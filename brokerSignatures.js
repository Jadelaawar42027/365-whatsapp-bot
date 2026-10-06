// Broker email signatures, pulled once from a real email each broker sent from GHL's inbox
// (the only emails GHL attaches their signature to) and stored. A broker with no usable email
// is marked no_signature so later runs don't search for them again.

import { pool } from "./db/pool.js";
import {
  listLocationUsers,
  listConversationsForUser,
  listAllMessages,
  getMessageById,
} from "./ghlRestClient.js";

const BROKER_NAMES = [
  "Nicolette Cervone",
  "Charlie Seitz",
  "James Klier",
  "Cheryl Hazel",
  "Martin Herbert-Burns",
  "Joseph Graffeo",
  "Peter Shaarda",
  "Alex Siegers",
  "David Pattinson",
];

// The roster spelling and GHL's spelling differ for some people.
const GHL_NAME_ALIASES = { "Alex Siegers": ["Alex Siegars"] };

const MAX_CONVERSATIONS_PER_BROKER = 40;
const MAX_EMAILS_PER_BROKER = 5;
const FOOTER_PATTERN = /no longer wish to receive/i;

function normalizeName(s) {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Start index of the <p> or <div> block containing position idx.
function blockStart(html, idx) {
  return Math.max(html.lastIndexOf("<p", idx), html.lastIndexOf("<div", idx), 0);
}

// Pulls the signature out of one email's HTML. Returns the signature HTML, or null if it can't
// be found with confidence. Cuts off the campaign unsubscribe footer first, then takes everything
// from the closing sign-off paragraph onward. Requires the broker's own name to appear in it.
export function extractSignatureHtml(rawHtml, brokerName) {
  if (!rawHtml) return null;
  let body = rawHtml;

  const footerIdx = body.search(FOOTER_PATTERN);
  if (footerIdx !== -1) body = body.slice(0, blockStart(body, footerIdx));

  const lower = body.toLowerCase();
  const names = [brokerName, ...(GHL_NAME_ALIASES[brokerName] || [])].map(normalizeName);
  const nameIdx = Math.max(...names.map((n) => lower.lastIndexOf(n)));
  if (nameIdx === -1) return null;

  const signatureHtml = body.slice(blockStart(body, nameIdx)).trim();
  const text = normalizeName(htmlToText(signatureHtml));
  if (!text || text.length > 800) return null;
  if (/unsubscribe/i.test(text)) return null;
  return signatureHtml;
}

async function findBrokerEmails(userId) {
  const found = [];
  const conversations = (await listConversationsForUser(userId)).slice(0, MAX_CONVERSATIONS_PER_BROKER);
  for (const convo of conversations) {
    const messages = await listAllMessages(convo.id);
    for (const m of messages) {
      if (m.messageType === "TYPE_EMAIL" && m.direction === "outbound" && m.userId === userId) {
        found.push(m.id);
        if (found.length >= MAX_EMAILS_PER_BROKER) return found;
      }
    }
  }
  return found;
}

async function saveSignature(userId, brokerName, { signatureHtml, sourceMessageId }) {
  await pool.query(
    `INSERT INTO broker_signatures (broker_user_id, broker_name, signature_html, no_signature, source_message_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (broker_user_id) DO UPDATE SET
       broker_name = EXCLUDED.broker_name,
       signature_html = EXCLUDED.signature_html,
       no_signature = EXCLUDED.no_signature,
       source_message_id = EXCLUDED.source_message_id,
       updated_at = now()`,
    [userId, brokerName, signatureHtml, signatureHtml === null, sourceMessageId]
  );
}

export async function getStoredSignature(userId) {
  const { rows } = await pool.query(
    "SELECT signature_html, no_signature FROM broker_signatures WHERE broker_user_id = $1",
    [userId]
  );
  return rows[0] || null;
}

// Finds one broker's signature from their recent emails. Stores the result either way: the
// signature, or no_signature = true when nothing usable turned up.
export async function refreshBrokerSignature(brokerName, { force = false, users } = {}) {
  const allUsers = users || (await listLocationUsers());
  const wanted = [brokerName, ...(GHL_NAME_ALIASES[brokerName] || [])].map(normalizeName);
  const user = allUsers.find((u) => wanted.includes(normalizeName(`${u.firstName || ""} ${u.lastName || ""}`)));
  if (!user) return { brokerName, status: "no_ghl_user" };

  if (!force) {
    const existing = await getStoredSignature(user.id);
    if (existing) return { brokerName, status: existing.no_signature ? "already_marked_none" : "already_stored" };
  }

  const emailIds = await findBrokerEmails(user.id);
  for (const messageId of emailIds) {
    const message = await getMessageById(messageId);
    const signatureHtml = extractSignatureHtml(message.body || "", brokerName);
    if (signatureHtml) {
      await saveSignature(user.id, brokerName, { signatureHtml, sourceMessageId: messageId });
      return { brokerName, status: "stored", emailsChecked: emailIds.indexOf(messageId) + 1 };
    }
  }

  await saveSignature(user.id, brokerName, { signatureHtml: null, sourceMessageId: null });
  return { brokerName, status: "no_signature", emailsChecked: emailIds.length };
}

export async function refreshAllSignatures({ force = false, only } = {}) {
  const users = await listLocationUsers();
  const names = only ? [only] : BROKER_NAMES;
  const results = [];
  for (const name of names) {
    try {
      results.push(await refreshBrokerSignature(name, { force, users }));
    } catch (err) {
      results.push({ brokerName: name, status: "error", error: err.message });
    }
  }
  return results;
}
