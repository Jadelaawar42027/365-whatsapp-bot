export const shorthands = undefined;

// One row per broker. signature_html is the signature pulled from a real email they sent from
// GHL. no_signature is set once a broker has been searched and nothing usable was found, so
// later runs skip them instead of searching again.
export function up(pgm) {
  pgm.createTable("broker_signatures", {
    broker_user_id: { type: "text", primaryKey: true },
    broker_name: { type: "text", notNull: true },
    signature_html: { type: "text" },
    no_signature: { type: "boolean", notNull: true, default: false },
    source_message_id: { type: "text" },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
}

export function down(pgm) {
  pgm.dropTable("broker_signatures");
}
