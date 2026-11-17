/* Gallery manager: list, detail, create/edit form, uploads. */

import {
  el, api, toast, copy, fmtDate, startView, errorView, select, postingBadge, minorBadge, label, TYPE_LABELS, todayLocal,
} from "./lib.js";

const FULL_EDGE = 2560;   // long edge of the client-facing image
const FULL_QUALITY = 0.86;
const THUMB_EDGE = 900;
const THUMB_QUALITY = 0.8;
const UPLOAD_CONCURRENCY = 3;

let uploading = false;
export const isUploading = () => uploading;

window.addEventListener("beforeunload", (e) => {
  if (uploading) { e.preventDefault(); e.returnValue = ""; }
});

const shareUrl = (g) => `${location.origin}/g/${g.slug}`;
// Expires at the end of expires_at in studio time; todayLocal() is YYYY-MM-DD in TZ.
const isExpired = (g) => !!g.expires_at && todayLocal() > g.expires_at;

export function galleryStatusPill(g) {
  if (isExpired(g)) return el("span", { class: "pill warn" }, "Expired");
  if (g.submitted_at) return el("span", { class: "pill done" }, `Submitted ${fmtDate(g.submitted_at)}`);
  if (g.favorite_count) return el("span", { class: "pill" }, "Client is choosing");
  return el("span", { class: "pill" }, "Not started");
}

function heartSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M12 20.5s-7.5-4.6-9.6-9.3C.9 7.7 3.2 4 6.9 4c2.1 0 3.6 1.1 5.1 3 1.5-1.9 3-3 5.1-3 3.7 0 6 3.7 4.5 7.2-2.1 4.7-9.6 9.3-9.6 9.3z");
  svg.append(p);
  return svg;
}

/** Linked-client line with posting + minor badges (used on list rows and sidebar). */
function linkedClient(g, { link = true } = {}) {
  if (!g.client_id) return null;
  return el("div", { class: "linked-client" },
    link
      ? el("a", { class: "raise", href: `#/c/${g.client_id}` }, g.linked_client_name || "Client")
      : el("span", {}, g.linked_client_name || "Client"),
    postingBadge(g.client_can_post),
    minorBadge(g.client_is_minor)
  );
}

/** Compact gallery row (also used on client/session pages). */
export function galleryRow(g) {
  return el("div", { class: "gal-row" },
    el("div", {},
      el("h3", {}, el("a", { class: "stretch", href: `#/g/${g.id}` }, g.title)),
      el("div", { class: "meta" }, [g.client_name, `Created ${fmtDate(g.created_at)}`].filter(Boolean).join(" · ")),
      linkedClient(g),
      g.session_id && g.session_title
        ? el("div", { class: "meta" }, "Session: ", el("a", { class: "raise", href: `#/s/${g.session_id}` }, g.session_title))
        : null
    ),
    el("div", { class: "gal-stat" }, el("b", {}, g.photo_count ?? 0), el("span", {}, "Photos")),
    el("div", { class: "gal-stat" }, el("b", {}, g.favorite_count ?? 0), el("span", {}, "Favorites")),
    galleryStatusPill(g)
  );
}

/* ---------- list view ---------- */

export async function renderGalleryList() {
  const mount = startView();
  let data;
  try { data = await api("/galleries"); }
  catch (err) { return mount(...errorView(err)); }

  const head = el("div", { class: "admin-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, "Gallery Manager"),
      el("h1", {}, "Client Galleries"),
    ),
    el("button", { class: "btn solid", type: "button", onclick: () => openGalleryForm() }, "New Gallery")
  );

  const list = data.galleries.length
    ? el("div", { class: "gal-list" }, data.galleries.map(galleryRow))
    : el("div", { class: "empty-state" },
        el("h3", {}, "No galleries yet"),
        el("p", {}, "Create one for your next shoot, upload the photos, and send the private link to your client.")
      );

  mount(head, list);
}

/* ---------- create / edit form ---------- */

/**
 * existing: gallery to edit, or undefined to create.
 * preset (create only): { client_id, session_id, title, client_name, client_email }
 */
