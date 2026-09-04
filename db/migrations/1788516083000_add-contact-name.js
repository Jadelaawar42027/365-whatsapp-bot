export const shorthands = undefined;

// contacts_memory only ever stored the raw GHL contact_id - fine for lookups, but the morning
// digest needs a human-readable name to show leadership/brokers without an extra GHL API call
// per stale-followup escalation.
export function up(pgm) {
  pgm.addColumn("contacts_memory", {
    contact_name: { type: "text" },
  });
}

export function down(pgm) {
  pgm.dropColumn("contacts_memory", "contact_name");
}
