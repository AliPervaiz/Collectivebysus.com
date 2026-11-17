/* Sessions: pipeline list, detail page, create/edit form, payments. */

import {
  el, api, send, toast, startView, errorView, select, field, openModal,
  fmtDate, fmtDateTime, relTime, fmtMoney, parseMoney, centsToInput, toLocalInput, todayLocal, label,
  STATUS_LABELS, STATUSES, TYPE_LABELS, TYPES, METHOD_LABELS, KIND_LABELS,
  postingBadge, minorBadge, statusPill, loadClients, pencilChoice, attachMenu, viewToggle,
} from "./lib.js";
import { paymentsTable } from "./clients.js";
import { openGalleryForm, galleryRow } from "./galleries.js";

const FILTERS = [["active", "Active"], ...STATUSES.map((s) => [s, STATUS_LABELS[s]]), ["all", "All"]];
const statusOptions = STATUSES.map((s) => [s, STATUS_LABELS[s]]);

/** "Quoted $300.00 · Paid $100.00" */
export function sessionMoney(s) {
  const parts = [];
  if (s.quoted_cents != null) parts.push(`Quoted ${fmtMoney(s.quoted_cents)}`);
  if (s.paid_cents) parts.push(`Paid ${fmtMoney(s.paid_cents)}`);
  if (s.quoted_cents == null && !s.paid_cents) parts.push("No quote yet");
  return parts.join(" · ");
}

/** Stage badge with a pencil that opens a menu of stages. onChanged(session) runs after a save. */
function stageEditor(s, onChanged) {
  return pencilChoice({
    items: STATUSES.map((st) => [st, label(STATUS_LABELS, st), `ev-${st}`]),
    value: s.status,
    ariaLabel: `Stage for ${s.client_name || "session"}`,
    display: (st) => el("span", { class: `pill st st-${st}` }, label(STATUS_LABELS, st)),
    onChange: async (status) => {
      const res = await send(`/sessions/${s.id}`, "PATCH", { status });
      Object.assign(s, res.session || { status });
      toast(`Moved to ${label(STATUS_LABELS, s.status)}`);
      onChanged?.(s);
    },
  });
}

/* ---------- pipeline list ---------- */

export async function renderSessions(query = new URLSearchParams()) {
  const status = query.get("status") || "active";
  const type = query.get("type") || "";
  const mount = startView();
  const qs = new URLSearchParams({ status });
  if (type) qs.set("type", type);
  let data;
  try { data = await api(`/sessions?${qs}`); }
  catch (err) { return mount(...errorView(err)); }
  const sessions = data.sessions || [];

  const hrefFor = (st, ty) => {
    const p = new URLSearchParams({ view: "list" });
    if (st && st !== "active") p.set("status", st);
    if (ty) p.set("type", ty);
    const s = p.toString();
    return `#/sessions${s ? `?${s}` : ""}`;
  };

  const head = el("div", { class: "admin-head" },
    el("div", {}, el("span", { class: "eyebrow" }, "Pipeline"), el("h1", {}, "Sessions")),
    el("div", { class: "cal-controls" },
      viewToggle("list", hrefFor(status, type), "#/sessions?view=month"),
      el("button", { class: "btn solid", type: "button", onclick: () => openSessionForm() }, "New session"))
  );
  const chips = el("div", { class: "filter-chips", role: "navigation", "aria-label": "Filter by stage" },
    FILTERS.map(([v, l]) => el("a", { class: "chip" + (v === status ? " active" : ""), href: hrefFor(v, type) }, l)));
  const typeSel = pencilChoice({
    items: [["", "All types"], ...TYPES.map((t) => [t, TYPE_LABELS[t]])],
    value: type,
    ariaLabel: "Session type",
    prefix: "Type",
    className: "filter-choice",
    onChange: (v) => { location.hash = hrefFor(status, v); },
  });

  const list = sessions.length
    ? el("div", { class: "row-list" }, sessions.map(pipelineRow))
    : el("div", { class: "empty-state small" }, el("p", { style: "margin:0" },
        status === "active" ? "No active sessions. When someone books, they'll show up here." : "Nothing in this stage right now."));

  mount(head, el("div", { class: "filter-bar" }, chips, typeSel), list);
}

