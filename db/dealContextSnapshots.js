import { pool } from "./pool.js";
import { assertCaller, resolveWriteBrokerId } from "./scoping.js";

/**
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 * @param {string|undefined} requestedBrokerId - only used for leadership callers
 */
export async function insertDealContextSnapshot(caller, contactId, requestedBrokerId, entry) {
  assertCaller(caller);
  const brokerId = resolveWriteBrokerId(caller, requestedBrokerId);
  const {
    priceDiscussed = null,
    objections = null,
    competitorMentions = null,
    financingStatus = null,
  } = entry;

  const { rows } = await pool.query(
    `INSERT INTO deal_context_snapshots (contact_id, broker_id, price_discussed, objections, competitor_mentions, financing_status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [contactId, brokerId, priceDiscussed, objections, competitorMentions, financingStatus]
  );
  return rows[0];
}