export function openGalleryForm(existing, preset = {}) {
  const g = existing || preset || {};
  const f = {
    title: el("input", { type: "text", required: true, maxlength: "200", value: g.title || "", placeholder: "Sarah & James · Engagement" }),
    client_name: el("input", { type: "text", maxlength: "200", value: g.client_name || "", placeholder: "Sarah" }),
    client_email: el("input", { type: "email", maxlength: "200", value: g.client_email || "" }),
    pin: el("input", { type: "text", maxlength: "32", autocomplete: "off", placeholder: g.has_pin ? "Leave blank to keep current PIN" : "Optional, e.g. 2611" }),
    remove_pin: el("input", { type: "checkbox" }),
    max_selections: el("input", { type: "number", min: "1", value: g.max_selections || "", placeholder: "Unlimited" }),
    expires_at: el("input", { type: "date", value: g.expires_at || "" }),
    allow_downloads: el("input", { type: "checkbox", checked: !!g.allow_downloads }),
    client_id: select([["", "Loading clients…"]], "", { disabled: true }),
    session_id: select([["", "No session"]], "", { disabled: true }),
  };
  const linkHint = el("small", { class: "hint" }, "Optional. Links this gallery to a client in your CRM.");
  const initialClient = g.client_id || "";
  const initialSession = g.session_id || "";
  let clients = [];
  let linksLoaded = false;

  const err = el("p", { class: "form-error", role: "alert" });
  const submit = el("button", { class: "btn solid", type: "submit" }, existing ? "Save Changes" : "Create Gallery");

  const form = el("form", { class: "modal-card", onsubmit: onSubmit },
    el("h3", {}, existing ? "Gallery settings" : "New gallery"),
    el("label", { class: "field" }, el("span", {}, "Title *"), f.title),
    el("div", { class: "field-row" },
      el("label", { class: "field" }, el("span", {}, "Client"), f.client_id),
      el("label", { class: "field" }, el("span", {}, "Session"), f.session_id),
    ),
    linkHint,
    el("div", { class: "field-row" },
      el("label", { class: "field" }, el("span", {}, "Client name"), f.client_name),
      el("label", { class: "field" }, el("span", {}, "Client email"), f.client_email),
    ),
    el("label", { class: "field" }, el("span", {}, "PIN"), f.pin,
      el("small", { class: "hint" }, "Clients enter this once to open the gallery. The link is already private, so this is extra.")),
    g.has_pin ? el("label", { class: "check" }, f.remove_pin, "Remove PIN") : null,
    el("div", { class: "field-row" },
      el("label", { class: "field" }, el("span", {}, "Selection limit"), f.max_selections),
      el("label", { class: "field" }, el("span", {}, "Expires"), f.expires_at),
    ),
    el("label", { class: "check" }, f.allow_downloads, "Let the client download photos"),
    err,
    el("div", { class: "modal-actions" },
      el("button", { class: "btn", type: "button", onclick: () => modal.remove() }, "Cancel"),
      submit
    )
  );
  const modal = el("div", { class: "modal", onclick: (e) => { if (e.target === modal) modal.remove(); } }, form);
  document.body.append(modal);
  f.title.focus();

  // Client / session pickers
  (async () => {
    try {
      const data = await api("/clients");
      clients = data.clients || [];
      const opts = [["", "No linked client"], ...clients.map((c) => [c.id, c.name + (c.email ? ` (${c.email})` : "")])];
      if (initialClient && !clients.some((c) => c.id === initialClient)) opts.push([initialClient, g.linked_client_name || "Linked client"]);
      f.client_id.replaceWith(f.client_id = select(opts, initialClient, { onchange: onClientChange }));
      linksLoaded = true;
      await loadSessions(initialClient, initialSession);
    } catch {
      f.client_id.replaceChildren(el("option", { value: "" }, "Client list unavailable"));
      linkHint.textContent = "Couldn't load your clients right now. You can link one later.";
    }
  })();

  async function loadSessions(clientId, selected) {
    if (!clientId) {
      f.session_id.replaceWith(f.session_id = select([["", "No session"]], "", { disabled: true }));
      return;
    }
    try {
      const data = await api(`/sessions?status=all&client_id=${encodeURIComponent(clientId)}`);
      const sessions = data.sessions || [];
      const opts = [["", "No session"], ...sessions.map((s) => [s.id, [s.title || label(TYPE_LABELS, s.type), s.starts_at ? fmtDate(s.starts_at) : ""].filter(Boolean).join(" · ")])];
      if (selected && !sessions.some((s) => s.id === selected)) opts.push([selected, g.session_title || "Linked session"]);
      f.session_id.replaceWith(f.session_id = select(opts, selected || ""));
    } catch {
      f.session_id.replaceWith(f.session_id = select([["", "Sessions unavailable"]], "", { disabled: true }));
    }
  }

  function onClientChange() {
    const c = clients.find((x) => x.id === f.client_id.value);
    if (c) {
      if (!f.client_name.value.trim()) f.client_name.value = c.name || "";
      if (!f.client_email.value.trim() && c.email) f.client_email.value = c.email;
    }
    loadSessions(f.client_id.value, "");
  }

  async function onSubmit(e) {
    e.preventDefault();
    submit.disabled = true;
    err.textContent = "";
    const body = {
      title: f.title.value,
      client_name: f.client_name.value,
      client_email: f.client_email.value,
      max_selections: f.max_selections.value,
      expires_at: f.expires_at.value,
      allow_downloads: f.allow_downloads.checked,
    };
    if (linksLoaded) {
      const cid = f.client_id.value;
      const sid = f.session_id.disabled ? "" : f.session_id.value;
      if (!existing || cid !== initialClient || sid !== initialSession) {
        body.client_id = cid;
        body.session_id = sid;
      }
    } else if (!existing && (preset.client_id || preset.session_id)) {
      if (preset.client_id) body.client_id = preset.client_id;
      if (preset.session_id) body.session_id = preset.session_id;
    }
    if (f.remove_pin.checked) body.pin = "";
    else if (f.pin.value.trim()) body.pin = f.pin.value.trim();
    else if (!existing) body.pin = "";
    try {
      const res = existing
        ? await api(`/galleries/${existing.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api("/galleries", { method: "POST", body: JSON.stringify(body) });
      modal.remove();
      if (existing) { toast("Saved"); renderGalleryDetail(existing.id, { refresh: true }); }
      else location.hash = `#/g/${res.gallery.id}`;
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
    }
  }
}

/* ---------- detail view ---------- */

let detailFilter = "all";

export async function renderGalleryDetail(id, { refresh = false } = {}) {
  const mount = startView(refresh ? null : "Loading…");
  let data;
  try { data = await api(`/galleries/${id}`); }
  catch (err) { return mount(...errorView(err, "#/galleries", "All galleries")); }
  const { gallery: g, photos } = data;
  const favs = photos.filter((p) => p.favorite);
  const refreshDetail = () => {
    if (location.hash.startsWith(`#/g/${g.id}`)) renderGalleryDetail(g.id, { refresh: true });
    else window.dispatchEvent(new HashChangeEvent("hashchange")); // user navigated during an upload
  };

  // Header
  const head = el("div", { class: "admin-head" },
    el("div", {},
      el("span", { class: "eyebrow" }, g.client_name ? `For ${g.client_name}` : "Gallery"),
      el("h1", {}, g.title),
      el("p", { class: "sub" }, `${photos.length} photos · ${favs.length} favorites`)
    ),
    galleryStatusPill({ ...g, favorite_count: favs.length })
  );

  // Upload
  const fileInput = el("input", { type: "file", accept: "image/*", multiple: true });
  const dropzone = el("label", { class: "dropzone" },
    fileInput,
    el("strong", {}, "Add photos"),
    el("span", {}, "Drop your edited JPEGs here or click to choose. They're resized for web on this computer before uploading, so your originals stay with you.")
  );
  const progress = el("div", { class: "progress", hidden: true },
    el("div", { class: "progress-track" }, el("div", { class: "progress-fill" })),
    el("div", { class: "progress-text" }),
    el("div", { class: "progress-errors" })
  );
  fileInput.addEventListener("change", () => startUpload([...fileInput.files], g, progress, refreshDetail));
  ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); }));
  dropzone.addEventListener("drop", (e) => startUpload([...e.dataTransfer.files], g, progress, refreshDetail));

  // Photos
  const filters = el("div", { class: "portfolio-filters admin-filters" });
  const grid = el("div", { class: "admin-grid" });
  function drawGrid() {
    const list = detailFilter === "fav" ? favs : photos;
    filters.replaceChildren(
      el("button", { type: "button", class: detailFilter === "all" ? "active" : "", onclick: () => { detailFilter = "all"; drawGrid(); } }, `All · ${photos.length}`),
      el("button", { type: "button", class: detailFilter === "fav" ? "active" : "", onclick: () => { detailFilter = "fav"; drawGrid(); } }, `Favorites · ${favs.length}`)
    );
    grid.replaceChildren(...list.map((p) =>
      el("figure", { class: "admin-thumb" + (p.favorite ? " fav" : "") },
        el("img", { src: `/api/admin/photos/${p.id}/thumb`, alt: p.filename, loading: "lazy" }),
        p.favorite ? el("span", { class: "fav-badge", title: "Client favorite" }, heartSvg()) : null,
        el("button", {
          class: "del", type: "button", title: "Remove photo", "aria-label": `Remove ${p.filename}`,
          onclick: async () => {
            if (!confirm(`Remove ${p.filename} from this gallery?`)) return;
            try { await api(`/photos/${p.id}`, { method: "DELETE" }); refreshDetail(); }
            catch (ex) { toast(ex.message); }
          },
        }, "×"),
        el("figcaption", {}, p.filename)
      )
    ));
    if (!list.length) grid.replaceChildren(el("p", { class: "admin-muted" }, detailFilter === "fav" ? "No favorites yet." : "No photos yet. Add some above."));
  }
  drawGrid();

  const main = el("div", {}, dropzone, progress, filters, grid);

  // Sidebar
  const baseNames = favs.map((p) => p.filename.replace(/\.[^.]+$/, ""));
  const side = el("aside", {},
    el("div", { class: "panel" },
      el("h4", {}, "Client"),
      g.client_id
        ? el("div", {},
            linkedClient(g),
            g.session_id
              ? el("p", { style: "margin:8px 0 0" }, "Session: ",
                  el("a", { href: `#/s/${g.session_id}` }, g.session_title || label(TYPE_LABELS, g.session_type) || "View session"))
              : null,
            g.client_can_post === "no"
              ? el("p", { class: "warn-text", style: "margin:10px 0 0" }, "This client asked you not to post their photos.")
              : null
          )
        : el("p", { style: "margin:0" }, "Not linked to a client yet. ",
            el("button", { class: "linklike", type: "button", onclick: () => openGalleryForm(g) }, "Link one"))
    ),
    el("div", { class: "panel" },
      el("h4", {}, "Share"),
      el("div", { class: "share-row" },
        el("input", { type: "text", readonly: true, value: shareUrl(g), onfocus: (e) => e.target.select() }),
        el("button", { class: "btn small solid", type: "button", onclick: () => copy(shareUrl(g), "Link copied") }, "Copy")
      ),
      el("p", { style: "margin:12px 0 0" },
        g.has_pin ? "PIN protected." : "No PIN. Anyone with the link can view.",
        g.expires_at ? ` Expires ${fmtDate(g.expires_at + "T12:00:00")}.` : "",
        g.max_selections ? ` Limit: ${g.max_selections} picks.` : "",
        g.allow_downloads ? " Downloads on." : ""
      ),
      el("div", { class: "btn-row" },
        el("a", { class: "btn small", href: shareUrl(g), target: "_blank", rel: "noopener" }, "Preview")
      )
    ),
    el("div", { class: "panel" },
      el("h4", {}, "Client selections"),
      el("p", { style: "margin:0" },
        favs.length ? `${favs.length} favorite${favs.length === 1 ? "" : "s"}` : "No favorites yet.",
        g.submitted_at ? ` · Sent ${fmtDate(g.submitted_at)}` : ""
      ),
      g.client_note ? el("div", { class: "note-box" }, g.client_note) : null,
      favs.length ? el("div", { class: "btn-row" },
        el("button", { class: "btn small solid", type: "button", title: "Paste into Lightroom's Library Filter › Text › Filename › Contains",
          onclick: () => copy(baseNames.join(" "), "Copied for Lightroom") }, "Copy for Lightroom"),
        el("button", { class: "btn small", type: "button",
          onclick: () => copy(favs.map((p) => p.filename).join("\n"), "Filename list copied") }, "Copy list")
      ) : null,
      favs.length ? el("p", { class: "admin-muted", style: "font-size:0.8rem;margin:12px 0 0" },
        "Lightroom tip: in Library, open the Filter bar › Text › Filename › Contains, and paste.") : null
    ),
    el("div", { class: "panel" },
      el("h4", {}, "Settings"),
      el("div", { class: "btn-row", style: "margin-top:0" },
        el("button", { class: "btn small", type: "button", onclick: () => openGalleryForm(g) }, "Edit"),
        favs.length ? el("button", {
          class: "btn small", type: "button",
          onclick: async () => {
            if (!confirm("Clear all of the client's favorites and their note? They'll start over.")) return;
            await api(`/galleries/${g.id}`, { method: "PATCH", body: JSON.stringify({ clear_favorites: true }) });
            refreshDetail();
          },
        }, "Clear favorites") : null,
        el("button", {
          class: "btn small danger", type: "button",
          onclick: async () => {
            if (!confirm(`Delete "${g.title}" and all ${photos.length} photos? This can't be undone.`)) return;
            try { await api(`/galleries/${g.id}`, { method: "DELETE" }); toast("Gallery deleted"); location.hash = "#/galleries"; }
            catch (ex) { toast(ex.message); }
          },
        }, "Delete")
      )
    )
  );

  mount(
    el("a", { class: "back-link", href: "#/galleries" }, "← All galleries"),
    head,
    el("div", { class: "detail-grid" }, main, side)
  );
}

