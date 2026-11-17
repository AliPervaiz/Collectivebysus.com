/* Dashboard: what needs attention, pipeline counts, upcoming sessions. */

import {
  el, api, send, toast, startView, errorView, select, relTime, fmtDateTime, fmtMoney, label, firstName,
  ATTENTION_LABELS, STATUS_LABELS, STATUSES, TYPE_LABELS, CHANNELS, postingBadge, minorBadge, TZ,
 pencilChoice,
} from "./lib.js";
import { openClientForm } from "./clients.js";
import { openSessionForm } from "./sessions.js";

const URGENT = new Set(["reply_overdue"]);

function attentionHref(a) {
  if (a.kind === "selections_waiting" && a.gallery_id) return `#/g/${a.gallery_id}`;
  if ((a.kind === "new_inquiry" || a.kind === "reply_overdue") && a.client_id) return `#/c/${a.client_id}`;
  if (a.session_id) return `#/s/${a.session_id}`;
  if (a.gallery_id) return `#/g/${a.gallery_id}`;
  if (a.client_id) return `#/c/${a.client_id}`;
  return null;
}

function attentionCard(a, onRemoved) {
  const href = attentionHref(a);
  const body = [
    el("span", { class: "att-kind" }, label(ATTENTION_LABELS, a.kind)),
    el("strong", { class: "att-title" }, a.title || ""),
    a.detail ? el("span", { class: "att-detail" }, a.detail) : null,
    a.since ? el("span", { class: "att-age" }, relTime(a.since)) : null,
  ];
  const main = href ? el("a", { class: "att-main", href }, body) : el("div", { class: "att-main" }, body);
  const card = el("div", { class: `att-card k-${a.kind}${URGENT.has(a.kind) ? " urgent" : ""}` }, main);

  if (a.inquiry_id && (a.kind === "new_inquiry" || a.kind === "reply_overdue")) {
    const channel = pencilChoice({ items: CHANNELS, value: "instagram", ariaLabel: "Replied via", prefix: "Replied via" });
    const btn = el("button", {
      class: "btn small", type: "button",
      onclick: async () => {
        btn.disabled = true;
        try {
          await send(`/inquiries/${a.inquiry_id}/replied`, "POST", { channel: channel.value });
          toast("Marked replied");
          card.remove();
          onRemoved();
        } catch (ex) {
          toast(ex.message);
          btn.disabled = false;
        }
      },
    }, "Mark replied");
    card.append(el("div", { class: "att-actions" }, channel, btn));
  }
  return card;
}

function upcomingRow(s) {
  return el("a", { class: "row-card", href: `#/s/${s.id}` },
    el("div", { class: "row-main" },
      el("strong", {}, s.client_name || "Client"),
      el("span", { class: "row-sub" }, [s.title, label(TYPE_LABELS, s.type)].filter(Boolean).join(" · ")),
      el("span", { class: "row-sub" }, s.starts_at ? fmtDateTime(s.starts_at) : "Date not set", s.location ? ` · ${s.location}` : "")
    ),
    el("div", { class: "row-badges" },
      postingBadge(s.client_can_post),
      minorBadge(s.client_is_minor),
      s.balance_cents > 0 ? el("span", { class: "pill owed" }, `${fmtMoney(s.balance_cents)} due`) : null
    )
  );
}

export async function renderDashboard() {
  const mount = startView();
  let data;
  try { data = await api("/dashboard"); }
  catch (err) { return mount(...errorView(err)); }

  const counts = data.counts || {};
  const attention = data.attention || [];
  const upcoming = data.upcoming || [];

  const head = el("div", { class: "admin-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, greeting(data.owner_name)),
      el("h1", {}, "Dashboard")
    ),
    el("div", { class: "btn-row", style: "margin:0" },
      el("button", { class: "btn small", type: "button", onclick: () => openClientForm() }, "+ Client"),
      el("button", { class: "btn small solid", type: "button", onclick: () => openSessionForm() }, "+ Session")
    )
  );

  // Needs attention
  const attList = el("div", { class: "att-list" });
  const attEmpty = () => el("div", { class: "empty-state small" },
    el("p", { style: "margin:0" }, "All caught up. Nothing needs you right now."));
  const countEl = el("span", { class: "count" });
  const updateCount = () => {
    const n = attList.querySelectorAll(".att-card").length;
    countEl.textContent = n ? String(n) : "";
    if (!n) attList.replaceChildren(attEmpty());
  };
  attList.append(...attention.map((a) => attentionCard(a, updateCount)));
  updateCount();

  // Stage chips
  const chips = el("div", { class: "stat-chips" },
    STATUSES.filter((s) => s !== "archived").map((s) =>
      el("a", { class: "stat-chip" + (counts[s] ? "" : " zero"), href: `#/sessions?status=${s}` },
        el("b", {}, counts[s] || 0), el("span", {}, label(STATUS_LABELS, s))
      )
    )
  );

  const upcomingList = upcoming.length
    ? el("div", { class: "row-list" }, upcoming.map(upcomingRow))
    : el("div", { class: "empty-state small" }, el("p", { style: "margin:0" }, "No sessions on the calendar yet. Your next booking will show up here."));

  const hint = data.settings_hint && data.settings_hint.cal_link_set === false
    ? el("p", { class: "notice" }, "Your booking link isn't set yet. ", el("a", { href: "#/settings" }, "Add it in Settings"), " so inquiries can book a time.")
    : null;

  mount(
    head,
    hint,
    el("section", { class: "dash-section" },
      el("h2", { class: "section-title" }, "Needs attention ", countEl),
      attList
    ),
    el("section", { class: "dash-section" },
      el("h2", { class: "section-title" }, "Pipeline"),
      chips
    ),
    el("section", { class: "dash-section" },
      el("div", { class: "sec-head" },
        el("h2", { class: "section-title" }, "Upcoming sessions"),
        el("a", { class: "small-link", href: "#/sessions" }, "All sessions →")
      ),
      upcomingList
    ),
    newInquiries(data.new_inquiries || [])
  );
}

function newInquiries(list) {
  if (!list.length) return null;
  return el("section", { class: "dash-section" },
    el("h2", { class: "section-title" }, "New inquiries"),
    el("div", { class: "row-list" }, list.map((q) =>
      el("a", { class: "row-card", href: q.client_id ? `#/c/${q.client_id}` : "#/clients" },
        el("div", { class: "row-main" },
          el("strong", {}, q.client_name || q.name || "New inquiry"),
          el("span", { class: "row-sub" }, [label(TYPE_LABELS, q.session_type), q.location].filter(Boolean).join(" · ")),
          q.message ? el("span", { class: "row-sub clamp" }, q.message) : null
        ),
        el("div", { class: "row-badges" }, el("span", { class: "row-sub" }, relTime(q.created_at)))
      )
    ))
  );
}

function greeting(ownerName) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const first = firstName(ownerName);
  return first ? `${part}, ${first}` : part;
}
