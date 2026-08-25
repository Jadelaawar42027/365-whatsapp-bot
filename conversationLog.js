// Conversation logging: every incoming message and outgoing reply gets
// appended as a row to a Google Sheet, via a tiny Apps Script "web app"
// endpoint (set up once in the sheet itself - see README/setup notes).
// This is best-effort and non-blocking: a logging failure should never
// break the actual bot reply, so errors are logged but never thrown.

const LOG_URL = process.env.CONVERSATION_LOG_URL;

/**
 * @param {object} entry
 * @param {string} entry.phone - sender's phone number (WhatsApp) or Slack user ID (Slack) - same field, whichever channel this came from
 * @param {string} entry.name - resolved name if known, else "Unknown"
 * @param {string} entry.role - 'leadership' | 'broker' | 'setter' | 'unregistered'
 * @param {'incoming'|'outgoing'} entry.direction
 * @param {string} entry.message - the message text
 */
export async function logExchange(entry) {
  if (!LOG_URL) {
    // Not configured - silently skip rather than erroring every message.
    return;
  }

  try {
    await fetch(LOG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        phone: entry.phone,
        name: entry.name || "Unknown",
        role: entry.role || "unregistered",
        direction: entry.direction,
        message: entry.message,
      }),
    });
  } catch (err) {
    console.error("Conversation log write failed (non-fatal):", err.message);
  }
}
