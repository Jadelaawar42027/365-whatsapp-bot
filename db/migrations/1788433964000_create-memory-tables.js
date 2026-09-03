export const shorthands = undefined;

const timestamps = (pgm) => ({
  created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
});

export function up(pgm) {
  // --- contacts_memory: one row per GHL contact, upserted ---
  pgm.createTable("contacts_memory", {
    contact_id: { type: "varchar(64)", primaryKey: true },
    broker_id: { type: "varchar(32)", notNull: true },
    consecutive_missed_followups: { type: "integer", notNull: true, default: 0 },
    last_ai_summary: { type: "text" },
    sentiment_trend: { type: "text" },
    last_contacted_at: { type: "timestamptz" },
    confidence: { type: "text" },
    stale: { type: "boolean", notNull: true, default: false },
    ...timestamps(pgm),
  });
  pgm.createIndex("contacts_memory", "broker_id");

  // --- interaction_log: append-only ---
  pgm.createTable("interaction_log", {
    id: { type: "bigserial", primaryKey: true },
    contact_id: { type: "varchar(64)", notNull: true },
    broker_id: { type: "varchar(32)", notNull: true },
    channel: { type: "text", notNull: true },
    direction: { type: "text", notNull: true },
    summary: { type: "text" },
    raw_ref: { type: "text" },
    extracted_intent: { type: "text" },
    extracted_objection_category: { type: "text" },
    extracted_urgency: { type: "text" },
    ...timestamps(pgm),
  });
  pgm.createIndex("interaction_log", "contact_id");
  pgm.createIndex("interaction_log", "broker_id");

  // --- followup_events: append-only ---
  pgm.createTable("followup_events", {
    id: { type: "bigserial", primaryKey: true },
    contact_id: { type: "varchar(64)", notNull: true },
    broker_id: { type: "varchar(32)", notNull: true },
    scheduled_at: { type: "timestamptz" },
    outcome: { type: "text" },
    flagged_at: { type: "timestamptz" },
    ...timestamps(pgm),
  });
  pgm.createIndex("followup_events", "contact_id");
  pgm.createIndex("followup_events", "broker_id");

  // --- hot_leads: append-only, new row per trigger event ---
  pgm.createTable("hot_leads", {
    id: { type: "bigserial", primaryKey: true },
    contact_id: { type: "varchar(64)", notNull: true },
    broker_id: { type: "varchar(32)", notNull: true },
    hot_since: { type: "timestamptz" },
    trigger_reason: { type: "text" },
    trigger_source: { type: "text" },
    confidence: { type: "text" },
    status: { type: "text", notNull: true, default: "active" },
    last_reviewed_at: { type: "timestamptz" },
    reviewed_by: { type: "text" },
    escalated_to_leadership: { type: "boolean", notNull: true, default: false },
    escalated_at: { type: "timestamptz" },
    ...timestamps(pgm),
  });
  pgm.createIndex("hot_leads", "contact_id");
  pgm.createIndex("hot_leads", "broker_id");

  // --- deal_context_snapshots ---
  pgm.createTable("deal_context_snapshots", {
    id: { type: "bigserial", primaryKey: true },
    contact_id: { type: "varchar(64)", notNull: true },
    broker_id: { type: "varchar(32)", notNull: true },
    snapshot_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    price_discussed: { type: "text" },
    objections: { type: "text[]" },
    competitor_mentions: { type: "text" },
    financing_status: { type: "text" },
    ...timestamps(pgm),
  });
  pgm.createIndex("deal_context_snapshots", "contact_id");
  pgm.createIndex("deal_context_snapshots", "broker_id");

  // --- ai_actions_log: append-only audit trail ---
  pgm.createTable("ai_actions_log", {
    id: { type: "bigserial", primaryKey: true },
    contact_id: { type: "varchar(64)", notNull: true },
    broker_id: { type: "varchar(32)", notNull: true },
    action_type: { type: "text", notNull: true },
    reasoning: { type: "text" },
    auto_executed: { type: "boolean", notNull: true, default: false },
    confirmed_by_human: { type: "boolean", notNull: true, default: false },
    overridden: { type: "boolean", notNull: true, default: false },
    ...timestamps(pgm),
  });
  pgm.createIndex("ai_actions_log", "contact_id");
  pgm.createIndex("ai_actions_log", "broker_id");

  // --- broker_preferences ---
  pgm.createTable("broker_preferences", {
    broker_id: { type: "varchar(32)", primaryKey: true },
    response_style: { type: "text" },
    preferred_cadence: { type: "text" },
    notes: { type: "text" },
    ...timestamps(pgm),
  });

  // --- broker_patterns: leadership-only, populated by scheduled jobs ---
  pgm.createTable("broker_patterns", {
    id: { type: "bigserial", primaryKey: true },
    broker_id: { type: "varchar(32)", notNull: true },
    period_start: { type: "timestamptz", notNull: true },
    period_end: { type: "timestamptz", notNull: true },
    missed_followup_streak_max: { type: "integer" },
    avg_response_time: { type: "interval" },
    notes: { type: "text" },
    ...timestamps(pgm),
  });
  pgm.createIndex("broker_patterns", "broker_id");

  // --- objection_patterns: leadership-level aggregation ---
  pgm.createTable("objection_patterns", {
    id: { type: "bigserial", primaryKey: true },
    period_start: { type: "timestamptz", notNull: true },
    period_end: { type: "timestamptz", notNull: true },
    objection_category: { type: "text", notNull: true },
    count: { type: "integer", notNull: true, default: 0 },
    notes: { type: "text" },
    ...timestamps(pgm),
  });
}

export function down(pgm) {
  pgm.dropTable("objection_patterns");
  pgm.dropTable("broker_patterns");
  pgm.dropTable("broker_preferences");
  pgm.dropTable("ai_actions_log");
  pgm.dropTable("deal_context_snapshots");
  pgm.dropTable("hot_leads");
  pgm.dropTable("followup_events");
  pgm.dropTable("interaction_log");
  pgm.dropTable("contacts_memory");
}
