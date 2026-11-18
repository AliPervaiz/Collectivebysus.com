/* CRM admin API: everything under /api/admin/* except galleries/photos.
 * Auth and the CSRF header check are enforced by the router before we get here. */

import { json, readJson, notFound } from "../lib/http.js";
import {
  cleanText, cleanLine, cleanCents, cleanNumber, cleanDate, cleanDateTime, cleanEmail, cleanHandle,
  oneOf, newId, nowIso,
} from "../lib/util.js";
import {
  SESSION_TYPES, SESSION_STATUSES, normalizeStatus, CAN_POST, PAYMENT_METHODS, PAYMENT_KINDS, logActivity,
} from "../lib/clients.js";
import { getSettings, saveSettings } from "../lib/settings.js";
import { computeAvailability, availabilityConfig, isDay } from "../lib/availability.js";
import { insights } from "../lib/insights.js";
import { dumpAll, runBackup, listBackups, backupKey, zipFiles, KEEP } from "../lib/backup.js";
import { adminGallery } from "../lib/galleries.js";
import { emailStatus } from "../lib/email.js";
import { toCsv, csvResponse } from "../lib/csv.js";
import { CONTRACT_DRAFT, MERGE_FIELDS } from "../lib/contract-draft.js";
import { BRAND } from "../lib/brand.js";

const ACTIVE_STATUSES = ["inquiry", "booked", "editing"];
const CHANNELS = ["instagram", "email", "text", "call", "in person"];
const INQUIRY_STATUSES = ["new", "replied", "closed"];
const TYPE_LABELS = { graduation: "Grad", engagement: "Engagement", event: "Event", portrait: "Portrait" };
const METHOD_LABELS = { venmo: "Venmo", zelle: "Zelle", cash: "cash", card: "card", other: "other" };
const CONTRACT_MAX = 50000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** parts = path segments after /api/admin/ */
export async function handleCrm(request, env, parts, ctx, admin) {
  const method = request.method;
  const [section, id, sub] = parts;
  const n = parts.length;

  if (section === "dashboard" && n === 1 && method === "GET") return dashboard(env);
  if (section === "insights" && n === 1 && method === "GET") return json(await insights(env, new URL(request.url)));

  if (section === "clients") {
    if (n === 1 && method === "GET") return listClients(env, new URL(request.url));
    if (n === 1 && method === "POST") return createClient(env, await readJson(request));
    if (n === 2 && method === "GET") return getClientDetail(env, id);
    if (n === 2 && method === "PATCH") return updateClient(env, id, await readJson(request));
    if (n === 2 && method === "DELETE") return deleteClient(env, id);
    if (n === 3 && sub === "activity" && method === "POST") return addActivity(env, id, await readJson(request));
  }

  if (section === "inquiries") {
    if (n === 3 && sub === "replied" && method === "POST") return markReplied(env, id, await readJson(request));
    if (n === 2 && method === "PATCH") return updateInquiry(env, id, await readJson(request));
  }

  if (section === "sessions") {
    if (n === 1 && method === "GET") return listSessions(env, new URL(request.url));
    if (n === 1 && method === "POST") return createSession(env, await readJson(request));
    if (n === 2 && method === "GET") return getSessionDetail(env, id);
    if (n === 2 && method === "PATCH") return updateSession(env, id, await readJson(request));
    if (n === 2 && method === "DELETE") return deleteSession(env, id);
    if (n === 3 && sub === "payments" && method === "POST") return addPayment(env, id, await readJson(request));
  }

  if (section === "payments" && n === 2 && method === "DELETE") return deletePayment(env, id);

  if (section === "availability" && n === 1 && method === "GET") return adminAvailability(env, new URL(request.url));
  if (section === "days" && n === 2) {
    if (method === "PUT") return setDayOverride(env, id, await readJson(request));
    if (method === "DELETE") return clearDayOverride(env, id);
  }

  if (section === "settings" && n === 1) {
    if (method === "GET") return settingsResponse(env);
    if (method === "PUT") return updateSettings(env, await readJson(request));
  }

  if (section === "contracts") {
    if (n === 1 && method === "GET") return listContracts(env);
    if (n === 1 && method === "POST") return saveContract(env, null, await readJson(request));
    if (n === 2 && method === "PUT") return saveContract(env, id, await readJson(request));
    if (n === 2 && method === "DELETE") return deleteContract(env, id);
  }

  if (section === "export" && n === 2 && method === "GET") {
    const one = EXPORTS[id];
    if (one) return csvResponse(exportName(id.replace(/\.csv$/, "")), await one(env));
    if (id === "everything.zip") return exportEverything(env);
  }

  if (section === "backups") {
    if (n === 1 && method === "GET") return json({ backups: await listBackups(env), keep: KEEP });
    if (n === 1 && method === "POST") return json(await runBackup(env, { reason: "manual" }));
    if (n === 2 && method === "GET") return downloadBackup(env, id);
  }

  return notFound();
}

/* ---------- small helpers ---------- */

const bad = (error, status = 400) => json({ error }, status);

function bool(v) {
  return v === true || v === 1 || v === "1" || v === "true" || v === "yes" || v === "on";
}

function cleanId(v) {
  return cleanLine(v, 64);
}

function isBlank(v) {
  return v == null || (typeof v === "string" && v.trim() === "");
}

/** Today's date (YYYY-MM-DD) in the studio's time zone. */
function todayChicago() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRAND.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** ISO -> "YYYY-MM-DD HH:MM" in the studio's time zone, for spreadsheets. */
function localDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: BRAND.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Minutes Chicago is ahead of UTC at instant t (negative, e.g. -360). */
function chicagoOffset(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: BRAND.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / 60000);
}

/**
 * Session start time -> ISO UTC. A zone-less "YYYY-MM-DDTHH:MM" (from a
 * datetime-local input) means studio (Central) time; the Workers runtime would otherwise
 * read it as UTC. Anything with a zone goes through cleanDateTime unchanged.
 */
