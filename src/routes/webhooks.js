/* Cal.com booking webhook (HMAC-SHA256 signed raw body). */

import { json } from "../lib/http.js";
import { cleanText, cleanLine, cleanEmail, cleanDateTime, hmacKey, toHex, safeEqual, newId, nowIso } from "../lib/util.js";
import { findOrCreateClient, logActivity } from "../lib/clients.js";
import { sendOwnerEmail } from "../lib/email.js";
import { BRAND } from "../lib/brand.js";

const MAX_BODY = 256 * 1024;

export async function handleCalWebhook(request, env, ctx) {
  if (!env.CAL_WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);

  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return json({ error: "Payload too large" }, 413);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY) return json({ error: "Payload too large" }, 413);

  const given = String(request.headers.get("x-cal-signature-256") || "").trim().toLowerCase().replace(/^sha256=/, "");
  const key = await hmacKey(env.CAL_WEBHOOK_SECRET);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, buf));
  if (!given || !safeEqual(given, expected)) return json({ error: "Invalid signature" }, 401);

  let event;
  try {
    event = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  if (!event || typeof event !== "object") return json({ error: "Bad request" }, 400);
  const trigger = String(event.triggerEvent || "");
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};

  let result;
  if (trigger === "BOOKING_CREATED") result = await bookingCreated(env, payload);
  else if (trigger === "BOOKING_RESCHEDULED") result = await bookingRescheduled(env, payload);
  else if (trigger === "BOOKING_CANCELLED") result = await bookingCancelled(env, payload);
  else return json({ ok: true, ignored: true });

  if (result.email && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendOwnerEmail(env, result.email).catch(console.error));
  }
  return json(result.ignored ? { ok: true, ignored: true } : { ok: true });
}

/* ---------- helpers ---------- */

function uidOf(v) {
  return cleanLine(v, 200);
}

function bookingTimes(payload) {
  const starts_at = cleanDateTime(payload.startTime);
  const ends_at = cleanDateTime(payload.endTime);
  let hours = null;
  if (starts_at && ends_at) {
    const ms = new Date(ends_at) - new Date(starts_at);
    if (ms > 0) hours = Math.round((ms / 3600000) * 4) / 4 || null;
  }
  return { starts_at, ends_at, hours };
}

function bookingLocation(payload) {
  return typeof payload.location === "string" ? cleanLine(payload.location, 200) : null;
}

function guessType(payload) {
  const hay = [
    payload.title, payload.eventTitle, payload.type,
    payload.responses ? JSON.stringify(payload.responses).slice(0, 4000) : "",
  ].filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (hay.includes("grad")) return "graduation";
  if (hay.includes("engage")) return "engagement";
  if (hay.includes("event")) return "event";
  return "portrait";
}

function attendeeOf(payload) {
  const a = Array.isArray(payload.attendees) && payload.attendees[0] && typeof payload.attendees[0] === "object"
    ? payload.attendees[0] : {};
  return { name: cleanLine(a.name, 120), email: cleanEmail(a.email), timeZone: cleanLine(a.timeZone, 60) };
}

function fmtWhen(iso) {
  if (!iso) return "unknown time";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: BRAND.timeZone, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }) + " CT";
  } catch {
    return iso;
  }
}

async function findByUid(env, uid) {
  if (!uid) return null;
  return env.DB.prepare("SELECT * FROM sessions WHERE cal_booking_uid = ?").bind(uid).first();
}

/* ---------- events ---------- */

