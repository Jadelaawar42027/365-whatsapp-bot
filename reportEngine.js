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
export async function runInternalReport(identity, instructions, reportLabel = "report") {
  const baseSystemPrompt = await getSystemPrompt();
  const staticBlock = `${baseSystemPrompt}\n\n---\n\n${REPORT_FORMAT_RULES}\n\n${instructions}`;
  const userContext = `CURRENT USER: ${identity.name}, role: ${identity.role}.`;

  const response = await anthropic.messages.create(
    {
      model: "claude-sonnet-4-6",
      // A controlled budget, not an unbounded ceiling - if a run genuinely
      // needs more (e.g. several leads needing a full conversation read
      // for the "no next action" recommendations), the fallback below
      // kicks in instead of the response just going missing.
      max_tokens: 4000,
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

  // Extraction: split on the required start/end markers rather than
  // trusting the model to never write a lead-in or trailing sentence.
  const allText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  const startIndex = allText.lastIndexOf(REPORT_MARKER);
  let finalText;

  if (startIndex !== -1) {
    const afterStart = allText.slice(startIndex + REPORT_MARKER.length);
    const endIndex = afterStart.indexOf(END_MARKER);
    finalText = (endIndex !== -1 ? afterStart.slice(0, endIndex) : afterStart).trim();
  } else {
    console.warn(`${reportLabel} for ${identity.name} did not include the ${REPORT_MARKER} marker - falling back to last text block.`);
    const textBlocks = response.content.filter((block) => block.type === "text");
    finalText = (textBlocks[textBlocks.length - 1]?.text || "").trim();
  }

  // Graceful degradation on truncation: send whatever real content exists
  // (clearly marked as cut off), or a plain "hit a limit" message if
  // there's nothing usable yet.
  if (response.stop_reason === "max_tokens") {
    console.warn(`${reportLabel} for ${identity.name} hit the max_tokens cap (stop_reason: max_tokens).`);

    if (finalText) {
      finalText += "\n\n_(Cut off — hit a response length limit before finishing. Ask me to continue for the rest.)_";
    } else {
      finalText = `I started pulling this together but hit a response length limit before I could finish. ` +
        `Try asking me again, or ping Aj if this keeps happening.`;
    }
  }

  return finalText;
}
