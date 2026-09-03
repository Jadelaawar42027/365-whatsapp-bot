// Maps a sender's WhatsApp phone number (as GHL/Meta send it - digits only,
// no "+", e.g. "34645496611") to their identity for permission purposes.
// Each entry can ALSO carry an optional "slack" field (that person's Slack
// user ID, e.g. "U0123ABC456" - find it via their Slack profile "Copy
// member ID") so the same identity is reachable from either channel. The
// WhatsApp phone number is still each entry's object key/primary identity;
// "slack" is just an extra lookup field on top of the same { name, role }.
//
// role: 'leadership' -> full access to all contacts/deals/broker data.
//       'broker'     -> restricted to only their own assigned contacts/deals.
//       'setter'     -> broad READ access like leadership (can view any contact,
//                        not just their own), but WRITE actions (tasks, notes,
//                        priority, stage, reassignment) stay restricted to their
//                        own assigned contacts, like a broker. Also gets a
//                        separate setter-specific knowledge base doc instead of
//                        the broker/leadership one (see knowledgeBase.js).
//
// No GHL user ID needed here - the GHL MCP server resolves it dynamically
// from the "name" below by matching against GHL's own user list. Just make
// sure "name" here matches the person's name in GHL exactly (case doesn't
// matter, but spelling does).
//
// HOW TO ADD SOMEONE: add a new entry below with their WhatsApp number
// (digits only) as the key, their name, and their role. Restart the bot to apply.

export const BROKER_ROSTER = {
  // --- Leadership: full access to everything ---
  '34645496611': { name: 'Aj El Aawar', role: 'leadership', slack: 'U046DS14XJA' },
  '15614459241': { name: 'Shelly Melcher', role: 'leadership' },
  '12244278061': { name: 'Max Sereda', role: 'leadership' },

  // --- Brokers: restricted to their own contacts/deals only ---
  '17725384547': { name: 'Nicolette Cervone', role: 'broker' },
  '16159483641': { name: 'Charlie Seitz', role: 'broker' },
  '17152203264': { name: 'James Klier', role: 'broker' },
  '17542074504': { name: 'Cheryl Hazel', role: 'broker' },
  '17812582070': { name: 'Martin Herbert-Burns', role: 'broker' },
  '19788268166': { name: 'Joseph Graffeo', role: 'broker' },
  '12394041441': { name: 'Peter Shaarda', role: 'broker' },

  // --- Setters: outbound qualification/booking, own separate knowledge base ---
  '48697713899': { name: 'Karim El Timani', role: 'leadership', slack: 'U05HD0984TU' },
};

/**
 * Looks up the identity for a given WhatsApp sender phone number.
 * Returns null if the number isn't in the roster (unregistered).
 */
export function getIdentityForPhone(phone) {
  return BROKER_ROSTER[phone] || null;
}

/**
 * Looks up the identity for a given Slack user ID (e.g. "U0123ABC456").
 * Mirrors getIdentityForPhone, but scans entries' "slack" field since the
 * roster is keyed by WhatsApp phone number, not Slack ID. Returns null if
 * no entry has a matching "slack" field (unregistered on Slack).
 */
export function getIdentityForSlackUser(slackUserId) {
  const match = Object.entries(BROKER_ROSTER).find(([, identity]) => identity.slack === slackUserId);
  if (!match) return null;
  const [phone, identity] = match;
  return { phone, ...identity };
}

/**
 * Reverse lookup: finds a roster entry (with phone) by name, case-insensitive.
 * Used for GHL-triggered flows (e.g. a call-review webhook) where GHL gives
 * us the assigned broker's name but not their phone number directly.
 * Returns null if no match, or if the name matches more than one entry
 * (fails closed rather than guessing which person to message).
 */
export function getIdentityByName(name) {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const matches = Object.entries(BROKER_ROSTER).filter(
    ([, identity]) => identity.name.trim().toLowerCase().replace(/\s+/g, ' ') === normalized
  );
  if (matches.length !== 1) return null;
  const [phone, identity] = matches[0];
  return { phone, ...identity };
}

/**
 * Returns every roster entry with role 'leadership' - used for team-wide
 * reports (hot buyers/alerts digest, broker performance review) that should
 * go to leadership only, never to individual brokers.
 */
export function getLeadershipEntries() {
  return Object.entries(BROKER_ROSTER)
    .filter(([, identity]) => identity.role === "leadership")
    .map(([phone, identity]) => ({ phone, ...identity }));
}
