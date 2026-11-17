/* Small HTTP helpers shared by every route module. */

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

export function forbidden() {
  return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
}

export function notFound() {
  return json({ error: "Not found" }, 404);
}

export function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

/** Parse a JSON body; anything invalid (or over maxBytes) becomes {}. */
export async function readJson(request, maxBytes = 256 * 1024) {
  try {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > maxBytes) return {};
    const text = await request.text();
    if (text.length > maxBytes) return {};
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

export function isMutation(request) {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

// Simple CSRF guard: browsers won't add custom headers to cross-site form posts.
export function hasFetchHeader(request) {
  return request.headers.get("x-requested-with") === "fetch";
}

/** Route path segments after a prefix, e.g. parts(url, "/api/admin/") */
export function pathParts(url, prefix) {
  return url.pathname.slice(prefix.length).split("/").filter(Boolean);
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "0.0.0.0";
}
