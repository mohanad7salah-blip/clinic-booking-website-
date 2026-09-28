// Shared helpers — no PII is ever logged.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

export function apiError(code, status, extra = {}) {
  return json({ ok: false, error: code, ...extra }, status);
}

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function uuid() { return crypto.randomUUID(); }
export function nowIso() { return new Date().toISOString(); }
export function isoIn(seconds) { return new Date(Date.now() + seconds * 1000).toISOString(); }

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function randomBase32(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = "";
  for (let i = 0; i < n; i++) s += CROCKFORD[bytes[i] & 31];
  return s;
}

export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Timing-safe string comparison. */
export function safeEqual(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Normalise an Iraqi mobile number to E.164 (+9647XXXXXXXXX).
 * Accepts: 07701234567, 7701234567, +9647701234567, 009647701234567, 9647701234567,
 * with spaces/dashes/brackets and Arabic-Indic digits. Returns null if invalid.
 */
export function normalizeIraqiPhone(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let d = String(raw)
    .replace(/[\u0660-\u0669]/g, c => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, c => String(c.charCodeAt(0) - 0x06F0))
    .replace(/[\s\-().\u200e\u200f]/g, "");
  if (d.length > 20) return null;
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("964")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  if (!/^7\d{9}$/.test(d)) return null;
  return "+964" + d;
}

/** Mask a phone for logs/admin lists where full number isn't needed: +96477•••••704 */
export function maskPhone(p) {
  if (!p) return "";
  return p.length > 8 ? p.slice(0, 6) + "•••••" + p.slice(-3) : "•••";
}

/** Strip control characters and collapse whitespace. */
export function cleanText(s, max) {
  if (s == null) return null;
  const v = String(s).replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  if (!v) return null;
  return max ? v.slice(0, max) : v;
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || "0.0.0.0";
}

export function log(level, msg, meta = {}) {
  // Structured logs, visible via `wrangler tail`. Never pass names/phones/notes here.
  console[level === "error" ? "error" : "log"](JSON.stringify({ level, msg, ...meta, at: nowIso() }));
}

export async function readJson(request, maxBytes = 8192) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("PAYLOAD_TOO_LARGE");
  try { return JSON.parse(text || "{}"); } catch { throw new Error("BAD_JSON"); }
}
