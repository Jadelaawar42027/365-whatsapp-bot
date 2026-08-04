import { CORE_RULES, FALLBACK_KNOWLEDGE } from "./systemPrompt.js";

// How long to trust a cached copy of the doc before re-fetching. Short enough
// that edits show up quickly; long enough that a burst of WhatsApp messages
// doesn't hammer Google on every single one.
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

let cachedKnowledge = null;
let cachedAt = 0;

/**
 * Fetches the plain-text export of a Google Doc. The doc must be shared as
 * "Anyone with the link -> Viewer" for this to work without OAuth credentials.
 */
async function fetchGoogleDocText(docId) {
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to fetch knowledge base doc: HTTP ${res.status}`);
  }

  return res.text();
}

/**
 * Returns the current knowledge base text (SOPs, objection handling,
 * escalation rules, etc.) — the part Aj edits directly in Google Docs.
 * Cached briefly; falls back to a hardcoded default if the doc is
 * unreachable so the bot never goes fully blind.
 */
async function getKnowledgeBaseText() {
  const now = Date.now();

  if (cachedKnowledge !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedKnowledge;
  }

  const docId = process.env.GOOGLE_DOC_KNOWLEDGE_ID;

  if (!docId) {
    console.warn("GOOGLE_DOC_KNOWLEDGE_ID not set — using fallback knowledge base.");
    cachedKnowledge = FALLBACK_KNOWLEDGE;
    cachedAt = now;
    return cachedKnowledge;
  }

  try {
    const text = await fetchGoogleDocText(docId);
    cachedKnowledge = text.trim();
    cachedAt = now;
    return cachedKnowledge;
  } catch (err) {
    console.error("Knowledge base fetch failed, using last good copy or fallback:", err.message);
    if (cachedKnowledge !== null) return cachedKnowledge;
    cachedKnowledge = FALLBACK_KNOWLEDGE;
    cachedAt = now;
    return cachedKnowledge;
  }
}

/**
 * Builds the full system prompt: fixed core rules (never change without a
 * code edit) + the live, editable knowledge base (Aj's Google Doc).
 */
export async function getSystemPrompt() {
  const knowledge = await getKnowledgeBaseText();
  return `${CORE_RULES}\n\n---\n\nKNOWLEDGE BASE (editable by Aj — SOPs, scripts, policies):\n\n${knowledge}`;
}

/**
 * Forces the next call to re-fetch instead of using the cache. Not currently
 * wired to anything, but handy if you add a "refresh now" admin command later.
 */
export function invalidateCache() {
  cachedKnowledge = null;
  cachedAt = 0;
}