async function bookingCreated(env, payload) {
  const uid = uidOf(payload.uid);
  if (!uid) return { ignored: true };
  const now = nowIso();
  const { starts_at, ends_at, hours } = bookingTimes(payload);
  const location = bookingLocation(payload);
  const title = cleanLine(payload.title, 200);

  // Retries / duplicates: update in place, no new activity or email.
  const existing = await findByUid(env, uid);
  if (existing) {
    await env.DB.prepare(
      `UPDATE sessions SET starts_at = COALESCE(?, starts_at), ends_at = COALESCE(?, ends_at),
         hours = COALESCE(?, hours), location = COALESCE(?, location), updated_at = ? WHERE id = ?`
    ).bind(starts_at, ends_at, hours, location, now, existing.id).run();
    return {};
  }

  const att = attendeeOf(payload);
  const { client } = await findOrCreateClient(env, {
    name: att.name, email: att.email, source: "cal.com",
  });

  const open = await env.DB.prepare(
    `SELECT * FROM sessions WHERE client_id = ? AND status = 'inquiry' AND cal_booking_uid IS NULL
     ORDER BY created_at DESC LIMIT 1`
  ).bind(client.id).first();

  let sessionId;
  if (open) {
    sessionId = open.id;
    await env.DB.prepare(
      `UPDATE sessions SET status = 'booked', status_changed_at = ?, cal_booking_uid = ?,
         starts_at = ?, ends_at = ?, hours = COALESCE(?, hours), location = COALESCE(?, location),
         title = COALESCE(?, title), updated_at = ? WHERE id = ?`
    ).bind(now, uid, starts_at, ends_at, hours, location, title, now, sessionId).run();
  } else {
    sessionId = newId();
    await env.DB.prepare(
      `INSERT INTO sessions (id, client_id, type, title, starts_at, ends_at, hours, location, status,
         status_changed_at, cal_booking_uid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?)`
    ).bind(sessionId, client.id, guessType(payload), title, starts_at, ends_at, hours, location,
      now, uid, now, now).run();
  }

  const when = fmtWhen(starts_at);
  await logActivity(env, {
    client_id: client.id, session_id: sessionId, kind: "booking",
    body: `Booked via Cal.com for ${when}${hours ? ` (${hours} h)` : ""}${open ? ", linked to inquiry" : ""}`,
  });

  return {
    email: {
      subject: `New booking: ${client.name} · ${when}`,
      text: [
        `${client.name} booked a session through Cal.com.`,
        "",
        `When: ${when}${hours ? ` (${hours} h)` : ""}`,
        `Title: ${title || "-"}`,
        `Location: ${location || "-"}`,
        `Email: ${client.email || "-"}`,
        open ? "Linked to their existing inquiry." : "",
      ].filter((l) => l !== null).join("\n"),
      replyTo: client.email || undefined,
    },
  };
}

async function bookingRescheduled(env, payload) {
  const newUid = uidOf(payload.uid);
  const oldUid = uidOf(payload.rescheduleUid);
  let session = (await findByUid(env, oldUid)) || (await findByUid(env, newUid));
  if (!session) return bookingCreated(env, payload);

  const now = nowIso();
  const { starts_at, ends_at, hours } = bookingTimes(payload);
  const location = bookingLocation(payload);
  const reopen = session.status === "lost";
  // Another row might already hold the new uid (e.g. a duplicate CREATED); avoid the unique clash.
  const holder = newUid && newUid !== session.cal_booking_uid ? await findByUid(env, newUid) : null;
  const uidToSet = holder ? session.cal_booking_uid : newUid || session.cal_booking_uid;

  await env.DB.prepare(
    `UPDATE sessions SET cal_booking_uid = ?, starts_at = COALESCE(?, starts_at), ends_at = COALESCE(?, ends_at),
       hours = COALESCE(?, hours), location = COALESCE(?, location),
       status = CASE WHEN status = 'lost' THEN 'booked' ELSE status END,
       status_changed_at = CASE WHEN status = 'lost' THEN ? ELSE status_changed_at END,
       updated_at = ? WHERE id = ?`
  ).bind(uidToSet, starts_at, ends_at, hours, location, now, now, session.id).run();

  await logActivity(env, {
    client_id: session.client_id, session_id: session.id, kind: "booking",
    body: `Rescheduled to ${fmtWhen(starts_at)}${reopen ? " (reopened, was lost)" : ""}`,
  });
  return {};
}

async function bookingCancelled(env, payload) {
  const session = await findByUid(env, uidOf(payload.uid));
  if (!session) return { ignored: true };
  const now = nowIso();
  const reason = cleanText(payload.cancellationReason, 500);
  if (session.status === "inquiry" || session.status === "booked") {
    await env.DB.prepare(
      "UPDATE sessions SET status = 'lost', status_changed_at = ?, updated_at = ? WHERE id = ?"
    ).bind(now, now, session.id).run();
  }
  await logActivity(env, {
    client_id: session.client_id, session_id: session.id, kind: "booking",
    body: `Cancelled on Cal.com${reason ? `: ${reason}` : ""}`,
  });
  const client = await env.DB.prepare("SELECT name, email FROM clients WHERE id = ?").bind(session.client_id).first();
  const name = (client && client.name) || "A client";
  return {
    email: {
      subject: `Booking cancelled: ${name} · ${fmtWhen(session.starts_at)}`,
      text: `${name} cancelled their Cal.com booking for ${fmtWhen(session.starts_at)}.\n\nReason: ${reason || "-"}`,
      replyTo: (client && client.email) || undefined,
    },
  };
}
