# Collective by Sus: site + studio admin

The public site is static HTML. One Cloudflare Worker (`collectivebysus`) also runs:

| Path | What |
|---|---|
| `/contact` | Inquiry form first, with a **day picker** (clients tap weekend days they're open to). Use `collectivebysus.com/contact` as the Instagram-bio link; old `/inquire` links redirect here. |
| `/privacy` | Privacy policy (linked from every footer and under the form). |
| `/g/<link>` | Private client galleries (favorites, PIN, downloads). |
| `/admin` | Susi's studio admin: Dashboard, Clients, Calendar, Sessions, Galleries, Settings. Behind Cloudflare Access. |

Code is shared with the Fieldnote Studio template (`../fieldnote-studio`). Brand values live
in `src/lib/brand.js`, `js/site-config.js`, the `:root` tokens in `css/styles.css`, and the
page frames (`contact.html`, `privacy.html`, `gallery.html`, `admin/index.html`).

## How Susi uses it
1. **New inquiry** → email alert to collectivebysus@gmail.com, and it shows on the Dashboard
   under "needs attention". It shows the days the client picked and any timing notes.
2. Reply by DM/email, then **Mark replied** (pick how you replied with the pencil).
3. When a date is agreed, **Start session** from the inquiry (or + Session) and set it to **Booked**.
   Booked sessions fill that day; at 3 the day disappears from the public picker.
4. **Calendar**: tap an upcoming day to add a session, **block** it (vacation, family), or
   **open** a weekday as a one-off. "Asks" = open inquiries that picked that day.
5. After the shoot: create the **gallery** from the session, send the link. When the client
   sends favorites you get an email and the session moves to **Editing**.
6. Log payments (Venmo/Zelle/cash) on the session; balances owed show on the Dashboard.
7. **Settings → Availability**: shoot days (Sat/Sun), shoots per day (3), days a client can
   pick (5), how far ahead (90 days).

## Config (wrangler.jsonc)
- D1 `collectivebysus-galleries` (migrations 0001–0003), R2 `collectivebysus-galleries`.
- Access: team `aged-sun-d138.cloudflareaccess.com`, AUD in `ACCESS_AUD`; app covers
  `/admin` and `/api/admin`. The worker also verifies the Access JWT.
- Email: `send_email` binding → collectivebysus@gmail.com (verified Email Routing destination),
  from `studio@collectivebysus.com`. Client auto-replies are off (need `RESEND_API_KEY` +
  `CLIENT_EMAIL_FROM`).
- Secrets: `SESSION_SECRET` (set). Set secrets with `wrangler secret put` right after a production
  deploy, then confirm with `wrangler secret list`.
- Optional: `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET` (spam check), `CAL_WEBHOOK_SECRET` (unused).

## Deploying
Merging to `main` deploys via Cloudflare Workers Builds. New migrations must be applied first:
`npm run db:migrate` (remote). Migrations are additive.

## Local
```sh
cp .dev.vars.example .dev.vars && npm install && npm run db:migrate:local && npm run dev
npm run test:smoke   # with the dev server running on :8787
```
