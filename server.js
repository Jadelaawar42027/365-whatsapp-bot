import "dotenv/config";
import express from "express";
import { sendWhatsAppMessage, sendTypingIndicator, sendTemplateMessage } from "./whatsapp.js";
import { handleIncomingMessage } from "./claude.js";
import { handleSlackEvent } from "./slack.js";
import { logExchange } from "./conversationLog.js";
import { getIdentityForPhone, getIdentityByName, getLeadershipEntries, BROKER_ROSTER } from "./brokerRoster.js";
import { generateMorningDigest } from "./digest.js";
import { generateEODCheckin } from "./eodCheckin.js";
import { generateCallReview } from "./callReview.js";
import { generateNoShowFollowup } from "./noShowFollowup.js";
import { formatCollectedAlerts } from "./leadershipDigest.js";
import { generateBrokerPerformanceReview } from "./brokerPerformanceReview.js";
import { transcribeWhatsAppVoiceNote } from "./voiceTranscription.js";
import { checkDbConnection } from "./db/pool.js";
import { getStaleMissedFollowups } from "./db/followupEvents.js";

const app = express();
// verify captures the exact raw request bytes onto req.rawBody, alongside
// the normal parsed req.body - needed for Slack's HMAC signature
// verification (see slack.js), which requires the raw bytes Slack actually
// signed rather than a re-serialized parsed body. Unused by every other
// route, so this is harmless everywhere else.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ---------------------------------------------------------------------------
// 1) Webhook verification — Meta calls this ONCE when you register the
//    webhook URL in the App Dashboard. It sends a GET request with a
//    challenge; you must echo it back if the verify token matches.
// ---------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("Webhook verification failed.");
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// 2) Incoming messages — Meta POSTs here every time someone messages your
//    WhatsApp number.
// ---------------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  // Always ACK immediately so Meta doesn't retry/timeout on you.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Not a new message - could be a delivery status callback
      // (sent/delivered/read/failed). Log failures specifically, since a
      // message that our code thinks "sent" successfully (no thrown error)
      // can still fail to actually deliver - most commonly because it's
      // outside WhatsApp's 24-hour window for free-form messages to that
      // recipient. Without this, that kind of failure is completely silent.
      const status = value?.statuses?.[0];
      if (status?.status === "failed") {
        const errorDetail = status.errors?.[0];
        console.error(
          `WhatsApp delivery FAILED to ${status.recipient_id}: ` +
          `${errorDetail?.title || "unknown error"} ` +
          `(code ${errorDetail?.code || "?"}) - ${errorDetail?.message || ""}`
        );
      }
      return;
    }

    if (message.type !== "text" && message.type !== "audio") {
      const from = message.from;
      await sendWhatsAppMessage(from, "I can only read text messages or voice notes right now.");
      return;
    }

    const from = message.from; // sender's phone number

    // Show the native "typing..." indicator right away - best-effort, don't
    // block on it. If the reply takes a while (multi-tool GHL calls can),
    // the indicator alone might expire after 25s with nothing sent yet, so
    // a text fallback fires after FALLBACK_DELAY_MS if we're still working.
    sendTypingIndicator(message.id);

    const FALLBACK_DELAY_MS = 8000;
    let replied = false;
    const fallbackTimer = setTimeout(() => {
      if (!replied) {
        sendWhatsAppMessage(from, "Sure, working on your request now...").catch((err) =>
          console.error("Failed to send fallback message (non-fatal):", err.message)
        );
      }
    }, FALLBACK_DELAY_MS);

    let text;

    if (message.type === "text") {
      text = message.text.body;
      console.log(`Incoming from ${from}: ${text}`);
    } else {
      console.log(`Incoming voice note from ${from}, transcribing...`);
      try {
        text = await transcribeWhatsAppVoiceNote(message.audio.id);
        console.log(`Transcribed from ${from}: ${text}`);
      } catch (err) {
        console.error("Voice note transcription failed:", err.message);
        clearTimeout(fallbackTimer);
        await sendWhatsAppMessage(from, "Couldn't transcribe that voice note — try again or send it as text.");
        return;
      }
    }

    const identity = getIdentityForPhone(from);
    logExchange({
      phone: from,
      name: identity?.name,
      role: identity?.role || "unregistered",
      direction: "incoming",
      message: text,
    });

    const reply = await handleIncomingMessage({ userId: from, identity, text, channel: "whatsapp" });
    replied = true;
    clearTimeout(fallbackTimer);
    await sendWhatsAppMessage(from, reply);

    logExchange({
      phone: from,
      name: identity?.name,
      role: identity?.role || "unregistered",
      direction: "outgoing",
      message: reply,
    });
  } catch (err) {
    console.error("Error handling incoming webhook:", err);
  }
});

