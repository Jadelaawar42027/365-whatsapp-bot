// Drafted follow-up texts: the AI proposes up to 3 options, the broker picks one with a button, reviews it with a
// Send/Cancel button, and only then does the bot send it. Sending goes through the GHL MCP
// send_sms tool, which enforces the broker's ownership of the contact again on its side.
//
// Button ids:  sms:<draftId>:opt:<n>   pick option n (0-based)
//              sms:<draftId>:send      send the picked option
//              sms:<draftId>:cancel    cancel the draft

import { pool } from "./db/pool.js";
import { callGhlMcpTool } from "./ghlMcpClient.js";
import { getIdentityForPhone } from "./brokerRoster.js";
import { sendWhatsAppMessage, sendInteractiveButtons } from "./whatsapp.js";
import { findStyleViolations, isWithinSendWindow, SMS_MAX_CHARS } from "./smsDraftStyle.js";

const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SENDS_PER_CONTACT_PER_DAY = 2;

// Validates every option against the style rules. Returns the violations per option, or null if all pass.
export function checkOptions(options) {
  if (!Array.isArray(options) || options.length < 1 || options.length > 3) {
    return [{ index: -1, problems: ["provide between 1 and 3 options"] }];
  }
  const failures = [];
  options.forEach((text, index) => {
    const problems = findStyleViolations(text);
    if (problems.length) failures.push({ index, problems });
  });
  return failures.length ? failures : null;
}

export async function createDraftSet({ brokerPhone, contactId, contactName, options }) {
  const { rows } = await pool.query(
    `INSERT INTO sms_drafts (broker_phone, contact_id, contact_name, options, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [brokerPhone, contactId, contactName || null, JSON.stringify(options), new Date(Date.now() + DRAFT_TTL_MS)]
  );
  return rows[0].id;
}

async function getDraft(id) {
  const { rows } = await pool.query("SELECT * FROM sms_drafts WHERE id = $1", [id]);
  return rows[0] || null;
}

async function setDraft(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(`UPDATE sms_drafts SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

async function sentToContactToday(contactId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sms_drafts
      WHERE contact_id = $1 AND status = 'sent' AND created_at > now() - interval '24 hours'`,
    [contactId]
  );
  return rows[0].n;
}

// Called from server.js when a broker taps a button. Returns true if it handled the reply.
export async function handleSmsButtonReply(from, buttonId) {
  const match = /^sms:([0-9a-f-]{36}):(opt:\d+|send|cancel)$/.exec(buttonId || "");
  if (!match) return false;
  const [, draftId, action] = match;

  const identity = getIdentityForPhone(from);
  const draft = await getDraft(draftId);
  if (!identity || !draft || draft.broker_phone !== from) {
    await sendWhatsAppMessage(from, "That draft isn't yours or no longer exists.");
    return true;
  }
  if (draft.status !== "pending" || new Date(draft.expires_at) < new Date()) {
    await setDraft(draftId, { status: draft.status === "pending" ? "expired" : draft.status });
    await sendWhatsAppMessage(from, "That draft has expired or was already handled. Ask me to draft new follow-ups.");
    return true;
  }

  const options = draft.options;
  const name = draft.contact_name || "this lead";

  if (action === "cancel") {
    await setDraft(draftId, { status: "cancelled" });
    await sendWhatsAppMessage(from, `Cancelled. Nothing was sent to ${name}.`);
    return true;
  }

  if (action.startsWith("opt:")) {
    const index = Number(action.split(":")[1]);
    if (index < 0 || index >= options.length) return true;
    await setDraft(draftId, { chosen_index: index });
    await sendWhatsAppMessage(from, `This is what will be sent to ${name} from your number:\n\n${options[index]}`);
    await sendInteractiveButtons(from, "Send it?", [
      { id: `sms:${draftId}:send`, title: "Send" },
      { id: `sms:${draftId}:cancel`, title: "Cancel" },
    ]);
    return true;
  }

  // action === "send"
  if (draft.chosen_index === null || draft.chosen_index === undefined) {
    await sendWhatsAppMessage(from, "Pick an option first.");
    return true;
  }
  if (!isWithinSendWindow()) {
    await sendWhatsAppMessage(from, `Not sent: texts only go out between 8am and 8pm Eastern. Tap Send again then, or ask me to redraft.`);
    return true;
  }
  if ((await sentToContactToday(draft.contact_id)) >= MAX_SENDS_PER_CONTACT_PER_DAY) {
    await sendWhatsAppMessage(from, `Not sent: ${name} has already had ${MAX_SENDS_PER_CONTACT_PER_DAY} texts from us today.`);
    return true;
  }

  const text = options[draft.chosen_index];
  if (text.length > SMS_MAX_CHARS) {
    await sendWhatsAppMessage(from, "Not sent: the draft is over the length limit.");
    return true;
  }

  try {
    const result = await callGhlMcpTool(identity, "send_sms", { contactId: draft.contact_id, message: text });
    const parsed = typeof result === "string" ? JSON.parse(result) : result;
    await setDraft(draftId, { status: "sent", sent_message_id: parsed?.messageId || null });
    await sendWhatsAppMessage(from, `Sent to ${name}.`);
  } catch (err) {
    console.error(`SMS send failed for draft ${draftId}:`, err.message);
    await sendWhatsAppMessage(from, `Not sent: ${err.message}`);
  }
  return true;
}

// Sends the drafted options to the broker: each option as its own labeled message, then the pick buttons.
export async function presentDrafts({ brokerPhone, contactName, draftId, options }) {
  for (let i = 0; i < options.length; i++) {
    await sendWhatsAppMessage(brokerPhone, `Option ${i + 1} for ${contactName || "this lead"}:\n\n${options[i]}`);
  }
  await sendInteractiveButtons(
    brokerPhone,
    "Which one should I send?",
    options.map((_, i) => ({ id: `sms:${draftId}:opt:${i}`, title: `Option ${i + 1}` }))
  );
}
