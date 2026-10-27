// Chapter 1 + 2: Morning Digest, now with real next-action tracking via
// get_contact_tasks (Chapter 2). Uses the shared report engine (see
// reportEngine.js) for the marker/truncation/priority-format logic common
// to every scheduled report type.

import { runInternalReportWithFlagsAndCoverage } from "./reportEngine.js";
import { getMainLeadsReference, getBuyerLeadsReference } from "./mainLeadsSheet.js";
import { callGhlMcpTool } from "./ghlMcpClient.js";
import { syncHotLeadsFromOverview, getActiveHotLeads, applyHotLeadRemovals } from "./digestHotLeads.js";
import { getOpportunitiesForContact } from "./ghlRestClient.js";
import { BUYER_PIPELINE_ID } from "./budgetBackfill.js";

const MORNING_DIGEST_INSTRUCTIONS = `Generate this person's MORNING DIGEST for today.

Core goal: scan this broker's ENTIRE lead list via get_broker_leads_overview and surface the genuinely
hottest leads that need real action TODAY. This is not a mechanical pass through every lead tagged Buy
Now or Active - a tier is a starting point for what to look at, not a verdict on what to report. Only
surface a lead if, after actually checking its current situation (notes, tasks, recent contact), it's
still genuinely live and actionable right now.

First, resolve their own GHL user ID via list_brokers (match on their name), then use
get_broker_leads_overview for their own ID to get the full lead list with each lead's priority and hot
flag. Each lead in that list already includes lastOutboundMessageDate - the REAL date of the broker's
last outbound message, the precise, automatic signal for whether a Buy Now or Active lead is overdue for
contact, not a guess from skimming text. Use that field directly - do NOT call get_last_broker_contact_date
separately for leads already covered by the overview, that's a redundant round-trip for data you already
have. Only call it standalone if you need to double-check a specific contact across every one of their
conversation threads (the overview's field only reflects their primary thread - rare that this matters,
most contacts have just one). Also call get_contact_tasks for open/incomplete tasks and due dates.

CRITICAL - notes and message history carry EQUAL weight for determining a lead's current status - never
treat message history as the sole source of truth just because it's the primary data stream. Before
flagging ANY lead as stale, overdue, or neglected, also call get_contact_notes and directly compare the
most recent NOTE timestamp against the most recent MESSAGE timestamp (lastOutboundMessageDate from the
overview, or the conversation timeline) - whichever is more recent is the current source of truth for
that lead, full stop, regardless of which source it came from. A note with no corresponding message at all (e.g. a
broker logged a personal-cell call or an in-person meeting that never went through WhatsApp/GHL) is still
FULLY authoritative for the lead's current state - don't discount it for lacking a paired message. A lead
with an old last-message-date but a recent note saying "going under contract" or "showing booked for
tomorrow" is NOT neglected - don't flag it as overdue just because the message data looks stale. The
reverse holds too: if a later note says the lead went cold, isn't interested, or asked to be left alone,
that note wins even if recent messages looked engaged - see the COLD LEAD OVERRIDE below. Never summarize
a lead using only message content if a more recent note exists - read the note and reflect it.

CRITICAL - EMAIL FOLLOW-UP BLIND SPOT: lastOutboundMessageDate only counts OUTBOUND messages, which is
the right signal for SMS/WhatsApp - but email has a real gap: a broker sometimes replies to a lead's
email from their own personal Gmail instead of through GHL, so the reply never shows as an outbound
message in GHL at all, even though the broker genuinely did follow up. Because of this, do NOT flag a
lead as neglected/overdue based on a stale lastOutboundMessageDate alone if the conversation timeline
shows a RECENT email from EITHER side (the lead's inbound email, or the broker's own outbound one) -
recent email activity in either direction is real, current evidence of engagement, not just outbound.
This carve-out is specific to email (TYPE_EMAIL in the timeline) - keep applying the normal
outbound-only standard for SMS/WhatsApp and calls, where this blind spot doesn't exist.

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

HOT LEADS - NO CAP, CHECK EVERY LEAD FRESH FOR *NEW* CANDIDATES: there is no fixed number of hot leads to
report - some days it's 3, some days it's 9. Evaluate every lead independently against the hot-lead
criteria; don't stop once you've found 3-4 and treat that as "enough." A lead that just started showing
hot signals - even one that's never been flagged before, and even if its tier is currently Active or
Nurture - MUST be included. Don't limit hot-signal checking to leads already tagged Hot or Buy Now:
get_broker_leads_overview's hot/priority fields reflect whatever was last set, not necessarily what's true
right now, so an Active or Nurture lead can have turned hot since the last check. For every lead marked
Hot in this digest, include a one-line reason citing the specific signal (e.g. "asked about financing
terms," "requested a sea trial date," "note: broker says client ready to make an offer this week") - never
just list the name.

STICKY HOT LEADS - DO NOT RE-DERIVE THESE, THEY'RE ALREADY DECIDED: a separate list below (if present)
names leads already confirmed hot in a previous digest and tracked outside this conversation - these are
NOT re-evaluated from scratch and MUST appear in today's Hot Leads section regardless of what GHL's hot
checkbox currently says. For each one, still pull real current notes/tasks/timeline (get_contact_notes,
get_contact_tasks, get_conversation_timeline) and write a current, specific one-line status - don't just
repeat yesterday's reason verbatim if something's moved. This list is the fix for hot leads inconsistently
vanishing day to day - inclusion is guaranteed, you're only deciding WHAT to say about each one, never
WHETHER to mention it. The "check every lead fresh" instruction above is for finding NEW hot candidates not
already on this list - it does not give you permission to drop one that is.

If a MAIN LEADS SHEET reference block is included below, cross-check every Hot-lead candidate against
it before including them - it's leadership's own hand-maintained list of leads they already consider
genuinely significant, a stronger anchor than GHL's tier tags (which go stale). A lead on that list,
especially with an A+ Quality rating, is real evidence toward Hot. A lead NOT on that list needs clear,
specific, current buying-signal language from this run's own message/note data - not just an old tier
tag - before you call it Hot; when the evidence is thin and the lead isn't on the list, leave it out
rather than including it on a guess. This list doesn't replace checking real GHL data - it's a
cross-check on top of it, not a substitute for reading the actual conversation/notes.

If a BUYER LEADS SHEET reference block is included below, treat it the same way: a candidate list to
make sure you don't miss a lead someone on the team is actively working, NEVER a verdict on its own. It
carries a real narrative "Update" per lead (a setter or broker's own note), which can be MORE current
than GHL for that specific lead, or can be STALE - a lead listed there can have already cooled (e.g. the
client said they're waiting a few months) since that update was written. For every lead on this sheet,
pull their real current notes/conversation before deciding - the sheet's own "Update" text is a strong
hint of what to look for, not a substitute for checking. A lead that just went hot from a fresh reply
that ISN'T on this sheet yet is still caught by the normal HOT LEADS check above - this sheet only adds
candidates, it never limits which leads you evaluate.

BUDGET IN EVERY LEAD LINE: each lead in the BROKER LEADS OVERVIEW below has a "budget" field - the
lead's Buyer Pipeline deal value, already formatted (e.g. "$350K", "$1.2M"), or null if none is set.
Whenever you name a lead anywhere in this digest, put their budget in parentheses right after their
name, before everything else on the line - the rest of the line stays exactly as the format rules
say. Example: "Barry Lee ($350K) 🔥 🔴 Buy Now: asked to schedule a viewing this week and hasn't heard
back — call him today to lock in a time." If budget is null, just leave the parentheses out - never
write "unknown" or guess a number, and never use a budget from anywhere other than this field.

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
  COST-EFFICIENCY PRE-FILTER, untagged leads only: before spending a conversation-timeline-and-notes
  read on a no-priority-tier lead, check what the overview already gives you for free - touches,
  lastOutboundMessageDate, and lastTouchDate (most recent message in EITHER direction). If touches are
  very low (3 or fewer) AND lastTouchDate is either absent or more than 6 months old AND the lead was
  added more than 6 months ago, it's overwhelmingly likely a dead record (a stray phone number, a
  vendor, a one-off inquiry that never went anywhere) rather than a forgotten active lead - skip it
  entirely, no timeline/notes read needed, and don't include it in this section. Use lastTouchDate here,
  not lastOutboundMessageDate alone - a lead can have real recent engagement via an inbound reply or a
  follow-up that happened through an untracked channel (e.g. a personal call/text) with no logged
  outbound message, and lastTouchDate is what catches that. Reserve the mandatory notes/timeline read
  below for untagged leads that DO show any real prior engagement (a real touch count, or a
  lastTouchDate at all, regardless of how old) but have since gone quiet - those are the ones actually
  worth verifying before flagging as forgotten.

  HOT LEAD REMOVAL/DOWNGRADE - act on clear evidence, don't just flag it and wait: a lead on the STICKY
  HOT LEADS list comes off it, or gets its priority tier corrected, in any of these cases - its GHL
  outcome becomes Sale Closed/Lost (handled automatically, not your job); notes show the deal is dead,
  they bought elsewhere, or they've gone definitively cold with no realistic path back (the same high bar
  as a Lost/cold-lead call elsewhere in this digest); OR a specific, current, logged note gives a concrete
  reason the urgency itself no longer holds - e.g. they're now waiting on an external event (financing
  falling through, a payout, selling another boat first) with no firm timeline, even though they're not
  dead as a prospect. In any of these cases, call update_lead_status yourself to correct the priority
  tier and/or hot flag to match reality, remove them from the sticky list if they no longer belong there,
  and report what you changed and why in ONE short line (e.g. "Downgraded Jeff Anderson to On Hold -
  waiting on a lawsuit payout with no firm timeline."). This instruction IS the authorization for that
  update_lead_status call - you do not need to ask the broker first here, unlike a normal live-chat
  priority change. The bar for what counts as real evidence doesn't change: going quiet for a few days,
  or today's notes just not being exciting, is NOT enough on its own - you need an actual logged reason,
  not just silence. When there's no such reason, leave it exactly as is and just report current status.
  Most days there should be few or none of these.

  MANDATORY: read their conversation timeline (get_conversation_timeline) AND their notes
  (get_contact_notes) to inform a good recommendation - a recent note can completely change the picture
  (e.g. a note logged yesterday saying a showing is booked means this lead does NOT belong in this
  section at all, even if get_contact_tasks shows no open task for it yet). The OUTPUT must be ONE SHORT
  SENTENCE per lead, nothing more. The broker already lived the history - don't replay it back to them.
  NO dates, NO "here's what happened," NO narrative walkthrough of the relationship. Just the name,
  tier, and the action.
  Exact format, one line, no exceptions: "[Lead Name] [(budget), if set] [priority emoji + label, or
  \"No priority set\"]: [ONE specific action]." That's the entire entry - nothing before it, nothing
  after it.
  Good example: "Charles Woods ($800K) No priority set: call him, ask if he looked at the Naval 78 v2 —
  looks like Active, want me to set it?"
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

Flag a lead as "alert" ONLY if BOTH of these hold - this is deliberately narrow, most digests should
have ZERO alerts, and this is NOT the place for routine missed-follow-up tracking (that's handled
separately, automatically, from real timestamps - don't duplicate it here):
1. ZERO contact of any kind - no message AND no note - for at least 7 full days, and as long as 14 days
   is still worth flagging. Verify this directly: call get_last_broker_contact_date AND
   get_contact_notes and confirm BOTH are silent for that whole window - a note logged 3 days ago with
   no message since does NOT qualify, and neither does a message 3 days ago with no note since. Genuine
   silence on both channels, for the full window, is required.
2. The deal was genuinely hot/promising BEFORE the silence started (strong buying signals, Buy Now
   tier with real engagement, a showing or offer that was actively moving) AND is now at real risk of
   being lost specifically because of that silence - not just "hasn't progressed" or "missed a
   follow-up." A lead that was lukewarm or early-stage before going quiet does not qualify, even after
   14 days - going quiet isn't itself a loss risk unless there was real momentum to lose.
Both conditions are required - a hot lead with a missed follow-up but recent contact otherwise does NOT
qualify, and a long-silent lead that was never actually hot does NOT qualify either. If a later note or
message already addressed the silence, it's not an alert - check for that before flagging.

HARD EXCLUSION RULE, no exceptions: if there has been a note logged OR any contact attempt (inbound or
outbound message, either direction) within the last 7 days, this lead must NOT be flagged as an alert -
full stop, regardless of how hot, urgent, or at-risk it otherwise looks. This restates condition 1 above
as an unambiguous exclusion specifically because it's the rule most likely to get second-guessed on a
lead that otherwise looks alarming - a recent note or message inside the 7-day window always wins over
how bad the situation looks on other signals.

Output the exact marker "===FLAGS===" on its own line right after "===END===", then a JSON array (even
if empty: []) of objects shaped like:
{"type": "near_close" or "alert", "leadName": "...", "reason": "one short sentence"}
Then output the exact marker "===END_FLAGS===" on its own line. Valid JSON only - no markdown code
fences, no trailing commas, no comments. If there's nothing to flag, output an empty array: [].

COVERAGE SELF-REPORT - a diagnostic, not shown to the broker. Right after "===END_FLAGS===", output
the exact marker "===COVERAGE===", then a single JSON object:
{"buyNowActiveTotal": N, "buyNowActiveChecked": M}
where N is the total number of this broker's leads with priority "Buy Now" or "Active" from
get_broker_leads_overview (before any exclusions), and M is how many of those you actually pulled
get_contact_notes and get_contact_tasks for (or get_conversation_timeline, for the email blind-spot
check) before writing about them or deciding to exclude them. M should equal N unless you genuinely
ran out of room - if M is less than N, that's expected to happen sometimes and is exactly what this
number is for, don't inflate it to match N. Then output the exact marker "===END_COVERAGE===" on its
own line, with nothing after it. Both coverage markers are required every time.

STICKY HOT LEAD REMOVALS - right after "===END_COVERAGE===", output the exact marker
"===HOT_LEAD_REMOVALS===", then a JSON array (even if empty: []) of any sticky hot leads you decided to
remove this run, per the HOT LEAD REMOVAL rule above:
{"contactId": "...", "reason": "one short sentence"}
Then output the exact marker "===END_HOT_LEAD_REMOVALS===" on its own line, with nothing after it. Both
markers are required every time, even when the array is empty - most days it will be.`;

