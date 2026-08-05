import "dotenv/config";
import express from "express";
import { sendWhatsAppMessage, sendTypingIndicator } from "./whatsapp.js";
import { askClaude } from "./claude.js";
import { logExchange } from "./conversationLog.js";
import { getIdentityForPhone } from "./brokerRoster.js";

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

    if (message.type !== "text") {
      const from = message.from;
      await sendWhatsAppMessage(from, "I can only read text messages right now — try typing your question.");
      return;
    }

    const from = message.from; // sender's phone number
    const text = message.text.body;

    console.log(`Incoming from ${from}: ${text}`);

    const identity = getIdentityForPhone(from);
    logExchange({
      phone: from,
      name: identity?.name,
      role: identity?.role || "unregistered",
      direction: "incoming",
      message: text,
    });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