function pipelineRow(s) {
  const owed = el("span", {});
  const drawOwed = () => owed.replaceChildren(s.balance_cents > 0 ? el("span", { class: "pill owed" }, `${fmtMoney(s.balance_cents)} due`) : "");
  drawOwed();
  const stage = stageEditor(s, drawOwed);
  return el("div", { class: "row-card has-controls" },
    el("a", { class: "row-main", href: `#/s/${s.id}` },
      el("strong", {}, s.client_name || "Client"),
      el("span", { class: "row-sub" }, [s.title, label(TYPE_LABELS, s.type)].filter(Boolean).join(" · ")),
      el("span", { class: "row-sub" }, s.starts_at ? fmtDateTime(s.starts_at) : "Date not set")
    ),
    el("div", { class: "row-badges" },
      postingBadge(s.client_can_post),
      minorBadge(s.client_is_minor),
      owed,
      stage
    )
  );
}

/* ---------- create / edit ---------- */

/** preset: { client_id, type, title, location, notes, inquiry_id } */
export function openSessionForm(existing, preset = {}, { onSaved } = {}) {
  const s = existing || preset;
  const initialStart = toLocalInput(s.starts_at);
  const f = {
    client_id: select([["", "Loading clients…"]], "", { required: true, disabled: true }),
    type: select(TYPES.map((t) => [t, TYPE_LABELS[t]]), s.type && TYPES.includes(s.type) ? s.type : "portrait"),
    title: el("input", { type: "text", maxlength: "200", value: s.title || "", placeholder: "e.g. Sarah · SMU grad" }),
    starts_at: el("input", { type: "datetime-local", value: initialStart }),
    hours: el("input", { type: "number", min: "0", step: "0.25", inputmode: "decimal", value: s.hours ?? "", placeholder: "1.5" }),
    location: el("input", { type: "text", maxlength: "300", value: s.location || "", placeholder: "Klyde Warren Park" }),
    status: select(statusOptions, s.status || (preset.inquiry_id ? "inquiry" : "booked")),
    quoted: el("input", { type: "text", inputmode: "decimal", value: centsToInput(s.quoted_cents), placeholder: "$" }),
    notes: el("textarea", { rows: "3", maxlength: "4000" }, s.notes || ""),
  };

  // Client: pick an existing one, or add a new one right here (no trip to the Clients page).
  const nc = {
    name: el("input", { type: "text", maxlength: "120", autocomplete: "off", placeholder: "Full name" }),
    email: el("input", { type: "email", maxlength: "200", autocomplete: "off", autocapitalize: "off", placeholder: "Optional" }),
    phone: el("input", { type: "tel", maxlength: "40", autocomplete: "off", placeholder: "Optional" }),
    instagram: el("input", { type: "text", maxlength: "60", autocomplete: "off", autocapitalize: "off", placeholder: "@handle, optional" }),
  };
  let clientMode = "existing";
  let createdClientId = null; // reuse if the session save fails and she submits again
  let clientNote = "";        // how the client was resolved, for the final toast
  const modeBtn = (m, text) => el("button", { type: "button", "data-mode": m, onclick: () => setClientMode(m) }, text);
  const modeToggle = el("div", { class: "view-toggle client-mode", role: "group", "aria-label": "Client" },
    modeBtn("existing", "Existing client"), modeBtn("new", "New client"));
  const existingWrap = el("div", { class: "client-existing" });
  const newWrap = el("div", { class: "client-new", hidden: true },
    el("div", { class: "field-row" }, field("Name *", nc.name), field("Email", nc.email)),
    el("div", { class: "field-row" }, field("Phone", nc.phone), field("Instagram", nc.instagram)));
  function setClientMode(m) {
    clientMode = m;
    modeToggle.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    existingWrap.hidden = m !== "existing";
    newWrap.hidden = m !== "new";
    if (m === "new") nc.name.focus();
  }
  setClientMode("existing");
  existingWrap.append(f.client_id);

  async function resolveClientId() {
    if (clientMode === "existing") {
      if (!f.client_id.value) throw new Error("Pick a client, or switch to New client.");
      return f.client_id.value;
    }
    if (createdClientId) return createdClientId;
    const name = nc.name.value.trim();
    if (!name) { nc.name.focus(); throw new Error("Enter the new client's name."); }
    try {
      const res = await send("/clients", "POST", {
        name, email: nc.email.value.trim(), phone: nc.phone.value.trim(), instagram: nc.instagram.value.trim(), source: "added in admin",
      });
      createdClientId = res.client.id;
      clientNote = "new";
    } catch (ex) {
      if (ex.status === 409 && ex.data && ex.data.client_id) {
        createdClientId = ex.data.client_id;
        clientNote = "existing";
      } else throw ex;
    }
    return createdClientId;
  }

  const { close } = openModal({
    title: existing ? "Edit session" : "New session",
    submitLabel: existing ? "Save" : "Create session",
    children: [
      existing
        ? el("p", { class: "admin-muted small-text", style: "margin:0" }, `Client: ${existing.client_name || ""}`)
        : el("div", { class: "field client-field" }, el("span", {}, "Client *"), preset.client_id ? null : modeToggle, existingWrap, newWrap),
      el("div", { class: "field-row" }, field("Type", f.type), field("Stage", f.status)),
      field("Title", f.title),
      el("div", { class: "field-row" }, field("Date & time (Central)", f.starts_at), field("Hours", f.hours)),
      field("Location", f.location),
      field("Quoted total ($)", f.quoted, "Leave blank if you haven't quoted yet."),
      field("Notes", f.notes),
    ],
    onSubmit: async () => {
      const quoted = parseMoney(f.quoted.value);
      if (Number.isNaN(quoted)) throw new Error("Quoted total should be a number, like 300 or 287.50.");
      const hours = f.hours.value === "" ? null : Number(f.hours.value);
      const body = {
        type: f.type.value,
        title: f.title.value.trim(),
        hours,
        location: f.location.value.trim(),
        status: f.status.value,
        quoted_cents: quoted,
        notes: f.notes.value,
      };
      if (!existing || f.starts_at.value !== initialStart) body.starts_at = f.starts_at.value || null;
      if (!existing) {
        body.client_id = await resolveClientId();
        if (preset.inquiry_id) body.inquiry_id = preset.inquiry_id;
      }
      const res = existing
        ? await send(`/sessions/${existing.id}`, "PATCH", body)
        : await send("/sessions", "POST", body);
      close();
      toast(existing ? "Saved"
        : clientNote === "new" ? "Client and session created"
        : clientNote === "existing" ? "Session created. That email was already a client, so it's linked to them."
        : "Session created");
      if (onSaved) onSaved(res.session);
      else if (!existing) location.hash = `#/s/${res.session.id}`;
    },
  });

  if (!existing) {
    loadClients().then((clients) => {
      const opts = [["", "Choose a client…"], ...clients.map((c) => [c.id, c.name + (c.email ? ` (${c.email})` : "")])];
      f.client_id.replaceWith(f.client_id = select(opts, preset.client_id || "", { "aria-label": "Existing client" }));
      if (!clients.length) {
        // Nobody to pick yet: go straight to adding the client here.
        modeToggle.querySelector('[data-mode="existing"]').disabled = true;
        setClientMode("new");
      }
    }).catch(() => {
      f.client_id.replaceChildren(el("option", { value: "" }, "Couldn't load clients"));
    });
  }
}

