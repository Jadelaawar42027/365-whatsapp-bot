// Shared engine for one-shot internal reports (morning digest, EOD
// check-in, and future scheduled reports). This is the same tested
// marker-extraction and truncation-handling logic - only the instructions
// text differs between report types, so that's the only thing callers pass.

import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "./knowledgeBase.js";
import { mintIdentityToken } from "./identity.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const REPORT_MARKER = "===REPORT===";
export const END_MARKER = "===END===";
export const FLAGS_MARKER = "===FLAGS===";
export const END_FLAGS_MARKER = "===END_FLAGS===";
export const COVERAGE_MARKER = "===COVERAGE===";
export const END_COVERAGE_MARKER = "===END_COVERAGE===";

/**
 * Shared formatting/marker rules every report type must follow, appended
 * ahead of the report-specific instructions. Keeping this in one place
 * means the marker contract can't drift between report types.
 */
export const REPORT_FORMAT_RULES = `CRITICAL - this is a finished message being delivered directly to them on WhatsApp, not a live chat
turn. Never narrate what you're doing ("let me check...", "now let me pull...", "good overview, moving
on to...", "good, I now have everything I need..."). Don't describe your research process, and don't
write any transition/wrap-up sentence before the report either - go straight from tool use into the
report itself with nothing in between. Write directly TO the person, second person ("you", "your
leads"), like you're texting them - never refer to them by name in the third person as if describing
them to someone else (wrong: "Charlie's leads show..." - right: "Hey Charlie! Quick check-in...").

MANDATORY FORMAT: once you're done using tools and are ready to write the report, output the exact
marker "===REPORT===" on its own line, then immediately begin the report right after it on the next
line - nothing else between the marker and the report, and nothing after the report ends. Everything
before "===REPORT===" is discarded automatically, so tool use and any unavoidable intermediate text is
fine before the marker - but the report itself must start IMMEDIATELY at the marker with zero lead-in
sentence, not even one word of transition. When the report is completely finished, output the exact
marker "===END===" on its own line right after it, with NOTHING after that - no closing remark, no
"let me know if you need anything," nothing. Both markers are required, always, every time.

LEAD PRIORITY SYSTEM - from get_broker_leads_overview's "priority" and "hot" fields:
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

PER-LEAD FORMAT (use this exact pattern whenever naming a specific lead):
"[Lead Name] [🔥 if hot][priority emoji] [priority label]: [what's going on + the one recommended
action]"
Example: "Barry Lee 🔥 🔴 Buy Now: asked to schedule a viewing this week and hasn't heard back — call
him today to lock in a time."`;

/**
 * Runs a one-shot Claude call with full tool access under the given
 * identity, for internal report generation rather than a live chat reply.
 *
 * Prompt caching: the base system prompt AND the report instructions are
 * identical across every person in a report run (only name/role differ) -
 * so both go in one cached block, with just the tiny per-person line left
 * uncached. Since trigger endpoints loop through everyone ~1s apart, this
 * means only the FIRST person's report pays full price; the rest hit cache
 * on this entire block.
 *
 * @param {{name: string, role: string}} identity
 * @param {string} instructions - report-specific instructions (does NOT
 *   need to repeat the marker/priority rules - REPORT_FORMAT_RULES already
 *   covers those)
 * @param {string} reportLabel - used only in log messages, e.g. "morning digest"
 */
/**
 * Core Claude call shared by both report modes below. Not exported -
 * callers use runInternalReport or runInternalReportWithFlags.
 */
