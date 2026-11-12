// @ts-check
/**
 * Client-side wallboard compute — a data-in/snapshot-out port of the backend's
 * compute.mjs, using the same @mon/core functions so the numbers are identical.
 * The static dashboards call this with rows pulled from Supabase.
 */
import {
  computeBillable, computeBreak, countConfirmedTransfers, pace, settleShift,
  evaluateAgentAlerts, DEFAULT_THRESHOLDS, SEVERITY_RANK,
} from './core/index.mjs';

const HOUR = 3_600_000;

export function plannedActiveHours(c) {
  return (c.shiftEnd - c.shiftStart) / HOUR - c.breakAllowanceMin / 60;
}

function uiState(status, idle) {
  if (idle) return { label: 'Idle', cls: 'idle' };
  switch (status) {
    case 'INCALL': return { label: 'On call', cls: 'call' };
    case 'READY': return { label: 'Ready', cls: 'ready' };
    case 'DISPO': return { label: 'Wrap-up', cls: 'wrap' };
    case 'PAUSED': return { label: 'Break', cls: 'break' };
    default: return { label: 'Offline', cls: 'wrap' };
  }
}
function perfClass(state) {
  if (state === 'ahead') return 'ok';
  if (state === 'unrecoverable' || state === 'behind') return 'crit';
  return 'warn';
}
function lastStatus(events, fallbackTs) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'status_change') return { status: events[i].payload?.to, since: events[i].serverTs };
  }
  return { status: 'OFFLINE', since: fallbackTs };
}
function isIdle(events) {
  let idle = false;
  for (const e of events) { if (e.type === 'idle_start') idle = true; else if (e.type === 'idle_end') idle = false; }
  return idle;
}
function agentMetrics(events, { status, idle, breakHours, paceState, now }) {
  let lastTransfer = null, lastEvent = 0, lastIdleStart = null, trackerErr = false, maxSkew = 0;
  for (const e of events) {
    if (e.serverTs > lastEvent) lastEvent = e.serverTs;
    if (e.type === 'transfer_confirmed' && (lastTransfer === null || e.serverTs > lastTransfer)) lastTransfer = e.serverTs;
    if (e.type === 'idle_start') lastIdleStart = e.serverTs;
    if (e.type === 'idle_end') lastIdleStart = null;
    if (e.type === 'tracker_error' && e.serverTs >= now - 15 * 60_000) trackerErr = true;
    if (e.serverTs >= now - HOUR) maxSkew = Math.max(maxSkew, Math.abs(e.serverTs - e.clientTs));
  }
  return {
    status, idle,
    idleMs: idle && lastIdleStart != null ? now - lastIdleStart : 0,
    breakMinutes: breakHours * 60,
    minsSinceTransfer: (now - (lastTransfer ?? events[0]?.serverTs ?? now)) / 60_000,
    paceState,
    lastHeartbeatAgeMs: now - (lastEvent || now),
    maxClockSkewMs: maxSkew,
    hasRecentTrackerError: trackerErr,
  };
}

/**
 * @param {Object} p
 * @param {any} p.campaign  {id,name,hourlyTarget,breakAllowanceMin,idleGraceMs,shiftStart,shiftEnd}
 * @param {any[]} p.agents  [{id,name,usualRate}]
 * @param {(id:string)=>any[]} p.eventsFor
 * @param {any} [p.settings] app_settings.settings (alerts group used)
 * @param {number} [p.now]
 */