/* ---------- detail ---------- */

export async function renderSessionDetail(id, { refresh = false } = {}) {
  const mount = startView(refresh ? null : "Loading…");
  let data;
  try { data = await api(`/sessions/${id}`); }
  catch (err) { return mount(...errorView(err, "#/sessions", "All sessions")); }
  const s = data.session;
  const c = data.client || {};
  const payments = data.payments || [];
  const galleries = data.galleries || [];
  const reload = () => renderSessionDetail(id, { refresh: true });

  // Stage is changed with Edit here; the pencil only lives on list rows.
  const stage = statusPill(s.status);

  const head = el("div", { class: "admin-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, label(TYPE_LABELS, s.type) + " session"),
      el("h1", {}, s.title || `${c.name || s.client_name || "Client"} · ${label(TYPE_LABELS, s.type)}`),
      el("p", { class: "sub" }, "For ", el("a", { href: `#/c/${s.client_id}` }, c.name || s.client_name || "client"),
        " ", postingBadge(c.can_post || s.client_can_post), " ", minorBadge(c.is_minor ?? s.client_is_minor))
    ),
    el("div", { class: "btn-row", style: "margin:0" },
      el("span", { class: "inline-label" }, el("span", {}, "Stage"), stage),
      el("button", { class: "btn small", type: "button", onclick: () => openSessionForm({ ...s, client_name: c.name || s.client_name }, {}, { onSaved: reload }) }, "Edit"),
      el("button", {
        class: "btn small danger", type: "button",
        onclick: async () => {
          if (!confirm("Delete this session and its payments? Linked galleries stay. This can't be undone.")) return;
          try { await send(`/sessions/${s.id}`, "DELETE"); toast("Session deleted"); location.hash = `#/c/${s.client_id}`; }
          catch (ex) { toast(ex.message); }
        },
      }, "Delete")
    )
  );

  const details = el("dl", { class: "kv" },
    kv("When", s.starts_at ? fmtDateTime(s.starts_at) : "Not set"),
    kv("Hours", s.hours != null && s.hours !== "" ? String(s.hours) : "—"),
    kv("Location", s.location || "—"),
    kv("Stage", label(STATUS_LABELS, s.status) + (s.status_changed_at ? ` · since ${relTime(s.status_changed_at)}` : "")),
    s.cal_booking_uid ? kv("Booked via", "Cal.com") : null,
    kv("Created", fmtDate(s.created_at))
  );

  const balance = el("div", { class: "balance" },
    money("Quoted", s.quoted_cents != null ? fmtMoney(s.quoted_cents) : "—"),
    money("Paid", fmtMoney(s.paid_cents || 0)),
    money("Balance owed", s.balance_cents == null ? "—" : fmtMoney(s.balance_cents), s.balance_cents > 0 ? "owed" : "")
  );

  const payForm = paymentForm(s, reload);

  const delPayment = async (p) => {
    if (!confirm(`Delete the ${fmtMoney(p.amount_cents)} ${label(METHOD_LABELS, p.method)} payment?`)) return;
    try { await send(`/payments/${p.id}`, "DELETE"); toast("Payment deleted"); reload(); }
    catch (ex) { toast(ex.message); }
  };

  const main = el("div", {},
    el("div", { class: "panel" }, el("h4", {}, "Details"), details,
      s.notes ? el("div", { class: "note-box" }, s.notes) : null),
    el("div", { class: "panel" },
      el("h4", {}, "Payments"),
      balance,
      payments.length ? paymentsTable(payments, { onDelete: delPayment, showSession: false }) : el("p", { class: "admin-muted small-text" }, "No payments recorded yet."),
      payForm
    )
  );

  const side = el("aside", {},
    el("div", { class: "panel" },
      el("h4", {}, "Galleries"),
      galleries.length
        ? el("div", { class: "row-list" }, galleries.map((g) => el("div", { class: "linked-gal" },
            galleryRow(g),
            el("button", {
              class: "linklike small-text", type: "button",
              onclick: async () => {
                try { await send(`/galleries/${g.id}`, "PATCH", { session_id: "" }); toast("Unlinked"); reload(); }
                catch (ex) { toast(ex.message); }
              },
            }, "Unlink from session")
          )))
        : el("p", { class: "admin-muted small-text" }, s.status === "shot" || s.status === "editing" ? "No gallery yet. Create one when the edits are ready." : "No gallery linked yet."),
      el("div", { class: "btn-row" },
        el("button", {
          class: "btn small solid", type: "button",
          onclick: () => openGalleryForm(undefined, {
            client_id: s.client_id, session_id: s.id,
            title: s.title || `${c.name || s.client_name || ""} · ${label(TYPE_LABELS, s.type)}`.replace(/^ · /, ""),
            client_name: c.name || s.client_name || "", client_email: c.email || "",
          }),
        }, "+ New gallery")
      ),
      linkPicker(s, galleries, reload)
    )
  );

  mount(
    el("a", { class: "back-link", href: "#/sessions" }, "← All sessions"),
    head,
    c.can_post === "no" ? el("div", { class: "perm-banner perm-no" }, postingBadge("no", { large: true }), el("span", {}, "Don't share photos from this session.")) : null,
    el("div", { class: "detail-grid" }, main, side)
  );
}

