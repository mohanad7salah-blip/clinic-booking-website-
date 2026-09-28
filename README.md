# Dr. Ali Al-Zubaidi Dental Clinic — Website & Booking System
**عيادة الدكتور علي الزبيدي** · Al-Rubaie Street, Zayouna, Baghdad · 0770 626 6800

A bilingual (Arabic RTL / English LTR) dental clinic website with a working appointment booking system: server-side availability, atomic double-booking protection, idempotent requests, automatic WhatsApp Business notifications with retries, a separate Test/Demo mode and a secured admin dashboard.

> ⚠️ **Important about hosting.** The website files are static, but booking, notifications and admin **need the backend** in `backend/` (a Cloudflare Worker with a D1 SQLite database). On a static-only host (for example the editor preview or the Publish tab) the pages work, but the booking form shows *"The booking system can't be reached right now"* and offers Call/WhatsApp instead. It never pretends a booking succeeded. Deploy the Worker (see §14) to turn booking on.

---

## 1. Architecture

```
Browser (index.html, services/*.html, admin.html)
   │  fetch /api/*   (no secrets in the browser)
   ▼
Cloudflare Worker  backend/src/index.js ── serves the static site too (same origin)
   ├─ availability.js  slot engine (Asia/Baghdad, hours, duration, buffer, blocks, notice)
   ├─ bookings.js      validation → atomic D1 batch (appointment + slot locks + idempotency + outbox)
   ├─ whatsapp.js      outbox processor, recipient routing test/prod, retries, webhooks
   ├─ auth.js / admin.js  PBKDF2 login, hashed sessions, CSRF, roles, audit log
   ├─ ratelimit.js     per-IP (hashed) fixed-window limits
   └─ cron (every minute) → retry due notifications, housekeeping
   ▼
Cloudflare D1 (SQLite)  backend/schema.sql
   ▼
Meta WhatsApp Cloud API (graph.facebook.com)  ← server-side only
```

| Path | Purpose |
|---|---|
| `index.html` | Homepage: hero, trust facts, services, about, booking wizard, location, contact |
| `services/<slug>.html` | 10 SEO service pages (teeth-whitening, emax, cosmetic-dentistry, orthodontic-treatment, gold-braces, metal-braces, clear-braces, clear-aligners, dental-fillings, wisdom-tooth-extraction) |
| `index.html?service=<slug>#booking` | Opens booking with the service already selected |
| `?lang=ar` / `?lang=en` | Forces a language (the choice is saved in localStorage) |
| `admin.html` | Admin dashboard (noindex; needs the backend) |
| `js/config.js` | **Public** config (API base, clinic facts). No secrets. |
| `js/i18n.js` | All UI strings in AR/EN |
| `js/services-data.js` | Service display content (no prices or durations) |
| `backend/` | Worker source, schema, tests, scripts |

### API
| Method & path | Notes |
|---|---|
| `GET /api/health` | `{environment}` |
| `GET /api/public-config` | Hours, active services, timezone. No secrets. |
| `GET /api/availability?service=&date=YYYY-MM-DD` | Free start times only |
| `GET /api/availability/calendar?service=` | Per-day open/available counts for the booking window |
| `POST /api/bookings` | JSON body + **`Idempotency-Key`** header (required) |
| `GET /api/bookings/:reference` | Returns non-sensitive fields only (no name, phone or notes) |
| `GET/POST /api/webhooks/whatsapp` | Meta verify handshake / status updates (HMAC verified) |
| `/api/admin/*` | Session cookie + `X-CSRF-Token`. Same origin only. |

Error codes: `VALIDATION`, `SLOT_UNAVAILABLE`, `INVALID_SLOT`, `RATE_LIMITED`, `IDEMPOTENCY_KEY_REUSED`, `TOO_MANY_ACTIVE_BOOKINGS`, `SERVER`. The UI turns each code into a friendly AR/EN message and never shows raw errors.

## 2. Installation
```bash
cd backend
npm install
npx wrangler login
npx wrangler d1 create alz_booking          # copy database_id into wrangler.toml
npm run db:init:local && npm run db:init:remote
cp .dev.vars.example .dev.vars               # local secrets (git-ignored)
npm run dev                                  # http://127.0.0.1:8787 serves site + API
```