function cleanStartsAt(v) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v.trim())) {
    const naive = Date.parse(v.trim() + "Z");
    if (Number.isNaN(naive)) return null;
    let t = naive - chicagoOffset(naive) * 60000;
    t = naive - chicagoOffset(t) * 60000;
    return new Date(t).toISOString();
  }
  return cleanDateTime(v);
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function dollars(cents) {
  return cents == null ? "" : (Number(cents) / 100).toFixed(2);
}

function statusLabel(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function sessionLabel(s) {
  return `${TYPE_LABELS[s.type] || "Portrait"} session`;
}

function sessionName(s) {
  return s.title || sessionLabel(s);
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) return "";
  const h = Math.floor(ms / HOUR);
  if (h < 1) return "just now";
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

function parseDates(v) {
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map(String) : [String(a)];
  } catch {
    return [String(v)];
  }
}

function inquiryOut(i) {
  return { ...i, preferred_dates: parseDates(i.preferred_dates) };
}

function clientOut(c) {
  return { ...c, is_minor: !!c.is_minor };
}

/* ---------- SQL fragments ---------- */

const PAID_SQL = "COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.session_id = s.id), 0)";

const SESSION_SELECT = `
  SELECT s.*, c.name AS client_name, c.can_post AS client_can_post, c.is_minor AS client_is_minor,
    ${PAID_SQL} AS paid_cents,
    (SELECT COUNT(*) FROM galleries g WHERE g.session_id = s.id) AS gallery_count
  FROM sessions s
  JOIN clients c ON c.id = s.client_id`;

const SESSION_ORDER = "ORDER BY s.starts_at IS NULL, s.starts_at ASC, s.created_at DESC";

