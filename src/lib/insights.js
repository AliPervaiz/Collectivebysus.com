/* Insights for the admin: where inquiries come from, how many book, reply speed,
 * bookings/revenue by month and type, most-requested days, gallery follow-through.
 * Everything is computed from the CRM's own tables; nothing leaves the site. */

import { BRAND } from "./brand.js";

const BOOKED = ["booked", "editing", "done"]; // an inquiry "booked" when its session reached one of these
const DAY = 86400000;
const monthFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BRAND.timeZone, year: "numeric", month: "2-digit" });
const monthKey = (iso) => monthFmt.format(new Date(iso)).slice(0, 7); // "YYYY-MM" in studio time

/** Period from ?range=12m|ytd|all → { from, to, label, months[] }. */
function period(range, now = new Date()) {
  const cur = monthKey(now.toISOString());
  const [cy, cm] = cur.split("-").map(Number);
  let startY, startM, label;
  if (range === "ytd") { startY = cy; startM = 1; label = "This year"; }
  else if (range === "all") { startY = null; label = "All time"; }
  else { const t = cy * 12 + (cm - 1) - 11; startY = Math.floor(t / 12); startM = (t % 12) + 1; label = "Last 12 months"; }
  const from = startY == null ? "0000-01-01T00:00:00.000Z" : new Date(Date.UTC(startY, startM - 1, 1)).toISOString();
  return { from, to: now.toISOString(), label, range: range === "ytd" || range === "all" ? range : "12m" };
}

/** List of "YYYY-MM" from first..last inclusive. */
function monthsBetween(first, last) {
  const out = [];
  let [y, m] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
    if (out.length > 240) break;
  }
  return out;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null); // one decimal %

function tally(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, { key: k, inquiries: 0, booked: 0 });
    const e = map.get(k);
    e.inquiries += 1;
    if (BOOKED.includes(r.session_status)) e.booked += 1;
  }
  return [...map.values()]
    .map((e) => ({ ...e, rate: rate(e.booked, e.inquiries) }))
    .sort((a, b) => b.inquiries - a.inquiries || a.key.localeCompare(b.key));
}

