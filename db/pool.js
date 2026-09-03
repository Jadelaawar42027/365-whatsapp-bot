import pg from "pg";

const { Pool } = pg;

// Connects as the least-privilege aibot_app role (see sql/setup_aibot_role.sql),
// never the admin/migration role - that one only runs `npm run migrate`.
// Small pool size: Railway's starter Postgres plugin caps total connections
// low, and this is a single always-on service, not a multi-instance fleet.
export const pool = new Pool({
  connectionString: process.env.AIBOT_DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client:", err.message);
});

/**
 * Startup health check - confirms the bot can actually reach Postgres with
 * its scoped role before the server starts accepting traffic silently
 * broken. Logs and returns false rather than throwing, so a DB outage
 * doesn't take down WhatsApp/Slack messaging, which don't depend on it.
 */
export async function checkDbConnection() {
  if (!process.env.AIBOT_DATABASE_URL) {
    console.warn("AIBOT_DATABASE_URL not set - memory layer disabled.");
    return false;
  }
  try {
    await pool.query("SELECT 1");
    console.log("Postgres memory layer connected.");
    return true;
  } catch (err) {
    console.error("Postgres memory layer connection failed:", err.message);
    return false;
  }
}