## 3. Environment variables
Non-secret values go in `wrangler.toml [vars]`. **Secrets are set with `npx wrangler secret put NAME`** and are never committed or sent to the browser.

| Name | Type | Meaning |
|---|---|---|
| `APP_ENV` | var | `test` \| `production` (must match `WHATSAPP_MODE`, otherwise the admin sees a warning) |
| `WHATSAPP_MODE` | var | **The production switch.** `test` \| `production` |
| `WHATSAPP_TEST_RECIPIENT` | secret | `+9647755473704` (default test recipient) |
| `WHATSAPP_CLINIC_RECIPIENT` | secret | Clinic's production WhatsApp number |
| `WHATSAPP_API_TOKEN` | secret | Meta system-user permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | secret | Sender phone-number ID |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | secret | WABA ID (reference) |
| `WHATSAPP_APP_SECRET` | secret | Used to verify `X-Hub-Signature-256` on webhooks |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | secret | Any random string, also entered in the Meta dashboard |
| `WHATSAPP_TEMPLATE_CLINIC` / `_PATIENT` | var | Approved template names (optional) |
| `WHATSAPP_SIMULATE_FAILURE` | var | `true` forces send failures (**test mode only**) |
| `IP_HASH_SALT` | secret | Salt for hashing IPs in rate limits |
| `ALLOWED_ORIGINS` | var | Only if the site is hosted on a different origin than the API |
| `RATE_LIMIT_DISABLED` | var | `true` only on a test Worker while running the concurrency script |

`DATABASE_URL` is not used: D1 is bound as `DB` in `wrangler.toml`.

## 4. Database setup
`backend/schema.sql` is idempotent and creates: `services`, `appointments`, `slot_locks`, `idempotency_keys`, `notifications`, `clinic_settings`, `blocked_times`, `admins`, `admin_sessions`, `rate_limits`, `audit_log`. The seed data contains only clinic-supplied facts:
- 10 services, all with duration NULL (uses the clinic default).
- Hours Sat–Thu 15:00–20:00. **Friday is `null` (closed/unconfirmed); no hours were made up.** Change this in the admin panel once the clinic confirms.
- Booking rules: default duration 30 min, buffer 0, 30-min steps, 30-day window, 120-min minimum notice. These are placeholders you can change in the admin panel.

## 5. Booking system
Steps: service → date (calendar from the server) → time (only free slots) → details (name and phone required; email and notes optional) → review → confirm. The server then re-validates, reserves atomically, creates the booking reference `ALZ-YYYY-XXXXX` (Crockford base32, UNIQUE), writes notification jobs and returns. WhatsApp sending runs **after** the commit (`ctx.waitUntil` + cron).

## 6. Double-booking protection
- Every booking owns one `slot_locks` row per 5-minute block it covers (duration + buffer). The primary key `(environment, slot_date, slot_minute)` means two bookings can't hold the same block.
- The appointment, its locks, the idempotency record and both notification jobs are written in **one D1 `batch()`**, which runs as one SQL transaction. If any lock already exists, the whole batch rolls back and the API returns `409 SLOT_UNAVAILABLE`: *"عذراً، هذا الموعد تم حجزه للتو…" / "Sorry, this appointment was just booked…"*.
- The pre-check (`SELECT` availability) only gives nicer error messages. Correctness does **not** depend on it.
- Cancelling a booking deletes its locks, so the slot becomes free again. Completed and no-show bookings keep their locks, since the time is in the past.
- Test and production bookings use separate lock namespaces through `environment`.

## 7. Idempotency
- The browser creates a UUID per submission and stores it with the payload in `sessionStorage`. Double-clicks, retries and **page refreshes** reuse the same key. After a refresh, an in-flight submission is re-sent automatically with that key.
- The server's `idempotency_keys` table (PK `environment, key`) plus `appointments UNIQUE(environment, idempotency_key)` means a replay returns the **original** booking (`200, replayed: true`) and creates nothing.
- Reusing a key with a different payload returns `422 IDEMPOTENCY_KEY_REUSED`.
- A temporary error keeps every field the patient entered, and "Try again" uses the same key.

