/* Clients: list with search, detail page, create/edit form. */

import {
  el, api, send, toast, startView, errorView, select, field, openModal, debounce,
  fmtDate, fmtDateTime, relTime, fmtMoney, label, plural,
  TYPE_LABELS, METHOD_LABELS, KIND_LABELS, CHANNELS, CAN_POST_LABELS, ACTIVITY_LABELS,
  postingBadge, minorBadge, statusPill, mailHref, telHref, igHref, igHandle,
 pencilChoice,
  markRepliedButton,
  dangerZone,
  typeUnlessInTitle,
} from "./lib.js";
import { openSessionForm, sessionMoney } from "./sessions.js";
import { openGalleryForm, galleryRow } from "./galleries.js";

let lastQuery = "";

/* ---------- list ---------- */

export async function renderClients() {
  const mount = startView(null);
  const search = el("input", {
    type: "search", value: lastQuery, placeholder: "Search name, email, phone or @instagram",
    "aria-label": "Search clients", autocomplete: "off",
  });
  const list = el("div", { class: "row-list" }, el("p", { class: "admin-muted" }, "Loading…"));
  const head = el("div", { class: "admin-head" },
    el("div", {}, el("h1", {}, "Clients")),
    el("button", { class: "btn solid", type: "button", onclick: () => openClientForm() }, "New client")
  );
  mount(head, el("div", { class: "search-bar" }, search), list);

  let seq = 0;
  async function load() {
    const my = ++seq;
    const q = search.value.trim();
    lastQuery = q;
    let data;
    try { data = await api(`/clients${q ? `?q=${encodeURIComponent(q)}` : ""}`); }
    catch (err) {
      if (my === seq && mount.current()) list.replaceChildren(...errorView(err));
      return;
    }
    if (my !== seq || !mount.current()) return;
    const clients = data.clients || [];
    if (!clients.length) {
      list.replaceChildren(el("div", { class: "empty-state small" },
        q ? el("p", { style: "margin:0" }, `No clients match “${q}”.`)
          : el("div", {},
              el("h3", {}, "No clients yet"),
              el("p", { style: "margin:0" }, "Inquiries from your website land here automatically. You can also add someone you met in your DMs."))
      ));
      return;
    }
    list.replaceChildren(...clients.map(clientRow));
  }
  search.addEventListener("input", debounce(load, 250));
  load();
}

function clientRow(c) {
  const handle = igHandle(c.instagram);
  return el("a", { class: "row-card", href: `#/c/${c.id}` },
    el("div", { class: "row-main" },
      el("strong", {}, c.name),
      el("span", { class: "row-sub" }, [handle ? `@${handle}` : null, c.email].filter(Boolean).join(" · ") || "No contact info"),
      el("span", { class: "row-sub" },
        plural(c.session_count || 0, "session"),
        c.last_session_at ? ` · ${new Date(c.last_session_at) > new Date() ? "next" : "last"} ${fmtDate(c.last_session_at)}` : "")
    ),
    el("div", { class: "row-badges" },
      c.open_inquiries ? el("span", { class: "pill urgent-pill" }, plural(c.open_inquiries, "open inquiry", "open inquiries")) : null,
      c.balance_cents > 0 ? el("span", { class: "pill owed" }, `${fmtMoney(c.balance_cents)} due`) : null
    )
  );
}

/* ---------- create / edit ---------- */

