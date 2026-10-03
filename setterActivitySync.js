// Setter activity sync: counts outbound call attempts ("dials") per setter per day, plus the
// unique contacts called, pulled straight from GHL's conversation/message history. Stored one
// row per outbound call (see db/migrations/*_setter-call-events.js) so the one-time backfill and
// the nightly job can both re-run safely. Days are Europe/Paris calendar days.
//
// Booked appointments are NOT stored here - the dashboard already has Date Booked per setter
// from the sheet, same source as the Funnel tab, and computes ABR from that plus these counts.

import { pool } from "./db/pool.js";
import { listConversationsPage, listAllMessages } from "./ghlRestClient.js";

const TZ = "Europe/Paris";
const BACKFILL_CURSOR_KEY = "backfill_cursor";
const BACKFILL_DONE_KEY = "backfill_done";

export function parisDay(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Outbound call attempts only. Every status counts as a dial, including no-answer - a dial is
// an attempt, not a connection.
export function extractOutboundCalls(conversation, messages) {
  return messages
    .filter((m) => m.messageType === "TYPE_CALL" && m.direction === "outbound" && m.userId)
    .map((m) => ({
      message_id: m.id,
      conversation_id: conversation.id,
      contact_id: conversation.contactId || null,
      setter_user_id: m.userId,
      call_day: parisDay(new Date(m.dateAdded).getTime()),
      status: m.status || null,
    }));
}

async function insertCallEvents(rows) {
  if (rows.length === 0) return 0;
  const cols = ["message_id", "conversation_id", "contact_id", "setter_user_id", "call_day", "status"];
  const values = [];
  const placeholders = rows.map((r, i) => {
    const base = i * cols.length;
    values.push(r.message_id, r.conversation_id, r.contact_id, r.setter_user_id, r.call_day, r.status);
    return `(${cols.map((_, j) => `$${base + j + 1}`).join(", ")})`;
  });
  const { rowCount } = await pool.query(
    `INSERT INTO setter_call_events (${cols.join(", ")}) VALUES ${placeholders.join(", ")}
     ON CONFLICT (message_id) DO NOTHING`,
    values
  );
  return rowCount;
}

async function getState(key) {
  const { rows } = await pool.query("SELECT value FROM setter_activity_sync_state WHERE key = $1", [key]);
  return rows[0]?.value ?? null;
}

async function setState(key, value) {
  await pool.query(
    `INSERT INTO setter_activity_sync_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

// Walks every conversation that has ever had a call, newest first, storing outbound calls.
// Checkpointed after every page so a restart resumes from the last finished page instead of
// starting over - inserts are idempotent, so re-processing a page is harmless anyway.
export async function runBackfill({ log = console.log } = {}) {
  if ((await getState(BACKFILL_DONE_KEY)) === "true") {
    log("Setter activity backfill already complete.");
    return { alreadyDone: true };
  }

  let cursor = (await getState(BACKFILL_CURSOR_KEY)) || undefined;
  let conversationsScanned = 0;
  let callsStored = 0;

  for (;;) {
    const page = await listConversationsPage({ startAfterDate: cursor });
    if (page.length === 0) break;

    for (const convo of page) {
      if (!convo.lastCallTimestamp) continue;
      const messages = await listAllMessages(convo.id);
      callsStored += await insertCallEvents(extractOutboundCalls(convo, messages));
      conversationsScanned += 1;
    }

    cursor = String(page[page.length - 1].lastMessageDate);
    await setState(BACKFILL_CURSOR_KEY, cursor);
    log(`Setter backfill: scanned ${conversationsScanned} call conversation(s), stored ${callsStored} outbound call(s) so far.`);

    if (page.length < 100) break;
  }

  await setState(BACKFILL_DONE_KEY, "true");
  log(`Setter activity backfill complete: ${conversationsScanned} call conversation(s), ${callsStored} new outbound call(s).`);
  return { conversationsScanned, callsStored };
}

// Pulls one Paris calendar day's outbound calls. Only conversations active from the day before
// onward are fetched (lastMessageDate sorts newest first, so paging stops as soon as it passes
// that point) - the day-before margin covers any timezone edge, and exact day matching is done
// per message.
export async function syncDay(day, { log = console.log } = {}) {
  const dayStartMs = new Date(`${day}T00:00:00Z`).getTime() - 26 * 60 * 60 * 1000;
  let cursor;
  let stored = 0;
  let scanned = 0;

  outer: for (;;) {
    const page = await listConversationsPage({ startAfterDate: cursor });
    if (page.length === 0) break;
    for (const convo of page) {
      if (Number(convo.lastMessageDate) < dayStartMs) break outer;
      if (!convo.lastCallTimestamp || Number(convo.lastCallTimestamp) < dayStartMs) continue;
      const messages = await listAllMessages(convo.id);
      const dayCalls = extractOutboundCalls(convo, messages).filter((c) => c.call_day === day);
      stored += await insertCallEvents(dayCalls);
      scanned += 1;
    }
    cursor = String(page[page.length - 1].lastMessageDate);
  }

  log(`Setter activity sync for ${day}: scanned ${scanned} conversation(s), stored ${stored} new outbound call(s).`);
  return { day, scanned, stored };
}

// Per-setter, per-day numbers the dashboard reads: dials = outbound call attempts, uniqueContacts
// = distinct contacts those attempts were made to.
export async function getSetterActivity({ start, end }) {
  const { rows } = await pool.query(
    `SELECT call_day::text AS day, setter_user_id,
            COUNT(*)::int AS dials,
            COUNT(DISTINCT contact_id)::int AS unique_contacts
       FROM setter_call_events
      WHERE call_day BETWEEN $1 AND $2
      GROUP BY call_day, setter_user_id
      ORDER BY call_day, setter_user_id`,
    [start, end]
  );
  return rows;
}

// Milliseconds from now until the next 23:59:59 Europe/Paris.
export function msUntilNextParisEndOfDay(now = Date.now()) {
  const day = parisDay(now);
  const [y, m, d] = day.split("-").map(Number);
  // Paris local 23:59:59 expressed as UTC: take the wall-clock time as if it were UTC, then
  // subtract the Paris offset at that moment.
  const asUtc = Date.UTC(y, m - 1, d, 23, 59, 59);
  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(asUtc));
  const get = (t) => Number(offsetParts.find((p) => p.type === t).value);
  const parisAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = parisAsUtc - asUtc;
  let target = asUtc - offsetMs;
  if (target <= now) target += 24 * 60 * 60 * 1000;
  return target - now;
}