// ---------------------------------------------------------------------------
// 2b) Slack — second input/output channel, reusing the same
//    handleIncomingMessage core as WhatsApp above. All Slack-specific
//    logic (signature verification, Events API payload shape, DM filtering,
//    posting the reply) lives in slack.js; this route just wires it in.
// ---------------------------------------------------------------------------
app.post("/slack/events", handleSlackEvent);

app.get("/", (req, res) => {
  res.send("365 Yachts WhatsApp bot is running.");
});

// ---------------------------------------------------------------------------
// 3) Scheduled report triggers (Chapters 1 + 9) — called by an external
//    scheduler (Make.com or similar) on a timer. Protected by a shared
//    secret since these fire proactive messages to everyone in the roster -
//    not something that should be triggerable by just anyone who finds the
//    URL. Both respond immediately and process in the background: each
//    person's report can take a while (its own multi-tool GHL scan + Claude
//    call), well beyond what most schedulers will wait on synchronously.
// ---------------------------------------------------------------------------

function requireTriggerAuth(req, res) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || token !== process.env.TRIGGER_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * Runs generatorFn for every roster entry and sends the result via
 * WhatsApp, logging each exchange. One person's failure is caught and
 * logged rather than aborting the rest of the batch.
 */
async function runBatchReport(generatorFn, reportLabel) {
  const roster = Object.entries(BROKER_ROSTER).map(([phone, identity]) => ({ phone, ...identity }));

  for (const person of roster) {
    try {
      console.log(`Generating ${reportLabel} for ${person.name} (${person.phone})...`);
      const report = await generatorFn(person);
      await sendWhatsAppMessage(person.phone, report);
      logExchange({
        phone: person.phone,
        name: person.name,
        role: person.role,
        direction: "outgoing",
        message: `[${reportLabel.toUpperCase()}]\n${report}`,
      });
      console.log(`${reportLabel} sent to ${person.name}.`);
    } catch (err) {
      console.error(`Failed to generate/send ${reportLabel} for ${person.name}:`, err.message);
    }
    // Small gap between sends so a batch doesn't hammer the GHL MCP server
    // / Anthropic API all at once.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(`${reportLabel} run complete.`);
}

/**
 * Formats a broker-facing note for leads whose missed-follow-up flag (see
 * db/followupEvents.js's getStaleMissedFollowups) is still unresolved 7+
 * days after it was first raised. Appended to the END of a person's digest
 * text - never merged into or placed before it - so it always lands after
 * that digest's own hot-leads-first section.
 * @param {Array<{contactName: string|null, contactId: string, daysAgo: number}>} items
 */
function formatStaleFollowupNote(items) {
  const lines = ["❗❗❗ *Still not followed up (flagged 7+ days ago)*"];
  for (const item of items) {
    lines.push(`- ${item.contactName || item.contactId}: flagged ${item.daysAgo} days ago, still no follow-up logged`);
  }
  return lines.join("\n");
}

/**
 * Morning digest run: brokers first (each digest generation also extracts
 * "leadership flags" - near-close deals, alerts - in the SAME Claude call,
 * no extra scan), THEN leadership last: their own personal digest, followed
 * by a compiled summary built purely from the flags already collected
 * during the broker loop - zero additional tool calls for that summary.
 */
async function runMorningDigestSequence() {
  const roster = Object.entries(BROKER_ROSTER).map(([phone, identity]) => ({ phone, ...identity }));
  const brokers = roster.filter((p) => p.role === "broker");
  const leadership = roster.filter((p) => p.role === "leadership");

  const collectedFlags = [];
  const collectedStaleFollowups = [];

  for (const person of brokers) {
    try {
      console.log(`Generating morning digest for ${person.name} (${person.phone})...`);
      const { text, flags } = await generateMorningDigest(person);

      // Memory-layer check, AFTER the digest's own hot-leads-first report is
      // already built - appended to the end of their text, never reordered
      // into it, so it always lands after hot leads for this same person.
      const staleFollowups = await getStaleMissedFollowups({ role: "broker", brokerId: person.phone });
      const fullText = staleFollowups.length > 0
        ? `${text}\n\n${formatStaleFollowupNote(staleFollowups)}`
        : text;

      await sendWhatsAppMessage(person.phone, fullText);
      logExchange({
        phone: person.phone,
        name: person.name,
        role: person.role,
        direction: "outgoing",
        message: `[MORNING DIGEST]\n${fullText}`,
      });
      console.log(`Morning digest sent to ${person.name}. Flags collected: ${flags.length}, stale follow-ups: ${staleFollowups.length}`);
      for (const flag of flags) {
        collectedFlags.push({ ...flag, brokerName: person.name });
      }
      for (const item of staleFollowups) {
        collectedStaleFollowups.push({ ...item, brokerName: person.name });
      }
    } catch (err) {
      console.error(`Failed to generate/send morning digest for ${person.name}:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Leadership goes LAST: their own personal digest (if they have a
  // personal deal book), then the compiled team summary from everything
  // collected above - no second scan needed for that summary.
  for (const person of leadership) {
    try {
      console.log(`Generating morning digest for leadership ${person.name} (${person.phone})...`);
      const { text } = await generateMorningDigest(person);
      await sendWhatsAppMessage(person.phone, text);
      logExchange({
        phone: person.phone,
        name: person.name,
        role: person.role,
        direction: "outgoing",
        message: `[MORNING DIGEST]\n${text}`,
      });
      console.log(`Morning digest sent to ${person.name}.`);
    } catch (err) {
      console.error(`Failed to generate/send morning digest for ${person.name}:`, err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const summary = formatCollectedAlerts(collectedFlags, person.name, collectedStaleFollowups);
      await sendWhatsAppMessage(person.phone, summary);
      logExchange({
        phone: person.phone,
        name: person.name,
        role: person.role,
        direction: "outgoing",
        message: `[TEAM SUMMARY]\n${summary}`,
      });
      console.log(`Team summary sent to ${person.name}.`);
    } catch (err) {
      console.error(`Failed to send team summary to ${person.name}:`, err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("Morning digest run complete.");
}

/**
 * Test variant of the digest run - generates each broker's ACTUAL digest
 * (their real identity, their real GHL data, the real rules) so a prompt
 * change can be verified against real data, but routes every result to
 * leadership instead of the broker themselves, clearly labeled with whose
 * digest it is - so testing a change never sends a broker an unsolicited
 * "test" message. Leadership's own digest + compiled team summary are
 * generated and sent normally at the end, same as a real run, just also
 * labeled [TEST] for clarity.
 */
async function runMorningDigestTestSequence() {
  const roster = Object.entries(BROKER_ROSTER).map(([phone, identity]) => ({ phone, ...identity }));
  const brokers = roster.filter((p) => p.role === "broker");
  const leadership = roster.filter((p) => p.role === "leadership");

  if (leadership.length === 0) {
    console.warn("Digest test run: no leadership entries to send test output to - aborting.");
    return;
  }

  const collectedFlags = [];
  const collectedStaleFollowups = [];

  for (const person of brokers) {
    try {
      console.log(`[TEST] Generating morning digest for ${person.name} (${person.phone})...`);
      const { text, flags } = await generateMorningDigest(person);
      const staleFollowups = await getStaleMissedFollowups({ role: "broker", brokerId: person.phone });
      const fullText = staleFollowups.length > 0
        ? `${text}\n\n${formatStaleFollowupNote(staleFollowups)}`
        : text;
      const labeled = `[TEST DIGEST — ${person.name}]\n\n${fullText}`;
      for (const leader of leadership) {
        await sendWhatsAppMessage(leader.phone, labeled);
        logExchange({
          phone: leader.phone,
          name: leader.name,
          role: leader.role,
          direction: "outgoing",
          message: `[TEST MORNING DIGEST - ${person.name}]\n${fullText}`,
        });
      }
      console.log(`[TEST] Digest for ${person.name} sent to leadership. Flags collected: ${flags.length}, stale follow-ups: ${staleFollowups.length}`);
      for (const flag of flags) {
        collectedFlags.push({ ...flag, brokerName: person.name });
      }
      for (const item of staleFollowups) {
        collectedStaleFollowups.push({ ...item, brokerName: person.name });
      }
    } catch (err) {
      console.error(`[TEST] Failed to generate digest for ${person.name}:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  for (const person of leadership) {
    try {
      console.log(`[TEST] Generating morning digest for leadership ${person.name} (${person.phone})...`);
      const { text } = await generateMorningDigest(person);
      await sendWhatsAppMessage(person.phone, `[TEST DIGEST — ${person.name}]\n\n${text}`);
      logExchange({
        phone: person.phone,
        name: person.name,
        role: person.role,
        direction: "outgoing",
        message: `[TEST MORNING DIGEST]\n${text}`,
      });
      console.log(`[TEST] Digest sent to ${person.name}.`);
    } catch (err) {
      console.error(`[TEST] Failed to generate/send morning digest for ${person.name}:`, err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const summary = formatCollectedAlerts(collectedFlags, person.name, collectedStaleFollowups);
      await sendWhatsAppMessage(person.phone, `[TEST TEAM SUMMARY]\n\n${summary}`);
      logExchange({
        phone: person.phone,
        name: person.name,
        role: person.role,
        direction: "outgoing",
        message: `[TEST TEAM SUMMARY]\n${summary}`,
      });
      console.log(`[TEST] Team summary sent to ${person.name}.`);
    } catch (err) {
      console.error(`[TEST] Failed to send team summary to ${person.name}:`, err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("[TEST] Morning digest test run complete.");
}

app.post("/trigger/digest-test", (req, res) => {
  if (!requireTriggerAuth(req, res)) return;
  const leadership = getLeadershipEntries();
  res.status(202).json({ status: "accepted", note: "test run - all output goes to leadership only", leadershipRecipients: leadership.length });
  runMorningDigestTestSequence();
});

app.post("/trigger/digest", (req, res) => {
  if (!requireTriggerAuth(req, res)) return;
  const roster = Object.entries(BROKER_ROSTER);
  res.status(202).json({ status: "accepted", recipients: roster.length });
  runMorningDigestSequence();
});

app.post("/trigger/eod-checkin", (req, res) => {
  if (!requireTriggerAuth(req, res)) return;
  const roster = Object.entries(BROKER_ROSTER);
  res.status(202).json({ status: "accepted", recipients: roster.length });
  runBatchReport(generateEODCheckin, "EOD check-in");
});

// "starter" was added to the WABA that actually owns the deployed phone
// number (1085003924210260, phone 1290223800835641) and confirmed live on
// WhatsApp. Both the real send and the leadership-only test below read from
// these two constants, so there's only one place to update if the template
// changes again.
const DAILY_TEMPLATE_NAME = "starter";
const DAILY_TEMPLATE_LANGUAGE = "en";

/**
 * Sends the approved WhatsApp template (see DAILY_TEMPLATE_NAME above) to
 * every roster entry (brokers and leadership alike) to reopen each
 * person's 24-hour messaging window before regular free-form reports need
 * to go out.
 */
async function runDailyTemplateSequence() {
  const roster = Object.entries(BROKER_ROSTER).map(([phone, identity]) => ({ phone, ...identity }));

  for (const person of roster) {
    try {
      await sendTemplateMessage(person.phone, DAILY_TEMPLATE_NAME, DAILY_TEMPLATE_LANGUAGE);
      logExchange({
        phone: person.phone,
        name: person.name,
        role: person.role,
        direction: "outgoing",
        message: "[DAILY TEMPLATE] Window reopen message sent",
      });
      console.log(`Daily template sent to ${person.name}.`);
    } catch (err) {
      console.error(`Failed to send daily template to ${person.name}:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log("Daily template run complete.");
}

/**
 * Test variant of the daily template send - leadership only, so a template
 * swap (like this one) can be verified against a couple of real recipients
 * before firing it at the whole roster.
 */
app.post("/trigger/daily-template-test", (req, res) => {
  if (!requireTriggerAuth(req, res)) return;
  const leadership = getLeadershipEntries();
  res.status(202).json({ status: "accepted", recipients: leadership.length });

  (async () => {
    for (const person of leadership) {
      try {
        await sendTemplateMessage(person.phone, DAILY_TEMPLATE_NAME, DAILY_TEMPLATE_LANGUAGE);
        logExchange({
          phone: person.phone,
          name: person.name,
          role: person.role,
          direction: "outgoing",
          message: "[DAILY TEMPLATE TEST] Window reopen message sent",
        });
        console.log(`Daily template test sent to ${person.name}.`);
      } catch (err) {
        console.error(`Failed to send daily template test to ${person.name}:`, err.message);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log("Daily template test run complete.");
  })();
});

app.post("/trigger/daily-template", (req, res) => {
  if (!requireTriggerAuth(req, res)) return;
  const roster = Object.entries(BROKER_ROSTER);
  res.status(202).json({ status: "accepted", recipients: roster.length });
  runDailyTemplateSequence();
});

// ---------------------------------------------------------------------------
// 4) Call review trigger — fired directly by a GHL automation (webhook
//    action), not a time-based scheduler. Configure the GHL workflow to fire
//    when a call's outcome is marked "Call Performed" (not "Call No Show"),
//    with a webhook action POSTing JSON containing the contact's ID, name,
//    and the assigned broker's name (all standard GHL merge fields).
//    Reviews just that one call and messages just that one broker - not a
//    roster-wide batch like the digest/EOD endpoints.
// ---------------------------------------------------------------------------
app.post("/trigger/call-review", async (req, res) => {
  if (!requireTriggerAuth(req, res)) return;

  console.log("Call review trigger raw payload:", JSON.stringify(req.body));

  const body = req.body || {};
  const contactId = body.contactId || body.id || body.contact_id;
  const contactName = body.contactName || body.full_name || `${body.first_name || ""} ${body.last_name || ""}`.trim();
  const brokerName = body.brokerName || (body.user ? `${body.user.firstName || ""} ${body.user.lastName || ""}`.trim() : undefined);

  if (!contactId || !brokerName) {
    return res.status(400).json({ error: "Missing required fields: contactId and brokerName." });
  }

  const identity = getIdentityByName(brokerName);
  if (!identity) {
    console.error(`Call review trigger: no roster match (or ambiguous match) for broker name "${brokerName}".`);
    return res.status(404).json({ error: `No unique roster match for broker name "${brokerName}".` });
  }

  res.status(202).json({ status: "accepted", broker: identity.name });

  (async () => {
    try {
      console.log(`Generating call review for ${identity.name} on contact ${contactName || contactId}...`);
      const review = await generateCallReview(identity, contactId, contactName || "this lead");
      await sendWhatsAppMessage(identity.phone, review);
      logExchange({
        phone: identity.phone,
        name: identity.name,
        role: identity.role,
        direction: "outgoing",
        message: `[CALL REVIEW - ${contactName || contactId}]\n${review}`,
      });
      console.log(`Call review sent to ${identity.name}.`);
    } catch (err) {
      console.error(`Failed to generate/send call review for ${identity.name}:`, err.message);
    }
  })();
});

// ---------------------------------------------------------------------------
// 5) No-show follow-up trigger — fired by a GHL automation, same shape as
//    call-review: workflow condition = Outcome is "Call No Show" -> Wait 24
//    hours -> Webhook action posting contactId, contactName, brokerName.
//    Checks for reschedule/response and asks the broker to decide if there's
//    been none. The broker's reply (follow up vs. reactivation) flows
//    through the normal chat pipeline in claude.js/systemPrompt.js.
// ---------------------------------------------------------------------------
app.post("/trigger/no-show-followup", async (req, res) => {
  if (!requireTriggerAuth(req, res)) return;

  console.log("No-show follow-up trigger raw payload:", JSON.stringify(req.body));

  const body = req.body || {};
  const contactId = body.contactId || body.id || body.contact_id;
  const contactName = body.contactName || body.full_name || `${body.first_name || ""} ${body.last_name || ""}`.trim();
  const brokerName = body.brokerName || (body.user ? `${body.user.firstName || ""} ${body.user.lastName || ""}`.trim() : undefined);

  if (!contactId || !brokerName) {
    return res.status(400).json({ error: "Missing required fields: contactId and brokerName." });
  }

  const identity = getIdentityByName(brokerName);
  if (!identity) {
    console.error(`No-show follow-up trigger: no roster match (or ambiguous match) for broker name "${brokerName}".`);
    return res.status(404).json({ error: `No unique roster match for broker name "${brokerName}".` });
  }

  res.status(202).json({ status: "accepted", broker: identity.name });

  (async () => {
    try {
      console.log(`Generating no-show follow-up for ${identity.name} on contact ${contactName || contactId}...`);
      const followup = await generateNoShowFollowup(identity, contactId, contactName || "this lead");
      await sendWhatsAppMessage(identity.phone, followup);
      logExchange({
        phone: identity.phone,
        name: identity.name,
        role: identity.role,
        direction: "outgoing",
        message: `[NO-SHOW FOLLOW-UP - ${contactName || contactId}]\n${followup}`,
      });
      console.log(`No-show follow-up sent to ${identity.name}.`);
    } catch (err) {
      console.error(`Failed to generate/send no-show follow-up for ${identity.name}:`, err.message);
    }
  })();
});

// ---------------------------------------------------------------------------
// 6) Leadership briefing trigger — like the digest trigger, but scoped to
//    leadership only and sends TWO separate messages per recipient: the
//    hot-buyers-and-alerts digest (cross-team), then the combined broker
//    broker performance review only. The hot-buyers-and-alerts summary is
//    no longer generated here - it's now compiled automatically as part of
//    /trigger/digest (see runMorningDigestSequence above), built from flags
//    collected during each broker's digest run rather than a second scan.
//    This endpoint remains for the performance review specifically, which
//    still needs its own dedicated look at cadence compliance per broker.
// ---------------------------------------------------------------------------
app.post("/trigger/leadership-digest", (req, res) => {
  if (!requireTriggerAuth(req, res)) return;
  const leadership = getLeadershipEntries();
  res.status(202).json({ status: "accepted", recipients: leadership.length });

  (async () => {
    for (const person of leadership) {
      try {
        console.log(`Generating broker performance review for ${person.name}...`);
        const performance = await generateBrokerPerformanceReview(person);
        await sendWhatsAppMessage(person.phone, performance);
        logExchange({
          phone: person.phone,
          name: person.name,
          role: person.role,
          direction: "outgoing",
          message: `[BROKER PERFORMANCE REVIEW]\n${performance}`,
        });
        console.log(`Broker performance review sent to ${person.name}.`);
      } catch (err) {
        console.error(`Failed to generate/send broker performance review for ${person.name}:`, err.message);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log("Leadership briefing run complete.");
  })();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  checkDbConnection(); // logs success/failure - doesn't block startup, WhatsApp/Slack don't depend on it
});
