/* Settings: business info, booking, reminders, auto-reply, policies, exports, contract templates. */

import {
  el, api, send, toast, startView, errorView, field, fmtMoney, parseMoney, centsToInput, fmtDate, todayLocal,
} from "./lib.js";

// Contracts are on hold (decided 2026-11-16). Flip to true to show the template editor again.
const SHOW_CONTRACTS = false;
// Client auto-reply email and policy drafts are out of scope for now (saved values are kept).
const SHOW_AUTO_REPLY = false;
const SHOW_POLICIES = false;

export async function renderSettings() {
  const mount = startView();
  let data;
  try { data = await api("/settings"); }
  catch (err) { return mount(...errorView(err)); }

  const head = el("div", { class: "admin-head" },
    el("div", {}, el("span", { class: "eyebrow" }, "Studio"), el("h1", {}, "Settings"))
  );

  mount(
    head,
    settingsForm(data),
    exportsPanel(),
    SHOW_CONTRACTS ? el("div", { id: "contracts-slot" }, el("p", { class: "admin-muted" }, "Loading contract templates…")) : null
  );
  if (!SHOW_CONTRACTS) return;

  const slot = document.getElementById("contracts-slot");
  try {
    const c = await api("/contracts");
    if (mount.current() && slot.isConnected) slot.replaceWith(contractEditor(c, data.settings || {}));
  } catch (err) {
    if (slot.isConnected) slot.replaceChildren(el("div", { class: "panel" }, el("h4", {}, "Contract templates"), ...errorView(err)));
  }
}

function statusLine(ok, okText, noText) {
  return el("p", { class: `status-line ${ok ? "ok" : "off"}` }, el("span", { class: "dot", "aria-hidden": "true" }), ok ? okText : noText);
}

