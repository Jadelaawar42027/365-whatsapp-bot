import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "./knowledgeBase.js";
import { getIdentityForPhone } from "./brokerRoster.js";
import { mintIdentityToken } from "./identity.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory conversation history, keyed by phone number.
// This resets if the server restarts — fine for now. Production deployment
// should move this to a real store (Postgres, Redis, or a GHL custom object)
// so history survives restarts and can be inspected/audited.
const conversations = new Map();

const MAX_TURNS_KEPT = 20; // trim history so context doesn't grow unbounded

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

/**
 * Sends the user's message to Claude along with their conversation history,
 * appends the exchange to history, and returns Claude's reply text.
 *
 * Identity/permissions (Phase 4): the sender's phone number is resolved
 * against the broker roster. Registered senders get a signed identity token
 * minted for this request, which the GHL MCP server verifies and uses to
 * scope what data comes back (leadership = everything, broker = only their
 * own contacts/deals). Unregistered senders get no GHL tool access at all —
 * the bot still replies, but can't touch CRM data for them.
 *
 * @param {string} phone - sender's phone number, used as the conversation key
 * @param {string} userMessage - the incoming WhatsApp message text
 */
export async function askClaude(phone, userMessage) {
  const history = getHistory(phone);

  history.push({ role: "user", content: userMessage });

  const baseSystemPrompt = await getSystemPrompt();
  const identity = getIdentityForPhone(phone);

  let systemPrompt = baseSystemPrompt;
  let mcpServers;

  if (identity) {
    systemPrompt += `\n\n---\n\nCURRENT USER: ${identity.name}, role: ${identity.role}. ` +
      (identity.role === "leadership"
        ? "This person has full access to all contacts, deals, and broker performance data."
        : "This person is a broker restricted to their OWN assigned contacts and deals only. " +
          "The GHL tools enforce this automatically — if a tool call returns \"Access denied\", " +
          "explain plainly that the data belongs to another broker and is restricted to leadership. " +
          "Don't retry with different arguments to try to work around a denial.");

    mcpServers = [
      {
        type: "url",
        url: process.env.GHL_MCP_URL,
        name: "ghl-coaching-mcp",
        authorization_token: mintIdentityToken(identity),
      },
    ];
  } else {
    systemPrompt += `\n\n---\n\nCURRENT USER: not on the broker roster. You have NO access to GHL/CRM ` +
      `tools for this conversation. If asked about leads, deals, or CRM data, explain that this number ` +
      `isn't registered yet and to contact Aj to get added.`;
  }

  const requestBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: systemPrompt,
    messages: history,
  };
  if (mcpServers) requestBody.mcp_servers = mcpServers;

  const response = await anthropic.messages.create(
    requestBody,
    { headers: { "anthropic-beta": "mcp-client-2025-04-04" } }
  );

  const replyText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  history.push({ role: "assistant", content: replyText });

  // Trim oldest turns if history gets long
  if (history.length > MAX_TURNS_KEPT * 2) {
    history.splice(0, history.length - MAX_TURNS_KEPT * 2);
  }

  return replyText;
}