async function callForReport(identity, instructions, maxTokens = 4000, tokenTtlMinutes = 5) {
  const baseSystemPrompt = await getSystemPrompt();
  const staticBlock = `${baseSystemPrompt}\n\n---\n\n${REPORT_FORMAT_RULES}\n\n${instructions}`;

  // CRITICAL: same fix as claude.js - Claude has no built-in awareness of
  // the current date/time, so every "due today", "overdue", "how long ago"
  // judgment in a report needs this injected explicitly. Uncached, since it
  // changes on every call (and every day).
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

  const userContext = `${dateContext}\n\nCURRENT USER: ${identity.name}, role: ${identity.role}.`;

  return anthropic.messages.create(
    {
      model: "claude-sonnet-4-6",
      // A controlled budget, not an unbounded ceiling - if a run genuinely
      // needs more (e.g. several leads needing a full conversation read
      // for the "no next action" recommendations), the fallback below
      // kicks in instead of the response just going missing. Callers
      // covering more ground in one turn (e.g. the leadership performance
      // review, which loops every broker) pass a higher maxTokens.
      max_tokens: maxTokens,
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
          // The GHL MCP server runs stateless, re-verifying this SAME token
          // on every individual tool call within the turn (not once per
          // turn) - a report covering more ground (higher maxTokens, more
          // tool calls, real network latency) can outlast the default
          // 5-minute expiry, so callers with a bigger maxTokens should pass
          // a matching tokenTtlMinutes or later tool calls get silently
          // rejected with "invalid or expired token" mid-report.
          authorization_token: mintIdentityToken(identity, tokenTtlMinutes),
        },
      ],
    },
    { headers: { "anthropic-beta": "mcp-client-2025-04-04" } }
  );
}

function extractBetweenMarkers(allText, startMarker, endMarker) {
  const startIndex = allText.lastIndexOf(startMarker);
  if (startIndex === -1) return null;
  const afterStart = allText.slice(startIndex + startMarker.length);
  const endIndex = afterStart.indexOf(endMarker);
  return (endIndex !== -1 ? afterStart.slice(0, endIndex) : afterStart).trim();
}

function applyTruncationFallback(finalText, response, identity, reportLabel) {
  if (response.stop_reason !== "max_tokens") return finalText;

  console.warn(`${reportLabel} for ${identity.name} hit the max_tokens cap (stop_reason: max_tokens).`);
  if (finalText) {
    return finalText + "\n\n_(Cut off — hit a response length limit before finishing. Ask me to continue for the rest.)_";
  }
  return `I started pulling this together but hit a response length limit before I could finish. ` +
    `Try asking me again, or ping Aj if this keeps happening.`;
}

/**
 * Runs a one-shot Claude call with full tool access under the given
 * identity, for internal report generation rather than a live chat reply.
 * Returns just the report text - unchanged behavior for existing callers
 * (digest, EOD check-in, call review, no-show follow-up).
 *
 * Prompt caching: the base system prompt AND the report instructions are
 * identical across every person in a report run (only name/role differ) -
 * so both go in one cached block, with just the tiny per-person line left
 * uncached. Since trigger endpoints loop through everyone ~1s apart, this
 * means only the FIRST person's report pays full price; the rest hit cache
 * on this entire block.
 *
 * @param {{name: string, role: string}} identity
 * @param {string} instructions - report-specific instructions (does NOT
 *   need to repeat the marker/priority rules - REPORT_FORMAT_RULES already
 *   covers those)
 * @param {string} reportLabel - used only in log messages, e.g. "morning digest"
 * @param {number} [maxTokens] - output token budget for this report's completion call, defaults to 4000
 * @param {number} [tokenTtlMinutes] - identity token lifetime in minutes, defaults to 5 - raise alongside maxTokens for reports that can run long
 */
export async function runInternalReport(identity, instructions, reportLabel = "report", maxTokens = 4000, tokenTtlMinutes = 5) {
  const response = await callForReport(identity, instructions, maxTokens, tokenTtlMinutes);

  const allText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  let finalText = extractBetweenMarkers(allText, REPORT_MARKER, END_MARKER);
  if (finalText === null) {
    console.warn(`${reportLabel} for ${identity.name} did not include the ${REPORT_MARKER} marker - falling back to last text block.`);
    const textBlocks = response.content.filter((block) => block.type === "text");
    finalText = (textBlocks[textBlocks.length - 1]?.text || "").trim();
  }

  return applyTruncationFallback(finalText, response, identity, reportLabel);
}

/**
 * Same as runInternalReport, but ALSO extracts a structured "flags" JSON
 * block from the same response - used when a report needs to surface
 * cross-referenceable data (e.g. near-close deals, alerts) WITHOUT a
 * second, separate scan later. The instructions passed in must tell the
 * model to output a JSON array between FLAGS_MARKER and END_FLAGS_MARKER,
 * in addition to the normal REPORT_MARKER/END_MARKER report text.
 *
 * Returns { text, flags } - flags is always an array, empty if none were
 * found or if parsing failed (fails safe: a formatting hiccup here should
 * never break the actual report text, which is the primary deliverable).
 */
