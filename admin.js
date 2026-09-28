// Admin API — every handler receives an authenticated session (see index.js).
import { json, apiError, nowIso, cleanText, uuid } from "./util.js";
import { isValidYmd, isValidHm, clinicNow, DOW_KEYS } from "./time.js";
import { loadSettings, DEFAULT_BOOKING_SETTINGS } from "./availability.js";
import { environmentOf, whatsappStatus, processNotifications } from "./whatsapp.js";
import { audit } from "./auth.js";

const STATUSES = ["pending", "confirmed", "cancelled", "completed", "no_show"];
// Allowed status transitions (prevents nonsensical edits)
const TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "no_show", "cancelled"],
  cancelled: [], completed: [], no_show: []
};

export async function adminRouter(env, request, url, session, body) {
  const db = env.DB;
  const p = url.pathname.replace(/^\/api\/admin/, "");
  const m = request.method;
  const environment = environmentOf(env);
  const viewEnv = url.searchParams.get("env") === "test" ? "test" : url.searchParams.get("env") === "production" ? "production" : environment;
  const owner = session.admin.role === "owner";

  if (p === "/me" && m === "GET") {
    return json({ ok: true, admin: { email: session.admin.email, role: session.admin.role }, csrf: session.csrf, environment, whatsapp: whatsappStatus(env) });
  }

  if (p === "/dashboard" && m === "GET") {
    const settings = await loadSettings(db);
    const today = clinicNow(settings.timezone).ymd;
    const [counts, todayList, notif] = await db.batch([
      db.prepare(`SELECT status, COUNT(*) AS n FROM appointments WHERE environment = ? AND appointment_date >= ? GROUP BY status`).bind(viewEnv, today),
      db.prepare(`SELECT a.booking_reference, a.patient_name, a.phone, a.start_time, a.status, s.name_en, s.name_ar FROM appointments a JOIN services s ON s.id = a.service_id
                  WHERE a.environment = ? AND a.appointment_date = ? ORDER BY a.start_time`).bind(viewEnv, today),
      db.prepare(`SELECT status, COUNT(*) AS n FROM notifications WHERE environment = ? GROUP BY status`).bind(viewEnv)
    ]);
    return json({ ok: true, today, environment: viewEnv,
      upcoming: Object.fromEntries(counts.results.map(r => [r.status, r.n])),
      today_appointments: todayList.results,
      notifications: Object.fromEntries(notif.results.map(r => [r.status, r.n])) });
  }

  if (p === "/appointments" && m === "GET") {
    const where = ["a.environment = ?"]; const binds = [viewEnv];
    const status = url.searchParams.get("status");
    if (status && STATUSES.includes(status)) { where.push("a.status = ?"); binds.push(status); }
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (from && isValidYmd(from)) { where.push("a.appointment_date >= ?"); binds.push(from); }
    if (to && isValidYmd(to)) { where.push("a.appointment_date <= ?"); binds.push(to); }
    const q = cleanText(url.searchParams.get("q"), 60);
    if (q) { where.push("(a.patient_name LIKE ? ESCAPE '\\' OR a.phone LIKE ? ESCAPE '\\' OR a.booking_reference LIKE ? ESCAPE '\\')"); const like = "%" + q.replace(/[\\%_]/g, "\\$&") + "%"; binds.push(like, like, like); }
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const rows = await db.prepare(
      `SELECT a.id, a.booking_reference, a.environment, a.patient_name, a.phone, a.email, a.notes, a.appointment_date, a.start_time, a.end_time,
              a.timezone, a.status, a.lang, a.created_at, a.updated_at, s.slug, s.name_en, s.name_ar,
              (SELECT group_concat(n.type || ':' || n.status, ',') FROM notifications n WHERE n.appointment_id = a.id) AS notif
         FROM appointments a JOIN services s ON s.id = a.service_id
        WHERE ${where.join(" AND ")} ORDER BY a.appointment_date DESC, a.start_time DESC LIMIT ?`
    ).bind(...binds, limit).all();
    return json({ ok: true, environment: viewEnv, appointments: rows.results });
  }

  const statusMatch = p.match(/^\/appointments\/([0-9a-f-]{36})\/status$/);
  if (statusMatch && m === "POST") {
    const next = body.status;
    if (!STATUSES.includes(next)) return apiError("VALIDATION", 422);
    const a = await db.prepare("SELECT id, status, environment FROM appointments WHERE id = ?").bind(statusMatch[1]).first();
    if (!a) return apiError("NOT_FOUND", 404);
    if (!TRANSITIONS[a.status].includes(next)) return apiError("INVALID_TRANSITION", 409, { from: a.status, to: next });
    const stmts = [db.prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ? AND status = ?").bind(next, nowIso(), a.id, a.status)];
    // Cancelled / no-show frees the slot for others
    if (next === "cancelled") stmts.push(db.prepare("DELETE FROM slot_locks WHERE appointment_id = ?").bind(a.id));
    const res = await db.batch(stmts);
    if (res[0].meta.changes !== 1) return apiError("CONFLICT", 409);
    await audit(env, session.admin.id, "appointment_status", a.id, { from: a.status, to: next });
    return json({ ok: true });
  }

  if (p === "/notifications" && m === "GET") {
    const status = url.searchParams.get("status");
    const where = ["n.environment = ?"]; const binds = [viewEnv];
    if (status) { where.push("n.status = ?"); binds.push(status); }
    const rows = await db.prepare(
      `SELECT n.id, n.type, n.environment, n.recipient, n.status, n.provider_message_id, n.attempts, n.max_attempts, n.last_error,
              n.next_attempt_at, n.last_attempt_at, n.sent_at, n.delivered_at, n.read_at, n.created_at, a.booking_reference
         FROM notifications n LEFT JOIN appointments a ON a.id = n.appointment_id
        WHERE ${where.join(" AND ")} ORDER BY n.created_at DESC LIMIT 200`
    ).bind(...binds).all();
    return json({ ok: true, notifications: rows.results, whatsapp: whatsappStatus(env) });
  }

  const retryMatch = p.match(/^\/notifications\/([0-9a-f-]{36})\/retry$/);
  if (retryMatch && m === "POST") {
    // Manual retry only for failed jobs that were never accepted by the provider.
    const r = await db.prepare(
      `UPDATE notifications SET status = 'retrying', next_attempt_at = ?, max_attempts = attempts + 3, updated_at = ?
        WHERE id = ? AND status = 'failed' AND provider_message_id IS NULL`
    ).bind(nowIso(), nowIso(), retryMatch[1]).run();
    if (r.meta.changes !== 1) return apiError("NOT_RETRYABLE", 409);
    await audit(env, session.admin.id, "notification_retry", retryMatch[1], null);
    const result = await processNotifications(env, { notificationId: retryMatch[1] });
    return json({ ok: true, result });
  }

  if (p === "/notifications/test" && m === "POST") {
    // Sends a clearly-marked TEST message to the TEST recipient only (blocked in production mode).
    if (environment !== "test") return apiError("ONLY_IN_TEST_MODE", 409);
    const id = uuid();
    await db.prepare("INSERT INTO notifications (id, appointment_id, environment, type, lang) VALUES (?, NULL, 'test', 'system_test', 'ar')").bind(id).run();
    await audit(env, session.admin.id, "notification_test", id, null);
    const result = await processNotifications(env, { notificationId: id });
    return json({ ok: true, result });
  }

  if (p === "/services" && m === "GET") {
    const rows = await db.prepare("SELECT * FROM services ORDER BY sort_order, id").all();
    return json({ ok: true, services: rows.results.map(s => ({ ...s, available_days: s.available_days ? JSON.parse(s.available_days) : null })) });
  }
  if (p === "/services" && m === "POST") {
    if (!owner) return apiError("FORBIDDEN", 403);
    const v = validateService(body, true); if (v.error) return apiError("VALIDATION", 422, { field: v.error });
    try {
      await db.prepare(`INSERT INTO services (slug, name_ar, name_en, description_ar, description_en, duration_minutes, available_days, sort_order, active) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(v.slug, v.name_ar, v.name_en, v.description_ar, v.description_en, v.duration_minutes, v.available_days, v.sort_order, v.active).run();
    } catch (e) { return apiError("SLUG_EXISTS", 409); }
    await audit(env, session.admin.id, "service_create", v.slug, null);
    return json({ ok: true }, 201);
  }
  const svcMatch = p.match(/^\/services\/(\d+)$/);
  if (svcMatch && m === "PUT") {
    if (!owner) return apiError("FORBIDDEN", 403);
    const v = validateService(body, false); if (v.error) return apiError("VALIDATION", 422, { field: v.error });
    const r = await db.prepare(`UPDATE services SET name_ar=?, name_en=?, description_ar=?, description_en=?, duration_minutes=?, available_days=?, sort_order=?, active=?, updated_at=? WHERE id=?`)
      .bind(v.name_ar, v.name_en, v.description_ar, v.description_en, v.duration_minutes, v.available_days, v.sort_order, v.active, nowIso(), Number(svcMatch[1])).run();
    if (r.meta.changes !== 1) return apiError("NOT_FOUND", 404);
    await audit(env, session.admin.id, "service_update", svcMatch[1], { active: v.active, duration: v.duration_minutes });
    return json({ ok: true });
  }

  if (p === "/settings" && m === "GET") {
    const s = await loadSettings(db);
    const blocked = await db.prepare("SELECT * FROM blocked_times WHERE date >= ? ORDER BY date, start_time").bind(clinicNow(s.timezone).ymd).all();
    return json({ ok: true, settings: s, blocked: blocked.results, whatsapp: whatsappStatus(env) });
  }
  if (p === "/settings" && m === "PUT") {
    if (!owner) return apiError("FORBIDDEN", 403);
    const wh = validateHours(body.working_hours); if (!wh) return apiError("VALIDATION", 422, { field: "working_hours" });
    const bs = validateBooking(body.booking); if (!bs) return apiError("VALIDATION", 422, { field: "booking" });
    const phone = cleanText(body.phone, 20), address_ar = cleanText(body.address_ar, 200), address_en = cleanText(body.address_en, 200);
    if (!phone || !address_ar || !address_en) return apiError("VALIDATION", 422, { field: "contact" });
    await db.prepare(`UPDATE clinic_settings SET working_hours=?, booking_settings=?, phone=?, address_ar=?, address_en=?, updated_at=? WHERE id=1`)
      .bind(JSON.stringify(wh), JSON.stringify(bs), phone, address_ar, address_en, nowIso()).run();
    await audit(env, session.admin.id, "settings_update", null, { working_hours: wh, booking: bs });
    return json({ ok: true });
  }

  if (p === "/blocked" && m === "POST") {
    const date = body.date, st = body.start_time || null, et = body.end_time || null;
    if (!isValidYmd(date)) return apiError("VALIDATION", 422, { field: "date" });
    if ((st || et) && !(isValidHm(st) && isValidHm(et) && st < et)) return apiError("VALIDATION", 422, { field: "time" });
    await db.prepare("INSERT INTO blocked_times (date, start_time, end_time, reason) VALUES (?,?,?,?)").bind(date, st, et, cleanText(body.reason, 120)).run();
    await audit(env, session.admin.id, "blocked_create", date, { st, et });
    return json({ ok: true }, 201);
  }
  const blkMatch = p.match(/^\/blocked\/(\d+)$/);
  if (blkMatch && m === "DELETE") {
    await db.prepare("DELETE FROM blocked_times WHERE id = ?").bind(Number(blkMatch[1])).run();
    await audit(env, session.admin.id, "blocked_delete", blkMatch[1], null);
    return json({ ok: true });
  }

  return apiError("NOT_FOUND", 404);
}

function validateService(b, isNew) {
  const out = {};
  if (isNew) { if (!/^[a-z0-9-]{2,60}$/.test(b.slug || "")) return { error: "slug" }; out.slug = b.slug; }
  out.name_ar = cleanText(b.name_ar, 100); out.name_en = cleanText(b.name_en, 100);
  if (!out.name_ar || !out.name_en) return { error: "name" };
  out.description_ar = cleanText(b.description_ar, 1000); out.description_en = cleanText(b.description_en, 1000);
  if (b.duration_minutes === null || b.duration_minutes === "" || b.duration_minutes === undefined) out.duration_minutes = null;
  else { const d = Number(b.duration_minutes); if (!Number.isInteger(d) || d < 5 || d > 480) return { error: "duration_minutes" }; out.duration_minutes = d; }
  if (b.available_days == null || (Array.isArray(b.available_days) && !b.available_days.length)) out.available_days = null;
  else if (Array.isArray(b.available_days) && b.available_days.every(d => DOW_KEYS.includes(d))) out.available_days = JSON.stringify([...new Set(b.available_days)]);
  else return { error: "available_days" };
  out.sort_order = Number.isInteger(Number(b.sort_order)) ? Number(b.sort_order) : 0;
  out.active = b.active ? 1 : 0;
  return out;
}

function validateHours(h) {
  if (!h || typeof h !== "object") return null;
  const out = {};
  for (const d of DOW_KEYS) {
    const v = h[d];
    if (v == null || (Array.isArray(v) && !v.length)) { out[d] = null; continue; }
    if (!Array.isArray(v) || v.length > 4) return null;
    const ranges = [];
    for (const r of v) {
      if (!Array.isArray(r) || r.length !== 2 || !isValidHm(r[0]) || !isValidHm(r[1]) || r[0] >= r[1]) return null;
      ranges.push([r[0], r[1]]);
    }
    ranges.sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) return null;
    out[d] = ranges;
  }
  return out;
}

function validateBooking(b) {
  if (!b || typeof b !== "object") return null;
  const n = (k, min, max) => { const v = Number(b[k] ?? DEFAULT_BOOKING_SETTINGS[k]); return Number.isInteger(v) && v >= min && v <= max ? v : NaN; };
  const out = {
    default_duration: n("default_duration", 5, 480),
    buffer_minutes: n("buffer_minutes", 0, 120),
    slot_step_minutes: n("slot_step_minutes", 5, 240),
    booking_window_days: n("booking_window_days", 1, 180),
    min_notice_minutes: n("min_notice_minutes", 0, 10080),
    max_active_per_phone: n("max_active_per_phone", 1, 20)
  };
  if (Object.values(out).some(Number.isNaN)) return null;
  if (out.default_duration % 5 || out.buffer_minutes % 5 || out.slot_step_minutes % 5) return null;
  return out;
}
