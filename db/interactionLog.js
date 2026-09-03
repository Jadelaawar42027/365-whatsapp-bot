import { pool } from "./pool.js";
import { assertCaller, readBrokerFilter, resolveWriteBrokerId } from "./scoping.js";

/**
 * Append-only. Every live message exchange writes one row here.
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 * @param {string|undefined} requestedBrokerId - only used for leadership callers
 */
export async function insertInteractionLog(caller, contactId, requestedBrokerId, entry) {
  assertCaller(caller);
  const brokerId = resolveWriteBrokerId(caller, requestedBrokerId);
  const {
    channel,
    direction,
    summary = null,
    rawRef = null,
    extractedIntent = null,
    extractedObjectionCategory = null,
    extractedUrgency = null,
  } = entry;

  const { rows } = await pool.query(
    `INSERT INTO interaction_log
       (contact_id, broker_id, channel, direction, summary, raw_ref, extracted_intent, extracted_objection_category, extracted_urgency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [contactId, brokerId, channel, direction, summary, rawRef, extractedIntent, extractedObjectionCategory, extractedUrgency]
  );
  return rows[0];
}

/**
 * Most recent N rows for a contact, newest first - used to give the AI a
 * compact recent-history block. Never returns more than `limit` rows and
 * never returns another broker's rows for a 'broker' caller.
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 * @param {number} [limit]
 */
export async function getRecentInteractions(caller, contactId, limit = 10) {
  assertCaller(caller);
  const brokerFilter = readBrokerFilter(caller);
  const params = [contactId];
  let sql = "SELECT * FROM interaction_log WHERE contact_id = $1";
  if (brokerFilter) {
    params.push(brokerFilter);
    sql += ` AND broker_id = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  const { rows } = await pool.query(sql, params);
  return rows;
}
