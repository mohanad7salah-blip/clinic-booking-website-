#!/usr/bin/env node
// Idempotency test: the SAME request (same Idempotency-Key) sent 10× in parallel and then again
// sequentially must produce ONE booking and ONE reference. Reusing the key with a different
// payload must be rejected. Only runs against TEST mode.
//   API=http://127.0.0.1:8787 node scripts/idempotency-test.mjs
const API = process.env.API || "http://127.0.0.1:8787";
const SERVICE = process.env.SERVICE || "teeth-whitening";

const health = await (await fetch(`${API}/api/health`)).json();
if (health.environment !== "test") { console.error("Refusing to run: server is not in TEST mode."); process.exit(2); }

const cal = await (await fetch(`${API}/api/availability/calendar?service=${SERVICE}`)).json();
const day = cal.days.find(d => d.open && d.available > 0);
const { slots } = await (await fetch(`${API}/api/availability?service=${SERVICE}&date=${day.date}`)).json();
const key = crypto.randomUUID();
const payload = { service: SERVICE, date: day.date, time: slots[0], name: "Idempotency Test", phone: "07709998877", lang: "ar" };
const send = (body = payload) => fetch(`${API}/api/bookings`, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body)
}).then(async r => ({ status: r.status, body: await r.json() }));

const burst = await Promise.all(Array.from({ length: 10 }, () => send()));
const again = await send();
const refs = new Set([...burst, again].filter(r => r.body.booking).map(r => r.body.booking.reference));
const created = [...burst, again].filter(r => r.status === 201).length;
const tampered = await send({ ...payload, name: "Someone Else" });

console.log({ statuses: [...burst, again].map(r => r.status), uniqueReferences: [...refs], created, tampered: tampered.body.error });
const pass = refs.size === 1 && created === 1 && tampered.body.error === "IDEMPOTENCY_KEY_REUSED";
console.log(pass ? "✅ PASS — one booking, same reference returned for every replay." : "❌ FAIL");
process.exit(pass ? 0 : 1);
