// Fixed-window rate limiter backed by D1 (atomic UPSERT). IPs are stored hashed.
// For very high traffic, swap for Cloudflare's Rate Limiting binding — same call site.
import { sha256Hex, clientIp } from "./util.js";

export const LIMITS = {
  availability: { max: 120, window: 60 },    // generous: browsing dates
  booking:      { max: 8,   window: 600 },   // 8 booking attempts / 10 min / IP
  lookup:       { max: 30,  window: 600 },
  login:        { max: 10,  window: 900 },   // plus per-account lockout in auth.js
  admin:        { max: 600, window: 60 }
};

export async function rateLimit(env, request, scope) {
  const cfg = LIMITS[scope];
  if (!cfg || env.RATE_LIMIT_DISABLED === "true") return { ok: true };
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % cfg.window);
  const bucket = `${scope}:${(await sha256Hex((env.IP_HASH_SALT || "alz") + clientIp(request))).slice(0, 32)}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
     RETURNING count`
  ).bind(bucket, windowStart).first();
  const count = row ? row.count : 1;
  if (count > cfg.max) return { ok: false, retryAfter: windowStart + cfg.window - now };
  return { ok: true };
}

export async function cleanupRateLimits(env) {
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(cutoff).run();
}
