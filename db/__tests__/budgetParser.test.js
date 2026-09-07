import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseBudgetToNumber } from "../../budgetParser.js";

describe("parseBudgetToNumber", () => {
  test("plain dollar amount with commas and $ sign", () => {
    assert.equal(parseBudgetToNumber("$350,000"), 350000);
    assert.equal(parseBudgetToNumber("client said 350,000"), 350000);
  });

  test("bare number, no formatting", () => {
    assert.equal(parseBudgetToNumber("350000"), 350000);
  });

  test("k shorthand", () => {
    assert.equal(parseBudgetToNumber("350k"), 350000);
    assert.equal(parseBudgetToNumber("$350K"), 350000);
    assert.equal(parseBudgetToNumber("budget is around 350k"), 350000);
  });

  test("m/mm/million shorthand", () => {
    assert.equal(parseBudgetToNumber("1.2m"), 1200000);
    assert.equal(parseBudgetToNumber("$1.2M"), 1200000);
    assert.equal(parseBudgetToNumber("1.2 million"), 1200000);
    assert.equal(parseBudgetToNumber("2mm"), 2000000);
  });

  test("thousand written out", () => {
    assert.equal(parseBudgetToNumber("300 thousand"), 300000);
  });

  test("range with suffix on both sides", () => {
    assert.equal(parseBudgetToNumber("$300k-$400k"), 350000);
    assert.equal(parseBudgetToNumber("300k to 400k"), 350000);
  });

  test("range with shared trailing suffix only (the dangerous shorthand)", () => {
    // "300-400k" means $300k-$400k, NOT $300-$400,000 - the whole reason this
    // isn't just "extract every number independently and average them."
    assert.equal(parseBudgetToNumber("300-400k"), 350000);
    assert.equal(parseBudgetToNumber("budget is 300-400k"), 350000);
  });

  test("range with leading suffix only", () => {
    assert.equal(parseBudgetToNumber("300k-400"), 350000);
  });

  test("range with no suffix at all, plain numbers", () => {
    assert.equal(parseBudgetToNumber("between 300,000 and 400,000"), 350000);
    assert.equal(parseBudgetToNumber("300000-400000"), 350000);
  });

  test("range using en-dash/em-dash", () => {
    assert.equal(parseBudgetToNumber("300k–400k"), 350000);
    assert.equal(parseBudgetToNumber("300k—400k"), 350000);
  });

  test("no budget mentioned at all", () => {
    assert.equal(parseBudgetToNumber(null), null);
    assert.equal(parseBudgetToNumber(undefined), null);
    assert.equal(parseBudgetToNumber(""), null);
    assert.equal(parseBudgetToNumber("not mentioned"), null);
  });

  test("ambiguous text with unrelated numbers - refuses to guess", () => {
    // e.g. a date and a phone number in the same sentence, no clear single
    // budget figure or two-sided range - must NOT silently average unrelated numbers.
    assert.equal(parseBudgetToNumber("called on 9/5 at 555-1234, no budget given"), null);
  });

  test("real transcript-style phrasing", () => {
    assert.equal(parseBudgetToNumber("we're looking to spend around $300k-$400k on this"), 350000);
    assert.equal(parseBudgetToNumber("client mentioned a budget of about $500,000"), 500000);
  });

  test("spoken article form - 'a million'/'a thousand' with no numeral", () => {
    // Surfaced by a real production sweep run: "A million dollars" (Roberto Montag, via
    // Charlie Seitz's leads) went unparsed before this normalization existed.
    assert.equal(parseBudgetToNumber("A million dollars"), 1000000);
    assert.equal(parseBudgetToNumber("a thousand"), 1000);
    assert.equal(parseBudgetToNumber("budget is around a million"), 1000000);
  });

  test("parenthetical suffix - 'X (thousand)'", () => {
    // Real production bug: the "(" broke the suffix regex's \b boundary right after the
    // digits, so "thousand" never matched at all and this silently wrote 700 instead of
    // 700000 to a live GHL opportunity before this fix existed.
    assert.equal(parseBudgetToNumber("700 (thousand)"), 700000);
    assert.equal(parseBudgetToNumber("budget is 250 (thousand) or so"), 250000);
  });

  test("implausibly small result - refuses rather than write a nonsensical value", () => {
    // All three are real production writes this bug caused, each wrong by 1000x+ or outright
    // meaningless - nobody buys a yacht for $1, $4, or $360. A dropped unit ("1.2" meant "$1.2
    // million" but the extracted text lost the word), a garbled transcript fragment (not a
    // budget at all), and a range where the client meant thousands but said bare numbers -
    // all three must now come back null instead of a technically-valid but absurd number.
    assert.equal(parseBudgetToNumber("1.2"), null);
    assert.equal(parseBudgetToNumber(`"I'm not sure if that's in my budget. I had over $3.87. That would work."`), null);
    assert.equal(
      parseBudgetToNumber("$350 to $370 range (for mainship/vessels with good resale); around $250 (for Meridian/Carver type vessels)"),
      null
    );
  });

  test("plausible small-but-real budget still passes the floor", () => {
    // A genuinely cheap boat/trailer purchase - must not get caught by the implausibility
    // floor just because it's a smaller number than most yacht budgets.
    assert.equal(parseBudgetToNumber("16,900 + TTL"), 16900);
  });
});
