import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt, getMasterReferenceText } from "./knowledgeBase.js";
import { mintIdentityToken } from "./identity.js";
import { getContactMemory, upsertContactMemory } from "./db/contactsMemory.js";
import { insertInteractionLog, getRecentInteractions } from "./db/interactionLog.js";
import { insertHotLead } from "./db/hotLeads.js";
import { insertFollowupEvent } from "./db/followupEvents.js";
import { insertAiActionLog } from "./db/aiActionsLog.js";
import { getIdentityByName } from "./brokerRoster.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Adds an ephemeral cache_control marker to the LAST content block of a
 * message (wrapping bare string content into a block array first, since
 * cache_control only attaches to a block, not a raw string). Exported for
 * direct testing of the marker-moving logic without a live API call.
 */
export function withCacheMarker(content) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
  const last = blocks.length - 1;
  blocks[last] = { ...blocks[last], cache_control: { type: "ephemeral" } };
  return blocks;
}

/**
 * Strips a cache_control marker back off the last content block - used to
 * move the ONE rolling marker forward each tool-loop iteration instead of
 * accumulating a new one every time, which would blow past Anthropic's
 * 4-breakpoint-per-request cap within a handful of iterations.
 */
export function withoutCacheMarker(content) {
  if (typeof content === "string") return content;
  const blocks = [...content];
  const last = blocks.length - 1;
  const { cache_control, ...rest } = blocks[last];
  blocks[last] = rest;
  return blocks;
}

/**
 * Strips the rolling marker off its old position (if any) and applies it to
 * the newest message instead - mutates `messages` in place, returns the new
 * index to track. Keeps exactly one rolling breakpoint at a time (plus the
 * system prompt's own = 2 total, well under the 4-per-request cap)
 * regardless of how many loop iterations run.
 */
export function moveRollingMarker(messages, oldIdx, mark = withCacheMarker, unmark = withoutCacheMarker) {
  if (oldIdx >= 0) {
    messages[oldIdx] = { ...messages[oldIdx], content: unmark(messages[oldIdx].content) };
  }
  const newIdx = messages.length - 1;
  messages[newIdx] = { ...messages[newIdx], content: mark(messages[newIdx].content) };
  return newIdx;
}

// Memory layer (Postgres) is optional - degrades to "no memory tools offered"
// rather than the bot erroring on every message if it isn't configured.
const MEMORY_ENABLED = Boolean(process.env.AIBOT_DATABASE_URL);
// Bounds the local tool loop below - a normal turn uses 0-2 round trips.
// Leadership gets a much higher cap: a large batch request (e.g. "go
// through all 23 reactivation leads") can legitimately pause_turn several
// times over a long agentic run, same reasoning as their 128K max_tokens.
const MAX_TOOL_ITERATIONS = 6;
const MAX_TOOL_ITERATIONS_ADMIN = 25;

// Two local tools alongside the existing remote GHL/analytics MCP
// connectors. Unlike those, tool_use blocks for these two DO reach our code
// (local tools execute client-side) and must be executed and looped, unlike
// the MCP ones which Anthropic resolves server-side before the response
// ever reaches us.
const MEMORY_TOOL_NAMES = new Set(["get_contact_memory", "record_contact_interaction"]);
const MEMORY_TOOLS = [
  {
    name: "get_contact_memory",
    description:
      "Fetch this bot's own persisted memory for a specific GHL contact - prior AI summary, sentiment " +
      "trend, consecutive missed follow-ups, and the last several logged interactions. Call this once " +
      "you've identified which contact (by GHL contact ID, from a GHL tool lookup) the conversation " +
      "concerns, before answering anything about their history or momentum. An empty result just means " +
      "this contact has no memory yet (new contact) - that's normal, not an error.",
    input_schema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "The GHL contact ID this memory concerns." },
      },
      required: ["contact_id"],
    },
  },
  {
    name: "record_contact_interaction",
    description:
      "Persist what happened this turn for a specific GHL contact. Call this once, near the end of your " +
      "turn, only when the conversation actually concerned a specific resolved contact (by GHL contact " +
      "ID) - skip it for generic questions with no specific contact. Never invent field values - omit an " +
      "optional field rather than guessing.",
    input_schema: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        lead_name: {
          type: "string",
          description: "The lead's name (from GHL), so this memory can be shown later without a fresh GHL lookup - include it whenever you know it.",
        },
        assigned_broker_name: {
          type: "string",
          description:
            "ONLY needed if you (the current user) are leadership: the name of the broker this GHL " +
            "contact is assigned to (from the contact's owner/assigned-user field in GHL), so this memory " +
            "gets recorded under the correct broker. Not needed and ignored if you are a broker or setter " +
            "- your own contacts are recorded automatically.",
        },
        summary: { type: "string", description: "One or two sentence summary of what this exchange covered." },
        extracted_intent: { type: "string" },
        extracted_objection_category: { type: "string" },
        extracted_urgency: { type: "string" },
        sentiment_trend: { type: "string", enum: ["improving", "stable", "declining"] },
        missed_followup: {
          type: "boolean",
          description: "Include true/false only if this exchange revealed whether a scheduled follow-up was missed.",
        },
        hot_lead: {
          type: "object",
          description: "Include only if this contact should be flagged/re-flagged as a hot lead based on this exchange.",
          properties: {
            trigger_reason: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
        },
      },
      required: ["contact_id", "summary"],
    },
  },
];

