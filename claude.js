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

  // CRITICAL: Claude has no built-in awareness of the current date/time -
  // it only knows what's in its context. Without this, every "is this
  // overdue", "due today", "how many days since" comparison is a guess.
  // This must be in the UNCACHED block since it changes on every request.
  const now = new Date();
  const dateContext = `CURRENT DATE/TIME: ${now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })}. Use this as ground truth for "today", "overdue", "how long ago", etc. - never guess or infer the
current date from anything else.`;

  let userContext;
  let mcpServers;

  if (identity) {
    userContext = `${dateContext}\n\nCURRENT USER: ${identity.name}, role: ${identity.role}. ` +
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
    userContext = `${dateContext}\n\nCURRENT USER: not on the broker roster. You have NO access to GHL/CRM ` +
      `tools for this conversation. If asked about leads, deals, or CRM data, explain that this number ` +
      `isn't registered yet and to contact Aj to get added.`;
  }

  // Prompt caching: the base system prompt (core rules + knowledge base doc)
  // is identical across every call for every user - a textbook cache
  // candidate. It's marked as its own block with cache_control so repeat
  // calls within the 5-minute window pay ~10% of normal input price for
  // this ~8-9k token block instead of full price every time.
  //
  // IMPORTANT: per-user content (name/role) must stay OUT of the cached
  // block - caching requires byte-for-byte identical content, so anything
  // that varies per person goes in a separate, small, uncached block after it.
  const requestBody = {
    model: "claude-sonnet-4-6",
    // A moderate, controlled budget covering the whole agentic turn (tool
    // calls + narration + final reply), not just the visible answer. Rather
    // than raising this indefinitely, truncation is handled explicitly
    // below - see digest.js for the fuller explanation of why a tight cap
    // can otherwise cut a reply off mid-generation on complex questions.
    max_tokens: 2000,
    system: [
      { type: "text", text: baseSystemPrompt, cache_control: { type: "ephemeral" } },
      { type: "text", text: userContext },
    ],
    messages: history,
  };
  if (mcpServers) requestBody.mcp_servers = mcpServers;

  const response = await anthropic.messages.create(
    requestBody,
    { headers: { "anthropic-beta": "mcp-client-2025-04-04" } }
  );

  let replyText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  // Graceful degradation on truncation, same pattern as the digest engine:
  // send whatever real content exists (clearly marked as cut off), or a
  // plain "hit a limit" message if there's nothing usable yet.
  if (response.stop_reason === "max_tokens") {
    console.warn(`Reply to ${phone} hit the max_tokens cap (stop_reason: max_tokens).`);

    if (replyText) {
      replyText += "\n\n_(Cut off — hit a response length limit. Ask me to continue if you need the rest.)_";
    } else {
      replyText = "I hit a response length limit before I could finish answering that — try asking again, " +
        "maybe in a more specific way, or ping Aj if this keeps happening.";
    }
  }

  history.push({ role: "assistant", content: replyText });

  // Trim oldest turns if history gets long
  if (history.length > MAX_TURNS_KEPT * 2) {
    history.splice(0, history.length - MAX_TURNS_KEPT * 2);
  }

  return replyText;
}