## 8. WhatsApp configuration
**A phone number alone cannot send WhatsApp messages automatically.** You need a WhatsApp Business Platform (Cloud API) account or a compliant provider:
1. Create a Meta Business account → developers.facebook.com → create an app → add **WhatsApp**.
2. Register or verify the sender number and note the **Phone number ID** and **WABA ID**.
3. Create a **System User** with `whatsapp_business_messaging` permission and generate a permanent token.
4. `wrangler secret put` each of `WHATSAPP_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_TEST_RECIPIENT`.
5. Webhook: callback `https://<your-domain>/api/webhooks/whatsapp`, verify token = your secret, subscribe to **messages**. This gives you sent/delivered/read/failed status.
6. **Templates.** Business-initiated messages to someone who hasn't messaged the number in the last 24 hours must use an approved template. Create them and set `WHATSAPP_TEMPLATE_CLINIC` / `WHATSAPP_TEMPLATE_PATIENT`. Body parameter order:
   - clinic: `{{1}}` TEST/NEW, `{{2}}` name, `{{3}}` phone, `{{4}}` service, `{{5}}` date, `{{6}}` time, `{{7}}` reference
   - patient: `{{1}}` service, `{{2}}` date, `{{3}}` time, `{{4}}` reference

   Without templates, free-form text is sent. That only works inside a 24-hour customer-service window, so Meta will reject some messages, and the dashboard will show them as *failed* with Meta's error.
7. In **Meta test mode**, the test recipient `+9647755473704` must be added as an allowed recipient in the app dashboard.

If the credentials are missing, bookings still succeed. Notifications are marked `failed` with *"INTEGRATION_NOT_CONFIGURED"*, the admin sees an "Integration not configured" warning, and the patient sees "the clinic will contact you" instead of a claim that WhatsApp was sent. Once credentials are added, press **Retry**.

Notification guarantees: the key `UNIQUE(appointment_id, type, environment)`, an atomic claim with `UPDATE … WHERE status IN ('pending','retrying')`, exponential backoff (1m, 2m, 4m… up to 6h, max 5 attempts), and a message is **never auto-resent when its outcome is unknown** (a worker crash mid-send is marked failed for a human to check). Webhook updates only move a status forward. "Delivered" is shown only after the provider confirms it.

## 9. Test mode
`WHATSAPP_MODE=test` (the default). **All** messages go to the test recipient **+9647755473704**: clinic notifications *and* patient confirmations, so real patients and the clinic never get test messages. Messages start with **"🧪 TEST BOOKING"**, bookings are stored with `environment='test'`, the confirmation screen shows a TEST badge, and the admin panel shows a striped yellow **TEST MODE** banner. The whole pipeline is the same as production; only the recipient and environment differ.

## 10. Test recipient
`WHATSAPP_TEST_RECIPIENT=+9647755473704`. It is stored **only** as a Worker secret. It is not in any frontend file; the admin panel shows it masked (`+96477•••••704`).

## 11. How to make a test booking
1. Deploy in test mode (§14) with the WhatsApp secrets set.
2. Open the site → Book → choose a service, date and time → enter your details → Confirm.
3. You should see the booking reference and the TEST badge, and receive a 🧪 message on +9647755473704.
4. Admin → **Send test message** checks the integration without creating a booking.
5. `WHATSAPP_SIMULATE_FAILURE=true` shows the retrying → failed flow while the booking stays valid.

Scripted tests (see `docs/TESTING.md`): `npm test` (unit), `npm run test:idempotency`, `npm run test:concurrency` (both refuse to run unless the server is in test mode).

## 12. How to check notification status
Admin → **Notifications** shows status (pending, processing, sent, delivered, read, retrying, failed), recipient, attempts, provider message ID, last error, next retry and a Retry button for failed messages the provider never accepted. Live logs: `npm run tail`.

