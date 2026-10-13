export const shorthands = undefined;

// One row per contact ever confirmed hot for a broker's daily digest - separate from the
// existing chat-memory hot_leads table (db/hotLeads.js, an append-only log of hot-signal events
// detected during live chat). This one tracks sticky digest membership: once added, a lead
// stays 'active' (and therefore mandatory in every digest) regardless of whether GHL's hot
// checkbox gets toggled later - only removed when the deal's outcome is Sale Closed/Lost
// (deterministic, checked every run) or the model explicitly requests removal with a stated
// reason.
export function up(pgm) {
  pgm.createTable("digest_hot_leads", {
    contact_id: { type: "text", primaryKey: true },
    broker_phone: { type: "text", notNull: true },
    lead_name: { type: "text" },
    status: { type: "text", notNull: true, default: "active" },
    first_flagged_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    last_confirmed_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    removed_reason: { type: "text" },
    removed_at: { type: "timestamptz" },
  });
  pgm.createIndex("digest_hot_leads", ["broker_phone", "status"]);
}

export function down(pgm) {
  pgm.dropTable("digest_hot_leads");
}