function settingsForm(data) {
  const s = data.settings || {};
  const email = data.email || {};
  const text = (key, attrs = {}) => el("input", { type: "text", value: s[key] ?? "", ...attrs });
  const area = (key, rows = 4, attrs = {}) => el("textarea", { rows: String(rows), ...attrs }, s[key] ?? "");
  const f = {
    business_name: text("business_name", { maxlength: "120" }),
    owner_name: text("owner_name", { maxlength: "120" }),
    contact_email: el("input", { type: "email", value: s.contact_email ?? "", maxlength: "200", autocapitalize: "off" }),
    instagram: text("instagram", { maxlength: "60", placeholder: "handle without @", autocapitalize: "off" }),
    price_note: area("price_note", 3, { maxlength: "1000" }),
    hourly_rate_text: text("hourly_rate_text", { maxlength: "200", placeholder: "e.g. $150/hour" }),
    retainer: el("input", { type: "text", inputmode: "decimal", value: centsToInput(s.retainer_cents), placeholder: "$ e.g. 75" }),
    retainer_note: area("retainer_note", 2, { maxlength: "500" }),
    turnaround: area("turnaround", 2, { maxlength: "500" }),
    reply_promise: text("reply_promise", { maxlength: "300" }),
    max_shoots_per_day: el("input", { type: "number", min: "1", max: "20", inputmode: "numeric", value: s.max_shoots_per_day ?? "3" }),
    max_picked_days: el("input", { type: "number", min: "1", max: "14", inputmode: "numeric", value: s.max_picked_days ?? "5" }),
    availability_days_ahead: el("input", { type: "number", min: "7", max: "365", inputmode: "numeric", value: s.availability_days_ahead ?? "90" }),
    inquiry_reply_hours: el("input", { type: "number", min: "1", max: "999", inputmode: "numeric", value: s.inquiry_reply_hours ?? "" }),
    shot_no_gallery_days: el("input", { type: "number", min: "1", max: "999", inputmode: "numeric", value: s.shot_no_gallery_days ?? "" }),
    auto_reply_enabled: el("input", { type: "checkbox", checked: s.auto_reply_enabled === "true" }),
    auto_reply_text: area("auto_reply_text", 8, { maxlength: "5000", class: "mono" }),
    policy_cancellation: area("policy_cancellation", 5, { maxlength: "5000" }),
    policy_weather: area("policy_weather", 5, { maxlength: "5000" }),
    policy_posting: area("policy_posting", 5, { maxlength: "5000" }),
  };

  const shootDays = new Set(String(s.shoot_weekdays ?? "0,6").split(",").filter(Boolean));
  const dayBoxes = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name, i) =>
    el("label", { class: "day-toggle" }, el("input", { type: "checkbox", value: String(i), checked: shootDays.has(String(i)) }), el("span", {}, name)));

  const group = (title, intro, ...children) => el("fieldset", { class: "panel settings-group" },
    el("legend", {}, el("h4", { style: "margin:0" }, title)),
    intro ? el("p", { class: "admin-muted small-text", style: "margin:0" }, intro) : null,
    ...children);

  const err = el("p", { class: "form-error", role: "alert" });
  const save = el("button", { class: "btn solid", type: "submit" }, "Save settings");

  const form = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      const retainer = parseMoney(f.retainer.value);
      if (Number.isNaN(retainer)) { err.textContent = "Retainer should be a number, like 75."; return; }
      const out = {};
      for (const [k, input] of Object.entries(f)) {
        if (k === "retainer" || k === "auto_reply_enabled") continue;
        out[k] = input.value;
      }
      out.retainer_cents = retainer == null ? "" : String(retainer);
      out.auto_reply_enabled = f.auto_reply_enabled.checked ? "true" : "false";
      out.shoot_weekdays = dayBoxes.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.value).join(",");
      if (!out.shoot_weekdays) { err.textContent = "Pick at least one shoot day."; return; }
      save.disabled = true;
      try {
        await send("/settings", "PUT", { settings: out });
        toast("Settings saved");
      } catch (ex) { err.textContent = ex.message; }
      finally { save.disabled = false; }
    },
  },
    group("Business & pricing", "Shown to clients on the inquiry thank-you page.",
      field("Business name", f.business_name),
      el("div", { class: "field-row" },
        field("Your name", f.owner_name),
        field("Contact email", f.contact_email)),
      field("Instagram", f.instagram),
      field("Pricing note", f.price_note),
      el("div", { class: "field-row" },
        field("Hourly rate", f.hourly_rate_text),
        field("Retainer ($)", f.retainer, f.retainer.value ? `Currently ${fmtMoney(s.retainer_cents)}` : "Leave blank for no retainer")),
      field("Retainer note", f.retainer_note),
      field("Turnaround", f.turnaround),
      field("Reply promise", f.reply_promise)
    ),
    group("Availability", "Clients pick days they're open to on the inquiry form. Only Booked (and later) sessions fill a day. Block or open single days from the Calendar.",
      el("div", { class: "field" }, el("span", {}, "Shoot days"), el("div", { class: "day-toggles" }, dayBoxes)),
      el("div", { class: "field-row" },
        field("Shoots per day (then the day is full)", f.max_shoots_per_day),
        field("Days a client can pick", f.max_picked_days)),
      field("Show this many days ahead", f.availability_days_ahead)
    ),
    group("Reminders & alerts", "When the dashboard should nudge you, and how you hear about new inquiries.",
      el("div", { class: "field-row" },
        field("Reply to inquiries within (hours)", f.inquiry_reply_hours),
        field("Gallery due after a shoot (days)", f.shot_no_gallery_days)),
      statusLine(!!email.owner, `Inquiry alerts to you: on${email.owner_via ? ` (via ${email.owner_via})` : ""}.`, "Inquiry alerts to you: not configured yet."),
      statusLine(!!data.turnstile, "Spam protection (Turnstile): on.", "Spam protection (Turnstile): off. Honeypot and rate limits still apply.")
    ),
    !SHOW_AUTO_REPLY ? null : group("Auto-reply", "An automatic thank-you email sent to people who fill out your inquiry form.",
      el("label", { class: "check" }, f.auto_reply_enabled, "Send an auto-reply to new inquiries"),
      field("Auto-reply message", f.auto_reply_text, "Merge fields: {{first_name}} and {{business_name}}"),
      email.client
        ? statusLine(true, `Client email: configured${email.client_via ? ` (via ${email.client_via})` : ""}.`, "")
        : statusLine(false, "", "Client email isn't configured, so the auto-reply won't send until RESEND_API_KEY (or the Email Service binding) is set.")
    ),
    !SHOW_POLICIES ? null : group("Policies (drafts)", "Your own notes for now. Have these reviewed before sharing with clients.",
      field("Cancellation & rescheduling", f.policy_cancellation),
      field("Weather", f.policy_weather),
      field("Posting & usage", f.policy_posting)
    ),
    err,
    el("div", { class: "sticky-save" }, save)
  );
  return form;
}

function exportsPanel() {
  const link = (file, text) => el("a", { class: "btn small", href: `/api/admin/export/${file}`, download: file }, text);
  return el("div", { class: "panel" },
    el("h4", {}, "Export"),
    el("p", { class: "admin-muted small-text" }, "Download spreadsheets (CSV) of everything. Opens in Excel, Numbers or Google Sheets."),
    el("div", { class: "btn-row" }, link("clients.csv", "Clients"), link("sessions.csv", "Sessions"), link("payments.csv", "Payments"))
  );
}

/* ---------- contract templates ---------- */

const SAMPLE = {
  client_name: "Jordan Rivera",
  client_email: "jordan@example.com",
  guardian_name: "Alex Rivera",
  session_type: "Graduation",
  session_date: "Saturday, May 2, 2026",
  session_time: "6:30 PM",
  session_hours: "1.5",
  session_location: "SMU campus, Dallas",
  hourly_rate: "$150",
  quoted_total: "$225.00",
  retainer_amount: "$75.00",
  balance_due: "$150.00",
  balance_due_date: "May 2, 2026",
  turnaround: "2–3 weeks",
  edited_image_count: "40",
  business_name: "Collective by Sus",
};