export function buildSnapshot({ campaign, agents, eventsFor, settings = {}, now = Date.now() }) {
  const windowOpts = { windowStart: campaign.shiftStart, windowEnd: now, idleGraceMs: campaign.idleGraceMs };
  const plannedHours = plannedActiveHours(campaign);
  const sa = settings.alerts ?? {};
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    breakAllowanceMin: campaign.breakAllowanceMin,
    idleAlertMs: (sa.idleMin ?? 5) * 60_000,
    zeroTransferMins: sa.zeroMin ?? 60,
    heartbeatTimeoutMs: (sa.hbSec ?? 60) * 1_000,
    clockSkewMs: (sa.skewMin ?? 2) * 60_000,
  };
  const alerts = [];

  const rows = agents.map((a) => {
    const events = (eventsFor(a.id) ?? []).slice().sort((x, y) => x.serverTs - y.serverTs);
    const { billableHours: activeHours } = computeBillable(events, windowOpts);
    const { breakHours } = computeBreak(events, windowOpts);
    const transfers = countConfirmedTransfers(events);
    const { status, since } = lastStatus(events, campaign.shiftStart);
    const idle = isIdle(events);

    const p = pace({ hourlyTarget: campaign.hourlyTarget, confirmedTransfers: transfers, billableHoursElapsed: activeHours, billableHoursTotal: plannedHours, historicalRate: a.usualRate });
    const settle = settleShift({ hourlyTarget: campaign.hourlyTarget, confirmedTransfers: transfers, billableHoursWorked: activeHours });

    const metrics = agentMetrics(events, { status, idle, breakHours, paceState: p.state, now });
    for (const al of evaluateAgentAlerts(metrics, thresholds)) {
      if (sa[al.code] === false) continue;
      alerts.push({ ...al, agentId: a.id, name: a.name, at: now });
    }

    const st = uiState(status, idle);
    const barPct = Math.max(4, Math.min(100, Math.round((transfers / Math.max(1, p.cumulativeTarget)) * 100)));
    return {
      id: a.id, name: a.name, status: st.label, statusClass: idle ? 'idle' : st.cls, idle,
      stateSinceMs: now - since,
      activeHours: +activeHours.toFixed(2), activeHMS: hms(activeHours * HOUR), breakHMS: hm(breakHours * HOUR),
      transfers, balance: Math.round(p.balance), balanceLabel: fmtBalance(p.balance),
      requiredPace: round1(p.requiredPace), usualRate: a.usualRate, perf: perfClass(p.state), paceState: p.state,
      barPct, projectedPaidHours: settle.paidHours, coveredHours: settle.coveredHours,
    };
  });

  const elapsedActive = rows.reduce((s, x) => s + x.activeHours, 0);
  const transfers = rows.reduce((s, x) => s + x.transfers, 0);
  const breakHoursTeam = rows.reduce((s, x) => s + hToNum(x.breakHMS), 0);
  const projectedEOD = rows.reduce((s, x) => s + (x.activeHours > 0 ? (x.transfers / x.activeHours) * plannedHours : 0), 0);
  const shiftTargetTeam = Math.round(plannedHours * campaign.hourlyTarget * rows.length);

  if (projectedEOD > 0 && projectedEOD < shiftTargetTeam * 0.95) {
    alerts.push({ code: 'team_projection', severity: 'warn', agentId: null, name: 'Team', at: now, message: `projected ${Math.round(projectedEOD)}/${shiftTargetTeam} — behind for the shift` });
  }
  alerts.sort((x, y) => (SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]) || (y.at - x.at));

  return {
    campaign: campaign.id, campaignName: campaign.name, now, shiftStart: campaign.shiftStart, shiftEnd: campaign.shiftEnd,
    hourlyTarget: campaign.hourlyTarget,
    team: {
      online: rows.filter((x) => x.status !== 'Offline').length, count: rows.length,
      activeHours: +elapsedActive.toFixed(1), breakHours: +breakHoursTeam.toFixed(1),
      transfers, cumulativeTarget: Math.round(elapsedActive * campaign.hourlyTarget),
      projectedEOD: Math.round(projectedEOD), shiftTarget: shiftTargetTeam,
      behind: rows.filter((x) => x.balance < 0).length,
      avgPace: elapsedActive > 0 ? round1(transfers / elapsedActive) : 0,
    },
    alerts, agents: rows,
  };
}

function round1(n) { return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0; }
function fmtBalance(b) { const r = Math.round(b); return r > 0 ? `+${r}` : `${r}`; }
function hms(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function hm(ms) { const m = Math.max(0, Math.floor(ms / 60000)); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; }
function hToNum(s) { const [h, m] = s.split(':').map(Number); return h + m / 60; }
