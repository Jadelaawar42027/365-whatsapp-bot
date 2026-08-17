// Chapter 1 + 2: Morning Digest, now with real next-action tracking via
// get_contact_tasks (Chapter 2). Uses the shared report engine (see
// reportEngine.js) for the marker/truncation/priority-format logic common
// to every scheduled report type.

import { runInternalReportWithFlags } from "./reportEngine.js";

const MORNING_DIGEST_INSTRUCTIONS = `Generate this person's MORNING DIGEST for today.

First, resolve their own GHL user ID via list_brokers (match on their name), then use
get_broker_leads_overview for their own ID to get the full lead list with each lead's priority and hot
flag. For Buy Now and Active leads especially, call get_last_broker_contact_date to check the REAL date
of the broker's last outbound message - the precise, automatic signal for whether they're overdue for
contact, not a guess from skimming text. Also call get_contact_tasks for open/incomplete tasks and due
dates.

CRITICAL - before flagging ANY lead as stale, overdue, or neglected, also call get_contact_notes. Notes
often capture real progress that message data alone misses entirely - a broker calling on a personal
cell, a showing that happened off-platform, a deal update - none of that shows up in
get_last_broker_contact_date or the conversation timeline, but it WILL be in notes if it was logged.
A lead with an old last-message-date but a recent note saying "going under contract" or "showing booked
for tomorrow" is NOT neglected - don't flag it as overdue just because the message data looks stale.
Cross-reference notes against message/task data before drawing any conclusion about a lead being
forgotten.

For anything that looks urgent, actually read the conversation timeline (get_conversation_timeline)
before characterizing it - per the standing rule, never judge a lead's status from stage/value/touch-
count alone, and priority tier alone doesn't tell the whole story either. While reading conversations,
if you see strong buying-signal language (wants to buy this week, asking to make an offer, flying in
soon, has proof of funds, wants to schedule a viewing), call update_lead_status to set hot=true
immediately - don't wait to ask permission for this specific flag, and mention in the report that you
flagged it.

Structure the report in this order, ALWAYS with Hot leads (regardless of tier) surfaced first, then
Buy Now, then Active, then Nurture:

- Open with a short, warm one-line greeting using their name.
- Every Hot lead first, regardless of tier, using the per-lead format from the rules above.
- Then remaining "Buy Now" leads worth a mention: overdue per get_last_broker_contact_date,
  overdue/due-today tasks, anything time-sensitive. Buy Now leads with nothing outstanding can be
  omitted or given a one-line "on track" mention.
- Then "Active" leads overdue on follow-up per get_last_broker_contact_date, or with an
  overdue/due-today task.
- "Nurture" - ONLY mention individually if genuinely overdue or something notable came up. Keep short.
- "No next action set" - Buy Now or Active leads with ZERO open tasks (confident claim from
  get_contact_tasks, not a guess), PLUS any lead with NO priority tier set at all who also has no open
  task and hasn't been touched in a while (e.g. last outbound contact is weeks/months old, or high touch
  count with no recent activity) - these are exactly the leads most likely to have been forgotten, so
  don't skip them just because they're untagged.
  MANDATORY: read their conversation timeline (get_conversation_timeline) AND their notes
  (get_contact_notes) to inform a good recommendation - a recent note can completely change the picture
  (e.g. a note logged yesterday saying a showing is booked means this lead does NOT belong in this
  section at all, even if get_contact_tasks shows no open task for it yet). The OUTPUT must be ONE SHORT
  SENTENCE per lead, nothing more. The broker already lived the history - don't replay it back to them.
  NO dates, NO "here's what happened," NO narrative walkthrough of the relationship. Just the name,
  tier, and the action.
  Exact format, one line, no exceptions: "[Lead Name] [priority emoji + label, or \"No priority set\"]:
  [ONE specific action]." That's the entire entry - nothing before it, nothing after it.
  Good example: "Charles Woods No priority set: call him, ask if he looked at the Naval 78 v2 — looks
  like Active, want me to set it?"
  Bad example (too long, don't do this): "Charles Woods — No priority set: Solid lead who texted you
  cold on July 26... [multiple sentences of history]... Recommended: call him today..."
  If more than 5 leads qualify for this section, list only the 5 most worth touching today and close
  with a one-line count for the rest (e.g. "+4 more untouched leads — ask me to list them if you want").
- Never individually mention Low Priority, On Hold, or Closed leads. A single closing line noting
  counts is enough if relevant (e.g. "6 leads on nurture, 3 on hold — nothing needs you there today").

Keep the WHOLE report to 5-10 total priorities - if there's genuinely nothing urgent, say so briefly
and warmly rather than padding with minor items. If this person has no leads assigned to them at all
(e.g. a leadership account with no personal deal book), say so briefly rather than returning an empty
report. Don't run get_contact_tasks or read full conversations for every single lead if the list is
long - prioritize Hot, Buy Now, and Active first, and it's fine to note that lower-priority leads
weren't individually checked since that matches how they're meant to be handled.

LEADERSHIP FLAGS - after finishing the broker-facing digest above, also output a SEPARATE structured
block for leadership visibility. This is NOT shown to the broker - it's collected across every broker's
digest run today and compiled into one leadership summary AFTER all digests are sent, so leadership
doesn't need a second full scan of everyone's pipeline. Only flag things that are genuinely
leadership-worthy - most digests will have FEW or ZERO flags, that's expected and fine.

Flag a lead as "near_close" if, from what you actually read in their conversation/notes, the deal looks
like it could realistically close within roughly 2-4 weeks (e.g. under contract, offer being finalized,
survey/closing scheduled, buyer explicitly said a timeline that fits this window).

Flag a lead as "alert" if something looks genuinely wrong and leadership visibility could help - NOT
just "overdue for cadence" (that's already normal digest content), but something more serious: a lead
who showed clear negative sentiment and got no follow-up, a lead who went silent right after something
concerning (a bad call, a complaint, a competitor mention), or a Buy Now/Hot lead who's been unreachable
for an unusually long stretch given how hot they are. Use judgment - this should be rare, not routine.

Output the exact marker "===FLAGS===" on its own line right after "===END===", then a JSON array (even
if empty: []) of objects shaped like:
{"type": "near_close" or "alert", "leadName": "...", "reason": "one short sentence"}
Then output the exact marker "===END_FLAGS===" on its own line. Valid JSON only - no markdown code
fences, no trailing commas, no comments. If there's nothing to flag, output an empty array: [].`;

/**
 * Generates a single person's morning digest.
 * @param {{name: string, role: string}} identity - a roster entry
 * @returns {Promise<{text: string, flags: Array}>}
 */
export async function generateMorningDigest(identity) {
  return runInternalReportWithFlags(identity, MORNING_DIGEST_INSTRUCTIONS, "morning digest");
}
