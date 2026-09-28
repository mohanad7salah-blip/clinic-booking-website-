// Atomic, idempotent booking creation.
//
// Correctness does NOT depend on "SELECT availability → INSERT". The authoritative
// guard is the slot_locks PRIMARY KEY (environment, slot_date, slot_minute):
// the appointment row, its slot locks, the idempotency record and the
// notification outbox rows are written in ONE D1 batch, which D1 executes as a
// single SQL transaction. If any lock row already exists the whole batch rolls
// back, so two concurrent requests can never both commit the same slot.
import { getDaySlots, granules, serviceDuration } from "./availability.js";
import { isValidYmd, isValidHm, toMin, fromMin } from "./time.js";
import { json, apiError, sha256Hex, uuid, randomBase32, normalizeIraqiPhone, cleanText, log } from "./util.js";
import { environmentOf, whatsappConfigured } from "./whatsapp.js";

const IDEM_RE = /^[A-Za-z0-9_-]{16,80}$/;
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function validate(body) {
  const fields = {};
  const service = typeof body.service === "string" ? body.service : "";
  if (!/^[a-z0-9-]{2,60}$/.test(service)) fields.service = "service";
  if (!isValidYmd(body.date)) fields.date = "date";
  if (!isValidHm(body.time) || toMin(body.time) % 5 !== 0) fields.time = "time";
  const name = cleanText(body.name, 80);
  if (!name || name.length < 2) fields.name = "name";
  const phone = normalizeIraqiPhone(body.phone);
  if (!phone) fields.phone = "phone";
  let email = cleanText(body.email, 120);
  if (email && !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(email)) fields.email = "email";
  const notes = cleanText(body.notes, 500);
  const lang = body.lang === "en" ? "en" : "ar";
  return { fields, clean: { service, date: body.date, time: body.time, name, phone, email: email || null, notes, lang } };
}

async function findByIdempotency(db, environment, key) {
  return db.prepare(
    `SELECT a.*, s.slug AS service_slug, i.request_hash
       FROM idempotency_keys i JOIN appointments a ON a.id = i.appointment_id
       JOIN services s ON s.id = a.service_id
      WHERE i.environment = ? AND i.idem_key = ?`
  ).bind(environment, key).first();
}

function publicBooking(a, env) {
  return {
    reference: a.booking_reference,
    service: a.service_slug,
    date: a.appointment_date,
    start_time: a.start_time,
    end_time: a.end_time,
    timezone: a.timezone,
    status: a.status,
    environment: a.environment,
    notification: { whatsapp_configured: whatsappConfigured(env), state: "queued" }
  };
}