export async function insights(env, url) {
  const p = period(url.searchParams.get("range"));
  const [inq, sess, pays, gals, settingsRow, upcoming] = await Promise.all([
    env.DB.prepare(
      `SELECT i.created_at, i.replied_at, i.came_from, i.referral, i.preferred_dates, i.session_type,
              s.status AS session_status
       FROM inquiries i LEFT JOIN sessions s ON s.id = i.session_id
       WHERE i.created_at >= ? AND i.created_at <= ?`
    ).bind(p.from, p.to).all(),
    env.DB.prepare(
      `SELECT type, status, starts_at FROM sessions
       WHERE status IN ('booked', 'editing', 'done') AND starts_at IS NOT NULL AND starts_at >= ? AND starts_at <= ?`
    ).bind(p.from, p.to).all(),
    env.DB.prepare(
      `SELECT p.amount_cents, p.paid_on, s.type FROM payments p LEFT JOIN sessions s ON s.id = p.session_id
       WHERE p.paid_on >= ? AND p.paid_on <= ?`
    ).bind(p.from.slice(0, 10), p.to.slice(0, 10)).all(),
    env.DB.prepare(
      `SELECT g.created_at, g.submitted_at,
              (SELECT COUNT(*) FROM photos ph WHERE ph.gallery_id = g.id) AS photo_count,
              (SELECT COUNT(*) FROM photos ph WHERE ph.gallery_id = g.id AND ph.favorite = 1) AS favorite_count
       FROM galleries g WHERE g.created_at >= ? AND g.created_at <= ?`
    ).bind(p.from, p.to).all(),
    env.DB.prepare("SELECT MIN(created_at) AS first FROM inquiries").first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE status = 'booked' AND starts_at > ?").bind(p.to).first(),
  ]);
  const inquiries = inq.results;

  // Month axis: the period's months (for "all", from the first record we have).
  const firstKeys = [
    ...inquiries.map((r) => r.created_at), ...sess.results.map((r) => r.starts_at),
    ...pays.results.map((r) => `${r.paid_on}T12:00:00Z`),
  ].filter(Boolean).map(monthKey).sort();
  const nowKey = monthKey(p.to);
  const startKey = p.range === "all" ? (firstKeys[0] || nowKey) : monthKey(p.from);
  const months = monthsBetween(startKey, nowKey);

  const byMonth = Object.fromEntries(months.map((m) => [m, { month: m, inquiries: 0, bookings: 0, revenue_cents: 0 }]));
  for (const r of inquiries) { const k = monthKey(r.created_at); if (byMonth[k]) byMonth[k].inquiries += 1; }
  for (const r of sess.results) { const k = monthKey(r.starts_at); if (byMonth[k]) byMonth[k].bookings += 1; }
  for (const r of pays.results) { const k = r.paid_on.slice(0, 7); if (byMonth[k]) byMonth[k].revenue_cents += r.amount_cents || 0; }

  // Reply speed (hours) for inquiries that were replied to.
  const replyHours = inquiries.filter((r) => r.replied_at).map((r) => (Date.parse(r.replied_at) - Date.parse(r.created_at)) / 3600000).filter((h) => h >= 0);
  const within24 = replyHours.filter((h) => h <= 24).length;

  // Session types: bookings (by shoot date) and revenue (by payment date).
  const types = {};
  for (const r of sess.results) { types[r.type] = types[r.type] || { type: r.type, bookings: 0, revenue_cents: 0 }; types[r.type].bookings += 1; }
  for (const r of pays.results) { const t = r.type || "other"; types[t] = types[t] || { type: t, bookings: 0, revenue_cents: 0 }; types[t].revenue_cents += r.amount_cents || 0; }

  // Most-requested days (from the inquiry day picker).
  const asks = new Map();
  for (const r of inquiries) {
    let days = [];
    try { days = JSON.parse(r.preferred_dates || "[]"); } catch { /* older free-text dates */ }
    for (const d of Array.isArray(days) ? days : []) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) asks.set(d, (asks.get(d) || 0) + 1);
  }
  const topDays = [...asks.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => b.count - a.count || a.day.localeCompare(b.day)).slice(0, 6);
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  for (const [d, c] of asks) weekday[new Date(`${d}T12:00:00Z`).getUTCDay()] += c;

  // Galleries: shared → favorites sent, and how long clients took.
  const galleries = gals.results.filter((g) => g.photo_count > 0);
  const submitted = galleries.filter((g) => g.submitted_at);
  const daysToSubmit = submitted.map((g) => (Date.parse(g.submitted_at) - Date.parse(g.created_at)) / DAY).filter((d) => d >= 0);

  const booked = inquiries.filter((r) => BOOKED.includes(r.session_status)).length;
  const revenue = pays.results.reduce((a, r) => a + (r.amount_cents || 0), 0);

  return {
    period: { range: p.range, label: p.label, from: p.from, to: p.to },
    has_data: !!(inquiries.length || sess.results.length || pays.results.length || galleries.length),
    totals: {
      inquiries: inquiries.length,
      booked_inquiries: booked,
      booking_rate: rate(booked, inquiries.length),
      bookings: sess.results.length,
      upcoming_bookings: upcoming ? upcoming.n : 0,
      revenue_cents: revenue,
      replied: replyHours.length,
      median_reply_hours: replyHours.length ? Math.round(median(replyHours) * 10) / 10 : null,
      replied_within_24h_rate: rate(within24, replyHours.length),
      unanswered: inquiries.filter((r) => !r.replied_at).length,
    },
    months: months.map((m) => byMonth[m]),
    sources: tally(inquiries, (r) => r.came_from || "Not tracked"),
    said_found_via: tally(inquiries.filter((r) => r.referral), (r) => r.referral),
    types: Object.values(types).sort((a, b) => b.bookings - a.bookings || b.revenue_cents - a.revenue_cents),
    requested_days: { top: topDays, by_weekday: weekday },
    galleries: {
      shared: galleries.length,
      favorites_sent: submitted.length,
      favorites_rate: rate(submitted.length, galleries.length),
      median_days_to_send: daysToSubmit.length ? Math.round(median(daysToSubmit) * 10) / 10 : null,
      median_favorites: submitted.length ? median(submitted.map((g) => g.favorite_count)) : null,
    },
    first_inquiry_at: settingsRow ? settingsRow.first : null,
  };
}
