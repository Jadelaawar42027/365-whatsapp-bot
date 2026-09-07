// Shared budget-backfill logic used by both the call-review trigger (fires per-lead,
// automatically, budgetRaw already extracted for free as a byproduct of the review itself -
// see reportEngine.js's runInternalReportWithBudget) and the one-time broker-leads sweep
// (server.js's /trigger/budget-backfill-sweep, which has no review already running so it
// pays for a dedicated lean Claude call per lead - see reportEngine.js's
// runBudgetExtraction). Both write via the same deterministic JS path: parse with
// budgetParser.js, write with ghlMcpClient.js - no Claude involved in either step.
import { callGhlMcpTool } from "./ghlMcpClient.js";
import { parseBudgetToNumber } from "./budgetParser.js";

// A GHL contact typically has an opportunity in SEVERAL pipelines at once (the real Buyer
// Pipeline deal, plus non-deal pipelines like the email-nurture list and the setter-cadence
// tracker) - confirmed against production data, where every one of them independently shows
// monetaryValue: 0. The budget belongs on the actual sales-cycle deal, so always target this
// specific pipeline (confirmed via list_pipelines: "Buyer Pipeline", the one with New Leads
// -> ... -> Under Contract -> Closing Process -> Owners Club - Win stages) - never guess
// between pipelines.
export const BUYER_PIPELINE_ID = "yp2TxpYmvRutPkNuoP69";

/**
 * Finds the contact's Buyer Pipeline opportunity, if it has one AND its value is currently
 * empty. `reason` explains why `opportunity` is null when it is - used by the sweep endpoint
 * to tally a real summary instead of just console logs nobody reads.
 * @returns {Promise<{opportunity: object|null, reason: string}>}
 */
export async function findEmptyBuyerPipelineOpportunity(identity, contactId) {
  let opportunities;
  try {
    opportunities = await callGhlMcpTool(identity, "get_opportunities_for_contact", { contactId });
  } catch (err) {
    console.error(`Budget backfill: failed to fetch opportunities for contact ${contactId}:`, err.message);
    return { opportunity: null, reason: "fetch_failed" };
  }

  const buyerPipelineOpportunities = (opportunities || []).filter((o) => o.pipelineId === BUYER_PIPELINE_ID);
  if (buyerPipelineOpportunities.length === 0) {
    console.log(`Budget backfill: contact ${contactId} has no Buyer Pipeline opportunity - nothing to do.`);
    return { opportunity: null, reason: "no_buyer_pipeline_opportunity" };
  }
  if (buyerPipelineOpportunities.length > 1) {
    console.warn(`Budget backfill: contact ${contactId} has ${buyerPipelineOpportunities.length} Buyer Pipeline opportunities - ambiguous which to update, skipping.`);
    return { opportunity: null, reason: "ambiguous" };
  }

  const opportunity = buyerPipelineOpportunities[0];
  if (opportunity.monetaryValue) {
    console.log(`Budget backfill: contact ${contactId}'s Buyer Pipeline opportunity already has a value (${opportunity.monetaryValue}) - not overwriting.`);
    return { opportunity: null, reason: "already_has_value" };
  }
  return { opportunity, reason: "empty" };
}

/**
 * Parses budgetRaw (deterministic JS, no Claude - see budgetParser.js) and, if it resolves
 * to a clean number, writes it to the given opportunity. No-op (with a log line) if
 * budgetRaw is null/unparseable.
 * @returns {Promise<boolean>} true if a write happened
 */
export async function writeOpportunityBudget(identity, contactId, opportunity, budgetRaw) {
  if (!budgetRaw) return false;

  const parsedBudget = parseBudgetToNumber(budgetRaw);
  if (parsedBudget === null) {
    console.warn(`Budget backfill: couldn't confidently parse budget text "${budgetRaw}" for contact ${contactId} - skipping.`);
    return false;
  }

  try {
    await callGhlMcpTool(identity, "update_opportunity_value", {
      contactId,
      opportunityId: opportunity.id,
      monetaryValue: parsedBudget,
    });
    console.log(`Budget backfill: set opportunity ${opportunity.id} (contact ${contactId}) to ${parsedBudget} from "${budgetRaw}".`);
    return true;
  } catch (err) {
    console.error(`Budget backfill: failed to update opportunity ${opportunity.id} for contact ${contactId}:`, err.message);
    return false;
  }
}

/**
 * Convenience wrapper for the call-review path, where budgetRaw is already known. Finds the
 * opportunity and writes to it if eligible; no-op otherwise.
 */
export async function backfillOpportunityBudget(identity, contactId, budgetRaw) {
  if (!budgetRaw) return;
  const { opportunity } = await findEmptyBuyerPipelineOpportunity(identity, contactId);
  if (!opportunity) return;
  await writeOpportunityBudget(identity, contactId, opportunity, budgetRaw);
}

/**
 * Instructions for the lean, silent, budget-only Claude call used by the sweep (no report
 * text, no chat-formatting rules - see reportEngine.js's runBudgetExtraction). Checks the
 * contact's FULL history, not just the latest call, since these are pre-existing leads that
 * may have mentioned budget at any point in the past.
 */
export function buildBudgetExtractionInstructions(contactId, contactName) {
  return `Find ${contactName}'s (GHL contact ID: ${contactId}) budget - the number they've mentioned for what
they're looking to spend on a boat - by checking their FULL message/call history, not just the most recent
contact:
1. Use get_conversations then get_conversation_timeline to see every message and call entry.
2. Call get_call_transcript for every call in the timeline - budget mentions often come up on calls, not
   just in text.
3. Check get_contact_notes too - a broker may have logged the budget as a note rather than it appearing in
   a transcript.

CRITICAL: this is a silent, internal-only lookup - nobody will read this as a message. Never narrate what
you're doing. Output NOTHING except the marker structure below - no summary, no explanation, no lead-in, no
wrap-up, before or after it.

Once you've checked all of the above, output the exact marker "===BUDGET===" on its own line, then on the
next line write the client's budget EXACTLY as mentioned (in their own words/numbers, e.g. "$300k-$400k",
"around 500 thousand", "1.2 million") - do not do any math or reformatting, just quote the raw figure(s) as
said, using whichever mention is clearest/most specific if it came up more than once. If no budget was ever
mentioned anywhere in this contact's history, write exactly the word "NONE" instead. Then output the exact
marker "===END_BUDGET===" on its own line, with nothing after it.`;
}