/**
 * Executes one memory-tool call. Permission enforcement happens entirely
 * here in code via `caller` (resolved by askClaude from the sender's
 * identity, never from anything Claude passes) - see db/scoping.js. Errors
 * are swallowed into a generic message so a DB hiccup degrades the memory
 * feature for this turn without taking down the whole reply.
 */
async function executeMemoryTool(block, caller, channel) {
  if (!caller) return JSON.stringify({ error: "no memory access for this sender" });

  try {
    if (block.name === "get_contact_memory") {
      const [memory, recentInteractions] = await Promise.all([
        getContactMemory(caller, block.input.contact_id),
        getRecentInteractions(caller, block.input.contact_id, 10),
      ]);
      return JSON.stringify({ memory, recentInteractions });
    }

    if (block.name === "record_contact_interaction") {
      const {
        contact_id: contactId,
        lead_name: leadName,
        assigned_broker_name: assignedBrokerName,
        summary,
        extracted_intent: extractedIntent,
        extracted_objection_category: extractedObjectionCategory,
        extracted_urgency: extractedUrgency,
        sentiment_trend: sentimentTrend,
        missed_followup: missedFollowup,
        hot_lead: hotLead,
      } = block.input;

      // Only matters for a leadership caller - resolveWriteBrokerId ignores
      // this for broker/setter (their own identity is forced regardless).
      // Leadership isn't tied to one broker's book, so there's nothing to
      // force it to - the AI has to name whose contact this is.
      let requestedBrokerId;
      if (caller.role === "leadership") {
        if (!assignedBrokerName) {
          return JSON.stringify({
            error: "As leadership, you must pass assigned_broker_name (the GHL contact's assigned broker) to record this.",
          });
        }
        const resolved = getIdentityByName(assignedBrokerName);
        if (!resolved) {
          return JSON.stringify({
            error: `Could not match "${assignedBrokerName}" to a registered broker - check the spelling against GHL's assigned-user name exactly.`,
          });
        }
        requestedBrokerId = resolved.phone;
      }

      await insertInteractionLog(caller, contactId, requestedBrokerId, {
        channel: channel || "whatsapp",
        direction: "inbound",
        summary,
        extractedIntent,
        extractedObjectionCategory,
        extractedUrgency,
      });

      let consecutiveMissedFollowups;
      if (typeof missedFollowup === "boolean") {
        const existing = await getContactMemory(caller, contactId);
        consecutiveMissedFollowups = missedFollowup ? (existing?.consecutive_missed_followups ?? 0) + 1 : 0;
        // Timestamped trail the morning digest escalates from (see
        // db/followupEvents.js's getStaleMissedFollowups) - "missed" now,
        // or "completed" if this turn shows the broker actually followed up,
        // which resolves any previously-flagged miss for this contact.
        await insertFollowupEvent(caller, contactId, requestedBrokerId, {
          outcome: missedFollowup ? "missed" : "completed",
          flaggedAt: missedFollowup ? new Date() : null,
        });
      }

      await upsertContactMemory(caller, contactId, requestedBrokerId, {
        contactName: leadName,
        lastAiSummary: summary,
        sentimentTrend,
        lastContactedAt: new Date(),
        consecutiveMissedFollowups,
      });

      if (hotLead?.trigger_reason) {
        await insertHotLead(caller, contactId, requestedBrokerId, {
          triggerReason: hotLead.trigger_reason,
          confidence: hotLead.confidence,
          triggerSource: `${channel || "whatsapp"} interaction`,
        });
      }

      await insertAiActionLog(caller, contactId, requestedBrokerId, {
        actionType: "memory_write_back",
        reasoning: summary,
        autoExecuted: true,
      });

      return JSON.stringify({ ok: true });
    }

    return JSON.stringify({ error: `unknown tool ${block.name}` });
  } catch (err) {
    console.error(`Memory tool ${block.name} failed:`, err.message);
    return JSON.stringify({ error: "memory lookup/write failed this turn - continue without it, don't retry" });
  }
}

