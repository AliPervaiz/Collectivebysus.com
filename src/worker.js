/**
 * Collective by Sus — site worker (router)
 *
 * Serves the static site, plus:
 *   /admin, /admin/*        CRM + gallery manager UI (Cloudflare Access)
 *   /api/admin/*            Admin JSON API (Cloudflare Access)
 *   /g/:slug                Private client gallery page
 *   /api/g/:slug/*          Client gallery JSON API + images
 *   /api/public/settings    Public business settings (price note, Cal link, form token)
 *   /api/public/availability  Open days for the inquiry form's day picker
 *   /api/inquiry            Public inquiry form submission
 *   /api/webhooks/cal       Cal.com booking webhook (HMAC signed)
 *   scheduled (weekly)      database backup to R2 backups/ (src/lib/backup.js)
 *
 * Bindings (see wrangler.jsonc):
 *   ASSETS   static assets
 *   DB       D1 database (migrations/)
 *   PHOTOS   R2 bucket holding resized images
 *   NOTIFY   optional send_email binding for alerts to the photographer
 *   EMAIL    optional Cloudflare Email Service binding for client auto-replies
 *
 * Vars / secrets:
 *   ACCESS_TEAM_DOMAIN, ACCESS_AUD, ADMIN_EMAILS   admin auth
 *   SESSION_SECRET            signs gallery PIN cookies and inquiry form tokens
 *   NOTIFY_FROM / NOTIFY_TO   alert addresses (optional)
 *   CLIENT_EMAIL_FROM         sender for client auto-replies (optional)
 *   RESEND_API_KEY            optional Resend transport (secret)
 *   TURNSTILE_SITE_KEY / TURNSTILE_SECRET   optional Turnstile on the inquiry form
 *   CAL_WEBHOOK_SECRET        Cal.com webhook signing secret
 *   DEV_ADMIN_BYPASS          "true" in .dev.vars only, skips Access on localhost
 */

import { json, forbidden, withHeaders, isMutation, hasFetchHeader, pathParts } from "./lib/http.js";
import { requireAdmin } from "./lib/auth.js";
import { handleAdminGalleries } from "./routes/admin-galleries.js";
import { handleClient } from "./routes/client-gallery.js";
import { handleCrm } from "./routes/crm.js";
import { handleInquiry, handlePublicSettings, handlePublicAvailability } from "./routes/inquiry.js";
import { handleCalWebhook } from "./routes/webhooks.js";
import { runBackup } from "./lib/backup.js";

export default {
  // Weekly database backup into R2 (see "triggers" in wrangler config and src/lib/backup.js).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env, { reason: "weekly" }).then(
      (r) => console.log(`backup ${r.name}: ${r.rows} rows, ${r.size} bytes, pruned ${r.pruned}`),
      (err) => { console.error("backup failed", err); throw err; }
    ));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/admin" || path.startsWith("/admin/")) {
        if (!(await requireAdmin(request, env, url))) return forbidden();
        const res = await env.ASSETS.fetch(request);
        return withHeaders(res, { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
      }

      if (path.startsWith("/api/admin/")) {
        const admin = await requireAdmin(request, env, url);
        if (!admin) return json({ error: "Not authorized" }, 403);
        if (isMutation(request) && !hasFetchHeader(request)) return json({ error: "Bad request" }, 400);
        const parts = pathParts(url, "/api/admin/");
        if (parts[0] === "galleries" || parts[0] === "photos") {
          return await handleAdminGalleries(request, env, parts);
        }
        return await handleCrm(request, env, parts, ctx, admin);
      }

      if (path.startsWith("/api/g/")) {
        if (isMutation(request) && !hasFetchHeader(request)) return json({ error: "Bad request" }, 400);
        return await handleClient(request, env, url, ctx);
      }

      if (path === "/api/public/settings") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        return await handlePublicSettings(request, env);
      }

      if (path === "/api/public/availability") {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        return await handlePublicAvailability(request, env);
      }

      if (path === "/api/inquiry") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        if (!hasFetchHeader(request)) return json({ error: "Bad request" }, 400);
        return await handleInquiry(request, env, ctx, url);
      }

      if (path === "/api/webhooks/cal") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        return await handleCalWebhook(request, env, ctx);
      }

      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);

      if (/^\/g\/[a-z0-9]+\/?$/.test(path)) {
        const res = await env.ASSETS.fetch(new Request(new URL("/gallery", url), request));
        return withHeaders(res, {
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
          "referrer-policy": "same-origin",
        });
      }

      // The old standalone inquiry page now lives on Contact; keep shared links working.
      if (/^\/inquire(\.html)?\/?$/.test(path)) {
        return Response.redirect(`${url.origin}/contact#inquire`, 301);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
};
