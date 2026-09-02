// Chapter 1 + 2: Morning Digest, now with real next-action tracking via
// get_contact_tasks (Chapter 2). Uses the shared report engine (see
// reportEngine.js) for the marker/truncation/priority-format logic common
// to every scheduled report type.

import { runInternalReportWithFlags } from "./reportEngine.js";

const MORNING_DIGEST_INSTRUCTIONS = `Generate this person's MORNING DIGEST for today.

Core goal: scan this broker's ENTIRE lead list via get_broker_leads_overview and surface the genuinely
hottest leads that need real action TODAY. This is not a mechanical pass through every lead tagged Buy
Now or Active - a tier is a starting point for what to look at, not a verdict on what to report. Only
surface a lead if, after actually checking its current situation (notes, tasks, recent contact), it's
still genuinely live and actionable right now.

First, resolve their own GHL user ID via list_brokers (match on their name), then use
get_broker_leads_overview for their own ID to get the full lead list with each lead's priority and hot
flag. For Buy Now and Active leads especially, call get_last_broker_contact_date to check the REAL date
of the broker's last outbound message - the precise, automatic signal for whether they're overdue for
contact, not a guess from skimming text. Also call get_contact_tasks for open/incomplete tasks and due
dates.

CRITICAL - notes and message history carry EQUAL weight for determining a lead's current status - never
treat message history as the sole source of truth just because it's the primary data stream. Before
flagging ANY lead as stale, overdue, or neglected, also call get_contact_notes and directly compare the
most recent NOTE timestamp against the most recent MESSAGE timestamp (from get_last_broker_contact_date /
the conversation timeline) - whichever is more recent is the current source of truth for that lead, full
stop, regardless of which source it came from. A note with no corresponding message at all (e.g. a
broker logged a personal-cell call or an in-person meeting that never went through WhatsApp/GHL) is still
FULLY authoritative for the lead's current state - don't discount it for lacking a paired message. A lead
with an old last-message-date but a recent note saying "going under contract" or "showing booked for
tomorrow" is NOT neglected - don't flag it as overdue just because the message data looks stale. The
reverse holds too: if a later note says the lead went cold, isn't interested, or asked to be left alone,
that note wins even if recent messages looked engaged - see the COLD LEAD OVERRIDE below. Never summarize
a lead using only message content if a more recent note exists - read the note and reflect it.

CRITICAL - COLD LEAD OVERRIDE: before flagging ANY lead as needing action, hot, urgent, or an alert, you
must check get_contact_notes. If the notes clearly indicate the lead has gone cold, said they're not
interested right now, asked to be left alone, or the broker has explicitly decided to stop actively
pursuing them - DO NOT flag this lead as needing action, regardless of what their priority tier or
touch/task data suggests. A lead can be tagged "Active" or "Buy Now" from weeks ago and simply be
stale/wrong now - the notes are the most current truth, not the tier. If there's a real mismatch between
the tier and what the notes describe (e.g. tagged Active but notes say cold), you can mention that the
tier looks out of date and suggest updating it, but that's a low-priority aside, not a reason to flag
urgency. This rule applies to every section of this digest, and to the LEADERSHIP FLAGS block
specifically - never mark a lead as an "alert" if notes explain the silence as an intentional,
already-acknowledged cold lead.

CRITICAL - BROKER OUTCOME OVERRIDE: get_broker_leads_overview returns each lead's "outcome" field (GHL's
"Broker Outcomes" custom field). If a lead's outcome is "Sale Closed" or "Lost", the broker has already
explicitly marked this lead as done - completely ignore it everywhere in this digest (not Hot, not Buy
Now/Active/Nurture, not "No next action set," not a leadership flag), even if its priority tier still
says something like "Buy Now" or "Active" - the tier can be stale, but this is a deliberate, explicit
broker action and takes priority over it. Don't mention these leads individually anywhere in the report,
same treatment as Low Priority/On Hold/Closed-priority leads.

For anything that looks urgent, actually read the conversation timeline (get_conversation_timeline)
before characterizing it - per the standing rule, never judge a lead's status from stage/value/touch-
count alone, and priority tier alone doesn't tell the whole story either. While reading conversations,
if you see strong buying-signal language (wants to buy this week, asking to make an offer, flying in
soon, has proof of funds, wants to schedule a viewing), call update_lead_status to set hot=true
immediately - don't wait to ask permission for this specific flag, and mention in the report that you
flagged it.

HOT LEADS - NO CAP, RE-EVALUATE FROM SCRATCH EVERY RUN: there is no fixed number of hot leads to report -
some days it's 3, some days it's 9. Evaluate every lead independently against the hot-lead criteria;
don't stop once you've found 3-4 and treat that as "enough." Don't anchor on or assume continuity with
any previous digest - re-derive the hot leads list from scratch every run, from THIS run's current
message and note data for each broker. A lead that was hot yesterday is only hot today if it still meets
criteria today; a lead that just started showing hot signals - even one that's never been flagged before,
and even if its tier is currently Active or Nurture - MUST be included. Don't limit hot-signal checking to
leads already tagged Hot or Buy Now: get_broker_leads_overview's hot/priority fields reflect whatever was
last set, not necessarily what's true right now, so an Active or Nurture lead can have turned hot since
the last check. For every lead marked Hot in this digest, include a one-line reason citing the specific
signal (e.g. "asked about financing terms," "requested a sea trial date," "note: broker says client ready
to make an offer this week") - never just list the name.

Structure the report in this order, ALWAYS with Hot leads (regardless of tier) surfaced first, then
Buy Now, then Active, then Nurture:

- Open with a short, warm one-line greeting using their name.
- Every Hot lead first, regardless of tier, using the per-lead format from the rules above - every one
  of them, no matter how many that turns out to be, each with its one-line hot-signal reason.
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
- Before flagging ANY lead as overdue, stale, or an issue anywhere in this digest (a Buy Now/Active
  mention, "No next action set," or a leadership "alert" flag below), check whether a later action
  already resolved it - a message sent, a note logged, or a task completed after the point that made it
  look stale. If it's already been addressed, don't flag it, even if it looked stale before that
  follow-up. Don't flag a lead as an issue purely because it's been open a long time or carries a
  low-priority tag either - pipeline age and priority tier are not issues on their own; only flag based
  on actual lack of movement or an explicit unresolved flag in notes/messages.
- Never individually mention Low Priority, On Hold, or Closed leads. A single closing line noting
  counts is enough if relevant (e.g. "6 leads on nurture, 3 on hold — nothing needs you there today").

Keep the WHOLE report to 5-10 total priorities - if there's genuinely nothing urgent, say so briefly
and warmly rather than padding with minor items. If this person has no leads assigned to them at all
(e.g. a leadership account with no personal deal book), say so briefly rather than returning an empty
report. Always call get_broker_leads_overview for the broker's FULL current lead list first - never
sample or work from a partial list, and never assume continuity with a previous digest run's names; this
run's digest must reflect this run's actual current data, including any lead that's brand new since the
last check. Deep reads (get_conversation_timeline, get_contact_notes) don't need to happen for every
single lead if the list is long, but don't skip them purely because a lead's CURRENT tier is Active or
Nurture - those are exactly the leads most likely to have crossed into Hot since the last check (see the
HOT LEADS rule above). It's reasonable to skip a deep read only for leads that are clearly Low Priority,
On Hold, or Closed with no recent activity at all - those are the ones genuinely unlikely to have changed.

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
for an unusually long stretch given how hot they are. Same resolution check applies here as everywhere
else in this digest: if a later note or message already addressed what looked concerning, it's not an
alert. Use judgment - this should be rare, not routine.

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
