// Cloudflare Worker entry — booking API + (optionally) serves the static site.
//
// Routes
//   GET  /api/health
//   GET  /api/public-config
//   GET  /api/availability?service=slug&date=YYYY-MM-DD
//   GET  /api/availability/calendar?service=slug
//   POST /api/bookings                     (Idempotency-Key header required)
//   GET  /api/bookings/:reference          (non-sensitive fields only)
//   GET  /api/webhooks/whatsapp            (Meta verification handshake)
//   POST /api/webhooks/whatsapp            (X-Hub-Signature-256 verified)
//   POST /api/admin/login | /api/admin/logout
//   *    /api/admin/*                      (session cookie + CSRF)
//   cron → processNotifications (retries with exponential backoff)
import { json, apiError, readJson, log } from "./util.js";
import { getDaySlots, getCalendar, loadSettings } from "./availability.js";
import { createBooking, getBookingByReference } from "./bookings.js";
import { processNotifications, verifyWebhookSignature, handleWebhookStatuses, environmentOf, whatsappConfigured } from "./whatsapp.js";
import { login, logout, requireAdmin } from "./auth.js";
import { adminRouter } from "./admin.js";
import { rateLimit, cleanupRateLimits } from "./ratelimit.js";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com https://cdn.jsdelivr.net 'unsafe-inline'",
  "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "frame-src https://maps.google.com https://www.google.com",
  "connect-src 'self'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"
].join("; ");

function allowedOrigin(env, request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function withHeaders(res, env, request, isApi) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  if (isApi) {
    const o = allowedOrigin(env, request);
    if (o && !new URL(request.url).pathname.startsWith("/api/admin")) { // admin API is same-origin only
      h.set("Access-Control-Allow-Origin", o);
      h.set("Vary", "Origin");
    }
  } else if ((h.get("content-type") || "").includes("text/html")) {
    h.set("Content-Security-Policy", CSP);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function limited(env, request, scope) {
  const r = await rateLimit(env, request, scope);
  return r.ok ? null : apiError("RATE_LIMITED", 429, { retry_after: r.retryAfter });
}

async function handleApi(request, env, ctx, url) {
  const p = url.pathname, m = request.method;

  if (m === "OPTIONS") {
    const o = allowedOrigin(env, request);
    return new Response(null, { status: 204, headers: o && !p.startsWith("/api/admin") ? {
      "Access-Control-Allow-Origin": o, "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key", "Access-Control-Max-Age": "86400", "Vary": "Origin"
    } : {} });
  }

  if (p === "/api/health") return json({ ok: true, environment: environmentOf(env) });

  if (p === "/api/public-config" && m === "GET") {
    const settings = await loadSettings(env.DB);
    const svc = await env.DB.prepare("SELECT slug, name_ar, name_en, duration_minutes, active FROM services ORDER BY sort_order, id").all();
    const hours = {};
    for (const [k, v] of Object.entries(settings.working_hours)) hours[k] = v && v.length ? v : null;
    return json({
      ok: true, environment: environmentOf(env), timezone: settings.timezone,
      hours, booking_window_days: settings.booking.booking_window_days,
      services: svc.results.map(s => ({ ...s, active: !!s.active })),
      whatsapp_configured: whatsappConfigured(env)
    }, 200, { "cache-control": "public, max-age=60" });
  }

  if (p === "/api/availability" && m === "GET") {
    const rl = await limited(env, request, "availability"); if (rl) return rl;
    const r = await getDaySlots(env.DB, environmentOf(env), url.searchParams.get("service"), url.searchParams.get("date"));
    if (r.error) return apiError(r.error, 400);
    return json({ ok: true, date: url.searchParams.get("date"), timezone: r.settings.timezone, open: r.open, reason: r.reason || null, slots: r.slots });
  }

  if (p === "/api/availability/calendar" && m === "GET") {
    const rl = await limited(env, request, "availability"); if (rl) return rl;
    const r = await getCalendar(env.DB, environmentOf(env), url.searchParams.get("service"));
    if (r.error) return apiError(r.error, 400);
    return json({ ok: true, ...r });
  }

  if (p === "/api/bookings" && m === "POST") {
    if (!(request.headers.get("content-type") || "").includes("application/json")) return apiError("UNSUPPORTED_MEDIA_TYPE", 415);
    const rl = await limited(env, request, "booking"); if (rl) return rl;
    let body; try { body = await readJson(request); } catch (e) { return apiError("BAD_REQUEST", 400); }
    return createBooking(request, env, ctx, body);
  }

  const ref = p.match(/^\/api\/bookings\/([A-Z0-9-]{8,20})$/);
  if (ref && m === "GET") {
    const rl = await limited(env, request, "lookup"); if (rl) return rl;
    return getBookingByReference(env, ref[1]);
  }

  if (p === "/api/webhooks/whatsapp") {
    if (m === "GET") {
      const mode = url.searchParams.get("hub.mode"), token = url.searchParams.get("hub.verify_token"), challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) return new Response(challenge || "", { status: 200 });
      return new Response("Forbidden", { status: 403 });
    }
    if (m === "POST") {
      const raw = await request.text();
      if (raw.length > 256 * 1024 || !(await verifyWebhookSignature(env, request, raw))) { log("warn", "webhook_signature_invalid"); return new Response("Unauthorized", { status: 401 }); }
      let payload; try { payload = JSON.parse(raw); } catch { return new Response("Bad Request", { status: 400 }); }
      const updated = await handleWebhookStatuses(env, payload);
      return json({ ok: true, updated });
    }
  }

  // ---------- Admin ----------
  if (p === "/api/admin/login" && m === "POST") {
    const rl = await limited(env, request, "login"); if (rl) return rl;
    let body; try { body = await readJson(request, 2048); } catch { return apiError("BAD_REQUEST", 400); }
    return login(env, body);
  }
  if (p === "/api/admin/logout" && m === "POST") return logout(env, request);
  if (p.startsWith("/api/admin/")) {
    const rl = await limited(env, request, "admin"); if (rl) return rl;
    const session = await requireAdmin(env, request);
    if (!session) return apiError("UNAUTHORIZED", 401);
    if (session.csrfFailed) return apiError("CSRF", 403);
    let body = {};
    if (!["GET", "HEAD", "DELETE"].includes(m)) { try { body = await readJson(request, 16384); } catch { return apiError("BAD_REQUEST", 400); } }
    return adminRouter(env, request, url, session, body);
  }

  return apiError("NOT_FOUND", 404);
}

export default {
  async fetch(request, env, ctx) {
    env.__processNotifications = processNotifications;
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    let res;
    try {
      if (isApi) res = await handleApi(request, env, ctx, url);
      else if (env.ASSETS) res = await env.ASSETS.fetch(request);
      else res = new Response("Not found", { status: 404 });
    } catch (e) {
      // Never leak internals to users; details go to server logs only.
      log("error", "unhandled", { path: url.pathname, err: String(e && e.message || e).slice(0, 300) });
      res = apiError("SERVER", 500);
    }
    return withHeaders(res, env, request, isApi);
  },

  // Cron trigger (wrangler.toml [triggers]) — retries due notifications & housekeeping
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await processNotifications(env, { limit: 50 }); } catch (e) { log("error", "cron_notifications", { err: String(e.message || e) }); }
      try { await cleanupRateLimits(env); } catch (e) { /* ignore */ }
      try { await env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')").run(); } catch (e) { /* ignore */ }
    })());
  }
};
