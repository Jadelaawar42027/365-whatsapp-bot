import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Signs a short-lived identity token for the given roster entry: just name
 * and role. The GHL MCP server verifies this signature (same JWT_SECRET on
 * both sides) and, for brokers, dynamically resolves their GHL user ID from
 * the name - so this bot never needs to know or carry a GHL ID at all.
 * Short expiry (5 min) limits how long a captured token would be usable.
 */
export function mintIdentityToken(identity) {
  if (!JWT_SECRET) {
    throw new Error('Missing JWT_SECRET in .env - required to mint identity tokens for the GHL MCP server.');
  }
  return jwt.sign(
    { name: identity.name, role: identity.role },
    JWT_SECRET,
    { expiresIn: '5m' }
  );
}
