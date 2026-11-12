// @ts-check
/**
 * Alert rules. Pure: given one agent's current metrics and the campaign
 * thresholds, return the alerts that are firing. The backend builds the metrics
 * from the event log and decorates the results with agent id / name / time.
 */
import { isBillableStatus } from './events.mjs';

/**
 * @typedef {Object} AgentMetrics
 * @property {string} status           core status (READY/INCALL/DISPO/PAUSED/OFFLINE)
 * @property {boolean} idle
 * @property {number} idleMs           how long the current idle episode has run
 * @property {number} breakMinutes     total break time this shift
 * @property {number} minsSinceTransfer minutes since the last confirmed transfer
 * @property {string} paceState        from core pace(): ahead/slightly_behind/behind/unrecoverable
 * @property {number} lastHeartbeatAgeMs
 * @property {number} maxClockSkewMs   largest recent |serverTs - clientTs|
 * @property {boolean} hasRecentTrackerError
 */

/**
 * @typedef {Object} AlertThresholds
 * @property {number} idleAlertMs
 * @property {number} breakAllowanceMin
 * @property {number} zeroTransferMins
 * @property {number} heartbeatTimeoutMs
 * @property {number} clockSkewMs
 */

/** @type {AlertThresholds} */
export const DEFAULT_THRESHOLDS = {
  idleAlertMs: 5 * 60_000,
  breakAllowanceMin: 60,
  zeroTransferMins: 60,
  heartbeatTimeoutMs: 60_000,
  clockSkewMs: 120_000,
};

/**
 * @param {AgentMetrics} m
 * @param {AlertThresholds} th
 * @returns {{code: string, severity: 'crit'|'warn'|'info', message: string}[]}
 */
export function evaluateAgentAlerts(m, th) {
  const a = [];

  // Lost heartbeat takes priority — the agent's device is unreachable.
  if (m.lastHeartbeatAgeMs >= th.heartbeatTimeoutMs) {
    a.push({ code: 'offline', severity: 'crit', message: `no heartbeat for ${Math.round(m.lastHeartbeatAgeMs / 1000)}s` });
    return a; // other metrics are stale while offline
  }
  if (m.idle && m.idleMs >= th.idleAlertMs) {
    a.push({ code: 'idle', severity: 'crit', message: `idle ${Math.round(m.idleMs / 60_000)} min while Ready` });
  }
  if (isBillableStatus(m.status) && m.minsSinceTransfer >= th.zeroTransferMins) {
    a.push({ code: 'zero_transfers', severity: 'crit', message: `0 transfers in last ${Math.round(m.minsSinceTransfer)} min` });
  }
  if (m.breakMinutes > th.breakAllowanceMin) {
    a.push({ code: 'break_overrun', severity: 'warn', message: `break over by ${Math.round(m.breakMinutes - th.breakAllowanceMin)} min` });
  }
  if (m.paceState === 'unrecoverable') {
    a.push({ code: 'pace', severity: 'warn', message: 'behind pace — recovery unlikely at current rate' });
  }
  if (m.hasRecentTrackerError) {
    a.push({ code: 'tracker_error', severity: 'crit', message: 'tracker error — capture gap on the dialer' });
  }
  if (m.maxClockSkewMs >= th.clockSkewMs) {
    a.push({ code: 'clock_skew', severity: 'info', message: `clock skew ${Math.round(m.maxClockSkewMs / 60_000)} min — flagged` });
  }
  return a;
}

/** Severity ordering for sorting a mixed list (most severe first). */
export const SEVERITY_RANK = { crit: 0, warn: 1, info: 2 };
