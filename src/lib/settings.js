/* Business settings stored in the D1 `settings` table (key/value). */

import { nowIso } from "./util.js";
import { BRAND } from "./brand.js";

// key -> { default, max length, public? }
export const SETTINGS_SCHEMA = {
  business_name:        { def: BRAND.businessName, max: 120, pub: true },
  owner_name:           { def: BRAND.ownerName, max: 120, pub: true },
  contact_email:        { def: BRAND.contactEmail, max: 200, pub: true },
  instagram:            { def: BRAND.instagram, max: 60, pub: true },
  price_note:           { def: "Sessions are booked by the hour. Most grad and portrait sessions are 1–2 hours; engagements and events vary. I'll send exact pricing with my reply.", max: 1000, pub: true },
  hourly_rate_text:     { def: "", max: 200, pub: true },
  retainer_cents:       { def: "", max: 12 },
  retainer_note:        { def: "A retainer holds your date and goes toward your total.", max: 500, pub: true },
  turnaround:           { def: "Edited photos are usually delivered within 2–3 weeks (a little longer in grad season).", max: 500, pub: true },
  reply_promise:        { def: "I'll get back to you within 24 hours.", max: 300, pub: true },
  cal_link:             { def: BRAND.calLinkDefault, max: 200, pub: true },
  policy_cancellation:  { def: "", max: 5000 },
  policy_weather:       { def: "", max: 5000 },
  policy_posting:       { def: "", max: 5000 },
  auto_reply_enabled:   { def: "false", max: 5 },
  auto_reply_text:      { def: `Hi {{first_name}},\n\nThank you for reaching out! I got your inquiry and will reply personally within 24 hours.\n\nTalk soon,\n${BRAND.ownerFirstName}\n{{business_name}}`, max: 5000 },
  inquiry_reply_hours:  { def: "24", max: 4 },
  shot_no_gallery_days: { def: "14", max: 4 },
  // Day picker on the inquiry form (see src/lib/availability.js).
  shoot_weekdays:          { def: "0,6", max: 20 },   // 0 = Sunday ... 6 = Saturday
  max_shoots_per_day:      { def: "3", max: 2 },
  availability_days_ahead: { def: "90", max: 3 },
  max_picked_days:         { def: "5", max: 2, pub: true },
};

export async function getSettings(env) {
  const out = {};
  for (const [k, s] of Object.entries(SETTINGS_SCHEMA)) out[k] = s.def;
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  for (const r of results) if (r.key in SETTINGS_SCHEMA && r.value != null) out[r.key] = r.value;
  return out;
}

/** Only the fields safe for the public site. */
export function publicSettings(settings) {
  const out = {};
  for (const [k, s] of Object.entries(SETTINGS_SCHEMA)) if (s.pub) out[k] = settings[k];
  return out;
}

/** Upsert known keys from a partial object; unknown keys are ignored. Returns full settings. */
export async function saveSettings(env, partial) {
  const now = nowIso();
  const stmts = [];
  for (const [k, s] of Object.entries(SETTINGS_SCHEMA)) {
    if (!(k in partial)) continue;
    const v = partial[k] == null ? "" : String(partial[k]).slice(0, s.max);
    stmts.push(
      env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(k, v, now)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return getSettings(env);
}
