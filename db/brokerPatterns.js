import { pool } from "./pool.js";

// Leadership-only aggregation, populated by a scheduled job (not the live
// chat path) - so these functions don't take a per-broker caller scope the
// way the live-chat tables do; gate access to the job/route that calls them
// (leadership-only), not here.

export async function insertBrokerPattern(entry) {
  const { brokerId, periodStart, periodEnd, missedFollowupStreakMax = null, avgResponseTime = null, notes = null } = entry;
  const { rows } = await pool.query(
    `INSERT INTO broker_patterns (broker_id, period_start, period_end, missed_followup_streak_max, avg_response_time, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [brokerId, periodStart, periodEnd, missedFollowupStreakMax, avgResponseTime, notes]
  );
  return rows[0];
}

export async function getBrokerPatterns(brokerId, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    "SELECT * FROM broker_patterns WHERE broker_id = $1 ORDER BY period_start DESC LIMIT $2",
    [brokerId, limit]
  );
  return rows;
}
