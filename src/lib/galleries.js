/* Gallery/photo helpers shared by the admin and client gallery routes. */

import { BRAND } from "./brand.js";

export async function getGalleryById(env, id) {
  return env.DB.prepare(
    `SELECT g.*, c.name AS linked_client_name, c.can_post AS client_can_post, c.is_minor AS client_is_minor,
       s.title AS session_title, s.type AS session_type, s.status AS session_status
     FROM galleries g
     LEFT JOIN clients c ON c.id = g.client_id
     LEFT JOIN sessions s ON s.id = g.session_id
     WHERE g.id = ?`
  ).bind(id).first();
}

export async function listPhotos(env, galleryId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM photos WHERE gallery_id = ? ORDER BY filename COLLATE NOCASE, created_at"
  ).bind(galleryId).all();
  return results.map(publicPhoto);
}

/** Admin view of a gallery row (never exposes the PIN hash). */
export function adminGallery(g) {
  const { pin_hash, pin_failures, pin_locked_until, ...rest } = g;
  return {
    ...rest,
    has_pin: !!pin_hash,
    allow_downloads: !!g.allow_downloads,
    client_is_minor: g.client_is_minor == null ? null : !!g.client_is_minor,
  };
}

export function clientGallery(g) {
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

export function publicPhoto(p) {
  return { id: p.id, filename: p.filename, width: p.width, height: p.height, favorite: !!p.favorite };
}

export function photoKey(photo, size) {
  return `galleries/${photo.gallery_id}/${photo.id}/${size}.jpg`;
}

export async function serveImage(env, key, downloadName) {
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": "image/jpeg",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=604800, immutable",
    etag: obj.httpEtag,
  });
  if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`);
  return new Response(obj.body, { headers });
}

export async function deletePrefix(env, prefix) {
  let cursor;
  do {
    const list = await env.PHOTOS.list({ prefix, cursor });
    if (list.objects.length) await env.PHOTOS.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

export function isExpired(g) {
  if (!g.expires_at) return false;
  // Expires at the end of the given day in the studio's time zone (DST-aware):
  // compare against today's date there, both as YYYY-MM-DD strings.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: BRAND.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return today > g.expires_at;
}

export async function hashPin(galleryId, pin) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${galleryId}:${pin}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