const CLIENT_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM sessions s WHERE s.client_id = c.id) AS session_count,
    (SELECT MAX(s.starts_at) FROM sessions s WHERE s.client_id = c.id) AS last_session_at,
    (SELECT COUNT(*) FROM inquiries i WHERE i.client_id = c.id AND i.status = 'new') AS open_inquiries,
    COALESCE((SELECT SUM(s.quoted_cents - ${PAID_SQL}) FROM sessions s
              WHERE s.client_id = c.id AND s.quoted_cents IS NOT NULL
                AND s.status NOT IN ('lost', 'archived')), 0) AS balance_cents
  FROM clients c`;

const GALLERY_SELECT = `
  SELECT g.*, c.name AS linked_client_name, c.can_post AS client_can_post, c.is_minor AS client_is_minor,
    s.title AS session_title, s.type AS session_type, s.status AS session_status,
    (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id) AS photo_count,
    (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.favorite = 1) AS favorite_count
  FROM galleries g
  LEFT JOIN clients c ON c.id = g.client_id
  LEFT JOIN sessions s ON s.id = g.session_id`;

function sessionOut(s) {
  const paid = Number(s.paid_cents || 0);
  return {
    ...s,
    client_is_minor: !!s.client_is_minor,
    paid_cents: paid,
    balance_cents: s.quoted_cents == null ? null : s.quoted_cents - paid,
    gallery_count: Number(s.gallery_count || 0),
  };
}

async function getSession(env, id) {
  const s = await env.DB.prepare(`${SESSION_SELECT} WHERE s.id = ?`).bind(id).first();
  return s ? sessionOut(s) : null;
}

async function querySessions(env, where, vals, suffix = SESSION_ORDER) {
  const { results } = await env.DB.prepare(
    `${SESSION_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ${suffix}`
  ).bind(...vals).all();
  return results.map(sessionOut);
}

async function getClient(env, id) {
  const c = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
  return c ? clientOut(c) : null;
}

/** column is whitelisted by callers ("client_id" or "session_id"). */
async function galleriesBy(env, column, id) {
  const col = column === "session_id" ? "g.session_id" : "g.client_id";
  const { results } = await env.DB.prepare(`${GALLERY_SELECT} WHERE ${col} = ? ORDER BY g.created_at DESC`)
    .bind(id).all();
  return results.map(adminGallery);
}

/* ---------- dashboard ---------- */

async function dashboard(env) {
  const settings = await getSettings(env);
  const now = Date.now();
  const replyHours = parseInt(settings.inquiry_reply_hours, 10) > 0 ? parseInt(settings.inquiry_reply_hours, 10) : 24;
  const shotDays = parseInt(settings.shot_no_gallery_days, 10) > 0 ? parseInt(settings.shot_no_gallery_days, 10) : 14;
  const replyCutoff = new Date(now - replyHours * HOUR).toISOString();
  const shotCutoff = new Date(now - shotDays * DAY).toISOString();
  const submittedCutoff = new Date(now - 60 * DAY).toISOString();
  const upcomingCutoff = new Date(now - 12 * HOUR).toISOString();

  const [countRows, newInq, needsGallery, selections, owed, noRetainer, upcoming] = await Promise.all([
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM sessions GROUP BY status").all(),
    env.DB.prepare(
      `SELECT i.*, c.name AS client_name FROM inquiries i JOIN clients c ON c.id = i.client_id
       WHERE i.status = 'new' ORDER BY i.created_at DESC`
    ).all(),
    querySessions(env, [
      // Shoot happened a while ago and there's still no gallery for it.
      "s.status = 'editing'", "s.starts_at IS NOT NULL", "s.starts_at < ?",
      "NOT EXISTS (SELECT 1 FROM galleries g WHERE g.session_id = s.id)",
    ], [shotCutoff], "ORDER BY s.starts_at ASC"),
    env.DB.prepare(
      `SELECT g.id, g.title, g.client_id, g.session_id, g.submitted_at, g.client_name AS gallery_client_name,
         c.name AS linked_client_name, s.status AS session_status,
         (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.favorite = 1) AS favorite_count
       FROM galleries g
       LEFT JOIN clients c ON c.id = g.client_id
       LEFT JOIN sessions s ON s.id = g.session_id
       WHERE g.submitted_at IS NOT NULL
         AND ((s.id IS NOT NULL AND s.status NOT IN ('delivered', 'done', 'archived'))
              OR (s.id IS NULL AND g.submitted_at >= ?))
       ORDER BY g.submitted_at ASC`
    ).bind(submittedCutoff).all(),
    querySessions(env, [
      "s.quoted_cents IS NOT NULL", `${PAID_SQL} < s.quoted_cents`,
      "s.status IN ('shot', 'editing', 'delivered', 'done')",
    ], [], "ORDER BY s.status_changed_at ASC"),
    // Only nag about missing retainers when the studio actually takes one (Settings > Retainer).
    settings.retainer_cents ? querySessions(env, [
      "s.status = 'booked'", "NOT EXISTS (SELECT 1 FROM payments p WHERE p.session_id = s.id)",
    ], [], SESSION_ORDER) : Promise.resolve([]),
    querySessions(env, ["s.status = 'booked'", "s.starts_at >= ?"], [upcomingCutoff],
      "ORDER BY s.starts_at ASC LIMIT 10"),
  ]);

  const counts = Object.fromEntries(SESSION_STATUSES.map((s) => [s, 0]));
  for (const r of countRows.results) if (r.status in counts) counts[r.status] = r.n;

  const item = (kind, title, detail, since, ids) => ({
    kind, title, detail,
    client_id: ids.client_id || null,
    session_id: ids.session_id || null,
    gallery_id: ids.gallery_id || null,
    inquiry_id: ids.inquiry_id || null,
    since,
  });

  const inquiries = newInq.results;
  const inquiryItem = (kind) => (i) => item(kind,
    kind === "reply_overdue" ? `Reply to ${i.client_name || i.name}` : `New inquiry from ${i.client_name || i.name}`,
    i.session_type ? `${statusLabel(i.session_type)} inquiry` : "Inquiry",
    i.created_at, { client_id: i.client_id, session_id: i.session_id, inquiry_id: i.id });

  const attention = [
    ...inquiries.filter((i) => i.created_at < replyCutoff).reverse().map(inquiryItem("reply_overdue")),
    ...inquiries.filter((i) => i.created_at >= replyCutoff).map(inquiryItem("new_inquiry")),
    ...needsGallery.map((s) => item("needs_gallery", `Make a gallery for ${s.client_name}`,
      `${sessionName(s)}, shot ${new Date(s.starts_at).toLocaleDateString("en-US", { timeZone: BRAND.timeZone, month: "short", day: "numeric" })}`, s.starts_at,
      { client_id: s.client_id, session_id: s.id })),
    ...selections.results.map((g) => item("selections_waiting",
      `${g.linked_client_name || g.gallery_client_name || "A client"} sent favorites`,
      `${g.title}: ${g.favorite_count} favorite${g.favorite_count === 1 ? "" : "s"}`,
      g.submitted_at, { client_id: g.client_id, session_id: g.session_id, gallery_id: g.id })),
    ...owed.map((s) => item("balance_owed", `${s.client_name} owes ${money(s.balance_cents)}`,
      `${sessionName(s)}: ${money(s.paid_cents)} of ${money(s.quoted_cents)} paid`, s.status_changed_at,
      { client_id: s.client_id, session_id: s.id })),
    ...noRetainer.map((s) => item("retainer_missing", `No retainer yet from ${s.client_name}`,
      `${sessionName(s)}${s.starts_at ? ` on ${localDateTime(s.starts_at).slice(0, 10)}` : ""} is booked with no payment`,
      s.status_changed_at, { client_id: s.client_id, session_id: s.id })),
  ];

  return json({
    counts,
    attention,
    upcoming,
    owner_name: settings.owner_name || BRAND.ownerName,
  });
}

/* ---------- clients ---------- */

async function listClients(env, url) {
  const q = cleanLine(url.searchParams.get("q"), 100);
  let limit = parseInt(url.searchParams.get("limit"), 10);
  if (!(limit > 0)) limit = 200;
  limit = Math.min(limit, 500);
  const vals = [];
  let where = "";
  if (q) {
    const like = `%${escapeLike(q.replace(/^@/, ""))}%`;
    where = `WHERE c.name LIKE ?1 ESCAPE '\\' OR c.email LIKE ?1 ESCAPE '\\'
             OR c.instagram LIKE ?1 ESCAPE '\\' OR c.phone LIKE ?1 ESCAPE '\\'`;
    vals.push(like);
  }
  vals.push(limit);
  const { results } = await env.DB.prepare(
    `${CLIENT_SELECT} ${where} ORDER BY c.created_at DESC LIMIT ?${vals.length}`
  ).bind(...vals).all();
  return json({ clients: results.map(clientOut) });
}

/**
 * Validate client fields present in body. Returns { fields } (only keys present) or { error }.
 * When requireName is true, name must be present and non-empty.
 */
function clientFields(body, requireName) {
  const f = {};
  if ("name" in body || requireName) {
    f.name = cleanLine(body.name, 200);
    if (!f.name) return { error: "Please enter the client's name." };
  }
  for (const key of ["email", "guardian_email"]) {
    if (!(key in body)) continue;
    f[key] = isBlank(body[key]) ? null : cleanEmail(body[key]);
    if (!isBlank(body[key]) && !f[key]) {
      return { error: key === "email" ? "That email address doesn't look right." : "The guardian's email doesn't look right." };
    }
  }
  if ("instagram" in body) {
    f.instagram = isBlank(body.instagram) ? null : cleanHandle(body.instagram);
    if (!isBlank(body.instagram) && !f.instagram) return { error: "That Instagram handle doesn't look right." };
  }
  if ("phone" in body) f.phone = cleanLine(body.phone, 40);
  if ("notes" in body) f.notes = cleanText(body.notes, 10000);
  if ("guardian_name" in body) f.guardian_name = cleanLine(body.guardian_name, 200);
  if ("source" in body) f.source = cleanLine(body.source, 100);
  if ("can_post" in body) {
    f.can_post = oneOf(body.can_post, CAN_POST);
    if (!f.can_post) return { error: "Posting permission must be yes, no, or ask." };
  }
  if ("is_minor" in body) f.is_minor = bool(body.is_minor) ? 1 : 0;
  return { fields: f };
}

async function emailTaken(env, email, exceptId) {
  if (!email) return null;
  return env.DB.prepare("SELECT id FROM clients WHERE email = ? AND id != ?").bind(email, exceptId || "").first();
}

async function createClient(env, body) {
  const { fields, error } = clientFields(body, true);
  if (error) return bad(error);
  const dup = await emailTaken(env, fields.email);
  if (dup) return json({ error: "Another client already has that email.", client_id: dup.id }, 409);

  const id = newId();
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO clients (id, name, email, phone, instagram, notes, can_post, is_minor,
       guardian_name, guardian_email, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, fields.name, fields.email ?? null, fields.phone ?? null, fields.instagram ?? null,
    fields.notes ?? null, fields.can_post || "ask", fields.is_minor || 0, fields.guardian_name ?? null,
    fields.guardian_email ?? null, fields.source ?? null, now, now).run();
  return json({ client: await getClient(env, id) }, 201);
}

async function getClientDetail(env, rawId) {
  const id = cleanId(rawId);
  const client = id && (await getClient(env, id));
  if (!client) return bad("Client not found", 404);
  const [sessions, galleries, payments, activity, inquiries] = await Promise.all([
    querySessions(env, ["s.client_id = ?"], [id]),
    galleriesBy(env, "client_id", id),
    env.DB.prepare(
      `SELECT p.*, s.title AS session_title, s.type AS session_type
       FROM payments p LEFT JOIN sessions s ON s.id = p.session_id
       WHERE p.client_id = ? ORDER BY p.paid_on DESC, p.created_at DESC`
    ).bind(id).all(),
    env.DB.prepare("SELECT * FROM activity WHERE client_id = ? ORDER BY created_at DESC LIMIT 200").bind(id).all(),
    env.DB.prepare("SELECT * FROM inquiries WHERE client_id = ? ORDER BY created_at DESC").bind(id).all(),
  ]);
  return json({
    client,
    sessions,
    galleries,
    payments: payments.results,
    activity: activity.results,
    inquiries: inquiries.results.map(inquiryOut),
  });
}

async function updateClient(env, rawId, body) {
  const id = cleanId(rawId);
  const existing = id && (await getClient(env, id));
  if (!existing) return bad("Client not found", 404);
  const { fields, error } = clientFields(body, false);
  if (error) return bad(error);
  if (fields.email) {
    const dup = await emailTaken(env, fields.email, id);
    if (dup) return json({ error: "Another client already has that email.", client_id: dup.id }, 409);
  }
  const keys = Object.keys(fields); // whitelisted by clientFields
  if (keys.length) {
    await env.DB.prepare(
      `UPDATE clients SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    ).bind(...keys.map((k) => fields[k]), nowIso(), id).run();
  }
  if (fields.can_post && fields.can_post !== existing.can_post) {
    await logActivity(env, { client_id: id, kind: "note", body: `Posting permission: ${fields.can_post}` });
  }
  return json({ client: await getClient(env, id) });
}

