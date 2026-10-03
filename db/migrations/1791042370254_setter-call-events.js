export const shorthands = undefined;

// One row per outbound call message, keyed by GHL message ID so the backfill and the daily
// sync can both re-run without double-counting. Daily dial/unique-contact numbers are computed
// from these rows rather than stored as counters.
export function up(pgm) {
  pgm.createTable("setter_call_events", {
    message_id: { type: "text", primaryKey: true },
    conversation_id: { type: "text", notNull: true },
    contact_id: { type: "text" },
    setter_user_id: { type: "text", notNull: true },
    call_day: { type: "date", notNull: true },
    status: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("setter_call_events", ["call_day", "setter_user_id"]);

  pgm.createTable("setter_activity_sync_state", {
    key: { type: "text", primaryKey: true },
    value: { type: "text", notNull: true },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
}

export function down(pgm) {
  pgm.dropTable("setter_activity_sync_state");
  pgm.dropTable("setter_call_events");
}