// Strictly on-demand trigger for the (large) Broker Master Reference doc -
// only fetched and injected when a message actually asks for it, not
// included in every system prompt. See the injection point below for why.
const MASTER_DOC_TRIGGER = /master doc/i;

// In-memory conversation history, keyed by conversationKey (a phone number
// for WhatsApp, a Slack user ID for Slack - any unique per-sender string).
// This resets if the server restarts — fine for now. Production deployment
// should move this to a real store (Postgres, Redis, or a GHL custom object)
// so history survives restarts and can be inspected/audited.
const conversations = new Map();

const MAX_TURNS_KEPT = 20; // trim history so context doesn't grow unbounded

function getHistory(conversationKey) {
  if (!conversations.has(conversationKey)) conversations.set(conversationKey, []);
  return conversations.get(conversationKey);
}

// Outbound WhatsApp template sends (see server.js's runDailyTemplateSequence)
// never touch `conversations` above - they go out via the raw WhatsApp API,
// not through askClaude - so a person's FIRST reply to one (often just
// "yes", mirroring the template's own "reply yes to activate" wording) has
// zero history to make sense of. Without this, that bare "yes" looks like a
// cut-off message with no context, and the AI says so - exactly the bug
// this fixes. One-shot: consumed (deleted) the moment the next message from
// that person is processed, so it only ever affects that first reply.
const pendingTemplateContext = new Map();

/**
 * Call right after successfully sending a WhatsApp template, so the
 * recipient's next reply - even a bare "yes" - has enough context to
 * interpret correctly instead of looking like a truncated message.
 * @param {string} conversationKey - the recipient's phone number
 * @param {string} templateText - the template's actual approved body text
 */
export function markTemplateSent(conversationKey, templateText) {
  pendingTemplateContext.set(conversationKey, templateText);
}

/**
 * Sends the user's message to Claude along with their conversation history,
 * appends the exchange to history, and returns Claude's reply text. This is
 * the shared engine behind every channel - it doesn't know or care whether
 * conversationKey is a WhatsApp phone number or a Slack user ID.
 *
 * Identity/permissions (Phase 4): identity is resolved by the CALLER
 * (each channel has its own directory of who's who - see getIdentityForPhone
 * in brokerRoster.js for WhatsApp, getIdentityForSlackUser for Slack) and
 * passed in already-resolved. Registered identities get a signed identity
 * token minted for this request, which the GHL MCP server verifies and uses
 * to scope what data comes back (leadership/setter = broad read access,
 * broker = only their own contacts/deals - see access.js in the GHL MCP
 * server repo). Unregistered senders (identity is null/undefined) get no
 * GHL tool access at all - the bot still replies, but can't touch CRM data
 * for them.
 *
 * @param {string} conversationKey - unique per-channel sender identifier (phone number, Slack user ID), used as the conversation history key
 * @param {string} userMessage - the incoming message text
 * @param {{name: string, role: string, phone?: string}|null|undefined} identity - resolved identity for this sender, or null/undefined if unregistered
 * @param {'whatsapp'|'slack'} [channel] - which channel this came in on, recorded on interaction_log rows
 */
