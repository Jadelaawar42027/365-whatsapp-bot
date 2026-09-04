// Leadership-only summary, compiled from flags ALREADY collected while
// generating each broker's individual morning digest (see digest.js's
// LEADERSHIP FLAGS instructions and reportEngine.js's runInternalReportWithFlags).
//
// This is deliberately NOT a fresh scan - no Claude call, no GHL tool calls,
// pure formatting of data that was already extracted during today's digest
// run. That's the whole point: leadership visibility without re-researching
// every lead a second time.

/**
 * Formats the accumulated near-close/alert flags from today's digest run
 * into one leadership-facing WhatsApp message. Sent AFTER each person's own
 * personal digest (which already surfaces their hot leads first) - see
 * server.js's runMorningDigestSequence - so this always lands after hot
 * leads have already been mentioned, never before.
 * @param {Array<{type: 'near_close'|'alert', leadName: string, reason: string, brokerName: string}>} flaggedItems
 * @param {string} greetingName - the leadership person's name, for the opening line
 * @param {Array<{contactName: string|null, contactId: string, brokerName: string, daysAgo: number}>} [staleFollowups] -
 *   from db/followupEvents.js's getStaleMissedFollowups - missed follow-ups still unresolved 7+ days after being flagged
 * @returns {string}
 */
export function formatCollectedAlerts(flaggedItems, greetingName, staleFollowups = []) {
  const nearClose = flaggedItems.filter((f) => f.type === "near_close");
  const alerts = flaggedItems.filter((f) => f.type === "alert");

  const lines = [];
  lines.push(`Hey ${greetingName}, here's today's team summary 👇`);
  lines.push("");

  if (nearClose.length === 0 && alerts.length === 0 && staleFollowups.length === 0) {
    lines.push("Nothing flagged today — no near-close deals and no alerts across the team.");
    return lines.join("\n");
  }

  if (nearClose.length > 0) {
    lines.push("🎯 *Near close (next 2-4 weeks)*");
    for (const item of nearClose) {
      lines.push(`- ${item.leadName} (${item.brokerName}): ${item.reason}`);
    }
    lines.push("");
  }

  if (alerts.length > 0) {
    lines.push("🚨 *Alerts - reach out to the broker ASAP*");
    for (const item of alerts) {
      lines.push(`- ${item.leadName} (${item.brokerName}): ${item.reason}`);
    }
    lines.push("");
  }

  if (staleFollowups.length > 0) {
    lines.push("❗❗❗ *Missed follow-ups - flagged 7+ days ago, still unresolved*");
    for (const item of staleFollowups) {
      lines.push(`- ${item.contactName || item.contactId} (${item.brokerName}): flagged ${item.daysAgo} days ago`);
    }
  }

  return lines.join("\n").trim();
}
