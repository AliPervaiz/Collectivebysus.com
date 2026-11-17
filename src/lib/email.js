/**
 * Email adapter.
 *
 * Two kinds of mail, each with its own transport chosen from what is configured:
 *
 *   sendOwnerEmail(env, msg)   alerts to the photographer (NOTIFY_TO)
 *     1. NOTIFY  send_email binding (Cloudflare Email Routing). Free, but it can
 *        only deliver to verified destination addresses, which is fine for the owner.
 *     2. Resend  (RESEND_API_KEY) as a fallback when NOTIFY isn't bound.
 *
 *   sendClientEmail(env, msg)  auto-replies to clients (arbitrary addresses)
 *     1. EMAIL   Cloudflare Email Service binding (send_email with no destination
 *        restriction). Beta, and arbitrary recipients need Workers Paid.
 *     2. Resend  via fetch with RESEND_API_KEY (free tier: 100/day, needs a
 *        verified sending domain).
 *
 * msg = { subject, text, replyTo? } (+ { to } for client mail).
 * Every function resolves to { sent: boolean, via?: string } and never throws when
 * unconfigured. Callers should still wrap in ctx.waitUntil(... .catch(console.error)).
 */

import { EmailMessage } from "cloudflare:email";
import { b64 } from "./util.js";
import { BRAND } from "./brand.js";

const FROM_NAME = BRAND.businessName;

export function emailStatus(env) {
  return {
    owner: !!ownerTransport(env),
    client: !!clientTransport(env),
    owner_via: ownerTransport(env),
    client_via: clientTransport(env),
  };
}

function ownerTransport(env) {
  if (!env.NOTIFY_TO || !env.NOTIFY_FROM) return null;
  if (env.NOTIFY) return "send_email";
  if (env.RESEND_API_KEY) return "resend";
  return null;
}

function clientTransport(env) {
  const from = env.CLIENT_EMAIL_FROM || env.NOTIFY_FROM;
  if (!from) return null;
  if (env.EMAIL && typeof env.EMAIL.send === "function") return "email_service";
  if (env.RESEND_API_KEY) return "resend";
  return null;
}

export async function sendOwnerEmail(env, { subject, text, replyTo }) {
  const via = ownerTransport(env);
  if (!via) return { sent: false };
  if (via === "send_email") {
    const raw = buildMime({ from: env.NOTIFY_FROM, to: env.NOTIFY_TO, subject, text, replyTo });
    await env.NOTIFY.send(new EmailMessage(env.NOTIFY_FROM, env.NOTIFY_TO, raw));
  } else {
    await sendResend(env, { from: env.NOTIFY_FROM, to: env.NOTIFY_TO, subject, text, replyTo });
  }
  return { sent: true, via };
}

export async function sendClientEmail(env, { to, subject, text, replyTo }) {
  const via = clientTransport(env);
  if (!via || !to) return { sent: false };
  const from = env.CLIENT_EMAIL_FROM || env.NOTIFY_FROM;
  const reply = replyTo || env.NOTIFY_TO || undefined;
  if (via === "email_service") {
    await env.EMAIL.send({ to, from: { email: from, name: FROM_NAME }, subject, text, replyTo: reply });
  } else {
    await sendResend(env, { from, to, subject, text, replyTo: reply });
  }
  return { sent: true, via };
}

async function sendResend(env, { from, to, subject, text, replyTo }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: `${FROM_NAME} <${from}>`,
      to: [to],
      subject,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend failed (${res.status})`);
}

function headerSafe(s) {
  return String(s || "").replace(/[\r\n]+/g, " ").trim();
}

function buildMime({ from, to, subject, text, replyTo }) {
  const enc = (s) => b64(new TextEncoder().encode(s));
  const domain = String(from).split("@")[1] || "localhost";
  const lines = [
    `From: ${FROM_NAME} <${headerSafe(from)}>`,
    `To: ${headerSafe(to)}`,
    replyTo ? `Reply-To: ${headerSafe(replyTo)}` : null,
    `Subject: =?UTF-8?B?${enc(headerSafe(subject))}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    enc(text).replace(/.{76}/g, "$&\r\n"),
  ];
  return lines.filter((l) => l !== null).join("\r\n");
}
