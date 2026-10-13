// Sticky hot-leads tracking for the morning digest. GHL's own "hot" checkbox and the model's own
// daily re-evaluation were the only two ways a lead could be surfaced as hot - both can flip a
// lead out of the digest for reasons that have nothing to do with the deal itself (the checkbox
// gets unchecked, or the model's fresh read that day just doesn't land the same way it did
// yesterday). This table is the third, durable source of truth: once a lead is confirmed hot, it
// stays on the list the digest is REQUIRED to cover until the deal actually closes/is lost, or
// the model explicitly asks to remove it with a stated reason (logged, not silent).

import { pool } from "./db/pool.js";

const TERMINAL_OUTCOMES = new Set(["Sale Closed", "Lost"]);

/**
 * Deterministic sync step, run once per broker per digest, BEFORE the Claude call - no AI
 * judgment involved. Adds any newly-hot lead from this run's live overview, refreshes
 * last_confirmed_at for leads still hot, and auto-closes any tracked lead whose outcome has
 * become terminal (Sale Closed/Lost) per the SAME overview data already fetched.
 * @param {string} brokerPhone - roster phone, same key used everywhere else in db/
 * @param {Array<{id: string, name: string, hot: boolean, outcome: string|null}>} overview -
 *   this broker's get_broker_leads_overview result
 */
export async function syncHotLeadsFromOverview(brokerPhone, overview) {
  const added = [];
  const autoClosed = [];

  for (const lead of overview) {
    if (!lead.hot) continue;
    const { rows } = await pool.query(
      `INSERT INTO digest_hot_leads (contact_id, broker_phone, lead_name, last_confirmed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (contact_id) DO UPDATE SET
         last_confirmed_at = now(),
         lead_name = COALESCE(EXCLUDED.lead_name, digest_hot_leads.lead_name)
       WHERE digest_hot_leads.status = 'active'
       RETURNING (xmax = 0) AS inserted`,
      [lead.id, brokerPhone, lead.name || null]
    );
    if (rows[0]?.inserted) added.push({ contactId: lead.id, name: lead.name });
  }

  const outcomeById = new Map(overview.map((l) => [l.id, l.outcome]));
  const { rows: activeRows } = await pool.query(
    "SELECT contact_id, lead_name FROM digest_hot_leads WHERE broker_phone = $1 AND status = 'active'",
    [brokerPhone]
  );
  for (const row of activeRows) {
    const outcome = outcomeById.get(row.contact_id);
    if (outcome && TERMINAL_OUTCOMES.has(outcome)) {
      await pool.query(
        `UPDATE digest_hot_leads SET status = 'removed', removed_reason = $2, removed_at = now()
         WHERE contact_id = $1 AND status = 'active'`,
        [row.contact_id, `GHL outcome: ${outcome}`]
      );
      autoClosed.push({ contactId: row.contact_id, name: row.lead_name, reason: outcome });
    }
  }

  return { added, autoClosed };
}

/** The broker's current sticky hot-leads list, for injecting into the digest instructions. */
export async function getActiveHotLeads(brokerPhone) {
  const { rows } = await pool.query(
    "SELECT contact_id, lead_name FROM digest_hot_leads WHERE broker_phone = $1 AND status = 'active' ORDER BY first_flagged_at",
    [brokerPhone]
  );
  return rows.map((r) => ({ contactId: r.contact_id, name: r.lead_name }));
}

/**
 * Applies model-requested removals from the digest's HOT_LEAD_REMOVALS block. Only removes rows
 * that are actually active and belong to this broker - an unrecognized or already-removed
 * contactId is silently skipped rather than erroring the whole digest over a formatting slip.
 * @param {string} brokerPhone
 * @param {Array<{contactId: string, reason: string}>} removals
 */
export async function applyHotLeadRemovals(brokerPhone, removals) {
  const applied = [];
  for (const { contactId, reason } of removals || []) {
    if (!contactId) continue;
    const { rowCount } = await pool.query(
      `UPDATE digest_hot_leads SET status = 'removed', removed_reason = $3, removed_at = now()
       WHERE contact_id = $1 AND broker_phone = $2 AND status = 'active'`,
      [contactId, brokerPhone, reason || "no reason given"]
    );
    if (rowCount > 0) applied.push({ contactId, reason });
  }
  return applied;
}