const kv = (k, v) => [el("dt", {}, k), el("dd", {}, v)];
const money = (k, v, cls = "") => el("div", { class: `bal ${cls}` }, el("span", {}, k), el("b", {}, v));

function paymentForm(s, reload) {
  const f = {
    amount: el("input", { type: "text", inputmode: "decimal", required: true, placeholder: "$", "aria-label": "Amount" }),
    method: pencilChoice({ items: Object.entries(METHOD_LABELS), value: "venmo", ariaLabel: "Payment method" }),
    kind: pencilChoice({ items: Object.entries(KIND_LABELS), value: s.paid_cents ? "balance" : "retainer", ariaLabel: "Payment for" }),
    paid_on: el("input", { type: "date", value: todayLocal(), required: true, "aria-label": "Date paid" }),
    note: el("input", { type: "text", maxlength: "500", placeholder: "Optional note" }),
  };
  if (s.balance_cents > 0) f.amount.placeholder = `$ e.g. ${centsToInput(s.balance_cents)}`;
  const err = el("p", { class: "form-error", role: "alert" });
  const btn = el("button", { class: "btn small solid", type: "submit" }, "Record payment");
  return el("form", {
    class: "pay-form",
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      const cents = parseMoney(f.amount.value);
      if (!cents || Number.isNaN(cents)) { err.textContent = "Enter an amount, like 100 or 87.50."; return; }
      btn.disabled = true;
      try {
        await send(`/sessions/${s.id}/payments`, "POST", {
          amount_cents: cents, method: f.method.value, kind: f.kind.value, paid_on: f.paid_on.value, note: f.note.value.trim(),
        });
        toast(`${fmtMoney(cents)} recorded`);
        reload();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  },
    el("h5", { class: "mini-label" }, "Record a payment"),
    el("div", { class: "field-row" }, field("Amount ($)", f.amount), field("Date", f.paid_on)),
    el("div", { class: "field-row" },
      el("div", { class: "field" }, el("span", {}, "Method"), f.method),
      el("div", { class: "field" }, el("span", {}, "For"), f.kind)),
    field("Note", f.note),
    err,
    el("div", { class: "btn-row", style: "margin-top:0" }, btn)
  );
}

function linkPicker(s, linked, reload) {
  const open = el("button", { class: "linklike small-text", type: "button" }, "Link an existing gallery");
  const wrap = el("div", { class: "link-picker choice-edit" }, open);
  const menu = attachMenu(wrap, open, {
    manual: true,
    ariaLabel: "Gallery to link",
    onPick: async (id) => {
      open.disabled = true;
      try {
        await send(`/galleries/${id}`, "PATCH", { client_id: s.client_id, session_id: s.id });
        toast("Gallery linked");
        reload();
      } catch (ex) { toast(ex.message); open.disabled = false; }
    },
  });
  open.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (wrap.querySelector(":scope > .pick-menu")) return menu.close();
    open.disabled = true;
    let galleries;
    try { galleries = (await api("/galleries")).galleries || []; }
    catch (ex) { toast(ex.message); return; }
    finally { open.disabled = false; }
    const ids = new Set(linked.map((g) => g.id));
    const avail = galleries.filter((g) => !ids.has(g.id) && (!g.client_id || g.client_id === s.client_id));
    if (!avail.length) return toast("No other galleries to link. Galleries for a different client aren't shown.");
    menu.open(avail.map((g) => [g.id, `${g.title}${g.session_id ? " (linked elsewhere)" : ""}`]));
  });
  return wrap;
}
