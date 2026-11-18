/* Shared helpers for the admin (CRM + gallery manager). Plain ES module. */

export const app = document.getElementById("app");
// Studio time zone; keep in sync with BRAND.timeZone in src/lib/brand.js.
export const TZ = "America/Chicago";

/* ---------- DOM ---------- */

/** Build an element. All children are text nodes unless they are already Nodes. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "value") node.value = v;
    else if (k === "checked") node.checked = !!v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * <select> with options [[value, label], ...] (or plain strings) and the given value selected.
 */
export function select(options, value, attrs = {}) {
  const s = el("select", attrs);
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    s.append(el("option", { value: v, selected: String(v) === String(value ?? "") }, label));
  }
  return s;
}

/* ---------- view lifecycle (ignore stale async renders) ---------- */

let viewToken = 0;
/** Call at the start of a view (pass null to keep the current content while refreshing). Returns mount(...nodes) that no-ops if the user navigated away. */
export function startView(loadingText = "Loading…") {
  const token = ++viewToken;
  if (loadingText !== null) app.replaceChildren(el("p", { class: "admin-muted" }, loadingText));
  const mount = (...nodes) => {
    if (token !== viewToken) return false;
    app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false));
    return true;
  };
  mount.current = () => token === viewToken;
  return mount;
}

export function errorView(err, backHref, backLabel) {
  const msg = err && err.status === 404
    ? "Couldn't find that. It may have been deleted, or this part of the admin isn't switched on yet."
    : (err && err.message) || "Something went wrong.";
  return [
    backHref ? el("a", { class: "back-link", href: backHref }, `← ${backLabel}`) : null,
    el("p", { class: "form-error" }, msg),
  ].filter(Boolean);
}

/* ---------- network ---------- */

export async function api(path, opts = {}) {
  const headers = { "x-requested-with": "fetch", ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers["content-type"] = "application/json";
  const res = await fetch(`/api/admin${path}`, { ...opts, headers, credentials: "same-origin" });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const send = (path, method, body) =>
  api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

/* ---------- feedback ---------- */

let toastTimer;
export function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

export async function copy(text, msg = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    window.prompt("Copy this:", text);
  }
}

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- modal ---------- */

/**
 * Open a modal form. build(close) returns the inner nodes; onSubmit(e) may throw to show an error.
 * Returns { modal, form, err, submit, close }.
 */
export function openModal({ title, submitLabel = "Save", children = [], onSubmit, wide = false }) {
  const err = el("p", { class: "form-error", role: "alert" });
  const submit = el("button", { class: "btn solid", type: "submit" }, submitLabel);
  const form = el("form", { class: "modal-card" + (wide ? " wide" : ""), onsubmit: handle },
    modalCloseButton(() => close()),
    el("h3", {}, title),
    ...children,
    err,
    el("div", { class: "modal-actions" },
      el("button", { class: "btn", type: "button", onclick: () => close() }, "Cancel"),
      submit
    )
  );
  const modal = el("div", { class: "modal", onclick: (e) => { if (e.target === modal) close(); } }, form);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  function close() { modal.remove(); document.removeEventListener("keydown", onKey); document.body.classList.remove("no-scroll"); }
  document.addEventListener("keydown", onKey);
  document.body.append(modal);
  document.body.classList.add("no-scroll");
  async function handle(e) {
    e.preventDefault();
    submit.disabled = true;
    err.replaceChildren();
    try {
      await onSubmit(e);
    } catch (ex) {
      if (ex instanceof Node) err.replaceChildren(ex);
      else err.textContent = ex.message || String(ex);
    } finally {
      submit.disabled = false;
    }
  }
  return { modal, form, err, submit, close };
}

/** The × in the top-right corner of every modal. */
export function modalCloseButton(onClose) {
  return el("button", { class: "modal-x", type: "button", "aria-label": "Close", title: "Close", onclick: onClose }, "×");
}

export const field = (label, input, hint) =>
  el("label", { class: "field" }, el("span", {}, label), input, hint ? el("small", { class: "hint" }, hint) : null);

/* ---------- formatting ---------- */

const isDateOnly = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(isDateOnly(iso) ? `${iso}T12:00:00` : iso);
  if (isNaN(d)) return "";
  const opts = { month: "short", day: "numeric", year: "numeric" };
  if (!isDateOnly(iso) && !/T12:00:00$/.test(iso)) opts.timeZone = TZ;
  return d.toLocaleDateString("en-US", opts);
}

