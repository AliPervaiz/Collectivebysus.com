/* Backups and "download everything".
 *
 *   dumpAll(env)       every table → { format, made_at, site, tables: { name: rows[] } }
 *   runBackup(env)     gzip that dump into R2 at backups/YYYY-MM-DD.json.gz, keep the newest KEEP
 *   listBackups(env)   newest first
 *   zipFiles(files)    [{ name, data: string|Uint8Array }] → Uint8Array (stored ZIP, no compression)
 *
 * Restore with scripts/restore-backup.mjs (turns a backup into SQL for `wrangler d1 execute`).
 * Backup keys live under backups/, which no public route can serve: images are only ever
 * read through photoKey() (galleries/<id>/<id>/<size>.jpg). */

import { BRAND } from "./brand.js";

export const BACKUP_PREFIX = "backups/";
export const KEEP = 26; // about six months of weekly copies
const SKIP_TABLES = new Set(["rate_limits", "d1_migrations"]); // throwaway / managed by wrangler

const enc = new TextEncoder();

export async function tableNames(env) {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
  ).all();
  return results.map((r) => r.name).filter((n) => !SKIP_TABLES.has(n));
}

export async function dumpAll(env) {
  const names = await tableNames(env);
  const tables = {};
  for (const name of names) {
    // Names come from sqlite_master, not from the request; quote them anyway.
    const { results } = await env.DB.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
    tables[name] = results;
  }
  return { format: "studio-backup-1", made_at: new Date().toISOString(), site: BRAND.fileSlug, tables };
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function runBackup(env, { reason = "weekly" } = {}) {
  const dump = await dumpAll(env);
  const day = dump.made_at.slice(0, 10);
  const key = `${BACKUP_PREFIX}${day}.json.gz`;
  const body = await gzip(JSON.stringify(dump));
  const rows = Object.values(dump.tables).reduce((a, t) => a + t.length, 0);
  await env.PHOTOS.put(key, body, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { reason, rows: String(rows), made_at: dump.made_at },
  });
  const pruned = await prune(env);
  return { key, name: key.slice(BACKUP_PREFIX.length), size: body.length, rows, pruned };
}

export async function listBackups(env) {
  const out = [];
  let cursor;
  do {
    const list = await env.PHOTOS.list({ prefix: BACKUP_PREFIX, cursor, include: ["customMetadata"] });
    for (const o of list.objects) {
      out.push({
        name: o.key.slice(BACKUP_PREFIX.length), size: o.size, uploaded: o.uploaded?.toISOString?.() || null,
        rows: o.customMetadata?.rows ? Number(o.customMetadata.rows) : null, reason: o.customMetadata?.reason || null,
      });
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

async function prune(env) {
  const all = await listBackups(env);
  const old = all.slice(KEEP).map((b) => BACKUP_PREFIX + b.name);
  if (old.length) await env.PHOTOS.delete(old);
  return old.length;
}

/** Only names we write ourselves: 2026-11-18.json.gz */
export function backupKey(name) {
  return /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(name || "") ? BACKUP_PREFIX + name : null;
}

/* ---------- minimal ZIP writer (method 0 = stored) ---------- */

let CRC_TABLE;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function zipFiles(files, when = new Date()) {
  const { time, date } = dosTime(when);
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, time, true); cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let pos = 0;
  for (const p of all) { out.set(p, pos); pos += p.length; }
  return out;
}