## 13. How to switch to production
```bash
npx wrangler secret put WHATSAPP_CLINIC_RECIPIENT      # e.g. +9647706266800 — must differ from the test number
# wrangler.toml: APP_ENV = "production", WHATSAPP_MODE = "production"
npm run deploy
```
No code changes are needed. In production, clinic notifications go to `WHATSAPP_CLINIC_RECIPIENT` and patient confirmations go to the patient. The router **refuses** to send a production message to the test number, and refuses any notification whose environment doesn't match the server mode. Test data stays in the database under `environment='test'` and never affects production availability.

## 14. Deployment
```bash
cd backend && npm run db:init:remote && npm run deploy
```
`wrangler.toml` serves the repository root as static assets (`.assetsignore` excludes `backend/`, `docs/` and the README) and routes `/api/*` to the Worker, all on one origin. Then:
- Add a custom domain in Cloudflare → Workers → Settings → Domains.
- Replace `https://alzubaidi-dental.example` in `index.html`, `services/*.html`, `sitemap.xml` and `robots.txt` with the real domain.
- Optional: paste the exact Google Maps embed URL into `js/config.js → map_embed_url`.

If you host the static files somewhere else, set `API_BASE` in `js/config.js` to the Worker URL and add that site's origin to `ALLOWED_ORIGINS`. The admin panel must still be opened on the Worker's origin, because its cookie is SameSite=Strict.

> The Genspark **Publish tab** / preview serves the static files only; the booking API won't run there. Use the Cloudflare Worker deployment above for a working booking system.

## 15. Admin setup
```bash
cd backend
node scripts/create-admin.mjs owner@clinic.example "a long strong passphrase" owner
npx wrangler d1 execute alz_booking --remote --command "<paste printed INSERT>"
```
Roles: `owner` (everything) and `staff` (appointments, notifications, blocked times; cannot edit services or settings). Sessions last 8 hours in an HttpOnly, Secure, SameSite=Strict `__Host-` cookie; only the token hash is stored. Each session has a CSRF token. After 5 failed logins the account locks for 15 minutes, on top of the per-IP limit. Admin actions are recorded in `audit_log`.

## 16. Troubleshooting
| Symptom | Fix |
|---|---|
| Booking shows "can't be reached" | The site is served without the Worker, or `API_BASE` is wrong. Check `/api/health`. |
| No slots at all | Check hours, the booking window and minimum notice in Admin → Settings. Friday is closed until configured. |
| Notifications `failed: INTEGRATION_NOT_CONFIGURED` | Set the WhatsApp secrets, then Retry. |
| Meta error 131047 / 131030 | Outside the 24h window → use approved templates. In Meta test mode, add the recipient to the allowed list. |
| Webhook 401 | `WHATSAPP_APP_SECRET` is missing or wrong. |
| Admin "APP_ENV and WHATSAPP_MODE disagree" | Set both to the same value. |
| Concurrency script gets 429s | Set `RATE_LIMIT_DISABLED=true` on the **test** Worker while testing. |

---

## Status
**Done:** bilingual site (complete AR/EN switch, saved preference), 10 service pages, SEO (unique titles and descriptions, canonical, hreflang, OG/Twitter, Dentist/Service/Breadcrumb JSON-LD, sitemap, robots), accessibility (skip link, semantic landmarks, labels, focus styles, reduced motion, aria-live), mobile sticky action bar, booking wizard, Worker API, D1 schema, atomic locks, idempotency, WhatsApp outbox/retry/webhooks, test mode, admin dashboard, rate limiting, honeypot, unit, concurrency and idempotency tests, documentation (`docs/TESTING.md`, `docs/SECURITY.md`).

**Not done / needs the clinic:** real domain; WhatsApp Business account and approved templates; confirmed Friday hours and real per-service durations; real clinic photos (the hero image is an illustrative stock photo and is labelled as such); an exact map pin; an analytics provider (the hook exists and never sends personal data); Cloudflare Turnstile (optional, can be added in `bookings.js`).

**Suggested next steps:** deploy the Worker in test mode → run the checklist in `docs/TESTING.md` → create the WhatsApp templates → switch to production (§13).

**Data stores:** Cloudflare D1 (all booking data). The Genspark Table API is not used.
