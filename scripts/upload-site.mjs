#!/usr/bin/env node
/* Upload a studio's website (a folder of HTML/CSS/images) to its storage folder.
 *
 *   node scripts/upload-site.mjs <studio handle> <folder> [--local | --remote] [--dry-run]
 *   node scripts/upload-site.mjs fieldnote sites/fieldnote --local
 *
 * Files go to R2 at studios/<studio-id>/site/<path>. A list of what was uploaded is kept at
 * studios/<studio-id>/site-manifest.json (outside the public site), so files you delete from the folder
 * are deleted from storage on the next upload. Unchanged files are skipped (compared by size + SHA-1).
 * Skipped: dotfiles, *.md, node_modules/, .git/, and anything listed with --exclude <dir-or-file>.
 * Platform files (/js/inquiry.js etc.) always come from the platform, so a site's own copies are ignored.
 * Default is --local. --remote talks to the real Cloudflare account. */

import { readdirSync, statSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const BUCKET = "lippoluppy-files";
const DB = "lippoluppy";
const PLATFORM = new Set(["js/gallery.js", "js/inquiry.js", "js/visit.js", "js/signin.js", "js/site-config.js",
  "css/gallery.css", "css/inquiry.css", "css/platform.css", "gallery.html", "signin.html"]);
const TYPES = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  json: "application/json", txt: "text/plain; charset=utf-8", xml: "application/xml", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", gif: "image/gif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", webmanifest: "application/manifest+json", pdf: "application/pdf" };

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i >= 0) { args.splice(i, 1); return true; } return false; };
const excludes = [];
for (let i = args.indexOf("--exclude"); i >= 0; i = args.indexOf("--exclude")) { excludes.push(args[i + 1].replace(/\/$/, "")); args.splice(i, 2); }
const remote = flag("--remote"); flag("--local");
const dry = flag("--dry-run");
const [handle, folder] = args;
if (!handle || !folder) {
  console.error("usage: node scripts/upload-site.mjs <studio handle> <folder> [--local|--remote] [--dry-run] [--exclude path]");
  process.exit(1);
}
const where = remote ? "--remote" : "--local";
const wrangler = (a, opts = {}) => execFileSync("npx", ["wrangler", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

// Studio id from its handle.
const q = JSON.parse(wrangler(["d1", "execute", DB, where, "--json", "--command",
  `SELECT id FROM studios WHERE handle = '${handle.replace(/[^a-z0-9-]/g, "")}'`]));
const studioId = q[0]?.results?.[0]?.id;
if (!studioId) { console.error(`No studio with handle "${handle}" (${where}).`); process.exit(1); }
const prefix = `studios/${studioId}/site/`;
const manifestKey = `studios/${studioId}/site-manifest.json`;

// Walk the folder.
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(folder, full).split(sep).join("/");
    if (name.startsWith(".") || name === "node_modules" || name.endsWith(".md")) continue;
    if (excludes.some((x) => rel === x || rel.startsWith(x + "/"))) continue;
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (PLATFORM.has(rel)) continue;
    const data = readFileSync(full);
    files.push({ rel, full, size: data.length, sha1: createHash("sha1").update(data).digest("hex") });
  }
})(folder);
if (!files.some((f) => f.rel === "index.html")) { console.error(`${folder} has no index.html.`); process.exit(1); }

// Previous upload, to skip unchanged files and delete removed ones.
let previous = {};
try {
  const tmp = mkdtempSync(join(tmpdir(), "site-"));
  wrangler(["r2", "object", "get", `${BUCKET}/${manifestKey}`, where, "--file", join(tmp, "m.json")]);
  previous = JSON.parse(readFileSync(join(tmp, "m.json"), "utf8")).files || {};
} catch { /* first upload */ }

const now = {};
let put = 0, same = 0, gone = 0;
for (const f of files) {
  now[f.rel] = { size: f.size, sha1: f.sha1 };
  const p = previous[f.rel];
  if (p && p.sha1 === f.sha1 && p.size === f.size) { same += 1; continue; }
  const type = TYPES[f.rel.split(".").pop().toLowerCase()] || "application/octet-stream";
  console.log(`  put  ${f.rel}`);
  if (!dry) wrangler(["r2", "object", "put", `${BUCKET}/${prefix}${f.rel}`, where, "--file", f.full, "--content-type", type]);
  put += 1;
}
for (const rel of Object.keys(previous)) {
  if (now[rel]) continue;
  console.log(`  del  ${rel}`);
  if (!dry) wrangler(["r2", "object", "delete", `${BUCKET}/${prefix}${rel}`, where]);
  gone += 1;
}
if (!dry) {
  const tmp = mkdtempSync(join(tmpdir(), "site-"));
  writeFileSync(join(tmp, "m.json"), JSON.stringify({ studio: studioId, uploaded_at: new Date().toISOString(), files: now }));
  wrangler(["r2", "object", "put", `${BUCKET}/${manifestKey}`, where, "--file", join(tmp, "m.json"), "--content-type", "application/json"]);
}
console.log(`${handle} (${studioId}, ${remote ? "REMOTE" : "local"}): ${put} uploaded, ${same} unchanged, ${gone} removed${dry ? " (dry run)" : ""}.`);
