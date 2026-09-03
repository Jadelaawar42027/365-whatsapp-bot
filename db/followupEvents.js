import { pool } from "./pool.js";
import { assertCaller, resolveWriteBrokerId } from "./scoping.js";

/**
 * Append-only.
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 * @param {string|undefined} requestedBrokerId - only used for leadership callers
 */
export async function insertFollowupEvent(caller, contactId, requestedBrokerId, entry) {
  assertCaller(caller);
  const brokerId = resolveWriteBrokerId(caller, requestedBrokerId);
  const { scheduledAt = null, outcome, flaggedAt = null } = entry;

  const { rows } = await pool.query(
    `INSERT INTO followup_events (contact_id, broker_id, scheduled_at, outcome, flagged_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [contactId, brokerId, scheduledAt, outcome, flaggedAt]
  );
  return rows[0];
}
