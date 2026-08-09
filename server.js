import "dotenv/config";
import express from "express";
import { sendWhatsAppMessage, sendTypingIndicator } from "./whatsapp.js";
import { askClaude } from "./claude.js";
import { logExchange } from "./conversationLog.js";
import { getIdentityForPhone, BROKER_ROSTER } from "./brokerRoster.js";
import { generateMorningDigest } from "./digest.js";
import { generateEODCheckin } from "./eodCheckin.js";
import { transcribeWhatsAppVoiceNote } from "./voiceTranscription.js";

const app = express();
app.use(express.json());

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
      // Could be a status update (delivered/read) rather than a new message — ignore.
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

    const reply = await askClaude(from, text);
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

app.post("/trigger/digest", (req, res) => {
  if (!requireTriggerAuth(req, res)) return;
  const roster = Object.entries(BROKER_ROSTER);
  res.status(202).json({ status: "accepted", recipients: roster.length });
  runBatchReport(generateMorningDigest, "morning digest");
});

app.post("/trigger/eod-checkin", (req, res) => {
  if (!requireTriggerAuth(req, res)) return;
  const roster = Object.entries(BROKER_ROSTER);
  res.status(202).json({ status: "accepted", recipients: roster.length });
  runBatchReport(generateEODCheckin, "EOD check-in");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
