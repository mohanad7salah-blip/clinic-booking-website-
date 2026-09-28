# Security Review

| Threat | Mitigation |
|---|---|
| **XSS** | All dynamic HTML goes through `esc()` (public site and admin). Patient data only appears in the authenticated admin view, escaped. Strict CSP from the Worker (`script-src 'self'`, `frame-ancestors 'none'`). No inline scripts except JSON-LD data. |
| **SQL injection** | Every query uses D1 prepared statements with bound parameters. LIKE search escapes `%` and `_`. Identifiers are never built from user input. |
| **NoSQL injection** | Not applicable (SQLite). |
| **CSRF** | Admin cookie is `SameSite=Strict`, and every admin mutation also needs the per-session `X-CSRF-Token`. The public booking POST requires `Content-Type: application/json`, which blocks simple cross-site form posts, plus an Idempotency-Key. |
| **IDOR** | Public lookup only by an unguessable reference (32^5 × year) and returns only non-sensitive fields. All ID-based endpoints are admin-only. |
| **Auth bypass / privilege escalation** | Server-side session check on every `/api/admin/*` request. Role checks (`owner` vs `staff`) are enforced server-side. There is no client-side auth logic and there are no credentials in the frontend. |
| **Brute force** | Per-IP login limit (10 per 15 min) plus a 15-minute account lock after 5 failures. PBKDF2-SHA256 with 100k iterations and a random salt. Similar timing for unknown emails. |
| **Session abuse** | 32-byte random token; only its SHA-256 is stored; 8-hour expiry; `__Host-` HttpOnly Secure cookie; logout deletes the session server-side. |
| **Rate limiting / spam bookings** | Per-IP limits for availability (120/min), booking (8/10 min), lookup and admin. Honeypot field. At most 3 active future bookings per phone. Turnstile can be added if spam shows up. |
| **Replay / duplicate requests** | Mandatory Idempotency-Key with a request hash; a replay returns the original result; a tampered replay is rejected. |
| **Double booking** | `slot_locks` primary key plus a single-transaction batch (see README §6). |
| **Insecure webhooks** | `X-Hub-Signature-256` HMAC checked against `WHATSAPP_APP_SECRET` with a timing-safe compare; 256 KB body cap; status can only move forward. The browser can never set notification status. |
| **Exposed secrets** | All tokens and recipients are Worker secrets. `.dev.vars` is git-ignored. `js/config.js` holds only public clinic facts. The admin panel shows only masked recipients and whether each setting is present. |
| **Exposed DB credentials** | D1 is reached through a Worker binding; there is no connection string. |
| **File uploads** | None accepted. |
| **Malicious input** | Server-side validation of every field (length, format, strict date/time, Iraqi phone). Control and bidi-override characters are stripped. 8 KB body cap. |
| **Privacy** | No patient data in URLs, analytics (the hook whitelists `service`, `step`, `lang`, `source` only) or logs (structured logs exclude names, phones and notes). The notes field warns patients not to include sensitive medical details. |
| **Clickjacking / transport** | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, HSTS, nosniff, Referrer-Policy and Permissions-Policy. |

**Residual items for the clinic:** enable Cloudflare WAF/Bot Fight Mode; rotate the WhatsApp token periodically; keep the number of admin accounts small; back up D1 (`wrangler d1 export`).
