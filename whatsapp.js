// WhatsApp Business Platform (Meta Cloud API) notification worker.
//
// • Server-side only. Tokens, recipients and the test number never reach the browser.
// • Transactional outbox: rows are created in the same DB transaction as the booking.
// • Idempotent: UNIQUE(appointment_id, type, environment) + atomic claim + "never
//   auto-resend when the outcome is unknown" ⇒ the same message is never sent twice.
// • Test/production separation is enforced here, at send time, for every message.
import { nowIso, isoIn, log, safeEqual, maskPhone } from "./util.js";

const GRAPH = "https://graph.facebook.com";
const CLAIM_SECONDS = 60;

/** Booking environment. Derived from WHATSAPP_MODE (single switch), APP_ENV must agree. */
export function environmentOf(env) {
  const m = String(env.WHATSAPP_MODE || env.APP_ENV || "test").toLowerCase();
  return (m === "prod" || m === "production") ? "production" : "test";
}

export function whatsappConfigured(env) {
  return !!(env.WHATSAPP_API_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

/** Admin-facing configuration status (no secret values, only presence + masked recipients). */
export function whatsappStatus(env) {
  const environment = environmentOf(env);
  const issues = [];
  if (!env.WHATSAPP_API_TOKEN) issues.push("WHATSAPP_API_TOKEN not set");
  if (!env.WHATSAPP_PHONE_NUMBER_ID) issues.push("WHATSAPP_PHONE_NUMBER_ID not set");
  if (environment === "test" && !env.WHATSAPP_TEST_RECIPIENT) issues.push("WHATSAPP_TEST_RECIPIENT not set");
  if (environment === "production" && !env.WHATSAPP_CLINIC_RECIPIENT) issues.push("WHATSAPP_CLINIC_RECIPIENT not set");
  if (environment === "production" && env.WHATSAPP_CLINIC_RECIPIENT && env.WHATSAPP_CLINIC_RECIPIENT === env.WHATSAPP_TEST_RECIPIENT) issues.push("Production clinic recipient equals the test recipient");
  const appEnv = String(env.APP_ENV || "").toLowerCase();
  if (appEnv && ((appEnv === "production") !== (environment === "production"))) issues.push(`APP_ENV (${appEnv}) and WHATSAPP_MODE disagree`);
  if (!env.WHATSAPP_APP_SECRET) issues.push("WHATSAPP_APP_SECRET not set (delivery webhooks cannot be verified)");
  return {
    environment,
    configured: whatsappConfigured(env),
    issues,
    active_clinic_recipient: maskPhone(environment === "test" ? env.WHATSAPP_TEST_RECIPIENT : env.WHATSAPP_CLINIC_RECIPIENT),
    templates: {
      clinic: env.WHATSAPP_TEMPLATE_CLINIC || null,
      patient: env.WHATSAPP_TEMPLATE_PATIENT || null
    },
    simulate_failure: environment === "test" && env.WHATSAPP_SIMULATE_FAILURE === "true"
  };
}

/**
 * Recipient routing — the ONLY place recipients are decided.
 * test:        every message → WHATSAPP_TEST_RECIPIENT (never the clinic, never real patients)
 * production:  clinic → WHATSAPP_CLINIC_RECIPIENT, patient → appointment phone;
 *              refuses to send to the test recipient.
 */
export function resolveRecipient(env, notif, appt) {
  const mode = environmentOf(env);
  if (notif.environment !== mode) return { error: `ENV_MISMATCH: notification is '${notif.environment}' but server mode is '${mode}'` };
  const test = (env.WHATSAPP_TEST_RECIPIENT || "").trim();
  if (mode === "test") {
    if (!test) return { error: "WHATSAPP_TEST_RECIPIENT not configured" };
    return { to: test };
  }
  const to = notif.type === "clinic_new_booking" ? (env.WHATSAPP_CLINIC_RECIPIENT || "").trim() : appt?.phone;
  if (!to) return { error: "Production recipient not configured" };
  if (test && digits(to) === digits(test)) return { error: "Refusing to send a production message to the test recipient" };
  return { to };
}
const digits = s => String(s || "").replace(/\D/g, "");

/* ---------------- Message content ---------------- */
function fmt12(hm, lang) {
  const [h, m] = hm.split(":").map(Number);
  const suffix = lang === "ar" ? (h < 12 ? "ص" : "م") : (h < 12 ? "AM" : "PM");
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}
const STATUS_AR = { pending: "قيد التأكيد", confirmed: "مؤكد", cancelled: "ملغى", completed: "مكتمل", no_show: "لم يحضر" };

export function buildMessage(notif, appt) {
  const test = notif.environment === "test";
  const svcAr = appt.service_name_ar, svcEn = appt.service_name_en;
  const time = fmt12(appt.start_time, "ar");
  if (notif.type === "clinic_new_booking") {
    const head = test
      ? "🧪 TEST BOOKING — عيادة الدكتور علي الزبيدي\n\nهذه رسالة اختبار للنظام وليست حجزاً إنتاجياً.\n"
      : "📅 حجز جديد — عيادة الدكتور علي الزبيدي\n";
    return `${head}
اسم المراجع: ${appt.patient_name}
رقم الهاتف: ${appt.phone}
الخدمة: ${svcAr}
التاريخ: ${appt.appointment_date}
الوقت: ${time}
${test ? "رقم الاختبار" : "رقم الحجز"}: ${appt.booking_reference}
الحالة: ${STATUS_AR[appt.status] || appt.status}`;
  }
  if (notif.type === "patient_confirmation") {
    const prefix = test ? "🧪 TEST — رسالة اختبار / Test message\n\n" : "";
    if (notif.lang === "en") {
      return `${prefix}✅ Your booking at Dr. Ali Al-Zubaidi Dental Clinic has been registered

Service: ${svcEn}
Date: ${appt.appointment_date}
Time: ${fmt12(appt.start_time, "en")} (Baghdad time)
Booking reference: ${appt.booking_reference}

Address:
Al-Rubaie Street, Zayouna, Baghdad

Thank you for contacting us.`;
    }
    return `${prefix}✅ تم تسجيل حجزك في عيادة الدكتور علي الزبيدي

الخدمة: ${svcAr}
التاريخ: ${appt.appointment_date}
الوقت: ${time}
رقم الحجز: ${appt.booking_reference}

العنوان:
شارع الربيعي، بغداد

شكراً لتواصلك معنا.`;
  }
  return "🧪 TEST — WhatsApp integration check from Dr. Ali Al-Zubaidi Dental Clinic booking system.";
}

/** Template payload (required by WhatsApp for business-initiated messages outside the 24h window). */
function templatePayload(env, notif, appt) {
  const name = notif.type === "clinic_new_booking" ? env.WHATSAPP_TEMPLATE_CLINIC : notif.type === "patient_confirmation" ? env.WHATSAPP_TEMPLATE_PATIENT : null;
  if (!name) return null;
  const lang = notif.type === "patient_confirmation" && notif.lang === "en" ? (env.WHATSAPP_TEMPLATE_LANG_EN || "en") : (env.WHATSAPP_TEMPLATE_LANG_AR || "ar");
  const svc = notif.lang === "en" && notif.type === "patient_confirmation" ? appt.service_name_en : appt.service_name_ar;
  // Body parameter order must match the approved template — documented in README.
  const params = notif.type === "clinic_new_booking"
    ? [notif.environment === "test" ? "TEST" : "NEW", appt.patient_name, appt.phone, svc, appt.appointment_date, fmt12(appt.start_time, "ar"), appt.booking_reference]
    : [svc, appt.appointment_date, fmt12(appt.start_time, notif.lang), appt.booking_reference];
  return { name, language: { code: lang }, components: [{ type: "body", parameters: params.map(t => ({ type: "text", text: String(t).slice(0, 1000) })) }] };
}

class SendError extends Error { constructor(msg, retryable) { super(msg); this.retryable = retryable; } }

async function sendViaCloudApi(env, to, notif, appt) {
  if (environmentOf(env) === "test" && env.WHATSAPP_SIMULATE_FAILURE === "true") throw new SendError("SIMULATED_FAILURE (WHATSAPP_SIMULATE_FAILURE=true)", true);
  const version = env.WHATSAPP_API_VERSION || "v21.0";
  const tpl = templatePayload(env, notif, appt);
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: digits(to),
    ...(tpl ? { type: "template", template: tpl } : { type: "text", text: { preview_url: false, body: buildMessage(notif, appt) } })
  };
  let res;
  try {
    res = await fetch(`${GRAPH}/${version}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.WHATSAPP_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new SendError("NETWORK: " + String(e.message || e).slice(0, 150), true);
  }
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (res.ok && data.messages && data.messages[0]?.id) return data.messages[0].id;
  const code = data?.error?.code;
  const msg = `HTTP ${res.status}${code ? " code " + code : ""}: ${String(data?.error?.message || "unknown").slice(0, 200)}`;
  // Retry on throttling / transient platform errors; 4xx auth/param errors are permanent
  const retryable = res.status >= 500 || res.status === 429 || [1, 2, 4, 80007, 130429, 131000, 131016, 133004].includes(code);
  throw new SendError(msg, retryable);
}

/** Exponential backoff with jitter: 1m, 2m, 4m, 8m … capped at 6h. */
export function backoffSeconds(attempt) {
  const base = Math.min(60 * 2 ** Math.max(0, attempt - 1), 6 * 3600);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Process due notification jobs. Safe to run concurrently (cron + waitUntil + admin retry):
 * each job is claimed with a conditional UPDATE; only the claimant sends.
 */
export async function processNotifications(env, { appointmentId, notificationId, limit = 20 } = {}) {
  const db = env.DB;
  const now = nowIso();

  // A job stuck in 'processing' past its lock means a worker died mid-send. The provider may or may
  // not have accepted the message, so we DO NOT resend automatically (that could duplicate it).
  await db.prepare(
    `UPDATE notifications SET status = 'failed', locked_until = NULL, updated_at = ?,
            last_error = 'OUTCOME_UNKNOWN: worker interrupted during send — not auto-retried to avoid a duplicate. Verify in WhatsApp Manager, then retry manually if needed.'
      WHERE status = 'processing' AND locked_until < ?`
  ).bind(now, now).run();

  let q = `SELECT id FROM notifications WHERE status IN ('pending','retrying') AND next_attempt_at <= ?`;
  const binds = [now];
  if (appointmentId) { q += " AND appointment_id = ?"; binds.push(appointmentId); }
  if (notificationId) { q += " AND id = ?"; binds.push(notificationId); }
  q += " ORDER BY next_attempt_at LIMIT ?"; binds.push(limit);
  const due = (await db.prepare(q).bind(...binds).all()).results;

  const results = [];
  for (const { id } of due) results.push(await processOne(env, id));
  return results;
}

async function processOne(env, id) {
  const db = env.DB;
  const now = nowIso();
  // Atomic claim
  const claim = await db.prepare(
    `UPDATE notifications SET status = 'processing', locked_until = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending','retrying') AND next_attempt_at <= ?`
  ).bind(isoIn(CLAIM_SECONDS), now, now, id, now).run();
  if (!claim.meta || claim.meta.changes !== 1) return { id, skipped: true };

  const notif = await db.prepare("SELECT * FROM notifications WHERE id = ?").bind(id).first();
  const appt = notif.appointment_id ? await db.prepare(
    `SELECT a.*, s.name_ar AS service_name_ar, s.name_en AS service_name_en
       FROM appointments a JOIN services s ON s.id = a.service_id WHERE a.id = ?`
  ).bind(notif.appointment_id).first() : null;

  const fail = async (err, retryable) => {
    const canRetry = retryable && notif.attempts < notif.max_attempts;
    await db.prepare(
      `UPDATE notifications SET status = ?, locked_until = NULL, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'`
    ).bind(canRetry ? "retrying" : "failed", String(err).slice(0, 500), canRetry ? isoIn(backoffSeconds(notif.attempts)) : nowIso(), nowIso(), id).run();
    log("warn", "notification_failed", { id, type: notif.type, environment: notif.environment, attempt: notif.attempts, retrying: canRetry, err: String(err).slice(0, 160) });
    return { id, status: canRetry ? "retrying" : "failed" };
  };

  if (!whatsappConfigured(env)) return fail("INTEGRATION_NOT_CONFIGURED: set WHATSAPP_API_TOKEN and WHATSAPP_PHONE_NUMBER_ID, then retry.", false);
  if (notif.appointment_id && !appt) return fail("Appointment not found", false);

  const r = resolveRecipient(env, notif, appt);
  if (r.error) return fail(r.error, false);
  await db.prepare("UPDATE notifications SET recipient = ? WHERE id = ?").bind(r.to, id).run();

  try {
    const messageId = await sendViaCloudApi(env, r.to, notif, appt || {});
    await db.prepare(
      `UPDATE notifications SET status = 'sent', provider_message_id = ?, sent_at = ?, locked_until = NULL, last_error = NULL, updated_at = ? WHERE id = ?`
    ).bind(messageId, nowIso(), nowIso(), id).run();
    log("info", "notification_sent", { id, type: notif.type, environment: notif.environment });
    return { id, status: "sent" };
  } catch (e) {
    return fail(e.message, e instanceof SendError ? e.retryable : true);
  }
}

/* ---------------- Webhooks ---------------- */
const RANK = { pending: 0, retrying: 0, processing: 1, sent: 2, delivered: 3, read: 4, failed: 5 };

export async function verifyWebhookSignature(env, request, rawBody) {
  const secret = env.WHATSAPP_APP_SECRET;
  if (!secret) return false;
  const header = request.headers.get("X-Hub-Signature-256") || "";
  if (!header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(header.slice(7), hex);
}

export async function handleWebhookStatuses(env, payload) {
  const db = env.DB;
  let updated = 0;
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      for (const st of change.value?.statuses || []) {
        const map = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };
        const status = map[st.status];
        if (!status || !st.id) continue;
        const n = await db.prepare("SELECT id, status FROM notifications WHERE provider_message_id = ?").bind(st.id).first();
        if (!n) continue;
        // Only move forward (webhooks can arrive out of order / be retried)
        if (status !== "failed" && RANK[status] <= RANK[n.status]) continue;
        if (status === "failed" && ["delivered", "read"].includes(n.status)) continue;
        const ts = st.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : nowIso();
        const err = status === "failed" ? (st.errors || []).map(e => `${e.code}: ${e.title || e.message || ""}`).join("; ").slice(0, 500) : null;
        await db.prepare(
          `UPDATE notifications SET status = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                  read_at = CASE WHEN ? = 'read' THEN ? ELSE read_at END,
                  last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ?`
        ).bind(status, status, ts, status, ts, err, nowIso(), n.id).run();
        updated++;
      }
    }
  }
  return updated;
}