/**
 * Generates a single person's morning digest. Cached for ~10 minutes (see
 * mainLeadsSheet.js), so every person in the same digest run gets
 * byte-identical instructions text - preserves prompt caching across the
 * whole roster loop, same as before this reference existed.
 * @param {{name: string, role: string}} identity - a roster entry
 * @returns {Promise<{text: string, flags: Array}>}
 */
/**
 * Deterministic pre-step, no Claude involved: resolves the broker's GHL user ID, fetches their
 * live lead overview (hot flag + outcome per lead, already free data this call would need
 * anyway), syncs the sticky digest_hot_leads table against it, and returns the text block to
 * inject into the instructions. Fails soft - a lookup problem here (e.g. a roster name that
 * doesn't resolve in GHL, same class of issue as Alex Siegers/Siegars) only means this run skips
 * sticky tracking, it never breaks the digest itself.
 */
async function buildStickyHotLeadsBlock(identity) {
  try {
    const brokerDirectory = await callGhlMcpTool(identity, "list_brokers", {});
    const directoryEntry = brokerDirectory.find(
      (b) => b.name.trim().toLowerCase() === identity.name.trim().toLowerCase()
    );
    if (!directoryEntry) {
      console.warn(`Sticky hot leads: no GHL user match for ${identity.name} - skipping for this run.`);
      return { stickyText: "", overview: null };
    }

    // get_broker_leads_overview loops a real GHL API call per assigned contact (see
    // ghlMcpClient.js) - genuinely slow, hence the 180s timeout. We need this same data for the
    // sticky sync below, so we fetch it ONCE here and hand it to the model as already-fetched
    // data (see generateMorningDigest) instead of making it call this same slow tool again itself.
    const overview = await callGhlMcpTool(identity, "get_broker_leads_overview", { brokerId: directoryEntry.id }, 180000);
    await syncHotLeadsFromOverview(identity.phone, overview);
    const active = await getActiveHotLeads(identity.phone);

    const stickyText = active.length === 0
      ? "\n\nSTICKY HOT LEADS (tracked, from previous digests): none yet for this broker."
      : `\n\nSTICKY HOT LEADS (tracked, from previous digests) - these MUST appear in today's Hot Leads section:\n${active.map((l) => `- ${l.name || "(name unknown)"} (contact ID: ${l.contactId})`).join("\n")}`;
    return { stickyText, overview };
  } catch (err) {
    console.warn(`Sticky hot leads: failed for ${identity.name}, skipping for this run:`, err.message);
    return { stickyText: "", overview: null };
  }
}