async function deleteClient(env, rawId) {
  const id = cleanId(rawId);
  const client = id && (await getClient(env, id));
  if (!client) return bad("Client not found", 404);
  const db = env.DB;
  await db.batch([
    db.prepare(
      `UPDATE galleries SET client_id = NULL, session_id = NULL
       WHERE client_id = ?1 OR session_id IN (SELECT id FROM sessions WHERE client_id = ?1)`
    ).bind(id),
    db.prepare("DELETE FROM payments WHERE client_id = ?1 OR session_id IN (SELECT id FROM sessions WHERE client_id = ?1)").bind(id),
    db.prepare("DELETE FROM activity WHERE client_id = ?").bind(id),
    db.prepare("DELETE FROM inquiries WHERE client_id = ?").bind(id),
    db.prepare("DELETE FROM sessions WHERE client_id = ?").bind(id),
    db.prepare("DELETE FROM clients WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function addActivity(env, rawId, body) {
  const id = cleanId(rawId);
  const client = id && (await getClient(env, id));
  if (!client) return bad("Client not found", 404);
  const kind = oneOf(body.kind, ["note", "contact"]);
  if (!kind) return bad("Activity must be a note or a contact.");
  let channel = null;
  if (!isBlank(body.channel)) {
    channel = oneOf(body.channel, CHANNELS);
    if (!channel) return bad("Pick instagram, email, text, call, or in person.");
  }
  let text = cleanText(body.body, 4000);
  if (kind === "note" && !text) return bad("Please write a note first.");
  if (kind === "contact" && !text) text = channel ? `Replied via ${channel}` : "Replied";

  const now = nowIso();
  const activity = { id: newId(), client_id: id, session_id: null, kind, body: text, created_at: now };
  const stmts = [
    env.DB.prepare(
      "INSERT INTO activity (id, client_id, session_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(activity.id, id, null, kind, text, now),
  ];
  if (kind === "contact") {
    stmts.push(
      env.DB.prepare("UPDATE clients SET last_contact_at = ?, updated_at = ? WHERE id = ?").bind(now, now, id),
      env.DB.prepare("UPDATE inquiries SET status = 'replied', replied_at = ? WHERE client_id = ? AND status = 'new'")
        .bind(now, id),
    );
  }
  await env.DB.batch(stmts);
  return json({ activity }, 201);
}

/* ---------- inquiries ---------- */

async function getInquiry(env, id) {
  const i = id && (await env.DB.prepare("SELECT * FROM inquiries WHERE id = ?").bind(id).first());
  return i ? inquiryOut(i) : null;
}

async function markReplied(env, rawId, body) {
  const id = cleanId(rawId);
  const inquiry = await getInquiry(env, id);
  if (!inquiry) return bad("Inquiry not found", 404);
  let channel = null;
  if (!isBlank(body.channel)) {
    channel = oneOf(body.channel, CHANNELS);
    if (!channel) return bad("Pick instagram, email, text, call, or in person.");
  }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE inquiries SET status = 'replied', replied_at = COALESCE(replied_at, ?) WHERE id = ?")
      .bind(now, id),
    env.DB.prepare("UPDATE clients SET last_contact_at = ?, updated_at = ? WHERE id = ?")
      .bind(now, now, inquiry.client_id),
  ]);
  await logActivity(env, {
    client_id: inquiry.client_id, session_id: inquiry.session_id, kind: "contact",
    body: channel ? `Replied to inquiry via ${channel}` : "Replied to inquiry",
  });
  return json({ inquiry: await getInquiry(env, id) });
}

async function updateInquiry(env, rawId, body) {
  const id = cleanId(rawId);
  const inquiry = await getInquiry(env, id);
  if (!inquiry) return bad("Inquiry not found", 404);
  const status = oneOf(body.status, INQUIRY_STATUSES);
  if (!status) return bad("Status must be new, replied, or closed.");
  const repliedAt = status === "new" ? null : status === "replied" ? inquiry.replied_at || nowIso() : inquiry.replied_at;
  await env.DB.prepare("UPDATE inquiries SET status = ?, replied_at = ? WHERE id = ?").bind(status, repliedAt, id).run();
  return json({ inquiry: await getInquiry(env, id) });
}

/* ---------- sessions ---------- */

async function listSessions(env, url) {
  const where = [];
  const vals = [];
  const status = url.searchParams.get("status") || "active";
  if (status === "active") {
    where.push(`s.status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`);
    vals.push(...ACTIVE_STATUSES);
  } else if (status !== "all") {
    // One stage, or several separated by commas (e.g. "shot,editing").
    const list = [...new Set(status.split(",").map((x) => normalizeStatus(x.trim())).filter(Boolean))];
    if (!list.length || list.some((x) => !oneOf(x, SESSION_STATUSES))) return bad("Unknown session status.");
    where.push(`s.status IN (${list.map(() => "?").join(", ")})`);
    vals.push(...list);
  }
  const clientId = cleanId(url.searchParams.get("client_id"));
  if (clientId) { where.push("s.client_id = ?"); vals.push(clientId); }
  const type = url.searchParams.get("type");
  if (type) {
    if (!oneOf(type, SESSION_TYPES)) return bad("Unknown session type.");
    where.push("s.type = ?");
    vals.push(type);
  }
  // Optional date window for the calendar: ?from=ISO&to=ISO (to is exclusive, max ~2 months).
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  if (fromRaw || toRaw) {
    const from = cleanDateTime(fromRaw);
    const to = cleanDateTime(toRaw);
    if (!from || !to || from >= to) return bad("Calendar range needs valid from and to dates.");
    if (new Date(to) - new Date(from) > 70 * 86400000) return bad("Calendar range is too long.");
    where.push("s.starts_at >= ? AND s.starts_at < ?");
    vals.push(from, to);
  }
  return json({ sessions: await querySessions(env, where, vals) });
}

/** Validate session fields present in body. Returns { fields } or { error }. */
function sessionFields(body) {
  const f = {};
  if ("type" in body) {
    f.type = oneOf(body.type, SESSION_TYPES);
    if (!f.type) return { error: "Session type must be graduation, engagement, event, or portrait." };
  }
  if ("status" in body) {
    f.status = oneOf(normalizeStatus(body.status), SESSION_STATUSES);
    if (!f.status) return { error: "Unknown session status." };
  }
  if ("title" in body) f.title = cleanLine(body.title, 200);
  if ("location" in body) f.location = cleanLine(body.location, 300);
  if ("notes" in body) f.notes = cleanText(body.notes, 10000);
  if ("starts_at" in body) {
    f.starts_at = isBlank(body.starts_at) ? null : cleanStartsAt(body.starts_at);
    if (!isBlank(body.starts_at) && !f.starts_at) return { error: "That date and time doesn't look right." };
  }
  if ("hours" in body) {
    f.hours = isBlank(body.hours) ? null : cleanNumber(body.hours, 48);
    if (!isBlank(body.hours) && f.hours == null) return { error: "Hours should be a number like 1 or 1.5." };
  }
  if ("quoted_cents" in body) {
    f.quoted_cents = isBlank(body.quoted_cents) ? null : cleanCents(body.quoted_cents);
    if (!isBlank(body.quoted_cents) && f.quoted_cents == null) return { error: "The quote doesn't look right." };
  }
  return { fields: f };
}

function endsAt(startsAt, hours) {
  if (!startsAt || !hours) return null;
  return new Date(new Date(startsAt).getTime() + hours * HOUR).toISOString();
}

async function createSession(env, body) {
  const clientId = cleanId(body.client_id);
  if (!clientId) return bad("Please pick a client for this session.");
  const client = await getClient(env, clientId);
  if (!client) return bad("That client no longer exists.");
  const { fields: f, error } = sessionFields(body);
  if (error) return bad(error);

  const id = newId();
  const now = nowIso();
  const status = f.status || "inquiry";
  await env.DB.prepare(
    `INSERT INTO sessions (id, client_id, type, title, starts_at, ends_at, hours, location, status,
       status_changed_at, quoted_cents, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, clientId, f.type || "portrait", f.title ?? null, f.starts_at ?? null,
    endsAt(f.starts_at, f.hours), f.hours ?? null, f.location ?? null, status, now,
    f.quoted_cents ?? null, f.notes ?? null, now, now).run();
  await logActivity(env, {
    client_id: clientId, session_id: id, kind: "status", body: `Session created (${statusLabel(status)})`,
  });
  return json({ session: await getSession(env, id) }, 201);
}

async function getSessionDetail(env, rawId) {
  const id = cleanId(rawId);
  const session = id && (await getSession(env, id));
  if (!session) return bad("Session not found", 404);
  const [client, payments, galleries] = await Promise.all([
    getClient(env, session.client_id),
    env.DB.prepare("SELECT * FROM payments WHERE session_id = ? ORDER BY paid_on DESC, created_at DESC").bind(id).all(),
    galleriesBy(env, "session_id", id),
  ]);
  return json({ session, client, payments: payments.results, galleries });
}

async function updateSession(env, rawId, body) {
  const id = cleanId(rawId);
  const existing = id && (await getSession(env, id));
  if (!existing) return bad("Session not found", 404);
  const { fields: f, error } = sessionFields(body);
  if (error) return bad(error);

  const stmts = [];
  if ("client_id" in body) {
    const clientId = cleanId(body.client_id);
    if (!clientId || !(await getClient(env, clientId))) return bad("That client no longer exists.");
    if (clientId !== existing.client_id) {
      f.client_id = clientId;
      stmts.push(
        env.DB.prepare("UPDATE payments SET client_id = ? WHERE session_id = ?").bind(clientId, id),
        env.DB.prepare("UPDATE galleries SET client_id = ? WHERE session_id = ?").bind(clientId, id),
      );
    }
  }
  const now = nowIso();
  const statusChanged = f.status && f.status !== existing.status;
  if (statusChanged) f.status_changed_at = now;
  if ("starts_at" in f || "hours" in f) {
    f.ends_at = endsAt("starts_at" in f ? f.starts_at : existing.starts_at, "hours" in f ? f.hours : existing.hours);
  }
  const keys = Object.keys(f); // whitelisted above
  if (keys.length) {
    stmts.unshift(env.DB.prepare(
      `UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    ).bind(...keys.map((k) => f[k]), now, id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  if (statusChanged) {
    const type = f.type || existing.type;
    await logActivity(env, {
      client_id: f.client_id || existing.client_id, session_id: id, kind: "status",
      body: `${sessionLabel({ type })}: ${statusLabel(existing.status)} → ${statusLabel(f.status)}`,
    });
  }
  return json({ session: await getSession(env, id) });
}

async function deleteSession(env, rawId) {
  const id = cleanId(rawId);
  const session = id && (await getSession(env, id));
  if (!session) return bad("Session not found", 404);
  await env.DB.batch([
    env.DB.prepare("UPDATE galleries SET session_id = NULL WHERE session_id = ?").bind(id),
    env.DB.prepare("UPDATE inquiries SET session_id = NULL WHERE session_id = ?").bind(id),
    env.DB.prepare("DELETE FROM payments WHERE session_id = ?").bind(id),
    env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id),
  ]);
  await logActivity(env, { client_id: session.client_id, kind: "status", body: `Deleted ${sessionName(session)}` });
  return json({ ok: true });
}

/* ---------- payments ---------- */

async function addPayment(env, rawId, body) {
  const id = cleanId(rawId);
  const session = id && (await getSession(env, id));
  if (!session) return bad("Session not found", 404);
  const amount = cleanCents(body.amount_cents);
  if (!amount) return bad("Please enter an amount greater than $0.");
  const method = oneOf(body.method, PAYMENT_METHODS);
  if (!method) return bad("Pick how they paid: Venmo, Zelle, cash, card, or other.");
  let kind = "other";
  if (!isBlank(body.kind)) {
    kind = oneOf(body.kind, PAYMENT_KINDS);
    if (!kind) return bad("Payment type must be retainer, balance, or other.");
  }
  let paidOn = todayChicago();
  if (!isBlank(body.paid_on)) {
    paidOn = cleanDate(body.paid_on);
    if (!paidOn) return bad("The payment date doesn't look right.");
  }
  const payment = {
    id: newId(), session_id: id, client_id: session.client_id, amount_cents: amount, currency: "usd",
    method, kind, paid_on: paidOn, note: cleanLine(body.note, 500), provider: "manual", provider_ref: null,
    created_at: nowIso(),
  };
  await env.DB.prepare(
    `INSERT INTO payments (id, session_id, client_id, amount_cents, currency, method, kind, paid_on, note,
       provider, created_at) VALUES (?, ?, ?, ?, 'usd', ?, ?, ?, ?, 'manual', ?)`
  ).bind(payment.id, id, session.client_id, amount, method, kind, paidOn, payment.note, payment.created_at).run();
  await logActivity(env, {
    client_id: session.client_id, session_id: id, kind: "payment",
    body: `${money(amount)} ${kind === "other" ? "payment" : kind} via ${METHOD_LABELS[method]}`,
  });
  return json({ payment, session: await getSession(env, id) }, 201);
}

async function deletePayment(env, rawId) {
  const id = cleanId(rawId);
  const payment = id && (await env.DB.prepare("SELECT * FROM payments WHERE id = ?").bind(id).first());
  if (!payment) return bad("Payment not found", 404);
  await env.DB.prepare("DELETE FROM payments WHERE id = ?").bind(id).run();
  await logActivity(env, {
    client_id: payment.client_id, session_id: payment.session_id, kind: "payment",
    body: `Removed ${money(payment.amount_cents)} ${payment.kind === "other" ? "payment" : payment.kind} from ${payment.paid_on}`,
  });
  return json({ ok: true, session: await getSession(env, payment.session_id) });
}

/* ---------- settings ---------- */

async function settingsResponse(env, settings) {
  return json({
    settings: settings || (await getSettings(env)),
    email: emailStatus(env),
    turnstile: !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET),
    cal_webhook: !!env.CAL_WEBHOOK_SECRET,
  });
}

/** Validate/normalize a partial settings object. Returns { values } or { error }. */
function validateSettings(input) {
  const out = {};
  for (const [k, raw] of Object.entries(input)) {
    if (raw != null && typeof raw === "object") return { error: `Setting ${k} must be text.` };
    out[k] = raw == null ? "" : String(raw);
  }
  for (const k of ["inquiry_reply_hours", "shot_no_gallery_days"]) {
    if (!(k in out)) continue;
    const v = out[k].trim();
    if (!/^\d{1,4}$/.test(v) || Number(v) < 1) {
      return { error: k === "inquiry_reply_hours" ? "Reply reminder hours must be a whole number above 0." : "Gallery reminder days must be a whole number above 0." };
    }
    out[k] = String(Number(v));
  }
  const ranges = {
    max_shoots_per_day: [1, 20, "Shoots per day must be a whole number from 1 to 20."],
    availability_days_ahead: [7, 365, "How far ahead must be between 7 and 365 days."],
    max_picked_days: [1, 14, "Days a client can pick must be from 1 to 14."],
  };
  for (const [k, [min, max, msg]] of Object.entries(ranges)) {
    if (!(k in out)) continue;
    const v = out[k].trim();
    if (!/^\d{1,3}$/.test(v) || Number(v) < min || Number(v) > max) return { error: msg };
    out[k] = String(Number(v));
  }
  if ("shoot_weekdays" in out) {
    const days = [...new Set(out.shoot_weekdays.split(",").map((x) => x.trim()).filter(Boolean))];
    if (days.some((d) => !/^[0-6]$/.test(d))) return { error: "Shoot days must be days of the week." };
    out.shoot_weekdays = days.sort().join(",");
  }
  if ("auto_reply_enabled" in out) {
    const v = out.auto_reply_enabled.trim();
    if (v !== "true" && v !== "false") return { error: "Auto-reply must be on or off." };
    out.auto_reply_enabled = v;
  }
  if ("retainer_cents" in out) {
    const v = out.retainer_cents.trim();
    if (v && !/^\d{1,10}$/.test(v)) return { error: "Retainer must be a whole number of cents." };
    out.retainer_cents = v;
  }
  if ("contact_email" in out) {
    const v = out.contact_email.trim();
    if (v && !cleanEmail(v)) return { error: "Contact email doesn't look like an email address." };
    out.contact_email = v ? cleanEmail(v) : "";
  }
  if ("instagram" in out) out.instagram = cleanHandle(out.instagram) || "";
  if ("cal_link" in out) {
    const v = out.cal_link.trim().replace(/^(https?:\/\/)?(www\.)?cal\.com\//i, "").replace(/^\/+|\/+$/g, "");
    if (v && !/^[A-Za-z0-9._~\-\/]{1,200}$/.test(v)) {
      return { error: "The Cal.com link should look like yourname/session." };
    }
    out.cal_link = v;
  }
  return { values: out };
}

async function updateSettings(env, body) {
  const input = body.settings;
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Nothing to save.");
  const { values, error } = validateSettings(input);
  if (error) return bad(error);
  return settingsResponse(env, await saveSettings(env, values));
}

/* ---------- availability (day picker) ---------- */

async function adminAvailability(env, url) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isDay(from) || !isDay(to) || from > to) return bad("Availability needs from and to dates (YYYY-MM-DD).");
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 70) return bad("Availability range is too long.");
  const settings = await getSettings(env);
  const map = await computeAvailability(env, settings, from, to, { withRequests: true });
  const cfg = availabilityConfig(settings);
  return json({
    config: { weekdays: [...cfg.weekdays], max_per_day: cfg.maxPerDay, days_ahead: cfg.daysAhead, max_picks: cfg.maxPicks },
    days: Object.fromEntries(map),
  });
}

