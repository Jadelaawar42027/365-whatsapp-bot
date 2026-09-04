// Fetches the leadership-maintained "Main Leads" tab of the deals sheet, so
// the morning digest can cross-reference GHL's own hot/priority tags (which
// go stale and over-flag) against a human-curated ground truth of which
// leads are genuinely significant. Same "anyone with the link -> Viewer"
// public-export approach as knowledgeBase.js's Google Doc fetch, just CSV
// instead of plain text - the sheet has no live write access anywhere in
// this codebase, only this read.

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes - a full digest run takes well under this, so every person in the same run sees byte-identical reference text (preserves prompt caching)
const MAIN_LEADS_GID = "0"; // the "Main Leads" tab specifically, not the deals-in-progress tab

let cache = null; // { text: string|null, cachedAt: number }

/**
 * Minimal RFC4180 CSV parser - handles quoted fields with embedded commas,
 * newlines, and escaped ("") quotes, which this sheet's Notes column uses
 * heavily. Google's own CSV export doesn't need anything more exotic than this.
 */
function parseCsv(csvText) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
      continue;
    }

    if (char === '"') { inQuotes = true; }
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\r") { /* skip - \n (or end) closes the row */ }
    else if (char === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

async function fetchMainLeadsCsv(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${MAIN_LEADS_GID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch Main Leads sheet: HTTP ${res.status}`);
  return res.text();
}

/**
 * Returns a compact reference block listing every lead on the Main Leads
 * sheet with their Quality rating and current status - the anchor the
 * morning digest cross-checks Hot-lead candidates against. Returns null if
 * GOOGLE_SHEET_MAIN_LEADS_ID isn't configured, or if the fetch fails and
 * there's no prior cached copy to fall back to - callers must treat null as
 * "run without this cross-check" (see digest.js), not an error.
 */
export async function getMainLeadsReference() {
  const now = Date.now();
  if (cache && now - cache.cachedAt < CACHE_TTL_MS) return cache.text;

  const sheetId = process.env.GOOGLE_SHEET_MAIN_LEADS_ID;
  if (!sheetId) {
    console.warn("GOOGLE_SHEET_MAIN_LEADS_ID not set - morning digest will run without the Main Leads cross-check.");
    return null;
  }

  try {
    const csv = await fetchMainLeadsCsv(sheetId);
    const rows = parseCsv(csv);
    const header = rows[0] || [];
    const nameIdx = header.indexOf("Lead Name");
    const qualityIdx = header.indexOf("Quality");
    const statusIdx = header.indexOf("Showing / call Status");

    const lines = rows
      .slice(1)
      .map((r) => ({
        name: (r[nameIdx] || "").trim(),
        quality: (r[qualityIdx] || "").trim(),
        status: (r[statusIdx] || "").trim(),
      }))
      .filter((r) => r.name)
      .map((r) => `- ${r.name}${r.quality ? ` (Quality: ${r.quality})` : ""}${r.status ? ` [${r.status}]` : ""}`);

    const text = lines.length > 0
      ? `MAIN LEADS SHEET (leadership-maintained list of genuinely significant leads):\n${lines.join("\n")}`
      : null;

    cache = { text, cachedAt: now };
    return text;
  } catch (err) {
    console.error("Main Leads sheet fetch failed, digest will run without it:", err.message);
    return cache ? cache.text : null;
  }
}