/** "Sat, Nov 14, 2026, 4:30 PM" in studio time. */
export function fmtDateTime(iso, { year = true } = {}) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-US", {
    timeZone: TZ, weekday: "short", month: "short", day: "numeric",
    year: year ? "numeric" : undefined, hour: "numeric", minute: "2-digit",
  });
}

/** "2 days ago", "in 3 hours", "just now". */
export function relTime(iso) {
  if (!iso) return "";
  const t = new Date(isDateOnly(iso) ? `${iso}T12:00:00` : iso).getTime();
  if (isNaN(t)) return "";
  const diff = (t - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "just now";
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [u, s] of units) if (abs >= s) return rtf.format(Math.round(diff / s), u);
  return "just now";
}

/** ISO UTC → "YYYY-MM-DDTHH:MM" in studio time, for <input type="datetime-local">. */
export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Today's date in studio time, YYYY-MM-DD. */
export function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export function fmtMoney(cents) {
  if (cents == null || cents === "" || isNaN(Number(cents))) return "";
  return money.format(Number(cents) / 100);
}

/** "150" / "$1,250.50" → cents. "" → null. Invalid → NaN. */
export function parseMoney(str) {
  const s = String(str ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}
export const centsToInput = (cents) => (cents == null || cents === "" ? "" : (Number(cents) / 100).toFixed(2).replace(/\.00$/, ""));

export const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;
export const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

/* ---------- labels ---------- */

export const STATUS_LABELS = {
  inquiry: "Inquiry", booked: "Booked", editing: "Editing", done: "Done", archived: "Archived",
};
export const STATUSES = Object.keys(STATUS_LABELS);
export const TYPE_LABELS = { graduation: "Graduation", engagement: "Engagement", event: "Event", portrait: "Portrait" };
export const TYPES = Object.keys(TYPE_LABELS);
export const METHOD_LABELS = { venmo: "Venmo", zelle: "Zelle", cash: "Cash", card: "Card", other: "Other" };
export const KIND_LABELS = { retainer: "Retainer", balance: "Balance", other: "Other" };
export const CHANNELS = [["instagram", "Instagram DM"], ["email", "Email"], ["text", "Text"], ["call", "Call"], ["in person", "In person"]];
export const CAN_POST_LABELS = { yes: "Can post", ask: "Ask first", no: "Do NOT post" };
export const ACTIVITY_LABELS = {
  inquiry: "Inquiry", note: "Note", contact: "Contact", status: "Status", payment: "Payment", booking: "Booking", gallery: "Gallery",
};
export const ATTENTION_LABELS = {
  reply_overdue: "Reply overdue", new_inquiry: "New inquiry", needs_gallery: "Needs gallery",
  selections_waiting: "Selections in", balance_owed: "Balance owed", retainer_missing: "No retainer",
};
export const label = (map, key) => map[key] || (key ? String(key).charAt(0).toUpperCase() + String(key).slice(1) : "");

/* ---------- badges ---------- */

export function postingBadge(canPost, { large = false } = {}) {
  if (!canPost) return null;
  const cls = { yes: "post-yes", ask: "post-ask", no: "post-no" }[canPost] || "post-ask";
  return el("span", { class: `pill post ${cls}${large ? " large" : ""}`, title: "Posting permission" }, label(CAN_POST_LABELS, canPost));
}

export const minorBadge = (isMinor) => (isMinor ? el("span", { class: "pill minor", title: "Client is a minor" }, "Minor") : null);

export const statusPill = (status) => el("span", { class: `pill st st-${status}` }, label(STATUS_LABELS, status));

/* ---------- safe hrefs ---------- */

export function mailHref(email) {
  const e = String(email || "").trim();
  return /^[^\s@<>"'?&#/\\]+@[^\s@<>"'?&#/\\]+\.[A-Za-z]{2,}$/.test(e) ? `mailto:${e}` : null;
}
export function telHref(phone) {
  const p = String(phone || "").trim();
  if (!/^[\d\s().+-]+$/.test(p)) return null;
  const digits = p.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return digits.replace(/\D/g, "").length >= 7 ? `tel:${digits}` : null;
}
export function igHandle(handle) {
  const h = String(handle || "").trim().replace(/^@+/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(h) ? h : null;
}
export function igHref(handle) {
  const h = igHandle(handle);
  return h ? `https://instagram.com/${encodeURIComponent(h)}` : null;
}

/** Shared list cache for pickers (clients). */
export async function loadClients() {
  const data = await api("/clients");
  return data.clients || [];
}

/* ---------- pencil + menu (used instead of on-page dropdowns) ---------- */

const PENCIL_D = "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z";

export function pencilIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", PENCIL_D);
  svg.append(p);
  return svg;
}

let closeOpenMenu = null;

/**
 * Small popover menu anchored inside `wrap` (which must be position:relative), toggled by `button`.
 * items: [[value, label, dotClass?], ...]. Returns { open(items?), close() }.
 * By default clicking `button` toggles it; pass { manual: true } to open it yourself.
 */
export function attachMenu(wrap, button, { items = [], current = () => null, onPick, ariaLabel = "Choose", manual = false }) {
  let menuItems = items;
  const close = () => {
    wrap.querySelector(":scope > .pick-menu")?.remove();
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    if (closeOpenMenu === close) closeOpenMenu = null;
  };
  const onOutside = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKey = (e) => {
    const btns = [...wrap.querySelectorAll(":scope > .pick-menu button")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); close(); button.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
  };
  const open = (newItems) => {
    if (newItems) menuItems = newItems;
    closeOpenMenu?.();
    const cur = current();
    const menu = el("div", { class: "pick-menu", role: "menu", "aria-label": ariaLabel },
      menuItems.map(([value, text, dot]) => el("button", {
        type: "button", role: "menuitemradio", "aria-checked": String(value === cur),
        class: value === cur ? "current" : "",
        onclick: () => { close(); button.focus(); onPick(value); },
      }, dot ? el("i", { class: `dot ${dot}` }) : null, text))
    );
    wrap.append(menu);
    button.setAttribute("aria-expanded", "true");
    if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) menu.classList.add("up");
    (menu.querySelector(".current") || menu.querySelector("button"))?.focus();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    closeOpenMenu = close;
  };
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  if (!manual) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (wrap.querySelector(":scope > .pick-menu")) close(); else open();
    });
  }
  return { open, close };
}

