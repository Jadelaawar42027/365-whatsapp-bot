// Fetches the leadership-maintained "Main Leads" tab of the deals sheet, so
// the morning digest can cross-reference GHL's own hot/priority tags (which
// go stale and over-flag) against a human-curated ground truth of which
// leads are genuinely significant. Same "anyone with the link -> Viewer"
// public-export approach as knowledgeBase.js's Google Doc fetch, just CSV
// instead of plain text - the sheet has no live write access anywhere in
// this codebase, only this read.

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes - a full digest run takes well under this, so every person in the same run sees byte-identical reference text (preserves prompt caching)
const MAIN_LEADS_GID = "0"; // the "Main Leads" tab specifically, not the deals-in-progress tab
const BUYER_LEADS_GID = "1077947976"; // the "Buyer Leads" tab - same spreadsheet, deal-progress notes

let cache = null; // { text: string|null, cachedAt: number }
let buyerLeadsCache = null; // { text: string|null, cachedAt: number }

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

async function fetchSheetCsv(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch sheet (gid ${gid}): HTTP ${res.status}`);
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
    const csv = await fetchSheetCsv(sheetId, MAIN_LEADS_GID);
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

const CURRENT_UPDATE_MAX_CHARS = 350;

/**
 * Returns a compact reference block from the "Buyer Leads" tab (same spreadsheet as Main
 * Leads, different tab) - a leadership/setter-maintained log of active deal progress, with a
 * real narrative "Current Update" per lead (e.g. a setter's call summary, a broker's note about
 * an offer). This is a CANDIDATE list, not a verdict: it can list leads that have since gone
 * cold (someone said they're waiting a few months) and can miss ones that just went hot (a
 * fresh reply the digest's own live scan would catch on its own) - the digest must still verify
 * each one against real current notes/messages before treating it as hot, same as any other
 * candidate. Deliberately excludes "Last Follow Up Date" - per Aj, that column isn't a reliable
 * recency signal, he updates it manually and not in sync with actual last contact. Returns null
 * if GOOGLE_SHEET_MAIN_LEADS_ID isn't configured or the tab has no rows.
 */
export async function getBuyerLeadsReference() {
  const now = Date.now();
  if (buyerLeadsCache && now - buyerLeadsCache.cachedAt < CACHE_TTL_MS) return buyerLeadsCache.text;

  const sheetId = process.env.GOOGLE_SHEET_MAIN_LEADS_ID;
  if (!sheetId) {
    console.warn("GOOGLE_SHEET_MAIN_LEADS_ID not set - morning digest will run without the Buyer Leads cross-check.");
    return null;
  }

  try {
    const csv = await fetchSheetCsv(sheetId, BUYER_LEADS_GID);
    const rows = parseCsv(csv);
    const header = (rows[0] || []).map((h) => h.trim());
    const idx = {
      name: header.indexOf("Lead"),
      update: header.indexOf("Current Update"),
      broker: header.indexOf("Broker"),
      price: header.indexOf("Price"),
      buyersAgreement: header.indexOf("Buyers Agreement Signed"),
      proofOfFunds: header.indexOf("Proof of Funs / BG Check"),
      blockers: header.indexOf("Blockers"),
      nextSteps: header.indexOf("Next Steps"),
      depositDate: header.indexOf("Deposit Dates"),
      closingDate: header.indexOf("Closing Dates"),
    };

    const clean = (s) => (s || "").trim().replace(/\s+/g, " ");

    const lines = rows
      .slice(1)
      .map((r) => {
        const name = clean(r[idx.name]);
        let update = clean(r[idx.update]);
        if (update.length > CURRENT_UPDATE_MAX_CHARS) update = `${update.slice(0, CURRENT_UPDATE_MAX_CHARS)}...`;
        const parts = [
          r[idx.broker] ? `Broker: ${clean(r[idx.broker])}` : null,
          r[idx.price] ? `Price: ${clean(r[idx.price])}` : null,
          clean(r[idx.buyersAgreement]) === "Y" ? "Buyer's Agreement signed" : null,
          clean(r[idx.proofOfFunds]) === "Y" ? "Proof of funds on file" : null,
          r[idx.depositDate] ? `Deposit date: ${clean(r[idx.depositDate])}` : null,
          r[idx.closingDate] ? `Closing date: ${clean(r[idx.closingDate])}` : null,
          r[idx.blockers] ? `Blockers: ${clean(r[idx.blockers])}` : null,
          r[idx.nextSteps] ? `Next steps: ${clean(r[idx.nextSteps])}` : null,
        ].filter(Boolean);
        return { name, update, meta: parts.join(" | ") };
      })
      .filter((r) => r.name)
      .map((r) => `- ${r.name}${r.meta ? ` (${r.meta})` : ""}${r.update ? `\n  Update: ${r.update}` : ""}`);

    const text = lines.length > 0
      ? `BUYER LEADS SHEET (leadership/setter-maintained deal-progress notes - a CANDIDATE list only, ` +
        `verify each one against real current notes/messages before treating as hot; a lead here can have ` +
        `already gone cold since this was last updated, or a lead not here can have just gone hot from a ` +
        `fresh reply - don't trust this sheet's recency, only its content):\n${lines.join("\n")}`
      : null;

    buyerLeadsCache = { text, cachedAt: now };
    return text;
  } catch (err) {
    console.error("Buyer Leads sheet fetch failed, digest will run without it:", err.message);
    return buyerLeadsCache ? buyerLeadsCache.text : null;
  }
}
