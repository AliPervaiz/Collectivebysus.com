/* Public inquiry form (inquire.html, contact.html#inquire).
   Plain script, no build. Enhances every form[data-inquiry-form]. */
(function () {
  "use strict";

  var SITE = window.SITE_CONFIG || {};
  var CONTACT = SITE.contactEmail ? ", or email " + SITE.contactEmail : "";
  var settingsPromise = null;

  /** Cached GET /api/public/settings. */
  function publicSettings(force) {
    if (!settingsPromise || force) {
      settingsPromise = fetch("/api/public/settings", { headers: { accept: "application/json" }, cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return settingsPromise;
  }
  window.sitePublicSettings = publicSettings;

  var turnstileLoading = null;
  function loadTurnstile() {
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise(function (resolve, reject) {
      window.siteTurnstileReady = function () { resolve(window.turnstile); };
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=siteTurnstileReady";
      s.async = true;
      s.defer = true;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return turnstileLoading;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }


  /* ---------- Day picker: clients tap the days they're open to shooting ---------- */

  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var WD = ["S", "M", "T", "W", "T", "F", "S"];
  var WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function dayKey(y, m, d) { return y + "-" + pad2(m) + "-" + pad2(d); }
  function parseKey(k) { var p = k.split("-"); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function niceDay(k) {
    var p = parseKey(k);
    var dt = new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
    return WD_LONG[dt.getUTCDay()].slice(0, 3) + ", " + MONTHS[p.m - 1].slice(0, 3) + " " + p.d;
  }

  function dayPicker(root, onChange) {
    var st = { open: {}, first: null, last: null, max: 5, selected: [], y: 0, m: 0, loaded: false };
    var grid = el("div", "dp-cal");
    var chosen = el("div", "dp-chosen");
    var msg = el("p", "dp-msg");
    msg.setAttribute("aria-live", "polite");
    root.appendChild(grid);
    root.appendChild(chosen);
    root.appendChild(msg);
    var maxLabel = root.closest("fieldset") ? root.closest("fieldset").querySelector("[data-max-picks]") : null;

    function load() {
      grid.replaceChildren(el("p", "dp-loading", "Loading available days..."));
      return fetch("/api/public/availability", { headers: { accept: "application/json" }, cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (data) {
          st.open = {};
          (data.open_days || []).forEach(function (k) { st.open[k] = true; });
          st.first = data.first; st.last = data.last; st.max = data.max_picks || 5;
          if (maxLabel) maxLabel.textContent = String(st.max);
          st.selected = st.selected.filter(function (k) { return st.open[k]; });
          if (!st.loaded) {
            var start = parseKey((data.open_days && data.open_days[0]) || data.first);
            st.y = start.y; st.m = start.m;
          }
          st.loaded = true;
          render();
        })
        .catch(function () {
          st.loaded = false;
          grid.replaceChildren(el("p", "dp-loading", "The calendar couldn't load. Just tell me which days work in the box below."));
        });
    }

    function monthIndex(y, m) { return y * 12 + (m - 1); }
    function canGo(delta) {
      if (!st.first) return false;
      var f = parseKey(st.first), l = parseKey(st.last), t = monthIndex(st.y, st.m) + delta;
      return t >= monthIndex(f.y, f.m) && t <= monthIndex(l.y, l.m);
    }
    function go(delta) {
      var t = monthIndex(st.y, st.m) + delta;
      st.y = Math.floor(t / 12); st.m = (t % 12) + 1;
      render();
    }

    function toggle(k) {
      var i = st.selected.indexOf(k);
      if (i >= 0) st.selected.splice(i, 1);
      else if (st.selected.length >= st.max) { msg.textContent = "You can pick up to " + st.max + " days."; return; }
      else st.selected.push(k);
      st.selected.sort();
      msg.textContent = "";
      render();
      if (onChange) onChange();
    }

    function render() {
      var head = el("div", "dp-head");
      var prev = el("button", "dp-nav", "‹");
      prev.type = "button"; prev.setAttribute("aria-label", "Previous month"); prev.disabled = !canGo(-1);
      prev.addEventListener("click", function () { go(-1); });
      var next = el("button", "dp-nav", "›");
      next.type = "button"; next.setAttribute("aria-label", "Next month"); next.disabled = !canGo(1);
      next.addEventListener("click", function () { go(1); });
      var title = el("span", "dp-title", MONTHS[st.m - 1] + " " + st.y);
      title.setAttribute("aria-live", "polite");
      head.appendChild(prev); head.appendChild(title); head.appendChild(next);

      var days = el("div", "dp-days");
      days.setAttribute("role", "group");
      days.setAttribute("aria-label", MONTHS[st.m - 1] + " " + st.y);
      WD.forEach(function (w, i) {
        var h = el("span", "dp-wd", w);
        h.setAttribute("aria-hidden", "true");
        h.title = WD_LONG[i];
        days.appendChild(h);
      });
      var lead = new Date(Date.UTC(st.y, st.m - 1, 1)).getUTCDay();
      var count = new Date(Date.UTC(st.y, st.m, 0)).getUTCDate();
      for (var b = 0; b < lead; b++) days.appendChild(el("span", "dp-blank"));
      for (var d = 1; d <= count; d++) {
        var k = dayKey(st.y, st.m, d);
        var isOpen = !!st.open[k];
        var isSel = st.selected.indexOf(k) >= 0;
        var btn = el("button", "dp-day" + (isOpen ? " open" : "") + (isSel ? " sel" : ""), String(d));
        btn.type = "button";
        btn.disabled = !isOpen;
        btn.setAttribute("aria-pressed", isSel ? "true" : "false");
        btn.setAttribute("aria-label", niceDay(k) + (isOpen ? (isSel ? ", selected" : ", available") : ", not available"));
        if (isOpen) btn.addEventListener("click", toggle.bind(null, k));
        days.appendChild(btn);
      }
      grid.replaceChildren(head, days);

      chosen.replaceChildren();
      if (st.selected.length) {
        chosen.appendChild(el("span", "dp-chosen-label", "You picked:"));
        st.selected.forEach(function (k) {
          var chip = el("button", "dp-chip", niceDay(k) + " ×");
          chip.type = "button";
          chip.setAttribute("aria-label", "Remove " + niceDay(k));
          chip.addEventListener("click", function () { toggle(k); });
          chosen.appendChild(chip);
        });
      }
    }

    load();
    return {
      values: function () { return st.selected.slice(); },
      refresh: function (dropped) {
        if (dropped && dropped.length) st.selected = st.selected.filter(function (k) { return dropped.indexOf(k) < 0; });
        return load();
      },
    };
  }


  function setup(form) {
    var state = { token: null, siteKey: null, widgetId: null, tokenAt: 0 };
    var errorEl = form.querySelector(".form-error");
    var button = form.querySelector('button[type="submit"]');
    var buttonLabel = button ? button.textContent : "";
    var tsBox = form.querySelector("[data-turnstile]");
    var dpRoot = form.querySelector("[data-day-picker]");
    var picker = dpRoot ? dayPicker(dpRoot) : null;


    function applySettings(data) {
      if (!data) return;
      if (data.form_token) { state.token = data.form_token; state.tokenAt = Date.now(); }
      if (data.turnstile_site_key && !state.siteKey && tsBox) {
        state.siteKey = data.turnstile_site_key;
        loadTurnstile().then(function (ts) {
          state.widgetId = ts.render(tsBox, { sitekey: state.siteKey, theme: "light" });
        }).catch(function () {
          showError("The spam check couldn't load. Please refresh" + CONTACT + ".");
        });
      }
    }
    publicSettings().then(applySettings);

    function showError(msg, field) {
      if (errorEl) errorEl.textContent = msg || "";
      Array.prototype.forEach.call(form.querySelectorAll(".is-invalid"), function (n) {
        n.classList.remove("is-invalid");
        n.removeAttribute("aria-invalid");
      });
      if (!field) return;
      var target = field === "session_type"
        ? form.querySelector("#inq-session_type, fieldset.inq-types")
        : form.querySelector('[name="' + field + '"]');
      if (target) {
        target.classList.add("is-invalid");
        target.setAttribute("aria-invalid", "true");
        var focusable = target.matches("fieldset") ? target.querySelector("input") : target;
        if (focusable && focusable.focus) focusable.focus();
      }
    }

    function value(name) {
      var n = form.elements[name];
      if (!n) return "";
      if (n.length != null && n.tagName == null) { // RadioNodeList
        return n.value || "";
      }
      return (n.value || "").trim();
    }

    function payload() {
      var dates = picker ? picker.values() : [];
      var turnstileToken = null;
      if (state.widgetId != null && window.turnstile) {
        turnstileToken = window.turnstile.getResponse(state.widgetId) || null;
      }
      return {
        name: value("name"),
        email: value("email"),
        phone: value("phone"),
        instagram: value("instagram"),
        session_type: value("session_type"),
        preferred_dates: dates,
        date_notes: value("date_notes"),
        location: value("location"),
        people_count: value("people_count"),
        usage: value("usage"),
        referral: value("referral"),
        message: value("message"),
        website: form.elements.website ? form.elements.website.value : "",
        form_token: state.token,
        turnstile_token: turnstileToken,
      };
    }

    function clientCheck(p) {
      if (!p.name) return ["Please tell me your name.", "name"];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return ["Please enter a valid email address.", "email"];
      if (!p.session_type) return ["Please choose a session type.", "session_type"];
      if (state.siteKey && !p.turnstile_token) return ["Please complete the verification below.", null];
      return null;
    }

    function post(p) {
      return fetch("/api/inquiry", {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "fetch", accept: "application/json" },
        body: JSON.stringify(p),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          return { status: r.status, ok: r.ok, data: data || {} };
        });
      });
    }

    async function ensureToken() {
      if (!state.token) applySettings(await publicSettings(true));
      // Token must be at least 3s old; humans rarely hit this, but be graceful.
      var wait = 3200 - (Date.now() - state.tokenAt);
      if (state.token && wait > 0) await sleep(wait);
    }

    function resetTurnstile() {
      if (state.widgetId != null && window.turnstile) {
        try { window.turnstile.reset(state.widgetId); } catch (e) { /* ignore */ }
      }
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (button && button.disabled) return;
      var p = payload();
      var bad = clientCheck(p);
      if (bad) { showError(bad[0], bad[1]); return; }
      showError("");
      if (button) { button.disabled = true; button.textContent = "Sending..."; }
      try {
        await ensureToken();
        p = payload();
        if (!p.form_token) throw new Error("no token");
        var res = await post(p);
        // Expired form (page left open a long time): grab a fresh token and retry once.
        if (res.status === 400 && res.data.field === "form_token") {
          applySettings(await publicSettings(true));
          await ensureToken();
          p = payload();
          res = await post(p);
        }
        if (res.ok && res.data.ok) {
          showThankYou(form, res.data.thank_you || {}, p.name);
          return;
        }
        resetTurnstile();
        if (res.status === 409 && picker) picker.refresh(res.data.unavailable || []);
        showError(res.data.error || "Something went wrong. Please try again.", res.data.field === "preferred_dates" ? null : res.data.field);
      } catch (err) {
        resetTurnstile();
        showError("I couldn't send that. Please check your connection and try again" + CONTACT + ".");
      } finally {
        if (button && document.body.contains(button)) { button.disabled = false; button.textContent = buttonLabel; }
      }
    });
  }

  function showThankYou(form, t, fallbackName) {
    var first = t.first_name || String(fallbackName || "").trim().split(/\s+/)[0] || "";
    var panel = el("div", "inq-thanks");
    panel.setAttribute("tabindex", "-1");
    panel.appendChild(el("span", "eyebrow", "Inquiry received"));
    panel.appendChild(el("h2", null, first ? "Thank you, " + first + "!" : "Thank you!"));
    panel.appendChild(el("p", "inq-thanks-lead", t.reply_promise || "I'll get back to you within 24 hours."));

    var details = el("div", "inq-thanks-details");
    function block(label, text) {
      if (!text) return;
      var b = el("div", "inq-thanks-block");
      b.appendChild(el("span", "inq-label", label));
      b.appendChild(el("p", null, text));
      details.appendChild(b);
    }
    var pricing = [t.price_note, t.hourly_rate_text].filter(Boolean).join(" ");
    block("Pricing", pricing);
    block("Holding your date", t.retainer_note);
    block("Turnaround", t.turnaround);
    if (details.childNodes.length) panel.appendChild(details);

    var actions = el("div", "inq-actions");
    var home = el("a", "btn", "Back to the portfolio");
    home.href = "/portfolio";
    actions.appendChild(home);
    panel.appendChild(actions);

    form.parentNode.replaceChild(panel, form);
    document.title = SITE.businessName ? "Thank you | " + SITE.businessName : "Thank you";
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    try { panel.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  function init() {
    var forms = document.querySelectorAll("form[data-inquiry-form]");
    Array.prototype.forEach.call(forms, setup);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