export async function createBooking(request, env, ctx, body) {
  const db = env.DB;
  const environment = environmentOf(env);

  // 1) Honeypot — bots fill hidden fields. Respond generically, store nothing.
  if (body.company) { log("warn", "honeypot_triggered"); return apiError("VALIDATION", 400, { fields: {} }); }

  // 2) Idempotency key (mandatory)
  const key = request.headers.get("Idempotency-Key") || "";
  if (!IDEM_RE.test(key)) return apiError("IDEMPOTENCY_KEY_REQUIRED", 400);

  // 3) Server-side validation (never trust the browser)
  const { fields, clean } = validate(body);
  if (Object.keys(fields).length) return apiError("VALIDATION", 422, { fields });

  const requestHash = await sha256Hex([clean.service, clean.date, clean.time, clean.phone, clean.name].join("|"));

  // 4) Replay? Return the ORIGINAL result, create nothing.
  const prior = await findByIdempotency(db, environment, key);
  if (prior) {
    if (prior.request_hash !== requestHash) return apiError("IDEMPOTENCY_KEY_REUSED", 422);
    return json({ ok: true, replayed: true, booking: publicBooking(prior, env) }, 200);
  }

  // 5) Validate service, clinic hours, date/time, blocked periods, lead time
  const day = await getDaySlots(db, environment, clean.service, clean.date);
  if (day.error === "UNKNOWN_SERVICE") return apiError("VALIDATION", 422, { fields: { service: "service" } });
  if (day.error) return apiError("VALIDATION", 422, { fields: { date: "date" } });
  if (!day.open || !day.slots.includes(clean.time)) {
    // Distinguish "someone just took it" from "never valid" for a friendlier message
    return apiError(day.open ? "SLOT_UNAVAILABLE" : "INVALID_SLOT", 409);
  }

  // 6) Anti-abuse: cap active future bookings per phone
  const maxActive = Number(day.settings.booking.max_active_per_phone) || 3;
  const active = await db.prepare(
    "SELECT COUNT(*) AS n FROM appointments WHERE environment = ? AND phone = ? AND status IN ('pending','confirmed') AND appointment_date >= ?"
  ).bind(environment, clean.phone, day.now.ymd).first();
  if (active && active.n >= maxActive) return apiError("TOO_MANY_ACTIVE_BOOKINGS", 429);

  // 7) Atomic reservation
  const duration = serviceDuration(day.service, day.settings);
  const buffer = Number(day.settings.booking.buffer_minutes) || 0;
  const startMin = toMin(clean.time);
  const endTime = fromMin(startMin + duration);
  const lockMinutes = granules(startMin, duration, buffer);
  const year = clean.date.slice(0, 4);

  for (let attempt = 0; attempt < 3; attempt++) {
    const id = uuid();
    const reference = `ALZ-${year}-${randomBase32(5)}`;
    const stmts = [
      db.prepare(
        `INSERT INTO appointments (id, booking_reference, environment, patient_name, phone, email, notes, service_id,
                                   appointment_date, start_time, end_time, timezone, status, lang, idempotency_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`
      ).bind(id, reference, environment, clean.name, clean.phone, clean.email, clean.notes, day.service.id,
             clean.date, clean.time, endTime, day.settings.timezone, clean.lang, key),
      // Multi-row INSERTs (chunked: D1 allows max 100 bound params per statement).
      // Any existing (environment, date, minute) → constraint error → full batch rollback.
      ...chunk(lockMinutes, 20).map(part => db.prepare(
        `INSERT INTO slot_locks (environment, slot_date, slot_minute, appointment_id) VALUES ` +
        part.map(() => "(?,?,?,?)").join(",")
      ).bind(...part.flatMap(m => [environment, clean.date, m, id]))),
      db.prepare("INSERT INTO idempotency_keys (environment, idem_key, request_hash, appointment_id) VALUES (?,?,?,?)")
        .bind(environment, key, requestHash, id),
      // Transactional outbox: jobs exist iff the booking committed
      db.prepare("INSERT INTO notifications (id, appointment_id, environment, type, lang) VALUES (?,?,?,?,?)")
        .bind(uuid(), id, environment, "clinic_new_booking", "ar"),
      db.prepare("INSERT INTO notifications (id, appointment_id, environment, type, lang) VALUES (?,?,?,?,?)")
        .bind(uuid(), id, environment, "patient_confirmation", clean.lang)
    ];

    try {
      await db.batch(stmts); // single transaction
      log("info", "booking_created", { environment, service: clean.service, date: clean.date, time: clean.time });
      // 8) Notifications are processed only AFTER commit, asynchronously
      if (ctx && env.__processNotifications) ctx.waitUntil(env.__processNotifications(env, { appointmentId: id }));
      return json({
        ok: true, replayed: false,
        booking: publicBooking({ booking_reference: reference, service_slug: clean.service, appointment_date: clean.date,
          start_time: clean.time, end_time: endTime, timezone: day.settings.timezone, status: "pending", environment }, env)
      }, 201);
    } catch (e) {
      const msg = String(e && e.message || e);
      if (!/constraint/i.test(msg)) { log("error", "booking_insert_failed", { err: msg.slice(0, 200) }); throw e; }
      // Same key raced us → return the winner's result (idempotent)
      const winner = await findByIdempotency(db, environment, key);
      if (winner) {
        if (winner.request_hash !== requestHash) return apiError("IDEMPOTENCY_KEY_REUSED", 422);
        return json({ ok: true, replayed: true, booking: publicBooking(winner, env) }, 200);
      }
      if (/slot_locks/i.test(msg)) {
        log("info", "slot_conflict", { environment, date: clean.date, time: clean.time });
        return apiError("SLOT_UNAVAILABLE", 409);
      }
      if (/booking_reference/i.test(msg)) continue; // astronomically rare reference collision → new reference
      log("error", "booking_constraint_unexpected", { err: msg.slice(0, 200) });
      return apiError("SLOT_UNAVAILABLE", 409);
    }
  }
  return apiError("SERVER", 500);
}

export async function getBookingByReference(env, reference) {
  if (!/^ALZ-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/.test(reference || "")) return apiError("NOT_FOUND", 404);
  const a = await env.DB.prepare(
    `SELECT a.booking_reference, a.appointment_date, a.start_time, a.end_time, a.timezone, a.status, a.environment, s.slug AS service_slug
       FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.booking_reference = ?`
  ).bind(reference).first();
  if (!a) return apiError("NOT_FOUND", 404);
  // Non-sensitive fields only — no name, phone, email or notes.
  return json({ ok: true, booking: {
    reference: a.booking_reference, service: a.service_slug, date: a.appointment_date,
    start_time: a.start_time, end_time: a.end_time, timezone: a.timezone, status: a.status, environment: a.environment
  } });
}
