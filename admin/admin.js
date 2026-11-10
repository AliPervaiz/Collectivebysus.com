/* Gallery manager — Collective by Sus */
(function () {
  "use strict";

  const app = document.getElementById("app");
  const FULL_EDGE = 2560;   // long edge of the client-facing image
  const FULL_QUALITY = 0.86;
  const THUMB_EDGE = 900;
  const THUMB_QUALITY = 0.8;
  const UPLOAD_CONCURRENCY = 3;

  let uploading = false;

  /* ---------- helpers ---------- */

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "value") node.value = v;
      else if (k === "checked") node.checked = !!v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  async function api(path, opts = {}) {
    const headers = { "x-requested-with": "fetch", ...(opts.headers || {}) };
    if (opts.body && !(opts.body instanceof FormData)) headers["content-type"] = "application/json";
    const res = await fetch(`/api/admin${path}`, { ...opts, headers, credentials: "same-origin" });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  async function copy(text, msg = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg);
    } catch {
      window.prompt("Copy this:", text);
    }
  }

  const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const shareUrl = (g) => `${location.origin}/g/${g.slug}`;
  const isExpired = (g) => g.expires_at && Date.now() > new Date(`${g.expires_at}T23:59:59-06:00`).getTime();

  function statusPill(g) {
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

  /* ---------- routing ---------- */

  function route() {
    if (uploading) return;
    const m = location.hash.match(/^#\/g\/([\w-]+)/);
    if (m) renderDetail(m[1]);
    else renderList();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", (e) => {
    if (uploading) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------- list view ---------- */

  async function renderList() {
    app.replaceChildren(el("p", { class: "admin-muted" }, "Loading…"));
    let data;
    try { data = await api("/galleries"); }
    catch (err) { return app.replaceChildren(el("p", { class: "form-error" }, err.message)); }

    const head = el("div", { class: "admin-head" },
      el("div", {},
        el("span", { class: "eyebrow" }, "Gallery Manager"),
        el("h1", {}, "Client Galleries"),
      ),
      el("button", { class: "btn solid", type: "button", onclick: () => openGalleryForm() }, "New Gallery")
    );

    const list = data.galleries.length
      ? el("div", { class: "gal-list" }, data.galleries.map((g) =>
          el("a", { class: "gal-row", href: `#/g/${g.id}` },
            el("div", {},
              el("h3", {}, g.title),
              el("div", { class: "meta" }, [g.client_name, `Created ${fmtDate(g.created_at)}`].filter(Boolean).join(" · "))
            ),
            el("div", { class: "gal-stat" }, el("b", {}, g.photo_count), el("span", {}, "Photos")),
            el("div", { class: "gal-stat" }, el("b", {}, g.favorite_count), el("span", {}, "Favorites")),
            statusPill(g)
          )
        ))
      : el("div", { class: "empty-state" },
          el("h3", {}, "No galleries yet"),
          el("p", {}, "Create one for your next shoot, upload the photos, and send the private link to your client.")
        );

    app.replaceChildren(head, list);
  }

  /* ---------- create / edit form ---------- */

  function openGalleryForm(existing) {
    const g = existing || {};
    const f = {
      title: el("input", { type: "text", required: true, maxlength: "200", value: g.title || "", placeholder: "Sarah & James · Engagement" }),
      client_name: el("input", { type: "text", maxlength: "200", value: g.client_name || "", placeholder: "Sarah" }),
      client_email: el("input", { type: "email", maxlength: "200", value: g.client_email || "" }),
      pin: el("input", { type: "text", maxlength: "32", autocomplete: "off", placeholder: g.has_pin ? "Leave blank to keep current PIN" : "Optional, e.g. 2611" }),
      remove_pin: el("input", { type: "checkbox" }),
      max_selections: el("input", { type: "number", min: "1", value: g.max_selections || "", placeholder: "Unlimited" }),
      expires_at: el("input", { type: "date", value: g.expires_at || "" }),
      allow_downloads: el("input", { type: "checkbox", checked: !!g.allow_downloads }),
    };
    const err = el("p", { class: "form-error", role: "alert" });
    const submit = el("button", { class: "btn solid", type: "submit" }, existing ? "Save Changes" : "Create Gallery");

    const form = el("form", { class: "modal-card", onsubmit: onSubmit },
      el("h3", {}, existing ? "Gallery settings" : "New gallery"),
      el("label", { class: "field" }, el("span", {}, "Title *"), f.title),
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
      if (f.remove_pin.checked) body.pin = "";
      else if (f.pin.value.trim()) body.pin = f.pin.value.trim();
      else if (!existing) body.pin = "";
      try {
        const res = existing
          ? await api(`/galleries/${existing.id}`, { method: "PATCH", body: JSON.stringify(body) })
          : await api("/galleries", { method: "POST", body: JSON.stringify(body) });
        modal.remove();
        if (existing) { toast("Saved"); renderDetail(existing.id); }
        else location.hash = `#/g/${res.gallery.id}`;
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    }
  }

  /* ---------- detail view ---------- */

  let detailFilter = "all";

  async function renderDetail(id) {
    let data;
    try { data = await api(`/galleries/${id}`); }
    catch (err) {
      return app.replaceChildren(
        el("a", { class: "back-link", href: "#/" }, "← All galleries"),
        el("p", { class: "form-error" }, err.message)
      );
    }
    const { gallery: g, photos } = data;
    const favs = photos.filter((p) => p.favorite);

    // Header
    const head = el("div", { class: "admin-head" },
      el("div", {},
        el("span", { class: "eyebrow" }, g.client_name ? `For ${g.client_name}` : "Gallery"),
        el("h1", {}, g.title),
        el("p", { class: "sub" }, `${photos.length} photos · ${favs.length} favorites`)
      ),
      statusPill({ ...g, favorite_count: favs.length })
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
    fileInput.addEventListener("change", () => startUpload([...fileInput.files], g, progress));
    ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); }));
    dropzone.addEventListener("drop", (e) => startUpload([...e.dataTransfer.files], g, progress));

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
              try { await api(`/photos/${p.id}`, { method: "DELETE" }); renderDetail(g.id); }
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
              renderDetail(g.id);
            },
          }, "Clear favorites") : null,
          el("button", {
            class: "btn small danger", type: "button",
            onclick: async () => {
              if (!confirm(`Delete "${g.title}" and all ${photos.length} photos? This can't be undone.`)) return;
              try { await api(`/galleries/${g.id}`, { method: "DELETE" }); toast("Gallery deleted"); location.hash = "#/"; }
              catch (ex) { toast(ex.message); }
            },
          }, "Delete")
        )
      )
    );

    app.replaceChildren(
      el("a", { class: "back-link", href: "#/" }, "← All galleries"),
      head,
      el("div", { class: "detail-grid" }, main, side)
    );
  }

  /* ---------- uploads ---------- */

  async function startUpload(files, g, progress) {
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
    if (!failed) renderDetail(g.id);
    else setTimeout(() => renderDetail(g.id), 4000);
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

  route();
})();