export function openClientForm(existing, { onSaved } = {}) {
  const c = existing || {};
  const f = {
    name: el("input", { type: "text", required: true, maxlength: "200", value: c.name || "", autocomplete: "off" }),
    email: el("input", { type: "email", maxlength: "200", value: c.email || "", autocomplete: "off" }),
    phone: el("input", { type: "tel", maxlength: "40", value: c.phone || "", autocomplete: "off" }),
    instagram: el("input", { type: "text", maxlength: "60", value: c.instagram ? `@${c.instagram}` : "", placeholder: "@handle", autocomplete: "off", autocapitalize: "off" }),
    source: el("input", { type: "text", maxlength: "80", value: c.source || "", placeholder: "e.g. Instagram, a referral, Google", list: "client-sources" }),
    can_post: select(Object.entries(CAN_POST_LABELS), c.can_post || "ask"),
    is_minor: el("input", { type: "checkbox", checked: !!c.is_minor }),
    guardian_name: el("input", { type: "text", maxlength: "200", value: c.guardian_name || "" }),
    guardian_email: el("input", { type: "email", maxlength: "200", value: c.guardian_email || "" }),
    notes: el("textarea", { maxlength: "4000", rows: "3" }, c.notes || ""),
  };
  const sources = el("datalist", { id: "client-sources" },
    ["Instagram", "Referral", "Google", "Website", "TikTok", "Repeat client"].map((s) => el("option", { value: s })));
  const guardian = el("div", { class: "guardian-fields", hidden: !c.is_minor },
    el("div", { class: "field-row" },
      field("Parent/guardian name", f.guardian_name),
      field("Parent/guardian email", f.guardian_email)
    )
  );
  f.is_minor.addEventListener("change", () => { guardian.hidden = !f.is_minor.checked; });

  const { close } = openModal({
    title: existing ? "Edit client" : "New client",
    submitLabel: existing ? "Save changes" : "Create client",
    children: [
      sources,
      field("Name *", f.name),
      el("div", { class: "field-row" }, field("Email", f.email), field("Phone", f.phone)),
      el("div", { class: "field-row" }, field("Instagram", f.instagram), field("Source", f.source)),
      field("Posting permission", f.can_post, "Can you share their photos on Instagram or your site?"),
      el("label", { class: "check" }, f.is_minor, "Client is under 18"),
      guardian,
      field("Notes", f.notes),
    ],
    onSubmit: async () => {
      const body = {
        name: f.name.value.trim(),
        email: f.email.value.trim(),
        phone: f.phone.value.trim(),
        instagram: f.instagram.value.trim().replace(/^@+/, ""),
        source: f.source.value.trim(),
        can_post: f.can_post.value,
        is_minor: f.is_minor.checked,
        guardian_name: f.is_minor.checked ? f.guardian_name.value.trim() : "",
        guardian_email: f.is_minor.checked ? f.guardian_email.value.trim() : "",
        notes: f.notes.value,
      };
      if (!body.name) throw new Error("Please add a name.");
      try {
        const res = existing
          ? await send(`/clients/${existing.id}`, "PATCH", body)
          : await send("/clients", "POST", body);
        close();
        toast(existing ? "Saved" : "Client added");
        if (onSaved) onSaved(res.client);
        else if (!existing) location.hash = `#/c/${res.client.id}`;
      } catch (ex) {
        if (ex.status === 409 && ex.data && ex.data.client_id) {
          throw el("span", {}, `${ex.message || "A client with that email already exists."} `,
            el("a", { href: `#/c/${ex.data.client_id}`, onclick: () => close() }, "Open that client →"));
        }
        throw ex;
      }
    },
  });
  f.name.focus();
}

/* ---------- detail ---------- */

