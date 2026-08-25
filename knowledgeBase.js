import { CORE_RULES, FALLBACK_KNOWLEDGE } from "./systemPrompt.js";

// How long to trust a cached copy of the doc before re-fetching. Short enough
// that edits show up quickly; long enough that a burst of WhatsApp messages
// doesn't hammer Google on every single one.
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

// Per-doc cache (keyed by logical doc, not a single global variable) so the
// broker/leadership doc and the setter doc - which may both be fetched in
// quick succession during a mixed-role batch run - don't evict each other.
const docCache = new Map(); // 'broker' | 'setter' -> { text, cachedAt }

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
 * Returns the current text for one logical knowledge base doc (broker or
 * setter), cached independently under cacheKey. Falls back to
 * FALLBACK_KNOWLEDGE if docId isn't configured, or to the last good cached
 * copy (then FALLBACK_KNOWLEDGE) if the fetch fails, so the bot never goes
 * fully blind. Never falls back to a DIFFERENT doc - a missing setter doc
 * must not silently serve the broker doc, which can contain broker-only
 * content (commission structures, negotiation strategy).
 */
async function getDocText(cacheKey, docId, missingWarning) {
  const now = Date.now();
  const cached = docCache.get(cacheKey);

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.text;
  }

  if (!docId) {
    console.warn(missingWarning);
    docCache.set(cacheKey, { text: FALLBACK_KNOWLEDGE, cachedAt: now });
    return FALLBACK_KNOWLEDGE;
  }

  try {
    const text = (await fetchGoogleDocText(docId)).trim();
    docCache.set(cacheKey, { text, cachedAt: now });
    return text;
  } catch (err) {
    console.error(`Knowledge base fetch failed for "${cacheKey}" doc, using last good copy or fallback:`, err.message);
    if (cached) return cached.text;
    docCache.set(cacheKey, { text: FALLBACK_KNOWLEDGE, cachedAt: now });
    return FALLBACK_KNOWLEDGE;
  }
}

/**
 * Returns the current knowledge base text (SOPs, objection handling,
 * escalation rules, etc.) — the part Aj edits directly in Google Docs.
 * Used for broker and leadership roles.
 */
async function getKnowledgeBaseText() {
  return getDocText(
    "broker",
    process.env.GOOGLE_DOC_KNOWLEDGE_ID,
    "GOOGLE_DOC_KNOWLEDGE_ID not set — using fallback knowledge base."
  );
}

/**
 * Returns the setter-specific knowledge base text (outbound
 * qualification/booking SOPs), from a separate Google Doc than the
 * broker/leadership one.
 */
async function getSetterKnowledgeBaseText() {
  return getDocText(
    "setter",
    process.env.GOOGLE_DOC_SETTER_KNOWLEDGE_ID,
    "GOOGLE_DOC_SETTER_KNOWLEDGE_ID not set — using fallback knowledge base for setters."
  );
}

/**
 * Builds the full system prompt: fixed core rules (never change without a
 * code edit) + the live, editable knowledge base (Aj's Google Doc). Setters
 * get their own separate doc; every other role (broker/leadership) gets the
 * existing shared doc, unchanged from prior behavior.
 * @param {string} [role] - the CURRENT USER's role, e.g. 'broker', 'leadership', 'setter'
 */
export async function getSystemPrompt(role) {
  const knowledge = role === "setter"
    ? await getSetterKnowledgeBaseText()
    : await getKnowledgeBaseText();
  return `${CORE_RULES}\n\n---\n\nKNOWLEDGE BASE (editable by Aj — SOPs, scripts, policies):\n\n${knowledge}`;
}

/**
 * Forces the next call to re-fetch instead of using the cache. Not currently
 * wired to anything, but handy if you add a "refresh now" admin command later.
 */
export function invalidateCache() {
  docCache.clear();
}