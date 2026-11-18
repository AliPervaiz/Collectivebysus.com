/* Public pages only (not /admin, not private galleries).
 * 1. Remembers where this visit came from, for the inquiry form:
 *    ?from=instagram (or ?utm_source=...) on the link, else the referring site, else "Direct".
 *    Kept in sessionStorage for this visit only; only a label and a site name, never a full URL.
 * 2. Loads Cloudflare Web Analytics (cookie-free) when SITE_CONFIG.webAnalyticsToken is set. */
(function () {
  "use strict";
  var KEY = "cameFrom";
  var LABELS = [
    [/(^|\.)instagram\.com$/, "Instagram"], [/(^|\.)facebook\.com$|(^|\.)fb\.com$/, "Facebook"],
    [/(^|\.)tiktok\.com$/, "TikTok"], [/(^|\.)pinterest\./, "Pinterest"], [/(^|\.)google\./, "Google"],
    [/(^|\.)bing\.com$/, "Bing"], [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"], [/(^|\.)(t\.co|x\.com|twitter\.com)$/, "X"],
    [/(^|\.)yelp\./, "Yelp"], [/(^|\.)thumbtack\.com$/, "Thumbtack"], [/(^|\.)linktr\.ee$/, "Linktree"],
  ];
  function titleCase(s) { return s.replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  try {
    if (!sessionStorage.getItem(KEY)) {
      var params = new URLSearchParams(location.search);
      var tag = (params.get("from") || params.get("utm_source") || "").trim().slice(0, 40);
      var host = "";
      try { host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, "") : ""; } catch (e) { host = ""; }
      if (host === location.hostname.replace(/^www\./, "")) host = ""; // moving around the site isn't a source
      var label = "Direct";
      if (tag) {
        label = titleCase(tag.toLowerCase());
        LABELS.forEach(function (l) { if (l[0].test(tag.toLowerCase() + ".com")) label = l[1]; });
      } else if (host) {
        label = host;
        for (var i = 0; i < LABELS.length; i++) if (LABELS[i][0].test(host)) { label = LABELS[i][1]; break; }
      }
      sessionStorage.setItem(KEY, JSON.stringify({ label: label, host: host.slice(0, 120) }));
    }
  } catch (e) { /* private mode: no source, that's fine */ }

  window.siteCameFrom = function () {
    try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; }
  };

  var token = (window.SITE_CONFIG || {}).webAnalyticsToken;
  if (token && /^[a-f0-9]{32}$/i.test(token)) {
    var s = document.createElement("script");
    s.defer = true;
    s.src = "https://static.cloudflareinsights.com/beacon.min.js";
    s.setAttribute("data-cf-beacon", JSON.stringify({ token: token }));
    document.head.appendChild(s);
  }
})();
