/* Admin gallery manager API: /api/admin/galleries/*, /api/admin/photos/* */

import { json, readJson, notFound } from "../lib/http.js";
import { cleanText, cleanPin, cleanInt, cleanDate, nowIso, newId, randomSlug } from "../lib/util.js";
import {
  getGalleryById, listPhotos, adminGallery, publicPhoto, photoKey, serveImage, deletePrefix, hashPin,
} from "../lib/galleries.js";

const MAX_FULL_BYTES = 30 * 1024 * 1024;
const MAX_THUMB_BYTES = 5 * 1024 * 1024;

/** parts = path segments after /api/admin/ */
export async function handleAdminGalleries(request, env, parts) {
  const method = request.method;

  // /api/admin/galleries[?client_id=&session_id=]
  if (parts[0] === "galleries" && parts.length === 1) {
    if (method === "GET") {
      const url = new URL(request.url);
      const where = [];
      const vals = [];
      const clientId = url.searchParams.get("client_id");
      const sessionId = url.searchParams.get("session_id");
      if (clientId) { where.push("g.client_id = ?"); vals.push(clientId); }
      if (sessionId) { where.push("g.session_id = ?"); vals.push(sessionId); }
      const { results } = await env.DB.prepare(
        `SELECT g.*, c.name AS linked_client_name, c.can_post AS client_can_post, c.is_minor AS client_is_minor,
           s.title AS session_title, s.type AS session_type, s.status AS session_status,
           (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id) AS photo_count,
           (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.favorite = 1) AS favorite_count
         FROM galleries g
         LEFT JOIN clients c ON c.id = g.client_id
         LEFT JOIN sessions s ON s.id = g.session_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY g.created_at DESC`
      ).bind(...vals).all();
      return json({ galleries: results.map(adminGallery) });
    }
    if (method === "POST") {
      const body = await readJson(request);
      const title = cleanText(body.title, 200);
      if (!title) return json({ error: "Please give the gallery a title." }, 400);
      const link = await resolveLinks(env, body.client_id, body.session_id);
      if (link.error) return json({ error: link.error }, 400);

      const id = newId();
      const slug = randomSlug(12);
      const pin = cleanPin(body.pin);
      await env.DB.prepare(
        `INSERT INTO galleries (id, slug, title, client_name, client_email, pin_hash,
           allow_downloads, max_selections, expires_at, created_at, client_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, slug, title,
        cleanText(body.client_name, 200) || link.client?.name || null,
        cleanText(body.client_email, 200) || link.client?.email || null,
        pin ? await hashPin(id, pin) : null,
        body.allow_downloads ? 1 : 0,
        cleanInt(body.max_selections),
        cleanDate(body.expires_at),
        nowIso(),
        link.client_id,
        link.session_id
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
        if ("client_id" in body || "session_id" in body) {
          const link = await resolveLinks(
            env,
            "client_id" in body ? body.client_id : gallery.client_id,
            "session_id" in body ? body.session_id : gallery.session_id
          );
          if (link.error) return json({ error: link.error }, 400);
          set("client_id", link.client_id);
          set("session_id", link.session_id);
        }
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

  return notFound();
}

/**
 * Validate optional client/session links. A session implies its client.
 * Returns { client_id, session_id, client } or { error }.
 */
async function resolveLinks(env, clientId, sessionId) {
  clientId = cleanText(clientId, 64);
  sessionId = cleanText(sessionId, 64);
  let session = null;
  if (sessionId) {
    session = await env.DB.prepare("SELECT id, client_id FROM sessions WHERE id = ?").bind(sessionId).first();
    if (!session) return { error: "That session no longer exists." };
    if (clientId && clientId !== session.client_id) return { error: "That session belongs to a different client." };
    clientId = session.client_id;
  }
  let client = null;
  if (clientId) {
    client = await env.DB.prepare("SELECT id, name, email FROM clients WHERE id = ?").bind(clientId).first();
    if (!client) return { error: "That client no longer exists." };
  }
  return { client_id: clientId || null, session_id: sessionId || null, client };
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
  // The part's content-type is client-claimed; check the JPEG signature too.
  if (!(await isJpeg(full)) || !(await isJpeg(thumb))) {
    return json({ error: "Images must be JPEG." }, 400);
  }

  // Re-uploading the same file (e.g. retrying a failed batch) is a no-op.
  const existing = await env.DB.prepare(
    "SELECT * FROM photos WHERE gallery_id = ? AND filename = ?"
  ).bind(gallery.id, filename).first();
  if (existing) return json({ photo: publicPhoto(existing), skipped: true });

  const photo = {
    id: newId(),
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

async function isJpeg(file) {
  const b = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  return b.length === 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
