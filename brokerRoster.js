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
  '34645496611': { name: 'Aj El Aawar', role: 'leadership' },
  // '15614459241': { name: 'Shelly', role: 'leadership' },
  '12244278061': { name: 'Max Sereda', role: 'leadership' },

  // --- Brokers: restricted to their own contacts/deals only ---
  // '1XXXXXXXXXX': { name: 'Broker Name (must match GHL exactly)', role: 'broker' },
};

/**
 * Looks up the identity for a given WhatsApp sender phone number.
 * Returns null if the number isn't in the roster (unregistered).
 */
export function getIdentityForPhone(phone) {
  return BROKER_ROSTER[phone] || null;
}
