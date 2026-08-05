import axios from "axios";

const GRAPH_API_VERSION = "v21.0";

/**
 * Sends a plain text WhatsApp message via the Meta Cloud API.
 * @param {string} to - recipient's phone number in international format, no "+" (e.g. "34612345678")
 * @param {string} text - message body
 */
export async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  try {
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
  } catch (err) {
    console.error("Failed to send WhatsApp message:", err.response?.data || err.message);
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