/* ---------- uploads ---------- */

async function startUpload(files, g, progress, refresh) {
  files = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
  if (!files.length || uploading) return;
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  uploading = true;
  progress.hidden = false;
  const fill = progress.querySelector(".progress-fill");
  const text = progress.querySelector(".progress-text");
  const errors = progress.querySelector(".progress-errors");
  errors.replaceChildren();
  let done = 0;
  let failed = 0;
  const update = () => {
    fill.style.width = `${Math.round((done / files.length) * 100)}%`;
    text.textContent = done < files.length
      ? `Uploading ${done + 1} of ${files.length}… please keep this tab open.`
      : `Done. ${files.length - failed} uploaded${failed ? `, ${failed} failed` : ""}.`;
  };
  update();

  const queue = files.slice();
  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      try {
        await uploadOne(file, g.id);
      } catch (err) {
        failed++;
        errors.append(el("div", {}, `${file.name}: ${err.message}`));
      }
      done++;
      update();
    }
  }
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  uploading = false;
  toast(failed ? `${failed} photo${failed === 1 ? "" : "s"} failed. You can drop them in again.` : "Upload complete");
  if (!failed) refresh();
  else setTimeout(refresh, 4000);
}

async function uploadOne(file, galleryId) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("couldn't read this file. Export it as JPEG and try again.");
  }
  try {
    const full = await resize(bitmap, FULL_EDGE, FULL_QUALITY);
    const thumb = await resize(bitmap, THUMB_EDGE, THUMB_QUALITY);
    const form = new FormData();
    form.append("filename", file.name);
    form.append("width", full.width);
    form.append("height", full.height);
    form.append("full", full.blob, "full.jpg");
    form.append("thumb", thumb.blob, "thumb.jpg");

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await api(`/galleries/${galleryId}/photos`, { method: "POST", body: form });
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw lastErr;
  } finally {
    bitmap.close();
  }
}

async function resize(bitmap, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("couldn't process image"))), "image/jpeg", quality)
  );
  return { blob, width, height };
}
