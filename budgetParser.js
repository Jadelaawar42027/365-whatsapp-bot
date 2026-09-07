// Parses a budget mention (raw text extracted by Claude from a call transcript/notes -
// see callReview.js's ===BUDGET=== marker) into a clean number for GHL's opportunity
// monetaryValue field. Deliberately pure, deterministic JS - no LLM involved - since this
// writes directly to a live CRM field with no human review after it (see server.js's
// /trigger/call-review handler). Returns null (never guesses) whenever the text doesn't
// clearly resolve to exactly one number or one two-sided range.

const SUFFIX_MULTIPLIERS = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
};

// Main digit run is either a properly comma-grouped number ("300,000", "1,234,567") or a
// plain digit run with no commas at all ("300000") - deliberately NOT a loose "[0-9,]*",
// which would happily swallow a stray trailing comma that isn't a real thousands-separator
// (e.g. the "," after "1234" in "...at 555-1234, no budget given") and make an unrelated
// number look formatted like money.
const NUMBER_RE =
  "\\$?\\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?)\\s*(k|mm|m|thousand|million)?\\b";

// A "300k-400k" / "300k to 400k" / "between 300,000 and 400,000" style range where BOTH
// numbers describe one budget window. Deliberately handles the common shorthand where only
// the SECOND number carries the suffix ("300-400k" meaning 300k-400k, not $300-$400,000) -
// treating the two numbers independently would silently average $300 with $400,000 instead
// of $300,000 with $400,000, which is exactly the kind of wrong-by-1000x mistake this
// module exists to prevent.
const RANGE_RE = new RegExp(
  `${NUMBER_RE}\\s*(?:-|to|and|–|—)\\s*${NUMBER_RE}`,
  "i"
);

// A bare range (no $, no k/m/thousand/million suffix anywhere, no thousand-separator commas)
// is indistinguishable from two unrelated small numbers joined by a hyphen elsewhere in the
// text - e.g. a phone number fragment like "555-1234". Real budgets mentioned with zero
// formatting are still large dollar figures, so require both sides to clear this floor before
// trusting a fully bare match; anything with $/suffix/commas already carries its own signal
// and skips this check entirely.
const BARE_RANGE_MIN = 1000;

// Final sanity floor on the RETURNED amount, regardless of which path produced it - a real
// production sweep run surfaced several ways a technically-valid regex match still yields a
// nonsensical result: a suffix silently dropped ("1.2" meant "$1.2 million" but the extracted
// text lost the word "million" -> parses to 1), a garbled/unrelated transcript fragment
// ("I had over $3.87" - not a budget at all -> parses to 4), and someone naming actual dollar
// amounts as an implicit shorthand for thousands ("$350 to $370 range...around $250..." meant
// $350k-$370k, not $350-$370 -> averages to a literal 360). Nobody buys a yacht for under
// $1,000 - a result below this is far more likely a lost unit or a bad extraction than a real
// answer, so refuse it (null) rather than write something this implausible to a live CRM field
// with no human review after it.
const MIN_PLAUSIBLE_BUDGET = 1000;

function toAmount(numStr, suffix) {
  const num = parseFloat(numStr.replace(/,/g, ""));
  if (isNaN(num)) return null;
  const multiplier = suffix ? SUFFIX_MULTIPLIERS[suffix.toLowerCase()] || 1 : 1;
  return num * multiplier;
}

function finalize(amount) {
  if (amount === null) return null;
  const rounded = Math.round(amount);
  return rounded >= MIN_PLAUSIBLE_BUDGET ? rounded : null;
}

/**
 * @param {string|null|undefined} rawText - e.g. "client said $300k-$400k", "around 350 thousand", null
 * @returns {number|null} a clean rounded integer, or null if nothing could be confidently parsed
 */
export function parseBudgetToNumber(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  // Normalize the spoken-article form ("a million", "an thousand" - ungrammatical but cheap
  // to handle anyway) to "1 million" up front, since real transcripts say this far more often
  // than a bare numeral - a live sweep run against production surfaced "A million dollars"
  // going unparsed before this existed. Every downstream check still requires a digit to
  // start the match, so this is the one place that needs to special-case it. Also strip
  // parentheses - "700 (thousand)" is a real extraction the suffix regex otherwise misses
  // entirely (the "(" breaks the \b boundary immediately after the digits), silently falling
  // back to treating "700" as a bare number instead of 700,000.
  const text = rawText
    .trim()
    .replace(/\b(a|an)\s+(thousand|million)\b/gi, "1 $2")
    .replace(/[()]/g, " ");
  if (!text.trim()) return null;

  const rangeMatch = text.match(RANGE_RE);
  if (rangeMatch) {
    const [fullMatch, num1, suffix1, num2, suffix2] = rangeMatch;
    const hasSuffix = Boolean(suffix1 || suffix2);
    const hasDollarOrComma = /[$,]/.test(fullMatch);
    const raw1 = parseFloat(num1.replace(/,/g, ""));
    const raw2 = parseFloat(num2.replace(/,/g, ""));
    const bareRangeRejected =
      !hasSuffix && !hasDollarOrComma && (raw1 < BARE_RANGE_MIN || raw2 < BARE_RANGE_MIN);
    if (!bareRangeRejected) {
      // Inherit the other side's suffix when only one side has one - "300-400k" means
      // 300k-400k, not $300-$400,000.
      const resolvedSuffix1 = suffix1 || suffix2;
      const resolvedSuffix2 = suffix2 || suffix1;
      const amount1 = toAmount(num1, resolvedSuffix1);
      const amount2 = toAmount(num2, resolvedSuffix2);
      if (amount1 === null || amount2 === null) return null;
      return finalize((amount1 + amount2) / 2);
    }
  }

  // No range - must resolve to EXACTLY one number, or it's ambiguous which figure (if any)
  // is actually the budget (e.g. a sentence mentioning both a budget and an unrelated date/
  // phone number) - safer to skip the auto-fill than guess.
  const singleRe = new RegExp(NUMBER_RE, "gi");
  const matches = [...text.matchAll(singleRe)];
  if (matches.length !== 1) return null;

  const [, numStr, suffix] = matches[0];
  const amount = toAmount(numStr, suffix);
  return finalize(amount);
}