async function setDayOverride(env, day, body) {
  if (!isDay(day)) return bad("That isn't a valid day.");
  const kind = oneOf(body.kind, ["blocked", "open"]);
  if (!kind) return bad("Choose whether to block or open the day.");
  const note = cleanLine(body.note, 200);
  await env.DB.prepare(
    `INSERT INTO day_overrides (day, kind, note, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET kind = excluded.kind, note = excluded.note`
  ).bind(day, kind, note, nowIso()).run();
  return json({ ok: true, day, kind, note });
}

async function clearDayOverride(env, day) {
  if (!isDay(day)) return bad("That isn't a valid day.");
  await env.DB.prepare("DELETE FROM day_overrides WHERE day = ?").bind(day).run();
  return json({ ok: true, day });
}

/* ---------- contracts ---------- */

function templateOut(t) {
  return { ...t, is_draft: !!t.is_draft };
}

async function listContracts(env) {
  let { results } = await env.DB.prepare("SELECT * FROM contract_templates ORDER BY created_at ASC").all();
  if (!results.length) {
    const now = nowIso();
    const seed = { id: newId(), name: "Session agreement (draft)", body: CONTRACT_DRAFT, is_draft: 1, created_at: now, updated_at: now };
    await env.DB.prepare(
      "INSERT INTO contract_templates (id, name, body, is_draft, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(seed.id, seed.name, seed.body, now, now).run();
    results = [seed];
  }
  return json({ templates: results.map(templateOut), merge_fields: MERGE_FIELDS });
}

async function saveContract(env, rawId, body) {
  let id = null;
  if (rawId != null) {
    id = cleanId(rawId);
    const existing = id && (await env.DB.prepare("SELECT id FROM contract_templates WHERE id = ?").bind(id).first());
    if (!existing) return bad("Template not found", 404);
  }
  const name = cleanLine(body.name, 200);
  if (!name) return bad("Please give the template a name.");
  if (typeof body.body === "string" && body.body.trim().length > CONTRACT_MAX) {
    return bad("That template is too long (50,000 characters max).");
  }
  const text = cleanText(body.body, CONTRACT_MAX);
  if (!text) return bad("The template can't be empty.");
  const now = nowIso();
  if (id) {
    await env.DB.prepare("UPDATE contract_templates SET name = ?, body = ?, is_draft = 1, updated_at = ? WHERE id = ?")
      .bind(name, text, now, id).run();
  } else {
    id = newId();
    await env.DB.prepare(
      "INSERT INTO contract_templates (id, name, body, is_draft, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(id, name, text, now, now).run();
  }
  const template = await env.DB.prepare("SELECT * FROM contract_templates WHERE id = ?").bind(id).first();
  return json({ template: templateOut(template) }, rawId == null ? 201 : 200);
}

async function deleteContract(env, rawId) {
  const id = cleanId(rawId);
  const existing = id && (await env.DB.prepare("SELECT id FROM contract_templates WHERE id = ?").bind(id).first());
  if (!existing) return bad("Template not found", 404);
  await env.DB.prepare("DELETE FROM contract_templates WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

/* ---------- CSV exports ---------- */

function exportName(kind) {
  return `${BRAND.fileSlug}-${kind}-${todayChicago()}.csv`;
}

async function clientsCsv(env) {
  const { results } = await env.DB.prepare(`${CLIENT_SELECT} ORDER BY c.created_at DESC`).all();
  const headers = ["Name", "Email", "Phone", "Instagram", "Can post", "Minor", "Guardian name", "Guardian email",
    "Source", "Sessions", "Last session (Central)", "Open inquiries", "Balance owed", "Last contact (Central)",
    "Notes", "Created (Central)"];
  const rows = results.map((c) => [
    c.name, c.email, c.phone, c.instagram, c.can_post, c.is_minor ? "yes" : "no", c.guardian_name,
    c.guardian_email, c.source, c.session_count, localDateTime(c.last_session_at), c.open_inquiries,
    dollars(c.balance_cents), localDateTime(c.last_contact_at), c.notes, localDateTime(c.created_at),
  ]);
  return toCsv(headers, rows);
}

async function sessionsCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, c.name AS client_name, c.email AS client_email, ${PAID_SQL} AS paid_cents
     FROM sessions s JOIN clients c ON c.id = s.client_id ${SESSION_ORDER}`
  ).all();
  const headers = ["Title", "Type", "Status", "Starts (Central)", "Hours", "Location", "Client", "Client email",
    "Quoted", "Paid", "Balance", "Notes", "Created (Central)"];
  const rows = results.map((s) => [
    s.title, s.type, s.status, localDateTime(s.starts_at), s.hours, s.location, s.client_name, s.client_email,
    dollars(s.quoted_cents), dollars(s.paid_cents),
    s.quoted_cents == null ? "" : dollars(s.quoted_cents - s.paid_cents), s.notes, localDateTime(s.created_at),
  ]);
  return toCsv(headers, rows);
}

async function paymentsCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, c.name AS client_name, s.title AS session_title, s.type AS session_type
     FROM payments p
     LEFT JOIN clients c ON c.id = p.client_id
     LEFT JOIN sessions s ON s.id = p.session_id
     ORDER BY p.paid_on DESC, p.created_at DESC`
  ).all();
  const headers = ["Paid on", "Amount", "Method", "Type", "Client", "Session", "Session type", "Note", "Recorded (Central)"];
  const rows = results.map((p) => [
    p.paid_on, dollars(p.amount_cents), p.method, p.kind, p.client_name, p.session_title, p.session_type, p.note,
    localDateTime(p.created_at),
  ]);
  return toCsv(headers, rows);
}

async function inquiriesCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT i.*, s.title AS session_title, s.status AS session_status FROM inquiries i
     LEFT JOIN sessions s ON s.id = i.session_id ORDER BY i.created_at DESC`
  ).all();
  const headers = ["Received (Central)", "Name", "Email", "Phone", "Instagram", "Session type", "Days asked for",
    "Date notes", "Location", "People", "Usage", "How they found you", "Came from", "Message", "Status",
    "Replied (Central)", "Session", "Session status"];
  const days = (v) => { try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a.join("; ") : String(v); } catch { return v; } };
  const rows = results.map((i) => [
    localDateTime(i.created_at), i.name, i.email, i.phone, i.instagram, i.session_type, days(i.preferred_dates),
    i.date_notes, i.location, i.people_count, i.usage, i.referral, i.came_from, i.message, i.status,
    localDateTime(i.replied_at), i.session_title, i.session_status,
  ]);
  return toCsv(headers, rows);
}

async function galleriesCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id) AS photo_count,
            (SELECT COUNT(*) FROM photos p WHERE p.gallery_id = g.id AND p.favorite = 1) AS favorite_count,
            (SELECT group_concat(filename, '; ') FROM (SELECT filename FROM photos p WHERE p.gallery_id = g.id AND p.favorite = 1 ORDER BY filename)) AS favorites
     FROM galleries g ORDER BY g.created_at DESC`
  ).all();
  const headers = ["Title", "Client", "Client email", "Link code", "Photos", "Favorites picked", "Favorite files",
    "Favorites sent (Central)", "Client note", "Downloads allowed", "Expires", "Created (Central)"];
  const rows = results.map((g) => [
    g.title, g.client_name, g.client_email, g.slug, g.photo_count, g.favorite_count, g.favorites,
    localDateTime(g.submitted_at), g.client_note, g.allow_downloads ? "yes" : "no", g.expires_at, localDateTime(g.created_at),
  ]);
  return toCsv(headers, rows);
}

