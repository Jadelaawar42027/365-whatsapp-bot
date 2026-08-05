// Chapter 1: Morning Digest engine. This is a one-shot (no chat history)
// Claude call with full GHL tool access under a given identity, used to
// generate a proactive report rather than reply to a live message.
//
// Note: this v1 digest works from get_broker_leads_overview + conversation
// reads only (the tools that exist today). Chapter 2 adds precise
// next-action/task tracking (get_contact_tasks), which will sharpen the
// "Due Today" and "CRM Gaps" sections beyond what's inferable from
// conversation content alone.

import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "./knowledgeBase.js";
import { mintIdentityToken } from "./identity.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MORNING_DIGEST_INSTRUCTIONS = `Generate this person's MORNING DIGEST for today.

First, resolve their own GHL user ID via list_brokers (match on their name), then use
get_broker_leads_overview for their own ID to get the full lead list with touch/call counts. For any
lead that looks like it could be urgent or worth flagging, actually read the conversation timeline
(get_conversation_timeline) before characterizing it - per the standing rule, never judge a lead's
status from stage/value/touch-count alone.

Structure the digest in this order:

- Open with a short, warm one-line greeting using their name.
- "Urgent" - leads that need action today: actively-buying leads with no recent broker response,
  leads waiting on something specific (listings, confirmation, financing info), anything time-sensitive
  based on what you actually read in their conversations. For each: name the lead and ONE concrete
  recommended action.
- "Follow-ups worth a look" - leads that seem to be waiting on the broker based on conversation content
  (last message was inbound, no reply since). Keep brief.
- "Upcoming / long-term" - leads on a longer timeline, one line each, only if notably relevant.
- If a lead's most recent activity looks like it might be stale or the record looks thin, you can note
  it, but don't guess at "missing next action" precision yet - that's a future capability, so phrase any
  such observation as an FYI, not a confident claim.

Keep the WHOLE digest to 5-10 total priorities across all sections - if there's genuinely nothing
urgent, say so briefly and warmly rather than padding with minor items. If this person has no leads
assigned to them at all (e.g. a leadership account with no personal deal book), say so briefly rather
than returning an empty digest.`;

/**
 * Runs a one-shot Claude call with full tool access under the given
 * identity, for internal report generation rather than a live chat reply.
 */
async function runInternalPrompt(identity, instructions) {
  const baseSystemPrompt = await getSystemPrompt();
  const systemPrompt = `${baseSystemPrompt}\n\n---\n\nCURRENT USER: ${identity.name}, role: ${identity.role}. ` +
    `This is an automated internal report generation task, not a live chat reply - the person will read ` +
    `this as a WhatsApp message with no chance to ask follow-up questions in this exchange, so be complete ` +
    `enough to be useful but keep the WhatsApp-length/formatting rules from above.\n\n${instructions}`;

  const response = await anthropic.messages.create(
    {
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: systemPrompt,
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

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Generates a single person's morning digest.
 * @param {{name: string, role: string}} identity - a roster entry
 */
export async function generateMorningDigest(identity) {
  return runInternalPrompt(identity, MORNING_DIGEST_INSTRUCTIONS);
}
