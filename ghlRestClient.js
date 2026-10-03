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
  for (;;) {
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