const EXPORTS = {
  "clients.csv": clientsCsv, "sessions.csv": sessionsCsv, "payments.csv": paymentsCsv,
  "inquiries.csv": inquiriesCsv, "galleries.csv": galleriesCsv,
};

const README = (site, when) => `Your data from ${site}, exported ${when}.

Spreadsheets (open in Excel, Numbers or Google Sheets):
  clients.csv     everyone in your client list
  sessions.csv    every session, with quoted / paid / balance
  payments.csv    every payment you recorded
  inquiries.csv   every inquiry from your website form
  galleries.csv   every client gallery and the favorites they picked

complete-backup.json is a full copy of the database (every field of every table).
It can be used to restore the site or move your data somewhere else.

Gallery photos are not included: they are copies of your own edited files.
`;

async function exportEverything(env) {
  const files = [];
  for (const [name, build] of Object.entries(EXPORTS)) files.push({ name, data: await build(env) });
  const dump = await dumpAll(env);
  files.push({ name: "complete-backup.json", data: JSON.stringify(dump, null, 1) });
  files.unshift({ name: "README.txt", data: README(BRAND.businessName, todayChicago()) });
  const zip = zipFiles(files);
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${BRAND.fileSlug}-export-${todayChicago()}.zip"`,
      "cache-control": "no-store",
    },
  });
}

async function downloadBackup(env, name) {
  const key = backupKey(name);
  const obj = key && (await env.PHOTOS.get(key));
  if (!obj) return bad("Backup not found", 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${BRAND.fileSlug}-backup-${name}"`,
      "cache-control": "no-store",
    },
  });
}
