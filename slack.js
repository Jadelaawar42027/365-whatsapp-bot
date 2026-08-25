// Slack adapter — a thin transport layer only. All it does is verify/parse
// Slack's Events API payloads, normalize them, hand off to the shared
// handleIncomingMessage core (same one WhatsApp uses, in claude.js), and
// post the reply back via Slack's Web API. No Claude/MCP logic lives here.
//
// Setup (once, in api.slack.com/apps for this app):
// - Enable Events API, set the Request URL to https://<this-server>/slack/events
// - Subscribe to bot event "message.im" (DMs only, for now)
// - Add bot token scopes: chat:write, im:history, im:read
// - Install the app to the workspace, copy the Bot User OAuth Token into
//   SLACK_BOT_TOKEN, and the Signing Secret into SLACK_SIGNING_SECRET.

import crypto from "crypto";
import axios from "axios";
import { logExchange } from "./conversationLog.js";
import { getIdentityForSlackUser } from "./brokerRoster.js";
import { handleIncomingMessage } from "./claude.js";

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// Reject requests whose timestamp is further than this from now - protects
// against a captured request being replayed later.
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

/**
 * Verifies the `X-Slack-Signature` header per Slack's signing secret scheme.
 * Requires req.rawBody (the exact raw request bytes, captured via the
 * express.json() `verify` callback in server.js) - a re-serialized parsed
 * body isn't guaranteed to produce byte-identical HMAC input.
 */
function verifySlackSignature(req) {
  if (!SLACK_SIGNING_SECRET) {
    console.error("SLACK_SIGNING_SECRET not set — rejecting Slack request.");
    return false;
  }

  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature || !req.rawBody) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isNaN(age) || age > MAX_TIMESTAMP_SKEW_SECONDS) {
    console.warn("Slack request timestamp outside allowed skew — rejecting.");
    return false;
  }

  const base = `v0:${timestamp}:${req.rawBody.toString("utf8")}`;
  const expected = "v0=" + crypto.createHmac("sha256", SLACK_SIGNING_SECRET).update(base).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    // Malformed/mismatched-length signature header - treat as invalid rather than throwing.
    return false;
  }
}

/**
 * Posts a plain-text message to a Slack conversation (DM channel ID from
 * the event payload). Slack's Web API always returns HTTP 200, even on
 * failure — success/failure is signaled via `ok` in the JSON body, not the
 * status code, so that has to be checked explicitly.
 */
async function postSlackMessage(channel, text) {
  const res = await axios.post(
    "https://slack.com/api/chat.postMessage",
    { channel, text },
    {
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.data.ok) {
    throw new Error(`Slack API error posting message: ${res.data.error}`);
  }
}

/**
 * Express handler for POST /slack/events. Handles the one-time URL
 * verification handshake, then DM message events: resolves the sender's
 * identity, calls the shared core handler, and replies via chat.postMessage.
 * Channel mentions (non-DM) are intentionally ignored for now - see
 * event.channel_type check below.
 */
export async function handleSlackEvent(req, res) {
  if (!verifySlackSignature(req)) {
    console.warn("Rejected Slack request with invalid signature.");
    return res.sendStatus(401);
  }

  const body = req.body || {};

  // One-time setup step when registering the Events API Request URL in
  // Slack's app config - echo the challenge back so Slack can confirm this
  // endpoint is live. Equivalent to the WhatsApp webhook's GET verification,
  // just shaped as a POST here since that's how Slack's Events API does it.
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Always ACK immediately so Slack doesn't retry/timeout on us - same
  // pattern as the WhatsApp webhook handler in server.js.
  res.sendStatus(200);

  // Slack retries the same event (marked with an X-Slack-Retry-Num header)
  // if our ack above doesn't land in time. Skip retries rather than
  // generating and sending a second reply.
  if (req.headers["x-slack-retry-num"]) {
    return;
  }

  try {
    const event = body.event;

    if (
      !event ||
      event.type !== "message" ||
      event.channel_type !== "im" || // DMs only for now - channel mentions come later
      event.bot_id || // ignore the bot's own messages / other bots
      event.subtype || // ignore edits, deletes, joins, etc. - only plain new messages
      !event.text
    ) {
      return;
    }

    const slackUserId = event.user;
    const text = event.text;

    console.log(`Incoming Slack DM from ${slackUserId}: ${text}`);

    const identity = getIdentityForSlackUser(slackUserId);
    logExchange({
      phone: slackUserId,
      name: identity?.name,
      role: identity?.role || "unregistered",
      direction: "incoming",
      message: text,
    });

    const reply = await handleIncomingMessage({ userId: slackUserId, identity, text, channel: "slack" });

    await postSlackMessage(event.channel, reply);

    logExchange({
      phone: slackUserId,
      name: identity?.name,
      role: identity?.role || "unregistered",
      direction: "outgoing",
      message: reply,
    });
  } catch (err) {
    console.error("Error handling incoming Slack event:", err);
  }
}