export async function runInternalReportWithFlags(identity, instructions, reportLabel = "report") {
  const response = await callForReport(identity, instructions);

  const allText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  let finalText = extractBetweenMarkers(allText, REPORT_MARKER, END_MARKER);
  if (finalText === null) {
    console.warn(`${reportLabel} for ${identity.name} did not include the ${REPORT_MARKER} marker - falling back to last text block.`);
    const textBlocks = response.content.filter((block) => block.type === "text");
    finalText = (textBlocks[textBlocks.length - 1]?.text || "").trim();
  }
  finalText = applyTruncationFallback(finalText, response, identity, reportLabel);

  let flags = [];
  const flagsRaw = extractBetweenMarkers(allText, FLAGS_MARKER, END_FLAGS_MARKER);
  if (flagsRaw) {
    try {
      const parsed = JSON.parse(flagsRaw);
      if (Array.isArray(parsed)) flags = parsed;
    } catch (err) {
      console.warn(`${reportLabel} for ${identity.name}: flags block wasn't valid JSON, treating as empty. Raw: ${flagsRaw.slice(0, 200)}`);
    }
  }

  return { text: finalText, flags };
}

/**
 * Same as runInternalReport, but ALSO extracts and logs a "coverage" JSON
 * block - a diagnostic, not part of the returned text. This is a
 * SELF-REPORTED number from the model (for each broker: how many Buy
 * Now/Active leads they have vs. how many the model actually pulled
 * cadence/task/note data for before writing that broker's section), not an
 * independently-verified one - it's meant to be compared against the
 * separate, code-level "fetched N contact(s) for owner X" log line the GHL
 * MCP server writes at the actual fetch point (ghl-client.js's
 * getBrokerLeadsOverview). A mismatch between the two - GHL says fetched
 * more leads than the model says it checked - is the actual accuracy signal,
 * instead of guessing from a broker complaining leads went missing.
 *
 * The instructions passed in must tell the model to output a JSON array
 * between COVERAGE_MARKER and END_COVERAGE_MARKER, in addition to the
 * normal REPORT_MARKER/END_MARKER report text. Fails safe: a missing or
 * malformed coverage block only logs a warning, never affects the report
 * text itself, which is the primary deliverable.
 *
 * @param {{name: string, role: string}} identity
 * @param {string} instructions
 * @param {string} reportLabel - used only in log messages
 * @param {number} [maxTokens] - output token budget for this report's completion call, defaults to 4000
 * @param {number} [tokenTtlMinutes] - identity token lifetime in minutes, defaults to 5 - raise alongside maxTokens for reports that can run long
 */
export async function runInternalReportWithCoverage(identity, instructions, reportLabel = "report", maxTokens = 4000, tokenTtlMinutes = 5) {
  const response = await callForReport(identity, instructions, maxTokens, tokenTtlMinutes);

  const allText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  let finalText = extractBetweenMarkers(allText, REPORT_MARKER, END_MARKER);
  if (finalText === null) {
    console.warn(`${reportLabel} for ${identity.name} did not include the ${REPORT_MARKER} marker - falling back to last text block.`);
    const textBlocks = response.content.filter((block) => block.type === "text");
    finalText = (textBlocks[textBlocks.length - 1]?.text || "").trim();
  }
  finalText = applyTruncationFallback(finalText, response, identity, reportLabel);

  const coverageRaw = extractBetweenMarkers(allText, COVERAGE_MARKER, END_COVERAGE_MARKER);
  if (coverageRaw) {
    try {
      const coverage = JSON.parse(coverageRaw);
      console.log(`${reportLabel} for ${identity.name} - coverage (self-reported; compare against the GHL MCP server's fetched-count logs):`, JSON.stringify(coverage));
    } catch (err) {
      console.warn(`${reportLabel} for ${identity.name}: coverage block wasn't valid JSON, skipping. Raw: ${coverageRaw.slice(0, 200)}`);
    }
  } else {
    console.warn(`${reportLabel} for ${identity.name} did not include a coverage block.`);
  }

  return finalText;
}
