# QA & Test-Mode Checklist

Run against a **TEST-mode** deployment (`WHATSAPP_MODE=test`). Tick each item.

## Automated
| Command (in `backend/`) | Covers | Expected |
|---|---|---|
| `npm test` | phone normalisation, slot engine (hours, Friday closed, window, notice, buffer, blocks, holidays, inactive services), Baghdad timezone, test/prod recipient routing, TEST message marking, backoff | all pass |
| `API=… npm run test:idempotency` | 10 parallel + 1 sequential replay with the same key; tampered payload | 1× `201`, others `200 replayed`, one reference, `IDEMPOTENCY_KEY_REUSED` |
| `API=… N=25 npm run test:concurrency` | 25 different users, same slot, same moment | exactly 1× `201`, the rest `409 SLOT_UNAVAILABLE`, slot no longer offered |

## Test-mode checklist (spec §35)
- [ ] **Test 1 – normal booking:** booking is created, reference shown with TEST badge, the slot disappears from availability, a 🧪 message arrives on **+9647755473704**, Admin → Notifications shows `sent`, then `delivered`.
- [ ] **Test 2 – same booking twice:** double-click Confirm, or run the idempotency script. One booking, one clinic notification and one patient notification (the notifications table has a UNIQUE key per booking, type and environment).
- [ ] **Test 3 – simultaneous users:** two phones or tabs pick the same slot and confirm together (or run the concurrency script). One succeeds; the other sees *"عذراً، هذا الموعد تم حجزه للتو…"* and is taken back to time selection with the list refreshed.
- [ ] **Test 4 – refresh after Confirm:** click Confirm and refresh straight away. The page re-sends with the same key and shows the same reference. There is no second row in Admin.
- [ ] **Test 5 – WhatsApp failure:** set `WHATSAPP_SIMULATE_FAILURE=true` and deploy, then book. The booking stays `pending`, the notification goes `retrying` → (after 5 attempts) `failed` with the error text. Set it back to `false`, press Retry, and it becomes `sent`.
- [ ] **Test 6 – production switch:** set `WHATSAPP_CLINIC_RECIPIENT` and `APP_ENV`/`WHATSAPP_MODE=production`, then deploy. The banner shows PRODUCTION MODE, the active recipient is the clinic number, a booking reaches the clinic and the patient, and nothing goes to +9647755473704. Old `pending` test notifications stay unsent (environment mismatch guard).

## Booking edge cases
- [ ] Past date or `2026-02-30` via API → `422 VALIDATION`
- [ ] Friday → calendar shows it closed; API → `409 INVALID_SLOT`
- [ ] Time not on the grid (`15:07`) or outside hours → `INVALID_SLOT`
- [ ] Blocked time or holiday (Admin → Settings) → slots disappear right away
- [ ] Cancel from Admin → slot becomes free again
- [ ] Invalid phone (`0123`) → inline AR/EN error on the page and `422` from the server
- [ ] Honeypot filled → rejected, nothing stored
- [ ] More than 8 booking POSTs in 10 min from one IP → `429` with a friendly message

## Frontend
- [ ] AR ↔ EN switch changes every string, `dir`, fonts, date and time formats, and meta title; the choice survives a reload
- [ ] Mobile 360–430px: no horizontal scroll; sticky bar doesn't cover the booking buttons; hamburger opens and closes (Esc works)
- [ ] Keyboard only: skip link, menu, service/date/time radios, form, Confirm
- [ ] `prefers-reduced-motion` → no animations
- [ ] Browsers: Chrome, Safari iOS, Firefox, Edge, Samsung Internet
- [ ] No console errors; all links work; no fake reviews, prices or staff anywhere

## Security spot checks
- [ ] `/api/admin/appointments` without a cookie → 401; POST without `X-CSRF-Token` → 403
- [ ] Staff role → PUT settings → 403
- [ ] `GET /api/bookings/ALZ-…` returns no name, phone or notes
- [ ] Webhook POST with a wrong signature → 401
- [ ] View source / DevTools: no tokens and no test number anywhere
