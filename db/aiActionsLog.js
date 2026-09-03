import { pool } from "./pool.js";
import { assertCaller, resolveWriteBrokerId } from "./scoping.js";

/**
 * Append-only audit trail - never UPDATEd or DELETEd (see the column-level
 * grants in sql/setup_aibot_role.sql, which revoke UPDATE on this table
 * entirely). Call this for any write-back action the AI takes.
 * @param {import('./scoping.js').Caller} caller
 * @param {string} contactId
 * @param {string|undefined} requestedBrokerId - only used for leadership callers
 */
export async function insertAiActionLog(caller, contactId, requestedBrokerId, entry) {
  assertCaller(caller);
  const brokerId = resolveWriteBrokerId(caller, requestedBrokerId);
  const {
    actionType,
    reasoning = null,
    autoExecuted = false,
    confirmedByHuman = false,
    overridden = false,
  } = entry;

  const { rows } = await pool.query(
    `INSERT INTO ai_actions_log (contact_id, broker_id, action_type, reasoning, auto_executed, confirmed_by_human, overridden)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [contactId, brokerId, actionType, reasoning, autoExecuted, confirmedByHuman, overridden]
  );
  return rows[0];
}
