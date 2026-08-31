import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Signs a short-lived identity token for the given roster entry: just name
 * and role. The GHL MCP server verifies this signature (same JWT_SECRET on
 * both sides) and, for brokers/setters, dynamically resolves their GHL user
 * ID from the name - so this bot never needs to know or carry a GHL ID at
 * all. Short expiry limits how long a captured token would be usable -
 * default 5 min is fine for a typical turn, but the GHL MCP server runs
 * stateless (a fresh request re-verifying this SAME token on every
 * individual tool call, not just once per turn), so a turn that legitimately
 * runs longer than the expiry - many tool calls across a large batch, e.g.
 * leadership's higher max_tokens paths - needs a longer-lived token passed
 * explicitly, or later tool calls in that same turn get silently rejected
 * with "invalid or expired token" once the clock runs out mid-turn.
 * @param {{name: string, role: string}} identity
 * @param {number} [ttlMinutes] - token lifetime in minutes, defaults to 5
 */
export function mintIdentityToken(identity, ttlMinutes = 5) {
  if (!JWT_SECRET) {
    throw new Error('Missing JWT_SECRET in .env - required to mint identity tokens for the GHL MCP server.');
  }
  return jwt.sign(
    { name: identity.name, role: identity.role },
    JWT_SECRET,
    { expiresIn: `${ttlMinutes}m` }
  );
}
