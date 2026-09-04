import { pool } from "./pool.js";
import { assertCaller, readBrokerFilter, resolveWriteBrokerId } from "./scoping.js";

/**
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 */
export async function getContactMemory(caller, contactId) {
  assertCaller(caller);
  const brokerFilter = readBrokerFilter(caller);
  const params = [contactId];
  let sql = "SELECT * FROM contacts_memory WHERE contact_id = $1";
  if (brokerFilter) {
    params.push(brokerFilter);
    sql += ` AND broker_id = $${params.length}`;
  }
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

/**
 * Upserts the memory row for a contact. Only non-undefined fields are
 * applied (COALESCE against the existing row) so a partial write-back
 * (e.g. just bumping consecutive_missed_followups) never clobbers other
 * columns with null.
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 * @param {string|undefined} requestedBrokerId - only used for leadership callers
 * @param {object} fields
 */
export async function upsertContactMemory(caller, contactId, requestedBrokerId, fields) {
  assertCaller(caller);
  const brokerId = resolveWriteBrokerId(caller, requestedBrokerId);

  // Fails closed rather than letting a leadership-initiated write silently
  // reassign a contact that already belongs to a different broker. Also
  // doubles as the "does a row already exist" lookup below - Postgres
  // validates NOT NULL constraints against the proposed row BEFORE it even
  // checks for a conflict, so passing null for consecutive_missed_followups/
  // stale and relying on ON CONFLICT's COALESCE to fall back to the old row
  // does NOT work (it 23502s even when a conflict would've fired) - the
  // "preserve the existing value when not mentioned" logic has to be
  // resolved here in JS instead, against the real current row.
  const existing = await pool.query(
    "SELECT * FROM contacts_memory WHERE contact_id = $1",
    [contactId]
  );
  if (existing.rows[0] && existing.rows[0].broker_id !== brokerId && caller.role !== "leadership") {
    return null;
  }
  const existingRow = existing.rows[0];

  const {
    contactName = null,
    consecutiveMissedFollowups = null,
    lastAiSummary = null,
    sentimentTrend = null,
    lastContactedAt = null,
    confidence = null,
    stale = null,
  } = fields;

  const consecutiveMissedFollowupsValue =
    consecutiveMissedFollowups ?? existingRow?.consecutive_missed_followups ?? 0;
  const staleValue = stale ?? existingRow?.stale ?? false;

  const { rows } = await pool.query(
    `INSERT INTO contacts_memory
       (contact_id, broker_id, contact_name, consecutive_missed_followups, last_ai_summary, sentiment_trend, last_contacted_at, confidence, stale, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (contact_id) DO UPDATE SET
       broker_id = EXCLUDED.broker_id,
       contact_name = COALESCE(EXCLUDED.contact_name, contacts_memory.contact_name),
       consecutive_missed_followups = EXCLUDED.consecutive_missed_followups,
       last_ai_summary = COALESCE(EXCLUDED.last_ai_summary, contacts_memory.last_ai_summary),
       sentiment_trend = COALESCE(EXCLUDED.sentiment_trend, contacts_memory.sentiment_trend),
       last_contacted_at = COALESCE(EXCLUDED.last_contacted_at, contacts_memory.last_contacted_at),
       confidence = COALESCE(EXCLUDED.confidence, contacts_memory.confidence),
       stale = EXCLUDED.stale,
       updated_at = now()
     RETURNING *`,
    [contactId, brokerId, contactName, consecutiveMissedFollowupsValue, lastAiSummary, sentimentTrend, lastContactedAt, confidence, staleValue]
  );
  return rows[0];
}