export async function renderClientDetail(id, { refresh = false } = {}) {
  const mount = startView(refresh ? null : "Loading…");
  let data;
  try { data = await api(`/clients/${id}`); }
  catch (err) { return mount(...errorView(err, "#/clients", "All clients")); }
  const { client: c } = data;
  const sessions = data.sessions || [];
  const galleries = data.galleries || [];
  const payments = data.payments || [];
  const activity = data.activity || [];
  const inquiries = data.inquiries || [];
  const reload = () => renderClientDetail(id, { refresh: true });

  // Header + contact
  const mail = mailHref(c.email);
  const tel = telHref(c.phone);
  const ig = igHref(c.instagram);
  const contact = el("div", { class: "contact-links" },
    ig ? el("a", { class: "btn small", href: ig, target: "_blank", rel: "noopener noreferrer" }, `@${igHandle(c.instagram)}`) : null,
    mail ? el("a", { class: "btn small", href: mail }, "Email") : null,
    tel ? el("a", { class: "btn small", href: tel }, "Call") : null,
    tel ? el("a", { class: "btn small", href: tel.replace(/^tel:/, "sms:") }, "Text") : null
  );

  const head = el("div", { class: "admin-head client-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, c.source ? `Client · via ${c.source}` : "Client"),
      el("h1", {}, c.name),
      el("p", { class: "sub" }, [c.email, c.phone].filter(Boolean).join(" · ") || "No email or phone saved"),
      contact
    ),
    el("div", { class: "btn-row", style: "margin:0" },
      el("button", { class: "btn small", type: "button", onclick: () => openClientForm(c, { onSaved: reload }) }, "Edit")
    )
  );

  // Permission banner
  const permText = {
    yes: "They're happy for you to share their photos.",
    ask: "Check with them before sharing any photos.",
    no: "They asked you not to share their photos anywhere.",
  }[c.can_post] || "";
  const perm = el("div", { class: `perm-banner perm-${c.can_post || "ask"}` },
    postingBadge(c.can_post || "ask", { large: true }),
    el("span", {}, permText),
    c.is_minor ? el("div", { class: "minor-info" },
      minorBadge(true),
      el("span", {}, "Under 18. ",
        c.guardian_name || c.guardian_email ? "Parent/guardian: " : "No parent/guardian saved yet.",
        c.guardian_name || "",
        c.guardian_email ? " " : "",
        mailHref(c.guardian_email) ? el("a", { href: mailHref(c.guardian_email) }, c.guardian_email) : (c.guardian_email || ""))
    ) : null
  );

  // Log contact
  const chan = pencilChoice({ items: CHANNELS, value: "instagram", ariaLabel: "Contact method", prefix: "Via" });
  const contactNote = el("input", { type: "text", maxlength: "1000", placeholder: "Optional note, e.g. sent pricing" });
  const openInq = inquiries.filter((q) => q.status === "new");
  const logBtn = el("button", { class: "btn small solid", type: "submit" }, "Log contact");
  const logForm = el("form", {
    class: "inline-form",
    onsubmit: async (e) => {
      e.preventDefault();
      logBtn.disabled = true;
      try {
        await send(`/clients/${c.id}/activity`, "POST", { kind: "contact", channel: chan.value, body: contactNote.value.trim() });
        toast(openInq.length ? "Logged. Inquiry marked replied." : "Contact logged");
        reload();
      } catch (ex) { toast(ex.message); logBtn.disabled = false; }
    },
  }, chan, contactNote, logBtn);

  const contactPanel = el("div", { class: "panel" },
    el("h2", { class: "h4" }, "Log a contact"),
    el("p", { class: "admin-muted small-text" },
      c.last_contact_at ? `Last contact ${relTime(c.last_contact_at)}.` : "No contact logged yet.",
      openInq.length ? " Logging a contact marks open inquiries as replied." : ""),
    logForm
  );

  const main = el("div", {},
    inquiries.length ? section("Inquiries", null, inquiries.map((q) => inquiryCard(q, reload))) : null,
    section("Sessions",
      el("button", { class: "btn small", type: "button", onclick: () => openSessionForm(null, { client_id: c.id }) }, "New session"),
      sessions.length ? sessions.map(sessionRow) : [emptyLine("No sessions yet.")]),
    section("Galleries",
      el("button", {
        class: "btn small", type: "button",
        onclick: () => openGalleryForm(undefined, { client_id: c.id, client_name: c.name, client_email: c.email || "" }),
      }, "New gallery"),
      galleries.length ? galleries.map((g) => galleryRow(g, { context: "client" })) : [emptyLine("No galleries linked yet.")]),
    section("Payments", null,
      payments.length ? [paymentsTable(payments)] : [emptyLine("No payments recorded.")])
  );

  // Notes / activity
  const noteBox = el("textarea", { rows: "3", maxlength: "4000", placeholder: "Add a note…" });
  const noteBtn = el("button", { class: "btn small solid", type: "submit" }, "Add note");
  const noteForm = el("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      const body = noteBox.value.trim();
      if (!body) return;
      noteBtn.disabled = true;
      try { await send(`/clients/${c.id}/activity`, "POST", { kind: "note", body }); toast("Note added"); reload(); }
      catch (ex) { toast(ex.message); noteBtn.disabled = false; }
    },
  }, el("label", { class: "field", style: "margin-top:0" }, noteBox), el("div", { class: "btn-row" }, noteBtn));

  const side = el("aside", {},
    contactPanel,
    c.notes ? el("div", { class: "panel" }, el("h2", { class: "h4" }, "About"), el("div", { class: "note-box", style: "margin:0" }, c.notes)) : null,
    el("div", { class: "panel" },
      el("h2", { class: "h4" }, "Notes & activity"),
      noteForm,
      activity.length
        ? el("ol", { class: "activity" }, activity.map((a) =>
            el("li", { class: `act act-${a.kind}` },
              el("div", { class: "act-meta" }, el("span", { class: "act-kind" }, label(ACTIVITY_LABELS, a.kind)), el("time", { title: fmtDateTime(a.created_at) }, relTime(a.created_at))),
              a.body ? el("div", { class: "act-body" }, a.body) : null
            )))
        : el("p", { class: "admin-muted small-text", style: "margin:12px 0 0" }, "Nothing logged yet.")
    )
  );

  mount(
    el("a", { class: "back-link", href: "#/clients" }, "← All clients"),
    head,
    perm,
    el("div", { class: "detail-grid" }, main, side),
    dangerZone("Delete this client", async () => {
      if (!confirm(`Delete ${c.name}? Their sessions, payments and notes will be deleted too. Galleries stay but are unlinked. This can't be undone.`)) return;
      try { await send(`/clients/${c.id}`, "DELETE"); toast("Client deleted"); location.hash = "#/clients"; }
      catch (ex) { toast(ex.message); }
    })
  );
}

function section(title, action, children) {
  return el("section", { class: "detail-section" },
    el("div", { class: "sec-head" }, el("h2", { class: "section-title" }, title), action),
    el("div", { class: "row-list" }, children)
  );
}
const emptyLine = (t) => el("p", { class: "admin-muted small-text", style: "margin:0" }, t);

