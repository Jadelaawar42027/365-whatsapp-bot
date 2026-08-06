// Chapter 1 + 2: Morning Digest engine, now with real next-action tracking
// via get_contact_tasks (Chapter 2). This is a one-shot (no chat history)
// Claude call with full GHL tool access under a given identity, used to
// generate a proactive report rather than reply to a live message.

import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "./knowledgeBase.js";
import { mintIdentityToken } from "./identity.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MORNING_DIGEST_INSTRUCTIONS = `Generate this person's MORNING DIGEST for today.

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
