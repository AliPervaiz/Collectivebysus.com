/* Sessions page, Month view: calendar of sessions plus day availability (block/open days). */

import {
  el, api, send, toast, attachMenu, viewToggle, startView, errorView, label, plural, TZ,
  STATUS_LABELS, TYPE_LABELS,
} from "./lib.js";
import { openSessionForm } from "./sessions.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PER_DAY = 3;
const HIDDEN_BY_DEFAULT = new Set(["lost", "archived"]);

/* ---------- date helpers (all in studio time) ---------- */

const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

/** ISO instant -> "YYYY-MM-DD" in studio time. */
const dayKey = (iso) => keyFmt.format(new Date(iso));

/** "4:30 PM" -> "4:30p", "10:00 AM" -> "10a". */
function shortTime(iso) {
  return timeFmt.format(new Date(iso)).replace(":00", "").replace(/\s?([AP])M/, (_, x) => x.toLowerCase());
}

/** Offset (ms) of the studio time zone from UTC at a given instant. */
function tzOffset(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}

/** Wall-clock studio time -> ISO instant. */
function studioToIso(y, m, d, h = 0, min = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  return new Date(guess - tzOffset(guess)).toISOString();
}

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function parseMonth(q) {
  const m = /^(\d{4})-(\d{2})$/.exec(q || "");
  if (m && +m[2] >= 1 && +m[2] <= 12) return { y: +m[1], m: +m[2] };
  const [y, mo] = keyFmt.format(new Date()).split("-");
  return { y: +y, m: +mo };
}

const monthParam = ({ y, m }) => `${y}-${pad(m)}`;
const shiftMonth = ({ y, m }, n) => {
  const t = (y * 12 + (m - 1)) + n;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
};

/** Days to show: whole weeks covering the month, Sunday first. */
function gridDays({ y, m }) {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  const days = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(y, m - 1, 1 - lead + i));
    days.push({
      y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
      key: keyOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
      inMonth: d.getUTCMonth() + 1 === m,
    });
  }
  return days;
}

/* ---------- view ---------- */