/**
 * Shows the current choice as text (or a custom node) with a pencil that opens a menu.
 *   items: [[value, label, dotClass?], ...]
 *   display(value, label) -> Node|string  (optional)
 *   onChange(newValue) -> may be async; return false (or throw) to keep the old value.
 * The returned element has a `.value` property, so it can stand in for a <select>.
 */
export function pencilChoice({ items, value, ariaLabel, prefix = "", display, onChange, className = "" }) {
  let current = value;
  const labelOf = (v) => (items.find(([x]) => x === v) || [v, String(v ?? "")])[1];
  const shown = el("span", { class: "choice-value" });
  const draw = () => shown.replaceChildren(display ? display(current, labelOf(current)) : labelOf(current));
  draw();
  const btn = el("button", { class: "pencil-btn", type: "button", title: `Change ${ariaLabel.toLowerCase()}`, "aria-label": `Change ${ariaLabel.toLowerCase()}: ${labelOf(current)}` }, pencilIcon());
  const wrap = el("span", { class: `choice-edit ${className}`.trim() },
    prefix ? el("span", { class: "choice-prefix" }, prefix) : null, shown, btn);
  attachMenu(wrap, btn, {
    items, ariaLabel, current: () => current,
    onPick: async (v) => {
      if (v === current) return;
      const prev = current;
      current = v; draw();
      btn.setAttribute("aria-label", `Change ${ariaLabel.toLowerCase()}: ${labelOf(current)}`);
      btn.disabled = true;
      let ok = true;
      try { if (onChange) ok = (await onChange(v)) !== false; }
      catch (ex) { ok = false; toast(ex.message); }
      finally { btn.disabled = false; }
      if (!ok) { current = prev; draw(); }
    },
  });
  Object.defineProperty(wrap, "value", { get: () => current });
  return wrap;
}

