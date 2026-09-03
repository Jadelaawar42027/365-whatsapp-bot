import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readBrokerFilter, resolveWriteBrokerId, assertCaller } from "../scoping.js";
import { getContactMemory, upsertContactMemory } from "../contactsMemory.js";

// Hard requirement (see db/scoping.js): a 'broker' caller must never be able
// to read or write another broker's rows, regardless of what contact_id/
// broker_id a tool call or the AI supplies. These unit tests cover the pure
// scoping logic with no DB required, so they always run; the integration
// block below additionally proves it end-to-end against a real Postgres
// instance when one is configured.

describe("scoping (unit, no DB required)", () => {
  test("assertCaller rejects a missing/incomplete caller", () => {
    assert.throws(() => assertCaller(null));
    assert.throws(() => assertCaller({ role: "broker" }));
    assert.throws(() => assertCaller({ brokerId: "123" }));
    assert.throws(() => assertCaller({ role: "manager", brokerId: "123" }));
  });

  test("readBrokerFilter scopes 'broker' but not 'setter'/'leadership'", () => {
    assert.equal(readBrokerFilter({ role: "broker", brokerId: "111" }), "111");
    assert.equal(readBrokerFilter({ role: "setter", brokerId: "222" }), null);
    assert.equal(readBrokerFilter({ role: "leadership", brokerId: "333" }), null);
  });

  test("resolveWriteBrokerId forces broker/setter to their OWN id, ignoring any requested override", () => {
    const spoofedTarget = "someone-elses-broker-id";
    assert.equal(resolveWriteBrokerId({ role: "broker", brokerId: "111" }, spoofedTarget), "111");
    assert.equal(resolveWriteBrokerId({ role: "setter", brokerId: "222" }, spoofedTarget), "222");
  });

  test("resolveWriteBrokerId requires an explicit target for leadership", () => {
    assert.throws(() => resolveWriteBrokerId({ role: "leadership", brokerId: "999" }, undefined));
    assert.equal(resolveWriteBrokerId({ role: "leadership", brokerId: "999" }, "any-broker"), "any-broker");
  });
});

// Integration check against a real database - the literal check section 3a
// asked for: call a data-access function AS a broker, requesting a
// contact_id belonging to a DIFFERENT broker, and assert it returns nothing.
// Skips (doesn't fail) when no test database is configured, since this repo
// has no CI database provisioned yet.
const hasTestDb = Boolean(process.env.TEST_DATABASE_URL || process.env.AIBOT_DATABASE_URL);

describe("contactsMemory cross-broker isolation (integration)", { skip: !hasTestDb && "set TEST_DATABASE_URL to run this against a real database" }, () => {
  test("a broker can never read or claim a contact seeded under a different broker", async () => {
    const contactId = `test-contact-${Date.now()}`;
    const owner = { role: "broker", brokerId: "owner-broker-id" };
    const intruder = { role: "broker", brokerId: "intruder-broker-id" };

    await upsertContactMemory(owner, contactId, undefined, { lastAiSummary: "owned by owner-broker-id" });

    const asIntruder = await getContactMemory(intruder, contactId);
    assert.equal(asIntruder, null, "a broker must not see another broker's contact row");

    const hijackAttempt = await upsertContactMemory(intruder, contactId, undefined, { lastAiSummary: "hijacked" });
    assert.equal(hijackAttempt, null, "a broker must not be able to overwrite another broker's contact row");

    const asOwner = await getContactMemory(owner, contactId);
    assert.equal(asOwner.last_ai_summary, "owned by owner-broker-id", "the original owner's data must be unchanged");
  });
});
