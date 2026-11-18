/* Public inquiry form: settings for the page, and the submission endpoint. */

import { json, readJson, clientIp } from "../lib/http.js";
import {
  cleanText, cleanLine, cleanEmail, cleanHandle, oneOf, newId, nowIso, signToken, verifyToken,
} from "../lib/util.js";
import { findOrCreateClient, logActivity, SESSION_TYPES } from "../lib/clients.js";
import { getSettings, publicSettings } from "../lib/settings.js";
import { sendOwnerEmail, sendClientEmail } from "../lib/email.js";
import { rateLimit, hashedIpKey } from "../lib/ratelimit.js";
import { turnstileEnabled, verifyTurnstile } from "../lib/turnstile.js";
import { BRAND } from "../lib/brand.js";
import { publicAvailability, computeAvailability, availabilityConfig, bookingWindow, isDay } from "../lib/availability.js";

/** "2026-12-05" -> "Sat, Dec 5" */
function fmtDay(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** GET /api/public/availability: which days clients can pick (no counts, no names). */
export async function handlePublicAvailability(request, env) {
  const data = await publicAvailability(env, await getSettings(env));
  return json(data, 200, { "cache-control": "public, max-age=60" });
}

const MIN_AGE_MS = 3000;
const MAX_AGE_MS = 24 * 3600 * 1000;
const INQUIRY_LIMIT = 5;
const INQUIRY_WINDOW = 3600;

const TYPE_LABELS = {
  graduation: "Graduation",
  engagement: "Engagement",
  event: "Event",
  portrait: "Portrait",
};

const REFERRAL_LABELS = {
  instagram: "Instagram",
  referral: "Friend / referral",
  google: "Google",
  other: "Other",
};

function tokenData(ts) {
  return "inq:" + ts;
}

export async function handlePublicSettings(request, env) {
  const settings = publicSettings(await getSettings(env));
  const ts = String(Date.now());
  const form_token = env.SESSION_SECRET
    ? `${ts}.${await signToken(env.SESSION_SECRET, tokenData(ts))}`
    : `${ts}.unsigned`;
  return json({
    settings,
    turnstile_site_key: turnstileEnabled(env) ? env.TURNSTILE_SITE_KEY : null,
    form_token,
  });
}

/** Returns null when the token is acceptable, or an error message. */
async function checkFormToken(env, token) {
  const expired = "This form expired, please refresh the page.";
  if (typeof token !== "string" || token.length > 200) return expired;
  const dot = token.indexOf(".");
  if (dot < 1) return expired;
  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d{10,16}$/.test(ts)) return expired;
  if (env.SESSION_SECRET) {
    if (!sig || sig === "unsigned") return expired;
    if (!(await verifyToken(env.SESSION_SECRET, tokenData(ts), sig))) return expired;
  }
  const age = Date.now() - Number(ts);
  if (age < MIN_AGE_MS) return "Please wait a moment and try again.";
  if (age > MAX_AGE_MS) return expired;
  return null;
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

function thankYou(settings, name) {
  return {
    first_name: firstName(name),
    price_note: settings.price_note || "",
    hourly_rate_text: settings.hourly_rate_text || "",
    retainer_note: settings.retainer_note || "",
    turnaround: settings.turnaround || "",
    reply_promise: settings.reply_promise || "",
  };
}

function validate(body) {
  const name = cleanLine(body.name, 120);
  if (!name) return { error: "Please tell me your name.", field: "name" };
  const email = cleanEmail(body.email);
  if (!email) return { error: "Please enter a valid email address.", field: "email" };
  const phone = cleanLine(body.phone, 40);
  let instagram = null;
  if (cleanText(body.instagram, 100)) {
    instagram = cleanHandle(body.instagram);
    if (!instagram) return { error: "That Instagram handle doesn't look right.", field: "instagram" };
  }
  const session_type = oneOf(body.session_type, SESSION_TYPES);
  if (!session_type) return { error: "Please choose a session type.", field: "session_type" };
  const rawDates = Array.isArray(body.preferred_dates) ? body.preferred_dates : [];
  if (rawDates.length > 31) return { error: "That's a lot of days. Please pick just a few.", field: "preferred_dates" };
  const preferred_dates = [...new Set(rawDates.map((d) => String(d).trim()).filter(Boolean))].sort();
  if (preferred_dates.some((d) => !isDay(d))) return { error: "Please pick days from the calendar.", field: "preferred_dates" };
  const referralRaw = cleanLine(body.referral, 120);
  return {
    data: {
      name,
      email,
      phone,
      instagram,
      session_type,
      preferred_dates,
      date_notes: cleanText(body.date_notes, 500),
      // Where the visit came from (set by js/visit.js): a short label and the referring site's name only.
      came_from: cleanLine(body.came_from, 40),
      referrer_host: /^[a-z0-9.-]{1,120}$/i.test(String(body.referrer_host || "")) ? String(body.referrer_host).toLowerCase() : null,
      location: cleanLine(body.location, 200),
      people_count: cleanLine(body.people_count, 40),
      usage: cleanText(body.usage, 500),
      referral: referralRaw,
      message: cleanText(body.message, 3000),
    },
  };
}

export async function handleInquiry(request, env, ctx, url) {
  if (Number(request.headers.get("content-length") || 0) > 32768) {
    return json({ error: "That's a bit long for this form. Please shorten your message.", field: "message" }, 413);
  }
  const body = await readJson(request, 32768);
  if (!Object.keys(body).length) return json({ error: "Bad request" }, 400);
  const settings = await getSettings(env);

  // 1. Honeypot: pretend success, store nothing.
  if (body.website != null && String(body.website).trim() !== "") {
    return json({ ok: true, thank_you: thankYou(settings, cleanLine(body.name, 120)) }, 200);
  }

  // 2. Timing / signed form token.
  const tokenError = await checkFormToken(env, body.form_token);
  if (tokenError) return json({ error: tokenError, field: "form_token" }, 400);

  // 3. Field validation (before rate limiting so typos don't use up attempts).
  const v = validate(body);
  if (v.error) return json({ error: v.error, field: v.field }, 400);
  const d = v.data;

  // Picked days must still be open (a day can fill up while the form is open).
  if (d.preferred_dates.length) {
    const cfg = availabilityConfig(settings);
    if (d.preferred_dates.length > cfg.maxPicks) {
      return json({ error: `Please pick up to ${cfg.maxPicks} days.`, field: "preferred_dates" }, 400);
    }
    const win = bookingWindow(cfg);
    const avail = await computeAvailability(env, settings, win.first, win.last);
    const unavailable = d.preferred_dates.filter((day) => !(avail.get(day) && avail.get(day).open));
    if (unavailable.length) {
      return json({
        error: `${unavailable.map(fmtDay).join(", ")} ${unavailable.length === 1 ? "isn't" : "aren't"} available anymore. Please pick another day.`,
        field: "preferred_dates", unavailable,
      }, 409);
    }
  }
  const datesText = d.preferred_dates.map(fmtDay).join("; ");

  // 4. Rate limit per hashed IP.
  const ip = clientIp(request);
  const rl = await rateLimit(env, "inquiry", await hashedIpKey(env, ip), INQUIRY_LIMIT, INQUIRY_WINDOW);
  if (!rl.ok) {
    return json(
      { error: `That's a lot of messages in a short time. Please try again in a little while, or email ${BRAND.contactEmail}.` },
      429,
      { "retry-after": String(Math.max(1, rl.retryAfter)) }
    );
  }

  // 5. Turnstile (only when configured).
  if (!(await verifyTurnstile(env, body.turnstile_token, ip))) {
    return json({ error: "Please complete the verification and try again.", field: "turnstile" }, 400);
  }

  // Store.
  const now = nowIso();
  const { client } = await findOrCreateClient(env, {
    name: d.name,
    email: d.email,
    phone: d.phone,
    instagram: d.instagram,
    source: d.referral ? cleanLine(d.referral, 120) : "website",
  });

  const typeLabel = TYPE_LABELS[d.session_type];
  const inquiryId = newId();
  const sessionId = newId();
  const noteLines = [];
  if (d.preferred_dates.length) noteLines.push(`Days they're open: ${datesText}`);
  if (d.date_notes) noteLines.push(`Timing notes: ${d.date_notes}`);
  if (d.people_count) noteLines.push(`People: ${d.people_count}`);
  if (d.usage) noteLines.push(`Usage: ${d.usage}`);
  const notes = noteLines.join("\n") || null;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO inquiries (id, client_id, session_id, name, email, phone, instagram, session_type,
         preferred_dates, date_notes, location, people_count, usage, referral, message, came_from, referrer_host,
         status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    ).bind(inquiryId, client.id, sessionId, d.name, d.email, d.phone, d.instagram, d.session_type,
      JSON.stringify(d.preferred_dates), d.date_notes, d.location, d.people_count, d.usage, d.referral, d.message, d.came_from, d.referrer_host, now),
    env.DB.prepare(
      `INSERT INTO sessions (id, client_id, inquiry_id, type, title, location, status, status_changed_at,
         notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'inquiry', ?, ?, ?, ?)`
    ).bind(sessionId, client.id, inquiryId, d.session_type, `${typeLabel} inquiry`, d.location, now,
      notes, now, now),
  ]);

  const summary = [`${typeLabel} inquiry via website form`];
  if (d.preferred_dates.length) summary.push(`open days: ${datesText}`);
  if (d.location) summary.push(`location: ${d.location}`);
  await logActivity(env, { client_id: client.id, session_id: sessionId, kind: "inquiry", body: summary.join(" · ") });

  // Email in the background; never block or fail the response on it.
  const adminLink = `${url.origin}/admin/#/c/${client.id}`;
  const ownerText = [
    `New ${typeLabel.toLowerCase()} inquiry from ${d.name}.`,
    "",
    `Name: ${d.name}`,
    `Email: ${d.email}`,
    `Phone: ${d.phone || "-"}`,
    `Instagram: ${d.instagram ? "@" + d.instagram : "-"}`,
    `Session type: ${typeLabel}`,
    `Days they're open: ${datesText || "-"}`,
    `Timing notes: ${d.date_notes || "-"}`,
    `Location: ${d.location || "-"}`,
    `Number of people: ${d.people_count || "-"}`,
    `Photo usage: ${d.usage || "-"}`,
    `Found me via: ${d.referral ? REFERRAL_LABELS[d.referral] || d.referral : "-"}`,
    `Came to the site from: ${d.came_from || "-"}${d.referrer_host && d.referrer_host.toLowerCase() !== String(d.came_from || "").toLowerCase() ? ` (${d.referrer_host})` : ""}`,
    "",
    "Message:",
    d.message || "-",
    "",
    `Open in CRM: ${adminLink}`,
  ].join("\n");

  const tasks = [
    sendOwnerEmail(env, { subject: `New inquiry: ${d.name} · ${typeLabel}`, text: ownerText, replyTo: d.email }),
  ];
  if (settings.auto_reply_enabled === "true" && settings.auto_reply_text) {
    const vars = {
      first_name: firstName(d.name),
      name: d.name,
      booking_url: `${url.origin}/contact#book`,
      business_name: settings.business_name || BRAND.businessName,
    };
    const text = settings.auto_reply_text.replace(/\{\{\s*(first_name|name|booking_url|business_name)\s*\}\}/g,
      (_, k) => vars[k]);
    tasks.push(sendClientEmail(env, {
      to: d.email,
      subject: `Thanks for reaching out, ${vars.first_name}`,
      text,
    }));
  }
  const work = Promise.allSettled(tasks).then((results) => {
    for (const r of results) if (r.status === "rejected") console.error("inquiry email failed", r.reason && r.reason.message);
  }).catch(console.error);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);

  return json({ ok: true, thank_you: thankYou(settings, d.name) }, 201);
}
