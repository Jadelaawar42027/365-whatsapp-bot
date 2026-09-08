// Relays the morning digest to a GHL workflow via webhook, which is expected to route it to
// the right broker (by name or phone, whichever the workflow's If/Else branches key off) and
// send it as SMS - see server.js's runMorningDigestSequence. This runs ALONGSIDE the existing
// WhatsApp digest send, not instead of it - a same-content backup, since WhatsApp's
// per-recipient MARKETING-template engagement throttle has caused real delivery failures for
// most of the team (see the "starter"/daily_activation_personalized template history), and
// SMS has no equivalent restriction.
import axios from "axios";
import { getIdentityForPhone } from "./brokerRoster.js";

// These two never receive SMS at all, full stop - every caller of this function goes through
// this one guard, so the rule can't be missed at some future call site. Checked against the
// PHONE's actual current roster owner, not the "brokerName" content-label argument - the
// digest-test path deliberately routes a broker's digest content to Aj's own phone for
// verification (see server.js's runMorningDigestTestSequence), so brokerName alone would miss
// that case; resolving the real recipient from the phone catches it correctly.
const NEVER_SMS_NAMES = new Set(["Aj El Aawar", "Karim El Timani"]);

/**
 * POSTs the digest to the configured GHL inbound webhook. No-op (logs a warning, doesn't
 * throw) if GHL_DIGEST_SMS_WEBHOOK_URL isn't set yet, so this can be wired in before the GHL
 * side is finished being built without breaking the existing WhatsApp digest send. Also a
 * no-op if the destination phone belongs to someone on NEVER_SMS_NAMES.
 * @param {string} brokerName
 * @param {string} phone - digits-only, no "+", same format as BROKER_ROSTER's keys
 * @param {string} digestText
 */
export async function postDigestToGhlWebhook(brokerName, phone, digestText) {
  const recipient = getIdentityForPhone(phone);
  const recipientName = recipient ? recipient.name : brokerName;
  if (NEVER_SMS_NAMES.has(recipientName)) {
    console.log(`SMS relay: skipping - ${recipientName}'s phone is excluded from SMS entirely.`);
    return;
  }

  const url = process.env.GHL_DIGEST_SMS_WEBHOOK_URL;
  if (!url) {
    console.warn("GHL_DIGEST_SMS_WEBHOOK_URL not set - skipping SMS digest relay for", brokerName);
    return;
  }
  try {
    await axios.post(url, { brokerName, phone, digestText });
    console.log(`Digest relayed to GHL webhook for SMS (${brokerName}).`);
  } catch (err) {
    console.error(`Failed to relay digest to GHL webhook for ${brokerName}:`, err.response?.data || err.message);
  }
}
