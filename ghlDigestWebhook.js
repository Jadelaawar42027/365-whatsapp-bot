// Relays the morning digest to GHL via webhook(s), which are expected to route it to the right
// broker and send it - see server.js's runMorningDigestSequence. This runs ALONGSIDE the existing
// WhatsApp digest send, not instead of it - a same-content backup, since WhatsApp's per-recipient
// MARKETING-template engagement throttle has caused real delivery failures for most of the team
// (see the "starter"/daily_activation_personalized template history), and neither SMS nor email
// has an equivalent restriction. Two separate webhooks/workflows: one sends SMS (chunked to fit
// the 1600-char limit), the other sends email (full text, single block, no limit) - see
// postDigestToGhlWebhook and postDigestEmail below.
import axios from "axios";
import { getIdentityForPhone } from "./brokerRoster.js";

// These two never receive SMS at all, full stop - every caller of this function goes through
// this one guard, so the rule can't be missed at some future call site. Checked against the
// PHONE's actual current roster owner, not the "brokerName" content-label argument - the
// digest-test path deliberately routes a broker's digest content to Aj's own phone for
// verification (see server.js's runMorningDigestTestSequence), so brokerName alone would miss
// that case; resolving the real recipient from the phone catches it correctly.
const NEVER_SMS_NAMES = new Set(["Aj El Aawar", "Karim El Timani"]);

// GHL/Twilio hard-reject a concatenated SMS body over 1600 characters outright (confirmed in
// production: "The concatenated message body exceeds the 1600 character limit" - the whole
// send fails, not just gets truncated). A digest or team summary with several flagged leads
// routinely runs well past that. Same fix shape as whatsapp.js's splitIntoChunks (paragraph ->
// line -> word -> hard cut boundaries) but NOT sharing that function directly - different
// limit, and this way a change to one send path can't accidentally break the other. Leaves
// headroom below the hard limit, same reasoning as WhatsApp's 3800-of-4096.
const SMS_MAX_CHARS = 1600;
const SMS_CHUNK_SIZE = 1400;

function splitForSms(text) {
  if (text.length <= SMS_MAX_CHARS) return [text];

  const rawChunks = [];
  let remaining = text;
  while (remaining.length > SMS_CHUNK_SIZE) {
    let splitAt = remaining.lastIndexOf("\n\n", SMS_CHUNK_SIZE);
    if (splitAt === -1) splitAt = remaining.lastIndexOf("\n", SMS_CHUNK_SIZE);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(" ", SMS_CHUNK_SIZE);
    if (splitAt === -1) splitAt = SMS_CHUNK_SIZE;

    rawChunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) rawChunks.push(remaining);

  // Prefix each part with "(n/total)" - unlike WhatsApp, where chunks land as obviously
  // sequential bubbles in one thread, multiple SMS just arrive as separate texts with no
  // inherent indication they're one message split up.
  const total = rawChunks.length;
  return rawChunks.map((chunk, i) => `(${i + 1}/${total}) ${chunk}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POSTs the digest to the configured GHL inbound webhook, splitting into multiple SMS-sized
 * parts first if needed (see splitForSms above). No-op (logs a warning, doesn't throw) if
 * GHL_DIGEST_SMS_WEBHOOK_URL isn't set yet, so this can be wired in before the GHL side is
 * finished being built without breaking the existing WhatsApp digest send. Also a no-op if the
 * destination phone belongs to someone on NEVER_SMS_NAMES.
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

  // Pulled from the same roster lookup already done above for the exclusion check - not a new
  // parameter, so every existing call site picks this up automatically. undefined (omitted from
  // the JSON body) for anyone without a real GHL user account on file (see brokerRoster.js) -
  // never send a guessed/fabricated email.
  const email = recipient?.email;

  const parts = splitForSms(digestText);
  for (let i = 0; i < parts.length; i++) {
    try {
      await axios.post(url, { brokerName, phone, email, digestText: parts[i] });
      console.log(`Digest relayed to GHL webhook for SMS (${brokerName})${parts.length > 1 ? ` [part ${i + 1}/${parts.length}]` : ""}.`);
    } catch (err) {
      console.error(`Failed to relay digest to GHL webhook for ${brokerName}${parts.length > 1 ? ` [part ${i + 1}/${parts.length}]` : ""}:`, err.response?.data || err.message);
    }
    // Small gap between parts so they arrive in order, same reasoning as whatsapp.js's
    // between-chunk delay.
    if (i < parts.length - 1) await sleep(500);
  }

  await postDigestEmail(brokerName, email, digestText);
}

/**
 * Separate webhook -> separate GHL workflow that sends the digest as an EMAIL instead of SMS.
 * Independent of the SMS send above: no character limit and never split into parts (email has no
 * equivalent length restriction, and splitting a written digest into "(1/3)"-style fragments would
 * just be worse to read in an inbox). Also independent of NEVER_SMS_NAMES - that exclusion is
 * specifically about SMS cost/annoyance for Aj/Karim, not about withholding the digest itself, so
 * it does not apply here. No-op if the recipient has no email on file (see brokerRoster.js), or if
 * GHL_DIGEST_EMAIL_WEBHOOK_URL isn't configured yet.
 */
async function postDigestEmail(brokerName, email, digestText) {
  if (!email) {
    console.log(`Email relay: skipping - no email on file for ${brokerName}.`);
    return;
  }

  const url = process.env.GHL_DIGEST_EMAIL_WEBHOOK_URL;
  if (!url) {
    console.warn("GHL_DIGEST_EMAIL_WEBHOOK_URL not set - skipping email digest relay for", brokerName);
    return;
  }

  try {
    await axios.post(url, {
      brokerName,
      email,
      subject: `${brokerName} - Morning Digest`,
      digestText,
    });
    console.log(`Digest relayed to GHL webhook for email (${brokerName}).`);
  } catch (err) {
    console.error(`Failed to relay digest to GHL email webhook for ${brokerName}:`, err.response?.data || err.message);
  }
}
