import { pool } from "./pool.js";
import { assertCaller, resolveWriteBrokerId, readBrokerFilter } from "./scoping.js";

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

/**
 * Finds contacts whose MOST RECENT followup_events row is still an
 * unresolved "missed" flag older than `olderThanDays` - i.e. the broker was
 * told about a missed follow-up and, as of right now, still hasn't logged
 * anything since (a later "completed" row for the same contact would be the
 * most recent row instead, so it wouldn't match). Used by the morning
 * digest to escalate stale misses - deterministic, not left to the model's
 * judgment, same reasoning as the permission scoping elsewhere in db/.
 * @param {import('./scoping.js').Caller} caller - 'broker' gets only their own; 'leadership'/'setter' get every broker's
 * @param {number} [olderThanDays]
 */
export async function getStaleMissedFollowups(caller, olderThanDays = 7) {
  assertCaller(caller);
  const brokerFilter = readBrokerFilter(caller);

  const params = [];
  let sql = `
    SELECT DISTINCT ON (fe.contact_id)
      fe.contact_id, fe.broker_id, fe.outcome, fe.flagged_at, cm.contact_name
    FROM followup_events fe
    LEFT JOIN contacts_memory cm ON cm.contact_id = fe.contact_id
  `;
  if (brokerFilter) {
    params.push(brokerFilter);
    sql += ` WHERE fe.broker_id = $${params.length}`;
  }
  sql += ` ORDER BY fe.contact_id, fe.created_at DESC`;

  const { rows } = await pool.query(sql, params);

  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  return rows
    .filter((r) => r.outcome === "missed" && r.flagged_at && new Date(r.flagged_at).getTime() <= cutoff)
    .map((r) => ({
      contactId: r.contact_id,
      brokerId: r.broker_id,
      contactName: r.contact_name,
      flaggedAt: r.flagged_at,
      daysAgo: Math.floor((Date.now() - new Date(r.flagged_at).getTime()) / (24 * 60 * 60 * 1000)),
    }));
}
