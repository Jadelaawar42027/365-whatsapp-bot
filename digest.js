// Chapter 1 + 2: Morning Digest, now with real next-action tracking via
// get_contact_tasks (Chapter 2). Uses the shared report engine (see
// reportEngine.js) for the marker/truncation/priority-format logic common
// to every scheduled report type.

import { runInternalReport } from "./reportEngine.js";

const MORNING_DIGEST_INSTRUCTIONS = `Generate this person's MORNING DIGEST for today.

First, resolve their own GHL user ID via list_brokers (match on their name), then use
get_broker_leads_overview for their own ID to get the full lead list with each lead's priority and hot
flag. For Buy Now and Active leads especially, call get_last_broker_contact_date to check the REAL date
of the broker's last outbound message - the precise, automatic signal for whether they're overdue for
contact, not a guess from skimming text. Also call get_contact_tasks for open/incomplete tasks and due
dates. For anything that looks urgent, actually read the conversation timeline
(get_conversation_timeline) before characterizing it - per the standing rule, never judge a lead's
status from stage/value/touch-count alone, and priority tier alone doesn't tell the whole story either.
While reading conversations, if you see strong buying-signal language (wants to buy this week, asking
to make an offer, flying in soon, has proof of funds, wants to schedule a viewing), call
update_lead_status to set hot=true immediately - don't wait to ask permission for this specific flag,
and mention in the report that you flagged it.

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
  MANDATORY: for EVERY lead in this section, you must actually read their conversation timeline
  (get_conversation_timeline) before listing them - never just say "no task" with no context. Each entry
  needs its own full line in this exact format, no lazy "(flagged above)" references:
  "[Lead Name] [priority emoji + label, or \"No priority set\" if untagged] — [one line of real context
  from their conversation: what they want, what happened last, how long it's been]. Recommended: [ONE
  concrete, specific next action based on what you actually read - not generic advice like \"follow up\"
  or \"check in\", something like \"call to ask if the Kashmir listing is still a fit\" or \"text asking
  if he's still looking after 4 months quiet - may be worth a re-qualification call\"]."
  If a lead has no priority set, also suggest what tier it probably should be based on the conversation
  (e.g. "looks like Active given confirmed budget" or "may be Nurture given vague timeline") and offer
  to set it - same confirm-first rule as any priority change.
- Never individually mention Low Priority, On Hold, or Closed leads. A single closing line noting
  counts is enough if relevant (e.g. "6 leads on nurture, 3 on hold — nothing needs you there today").

Keep the WHOLE report to 5-10 total priorities - if there's genuinely nothing urgent, say so briefly
and warmly rather than padding with minor items. If this person has no leads assigned to them at all
(e.g. a leadership account with no personal deal book), say so briefly rather than returning an empty
report. Don't run get_contact_tasks or read full conversations for every single lead if the list is
long - prioritize Hot, Buy Now, and Active first, and it's fine to note that lower-priority leads
weren't individually checked since that matches how they're meant to be handled.`;

/**
 * Generates a single person's morning digest.
 * @param {{name: string, role: string}} identity - a roster entry
 */
export async function generateMorningDigest(identity) {
  return runInternalReport(identity, MORNING_DIGEST_INSTRUCTIONS, "morning digest");
}