// "$350K", "$1.2M" - or null for no value. Anything under $1,000 is treated as unset, same
// floor as budgetParser.js (nobody buys a yacht for less, so it's a bad value, not a budget).
export function formatBudget(value) {
  const n = Number(value);
  if (!n || n < 1000) return null;
  if (n >= 999500) return `$${+(n / 1e6).toFixed(2)}M`;
  return `$${Math.round(n / 1e3)}K`;
}

// Leads the digest never names individually - no point spending a GHL call on their budget.
const SKIP_PRIORITY_RE = /low priority|on hold|closed/i;
const SKIP_OUTCOMES = new Set(["Sale Closed", "Lost"]);

/**
 * Adds a "budget" field to each overview lead: the value of their Buyer Pipeline deal. Leads
 * with no Buyer Pipeline deal, a zero value, or a lookup error get null - a failed lookup only
 * means that one line shows no budget, it never breaks the digest.
 */
async function addBudgetsToOverview(overview) {
  return Promise.all(
    overview.map(async (lead) => {
      if (SKIP_OUTCOMES.has(lead.outcome) || SKIP_PRIORITY_RE.test(lead.priority || "")) {
        return { ...lead, budget: null };
      }
      try {
        const opportunities = await getOpportunitiesForContact(lead.id);
        const values = opportunities
          .filter((o) => o.pipelineId === BUYER_PIPELINE_ID)
          .map((o) => Number(o.monetaryValue) || 0);
        return { ...lead, budget: formatBudget(Math.max(0, ...values)) };
      } catch (err) {
        console.warn(`Digest budgets: lookup failed for contact ${lead.id}:`, err.message);
        return { ...lead, budget: null };
      }
    })
  );
}

