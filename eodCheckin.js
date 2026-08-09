// Chapter 9: End-of-Day Check-in. Same engine as the morning digest, but
// closes the loop instead of opening it: checks what still needed action
// today and asks directly, in a short, low-pressure way.

import { runInternalReport } from "./reportEngine.js";

const EOD_CHECKIN_INSTRUCTIONS = `Generate this person's END-OF-DAY CHECK-IN.

This follows up on exactly the kind of thing the morning digest would have flagged - tasks due today,
and Buy Now/Hot leads that needed contact today. You're not trying to recreate this morning's exact
message (you don't have it stored), you're checking the CURRENT real state of things right now, end of
day, using the same tools as the morning digest.

First, resolve their own GHL user ID via list_brokers, then use get_broker_leads_overview to get their
leads with priority/hot status. For Buy Now, Hot, and Active leads, call get_contact_tasks to check for
tasks with a due date of TODAY, and get_last_broker_contact_date to see if today's date shows as their
last outbound contact. Only read full conversation timelines if something looks genuinely ambiguous -
keep tool use lighter than the morning digest since this should be fast to generate.

Structure:
- Open with a short, casual greeting - lower-key than the morning digest, e.g. "Hey [name], quick
  end-of-day check-in."
- List anything that was due today or needed contact today and doesn't show as done: name the lead
  using the per-lead format from the rules above, and ask directly and specifically - e.g. "Did you get
  a chance to call Barry Lee? His follow-up was due today." Keep each one to one line, a direct question,
  not a restatement of the whole situation again.
- If EVERYTHING due today looks handled (tasks show recent activity, last contact is today), say so
  briefly and positively - don't manufacture things to ask about.
- Close by inviting a simple reply - they should be able to just say "done," "moving to tomorrow," or
  flag they need help, so keep the tone low-pressure, not a scolding. Something like: "Just let me know
  where things stand — done, need more time, or want a hand with any of these."

Keep the WHOLE thing SHORT - a handful of lines, not a report. This is a quick check-in, not a second
morning digest. If this person has no leads assigned to them at all, say so briefly rather than
returning an empty check-in.`;

/**
 * Generates a single person's end-of-day check-in.
 * @param {{name: string, role: string}} identity - a roster entry
 */
export async function generateEODCheckin(identity) {
  return runInternalReport(identity, EOD_CHECKIN_INSTRUCTIONS, "EOD check-in");
}
