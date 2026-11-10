/**
 * Collective by Sus — site worker
 *
 * Serves the static site, plus:
 *   /admin, /admin/*      Gallery manager (protected by Cloudflare Access)
 *   /api/admin/*          Admin JSON API (protected by Cloudflare Access)
 *   /g/:slug              Private client gallery page
 *   /api/g/:slug/*        Client gallery JSON API + images
 *
 * Bindings (see wrangler.jsonc):
 *   ASSETS   static assets
 *   DB       D1 database (migrations/)
 *   PHOTOS   R2 bucket holding resized images
 *   NOTIFY   optional send_email binding for "client submitted" emails
 *
 * Vars / secrets:
 *   ACCESS_TEAM_DOMAIN  e.g. "collectivebysus.cloudflareaccess.com"
 *   ACCESS_AUD          Application Audience (AUD) tag from the Access app
 *   ADMIN_EMAILS        optional comma-separated allowlist (defense in depth)
 *   SESSION_SECRET      secret used to sign gallery PIN cookies
 *   NOTIFY_FROM / NOTIFY_TO   addresses for submission emails (optional)
 *   DEV_ADMIN_BYPASS    "true" in .dev.vars only, skips Access on localhost
 */

import { EmailMessage } from "cloudflare:email";

const MAX_FULL_BYTES = 30 * 1024 * 1024;
const MAX_THUMB_BYTES = 5 * 1024 * 1024;
const PIN_MAX_FAILURES = 8;
const PIN_LOCK_MINUTES = 15;
const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l confusion

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/admin" || path.startsWith("/admin/")) {
        if (!(await requireAdmin(request, env, url))) return forbidden();
        const res = await env.ASSETS.fetch(request);
        return withHeaders(res, { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
      }

      if (path.startsWith("/api/admin/")) {
        if (!(await requireAdmin(request, env, url))) return json({ error: "Not authorized" }, 403);
        if (isMutation(request) && !hasFetchHeader(request)) return json({ error: "Bad request" }, 400);
        return await handleAdmin(request, env, url);
      }

      if (path.startsWith("/api/g/")) {
        if (isMutation(request) && !hasFetchHeader(request)) return json({ error: "Bad request" }, 400);
        return await handleClient(request, env, url, ctx);
      }

      if (/^\/g\/[a-z0-9]+\/?$/.test(path)) {
        const res = await env.ASSETS.fetch(new Request(new URL("/gallery", url), request));
        return withHeaders(res, {
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
          "referrer-policy": "same-origin",
        });
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Admin API                                                           */
/* ------------------------------------------------------------------ */

async function handleAdmin(request, env, url) {
  const parts = url.pathname.replace(/^\/api\/admin\//, "").split("/").filter(Boolean);
  const method = request.method;

  // /api/admin/galleries
  if (parts[0] === "galleries" && parts.length === 1) {
    if (method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT g.*,
           (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id) AS photo_count,
           (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.favorite = 1) AS favorite_count
         FROM galleries g ORDER BY g.created_at DESC`
      ).all();
      return json({ galleries: results.map(adminGallery) });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const title = cleanText(body.title, 200);
      if (!title) return json({ error: "Please give the gallery a title." }, 400);

      const id = crypto.randomUUID();
      const slug = randomSlug(12);
      const pin = cleanPin(body.pin);
      await env.DB.prepare(
        `INSERT INTO galleries (id, slug, title, client_name, client_email, pin_hash,
           allow_downloads, max_selections, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, slug, title,
        cleanText(body.client_name, 200),
        cleanText(body.client_email, 200),
        pin ? await hashPin(id, pin) : null,
        body.allow_downloads ? 1 : 0,
        cleanInt(body.max_selections),
        cleanDate(body.expires_at),
        nowIso()
      ).run();
      return json({ gallery: adminGallery(await getGalleryById(env, id)) }, 201);
    }
  }

  // /api/admin/galleries/:id[/photos]
  if (parts[0] === "galleries" && parts[1]) {
    const gallery = await getGalleryById(env, parts[1]);
    if (!gallery) return json({ error: "Gallery not found" }, 404);

    if (parts.length === 2) {
      if (method === "GET") {
        const photos = await listPhotos(env, gallery.id);
        return json({ gallery: adminGallery(gallery), photos });
      }
      if (method === "PATCH") {
        const body = await readJson(request);
        const sets = [];
        const vals = [];
        const set = (col, val) => { sets.push(`${col} = ?`); vals.push(val); };

        if ("title" in body) {
          const t = cleanText(body.title, 200);
          if (!t) return json({ error: "Title can't be empty." }, 400);
          set("title", t);
        }
        if ("client_name" in body) set("client_name", cleanText(body.client_name, 200));
        if ("client_email" in body) set("client_email", cleanText(body.client_email, 200));
        if ("allow_downloads" in body) set("allow_downloads", body.allow_downloads ? 1 : 0);
        if ("max_selections" in body) set("max_selections", cleanInt(body.max_selections));
        if ("expires_at" in body) set("expires_at", cleanDate(body.expires_at));
        if ("pin" in body) {
          const pin = cleanPin(body.pin);
          set("pin_hash", pin ? await hashPin(gallery.id, pin) : null);
          set("pin_failures", 0);
          set("pin_locked_until", null);
        }
        if (body.reopen) {
          set("submitted_at", null);
        }
        if (body.clear_favorites) {
          await env.DB.prepare("UPDATE photos SET favorite = 0 WHERE gallery_id = ?").bind(gallery.id).run();
          set("submitted_at", null);
          set("client_note", null);
        }
        if (sets.length) {
          vals.push(gallery.id);
          await env.DB.prepare(`UPDATE galleries SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
        }
        return json({ gallery: adminGallery(await getGalleryById(env, gallery.id)) });
      }
      if (method === "DELETE") {
        await deletePrefix(env, `galleries/${gallery.id}/`);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM photos WHERE gallery_id = ?").bind(gallery.id),
          env.DB.prepare("DELETE FROM galleries WHERE id = ?").bind(gallery.id),
        ]);
        return json({ ok: true });
      }
    }

    if (parts[2] === "photos" && parts.length === 3 && method === "POST") {
      return await uploadPhoto(request, env, gallery);
    }
  }

  // /api/admin/photos/:id[/thumb|full]
  if (parts[0] === "photos" && parts[1]) {
    const photo = await env.DB.prepare("SELECT * FROM photos WHERE id = ?").bind(parts[1]).first();
    if (!photo) return json({ error: "Photo not found" }, 404);

    if (parts.length === 2 && method === "DELETE") {
      await env.PHOTOS.delete([photoKey(photo, "full"), photoKey(photo, "thumb")]);
      await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(photo.id).run();
      return json({ ok: true });
    }
    if (parts.length === 3 && method === "GET" && (parts[2] === "thumb" || parts[2] === "full")) {
      return await serveImage(env, photoKey(photo, parts[2]));
    }
  }

  return json({ error: "Not found" }, 404);
}

async function uploadPhoto(request, env, gallery) {
  const form = await request.formData();
  const full = form.get("full");
  const thumb = form.get("thumb");
  const filename = cleanText(form.get("filename"), 200) || "photo.jpg";

  if (!(full instanceof File) || !(thumb instanceof File)) {
    return json({ error: "Missing image data." }, 400);
  }
  if (full.type !== "image/jpeg" || thumb.type !== "image/jpeg") {
    return json({ error: "Images must be JPEG." }, 400);
  }
  if (full.size > MAX_FULL_BYTES || thumb.size > MAX_THUMB_BYTES) {
    return json({ error: "Image is too large." }, 413);
  }

  // Re-uploading the same file (e.g. retrying a failed batch) is a no-op.
  const existing = await env.DB.prepare(
    "SELECT * FROM photos WHERE gallery_id = ? AND filename = ?"
  ).bind(gallery.id, filename).first();
  if (existing) return json({ photo: publicPhoto(existing), skipped: true });

  const photo = {
    id: crypto.randomUUID(),
    gallery_id: gallery.id,
    filename,
    width: cleanInt(form.get("width")),
    height: cleanInt(form.get("height")),
  };
  const meta = { httpMetadata: { contentType: "image/jpeg" } };
  await Promise.all([
    env.PHOTOS.put(photoKey(photo, "full"), full, meta),
    env.PHOTOS.put(photoKey(photo, "thumb"), thumb, meta),
  ]);
  await env.DB.prepare(
    `INSERT INTO photos (id, gallery_id, filename, width, height, favorite, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).bind(photo.id, photo.gallery_id, photo.filename, photo.width, photo.height, nowIso()).run();

  return json({ photo: publicPhoto({ ...photo, favorite: 0 }) }, 201);
}

/* ------------------------------------------------------------------ */
/* Client API                                                          */
/* ------------------------------------------------------------------ */

async function handleClient(request, env, url, ctx) {
  const parts = url.pathname.replace(/^\/api\/g\//, "").split("/").filter(Boolean);
  const method = request.method;
  const gallery = await env.DB.prepare("SELECT * FROM galleries WHERE slug = ?").bind(parts[0] || "").first();

  if (!gallery) return json({ error: "This gallery doesn't exist or has been removed." }, 404);
  if (isExpired(gallery)) return json({ error: "This gallery has expired.", expired: true }, 410);

  // POST /api/g/:slug/unlock
  if (parts[1] === "unlock" && method === "POST") {
    return await unlockGallery(request, env, gallery);
  }

  if (!(await hasClientAccess(request, env, gallery))) {
    return json({ locked: true, title: gallery.title }, 401);
  }

  // GET /api/g/:slug
  if (parts.length === 1 && method === "GET") {
    const photos = await listPhotos(env, gallery.id);
    return json({ gallery: clientGallery(gallery), photos });
  }

  // POST /api/g/:slug/submit
  if (parts[1] === "submit" && parts.length === 2 && method === "POST") {
    const body = await readJson(request);
    const note = cleanText(body.note, 4000);
    const submittedAt = nowIso();
    await env.DB.prepare("UPDATE galleries SET submitted_at = ?, client_note = ? WHERE id = ?")
      .bind(submittedAt, note, gallery.id).run();
    const { results } = await env.DB.prepare(
      "SELECT filename FROM photos WHERE gallery_id = ? AND favorite = 1 ORDER BY filename COLLATE NOCASE"
    ).bind(gallery.id).all();
    ctx.waitUntil(notifySubmission(env, url, gallery, note, results.map((r) => r.filename)).catch(console.error));
    return json({ ok: true, submitted_at: submittedAt, count: results.length });
  }

  // /api/g/:slug/photos/:id/(favorite|thumb|full|download)
  if (parts[1] === "photos" && parts[2] && parts.length === 4) {
    const photo = await env.DB.prepare("SELECT * FROM photos WHERE id = ? AND gallery_id = ?")
      .bind(parts[2], gallery.id).first();
    if (!photo) return json({ error: "Photo not found" }, 404);
    const action = parts[3];

    if (action === "favorite" && method === "PUT") {
      const body = await readJson(request);
      const fav = body.favorite ? 1 : 0;
      if (fav && !photo.favorite && gallery.max_selections) {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM photos WHERE gallery_id = ? AND favorite = 1"
        ).bind(gallery.id).first();
        if (row.n >= gallery.max_selections) {
          return json({ error: `You can choose up to ${gallery.max_selections} photos.`, limit: true }, 409);
        }
      }
      await env.DB.prepare("UPDATE photos SET favorite = ? WHERE id = ?").bind(fav, photo.id).run();
      return json({ ok: true, favorite: !!fav });
    }

    if (method === "GET" && (action === "thumb" || action === "full")) {
      return await serveImage(env, photoKey(photo, action));
    }
    if (method === "GET" && action === "download") {
      if (!gallery.allow_downloads) return json({ error: "Downloads are turned off for this gallery." }, 403);
      const base = photo.filename.replace(/\.[^.]+$/, "").replace(/[^\w.\- ]+/g, "_") || "photo";
      return await serveImage(env, photoKey(photo, "full"), `${base}.jpg`);
    }
  }

  return json({ error: "Not found" }, 404);
}

async function unlockGallery(request, env, gallery) {
  if (!gallery.pin_hash) return json({ ok: true });
  if (!env.SESSION_SECRET) {
    console.error("SESSION_SECRET is not set");
    return json({ error: "This gallery isn't available right now." }, 500);
  }
  if (gallery.pin_locked_until && new Date(gallery.pin_locked_until) > new Date()) {
    return json({ error: "Too many attempts. Please try again in a few minutes." }, 429);
  }

  const body = await readJson(request);
  const pin = cleanPin(body.pin);
  const ok = pin && (await hashPin(gallery.id, pin)) === gallery.pin_hash;

  if (!ok) {
    const failures = (gallery.pin_failures || 0) + 1;
    const lockUntil = failures >= PIN_MAX_FAILURES
      ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString()
      : null;
    await env.DB.prepare("UPDATE galleries SET pin_failures = ?, pin_locked_until = ? WHERE id = ?")
      .bind(lockUntil ? 0 : failures, lockUntil, gallery.id).run();
    return json({ error: "That PIN doesn't match. Please try again." }, 401);
  }

  await env.DB.prepare("UPDATE galleries SET pin_failures = 0, pin_locked_until = NULL WHERE id = ?")
    .bind(gallery.id).run();
  const token = await signToken(env.SESSION_SECRET, `${gallery.id}:${gallery.pin_hash}`);
  return json({ ok: true }, 200, {
    "set-cookie": `${cookieName(gallery)}=${token}; Path=/; Max-Age=${60 * 60 * 24 * 60}; HttpOnly; Secure; SameSite=Lax`,
  });
}

async function hasClientAccess(request, env, gallery) {
  if (!gallery.pin_hash) return true;
  if (!env.SESSION_SECRET) return false;
  const token = getCookie(request, cookieName(gallery));
  if (!token) return false;
  return verifyToken(env.SESSION_SECRET, `${gallery.id}:${gallery.pin_hash}`, token);
}

async function notifySubmission(env, url, gallery, note, filenames) {
  if (!env.NOTIFY || !env.NOTIFY_FROM || !env.NOTIFY_TO) return;
  const who = gallery.client_name || "Your client";
  const subject = `${who} chose ${filenames.length} photo${filenames.length === 1 ? "" : "s"} — ${gallery.title}`;
  const lines = [
    `${who} sent their selections for "${gallery.title}".`,
    "",
    `Favorites: ${filenames.length}`,
    note ? `\nTheir note:\n${note}\n` : "",
    "Files:",
    ...filenames.map((f) => `  ${f}`),
    "",
    `Open in the gallery manager: ${url.origin}/admin/#/g/${gallery.id}`,
  ];
  const raw = [
    `From: Collective by Sus <${env.NOTIFY_FROM}>`,
    `To: ${env.NOTIFY_TO}`,
    `Subject: =?UTF-8?B?${b64(new TextEncoder().encode(subject))}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${url.hostname}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(new TextEncoder().encode(lines.join("\n"))).replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
  await env.NOTIFY.send(new EmailMessage(env.NOTIFY_FROM, env.NOTIFY_TO, raw));
}

/* ------------------------------------------------------------------ */
/* Cloudflare Access verification                                      */
/* ------------------------------------------------------------------ */

let certCache = { at: 0, keys: [] };

async function requireAdmin(request, env, url) {
  if (env.DEV_ADMIN_BYPASS === "true" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return { email: "dev@localhost" };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  let jwk = (await getAccessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getAccessKeys(team, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (!payload.exp || payload.exp < now) return null;

  if (env.ADMIN_EMAILS) {
    const allowed = env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(String(payload.email || "").toLowerCase())) return null;
  }
  return { email: payload.email };
}

async function getAccessKeys(team, force = false) {
  if (!force && certCache.keys.length && Date.now() - certCache.at < 60 * 60 * 1000) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) return certCache.keys;
  const data = await res.json();
  certCache = { at: Date.now(), keys: data.keys || [] };
  return certCache.keys;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function getGalleryById(env, id) {
  return env.DB.prepare("SELECT * FROM galleries WHERE id = ?").bind(id).first();
}

async function listPhotos(env, galleryId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM photos WHERE gallery_id = ? ORDER BY filename COLLATE NOCASE, created_at"
  ).bind(galleryId).all();
  return results.map(publicPhoto);
}

function adminGallery(g) {
  const { pin_hash, pin_failures, pin_locked_until, ...rest } = g;
  return { ...rest, has_pin: !!pin_hash, allow_downloads: !!g.allow_downloads };
}

function clientGallery(g) {
  return {
    title: g.title,
    client_name: g.client_name,
    allow_downloads: !!g.allow_downloads,
    max_selections: g.max_selections,
    expires_at: g.expires_at,
    submitted_at: g.submitted_at,
    client_note: g.client_note,
  };
}

function publicPhoto(p) {
  return { id: p.id, filename: p.filename, width: p.width, height: p.height, favorite: !!p.favorite };
}

function photoKey(photo, size) {
  return `galleries/${photo.gallery_id}/${photo.id}/${size}.jpg`;
}

async function serveImage(env, key, downloadName) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": "image/jpeg",
    "cache-control": "private, max-age=604800, immutable",
    etag: obj.httpEtag,
  });
  if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`);
  return new Response(obj.body, { headers });
}

async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const list = await env.PHOTOS.list({ prefix, cursor });
    if (list.objects.length) await env.PHOTOS.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

function isExpired(g) {
  if (!g.expires_at) return false;
  // Expires at the end of the given day, Dallas time (approx. UTC-6).
  return Date.now() > new Date(`${g.expires_at}T23:59:59-06:00`).getTime();
}

function cookieName(g) {
  return `gal_${g.slug}`;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

async function signToken(secret, data) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

async function verifyToken(secret, data, token) {
  try {
    return await crypto.subtle.verify(
      "HMAC", await hmacKey(secret), b64urlDecode(token), new TextEncoder().encode(data)
    );
  } catch {
    return false;
  }
}

async function hashPin(galleryId, pin) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${galleryId}:${pin}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSlug(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
}

function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

function cleanPin(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 32) : null;
}

function cleanInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function nowIso() {
  return new Date().toISOString();
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function isMutation(request) {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

// Simple CSRF guard: browsers won't add custom headers to cross-site form posts.
function hasFetchHeader(request) {
  return request.headers.get("x-requested-with") === "fetch";
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

function forbidden() {
  return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
}

function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64url(bytes) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
