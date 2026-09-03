import { pool } from "./pool.js";
import { assertCaller, readBrokerFilter, resolveWriteBrokerId } from "./scoping.js";

/**
 * Append-only - a new hot-lead EVENT per trigger, never overwritten in
 * place. Call this whenever the AI flags a contact as hot.
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 * @param {string|undefined} requestedBrokerId - only used for leadership callers
 */
export async function insertHotLead(caller, contactId, requestedBrokerId, entry) {
  assertCaller(caller);
  const brokerId = resolveWriteBrokerId(caller, requestedBrokerId);
  const {
    hotSince = new Date(),
    triggerReason,
    triggerSource = null,
    confidence = null,
  } = entry;

  const { rows } = await pool.query(
    `INSERT INTO hot_leads (contact_id, broker_id, hot_since, trigger_reason, trigger_source, confidence, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING *`,
    [contactId, brokerId, hotSince, triggerReason, triggerSource, confidence]
  );
  return rows[0];
}

/**
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 */
export async function getActiveHotLeads(caller, contactId) {
  assertCaller(caller);
  const brokerFilter = readBrokerFilter(caller);
  const params = [contactId];
  let sql = "SELECT * FROM hot_leads WHERE contact_id = $1 AND status = 'active'";
  if (brokerFilter) {
    params.push(brokerFilter);
    sql += ` AND broker_id = $${params.length}`;
  }
  sql += " ORDER BY hot_since DESC";

  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Updates only the review/escalation columns on an existing hot-lead row -
 * matches the column-level GRANT in sql/setup_aibot_role.sql, which allows
 * UPDATE on these columns only (never trigger_reason/hot_since - the
 * original facts stay append-only in spirit).
 * @param {import('./scoping.js').Caller} caller
 * @param {number} id
 */
export async function reviewHotLead(caller, id, updates) {
  assertCaller(caller);
  const brokerFilter = readBrokerFilter(caller);
  const {
    status = null,
    lastReviewedAt = new Date(),
    reviewedBy = null,
    escalatedToLeadership = null,
    escalatedAt = null,
  } = updates;

  const params = [id];
  let sql = `UPDATE hot_leads SET
      status = COALESCE($2, status),
      last_reviewed_at = COALESCE($3, last_reviewed_at),
      reviewed_by = COALESCE($4, reviewed_by),
      escalated_to_leadership = COALESCE($5, escalated_to_leadership),
      escalated_at = COALESCE($6, escalated_at),
      updated_at = now()
    WHERE id = $1`;
  params.push(status, lastReviewedAt, reviewedBy, escalatedToLeadership, escalatedAt);

  if (brokerFilter) {
    params.push(brokerFilter);
    sql += ` AND broker_id = $${params.length}`;
  }
  sql += " RETURNING *";

  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}
