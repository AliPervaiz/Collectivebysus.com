/* Admin entry point: hash router + nav highlighting. */

import { renderGalleryList, renderGalleryDetail, isUploading } from "./galleries.js";
import { renderDashboard } from "./dashboard.js";
import { renderClients, renderClientDetail } from "./clients.js";
import { renderSessions, renderSessionDetail } from "./sessions.js";
import { renderSettings } from "./settings.js";
import { renderCalendar } from "./calendar.js";

const routes = [
  [/^\/?$/, "dashboard", () => renderDashboard()],
  [/^\/clients\/?$/, "clients", () => renderClients()],
  [/^\/c\/([\w-]+)/, "clients", (m) => renderClientDetail(m[1])],
  [/^\/calendar\/?$/, "calendar", (m, q) => renderCalendar(q)],
  [/^\/sessions\/?$/, "sessions", (m, q) => renderSessions(q)],
  [/^\/s\/([\w-]+)/, "sessions", (m) => renderSessionDetail(m[1])],
  [/^\/galleries\/?$/, "galleries", () => renderGalleryList()],
  [/^\/g\/([\w-]+)/, "galleries", (m) => renderGalleryDetail(m[1])],
  [/^\/settings\/?$/, "settings", () => renderSettings()],
];

function setNav(section) {
  for (const a of document.querySelectorAll(".admin-nav-links a[data-nav]")) {
    const on = a.dataset.nav === section;
    a.classList.toggle("active", on);
    if (on) {
      a.setAttribute("aria-current", "page");
      const ul = a.closest("ul");
      if (ul && ul.scrollWidth > ul.clientWidth) ul.scrollLeft = a.offsetLeft - (ul.clientWidth - a.offsetWidth) / 2;
    } else a.removeAttribute("aria-current");
  }
}

function route() {
  if (isUploading()) return;
  document.querySelectorAll("body > .modal").forEach((m) => m.remove());
  document.body.classList.remove("no-scroll");
  const raw = location.hash.replace(/^#/, "");
  const [path, qs = ""] = raw.split("?");
  const query = new URLSearchParams(qs);
  for (const [re, section, fn] of routes) {
    const m = path.match(re);
    if (m) {
      setNav(section);
      fn(m, query);
      window.scrollTo(0, 0);
      return;
    }
  }
  location.replace("#/");
}

window.addEventListener("hashchange", route);
route();
