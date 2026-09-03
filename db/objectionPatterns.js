import { pool } from "./pool.js";

// Leadership-level aggregation, populated by a scheduled job - see
// brokerPatterns.js for why this doesn't take a per-broker caller scope.

export async function insertObjectionPattern(entry) {
  const { periodStart, periodEnd, objectionCategory, count = 0, notes = null } = entry;
  const { rows } = await pool.query(
    `INSERT INTO objection_patterns (period_start, period_end, objection_category, count, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [periodStart, periodEnd, objectionCategory, count, notes]
  );
  return rows[0];
}

export async function getObjectionPatterns({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    "SELECT * FROM objection_patterns ORDER BY period_start DESC LIMIT $1",
    [limit]
  );
  return rows;
}