/**
 * A filter control: "Type: All types ▾". The whole label is one button that opens a menu.
 * (Pencils are for editing a value; filters only change what's shown.)
 */
export function filterChoice({ items, value, ariaLabel, prefix = "", onChange, className = "" }) {
  let current = value;
  const labelOf = (v) => (items.find(([x]) => x === v) || [v, String(v ?? "")])[1];
  const shown = el("span", { class: "choice-value" }, labelOf(current));
  const btn = el("button", { class: "filter-btn", type: "button" },
    prefix ? el("span", { class: "choice-prefix" }, prefix) : null, shown, el("span", { class: "filter-caret", "aria-hidden": "true" }, "▾"));
  const wrap = el("span", { class: `choice-edit ${className}`.trim() }, btn);
  attachMenu(wrap, btn, {
    items, ariaLabel, current: () => current,
    onPick: (v) => {
      if (v === current) return;
      current = v;
      shown.textContent = labelOf(v);
      if (onChange) onChange(v);
    },
  });
  Object.defineProperty(wrap, "value", { get: () => current });
  return wrap;
}

/* ---------- Sessions page: List / Month view ---------- */

/** "list" or "month", from ?view= (remembered per browser) or the last choice. Defaults to list. */
export function sessionsView(query) {
  let v = query.get("view");
  if (v === "list" || v === "month") { try { localStorage.setItem("sessionsView", v); } catch { /* private mode */ } return v; }
  try { v = localStorage.getItem("sessionsView") || localStorage.getItem("calView"); } catch { v = null; }
  return v === "month" ? "month" : "list";
}

/** The List | Month switch shown at the top of the Sessions page. */
export function viewToggle(current, listHref, monthHref) {
  const link = (v, text, href) => el("a", { class: current === v ? "on" : "", href, "aria-current": current === v ? "true" : null }, text);
  return el("div", { class: "view-toggle", role: "group", "aria-label": "View" },
    link("list", "List", listHref), link("month", "Calendar", monthHref));
}

/** "Mark replied ▾": asks how she replied, then marks the inquiry replied. */
export function markRepliedButton(inquiryId, onDone, { small = true } = {}) {
  const btn = el("button", { class: `btn ${small ? "small" : ""} solid`.trim(), type: "button" }, "Mark replied", el("span", { class: "caret", "aria-hidden": "true" }, "▾"));
  const wrap = el("span", { class: "choice-edit reply-menu" }, btn);
  attachMenu(wrap, btn, {
    items: CHANNELS, ariaLabel: "How did you reply?", current: () => null,
    onPick: async (channel) => {
      btn.disabled = true;
      try {
        await send(`/inquiries/${inquiryId}/replied`, "POST", { channel });
        toast("Marked replied");
        onDone();
      } catch (ex) { toast(ex.message); btn.disabled = false; }
    },
  });
  return wrap;
}

/** Delete control at the bottom of a detail page (kept away from Edit so it isn't tapped by mistake). */
export function dangerZone(text, onClick) {
  return el("div", { class: "danger-zone" }, el("button", { class: "btn small danger", type: "button", onclick: onClick }, text));
}

/** Session type label, or "" when the title already says it (avoids "Engagement inquiry · Engagement"). */
export function typeUnlessInTitle(s) {
  const t = label(TYPE_LABELS, s.type);
  return s.title && t && s.title.toLowerCase().includes(t.toLowerCase()) ? "" : t;
}
