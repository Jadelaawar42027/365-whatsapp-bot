import "dotenv/config";
import express from "express";
import { sendWhatsAppMessage, sendTypingIndicator } from "./whatsapp.js";
import { askClaude } from "./claude.js";
import { transcribeWhatsAppVoiceNote } from "./voiceTranscription.js";

const app = express();
app.use(express.json());

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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return;
    }

    const from = message.from;

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
    } else if (message.type === "audio") {
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
    } else {
      clearTimeout(fallbackTimer);
      await sendWhatsAppMessage(from, "I can only read text messages or voice notes right now.");
      return;
    }

    const reply = await askClaude(from, text);
    replied = true;
    clearTimeout(fallbackTimer);
    await sendWhatsAppMessage(from, reply);
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
