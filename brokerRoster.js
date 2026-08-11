// Maps a sender's WhatsApp phone number (as GHL/Meta send it - digits only,
// no "+", e.g. "34645496611") to their identity for permission purposes.
//
// role: 'leadership' -> full access to all contacts/deals/broker data.
//       'broker'     -> restricted to only their own assigned contacts/deals.
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

'34645496611': { name: 'Nicolette Cervone', role: 'leadership' },
// '15614459241': { name: 'Shelly', role: 'leadership' },
// '12244278061': { name: 'Nicolette Cervone', role: 'leadership' },

// --- Brokers: restricted to their own contacts/deals only ---
// '1XXXXXXXXXX': { name: 'Broker Name (must match GHL exactly)', role: 'broker' },
'17725384547': { name: 'Nicolette Cervone', role: 'broker' },
'16159483641': { name: 'Charlie Seitz', role: 'broker' },
'17152203264': { name: 'James Klier', role: 'broker' },
'17542074504': { name: 'Cheryl Hazel', role: 'broker' },
};

/**
 * Looks up the identity for a given WhatsApp sender phone number.
 * Returns null if the number isn't in the roster (unregistered).
 */
export function getIdentityForPhone(phone) {
  return BROKER_ROSTER[phone] || null;
}

/**
 * Reverse lookup: finds a roster entry (with phone) by name, case-insensitive.
 * Used for GHL-triggered flows (e.g. a call-review webhook) where GHL gives
 * us the assigned broker's name but not their phone number directly.
 * Returns null if no match, or if the name matches more than one entry
 * (fails closed rather than guessing which person to message).
 */
export function getIdentityByName(name) {
  const normalized = name.trim().toLowerCase();
  const matches = Object.entries(BROKER_ROSTER).filter(
    ([, identity]) => identity.name.trim().toLowerCase() === normalized
  );
  if (matches.length !== 1) return null;
  const [phone, identity] = matches[0];
  return { phone, ...identity };
}
