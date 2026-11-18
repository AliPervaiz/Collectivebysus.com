/* Insights: how the business is doing. Single-series charts only (one brand color),
 * every bar has a hover/focus tooltip, and each chart has a table view. */

import { el, api, startView, errorView, fmtMoney, label, plural, TYPE_LABELS } from "./lib.js";

const RANGES = [["12m", "Last 12 months"], ["ytd", "This year"], ["all", "All time"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const monthLabel = (k) => { const [y, m] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${String(y).slice(2)}`; };
const monthLong = (k) => { const [y, m] = k.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const pct = (v) => (v == null ? "–" : `${Math.round(v)}%`);
const dayLabel = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

function replyTime(h) {
  if (h == null) return "–";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 36) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

/* ---------- shared tooltip ---------- */

let tip;
function tooltip() {
  if (!tip || !tip.isConnected) { tip = el("div", { class: "ins-tip", role: "tooltip", hidden: true }); document.body.append(tip); }
  return tip;
}
function bindTip(node, text) {
  const show = () => {
    const t = tooltip(); t.textContent = text; t.hidden = false;
    const r = node.getBoundingClientRect(), tr = t.getBoundingClientRect();
    t.style.left = `${Math.min(window.innerWidth - tr.width - 8, Math.max(8, r.left + r.width / 2 - tr.width / 2))}px`;
    t.style.top = `${Math.max(8, r.top - tr.height - 8)}px`;
  };
  const hide = () => { if (tip) tip.hidden = true; };
  node.addEventListener("mouseenter", show); node.addEventListener("focus", show);
  node.addEventListener("mouseleave", hide); node.addEventListener("blur", hide);
}

/* ---------- pieces ---------- */

const tile = (value, title, sub) => el("div", { class: "ins-tile" },
  el("span", { class: "ins-tile-label" }, title),
  el("strong", { class: "ins-tile-value" }, value),
  sub ? el("span", { class: "ins-tile-sub" }, sub) : null);

/** Vertical bar chart over months. values: [{ key, value, text }]. */
function monthBars(title, rows, { fmt = String, unit = "" } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const plot = el("div", { class: "ins-bars", role: "list", "aria-label": title },
    rows.map((r) => {
      const bar = el("div", { class: "ins-bar", role: "listitem", tabindex: "0", "aria-label": `${monthLong(r.key)}: ${fmt(r.value)}${unit}` },
        el("span", { class: "ins-bar-fill", style: `height:${(r.value / max) * 100}%` }));
      bindTip(bar, `${monthLong(r.key)}: ${fmt(r.value)}${unit}`);
      return bar;
    }));
  const step = Math.max(1, Math.ceil(rows.length / 6)); // label at most ~6 months
  const axis = el("div", { class: "ins-axis", "aria-hidden": "true" },
    rows.map((r, i) => el("span", {}, i % step === 0 || i === rows.length - 1 ? monthLabel(r.key) : "")));
  const peak = rows.reduce((a, r) => (r.value > a.value ? r : a), rows[0] || { value: 0 });
  return el("section", { class: "panel ins-chart" },
    el("div", { class: "ins-chart-head" },
      el("h2", { class: "h4" }, title),
      peak && peak.value ? el("span", { class: "ins-chart-note" }, `Best: ${monthLong(peak.key)} (${fmt(peak.value)}${unit})`) : null),
    el("div", { class: "ins-plot" }, el("span", { class: "ins-max", "aria-hidden": "true" }, `${fmt(max)}${unit}`), plot),
    axis,
    tableView(["Month", title], rows.map((r) => [monthLong(r.key), `${fmt(r.value)}${unit}`])));
}

/** Horizontal bars: rows [{ name, value, detail }]. */
function hBars(title, rows, { empty = "Nothing yet.", note } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return el("section", { class: "panel ins-chart" },
    el("div", { class: "ins-chart-head" }, el("h2", { class: "h4" }, title), note ? el("span", { class: "ins-chart-note" }, note) : null),
    rows.length
      ? el("div", { class: "ins-hbars", role: "list" }, rows.map((r) => {
          const row = el("div", { class: "ins-hrow", role: "listitem", tabindex: "0", "aria-label": `${r.name}: ${r.value}. ${r.detail || ""}` },
            el("span", { class: "ins-hname" }, r.name),
            el("span", { class: "ins-htrack" }, el("span", { class: "ins-hfill", style: `width:${(r.value / max) * 100}%` })),
            el("span", { class: "ins-hval" }, String(r.value)),
            r.detail ? el("span", { class: "ins-hdetail" }, r.detail) : null);
          bindTip(row, `${r.name}: ${r.value}${r.detail ? ` · ${r.detail}` : ""}`);
          return row;
        }))
      : el("p", { class: "admin-muted small-text", style: "margin:0" }, empty));
}

function tableView(head, rows) {
  return el("details", { class: "ins-table" },
    el("summary", {}, "Show as table"),
    el("table", {},
      el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, rows.map((r) => el("tr", {}, r.map((c, i) => (i === 0 ? el("th", { scope: "row" }, c) : el("td", {}, c))))))));
}

/* ---------- page ---------- */

export async function renderInsights(query = new URLSearchParams()) {
  const range = RANGES.some(([k]) => k === query.get("range")) ? query.get("range") : "12m";
  const mount = startView();
  let d;
  try { d = await api(`/insights?range=${range}`); }
  catch (err) { return mount(...errorView(err)); }
  const t = d.totals;

  const head = el("div", { class: "admin-head" },
    el("div", {}, el("h1", {}, "Insights"), el("p", { class: "sub" }, d.period.label)),
    el("div", { class: "filter-chips", role: "navigation", "aria-label": "Time range" },
      RANGES.map(([k, l]) => el("a", { class: "chip" + (k === range ? " active" : ""), href: `#/insights?range=${k}`, "aria-current": k === range ? "true" : null }, l))));

  if (!d.has_data) {
    return mount(head, el("div", { class: "empty-state" },
      el("h3", {}, "Nothing to show yet"),
      el("p", {}, "Insights fill in as inquiries, bookings, payments and galleries come in. Check back after your first few inquiries.")));
  }

  const tiles = el("div", { class: "ins-tiles" },
    tile(String(t.inquiries), "Inquiries", t.unanswered ? `${t.unanswered} not replied to yet` : "All replied to"),
    tile(pct(t.booking_rate), "Booked", `${t.booked_inquiries} of ${plural(t.inquiries, "inquiry", "inquiries")}`),
    tile(replyTime(t.median_reply_hours), "Typical reply time", t.replied ? `${pct(t.replied_within_24h_rate)} replied within 24 h` : "No replies logged yet"),
    tile(fmtMoney(t.revenue_cents) || "$0", "Payments received", t.upcoming_bookings ? `${plural(t.upcoming_bookings, "upcoming booked shoot")}` : "No upcoming booked shoots"));

  const months = d.months || [];
  const money = (c) => fmtMoney(c).replace(/\.00$/, "");
  const charts = el("div", { class: "ins-grid" },
    monthBars("Inquiries by month", months.map((m) => ({ key: m.month, value: m.inquiries }))),
    monthBars("Shoots by month", months.map((m) => ({ key: m.month, value: m.bookings }))),
    monthBars("Payments by month", months.map((m) => ({ key: m.month, value: m.revenue_cents })), { fmt: money }));

  const sources = hBars("Where inquiries come from", d.sources.map((s) => ({
    name: s.key, value: s.inquiries, detail: `${s.booked} booked · ${pct(s.rate)}`,
  })), { note: "Tracked from the link or site they arrived from" });
  const said = d.said_found_via.length ? hBars("What they said (\"How did you find me?\")", d.said_found_via.map((s) => ({
    name: s.key, value: s.inquiries, detail: `${s.booked} booked · ${pct(s.rate)}`,
  }))) : null;
  const types = hBars("Session types", d.types.map((x) => ({
    name: label(TYPE_LABELS, x.type) || "Other", value: x.bookings, detail: `${money(x.revenue_cents)} paid`,
  })), { note: "Shoots, and payments received" });

  const asked = d.requested_days;
  const days = hBars("Most-requested days", asked.top.map((x) => ({ name: dayLabel(x.day), value: x.count, detail: plural(x.count, "inquiry", "inquiries") })),
    { empty: "No days picked on inquiries yet.", note: (() => {
      const sat = asked.by_weekday[6], sun = asked.by_weekday[0];
      return sat + sun ? `Saturdays ${sat} · Sundays ${sun}` : null;
    })() });

  const g = d.galleries;
  const galleries = el("section", { class: "panel ins-chart" },
    el("div", { class: "ins-chart-head" }, el("h2", { class: "h4" }, "Galleries")),
    g.shared
      ? el("div", { class: "ins-tiles small" },
          tile(String(g.shared), "Shared"),
          tile(pct(g.favorites_rate), "Sent favorites", `${g.favorites_sent} of ${g.shared}`),
          tile(g.median_days_to_send == null ? "–" : `${g.median_days_to_send} days`, "Typical time to send"),
          tile(g.median_favorites == null ? "–" : String(g.median_favorites), "Typical favorites picked"))
      : el("p", { class: "admin-muted small-text", style: "margin:0" }, "No galleries shared in this period."));

  mount(head, tiles, charts, el("div", { class: "ins-two" }, sources, types), said ? el("div", { class: "ins-two" }, said, days) : el("div", { class: "ins-two" }, days, galleries), said ? galleries : null);
}

