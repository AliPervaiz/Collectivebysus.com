/* Dashboard: what needs attention, pipeline counts, upcoming sessions. */

import {
  el, api, send, toast, startView, errorView, relTime, fmtDateTime, fmtMoney, label,
  ATTENTION_LABELS, STATUS_LABELS, STATUSES, TYPE_LABELS, markRepliedButton,
  typeUnlessInTitle,
} from "./lib.js";
import { openClientForm } from "./clients.js";
import { openSessionForm } from "./sessions.js";

const URGENT = new Set(["reply_overdue"]);
const ATTENTION_SHOWN = 3; // more go behind "Show all"


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
    card.append(el("div", { class: "att-actions" }, markRepliedButton(a.inquiry_id, () => { card.remove(); onRemoved(); })));
  }
  return card;
}

function upcomingRow(s) {
  return el("a", { class: "row-card", href: `#/s/${s.id}` },
    el("div", { class: "row-main" },
      el("strong", {}, s.client_name || "Client"),
      el("span", { class: "row-sub" }, [s.title, typeUnlessInTitle(s)].filter(Boolean).join(" · ")),
      el("span", { class: "row-sub" }, s.starts_at ? fmtDateTime(s.starts_at) : "Date not set", s.location ? ` · ${s.location}` : "")
    ),
    el("div", { class: "row-badges" },
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
    el("div", {}, el("h1", {}, "Dashboard")),
    el("div", { class: "btn-row", style: "margin:0" },
      el("button", { class: "btn small", type: "button", onclick: () => openClientForm() }, "New client"),
      el("button", { class: "btn small solid", type: "button", onclick: () => openSessionForm() }, "New session")
    )
  );

  // Needs attention
  const attList = el("div", { class: "att-list" });
  const attEmpty = () => el("div", { class: "empty-state small" },
    el("p", { style: "margin:0" }, "All caught up. Nothing needs you right now."));
  const countEl = el("span", { class: "count" });
  const showAll = el("button", { class: "linklike small-text show-all", type: "button", hidden: true,
    onclick: () => { attList.classList.add("expanded"); showAll.hidden = true; } });
  const updateCount = () => {
    const n = attList.querySelectorAll(".att-card").length;
    countEl.textContent = n ? String(n) : "";
    if (!n) attList.replaceChildren(attEmpty());
    const hiddenN = attList.classList.contains("expanded") ? 0 : Math.max(0, n - ATTENTION_SHOWN);
    showAll.hidden = !hiddenN;
    showAll.textContent = `Show all ${n}`;
  };
  attList.append(...attention.map((a) => attentionCard(a, updateCount)));
  updateCount();

  // Stage chips
  const chips = el("div", { class: "stat-chips" },
    STATUSES.filter((s) => s !== "archived").map((s) =>
      el("a", { class: "stat-chip" + (counts[s] ? "" : " zero"), href: `#/sessions?view=list&stage=${s}` },
        el("b", {}, counts[s] || 0), el("span", {}, label(STATUS_LABELS, s))
      )
    )
  );

  const upcomingList = upcoming.length
    ? el("div", { class: "row-list" }, upcoming.map(upcomingRow))
    : el("div", { class: "empty-state small" }, el("p", { style: "margin:0" }, "No sessions on the calendar yet. Your next booking will show up here."));

  mount(
    head,
    el("section", { class: "dash-section" },
      el("h2", { class: "section-title" }, "Needs attention ", countEl),
      attList,
      showAll
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
    )
  );
}


