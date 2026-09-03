-- Run this ONCE against the Railway Postgres instance, connected as the
-- default admin/superuser (the connection string Railway calls DATABASE_URL,
-- reserved for migrations/admin - the bot itself never uses it).
--
-- Safe to re-run: CREATE ROLE is guarded, and the GRANTs/ALTER DEFAULT
-- PRIVILEGES are idempotent. Re-run this after adding new tables via a
-- migration if you ever add a table NOT covered by the default-privileges
-- line below (e.g. a table created before this script last ran).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'aibot_app') THEN
    CREATE ROLE aibot_app WITH LOGIN PASSWORD :'aibot_app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE railway TO aibot_app;
GRANT USAGE ON SCHEMA public TO aibot_app;

-- Existing tables (run after migrations have created them).
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO aibot_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aibot_app;

-- Any table/sequence created by a FUTURE migration (run as this same admin
-- role) is automatically granted the same privileges - no DELETE/DROP/
-- TRUNCATE ever, matching the "soft-delete via status columns only" rule.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO aibot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO aibot_app;

-- Optional hardening: the append-only-in-spirit tables only ever need their
-- status-like columns updated after the initial insert, never the original
-- facts. Column-level UPDATE grants narrow what a bug (or a compromised
-- dependency) could rewrite, on top of the app-code discipline of only ever
-- writing INSERTs to these tables in normal operation.
REVOKE UPDATE ON hot_leads FROM aibot_app;
GRANT UPDATE (status, last_reviewed_at, reviewed_by, escalated_to_leadership, escalated_at, updated_at)
  ON hot_leads TO aibot_app;

REVOKE UPDATE ON followup_events FROM aibot_app;
GRANT UPDATE (outcome, flagged_at, updated_at) ON followup_events TO aibot_app;

REVOKE UPDATE ON interaction_log FROM aibot_app;
REVOKE UPDATE ON ai_actions_log FROM aibot_app;
REVOKE UPDATE ON deal_context_snapshots FROM aibot_app;
