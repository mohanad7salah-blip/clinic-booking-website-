// Pure-logic unit tests: `node --test tests/`
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIraqiPhone, maskPhone } from "../src/util.js";
import { computeDaySlots, granules, dayRanges } from "../src/availability.js";
import { clinicNow, isValidYmd, dowKey } from "../src/time.js";
import { resolveRecipient, environmentOf, buildMessage, backoffSeconds } from "../src/whatsapp.js";

test("Iraqi phone normalisation", () => {
  for (const v of ["07706266800", "0770 626 6800", "+9647706266800", "009647706266800", "9647706266800", "7706266800", "٠٧٧٠٦٢٦٦٨٠٠"]) {
    assert.equal(normalizeIraqiPhone(v), "+9647706266800", v);
  }
  for (const v of ["", "0123", "06706266800", "+9647706", "+96477062668001", "abc", null]) assert.equal(normalizeIraqiPhone(v), null, String(v));
  assert.equal(maskPhone("+9647755473704"), "+96477•••••704");
});

const settings = {
  timezone: "Asia/Baghdad",
  working_hours: { sat: [["15:00", "20:00"]], sun: [["15:00", "20:00"]], mon: [["15:00", "20:00"]], tue: [["15:00", "20:00"]], wed: [["15:00", "20:00"]], thu: [["15:00", "20:00"]], fri: null },
  booking: { default_duration: 30, buffer_minutes: 0, slot_step_minutes: 30, booking_window_days: 30, min_notice_minutes: 120 }
};
const service = { id: 1, active: 1, duration_minutes: null, available_days: null };
const base = { settings, service, lockedMinutes: new Set(), blocks: [] };
// 2026-09-26 is a Saturday
const now = { ymd: "2026-09-26", minutes: 9 * 60, dow: "sat" };