const UNREGISTERED_REPLY =
  "Hey — this number isn't registered yet, so I can't help with leads/deals here. Ping Aj to get added.";

export async function askClaude(conversationKey, userMessage, identity, channel) {
  // Cost win, zero capability loss: this reply never varies regardless of
  // what an unregistered sender writes (wrong number, spam, an old number
  // still saved by someone no longer with the team) - no real judgment was
  // ever being exercised by routing this through a full Claude call against
  // the cached system prompt, so skip the API entirely rather than paying
  // for a deterministic boilerplate reply. Also skips ever touching
  // `history` for a sender who'll never get a different answer either way.
  if (!identity) return UNREGISTERED_REPLY;

  const history = getHistory(conversationKey);

  // broker_id throughout db/ is the WhatsApp roster phone number
  // (brokerRoster.js's own primary key) - the one stable identity this
  // codebase already has. For WhatsApp senders, conversationKey IS that
  // phone number; getIdentityForSlackUser attaches it as identity.phone for
  // Slack senders. Unregistered senders (identity null) get no memory access.
  const caller = identity ? { role: identity.role, brokerId: identity.phone || conversationKey } : null;

  // Leadership gets a much larger max_tokens budget below (for large batch
  // turns) - a turn that big can run long enough to outlast the identity
  // token's default 5-minute expiry, so it also needs a longer-lived token.
  const isAdmin = identity?.role === "leadership";

  history.push({ role: "user", content: userMessage });

  const baseSystemPrompt = await getSystemPrompt(identity?.role || "broker");

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
  let tools;

  if (identity) {
    const accessDescription = identity.role === "leadership"
      ? "This person has full access to all contacts, deals, and broker performance data."
      : identity.role === "setter"
      ? "This person can VIEW any contact, conversation, call transcript, notes, tasks, and opportunities " +
        "across the whole team - read access is NOT restricted to their own contacts, since setters need " +
        "to look up any lead for qualification calls. However, WRITE actions (creating/editing tasks, " +
        "adding notes, changing lead priority/hot flag, updating opportunity stage, reassigning a contact) " +
        "are still restricted to contacts assigned to them, same as a broker - if a WRITE tool call returns " +
        "\"Access denied\", explain plainly that editing someone else's contact is restricted to leadership. " +
        "Don't retry with different arguments to try to work around a denial."
      : "This person is a broker restricted to their OWN assigned contacts and deals only. " +
        "The GHL tools enforce this automatically — if a tool call returns \"Access denied\", " +
        "explain plainly that the data belongs to another broker and is restricted to leadership. " +
        "Don't retry with different arguments to try to work around a denial.";

    const setterNote = identity.role === "setter"
      ? " This person is a setter, not a broker - their job is outbound qualification and booking " +
        "calls, not deal management, negotiation, or closing. Follow the Setter SOPs in the KNOWLEDGE " +
        "BASE section above rather than assuming broker playbook context applies."
      : "";

    // Business consultant capability - leadership only. get_broker_metrics/
    // get_setter_metrics/get_overview_metrics/get_partner_metrics/get_ad_spend come
    // from the yachts-analytics-mcp server, wired in below alongside GHL. This is
    // ad-hoc only (no scheduled report) - leadership just asks whenever they want.
    const consultantNote = isAdmin
      ? " You also have business analytics tools (get_broker_metrics, get_setter_metrics, " +
        "get_overview_metrics, get_partner_metrics, get_ad_spend), each for an arbitrary date range. " +
        "When leadership asks an analytical or strategic question (e.g. \"look at setter numbers for " +
        "the last 6 months and find patterns, factor in ad spend\"), act as a business/sales " +
        "performance consultant, not just a data lookup: pull whatever combination of tools the " +
        "question needs (calling a segment tool across multiple date ranges to see a trend, and " +
        "get_ad_spend alongside it to actually correlate spend against performance yourself - these " +
        "tools return raw data, not a pre-computed correlation), name concrete patterns you actually " +
        "see in the numbers rather than just reciting them back, and close with a specific, actionable " +
        "recommendation (a training focus, a budget shift, a process change) - not just an observation " +
        "with no next step."
      : "";

    const memoryNote = MEMORY_ENABLED
      ? " You also have get_contact_memory and record_contact_interaction tools - call get_contact_memory " +
        "once you know which GHL contact a question concerns, before answering anything about their " +
        "history/momentum, and call record_contact_interaction near the end of your turn for any exchange " +
        "that concerned a specific resolved contact."
      : "";

    userContext = `${dateContext}\n\nCURRENT USER: ${identity.name}, role: ${identity.role}. ` +
      accessDescription + setterNote + consultantNote + memoryNote;

    // Master reference doc - tens of thousands of tokens, so it's fetched and
    // injected for THIS TURN ONLY when the message explicitly asks for it
    // (uncached, unlike the regular knowledge base doc), not included in
    // every system prompt. Not offered to setters - this is broker/
    // leadership sales/product/deal-mechanics content, same scoping as the
    // regular knowledge base doc.
    if (identity.role !== "setter" && MASTER_DOC_TRIGGER.test(userMessage)) {
      const masterDoc = await getMasterReferenceText();
      userContext += masterDoc
        ? `\n\n---\n\nMASTER REFERENCE DOC (requested this turn - "365 Yachts Broker Master Reference"):\n\n${masterDoc}`
        : `\n\n---\n\nThe user asked to use the master reference doc, but it isn't configured yet ` +
          `(GOOGLE_DOC_KNOWLEDGE_ID_2 not set) - tell them plainly rather than pretending to have it.`;
    }

    // Same identity token works for every MCP server here - each verifies it
    // independently against the shared JWT_SECRET, so there's no need to mint a
    // separate token per server.
    const identityToken = mintIdentityToken(identity, isAdmin ? 20 : 5);

    mcpServers = [
      {
        type: "url",
        url: process.env.GHL_MCP_URL,
        name: "ghl-coaching-mcp",
        authorization_token: identityToken,
      },
    ];

    if (isAdmin && process.env.YACHTS_ANALYTICS_MCP_URL) {
      mcpServers.push({
        type: "url",
        url: process.env.YACHTS_ANALYTICS_MCP_URL,
        name: "yachts-analytics-mcp",
        authorization_token: identityToken,
      });
    }

    // NOTE: mcp_servers above does NOT need a paired `tools` entry on this
    // API surface (that's a different, beta client surface) - adding an
    // `mcp_toolset` type here was rejected outright with a 400 in
    // production. `tools` below is ONLY the local memory tools.
    if (MEMORY_ENABLED) tools = [...MEMORY_TOOLS];
  }
  // (no `else` - unregistered senders return early above, before this point)

  // One-shot: only the reply immediately after a template send sees this note.
  const pendingTemplate = pendingTemplateContext.get(conversationKey);
  if (pendingTemplate) {
    pendingTemplateContext.delete(conversationKey);
    userContext += `\n\nNOTE: this person was just sent this WhatsApp template message: "${pendingTemplate}" - ` +
      `if their reply is short (e.g. "yes", "yep", "ready"), treat it as a direct answer to that, not as a ` +
      `truncated or cut-off message - respond naturally to what they confirmed, don't ask if their message got cut off.`;
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

  // Everyone else gets a moderate, controlled budget covering the whole
  // agentic turn (tool calls + narration + final reply), not just the
  // visible answer - see digest.js for the fuller explanation of why a
  // tight cap can otherwise cut a reply off mid-generation on complex
  // questions. Leadership gets claude-sonnet-4-6's actual max output
  // (128K) instead - as close to "no limit" as the API allows - since an
  // admin firing a large batch of GHL updates in one turn can burn through
  // the standard budget well before finishing. 128K max_tokens requires
  // streaming rather than a plain create() call, to avoid the SDK's HTTP
  // timeout on very large non-streaming responses.
  // Scratch copy for this turn's tool round-trips - NOT the persisted
  // `history`. Only the final plain-text reply gets pushed back into
  // `history` below, same as before the memory tools existed, so a turn
  // that calls get_contact_memory/record_contact_interaction doesn't bloat
  // every future request with this turn's internal tool exchange.
  let turnMessages = [...history];

  // Second cache breakpoint, on top of the system-prompt one below: the
  // tool loop can make 2-3 separate API calls in ONE turn (get memory ->
  // GHL lookups -> record memory), and without this, every one of those
  // calls re-sends the entire prior conversation history at full price -
  // only the first call's history is a cache write, every call after it
  // within this same turn (and the next turn, if within the TTL) reads it
  // at ~10% of that. Only the LAST pre-loop message needs the breakpoint;
  // caching covers everything up to and including it.
  const lastIdx = turnMessages.length - 1;
  if (lastIdx >= 0 && typeof turnMessages[lastIdx].content === "string") {
    turnMessages[lastIdx] = { ...turnMessages[lastIdx], content: withCacheMarker(turnMessages[lastIdx].content) };
  }
  // Tracks whichever message currently carries the SECOND (rolling)
  // breakpoint below - only ever one at a time, moved forward each tool
  // loop iteration, so a long multi-round-trip turn (e.g. reviewing a call:
  // find it, pull the transcript, write the review) doesn't resend
  // everything already seen at full price on every single round trip.
  let rollingCacheIdx = lastIdx >= 0 ? lastIdx : -1;

  const requestBody = {
    model: "claude-sonnet-4-6",
    max_tokens: isAdmin ? 128000 : 2000,
    system: [
      { type: "text", text: baseSystemPrompt, cache_control: { type: "ephemeral" } },
      { type: "text", text: userContext },
    ],
    messages: turnMessages,
  };
  if (mcpServers) requestBody.mcp_servers = mcpServers;
  if (tools) requestBody.tools = tools;

  const requestOptions = { headers: { "anthropic-beta": "mcp-client-2025-04-04" } };

  let response;
  let toolRoundTrips = 0;
  // Text can legitimately arrive in an EARLIER round, not just the final
  // one - the memory-tool instructions literally tell the model to answer
  // first, THEN call record_contact_interaction "near the end of your
  // turn." When that closing tool-call round has nothing further to add
  // (correctly - it already answered), extracting text from only the LAST
  // response discards the real answer from the round before it. Accumulate
  // every round's text instead, in order.
  const textParts = [];
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const maxIterations = isAdmin ? MAX_TOOL_ITERATIONS_ADMIN : MAX_TOOL_ITERATIONS;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    response = isAdmin
      ? await anthropic.messages.stream(requestBody, requestOptions).finalMessage()
      : await anthropic.messages.create(requestBody, requestOptions);

    usage.input += response.usage?.input_tokens ?? 0;
    usage.cacheWrite += response.usage?.cache_creation_input_tokens ?? 0;
    usage.cacheRead += response.usage?.cache_read_input_tokens ?? 0;
    usage.output += response.usage?.output_tokens ?? 0;

    const roundText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (roundText) textParts.push(roundText);

    // pause_turn: a long agentic run (e.g. a big batch of GHL tool calls
    // across many contacts) got paused, NOT finished - resuming means
    // resending the response content back with no tool_result needed.
    // Treating this the same as end_turn (i.e. NOT looping) is exactly what
    // silently truncated replies mid-batch: whatever narration text existed
    // so far got sent as if it were the finished answer.
    if (response.stop_reason === "pause_turn") {
      turnMessages = [...turnMessages, { role: "assistant", content: response.content }];
      rollingCacheIdx = moveRollingMarker(turnMessages, rollingCacheIdx, withCacheMarker, withoutCacheMarker);
      requestBody.messages = turnMessages;
      toolRoundTrips++;
      continue;
    }

    if (response.stop_reason !== "tool_use") break;

    const toolUseBlocks = response.content.filter(
      (block) => block.type === "tool_use" && MEMORY_TOOL_NAMES.has(block.name)
    );
    if (toolUseBlocks.length === 0) {
      const unhandledNames = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => block.name);
      if (unhandledNames.length > 0) {
        console.warn(`Unhandled tool_use block(s) reached askClaude's loop: ${unhandledNames.join(", ")} - stopping this turn.`);
      }
      break; // nothing here for us to execute - avoid looping forever
    }

    turnMessages = [...turnMessages, { role: "assistant", content: response.content }];
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (block) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: await executeMemoryTool(block, caller, channel),
      }))
    );
    turnMessages.push({ role: "user", content: toolResults });
    rollingCacheIdx = moveRollingMarker(turnMessages, rollingCacheIdx, withCacheMarker, withoutCacheMarker);
    requestBody.messages = turnMessages;
    toolRoundTrips++;
  }

  console.log(
    `[usage] ${conversationKey} turn: ${toolRoundTrips} tool round-trip(s), ` +
      `input=${usage.input} cache_write=${usage.cacheWrite} cache_read=${usage.cacheRead} output=${usage.output}`
  );

  let replyText = textParts.join("\n\n").trim();

  // The loop above can end without Claude actually being done: it ran out
  // of MAX_TOOL_ITERATIONS mid pause_turn/tool_use, or hit an unhandled
  // tool_use block it gave up on. Either way, whatever text exists so far
  // is a mid-thought fragment, not a finished answer - don't silently send
  // it as if it were one (this is what caused replies to trail off mid
  // narration on big batch requests), and never let an empty replyText
  // reach sendWhatsAppMessage (it rejects an empty text.body outright).
  if (response.stop_reason === "tool_use" || response.stop_reason === "pause_turn") {
    console.warn(
      `Reply to ${conversationKey} ended incomplete (stop_reason: ${response.stop_reason}, ${toolRoundTrips} round-trip(s)).`
    );
    replyText = replyText
      ? `${replyText}\n\n_(Got interrupted partway through a bigger lookup — say "continue" if you want the rest.)_`
      : "That took more back-and-forth with the CRM than expected and I didn't land on an answer — try asking again, maybe narrowed down a bit.";
  }

  // Graceful degradation on truncation, same pattern as the digest engine:
  // send whatever real content exists (clearly marked as cut off), or a
  // plain "hit a limit" message if there's nothing usable yet.
  if (response.stop_reason === "max_tokens") {
    console.warn(`Reply to ${conversationKey} hit the max_tokens cap (stop_reason: max_tokens).`);

    if (replyText) {
      replyText += "\n\n_(Cut off — hit a response length limit. Ask me to continue if you need the rest.)_";
    } else {
      replyText = "I hit a response length limit before I could finish answering that — try asking again, " +
        "maybe in a more specific way, or ping Aj if this keeps happening.";
    }
  }

  // Last-resort guard, independent of stop_reason: the two blocks above only
  // catch the specific cases they know about (tool_use/pause_turn/
  // max_tokens) - a normal end_turn completion can still produce empty text
  // (e.g. the model's last action was a tool call and it simply had nothing
  // further to say), and WhatsApp rejects an empty text.body with a flat
  // 400. Never let that reach sendWhatsAppMessage, whatever the cause.
  if (!replyText) {
    console.warn(`Reply to ${conversationKey} was empty (stop_reason: ${response.stop_reason}) - substituting a fallback instead of sending nothing.`);
    replyText = "I didn't get a usable answer together for that — try asking again, maybe worded a little differently.";
  }

  history.push({ role: "assistant", content: replyText });

  // Trim oldest turns if history gets long
  if (history.length > MAX_TURNS_KEPT * 2) {
    history.splice(0, history.length - MAX_TURNS_KEPT * 2);
  }

  return replyText;
}

/**
 * Transport-agnostic entry point for live chat. Every channel adapter
 * (WhatsApp's webhook handler in server.js, slack.js) normalizes its own
 * incoming payload into this shape and calls this instead of touching
 * askClaude/Claude/MCP logic directly, so channel-specific code stays a
 * thin transport layer with zero duplication of the actual assistant logic.
 * @param {object} message
 * @param {string} message.userId - unique per-channel sender identifier (phone number, Slack user ID) - used as the conversation history key
 * @param {{name: string, role: string}|null|undefined} message.identity - resolved identity for this sender, or null/undefined if unregistered
 * @param {string} message.text - the incoming message text
 * @param {'whatsapp'|'slack'} message.channel - which channel this came in on (not currently used to vary behavior, but kept in the shape for when it needs to)
 * @returns {Promise<string>} reply text
 */
export async function handleIncomingMessage({ userId, identity, text, channel }) {
  return askClaude(userId, text, identity, channel);
}
