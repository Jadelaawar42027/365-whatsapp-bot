// Style rules for AI-drafted follow-up texts. Enforced in code (findStyleViolations) as well as
// described to the model, so a draft that breaks a rule is rejected before it can be shown to a
// broker, let alone sent.

export const SMS_MAX_CHARS = 320;

const BANNED_PATTERNS = [
  { re: /[—–]/, reason: "contains an em dash or en dash - use a comma, period, or new sentence instead" },
  { re: /\bas an ai\b|\blanguage model\b|\bi'?m an ai\b|\bi am an ai\b|\bai assistant\b|\bchatbot\b/i, reason: "sounds like an AI wrote it" },
  { re: /\bi hope (this|that|you)\b.*\b(finds?|are|is|doing)\b|\bhope you'?re doing well\b|\bhope this (message|text|finds)\b/i, reason: "generic filler opener" },
  { re: /\b(dear|sincerely|best regards|kind regards|warm regards|yours truly)\b/i, reason: "formal letter sign-off or greeting" },
  { re: /^\s*[-*•]\s|\n\s*[-*•]\s|\n\s*\d+[.)]\s/m, reason: "bullet or numbered list - write it as a plain text message" },
  { re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, reason: "contains emoji" },
];

export function findStyleViolations(text) {
  const violations = [];
  if (!text || !text.trim()) violations.push("draft is empty");
  if (text && text.length > SMS_MAX_CHARS) {
    violations.push(`${text.length} characters - keep it under ${SMS_MAX_CHARS}`);
  }
  for (const { re, reason } of BANNED_PATTERNS) {
    if (text && re.test(text)) violations.push(reason);
  }
  return violations;
}

// Sending window in the lead's market. US leads only for now, so America/New_York, and the
// window is intentionally conservative (8am-8pm) since we don't store each lead's timezone.
const SEND_TZ = "America/New_York";
const SEND_START_HOUR = 8;
const SEND_END_HOUR = 20;

export function isWithinSendWindow(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: SEND_TZ, hour: "numeric", hourCycle: "h23" }).format(now));
  return hour >= SEND_START_HOUR && hour < SEND_END_HOUR;
}

// Condensed from the jm-sales (Jeremy Miner NEPQ) skill, kept short on purpose - it's injected
// into every drafting request. The full skill and its objection/industry references stay on
// the Claude Code side.
export const SMS_DRAFTING_GUIDE = `WRITING FOLLOW-UP TEXTS (read carefully - these are the rules, enforced automatically):
- Write like a real person texting: short, plain, warm, specific to this lead. One idea per text. Usually 1-3 sentences.
- NEVER use em dashes (—) or en dashes (–). Use commas, periods, or a new sentence instead.
- NEVER sound like an AI: no "as an AI", no "I hope this message finds you well", no formal sign-offs ("Best regards", "Sincerely"), no bullet or numbered lists, no emojis.
- Do not pitch or push. Ask one open question that makes the lead think about their own situation (NEPQ style): what they're trying to accomplish, what's holding them back, what would need to be true. Let them persuade themselves; never create pressure or urgency you don't actually have.
- Reference something real from the timeline (their stated timing, budget, boat type, a vacation or travel note, the last thing they said). Never invent facts, dates, prices, or availability.
- Respect stated timing. If they said they're away or will be back on a date, the text should land after that date, not before.
- Each option should take a different angle (e.g. re-engage on their timeline, ask about their goal, offer one concrete next step). Keep the sender's name out unless the lead already knows them.`;