function contractEditor(data, settings) {
  let templates = data.templates || [];
  const mergeFields = data.merge_fields || [];
  const sample = { ...SAMPLE, today: fmtDate(todayLocal()) };
  if (settings.business_name) sample.business_name = settings.business_name;
  if (settings.hourly_rate_text) sample.hourly_rate = settings.hourly_rate_text;
  if (settings.turnaround) sample.turnaround = settings.turnaround;
  if (settings.retainer_cents) sample.retainer_amount = fmtMoney(settings.retainer_cents);

  let current = null; // template being edited (null + isNew → new)
  const picker = el("div", { class: "tpl-picker" });
  const name = el("input", { type: "text", maxlength: "200", "aria-label": "Template name" });
  const body = el("textarea", { class: "mono contract-body", rows: "22", spellcheck: "true", "aria-label": "Template text" });
  const preview = el("div", { class: "contract-preview", hidden: true });
  const previewBtn = el("button", { class: "btn small", type: "button", onclick: togglePreview }, "Preview");
  const err = el("p", { class: "form-error", role: "alert" });
  const saveBtn = el("button", { class: "btn small solid", type: "submit" }, "Save template");
  const delBtn = el("button", { class: "btn small danger", type: "button", onclick: onDelete }, "Delete");
  const meta = el("p", { class: "admin-muted small-text", style: "margin:6px 0 0" });

  const chips = el("div", { class: "merge-chips" },
    mergeFields.map((m) => el("button", {
      class: "chip", type: "button", title: `Insert {{${m.key}}}`,
      onclick: () => insertAtCursor(body, `{{${m.key}}}`),
    }, m.label)));

  const editor = el("form", { class: "tpl-editor", onsubmit: onSave, hidden: true },
    field("Template name", name),
    el("div", { class: "mini-label", style: "margin-top:16px" }, "Tap to insert a merge field"),
    chips,
    el("label", { class: "field" }, el("span", {}, "Contract text"), body),
    meta,
    preview,
    err,
    el("div", { class: "btn-row" }, saveBtn, previewBtn, delBtn)
  );

  function drawPicker() {
    picker.replaceChildren(
      ...templates.map((t) => el("button", {
        class: "chip" + (current && current.id === t.id ? " active" : ""), type: "button",
        onclick: () => edit(t),
      }, t.name)),
      el("button", { class: "chip add", type: "button", onclick: () => edit(null) }, "+ New template")
    );
  }

  function edit(t) {
    current = t || { id: null, name: "", body: "" };
    name.value = current.name;
    body.value = current.body;
    meta.textContent = t && t.updated_at ? `Last saved ${fmtDate(t.updated_at)}` : "Not saved yet.";
    delBtn.hidden = !t;
    editor.hidden = false;
    preview.hidden = true;
    previewBtn.textContent = "Preview";
    err.textContent = "";
    drawPicker();
  }

  function togglePreview() {
    if (preview.hidden) {
      preview.textContent = body.value.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) => sample[k] ?? `[${k}]`);
      preview.hidden = false;
      previewBtn.textContent = "Hide preview";
    } else {
      preview.hidden = true;
      previewBtn.textContent = "Preview";
    }
  }

  async function onSave(e) {
    e.preventDefault();
    err.textContent = "";
    if (!name.value.trim()) { err.textContent = "Give the template a name."; return; }
    if (!body.value.trim()) { err.textContent = "The template is empty."; return; }
    saveBtn.disabled = true;
    try {
      const payload = { name: name.value.trim(), body: body.value };
      const res = current.id
        ? await send(`/contracts/${current.id}`, "PUT", payload)
        : await send("/contracts", "POST", payload);
      const saved = res.template || { ...current, ...payload, id: current.id || res.id };
      const i = templates.findIndex((t) => t.id === saved.id);
      if (i >= 0) templates[i] = saved; else templates.push(saved);
      toast("Template saved");
      edit(saved);
    } catch (ex) { err.textContent = ex.message; }
    finally { saveBtn.disabled = false; }
  }

  async function onDelete() {
    if (!current || !current.id) return;
    if (!confirm(`Delete the template "${current.name}"?`)) return;
    try {
      await send(`/contracts/${current.id}`, "DELETE");
      templates = templates.filter((t) => t.id !== current.id);
      toast("Template deleted");
      current = null;
      editor.hidden = true;
      drawPicker();
      if (templates[0]) edit(templates[0]);
    } catch (ex) { toast(ex.message); }
  }

  drawPicker();
  if (templates[0]) edit(templates[0]);

  return el("section", { class: "panel contracts" },
    el("h4", {}, "Contract templates"),
    el("div", { class: "draft-banner", role: "note" },
      el("strong", {}, "Draft — have this reviewed before using. Not legal advice."),
      el("span", {}, " Client signing isn't built yet.")),
    picker,
    editor
  );
}

function insertAtCursor(ta, text) {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  ta.setRangeText(text, start, end, "end");
  ta.focus();
  ta.dispatchEvent(new Event("input"));
}
