// Admin authentication: PBKDF2 password hashes, opaque session tokens stored hashed,
// HttpOnly+Secure+SameSite=Strict cookie, per-session CSRF token, account lockout.
import { sha256Hex, randomToken, safeEqual, isoIn, nowIso, json, apiError, log } from "./util.js";

const COOKIE = "__Host-alz_admin";
const SESSION_HOURS = 8;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
export const PBKDF2_ITERATIONS = 100000; // Workers Web Crypto maximum

function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

export async function hashPassword(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2-sha256" || !iter || !salt || !hash) return false;
  const again = await hashPassword(password, unb64(salt), Number(iter));
  return safeEqual(again.split("$")[3], hash);
}

function cookieValue(request) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + COOKIE.replace(/[-$]/g, "\\$&") + "=([^;]+)"));
  return m ? m[1] : null;
}

export async function login(env, body) {
  const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
  const password = String(body.password || "").slice(0, 200);
  const db = env.DB;
  const admin = email ? await db.prepare("SELECT * FROM admins WHERE email = ?").bind(email).first() : null;

  if (admin && admin.locked_until && admin.locked_until > nowIso()) return apiError("ACCOUNT_LOCKED", 423);
  // Always run a hash to keep timing similar for unknown emails
  const ok = admin ? await verifyPassword(password, admin.password_hash) : (await hashPassword(password), false);
  if (!ok) {
    if (admin) {
      const failed = admin.failed_attempts + 1;
      await db.prepare("UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = ?")
        .bind(failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED ? isoIn(LOCK_MINUTES * 60) : null, admin.id).run();
      await audit(env, admin.id, "login_failed", null, null);
    }
    log("warn", "admin_login_failed");
    return apiError("INVALID_CREDENTIALS", 401);
  }

  const token = randomToken(32);
  const csrf = randomToken(24);
  await db.batch([
    db.prepare("UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?").bind(admin.id),
    db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(nowIso()),
    db.prepare("INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, expires_at) VALUES (?,?,?,?)")
      .bind(await sha256Hex(token), admin.id, csrf, isoIn(SESSION_HOURS * 3600))
  ]);
  await audit(env, admin.id, "login", null, null);
  return json({ ok: true, csrf, admin: { email: admin.email, role: admin.role } }, 200, {
    "Set-Cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`
  });
}

export async function logout(env, request) {
  const token = cookieValue(request);
  if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
}

/** Returns {admin, csrf} or null. Mutating requests must also pass X-CSRF-Token. */
export async function requireAdmin(env, request) {
  const token = cookieValue(request);
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare(
    `SELECT s.csrf_token, s.expires_at, a.id, a.email, a.role FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!row || row.expires_at < nowIso()) return null;
  if (!["GET", "HEAD"].includes(request.method)) {
    if (!safeEqual(request.headers.get("X-CSRF-Token") || "", row.csrf_token)) return { csrfFailed: true };
  }
  return { admin: { id: row.id, email: row.email, role: row.role }, csrf: row.csrf_token };
}

export async function audit(env, adminId, action, target, details) {
  try {
    await env.DB.prepare("INSERT INTO audit_log (admin_id, action, target, details) VALUES (?,?,?,?)")
      .bind(adminId, action, target, details ? JSON.stringify(details).slice(0, 1000) : null).run();
  } catch (e) { log("error", "audit_failed"); }
}
