# Client Galleries & Booking — Setup

## One-time Cloudflare setup

Run these from the project folder after `npm install` and `npx wrangler login`.

1. **Create the photo bucket**
   ```sh
   npx wrangler r2 bucket create collectivebysus-galleries
   ```

2. **Create the database** and paste the printed `database_id` into `wrangler.jsonc`
   ```sh
   npx wrangler d1 create collectivebysus-galleries
   npm run db:migrate
   ```

3. **Set the cookie-signing secret** (any long random string)
   ```sh
   openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
   ```

4. **Protect `/admin` with Cloudflare Access** (free, up to 50 users)
   - Dashboard → Zero Trust → Access → Applications → Add → Self-hosted.
   - Domain: `collectivebysus.com`, paths `admin` **and** `api/admin`.
     (If the workers.dev URL is still enabled, add it too, or turn it off.)
   - Policy: Allow → Emails → Susi's email (and yours).
   - Login method: One-time PIN (email code) or Google.
   - Copy the **Application Audience (AUD) Tag** into `ACCESS_AUD` in `wrangler.jsonc`,
     and your team domain (`<team>.cloudflareaccess.com`, from Zero Trust → Settings)
     into `ACCESS_TEAM_DOMAIN`.
   - The worker verifies the Access token itself, so if Access is misconfigured
     the admin is locked rather than open.

5. **(Optional) Email Susi when a client submits**
   - Enable Email Routing on collectivebysus.com and verify `contact@collectivebysus.com`
     as a destination address.
   - Uncomment the `send_email` block in `wrangler.jsonc`.

6. Deploy: `npm run deploy` (or merge to main if Git deploys are set up).

## Using it (for Susi)

1. Go to **collectivebysus.com/admin** and sign in.
2. **New Gallery**: add a title, client name, and optionally a PIN, selection limit, expiry date, or downloads.
3. Drag in the edited JPEGs. They're resized in the browser (2560px long edge), so
   uploads are quick and originals never leave her computer. Keep the tab open until it says done.
   Re-dropping the same files skips ones already uploaded.
4. **Copy** the link and send it to the client (with the PIN, if set).
5. The client hearts photos and hits "Send my selections". The gallery shows the picks and the client's note.
6. **Copy for Lightroom**, then in Lightroom: Library → Filter bar → Text → Filename → Contains → paste.

## Booking (Cal.com)

1. Sign up at cal.com and connect Google Calendar (Settings → Calendars).
   Set availability and buffer time between sessions.
2. Create an event type (e.g. "Photo Session") and turn on **multiple durations**
   (1h / 2h / 3h / 4h) so clients pick how many hours they want.
   Add booking questions (session type, location, number of people).
   Optional: "Requires confirmation" so she approves each request, or a Stripe deposit.
3. Set `CAL_LINK` in `contact.html` to `<username>/<event-slug>`.

## Local development

```sh
cp .dev.vars.example .dev.vars   # skips Access on localhost only
npm run db:migrate:local
npm run dev                      # http://localhost:8787/admin/
```

## Costs

R2 includes 10 GB of free storage and free egress. At about 0.6 MB per photo, that's
roughly 15,000 client photos before paying ~$0.015/GB-month. D1, Workers, and Access
are well within their free tiers at this scale.
