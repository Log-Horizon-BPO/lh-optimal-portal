// @ts-check
/**
 * Billable-time and transfer-settlement logic.
 *
 * This is the only place that decides pay. It is pure: events in, numbers out.
 * All timestamps are server time (epoch ms).
 */
import { isBillableStatus } from './events.mjs';
import { clip, merge, subtract, totalMs } from './intervals.mjs';

const MS_PER_HOUR = 3_600_000;

/**
 * Build billable intervals from an agent's status_change events, clipped to the
 * scheduled dialing window, with over-grace idle time removed.
 *
 * - Billable status (READY/INCALL/DISPO) persists from one status_change to the
 *   next. The final status runs until the window end.
 * - Breaks are simply PAUSED time, so they are never billable.
 * - Idle episodes (idle_start/idle_end) that exceed `idleGraceMs` have their
 *   portion beyond the grace removed from billable time. Short idles are kept.
 *
 * @param {import('./events.mjs').ActivityEvent[]} events  agent's events (any order)
 * @param {Object} opts
 * @param {number} opts.windowStart  scheduled dialing window start (epoch ms)
 * @param {number} opts.windowEnd    scheduled dialing window end (epoch ms)
 * @param {number} [opts.idleGraceMs]  idle shorter than this is still billable (default 180000 = 3 min)
 * @returns {{ billableMs: number, billableHours: number, intervals: import('./intervals.mjs').Interval[] }}
 */
export function computeBillable(events, opts) {
  const { windowStart, windowEnd, idleGraceMs = 180_000 } = opts;
  const window = { start: windowStart, end: windowEnd };

  const statusChanges = events
    .filter((e) => e.type === 'status_change')
    .sort((a, b) => a.serverTs - b.serverTs);

  /** @type {import('./intervals.mjs').Interval[]} */
  const billableRaw = [];
  for (let i = 0; i < statusChanges.length; i++) {
    const ev = statusChanges[i];
    const to = /** @type {import('./events.mjs').AgentStatus} */ (
      /** @type {any} */ (ev.payload)?.to
    );
    const start = ev.serverTs;
    const end = i + 1 < statusChanges.length ? statusChanges[i + 1].serverTs : windowEnd;
    if (isBillableStatus(to)) billableRaw.push({ start, end });
  }

  let billable = clip(merge(billableRaw), window);

  // Remove the over-grace part of each idle episode.
  const overGraceIdle = idleEpisodes(events)
    .filter((ep) => ep.end - ep.start > idleGraceMs)
    .map((ep) => ({ start: ep.start + idleGraceMs, end: ep.end }));

  billable = subtract(billable, clip(overGraceIdle, window));

  const billableMs = totalMs(billable);
  return { billableMs, billableHours: billableMs / MS_PER_HOUR, intervals: billable };
}

/**
 * Pair idle_start with the next idle_end.
 * @param {import('./events.mjs').ActivityEvent[]} events
 * @returns {import('./intervals.mjs').Interval[]}
 */
function idleEpisodes(events) {
  const sorted = events
    .filter((e) => e.type === 'idle_start' || e.type === 'idle_end')
    .sort((a, b) => a.serverTs - b.serverTs);
  /** @type {import('./intervals.mjs').Interval[]} */
  const out = [];
  let openStart = null;
  for (const e of sorted) {
    if (e.type === 'idle_start' && openStart === null) openStart = e.serverTs;
    else if (e.type === 'idle_end' && openStart !== null) {
      out.push({ start: openStart, end: e.serverTs });
      openStart = null;
    }
  }
  return out;
}

/**
 * Count confirmed transfers. Only transfer_confirmed events count — a click that
 * never confirms is not a paid transfer.
 * @param {import('./events.mjs').ActivityEvent[]} events
 * @returns {number}
 */
export function countConfirmedTransfers(events) {
  return events.filter((e) => e.type === 'transfer_confirmed').length;
}

/**
 * Number of calls = how many times the agent entered INCALL (one per dialed/
 * connected call). Derived from status_change events.
 * @param {import('./events.mjs').ActivityEvent[]} events
 * @returns {number}
 */
export function countCalls(events) {
  return events.filter((e) => e.type === 'status_change' && /** @type {any} */ (e.payload)?.to === 'INCALL').length;
}

/**
 * Count each disposition code chosen at call wrap. Reads `disposition` events
 * (payload.code), e.g. { XFER: 3, NI: 12, A: 5 }.
 * @param {import('./events.mjs').ActivityEvent[]} events
 * @returns {Record<string, number>}
 */
export function dispositionCounts(events) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const e of events) {
    if (e.type !== 'disposition') continue;
    const code = /** @type {any} */ (e.payload)?.code;
    if (!code) continue;
    out[code] = (out[code] || 0) + 1;
  }
  return out;
}

/**
 * One-shot activity summary over a window — the numbers both admin reports use.
 * @param {import('./events.mjs').ActivityEvent[]} events
 * @param {{ windowStart: number, windowEnd: number, idleGraceMs?: number }} opts
 * @returns {{
 *   dialingMs: number, dialingHours: number,
 *   pauseMs: number, pauseHours: number,
 *   paidTransfers: number, calls: number,
 *   dispositions: Record<string, number>
 * }}
 */
