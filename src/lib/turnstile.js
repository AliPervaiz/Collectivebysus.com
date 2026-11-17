/* Cloudflare Turnstile verification (only active when both keys are configured). */

export function turnstileEnabled(env) {
  return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}

/** Verify a Turnstile token. Returns true when Turnstile is disabled. */
export async function verifyTurnstile(env, token, ip) {
  if (!turnstileEnabled(env)) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip && ip !== "0.0.0.0") form.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.success === true;
  } catch (err) {
    console.error("turnstile verify failed", err && err.message);
    return false;
  }
}
