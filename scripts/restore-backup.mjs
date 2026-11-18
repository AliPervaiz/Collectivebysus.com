#!/usr/bin/env node
/* Turn a backup into SQL that replaces the database contents.
 *
 *   node scripts/restore-backup.mjs <backup.json.gz | complete-backup.json> > restore.sql
 *   npx wrangler d1 execute <database-name> --remote --file restore.sql      (real site)
 *   npx wrangler d1 execute <database-name> --local  --file restore.sql      (try it locally first)
 *
 * Backups come from Admin → Settings → Backups (weekly .json.gz) or from
 * "Download everything" (complete-backup.json inside the ZIP).
 *
 * Every table in the backup is emptied and refilled. Tables not in the backup are left alone.
 * Run migrations first if the backup is newer than the database (columns must exist).
 * For "go back to an earlier minute in the last 30 days", D1 Time Travel is simpler:
 *   npx wrangler d1 time-travel restore <database-name> --timestamp <ISO time>
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/restore-backup.mjs <backup.json.gz | complete-backup.json> > restore.sql");
  process.exit(1);
}
let raw = readFileSync(file);
if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
const dump = JSON.parse(raw.toString("utf8"));
if (dump.format !== "studio-backup-1" || !dump.tables) {
  console.error("Not a studio backup (expected format studio-backup-1).");
  process.exit(1);
}

const ident = (n) => `"${String(n).replace(/"/g, '""')}"`;
function lit(v) {
  if (v == null) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

const out = [
  `-- Restore of ${dump.site || "site"} backup made ${dump.made_at}`,
  "PRAGMA defer_foreign_keys = on;",
];
const names = Object.keys(dump.tables);
for (const name of names) out.push(`DELETE FROM ${ident(name)};`);
let total = 0;
for (const name of names) {
  for (const row of dump.tables[name]) {
    const cols = Object.keys(row);
    out.push(`INSERT INTO ${ident(name)} (${cols.map(ident).join(", ")}) VALUES (${cols.map((c) => lit(row[c])).join(", ")});`);
    total += 1;
  }
}
process.stdout.write(out.join("\n") + "\n");
console.error(`${names.length} tables, ${total} rows → SQL written. Review it, then run it with wrangler d1 execute --file.`);
