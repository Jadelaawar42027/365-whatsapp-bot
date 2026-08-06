// Chapter 1 + 2: Morning Digest engine, now with real next-action tracking
// via get_contact_tasks (Chapter 2). This is a one-shot (no chat history)
// Claude call with full GHL tool access under a given identity, used to
// generate a proactive report rather than reply to a live message.

import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "./knowledgeBase.js";
import { mintIdentityToken } from "./identity.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MORNING_DIGEST_INSTRUCTIONS = `Generate this person's MORNING DIGEST for today.

CRITICAL - this is a finished message being delivered directly to them on WhatsApp, not a live chat
turn. Never narrate what you're doing ("let me check...", "now let me pull...", "good overview, moving
on to...", "good, I now have everything I need..."). Don't describe your research process, and don't
write any transition/wrap-up sentence before the digest either - go straight from tool use into the
digest itself with nothing in between. Write directly TO the person, second person ("you", "your
leads"), like you're texting them - never refer to them by name in the third person as if describing
them to someone else (wrong: "Charlie's leads show..." - right: "Good morning Charlie! Here's what's
on your plate...").

MANDATORY FORMAT: once you're done using tools and are ready to write the digest, output the exact
marker "===DIGEST===" on its own line, then immediately begin the digest right after it on the next
line - nothing else between the marker and the digest, and nothing after the digest ends. Everything
before "===DIGEST===" is discarded automatically, so tool use and any unavoidable intermediate text is
fine before the marker - but the digest itself must start IMMEDIATELY at the marker with zero lead-in
sentence, not even one word of transition.

LEAD PRIORITY SYSTEM - the primary prioritization signal, from get_broker_leads_overview's "priority"
and "hot" fields:
- 🔴 Buy Now: purchasing within 0-30 days, budget verified, financing/proof of funds available,
  responding to messages, ready to schedule or actively viewing. Contact almost daily, right away.
- 🟠 Active: 30-90 days out, serious buyer, still comparing options, needs regular follow-up.
- 🟡 Nurture: 3-12 months out, still researching, wants recommendations/education.
- ⚪ Low Priority: very early stage, no defined budget, browsing only, infrequent engagement.
- ⚫ On Hold: explicitly asked to pause (vacation, waiting to sell another boat, waiting on financing) -
  respect this, don't chase.
- 🚫 Closed: bought elsewhere, no longer interested, unqualified - never mention these at all.

🔥 HOT is a SEPARATE flag, independent of priority - it means someone showed a strong, immediate buying
signal regardless of tier. A lead can be "🔥 🟠 Active" if they suddenly said something urgent even
though their overall timeline is still 30-90 days.

PER-LEAD FORMAT (use this exact pattern whenever naming a specific lead in the digest):
"[Lead Name] [🔥 if hot][priority emoji] [priority label]: [what's going on + the one recommended
action]"
Example: "Barry Lee 🔥 🔴 Buy Now: asked to schedule a viewing this week and hasn't heard back — call
him today to lock in a time."
Example without hot: "Silvia Reyes 🟠 Active: comparing two other listings, due for a check-in — send
her the comps you promised."

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
and mention in the digest that you flagged it.

Structure the digest in this order, ALWAYS with Hot leads (regardless of tier) surfaced first, then
Buy Now, then Active, then Nurture:

- Open with a short, warm one-line greeting using their name.
- Every Hot lead first, regardless of tier, using the per-lead format above.
- Then remaining "Buy Now" leads worth a mention: overdue per get_last_broker_contact_date,
  overdue/due-today tasks, anything time-sensitive. Buy Now leads with nothing outstanding can be
  omitted or given a one-line "on track" mention.
- Then "Active" leads overdue on follow-up per get_last_broker_contact_date, or with an
  overdue/due-today task.
- "Nurture" - ONLY mention individually if genuinely overdue or something notable came up. Keep short.
- "No next action set" - Buy Now or Active leads with ZERO open tasks (confident claim from
  get_contact_tasks, not a guess) - say so plainly and suggest the likely next step.
- Never individually mention Low Priority, On Hold, or Closed leads. A single closing line noting
  counts is enough if relevant (e.g. "6 leads on nurture, 3 on hold — nothing needs you there today").

Keep the WHOLE digest to 5-10 total priorities - if there's genuinely nothing urgent, say so briefly
and warmly rather than padding with minor items. If this person has no leads assigned to them at all
(e.g. a leadership account with no personal deal book), say so briefly rather than returning an empty
digest. Don't run get_contact_tasks or read full conversations for every single lead if the list is
long - prioritize Hot, Buy Now, and Active first, and it's fine to note that lower-priority leads
weren't individually checked since that matches how they're meant to be handled.`;

const DIGEST_MARKER = "===DIGEST===";

/**
 * Runs a one-shot Claude call with full tool access under the given
 * identity, for internal report generation rather than a live chat reply.
 *
 * Prompt caching: the base system prompt AND the digest instructions are
 * identical across every person in a digest run (only name/role differ) -
 * so both go in one cached block, with just the tiny per-person line left
 * uncached. Since the trigger endpoint loops through everyone ~1s apart,
 * this means only the FIRST person's digest pays full price; the rest hit
 * cache on this entire block.
 */
async function runInternalPrompt(identity, instructions) {
  const baseSystemPrompt = await getSystemPrompt();
  const staticBlock = `${baseSystemPrompt}\n\n---\n\n` +
    `This is an automated internal report generation task, not a live chat reply - the person will read ` +
    `this as a WhatsApp message with no chance to ask follow-up questions in this exchange, so be complete ` +
    `enough to be useful but keep the WhatsApp-length/formatting rules from above.\n\n${instructions}`;
  const userContext = `CURRENT USER: ${identity.name}, role: ${identity.role}.`;

  const response = await anthropic.messages.create(
    {
      model: "claude-sonnet-4-6",
      // A moderate, controlled budget rather than an unbounded ceiling -
      // if a run genuinely needs more (a broker with a very long lead
      // list), the fallback below kicks in instead of the response just
      // going missing.
      max_tokens: 3000,
      system: [
        { type: "text", text: staticBlock, cache_control: { type: "ephemeral" } },
        { type: "text", text: userContext },
      ],
      messages: [{ role: "user", content: "Generate the report now." }],
      mcp_servers: [
        {
          type: "url",
          url: process.env.GHL_MCP_URL,
          name: "ghl-coaching-mcp",
          authorization_token: mintIdentityToken(identity),
        },
      ],
    },
    { headers: { "anthropic-beta": "mcp-client-2025-04-04" } }
  );

  // Extraction: split on the required "===DIGEST===" marker rather than
  // trusting the model to never write a lead-in sentence. Prompt
  // instructions alone weren't reliable enough - Claude sometimes wrote a
  // short transition ("Good, I have what I need...") in the SAME text block
  // as the real digest, which block-boundary splitting can't separate. A
  // hard, code-enforced marker is deterministic instead of hopeful.
  const allText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const markerIndex = allText.lastIndexOf(DIGEST_MARKER);
  let finalText;

  if (markerIndex !== -1) {
    finalText = allText.slice(markerIndex + DIGEST_MARKER.length).trim();
  } else {
    // Fallback if the model didn't include the marker for some reason -
    // last text block is still better than nothing, and this branch
    // logs so drift like this is visible rather than silent.
    console.warn(`Digest for ${identity.name} did not include the ${DIGEST_MARKER} marker - falling back to last text block.`);
    const textBlocks = response.content.filter((block) => block.type === "text");
    finalText = (textBlocks[textBlocks.length - 1]?.text || "").trim();
  }

  // Graceful degradation on truncation: rather than raising max_tokens
  // indefinitely, handle the cap being hit explicitly. Two cases:
  // (1) generation was cut off mid-tool-call, before ever writing the
  //     digest - there's nothing usable to send, so say so plainly.
  // (2) generation was cut off while writing the digest itself - send
  //     what was written, clearly marked as incomplete, rather than
  //     silently dropping it.
  if (response.stop_reason === "max_tokens") {
    console.warn(`Digest for ${identity.name} hit the max_tokens cap (stop_reason: max_tokens).`);

    if (finalText) {
      finalText += "\n\n_(Cut off — hit a response length limit before finishing. Ask me to continue for the rest.)_";
    } else {
      finalText = "I started pulling your digest together but hit a response length limit before I could " +
        "finish writing it. Try asking me again, or ping Aj if this keeps happening.";
    }
  }

  return finalText;
}

/**
 * Generates a single person's morning digest.
 * @param {{name: string, role: string}} identity - a roster entry
 */
export async function generateMorningDigest(identity) {
  return runInternalPrompt(identity, MORNING_DIGEST_INSTRUCTIONS);
}
