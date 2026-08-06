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

First, resolve their own GHL user ID via list_brokers (match on their name), then use
get_broker_leads_overview for their own ID to get the full lead list with touch/call counts. For each
lead worth considering for the digest, call get_contact_tasks to check whether they have an open
(incomplete) task and what its due date is - this is the real signal for "next action" and "due today,"
not a guess. For any lead that looks like it could be urgent or worth flagging, also actually read the
conversation timeline (get_conversation_timeline) before characterizing it - per the standing rule,
never judge a lead's status from stage/value/touch-count alone.

Structure the digest in this order:

- Open with a short, warm one-line greeting using their name.
- "Urgent" - leads that need action today: actively-buying leads with no recent broker response,
  leads waiting on something specific (listings, confirmation, financing info), anything time-sensitive
  based on what you actually read in their conversations - PLUS any lead whose open task has a due date
  of today or earlier (overdue). For each: name the lead and ONE concrete recommended action.
- "Due today" - leads with an open task whose due date is today, that aren't already covered above.
  This should now be based on real task due dates, not inference.
- "Follow-ups worth a look" - leads that seem to be waiting on the broker based on conversation content
  (last message was inbound, no reply since) but don't have an open task yet. Keep brief.
- "Upcoming / long-term" - leads on a longer timeline, one line each, only if notably relevant.
- "No next action set" - leads with ZERO open tasks. This is now a confident claim, not a soft FYI: if
  get_contact_tasks comes back with no incomplete tasks for an active lead, say so plainly and suggest
  what the next step should probably be based on the conversation content. Every active lead should have
  a next action - this section exists specifically to catch the ones that don't.

Keep the WHOLE digest to 5-10 total priorities across all sections - if there's genuinely nothing
urgent, say so briefly and warmly rather than padding with minor items. If this person has no leads
assigned to them at all (e.g. a leadership account with no personal deal book), say so briefly rather
than returning an empty digest. Don't run get_contact_tasks on every single lead if the list is long -
prioritize the ones that look active/relevant from the overview first, and it's fine to note that older
or clearly-inactive leads weren't individually checked.`;

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
