export const shorthands = undefined;

// Drafted follow-up texts awaiting a broker's approval. A draft can only be sent from the
// broker it was created for, and expires so an old draft can't go out later.
export function up(pgm) {
  pgm.createTable("sms_drafts", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    broker_phone: { type: "text", notNull: true },
    contact_id: { type: "text", notNull: true },
    contact_name: { type: "text" },
    options: { type: "jsonb", notNull: true },
    status: { type: "text", notNull: true, default: "pending" },
    chosen_index: { type: "integer" },
    sent_message_id: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    expires_at: { type: "timestamptz", notNull: true },
  });
  pgm.createIndex("sms_drafts", ["contact_id", "created_at"]);
}

export function down(pgm) {
  pgm.dropTable("sms_drafts");
}
