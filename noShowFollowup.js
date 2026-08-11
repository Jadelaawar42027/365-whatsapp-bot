// Triggered by a GHL automation (webhook action, after a 24h Wait step)
// when a call is marked "Call No Show." Checks whether the lead rescheduled
// or responded in the meantime; if not, asks the broker to decide between
// following up personally or sending the lead to reactivation.

import { runInternalReport } from "./reportEngine.js";

function buildInstructions(contactId, contactName) {
  return `Generate a NO-SHOW FOLLOW-UP CHECK for the broker's lead ${contactName} (GHL contact ID: ${contactId}).

This lead's call was marked "Call No Show" roughly 24 hours ago. Your job is to check whether anything
has changed since then:

1. Call get_contact_tasks - is there a new open task for a rescheduled call/showing? That's a strong
   sign this is already being handled.
2. Call get_last_broker_contact_date AND get_conversation_timeline - has there been any INBOUND message
   from the lead since the no-show (them reaching out, apologizing, asking to reschedule)? Also check for
   any outbound message from the broker attempting a reschedule.
3. Call get_contact_notes - any note indicating a reschedule happened, or contact was made another way.

Two possible outcomes:

CASE A - evidence of re-engagement (rescheduled task exists, OR any message/note since the no-show
suggesting contact or a new plan): write ONE SHORT LINE confirming this looks handled, no action needed.
Example: "Quick check on [Lead] after yesterday's no-show - looks like it's already being handled
([one word on why, e.g. "rescheduled for Thursday"]). No action needed from you."

CASE B - no evidence of re-engagement (no reschedule, no response, no note): ask the broker directly to
decide. Use the per-lead priority format for the lead, briefly note the no-show and silence, then ask:
"Want me to (1) flag this for you to follow up on personally, or (2) send [Lead] to reactivation? Just
reply 'follow up' or 'reactivation.'"
Keep this SHORT - a couple of lines, not a report. Don't pad with a full history of the relationship.

In either case, this is a single check-in message, not a report - match the tone and length of a quick
text, not the morning digest.`;
}

/**
 * Generates a no-show follow-up check for a specific lead.
 * @param {{name: string, role: string}} identity - the resolved broker's roster entry
 * @param {string} contactId - the GHL contact ID from the webhook
 * @param {string} contactName - the lead's name, for framing
 */
export async function generateNoShowFollowup(identity, contactId, contactName) {
  return runInternalReport(identity, buildInstructions(contactId, contactName), "no-show follow-up");
}
