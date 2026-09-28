#!/usr/bin/env node
// Creates an admin account and prints the SQL to run against D1.
// Usage: node scripts/create-admin.mjs owner@clinic.example "a-long-strong-passphrase" owner
// Then:  npx wrangler d1 execute alz_booking --remote --command "<printed SQL>"
// The password is hashed locally (PBKDF2-SHA256, 100k iterations); it is never stored or sent in clear.
import { webcrypto as crypto } from "node:crypto";

const [email, password, role = "staff"] = process.argv.slice(2);
if (!email || !password) { console.error("Usage: node scripts/create-admin.mjs <email> <password> [owner|staff]"); process.exit(1); }
if (password.length < 12) { console.error("Password must be at least 12 characters."); process.exit(1); }
if (!["owner", "staff"].includes(role)) { console.error("Role must be owner or staff."); process.exit(1); }

const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
const b64 = b => Buffer.from(b).toString("base64");
const hash = `pbkdf2-sha256$100000$${b64(salt)}$${b64(bits)}`;
const esc = s => s.replace(/'/g, "''");
console.log(`INSERT INTO admins (email, password_hash, role) VALUES ('${esc(email.toLowerCase())}', '${hash}', '${role}');`);
