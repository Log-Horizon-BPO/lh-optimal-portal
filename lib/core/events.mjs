// @ts-check
/**
 * Agent activity event model.
 *
 * Events form an append-only log. Each event carries BOTH a client timestamp
 * (from the agent PC, which the agent could tamper with) and a server timestamp
 * (authoritative). Billing always uses server time.
 *
 * This file defines the vocabulary and small helpers only — no storage, no I/O.
 */

/** @typedef {(
 *   | 'app_login' | 'app_logout'
 *   | 'dialer_login' | 'dialer_logout'
 *   | 'status_change'
 *   | 'transfer_clicked' | 'transfer_confirmed' | 'transfer_cancelled'
 *   | 'idle_start' | 'idle_end'
 *   | 'focus_lost' | 'focus_gained'
 *   | 'screen_locked' | 'screen_unlocked'
 *   | 'heartbeat'
 *   | 'tracker_error'
 * )} EventType */

/**
 * Agent status reported by the dialer. BILLABLE_STATUSES below defines which of
 * these count as paid dialing time.
 * @typedef {('READY' | 'INCALL' | 'DISPO' | 'PAUSED' | 'OFFLINE')} AgentStatus
 */

/** Statuses that count toward billable dialing time. */
export const BILLABLE_STATUSES = Object.freeze(['READY', 'INCALL', 'DISPO']);

/**
 * @typedef {Object} ActivityEvent
 * @property {string} id
 * @property {string} agentId
 * @property {string} shiftId
 * @property {string} deviceId
 * @property {EventType} type
 * @property {number} clientTs  epoch ms from the agent PC (untrusted)
 * @property {number} serverTs  epoch ms assigned on ingest (authoritative)
 * @property {Record<string, unknown>} [payload]
 */

/**
 * @param {AgentStatus} status
 * @returns {boolean}
 */
export function isBillableStatus(status) {
  return BILLABLE_STATUSES.includes(status);
}

/**
 * Flag suspicious gaps between the agent's clock and the server's clock.
 * A large positive or negative skew is a tampering signal, not proof.
 * @param {ActivityEvent} event
 * @param {number} [toleranceMs]
 * @returns {number} absolute skew in ms (compare against your own threshold)
 */
export function clockSkew(event, toleranceMs = 0) {
  const skew = Math.abs(event.serverTs - event.clientTs);
  return skew <= toleranceMs ? 0 : skew;
}
