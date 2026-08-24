import axios from "axios";

const GRAPH_API_VERSION = "v21.0";
const WHATSAPP_MAX_CHARS = 4096;
// Leave headroom below the hard limit so we're not right at the edge.
const CHUNK_SIZE = 3800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Splits text into chunks under WhatsApp's character limit, breaking on
 * paragraph/line boundaries where possible so chunks don't cut mid-sentence.
 */
function splitIntoChunks(text) {
  if (text.length <= WHATSAPP_MAX_CHARS) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > CHUNK_SIZE) {
    // Prefer to split at the last paragraph break before the limit, then
    // the last line break, then the last space - falls back to a hard cut
    // only if none of those exist within the chunk.
    let splitAt = remaining.lastIndexOf("\n\n", CHUNK_SIZE);
    if (splitAt === -1) splitAt = remaining.lastIndexOf("\n", CHUNK_SIZE);
    if (splitAt === -1) splitAt = remaining.lastIndexOf(" ", CHUNK_SIZE);
    if (splitAt === -1) splitAt = CHUNK_SIZE;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendSingleMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Sends a plain text WhatsApp message via the Meta Cloud API. Automatically
 * splits messages over WhatsApp's 4096-character limit into multiple
 * sequential messages instead of failing outright (e.g. long multi-lead
 * analysis replies).
 * @param {string} to - recipient's phone number in international format, no "+" (e.g. "34612345678")
 * @param {string} text - message body
 */
export async function sendWhatsAppMessage(to, text) {
  const chunks = splitIntoChunks(text);

  try {
    for (let i = 0; i < chunks.length; i++) {
      await sendSingleMessage(to, chunks[i]);
      // Small delay between chunks so they arrive in order and don't get
      // interleaved by WhatsApp's delivery, without being noticeably slow.
      if (i < chunks.length - 1) await sleep(300);
    }
  } catch (err) {
    console.error("Failed to send WhatsApp message:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Sends a pre-approved WhatsApp message template via the Meta Cloud API
 * (as opposed to free-form text). Used to reopen a recipient's 24-hour
 * messaging window - templates are the only message type Meta allows
 * outside that window.
 * @param {string} to - recipient's phone number in international format, no "+" (e.g. "34612345678")
 * @param {string} templateName - the exact template name as approved in WhatsApp Manager
 * @param {string} [languageCode] - template language code, defaults to 'en_US'
 */
export async function sendTemplateMessage(to, templateName, languageCode = "en_US") {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Failed to send WhatsApp template message:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Marks the given incoming message as read and shows the native "typing..."
 * indicator on the sender's device. Meta auto-dismisses it after 25 seconds
 * or as soon as a real message is sent, whichever comes first. Best-effort:
 * failures here shouldn't block the actual reply, so errors are logged but
 * not thrown.
 * @param {string} messageId - the id of the incoming message from the webhook payload
 */
export async function sendTypingIndicator(messageId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Failed to send typing indicator (non-fatal):", err.response?.data || err.message);
  }
}