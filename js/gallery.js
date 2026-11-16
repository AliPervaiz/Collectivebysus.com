/* Client proofing gallery — Collective by Sus */
(function () {
  "use strict";

  const slug = (location.pathname.match(/^\/g\/([a-z0-9]+)/) || [])[1];
  const api = (p = "") => `/api/g/${slug}${p}`;
  const app = document.getElementById("app");

  const state = {
    gallery: null,
    photos: [],
    filter: "all",
    lbIndex: -1,
    lbList: [],
  };

  /* ---------- helpers ---------- */

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  async function request(path, opts = {}) {
    const res = await fetch(api(path), {
      ...opts,
      headers: { "content-type": "application/json", "x-requested-with": "fetch", ...(opts.headers || {}) },
      credentials: "same-origin",
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  }

  const heartSvg = () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 20.5s-7.5-4.6-9.6-9.3C.9 7.7 3.2 4 6.9 4c2.1 0 3.6 1.1 5.1 3 1.5-1.9 3-3 5.1-3 3.7 0 6 3.7 4.5 7.2-2.1 4.7-9.6 9.3-9.6 9.3z");
    svg.append(path);
    return svg;
  };

  const favCount = () => state.photos.filter((p) => p.favorite).length;
  const visiblePhotos = () => (state.filter === "fav" ? state.photos.filter((p) => p.favorite) : state.photos);

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  }

  function status(title, message) {
    app.replaceChildren(
      el("div", { class: "proof-status" },
        el("span", { class: "eyebrow" }, "Collective by Sus"),
        el("h2", {}, title),
        el("p", {}, message),
        el("p", {}, "Questions? ", el("a", { href: "mailto:contact@collectivebysus.com" }, "contact@collectivebysus.com"))
      )
    );
  }

  /* ---------- load ---------- */

  async function load() {
    if (!slug) return status("Gallery not found", "Please double-check the link you were sent.");
    const { ok, status: code, data } = await request("");
    if (code === 401 && data.locked) return renderLocked(data.title);
    if (code === 410) return status("This gallery has expired", "Reach out if you'd like it reopened. I'm happy to help.");
    if (!ok) return status("Gallery not found", data.error || "Please double-check the link you were sent.");

    state.gallery = data.gallery;
    state.photos = data.photos;
    document.title = `${data.gallery.title} | Collective by Sus`;
    renderGallery();
  }

  function renderLocked(title) {
    const input = el("input", {
      type: "password", inputmode: "numeric", autocomplete: "off", required: true,
      placeholder: "PIN", "aria-label": "Gallery PIN", maxlength: "32",
    });
    const msg = el("p", { class: "form-error", role: "alert" });
    const btn = el("button", { class: "btn solid", type: "submit" }, "View Gallery");
    const form = el("form", {
      class: "pin-form",
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        msg.textContent = "";
        const { ok, data } = await request("/unlock", { method: "POST", body: JSON.stringify({ pin: input.value }) });
        btn.disabled = false;
        if (ok) return load();
        msg.textContent = data.error || "Something went wrong.";
        input.select();
      },
    }, input, btn);

    app.replaceChildren(
      el("div", { class: "proof-status" },
        el("span", { class: "eyebrow" }, "Private Gallery"),
        el("h2", {}, title || "Your gallery"),
        el("p", {}, "Enter the PIN Susi sent you to view your photos."),
        form, msg
      )
    );
    input.focus();
  }

  /* ---------- gallery ---------- */

  function renderGallery() {
    const g = state.gallery;
    const intro = g.max_selections
      ? `Tap the heart on your ${g.max_selections} favorites. Your picks save as you go, so you can come back anytime. When you're happy, hit “Send my selections.”`
      : "Tap the heart on the photos you love. Your picks save as you go, so you can come back anytime. When you're happy, hit “Send my selections.”";

    const header = el("header", { class: "page-header proof-header" },
      el("span", { class: "eyebrow" }, g.client_name ? `Prepared for ${g.client_name}` : "Your Gallery"),
      el("h1", {}, g.title),
      el("p", {}, intro),
      g.expires_at ? el("p", { class: "proof-expiry" }, `Available until ${formatDate(g.expires_at + "T12:00:00")}`) : null,
      el("div", { class: "accent-line" })
    );

    const filters = el("div", { class: "portfolio-filters proof-filters", id: "filters" });
    const grid = el("div", { class: "proof-grid", id: "grid" });

    app.replaceChildren(header, el("section", { class: "section proof-section" },
      el("div", { class: "container" }, filters, grid)
    ));

    if (!state.photos.length) {
      grid.replaceWith(el("p", { class: "proof-empty" }, "Your photos are on their way. Check back soon!"));
      return;
    }

    renderFilters();
    renderGrid();
    updateBar();
    document.getElementById("bar").hidden = false;
    document.body.classList.add("has-bar");
  }

  function renderFilters() {
    const filters = document.getElementById("filters");
    if (!filters) return;
    const mk = (key, label) => el("button", {
      type: "button",
      class: state.filter === key ? "active" : "",
      onclick: () => { state.filter = key; renderFilters(); renderGrid(); },
    }, label);
    filters.replaceChildren(
      mk("all", `All · ${state.photos.length}`),
      mk("fav", `Favorites · ${favCount()}`)
    );
  }

  function renderGrid() {
    const grid = document.getElementById("grid");
    if (!grid) return;
    const list = visiblePhotos();
    if (!list.length) {
      grid.replaceChildren(el("p", { class: "proof-empty" }, "No favorites yet. Tap the heart on any photo to add it here."));
      return;
    }
    grid.replaceChildren(...list.map((photo, i) => {
      const ratio = photo.width && photo.height ? `${photo.width} / ${photo.height}` : "3 / 4";
      const heart = el("button", {
        type: "button",
        class: "heart-btn" + (photo.favorite ? " on" : ""),
        "aria-pressed": String(photo.favorite),
        "aria-label": photo.favorite ? "Remove from favorites" : "Add to favorites",
        onclick: (e) => { e.stopPropagation(); toggleFavorite(photo); },
      }, heartSvg());
      return el("figure", { class: "proof-item" + (photo.favorite ? " is-fav" : ""), "data-id": photo.id },
        el("button", { type: "button", class: "proof-open", "aria-label": `View ${photo.filename}`, onclick: () => openLightbox(i) },
          el("img", {
            src: api(`/photos/${photo.id}/thumb`), alt: "", loading: "lazy", decoding: "async",
            style: `aspect-ratio:${ratio}`, oncontextmenu: blockSave,
          })
        ),
        heart
      );
    }));
  }

  function blockSave(e) {
    if (!state.gallery.allow_downloads) e.preventDefault();
  }

  async function toggleFavorite(photo) {
    const next = !photo.favorite;
    photo.favorite = next;
    refreshFavoriteUI();
    const { ok, data } = await request(`/photos/${photo.id}/favorite`, {
      method: "PUT", body: JSON.stringify({ favorite: next }),
    });
    if (!ok) {
      photo.favorite = !next;
      refreshFavoriteUI();
      flash(data.error || "Couldn't save that. Please try again.");
    }
  }

  function refreshFavoriteUI() {
    // When viewing favorites only, re-render so removed items disappear.
    if (state.filter === "fav" && document.getElementById("lightbox").hidden) {
      renderGrid();
    } else {
      document.querySelectorAll(".proof-item").forEach((fig) => {
        const p = state.photos.find((x) => x.id === fig.dataset.id);
        if (!p) return;
        fig.classList.toggle("is-fav", p.favorite);
        const btn = fig.querySelector(".heart-btn");
        btn.classList.toggle("on", p.favorite);
        btn.setAttribute("aria-pressed", String(p.favorite));
        btn.setAttribute("aria-label", p.favorite ? "Remove from favorites" : "Add to favorites");
      });
    }
    renderFilters();
    updateBar();
    updateLightbox();
  }

  /* ---------- selection bar ---------- */

  let flashTimer;
  function flash(text) {
    const msg = document.getElementById("barMsg");
    msg.textContent = text;
    msg.classList.add("flash");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { msg.classList.remove("flash"); updateBar(); }, 3500);
  }

  function updateBar() {
    const g = state.gallery;
    if (!g) return;
    const n = favCount();
    document.getElementById("barCount").textContent = g.max_selections ? `${n} / ${g.max_selections}` : n;
    document.getElementById("barLabel").textContent = n === 1 && !g.max_selections ? "favorite" : "favorites";
    const btn = document.getElementById("submitBtn");
    btn.disabled = n === 0;
    btn.textContent = g.submitted_at ? "Send updated selections" : "Send my selections";
    const msg = document.getElementById("barMsg");
    if (!msg.classList.contains("flash")) {
      msg.textContent = g.submitted_at ? `Sent ${formatDate(g.submitted_at)}. You can still make changes.` : "";
    }
  }

  /* ---------- submit ---------- */

  const modal = document.getElementById("submitModal");
  document.getElementById("submitBtn").addEventListener("click", () => {
    const n = favCount();
    document.getElementById("submitSummary").textContent =
      `You've chosen ${n} photo${n === 1 ? "" : "s"}. Susi will get your list right away.`;
    document.getElementById("submitNote").value = state.gallery.client_note || "";
    modal.hidden = false;
    document.getElementById("submitNote").focus();
  });
  document.getElementById("submitCancel").addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  document.getElementById("submitConfirm").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const note = document.getElementById("submitNote").value;
    const { ok, data } = await request("/submit", { method: "POST", body: JSON.stringify({ note }) });
    btn.disabled = false;
    if (!ok) return flash(data.error || "Couldn't send. Please try again.");
    state.gallery.submitted_at = data.submitted_at;
    state.gallery.client_note = note;
    modal.hidden = true;
    updateBar();
    flash("Thank you! Your selections are on their way to Susi.");
  });

  /* ---------- lightbox ---------- */

  const lb = document.getElementById("lightbox");
  const lbImg = document.getElementById("lbImg");
  const lbHeart = document.getElementById("lbHeart");
  const lbDownload = document.getElementById("lbDownload");

  function openLightbox(i) {
    state.lbIndex = i;
    state.lbList = visiblePhotos().slice();
    lb.hidden = false;
    document.body.classList.add("no-scroll");
    updateLightbox();
  }

  function closeLightbox() {
    lb.hidden = true;
    document.body.classList.remove("no-scroll");
    state.lbIndex = -1;
    if (state.filter === "fav") renderGrid();
  }

  function step(dir) {
    const list = state.lbList;
    if (!list.length) return;
    state.lbIndex = (state.lbIndex + dir + list.length) % list.length;
    updateLightbox();
  }

  function updateLightbox() {
    if (lb.hidden) return;
    const list = state.lbList;
    const photo = list[state.lbIndex];
    if (!photo) return closeLightbox();
    const src = api(`/photos/${photo.id}/full`);
    if (lbImg.getAttribute("src") !== src) {
      lbImg.classList.add("loading");
      lbImg.onload = () => lbImg.classList.remove("loading");
      lbImg.src = src;
    }
    lbImg.oncontextmenu = blockSave;
    document.getElementById("lbCounter").textContent = `${state.lbIndex + 1} of ${list.length}`;
    lbHeart.classList.toggle("on", photo.favorite);
    lbHeart.setAttribute("aria-pressed", String(photo.favorite));
    lbHeart.querySelector("span").textContent = photo.favorite ? "Favorited" : "Favorite";
    if (state.gallery.allow_downloads) {
      lbDownload.hidden = false;
      lbDownload.href = api(`/photos/${photo.id}/download`);
    } else {
      lbDownload.hidden = true;
    }
    // Preload neighbours for snappy navigation.
    [1, -1].forEach((d) => {
      const n = list[(state.lbIndex + d + list.length) % list.length];
      if (n) new Image().src = api(`/photos/${n.id}/full`);
    });
  }

  lb.querySelector(".lb-close").addEventListener("click", closeLightbox);
  lb.querySelector(".lb-prev").addEventListener("click", () => step(-1));
  lb.querySelector(".lb-next").addEventListener("click", () => step(1));
  lb.addEventListener("click", (e) => { if (e.target === lb || e.target.classList.contains("lb-figure")) closeLightbox(); });
  lbHeart.addEventListener("click", () => {
    const photo = state.lbList[state.lbIndex];
    if (photo) toggleFavorite(photo);
  });

  document.addEventListener("keydown", (e) => {
    if (!modal.hidden && e.key === "Escape") { modal.hidden = true; return; }
    if (lb.hidden) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key.toLowerCase() === "f") lbHeart.click();
  });

  let touchX = null;
  lb.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    touchX = null;
  });

  load();
})();
