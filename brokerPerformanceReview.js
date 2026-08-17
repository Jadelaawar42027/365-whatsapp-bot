// Leadership-only report: a real individual write-up for EACH broker
// separately, not a compressed team summary - who's on track, and for
// anyone with gaps, exactly what's missing and for which specific client.

import { runInternalReport } from "./reportEngine.js";

const BROKER_PERFORMANCE_INSTRUCTIONS = `Generate a BROKER PERFORMANCE REVIEW - a real individual
write-up for EACH broker separately, not a compressed team summary or blended paragraph.

You have full leadership access - use it. First call list_brokers to get every broker on the team. For
EACH broker, call get_broker_leads_overview to get their leads with priority/hot status.

For each broker, assess cadence compliance on their Buy Now and Active leads specifically (those are the
tiers with real expectations - Buy Now should show contact almost daily, Active weekly):
- Call get_last_broker_contact_date on their Buy Now/Active leads to check if contact is current for
  their tier.
- Call get_contact_tasks to check whether each Buy Now/Active lead has an open next action.
- ALWAYS call get_contact_notes before concluding something's missing - a lead can look neglected by
  message/task data alone while a note shows real recent progress (a call on a personal cell, a showing
  booked another way, etc.). Don't flag a gap that a note actually explains.

Structure - a clearly separated section per broker, each with its own header (the broker's name), not
one blended paragraph covering everyone:

[Broker Name]
Then either:
(a) If genuinely on track: a short, real assessment - not just "on track" with nothing else, actually
    say what's going well (e.g. "Staying on top of his Buy Now leads, good cadence on Active. No gaps
    right now.").
(b) If there are gaps: name the SPECIFIC client and the SPECIFIC issue for each one - e.g. "No contact
    with Barry Lee in 6 days (Buy Now - should be near-daily)" or "No next action set for Eric Singer."
    List up to 5 issues if that many exist; if more, note a count for the rest.

Give each broker a genuine individual write-up - don't shortcut anyone's section just because another
broker has more to say. A broker who's doing well deserves a real (if brief) acknowledgment, not just
being skipped past. Separate each broker's section clearly (a blank line and their name as a header) so
this reads as distinct write-ups, not one continuous block.

Keep the overall message readable - this is a leadership review, not an audit report, but don't sacrifice
the individual detail for brevity. If every broker is on track, say so for each one individually rather
than one blanket line for the whole team.`;

/**
 * Generates individual performance write-ups for every broker, combined
 * into one message but with each broker clearly separated.
 * @param {{name: string, role: string}} identity - a leadership roster entry
 */
export async function generateBrokerPerformanceReview(identity) {
  return runInternalReport(identity, BROKER_PERFORMANCE_INSTRUCTIONS, "broker performance review");
}