export async function renderCalendar(query = new URLSearchParams()) {
  const month = parseMonth(query.get("m"));
  const showHidden = query.get("all") === "1";
  const mount = startView();

  const days = gridDays(month);
  const first = days[0];
  const last = days[days.length - 1];
  // Pad a day on each side; sessions are bucketed by studio-local date below.
  const from = studioToIso(first.y, first.m, first.d - 1);
  const to = studioToIso(last.y, last.m, last.d + 2);

  let ranged, active, avail;
  try {
    [ranged, active, avail] = await Promise.all([
      api(`/sessions?${new URLSearchParams({ status: "all", from, to })}`),
      api("/sessions?status=active"),
      api(`/availability?${new URLSearchParams({ from: first.key, to: last.key })}`).catch(() => ({ days: {} })),
    ]);
  } catch (err) {
    return mount(...errorView(err));
  }

  const sessions = (ranged.sessions || []).filter((s) => s.starts_at && (showHidden || !HIDDEN_BY_DEFAULT.has(s.status)));
  const hiddenCount = (ranged.sessions || []).filter((s) => s.starts_at && HIDDEN_BY_DEFAULT.has(s.status)).length;
  const unscheduled = (active.sessions || []).filter((s) => !s.starts_at);

  const byDay = new Map();
  for (const s of sessions) {
    const k = dayKey(s.starts_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const todayKey = keyFmt.format(new Date());
  const now = Date.now();
  const title = new Date(Date.UTC(month.y, month.m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const href = (mo, all = showHidden) => `#/sessions?view=month&m=${monthParam(mo)}${all ? "&all=1" : ""}`;

  const inMonth = sessions.filter((s) => dayKey(s.starts_at).startsWith(monthParam(month)));
  const upcoming = inMonth.filter((s) => new Date(s.starts_at) >= now).length;

  const newSessionOn = (day) => {
    openSessionForm(undefined, { starts_at: studioToIso(day.y, day.m, day.d, 10), status: "booked" }, {
      onSaved: () => renderCalendar(query),
    });
  };

  const setDay = async (key, kind) => {
    try {
      if (kind) await send(`/days/${key}`, "PUT", { kind });
      else await send(`/days/${key}`, "DELETE");
      toast(kind === "blocked" ? "Day blocked" : kind === "open" ? "Day opened for shoots" : "Back to normal");
      renderCalendar(query);
    } catch (ex) { toast(ex.message); }
  };

  /** Menu of actions for an upcoming day (block/unblock, open a non-shoot day, add a session). */
  const dayMenuItems = (day, a, list) => {
    const items = [["new", "New session on this day"]];
    if (a) {
      if (a.override === "blocked") items.push(["unblock", "Unblock this day"]);
      else if (a.override === "open") items.push(["unopen", "Remove extra opening"], ["block", "Block this day"]);
      else if (a.shoot_day) items.push(["block", "Block this day"]);
      else items.push(["open", "Open this day for shoots"]);
    }
    if (list.length && window.matchMedia("(max-width: 720px)").matches) items.unshift(["agenda", "Show sessions"]);
    return items;
  };

  const dayBadge = (a) => {
    if (!a || a.reason === "past" || a.reason === "outside") return null;
    if (a.reason === "blocked") return el("span", { class: "cal-tag t-blocked", title: a.note || "Blocked" }, "Blocked");
    if (a.reason === "full") return el("span", { class: "cal-tag t-full" }, "Full");
    if (a.override === "open") return el("span", { class: "cal-tag t-open" }, "Opened");
    return null;
  };

  const chip = (s, { full = false } = {}) => {
    const past = new Date(s.starts_at) < now;
    const name = s.title || s.client_name || "Session";
    return el("a", {
      class: `cal-ev ev-${s.status}${past ? " past" : ""}`,
      href: `#/s/${s.id}`,
      title: `${shortTime(s.starts_at)} · ${name} · ${label(STATUS_LABELS, s.status)}${s.location ? ` · ${s.location}` : ""}`,
      onclick: (e) => e.stopPropagation(),
    },
      el("span", { class: "cal-ev-time" }, shortTime(s.starts_at)),
      el("span", { class: "cal-ev-name" }, name),
      full ? el("span", { class: "cal-ev-meta" },
        [label(TYPE_LABELS, s.type), s.hours ? `${s.hours}h` : "", s.location || "", label(STATUS_LABELS, s.status)].filter(Boolean).join(" · ")
      ) : null
    );
  };

  /* Month grid */
  const grid = el("div", { class: "cal-grid", "aria-label": title },
    WEEKDAYS.map((w) => el("div", { class: "cal-wd", "aria-hidden": "true" }, w)),
    days.map((day) => {
      const list = byDay.get(day.key) || [];
      const isPast = day.key < todayKey;
      const a = (avail.days || {})[day.key];
      // Past days all look the same (muted). From today on, hatch non-shoot days unless opened as a one-off.
      const offDay = a && !isPast && !a.shoot_day && a.override !== "open";
      const cls = ["cal-day", day.inMonth ? "" : "out", isPast ? "is-past" : "", day.key === todayKey ? "is-today" : "",
        list.length ? "has-ev" : "", offDay ? "is-off" : "", a && a.reason === "blocked" ? "is-blocked" : "",
        new Date(`${day.key}T12:00:00Z`).getUTCDay() >= 4 ? "menu-right" : ""]
        .filter(Boolean).join(" ");
      const more = list.length - MAX_PER_DAY;
      const asks = a && a.requests && !isPast
        ? el("span", { class: "cal-asks", title: `${plural(a.requests, "open inquiry", "open inquiries")} picked this day` }, `${a.requests} ask${a.requests === 1 ? "" : "s"}`)
        : null;
      const cell = el("div", {
        class: cls, role: "group", tabindex: "0", "data-day": day.key,
        "aria-label": `${day.d} ${new Date(Date.UTC(day.y, day.m - 1, day.d)).toLocaleDateString("en-US", { weekday: "long", month: "long", timeZone: "UTC" })}: ${plural(list.length, "session")}${a && a.reason === "full" ? ", full" : ""}${a && a.reason === "blocked" ? ", blocked" : ""}`,
        onkeydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) e.currentTarget.click(); },
      },
        el("span", { class: "cal-day-top" }, el("span", { class: "cal-num" }, day.d), dayBadge(a)),
        el("div", { class: "cal-evs" },
          list.slice(0, MAX_PER_DAY).map((s) => chip(s)),
          more > 0 ? el("span", { class: "cal-more" }, `+${more} more`) : null
        ),
        asks,
        list.length ? el("span", { class: "cal-dots", "aria-hidden": "true" },
          list.slice(0, 4).map((s) => el("i", { class: `dot ev-${s.status}${new Date(s.starts_at) < now ? " past" : ""}` }))
        ) : null
      );
      if (!isPast) {
        const menu = attachMenu(cell, cell, {
          manual: true,
          ariaLabel: `Actions for ${day.key}`,
          onPick: (v) => {
            if (v === "new") newSessionOn(day);
            else if (v === "agenda") document.getElementById(`ag-${day.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            else if (v === "block") setDay(day.key, "blocked");
            else if (v === "open") setDay(day.key, "open");
            else setDay(day.key, null);
          },
        });
        cell.addEventListener("click", (e) => {
          if (e.target.closest(".pick-menu, .cal-ev")) return;
          if (cell.querySelector(":scope > .pick-menu")) return menu.close();
          menu.open(dayMenuItems(day, a, list));
        });
      } else {
        cell.addEventListener("click", () => {
          if (list.length && window.matchMedia("(max-width: 720px)").matches) {
            document.getElementById(`ag-${day.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
      }
      return cell;
    })
  );

  /* Agenda: the List view, and the day list under the grid on phones. Includes blocked days. */
  const blockedIn = (d) => { const a = (avail.days || {})[d.key]; return a && a.override === "blocked" ? a : null; };
  const agendaDays = days.filter((d) => d.inMonth && (byDay.has(d.key) || blockedIn(d)));
  const agenda = el("section", { class: "cal-agenda" },
    el("h2", { class: "h4" }, "This month"),
    agendaDays.length
      ? agendaDays.map((day) => el("div", { class: `ag-day${day.key < todayKey ? " is-past" : ""}${day.key === todayKey ? " is-today" : ""}`, id: `ag-${day.key}` },
          el("div", { class: "ag-date" },
            new Date(Date.UTC(day.y, day.m - 1, day.d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }),
            day.key === todayKey ? el("span", { class: "pill" }, "Today") : null
          ),
          (byDay.get(day.key) || []).map((s) => chip(s, { full: true })),
          blockedIn(day) ? el("div", { class: "ag-blocked" }, el("span", { class: "cal-tag t-blocked" }, "Blocked"), blockedIn(day).note || "") : null
        ))
      : el("p", { class: "admin-muted" }, "No sessions this month.")
  );

  const head = el("div", { class: "admin-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, "Sessions"),
      el("h1", {}, title),
      el("p", { class: "sub" }, `${plural(inMonth.length, "session")} this month · ${upcoming} upcoming`)
    ),
    el("div", { class: "cal-controls" },
      viewToggle("month", "#/sessions?view=list", href(month)),
      el("a", { class: "btn small", href: href(shiftMonth(month, -1)), "aria-label": "Previous month" }, "‹"),
      el("a", { class: "btn small", href: href(parseMonth("")) }, "Today"),
      el("a", { class: "btn small", href: href(shiftMonth(month, 1)), "aria-label": "Next month" }, "›"),
      el("button", { class: "btn small solid", type: "button", onclick: () => openSessionForm(undefined, { status: "booked" }, { onSaved: () => renderCalendar(query) }) }, "New session")
    )
  );

  const legend = el("div", { class: "cal-legend" },
    el("span", {}, el("i", { class: "dot ev-booked" }), "Booked"),
    el("span", {}, el("i", { class: "dot ev-inquiry" }), "Inquiry (not confirmed)"),
    el("span", {}, el("i", { class: "dot ev-done past" }), "Past"),
    el("span", {}, el("span", { class: "cal-tag t-full" }, "Full"), `${(avail.config || {}).max_per_day || 3} shoots`),
    el("span", {}, el("span", { class: "cal-tag t-blocked" }, "Blocked"), "by you"),
    hiddenCount || showHidden
      ? el("a", { href: href(month, !showHidden) }, showHidden ? "Hide lost & archived" : `Show ${plural(hiddenCount, "lost/archived session")}`)
      : null,
    unscheduled.length
      ? el("a", { href: "#/sessions" }, `${plural(unscheduled.length, "active session")} with no date yet`)
      : null
  );

  mount(head, legend, grid, el("p", { class: "admin-muted small-text cal-hint" }, "Tap an upcoming day to add a session, or to block or open it. Greyed days aren't shoot days. \"Asks\" are open inquiries that picked that day. Times are Central."), agenda);
}
