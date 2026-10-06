// Direct GHL REST client for the setter-activity sync. Rate-limited to 4 requests per second
// (well under GHL's per-location limits) and shared across the backfill and the daily job so
// they can never burst past it together.

const GHL_BASE = "https://services.leadconnectorhq.com";
const MAX_PER_SECOND = 4;
const GAP_MS = 1000 / MAX_PER_SECOND;

let queue = Promise.resolve();
function limited(fn) {
  const run = queue.then(() => new Promise((r) => setTimeout(r, GAP_MS)).then(fn));
  queue = run.catch(() => {});
  return run;
}

async function ghlGet(path, params = {}) {
  const url = new URL(GHL_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return limited(async () => {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
        Version: "2021-07-28",
        Accept: "application/json",
      },
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 5000));
      return ghlGet(path, params);
    }
    if (!res.ok) throw new Error(`GHL ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  });
}

// One page of conversations, newest activity first. Pass startAfterDate (ms) to get the next page.
export async function listConversationsPage({ startAfterDate } = {}) {
  const data = await ghlGet("/conversations/search", {
    locationId: process.env.GHL_LOCATION_ID,
    limit: 100,
    startAfterDate,
  });
  return data.conversations || [];
}

// Every message in one conversation, paged via lastMessageId. Returns raw GHL message objects.
export async function listAllMessages(conversationId) {
  const all = [];
  let lastMessageId;
  for (let page = 0; page < 20; page++) {
    const data = await ghlGet(`/conversations/${conversationId}/messages`, {
      limit: 100,
      lastMessageId,
    });
    const page = data.messages?.messages || [];
    all.push(...page);
    if (!data.messages?.nextPage || page.length === 0) break;
    lastMessageId = data.messages.lastMessageId;
  }
  return all;
}

// One message by ID, including its body. Email bodies are only returned by this endpoint.
export async function getMessageById(messageId) {
  const data = await ghlGet(`/conversations/messages/${messageId}`);
  return data.message || data;
}

// Every user on the location (the roster name -> GHL user ID lookup).
// /users/search leaves out some active location users (Peter Shaarda and Shelly Melcher both load
// fine by ID), so those are added explicitly by ID.
const EXTRA_USER_IDS = ["MBQ0PWk0hNfytP4eoohE", "u4HBNud6rK0HyezX9l1a"];

export async function listLocationUsers() {
  const data = await ghlGet("/users/search", {
    companyId: process.env.GHL_COMPANY_ID,
    locationId: process.env.GHL_LOCATION_ID,
  });
  const users = data.users || [];
  const seen = new Set(users.map((u) => u.id));
  for (const id of EXTRA_USER_IDS) {
    if (seen.has(id)) continue;
    users.push(await ghlGet(`/users/${id}`));
  }
  return users;
}

// Conversations assigned to one GHL user, newest activity first. Used to find emails a broker
// sent from GHL's own inbox - those are the only emails that carry their signature.
export async function listConversationsForUser(userId, { startAfterDate } = {}) {
  const data = await ghlGet("/conversations/search", {
    locationId: process.env.GHL_LOCATION_ID,
    assignedTo: userId,
    limit: 100,
    startAfterDate,
  });
  return data.conversations || [];
}
