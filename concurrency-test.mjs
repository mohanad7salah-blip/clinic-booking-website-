#!/usr/bin/env node
// MANDATORY concurrency test: N clients try to book the SAME service/date/time at the same moment.
// Expected: exactly 1 × 201 Created, all others 409 SLOT_UNAVAILABLE, 0 duplicates.
//
// Usage (against a TEST-mode deployment or `wrangler dev`):
//   API=http://127.0.0.1:8787 SERVICE=dental-fillings N=25 node scripts/concurrency-test.mjs
// Run with RATE_LIMIT_DISABLED=true on the test Worker, otherwise the per-IP booking limit
// (8/10min) will turn most requests into 429 — which is also a "not booked" outcome.
const API = process.env.API || "http://127.0.0.1:8787";
const SERVICE = process.env.SERVICE || "dental-fillings";
const N = Number(process.env.N || 25);

const health = await (await fetch(`${API}/api/health`)).json();
if (health.environment !== "test") { console.error("Refusing to run: server is not in TEST mode."); process.exit(2); }

const cal = await (await fetch(`${API}/api/availability/calendar?service=${SERVICE}`)).json();
const day = cal.days.find(d => d.open && d.available > 0);
if (!day) { console.error("No available day found."); process.exit(1); }
const slots = await (await fetch(`${API}/api/availability?service=${SERVICE}&date=${day.date}`)).json();
const time = slots.slots[0];
console.log(`Target slot: ${SERVICE} ${day.date} ${time} — firing ${N} simultaneous requests…`);

const reqs = Array.from({ length: N }, (_, i) => fetch(`${API}/api/bookings`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({ service: SERVICE, date: day.date, time, name: `Concurrency Test ${i}`, phone: `0770${String(1000000 + i).slice(-7)}`, lang: "en" })
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) })));

const results = await Promise.all(reqs);
const tally = {};
for (const r of results) { const k = `${r.status} ${r.body.error || (r.body.booking && "CREATED") || ""}`; tally[k] = (tally[k] || 0) + 1; }
console.table(tally);

const created = results.filter(r => r.status === 201);
const after = await (await fetch(`${API}/api/availability?service=${SERVICE}&date=${day.date}`)).json();
const stillOffered = after.slots.includes(time);
const pass = created.length === 1 && !stillOffered && results.every(r => [201, 409, 429].includes(r.status));
console.log(pass ? "✅ PASS — exactly one booking succeeded; slot no longer offered." : "❌ FAIL");
if (created[0]) console.log("Winning reference:", created[0].body.booking.reference);
process.exit(pass ? 0 : 1);