function sessionRow(s) {
  return el("a", { class: "row-card", href: `#/s/${s.id}` },
    el("div", { class: "row-main" },
      el("strong", {}, s.title || label(TYPE_LABELS, s.type)),
      el("span", { class: "row-sub" }, [typeUnlessInTitle(s), s.starts_at ? fmtDateTime(s.starts_at) : "Date not set"].filter(Boolean).join(" · ")),
      el("span", { class: "row-sub" }, sessionMoney(s))
    ),
    el("div", { class: "row-badges" }, statusPill(s.status),
      s.balance_cents > 0 ? el("span", { class: "pill owed" }, `${fmtMoney(s.balance_cents)} due`) : null)
  );
}

export function paymentsTable(payments, { onDelete, showSession = true } = {}) {
  return el("div", { class: "pay-list" }, payments.map((p) =>
    el("div", { class: "pay-row" },
      el("div", { class: "pay-amt" }, fmtMoney(p.amount_cents)),
      el("div", { class: "pay-info" },
        el("span", {}, [label(METHOD_LABELS, p.method), label(KIND_LABELS, p.kind), fmtDate(p.paid_on)].filter(Boolean).join(" · ")),
        showSession && p.session_id
          ? el("a", { class: "row-sub", href: `#/s/${p.session_id}` }, p.session_title || label(TYPE_LABELS, p.session_type) || "Session")
          : null,
        p.note ? el("span", { class: "row-sub" }, p.note) : null
      ),
      onDelete ? el("button", {
        class: "icon-btn", type: "button", "aria-label": `Delete ${fmtMoney(p.amount_cents)} payment`, title: "Delete payment",
        onclick: () => onDelete(p),
      }, "×") : null
    )
  ));
}

/** "2026-12-05" -> "Sat, Dec 5"; older free-text dates pass through unchanged. */
function niceDay(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function inquiryCard(q, reload) {
  const dates = Array.isArray(q.preferred_dates) ? q.preferred_dates.filter(Boolean).map(niceDay) : [];
  const rows = [
    ["Session type", label(TYPE_LABELS, q.session_type)],
    ["Open days", dates.join(", ")],
    ["Timing notes", q.date_notes],
    ["Location", q.location],
    ["People", q.people_count],
    ["Photo use", q.usage],
    ["Found me via", q.referral],
    ["Came from", q.came_from ? q.came_from + (q.referrer_host && q.referrer_host.toLowerCase() !== q.came_from.toLowerCase() ? ` (${q.referrer_host})` : "") : ""],
    ["Phone", q.phone],
    ["Instagram", q.instagram ? `@${String(q.instagram).replace(/^@+/, "")}` : ""],
  ].filter(([, v]) => v);

  const isOpen = q.status === "new";
  const inquiryNotes = [dates.length ? `Open days: ${dates.join(", ")}` : "", q.date_notes ? `Timing: ${q.date_notes}` : "", q.people_count ? `People: ${q.people_count}` : "", q.message || ""].filter(Boolean).join("\n");
  const actions = el("div", { class: "btn-row" },
    isOpen ? markRepliedButton(q.id, reload) : null,
    el("button", {
      class: "btn small", type: "button",
      onclick: async (e) => {
        // The inquiry already created a session (stage: Inquiry). Open that one to set the date and book it.
        const btn = e.currentTarget;
        if (q.session_id) {
          btn.disabled = true;
          try {
            const { session } = await api(`/sessions/${q.session_id}`);
            openSessionForm({ ...session, status: session.status === "inquiry" ? "booked" : session.status, client_name: q.client_name || q.name },
              {}, { onSaved: reload });
          } catch (ex) { toast(ex.message); }
          finally { btn.disabled = false; }
          return;
        }
        openSessionForm(null, { client_id: q.client_id, type: q.session_type, location: q.location, notes: inquiryNotes, status: "booked" }, { onSaved: reload });
      },
    }, "Book session"),
    q.status !== "closed" ? el("button", {
      class: "btn small", type: "button",
      onclick: async () => {
        try { await send(`/inquiries/${q.id}`, "PATCH", { status: "closed" }); toast("Inquiry closed"); reload(); }
        catch (ex) { toast(ex.message); }
      },
    }, "Close") : null
  );

  return el("div", { class: `inq-card${isOpen ? " open" : ""}` },
    el("div", { class: "inq-head" },
      el("span", { class: `pill ${isOpen ? "urgent-pill" : q.status === "replied" ? "done" : ""}` },
        isOpen ? "Needs reply" : q.status === "replied" ? "Replied" : "Closed"),
      el("span", { class: "row-sub" }, `${fmtDateTime(q.created_at)} · ${relTime(q.created_at)}`),
      q.replied_at ? el("span", { class: "row-sub" }, `Replied ${relTime(q.replied_at)}`) : null
    ),
    el("dl", { class: "inq-answers" }, rows.map(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
    q.message ? el("div", { class: "note-box" }, q.message) : null,
    actions
  );
}
