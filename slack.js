// Slack adapter — a thin transport layer only. All it does is verify/parse
// Slack's Events API payloads, normalize them, hand off to the shared
// handleIncomingMessage core (same one WhatsApp uses, in claude.js), and
// post the reply back via Slack's Web API. No Claude/MCP logic lives here.
//
// Setup (once, in api.slack.com/apps for this app):
// - Enable Events API, set the Request URL to https://<this-server>/slack/events
// - Subscribe to bot events "message.im" (DMs) and "app_mention" (channel @-mentions)
// - Add bot token scopes: chat:write, im:history, im:read, app_mentions:read
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

// Slack's own event_id (unique per event, stable across retries) - tracked
// here so a retry, or a hypothetical future overlap between message.im and
// app_mention firing for the same underlying message, can't produce two
// replies. Just needs to cover the retry/duplicate window, not be a durable
// store, so a small bounded set is enough.
const recentEventIds = new Set();
const MAX_RECENT_EVENT_IDS = 500;

function alreadyProcessed(eventId) {
  if (!eventId) return false;
  if (recentEventIds.has(eventId)) return true;
  recentEventIds.add(eventId);
  if (recentEventIds.size > MAX_RECENT_EVENT_IDS) {
    recentEventIds.delete(recentEventIds.values().next().value);
  }
  return false;
}

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
 * Posts a plain-text message to a Slack conversation (channel ID from the
 * event payload - a DM channel or a regular channel). Pass threadTs to
 * reply inside a thread (used for channel mentions) instead of posting a
 * new top-level message; omit it for a plain DM reply. Slack's Web API
 * always returns HTTP 200, even on failure — success/failure is signaled
 * via `ok` in the JSON body, not the status code, so that has to be
 * checked explicitly.
 */
async function postSlackMessage(channel, text, threadTs) {
  const body = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  const res = await axios.post(
    "https://slack.com/api/chat.postMessage",
    body,
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
 * verification handshake, then two event types - DM messages (message.im)
 * and channel @-mentions (app_mention) - both funneled through the same
 * identity resolution, core handler call, and chat.postMessage reply.
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

  // Belt-and-suspenders dedup on Slack's own event_id, in case a retry
  // arrives without the header above, or message.im and app_mention ever
  // both fired for the same underlying message.
  if (alreadyProcessed(body.event_id)) {
    return;
  }

  try {
    const event = body.event;
    if (!event) return;

    let text;
    let replyChannel;
    let threadTs; // undefined = reply as a new top-level message (DMs); set for mentions

    if (
      event.type === "message" &&
      event.channel_type === "im" &&
      !event.bot_id && // ignore the bot's own messages / other bots
      !event.subtype && // ignore edits, deletes, joins, etc. - only plain new messages
      event.text
    ) {
      text = event.text;
      replyChannel = event.channel;
      // DM replies stay inline, not threaded.
    } else if (
      event.type === "app_mention" &&
      !event.bot_id &&
      !event.subtype &&
      event.text
    ) {
      // Strip the leading <@BOTID> mention Slack includes in the text
      // (there can technically be more than one leading mention) before
      // handing it to the core handler as a plain question.
      text = event.text.replace(/^(<@[^>]+>\s*)+/, "").trim();
      replyChannel = event.channel;
      // Reply in the existing thread if this mention was already part of
      // one, otherwise start a new thread from this message - never as a
      // new top-level channel message.
      threadTs = event.thread_ts || event.ts;
    } else {
      return;
    }

    if (!text) return; // e.g. a bare mention with nothing else in it

    const slackUserId = event.user;

    console.log(`Incoming Slack ${event.type === "app_mention" ? "mention" : "DM"} from ${slackUserId}: ${text}`);

    const identity = getIdentityForSlackUser(slackUserId);
    logExchange({
      phone: slackUserId,
      name: identity?.name,
      role: identity?.role || "unregistered",
      direction: "incoming",
      message: text,
    });

    const reply = await handleIncomingMessage({ userId: slackUserId, identity, text, channel: "slack" });

    await postSlackMessage(replyChannel, reply, threadTs);

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
