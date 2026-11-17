/* Day-level availability for the inquiry form's day picker (and the admin calendar).
 *
 * A day is OPEN when all of these hold:
 *   - it is within the booking window (tomorrow .. today + availability_days_ahead),
 *   - it is a shoot weekday (Settings: shoot_weekdays) OR has an 'open' override,
 *   - it has no 'blocked' override,
 *   - it has fewer than max_shoots_per_day sessions in a counted stage.
 * Only confirmed work counts toward the limit; inquiries never block a day.
 */

import { BRAND } from "./brand.js";

export const COUNTED_STATUSES = ["booked", "shot", "editing", "delivered", "done"];
const MAX_WINDOW_DAYS = 400;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BRAND.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

/** ISO instant -> "YYYY-MM-DD" in studio time. */
export const studioDay = (iso) => keyFmt.format(new Date(iso));

export const isDay = (v) => typeof v === "string" && DAY_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** "YYYY-MM-DD" + n days. */
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

/** Parse settings into numbers/sets with safe fallbacks. */
export function availabilityConfig(settings) {
  const weekdays = new Set(
    String(settings.shoot_weekdays ?? "0,6").split(",").map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 6)
  );
  const int = (v, def, min, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  return {
    weekdays,
    maxPerDay: int(settings.max_shoots_per_day, 3, 1, 20),
    daysAhead: int(settings.availability_days_ahead, 90, 7, 365),
    maxPicks: int(settings.max_picked_days, 5, 1, 14),
  };
}

/** The window clients may pick from: tomorrow (studio time) .. today + daysAhead. */
export function bookingWindow(cfg) {
  const today = keyFmt.format(new Date());
  return { today, first: addDays(today, 1), last: addDays(today, cfg.daysAhead) };
}

/**
 * Compute availability for [from, to] inclusive (YYYY-MM-DD).
 * Returns Map(day -> { open, count, override: 'blocked'|'open'|null, note, reason, requests? }).
 * reason: 'past' | 'outside' | 'not_shoot_day' | 'blocked' | 'full' | null
 * With { withRequests: true } also counts open inquiries that picked each day (admin only).
 */
export async function computeAvailability(env, settings, from, to, { withRequests = false } = {}) {
  const cfg = availabilityConfig(settings);
  const win = bookingWindow(cfg);
  if (!isDay(from) || !isDay(to) || from > to) throw new Error("bad range");
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_WINDOW_DAYS) throw new Error("range too long");

  // Sessions: pad one day on each side in UTC, then bucket by studio-local day.
  const padFrom = `${addDays(from, -1)}T00:00:00.000Z`;
  const padTo = `${addDays(to, 2)}T00:00:00.000Z`;
  const statusMarks = COUNTED_STATUSES.map(() => "?").join(", ");
  const [sessions, overrides, inquiries] = await Promise.all([
    env.DB.prepare(
      `SELECT starts_at FROM sessions WHERE starts_at >= ? AND starts_at < ? AND status IN (${statusMarks})`
    ).bind(padFrom, padTo, ...COUNTED_STATUSES).all(),
    env.DB.prepare("SELECT day, kind, note FROM day_overrides WHERE day >= ? AND day <= ?").bind(from, to).all(),
    withRequests
      ? env.DB.prepare("SELECT preferred_dates FROM inquiries WHERE status = 'new' AND preferred_dates IS NOT NULL").all()
      : Promise.resolve({ results: [] }),
  ]);

  const counts = new Map();
  for (const s of sessions.results) {
    const k = studioDay(s.starts_at);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const ovr = new Map(overrides.results.map((o) => [o.day, o]));
  const requests = new Map();
  for (const q of inquiries.results) {
    let days = [];
    try { days = JSON.parse(q.preferred_dates) || []; } catch { /* legacy free text */ }
    for (const d of Array.isArray(days) ? days : []) if (isDay(d)) requests.set(d, (requests.get(d) || 0) + 1);
  }

  const out = new Map();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const count = counts.get(day) || 0;
    const o = ovr.get(day);
    const shootDay = cfg.weekdays.has(weekdayOf(day));
    let reason = null;
    if (day <= win.today) reason = "past";
    else if (day > win.last) reason = "outside";
    else if (o && o.kind === "blocked") reason = "blocked";
    else if (!shootDay && !(o && o.kind === "open")) reason = "not_shoot_day";
    else if (count >= cfg.maxPerDay) reason = "full";
    const entry = { open: reason === null, count, override: o ? o.kind : null, note: o ? o.note || null : null, reason, shoot_day: shootDay };
    if (withRequests) entry.requests = requests.get(day) || 0;
    out.set(day, entry);
  }
  return out;
}

/** Public view: only which days in the booking window are open. No counts. */
export async function publicAvailability(env, settings) {
  const cfg = availabilityConfig(settings);
  const win = bookingWindow(cfg);
  const map = await computeAvailability(env, settings, win.first, win.last);
  const open = [];
  for (const [day, a] of map) if (a.open) open.push(day);
  return { first: win.first, last: win.last, max_picks: cfg.maxPicks, open_days: open };
}
