import { pool } from "./pool.js";
import { assertCaller } from "./scoping.js";

// Not wired into the live chat tool loop yet - reserved for a future admin
// flow. A broker/setter can only ever read/write their own row; leadership
// can read/write any.

/**
 * @param {import('./scoping.js').Caller} caller
 * @param {string} brokerId
 */
export async function getBrokerPreferences(caller, brokerId) {
  assertCaller(caller);
  if (caller.role !== "leadership" && brokerId !== caller.brokerId) return null;
  const { rows } = await pool.query(
    "SELECT * FROM broker_preferences WHERE broker_id = $1",
    [brokerId]
  );
  return rows[0] || null;
}

/**
 * @param {import('./scoping.js').Caller} caller
 * @param {string} brokerId
 */
export async function upsertBrokerPreferences(caller, brokerId, fields) {
  assertCaller(caller);
  if (caller.role !== "leadership" && brokerId !== caller.brokerId) return null;
  const { responseStyle = null, preferredCadence = null, notes = null } = fields;

  const { rows } = await pool.query(
    `INSERT INTO broker_preferences (broker_id, response_style, preferred_cadence, notes, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (broker_id) DO UPDATE SET
       response_style = COALESCE(EXCLUDED.response_style, broker_preferences.response_style),
       preferred_cadence = COALESCE(EXCLUDED.preferred_cadence, broker_preferences.preferred_cadence),
       notes = COALESCE(EXCLUDED.notes, broker_preferences.notes),
       updated_at = now()
     RETURNING *`,
    [brokerId, responseStyle, preferredCadence, notes]
  );
  return rows[0];
}
