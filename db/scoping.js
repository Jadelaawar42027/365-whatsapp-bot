// Hard requirement (mirrors the GHL MCP server's server-side broker scoping,
// NOT left to the model's judgment): every data-access function takes the
// CALLER's { role, brokerId } - resolved by claude.js from the sender's
// identity/session, never from tool-call arguments or message text - and
// every query here is built from it, not trusted input.
//
// broker_id in this schema is the sender's WhatsApp roster phone number
// (brokerRoster.js's own primary key) - there's no separate numeric broker
// ID anywhere else in this codebase, so reusing the phone number keeps one
// consistent identity across the whole system instead of inventing a second.

/**
 * @typedef {{role: 'broker'|'setter'|'leadership', brokerId: string}} Caller
 */

/**
 * @param {Caller} caller
 */
export function assertCaller(caller) {
  if (!caller || !caller.role || !caller.brokerId) {
    throw new Error("Data-access call missing caller { role, brokerId } - never optional.");
  }
  if (!["broker", "setter", "leadership"].includes(caller.role)) {
    throw new Error(`Unknown caller role: ${caller.role}`);
  }
}

/**
 * Read-side enforcement: a 'broker' only ever sees their own rows. 'setter'
 * and 'leadership' both get broad read access (setter mirrors leadership
 * for reads per brokerRoster.js's documented role semantics - only writes
 * are broker-scoped for setters).
 * @param {Caller} caller
 * @returns {string|null} 'broker_id' value to filter on, or null for no filter
 */
export function readBrokerFilter(caller) {
  assertCaller(caller);
  return caller.role === "broker" ? caller.brokerId : null;
}

/**
 * Write-side enforcement: 'broker' and 'setter' can only ever write rows
 * under their OWN broker_id, regardless of what a tool call/AI output
 * suggests - this function is the only place that value comes from for
 * those two roles. 'leadership' isn't tied to one book of business, so a
 * leadership-initiated write must name which broker's contact this concerns
 * explicitly (requestedBrokerId) - there's nothing to force it to.
 * @param {Caller} caller
 * @param {string|undefined} requestedBrokerId - only consulted for leadership
 */
export function resolveWriteBrokerId(caller, requestedBrokerId) {
  assertCaller(caller);
  if (caller.role === "broker" || caller.role === "setter") return caller.brokerId;
  if (!requestedBrokerId) {
    throw new Error("Leadership-initiated writes must specify which broker's contact this concerns.");
  }
  return requestedBrokerId;
}
