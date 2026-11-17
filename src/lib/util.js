/* Validation, encoding and crypto helpers. */

const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l confusion

export function randomSlug(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
}

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

/** Trimmed string capped at max chars, or null when empty. */
export function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

/** Single-line text: newlines/control chars collapsed to spaces. */
export function cleanLine(v, max) {
  if (v == null) return null;
  return cleanText(String(v).replace(/[\u0000-\u001f\u007f]+/g, " "), max);
}

export function cleanPin(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 32) : null;
}

/** Positive integer or null. */
export function cleanInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Non-negative integer number of cents, or null. Accepts 12345 (cents). */
export function cleanCents(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) return null;
  return Math.round(n);
}

/** Positive number (e.g. hours: 1.5) capped, or null. */
export function cleanNumber(v, max = 1000) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : null;
}

/** YYYY-MM-DD or null. */
export function cleanDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Any parseable date/time string -> ISO string, or null. Accepts "YYYY-MM-DDTHH:MM" local too. */
export function cleanDateTime(v) {
  if (typeof v !== "string" || !v || v.length > 40) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Lowercased email or null. Deliberately loose: one @, a dot in the domain, no spaces. */
export function cleanEmail(v) {
  const s = cleanText(v, 200);
  if (!s) return null;
  const e = s.toLowerCase();
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(e) ? e : null;
}

/** Instagram handle without the @, or null. */
export function cleanHandle(v) {
  const s = cleanText(v, 100);
  if (!s) return null;
  const h = s.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(h) ? h : null;
}

/** Value from a fixed list, or fallback. */
export function oneOf(v, allowed, fallback = null) {
  return allowed.includes(v) ? v : fallback;
}

export function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64url(bytes) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

export async function signToken(secret, data) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

export async function verifyToken(secret, data, token) {
  try {
    return await crypto.subtle.verify(
      "HMAC", await hmacKey(secret), b64urlDecode(token), new TextEncoder().encode(data)
    );
  } catch {
    return false;
  }
}

/** Constant-time-ish compare of two strings. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}
