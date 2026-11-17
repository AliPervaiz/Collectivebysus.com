/* CSV export helpers (RFC 4180, CRLF, UTF-8 BOM, formula-injection safe). */

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const RISKY_START = /^[=+\-@\t\r]/;

function cell(v) {
  if (v == null) return "";
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  // A cell Excel/Sheets could read as a formula gets a leading apostrophe.
  // Plain numbers (including negatives like -5.00) cannot be formulas, so leave them.
  if (typeof v !== "number" && RISKY_START.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** headers: string[], rows: any[][] -> CSV text with a UTF-8 BOM. */
export function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(",")];
  for (const row of rows) lines.push(row.map(cell).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export function csvResponse(filename, csv) {
  const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${safe}"`,
      "cache-control": "no-store",
    },
  });
}