export async function generateMorningDigest(identity) {
  const [mainLeadsRef, buyerLeadsRef, { stickyText, overview: rawOverview }] = await Promise.all([
    getMainLeadsReference(),
    getBuyerLeadsReference(),
    buildStickyHotLeadsBlock(identity),
  ]);
  const overview = Array.isArray(rawOverview) ? await addBudgetsToOverview(rawOverview) : rawOverview;
  const overviewBlock = overview
    ? `\n\nBROKER LEADS OVERVIEW - ALREADY FETCHED, DO NOT CALL get_broker_leads_overview AGAIN: the full, ` +
      `current result of get_broker_leads_overview for this broker is given below as JSON - it is this run's ` +
      `real, fresh data (fetched moments ago), not a cached or stale copy, so every rule above that references ` +
      `get_broker_leads_overview's fields (priority, hot, outcome, lastOutboundMessageDate, etc.) applies to it ` +
      `exactly as if you'd called the tool yourself. Calling get_broker_leads_overview again this run would just ` +
      `re-fetch this same data a second time (it's a slow tool - one real GHL API call per lead) - use this ` +
      `instead:\n${JSON.stringify(overview)}`
    : "";
  const instructions = (mainLeadsRef ? `${MORNING_DIGEST_INSTRUCTIONS}\n\n${mainLeadsRef}` : MORNING_DIGEST_INSTRUCTIONS) +
    (buyerLeadsRef ? `\n\n${buyerLeadsRef}` : "") + overviewBlock + stickyText;

  const result = await runInternalReportWithFlagsAndCoverage(identity, instructions, "morning digest");

  if (result.hotLeadRemovals?.length) {
    try {
      const applied = await applyHotLeadRemovals(identity.phone, result.hotLeadRemovals);
      if (applied.length) console.log(`Sticky hot leads: removed for ${identity.name}:`, JSON.stringify(applied));
    } catch (err) {
      console.warn(`Sticky hot leads: failed to apply removals for ${identity.name}:`, err.message);
    }
  }

  return { text: result.text, flags: result.flags };
}
