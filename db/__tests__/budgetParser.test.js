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
});
