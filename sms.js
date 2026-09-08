// SMS adapter (Twilio) — a thin transport layer only, mirroring slack.js's pattern exactly.
// Verifies/parses Twilio's inbound webhook payload, normalizes it, hands off to the shared
// handleIncomingMessage core (same one WhatsApp and Slack use, in claude.js), and sends the
// reply back via Twilio's REST API. No Claude/MCP logic lives here.
//
// NOT YET WIRED UP: server.js does not register a route for handleSmsWebhook, deliberately -
// there's no Twilio account/phone number to point at it yet. Everything here is safe to have
// deployed in the meantime: nothing calls handleSmsWebhook until a route exists, and
// sendSmsMessage no-ops (logs a warning) rather than throwing if the Twilio env vars aren't
// set, same pattern as ghlDigestWebhook.js/ghlMcpClient.js elsewhere in this codebase.
//
// Setup (once you have a Twilio account + phone number):
// 1. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (E.164, e.g.
//    "+15551234567") in Railway.
// 2. In server.js, add BOTH of these (order matters - the urlencoded parser must be scoped to
//    this route only, since Twilio's webhook body is application/x-www-form-urlencoded, not
//    JSON like every other webhook in this codebase):
//      import { handleSmsWebhook } from "./sms.js";
//      app.post("/sms/webhook", express.urlencoded({ extended: false }), handleSmsWebhook);
// 3. In the Twilio console, set that phone number's "A MESSAGE COMES IN" webhook to
//    https://<this-server>/sms/webhook, method POST.
// 4. Test with a real message before trusting it - same discipline as everything else built
//    this session (GHL MCP tools, the SMS digest relay) got verified against the real API
//    before being trusted, not just written against documentation.

import twilio from "twilio";
import { logExchange } from "./conversationLog.js";
import { getIdentityForPhone } from "./brokerRoster.js";
import { handleIncomingMessage } from "./claude.js";

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

/**
 * Sends a plain-text SMS via Twilio. Roster (BROKER_ROSTER) phone numbers are digit-only with
 * no "+" - same format WhatsApp uses - so this adds the "+" Twilio's E.164-only API requires,
 * keeping every caller consistent with sendWhatsAppMessage/postDigestToGhlWebhook's format.
 * No-op (logs a warning, doesn't throw) if Twilio isn't configured yet.
 * @param {string} to - digits-only, no "+", e.g. "34645496611"
 * @param {string} text
 */
export async function sendSmsMessage(to, text) {
  if (!twilioClient || !TWILIO_PHONE_NUMBER) {
    console.warn("Twilio not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER) - skipping SMS send to", to);
    return;
  }
  try {
    await twilioClient.messages.create({
      to: `+${to}`,
      from: TWILIO_PHONE_NUMBER,
      body: text,
    });
  } catch (err) {
    console.error("Failed to send SMS via Twilio:", err.message);
    throw err;
  }
}

/**
 * Express handler for POST /sms/webhook (route not yet registered - see the note at the top of
 * this file for exactly what to add, and why the express.urlencoded() scoping matters).
 */
export async function handleSmsWebhook(req, res) {
  if (!TWILIO_AUTH_TOKEN) {
    console.error("TWILIO_AUTH_TOKEN not set — rejecting SMS webhook request.");
    return res.sendStatus(401);
  }

  // Railway terminates TLS at its edge, so req.protocol reports "http" unless Express's
  // "trust proxy" is set - rather than change that globally (affects every route's req.ip too),
  // just tell Twilio's validator the real public scheme directly for this one check.
  const isValid = twilio.validateExpressRequest(req, TWILIO_AUTH_TOKEN, { protocol: "https" });
  if (!isValid) {
    console.warn("Rejected SMS webhook request with invalid Twilio signature.");
    return res.sendStatus(401);
  }

  // ACK immediately with empty TwiML (no auto-reply baked into the response) so Twilio doesn't
  // retry/timeout on us - same ack-fast-then-process-async pattern as the WhatsApp/Slack
  // webhook handlers elsewhere in this codebase.
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  try {
    const from = (req.body.From || "").replace(/^\+/, "");
    const text = req.body.Body;
    if (!from || !text) return;

    console.log(`Incoming SMS from ${from}: ${text}`);

    const identity = getIdentityForPhone(from);
    logExchange({
      phone: from,
      name: identity?.name,
      role: identity?.role || "unregistered",
      direction: "incoming",
      message: text,
    });

    const reply = await handleIncomingMessage({ userId: from, identity, text, channel: "sms" });

    await sendSmsMessage(from, reply);

    logExchange({
      phone: from,
      name: identity?.name,
      role: identity?.role || "unregistered",
      direction: "outgoing",
      message: reply,
    });
  } catch (err) {
    console.error("Error handling incoming SMS:", err);
  }
}