export function summarizeActivity(events, opts) {
  const { billableMs, billableHours } = computeBillable(events, opts);
  const { breakMs, breakHours } = computeBreak(events, opts);
  return {
    dialingMs: billableMs, dialingHours: billableHours,
    pauseMs: breakMs, pauseHours: breakHours,
    paidTransfers: countConfirmedTransfers(events),
    calls: countCalls(events),
    dispositions: dispositionCounts(events),
  };
}

/**
 * Total PAUSED (break) time, clipped to the window. Breaks are never billable;
 * this is for display and break-allowance checks, not pay.
 * @param {import('./events.mjs').ActivityEvent[]} events
 * @param {Object} opts
 * @param {number} opts.windowStart
 * @param {number} opts.windowEnd
 * @returns {{ breakMs: number, breakHours: number }}
 */
export function computeBreak(events, opts) {
  const { windowStart, windowEnd } = opts;
  const window = { start: windowStart, end: windowEnd };
  const statusChanges = events
    .filter((e) => e.type === 'status_change')
    .sort((a, b) => a.serverTs - b.serverTs);

  /** @type {import('./intervals.mjs').Interval[]} */
  const paused = [];
  for (let i = 0; i < statusChanges.length; i++) {
    const ev = statusChanges[i];
    const to = /** @type {any} */ (ev.payload)?.to;
    const start = ev.serverTs;
    const end = i + 1 < statusChanges.length ? statusChanges[i + 1].serverTs : windowEnd;
    if (to === 'PAUSED') paused.push({ start, end });
  }
  const breakMs = totalMs(clip(merge(paused), window));
  return { breakMs, breakHours: breakMs / 3_600_000 };
}

/**
 * Live pace view during a shift.
 *
 * The target is hourly but evaluated cumulatively: an agent may make up a missed
 * hour later in the same shift. `balance` is how many transfers ahead (+) or
 * behind (-) the agent is right now.
 *
 * @param {Object} p
 * @param {number} p.hourlyTarget         transfers required per billable hour
 * @param {number} p.confirmedTransfers   confirmed so far
 * @param {number} p.billableHoursElapsed billable hours worked so far
 * @param {number} p.billableHoursTotal   billable hours in the full shift
 * @param {number} [p.historicalRate]     agent's usual transfers/hr, for recoverability
 * @returns {{
 *   cumulativeTarget: number,
 *   shiftTarget: number,
 *   balance: number,
 *   requiredPace: number,
 *   recoverable: boolean | null,
 *   state: 'ahead' | 'slightly_behind' | 'behind' | 'unrecoverable'
 * }}
 */
export function pace(p) {
  const {
    hourlyTarget,
    confirmedTransfers,
    billableHoursElapsed,
    billableHoursTotal,
    historicalRate,
  } = p;

  const cumulativeTarget = hourlyTarget * billableHoursElapsed;
  const shiftTarget = hourlyTarget * billableHoursTotal;
  const balance = confirmedTransfers - cumulativeTarget;

  const hoursRemaining = Math.max(0, billableHoursTotal - billableHoursElapsed);
  const remainingNeed = Math.max(0, shiftTarget - confirmedTransfers);
  const requiredPace = hoursRemaining > 0 ? remainingNeed / hoursRemaining : remainingNeed > 0 ? Infinity : 0;

  // Recoverable if the pace needed is within ~1.5x the agent's usual rate.
  /** @type {boolean | null} */
  let recoverable = null;
  if (historicalRate != null && historicalRate > 0) {
    recoverable = requiredPace <= historicalRate * 1.5;
  }

  /** @type {'ahead' | 'slightly_behind' | 'behind' | 'unrecoverable'} */
  let state;
  if (balance >= 0) state = 'ahead';
  else if (recoverable === false) state = 'unrecoverable';
  else if (balance >= -2) state = 'slightly_behind';
  else state = 'behind';

  return { cumulativeTarget, shiftTarget, balance, requiredPace, recoverable, state };
}

/**
 * End-of-shift settlement.
 *
 * Billing rule: the target is per agent per hour, made up across the shift. If
 * the agent ends below the full-shift target, they are PAID ONLY FOR COVERED
 * HOURS — the whole hours their transfers actually cover — never more than the
 * billable hours they worked.
 *
 *   paidHours = min( floor(confirmedTransfers / hourlyTarget), billableHoursWorked )
 *
 * @param {Object} p
 * @param {number} p.hourlyTarget
 * @param {number} p.confirmedTransfers
 * @param {number} p.billableHoursWorked  actual billable hours (may be fractional)
 * @returns {{
 *   coveredHours: number,
 *   paidHours: number,
 *   shiftTarget: number,
 *   metTarget: boolean,
 *   shortfallTransfers: number
 * }}
 */
export function settleShift(p) {
  const { hourlyTarget, confirmedTransfers, billableHoursWorked } = p;
  if (hourlyTarget <= 0) throw new Error('hourlyTarget must be > 0');

  const coveredHours = Math.floor(confirmedTransfers / hourlyTarget);
  // Cannot be paid for more hours than were actually worked.
  const cappedWorked = Math.floor(billableHoursWorked);
  const paidHours = Math.min(coveredHours, cappedWorked);

  const shiftTarget = hourlyTarget * cappedWorked;
  const metTarget = confirmedTransfers >= shiftTarget && cappedWorked > 0;
  const shortfallTransfers = Math.max(0, shiftTarget - confirmedTransfers);

  return { coveredHours, paidHours, shiftTarget, metTarget, shortfallTransfers };
}
