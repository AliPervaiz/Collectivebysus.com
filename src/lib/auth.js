/* Cloudflare Access verification for /admin and /api/admin/*. */

import { b64urlDecode } from "./util.js";

let certCache = { at: 0, keys: [] };
let lastForcedFetch = 0;

/** Returns { email } for a valid admin, or null. */
export async function requireAdmin(request, env, url) {
  if (env.DEV_ADMIN_BYPASS === "true" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return { email: "dev@localhost" };
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  let jwk = (await getAccessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await getAccessKeys(team, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (!payload.exp || payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now + 60) return null;

  if (env.ADMIN_EMAILS) {
    const allowed = env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(String(payload.email || "").toLowerCase())) return null;
  }
  return { email: payload.email };
}

async function getAccessKeys(team, force = false) {
  if (!force && certCache.keys.length && Date.now() - certCache.at < 60 * 60 * 1000) return certCache.keys;
  // An unknown kid forces a refresh (key rotation), but at most once a minute so
  // junk tokens can't turn every request into a certs fetch.
  if (force) {
    if (Date.now() - lastForcedFetch < 60 * 1000) return certCache.keys;
    lastForcedFetch = Date.now();
  }
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) return certCache.keys;
  const data = await res.json();
  certCache = { at: Date.now(), keys: data.keys || [] };
  return certCache.keys;
}
