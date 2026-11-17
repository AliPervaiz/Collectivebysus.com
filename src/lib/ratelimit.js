/* Fixed-window rate limiting backed by the D1 `rate_limits` table. */

import { sha256Hex } from "./util.js";

/**
 * Count one hit for (bucket, key) in the current window and report whether it
 * is within `limit`. `key` should already be hashed (see hashedIpKey); raw IPs
 * are never stored. Fails open if the table is unavailable.
 * Returns { ok, count, retryAfter } (retryAfter in seconds).
 */
export async function rateLimit(env, bucket, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  let count = 0;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, key, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(bucket, key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`
    ).bind(bucket, key, windowStart).first();
    count = row ? Number(row.count) : 0;
    // Opportunistic cleanup of old windows (~1 in 20 requests).
    if (Math.random() < 0.05) {
      await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 86400).run();
    }
  } catch (err) {
    console.error("rate limit unavailable", err && err.message);
    return { ok: true, count: 0, retryAfter: 0 };
  }
  return { ok: count <= limit, count, retryAfter: windowStart + windowSeconds - now };
}

/** Hash an IP (peppered with SESSION_SECRET when set) for use as a rate-limit key. */
export async function hashedIpKey(env, ip) {
  return sha256Hex((env.SESSION_SECRET || "") + (ip || ""));
}
