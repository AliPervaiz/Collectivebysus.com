/* Client proofing gallery API: /api/g/:slug/* */

import { json, readJson, notFound } from "../lib/http.js";
import { cleanText, cleanPin, nowIso, signToken, verifyToken, getCookie } from "../lib/util.js";
import { listPhotos, clientGallery, photoKey, serveImage, isExpired, hashPin } from "../lib/galleries.js";
import { sendOwnerEmail } from "../lib/email.js";
import { logActivity } from "../lib/clients.js";

const PIN_MAX_FAILURES = 8;
const PIN_LOCK_MINUTES = 15;

export async function handleClient(request, env, url, ctx) {
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
    const filenames = results.map((r) => r.filename);
    ctx.waitUntil(notifySubmission(env, url, gallery, note, filenames).catch(console.error));
    if (gallery.client_id) {
      ctx.waitUntil(recordSubmission(env, gallery, filenames.length, submittedAt).catch(console.error));
    }
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
      if (fav && gallery.max_selections) {
        // Re-check the limit in the same statement so parallel taps can't overshoot it.
        const res = await env.DB.prepare(
          `UPDATE photos SET favorite = 1 WHERE id = ? AND (favorite = 1 OR
             (SELECT COUNT(*) FROM photos WHERE gallery_id = ? AND favorite = 1) < ?)`
        ).bind(photo.id, gallery.id, gallery.max_selections).run();
        if (!(res.meta && res.meta.changes)) {
          return json({ error: `You can choose up to ${gallery.max_selections} photos.`, limit: true }, 409);
        }
      } else {
        await env.DB.prepare("UPDATE photos SET favorite = ? WHERE id = ?").bind(fav, photo.id).run();
      }
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

  return notFound();
}

async function unlockGallery(request, env, gallery) {
  if (!gallery.pin_hash) return json({ ok: true });
  if (!env.SESSION_SECRET) {
    console.error("SESSION_SECRET is not set");
    return json({ error: "This gallery isn't available right now." }, 500);
  }
  const locked = json({ error: "Too many attempts. Please try again in a few minutes." }, 429);
  const now = nowIso();
  const lockUntil = () => new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString();

  // Count the attempt atomically *before* checking the PIN, so a burst of
  // parallel guesses can't all slip past a stale failure count.
  const claim = await env.DB.prepare(
    `UPDATE galleries SET pin_failures = pin_failures + 1
     WHERE id = ? AND pin_failures < ? AND (pin_locked_until IS NULL OR pin_locked_until <= ?)
     RETURNING pin_failures`
  ).bind(gallery.id, PIN_MAX_FAILURES, now).first();
  if (!claim) {
    // Either already locked, or the attempt budget ran out mid-burst: lock now.
    await env.DB.prepare(
      `UPDATE galleries SET pin_failures = 0, pin_locked_until = ?
       WHERE id = ? AND pin_failures >= ? AND (pin_locked_until IS NULL OR pin_locked_until <= ?)`
    ).bind(lockUntil(), gallery.id, PIN_MAX_FAILURES, now).run();
    return locked;
  }

  const body = await readJson(request);
  const pin = cleanPin(body.pin);
  const ok = pin && (await hashPin(gallery.id, pin)) === gallery.pin_hash;

  if (!ok) {
    if (claim.pin_failures >= PIN_MAX_FAILURES) {
      await env.DB.prepare("UPDATE galleries SET pin_failures = 0, pin_locked_until = ? WHERE id = ?")
        .bind(lockUntil(), gallery.id).run();
    }
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

function cookieName(g) {
  return `gal_${g.slug}`;
}

async function notifySubmission(env, url, gallery, note, filenames) {
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
  await sendOwnerEmail(env, { subject, text: lines.join("\n") });
}

/**
 * CRM side of a favorites submission: log it on the client's timeline and, if
 * the linked session is still "booked" or "shot", move it to "editing". Later
 * stages are left alone (the dashboard still lists the gallery as waiting).
 */
async function recordSubmission(env, gallery, count, at) {
  await logActivity(env, {
    client_id: gallery.client_id,
    session_id: gallery.session_id,
    kind: "gallery",
    body: `Sent ${count} favorite${count === 1 ? "" : "s"} from "${gallery.title}"`,
  });
  if (!gallery.session_id) return;
  const res = await env.DB.prepare(
    `UPDATE sessions SET status = 'editing', status_changed_at = ?, updated_at = ?
     WHERE id = ? AND client_id = ? AND status IN ('booked', 'shot')`
  ).bind(at, at, gallery.session_id, gallery.client_id).run();
  if (res.meta && res.meta.changes) {
    await logActivity(env, {
      client_id: gallery.client_id,
      session_id: gallery.session_id,
      kind: "status",
      body: "Moved to Editing (client sent favorites)",
    });
  }
}
