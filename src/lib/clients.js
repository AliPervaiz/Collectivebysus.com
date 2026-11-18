/* Shared client/session/activity helpers used by inquiry, webhook and CRM routes. */

import { newId, nowIso, cleanEmail } from "./util.js";

export const SESSION_TYPES = ["graduation", "engagement", "event", "portrait"];
export const SESSION_STATUSES = ["inquiry", "booked", "editing", "done", "archived"];
// Retired stages (2026-11-18) and where they went. Accepted on input so old links/integrations keep working.
export const LEGACY_STATUS = { shot: "editing", delivered: "done", lost: "archived" };
export const normalizeStatus = (v) => (typeof v === "string" && LEGACY_STATUS[v]) || v;
export const CAN_POST = ["yes", "no", "ask"];
export const PAYMENT_METHODS = ["venmo", "zelle", "cash", "card", "other"];
export const PAYMENT_KINDS = ["retainer", "balance", "other"];
export const ACTIVITY_KINDS = ["inquiry", "note", "contact", "status", "payment", "booking", "gallery"];

/**
 * Find a client by email (case-insensitive) or create one. Fills in blank
 * fields (phone, instagram, name) on an existing client but never overwrites.
 * fields: { name, email, phone, instagram, source }
 * Returns { client, created }.
 */
export async function findOrCreateClient(env, fields) {
  const email = cleanEmail(fields.email);
  const now = nowIso();
  if (email) {
    const existing = await env.DB.prepare("SELECT * FROM clients WHERE email = ?").bind(email).first();
    if (existing) {
      await env.DB.prepare(
        `UPDATE clients SET
           name = COALESCE(NULLIF(name, ''), ?),
           phone = COALESCE(phone, ?),
           instagram = COALESCE(instagram, ?),
           updated_at = ?
         WHERE id = ?`
      ).bind(fields.name || null, fields.phone || null, fields.instagram || null, now, existing.id).run();
      const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(existing.id).first();
      return { client, created: false };
    }
  }
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO clients (id, name, email, phone, instagram, source, can_post, is_minor, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ask', 0, ?, ?)`
  ).bind(id, fields.name || email || "Unnamed client", email, fields.phone || null, fields.instagram || null,
    fields.source || null, now, now).run();
  const client = await env.DB.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first();
  return { client, created: true };
}

/** Append to the activity log. */
export async function logActivity(env, { client_id, session_id = null, kind, body }) {
  await env.DB.prepare(
    "INSERT INTO activity (id, client_id, session_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(newId(), client_id, session_id, kind, String(body || "").slice(0, 4000), nowIso()).run();
}