test("slots follow configured hours (Sat–Thu 15:00–20:00, 30-min)", () => {
  const r = computeDaySlots({ ...base, ymd: "2026-09-27", now });
  assert.equal(r.open, true);
  assert.deepEqual(r.slots, ["15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "19:30"]);
});

test("Friday is closed (not invented)", () => {
  assert.equal(dowKey("2026-10-02"), "fri");
  const r = computeDaySlots({ ...base, ymd: "2026-10-02", now });
  assert.equal(r.open, false); assert.equal(r.reason, "CLOSED");
});

test("past dates, window limit and minimum notice", () => {
  assert.equal(computeDaySlots({ ...base, ymd: "2026-09-25", now }).reason, "PAST");
  assert.equal(computeDaySlots({ ...base, ymd: "2026-12-01", now }).reason, "OUT_OF_WINDOW");
  const r = computeDaySlots({ ...base, ymd: "2026-09-26", now: { ...now, minutes: 16 * 60 + 10 } });
  assert.equal(r.slots[0], "18:30"); // 16:10 + 120 min notice → first slot ≥ 18:10
});

test("booked granules and blocked periods remove slots; holidays close the day", () => {
  const locked = new Set(granules(15 * 60 + 30, 30, 0));
  const r = computeDaySlots({ ...base, ymd: "2026-09-27", now, lockedMinutes: locked, blocks: [{ start: 18 * 60, end: 19 * 60 }] });
  assert.ok(!r.slots.includes("15:30")); assert.ok(!r.slots.includes("18:00")); assert.ok(!r.slots.includes("18:30"));
  assert.ok(r.slots.includes("15:00") && r.slots.includes("19:00"));
  assert.equal(computeDaySlots({ ...base, ymd: "2026-09-27", now, blocks: [{ whole: true }] }).reason, "HOLIDAY");
});

test("longer service + buffer overlaps are detected via granules", () => {
  const s60 = { ...service, duration_minutes: 60 };
  const locked = new Set(granules(16 * 60, 30, 10)); // 16:00–16:40 occupied
  const r = computeDaySlots({ ...base, service: s60, ymd: "2026-09-27", now, lockedMinutes: locked });
  assert.ok(!r.slots.includes("15:30")); // 15:30–16:30 overlaps
  assert.ok(!r.slots.includes("16:00"));
  assert.ok(r.slots.includes("17:00"));
  assert.ok(!r.slots.includes("19:30")); // would end 20:30 > close
  assert.deepEqual(granules(900, 30, 0), [900, 905, 910, 915, 920, 925]);
});

test("inactive service & service day restrictions", () => {
  assert.equal(computeDaySlots({ ...base, service: { ...service, active: 0 }, ymd: "2026-09-27", now }).reason, "SERVICE_INACTIVE");
  assert.equal(computeDaySlots({ ...base, service: { ...service, available_days: ["mon"] }, ymd: "2026-09-27", now }).reason, "SERVICE_NOT_ON_DAY");
});

test("working-hours shapes", () => {
  assert.deepEqual(dayRanges({ sat: ["15:00", "20:00"] }, "sat"), [[900, 1200]]);
  assert.deepEqual(dayRanges({ sat: [["10:00", "12:00"], ["15:00", "20:00"]] }, "sat"), [[600, 720], [900, 1200]]);
  assert.deepEqual(dayRanges({ fri: null }, "fri"), []);
});

test("clinic time uses Asia/Baghdad regardless of host TZ", () => {
  const n = clinicNow("Asia/Baghdad", new Date("2026-09-26T21:30:00Z")); // 00:30 next day in Baghdad (UTC+3)
  assert.equal(n.ymd, "2026-09-27"); assert.equal(n.minutes, 30);
  assert.ok(isValidYmd("2026-02-28")); assert.ok(!isValidYmd("2026-02-30"));
});

test("TEST mode routes every message to the test recipient only", () => {
  const env = { WHATSAPP_MODE: "test", WHATSAPP_TEST_RECIPIENT: "+9647755473704", WHATSAPP_CLINIC_RECIPIENT: "+9647706266800" };
  assert.equal(environmentOf(env), "test");
  const appt = { phone: "+9647701112222" };
  assert.equal(resolveRecipient(env, { environment: "test", type: "clinic_new_booking" }, appt).to, "+9647755473704");
  assert.equal(resolveRecipient(env, { environment: "test", type: "patient_confirmation" }, appt).to, "+9647755473704");
  assert.ok(resolveRecipient(env, { environment: "production", type: "clinic_new_booking" }, appt).error); // env mismatch blocked
});

test("PRODUCTION mode never uses the test recipient", () => {
  const env = { WHATSAPP_MODE: "production", WHATSAPP_TEST_RECIPIENT: "+9647755473704", WHATSAPP_CLINIC_RECIPIENT: "+9647706266800" };
  const appt = { phone: "+9647701112222" };
  assert.equal(resolveRecipient(env, { environment: "production", type: "clinic_new_booking" }, appt).to, "+9647706266800");
  assert.equal(resolveRecipient(env, { environment: "production", type: "patient_confirmation" }, appt).to, "+9647701112222");
  assert.ok(resolveRecipient(env, { environment: "test", type: "clinic_new_booking" }, appt).error);
  const bad = { ...env, WHATSAPP_CLINIC_RECIPIENT: "+9647755473704" };
  assert.ok(resolveRecipient(bad, { environment: "production", type: "clinic_new_booking" }, appt).error);
  assert.ok(resolveRecipient({ ...env, WHATSAPP_CLINIC_RECIPIENT: "" }, { environment: "production", type: "clinic_new_booking" }, appt).error);
});

test("test messages are unmistakably marked", () => {
  const appt = { patient_name: "A", phone: "+9647701112222", service_name_ar: "حشوات الأسنان", service_name_en: "Dental Fillings", appointment_date: "2026-09-27", start_time: "15:30", booking_reference: "ALZ-2026-ABCDE", status: "pending" };
  assert.match(buildMessage({ environment: "test", type: "clinic_new_booking" }, appt), /^🧪 TEST BOOKING/);
  assert.match(buildMessage({ environment: "production", type: "clinic_new_booking" }, appt), /^📅 حجز جديد/);
  assert.match(buildMessage({ environment: "test", type: "patient_confirmation", lang: "en" }, appt), /TEST/);
  assert.doesNotMatch(buildMessage({ environment: "production", type: "patient_confirmation", lang: "ar" }, appt), /TEST/);
});

test("exponential backoff grows and is capped", () => {
  const a = backoffSeconds(1), b = backoffSeconds(4), c = backoffSeconds(20);
  assert.ok(a >= 48 && a <= 72); assert.ok(b >= 384 && b <= 576); assert.ok(c <= 6 * 3600 * 1.2);
});
