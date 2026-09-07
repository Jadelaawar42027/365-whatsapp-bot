// Triggered by a GHL automation (webhook action) when a call's outcome is
// marked "Call Performed" - not a scheduled/time-based report like the
// digest or EOD check-in. Reviews the specific call that just happened and
// sends the assigned broker direct coaching feedback on it.

import { runInternalReportWithBudget } from "./reportEngine.js";

function buildInstructions(contactId, contactName) {
  return `Generate a CALL REVIEW for the broker on their call with ${contactName} (GHL contact ID: ${contactId}).

This call was just marked "Call Performed" - your job is to review THIS specific call, not the lead's
entire history. Find it and review it:

1. Use search_contacts or the contact ID directly with get_conversations to find this contact's
   conversations, then get_conversation_timeline to find the most recent call in the timeline (it just
   happened, so it should be the latest or near-latest call entry).
2. Call get_call_transcript on that call's message ID to get the actual transcript.
3. Also check get_contact_notes and the lead's priority/hot status (from search_contacts or
   get_broker_leads_overview) for brief context on where this deal stands - but the review itself should
   be about the call, not a full relationship history dump.

Before the review itself, output one or two lines, in this exact order, with no greeting or lead-in
before them:
1. One line, no preamble: the single biggest issue the broker made on this call - the one thing that
   mattered most, stated directly and specifically (a real moment/mistake, not a vague generality like
   "communication could be better").
2. ONLY if the broker failed to BAMFAM (Book A Meeting From A Meeting - didn't lock in a specific next
   scheduled touchpoint before the call ended) OR failed to get clear agreement with the client on next
   steps: a second line, on its own, formatted exactly as "🔴 [specific description of what was missed] 🔴".
   If the broker DID BAMFAM and DID land clear next steps, omit this line entirely - don't force it in
   when it doesn't apply.

Then, below those one or two lines, write the review in this style - direct, specific, coaching-oriented,
referencing actual moments from the transcript rather than generic advice:
- Open with a one-line summary of the call and lead context (who they are, what stage/priority).
- "What you did well" - 1-3 specific, genuine strengths from the actual transcript. Reference specific
  things said or done, not generic praise.
- "What to improve" - 1-3 specific, actionable points. If something concerning or a missed opportunity
  came up in the transcript, name it plainly. If there's nothing real to improve, don't manufacture
  something - say the call was clean.
- Close with a bottom line: what the next step should be, and whether there's an open task for it (check
  get_contact_tasks) - if not, say so and suggest one.

Keep it tight - this is a WhatsApp message someone reads right after a call, not a training document.
Use the standard per-lead priority label format when referencing the lead. If you can't find a call
transcript at all (e.g. the call wasn't recorded/transcribed), say so plainly rather than fabricating
a review.

SEPARATELY from the review above - after the "===END===" marker, also output a raw budget line so a
separate deterministic (non-AI) step can backfill this lead's GHL opportunity value if it's currently
empty. On its own line output the exact marker "===BUDGET===", then on the next line write the client's
budget EXACTLY as mentioned in the call transcript/notes, in their own words/numbers (e.g. "$300k-
$400k", "around 500 thousand", "1.2 million") - do not do any math or reformatting yourself, just quote
the raw figure(s) as said. If no budget was mentioned anywhere in this call's transcript or notes, write
exactly the word "NONE" instead. Then output the exact marker "===END_BUDGET===" on its own line, with
nothing after it. Both budget markers are required every time, even when the answer is "NONE".`;
}

/**
 * Generates a call review for the broker who owns the given contact, plus the raw budget
 * mention (if any) from the same call - for GHL opportunity-value backfilling (see
 * server.js's /trigger/call-review handler, which parses budgetRaw with budgetParser.js and
 * writes it via ghlMcpClient.js, all without a second Claude call).
 * @param {{name: string, role: string}} identity - the resolved broker's roster entry
 * @param {string} contactId - the GHL contact ID from the webhook
 * @param {string} contactName - the lead's name, for framing (from the webhook payload)
 * @returns {Promise<{text: string, budgetRaw: string|null}>}
 */
export async function generateCallReview(identity, contactId, contactName) {
  return runInternalReportWithBudget(identity, buildInstructions(contactId, contactName), "call review");
}
