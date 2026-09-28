// Availability engine — server-side, authoritative, Asia/Baghdad.
import { clinicNow, addDays, dowKey, toMin, fromMin, diffDays, isValidYmd } from "./time.js";

export const GRANULE = 5; // minutes; slot_locks resolution

export const DEFAULT_BOOKING_SETTINGS = {
  default_duration: 30,
  buffer_minutes: 0,
  slot_step_minutes: 30,
  booking_window_days: 30,
  min_notice_minutes: 120,
  max_active_per_phone: 3
};

export async function loadSettings(db) {
  const row = await db.prepare("SELECT * FROM clinic_settings WHERE id = 1").first();
  if (!row) throw new Error("SETTINGS_MISSING");
  return {
    timezone: row.timezone || "Asia/Baghdad",
    phone: row.phone,
    address_ar: row.address_ar,
    address_en: row.address_en,
    working_hours: JSON.parse(row.working_hours || "{}"),
    booking: { ...DEFAULT_BOOKING_SETTINGS, ...JSON.parse(row.booking_settings || "{}") }
  };
}

export async function loadService(db, slug) {
  if (typeof slug !== "string" || !/^[a-z0-9-]{2,60}$/.test(slug)) return null;
  const s = await db.prepare("SELECT * FROM services WHERE slug = ?").bind(slug).first();
  if (!s) return null;
  s.available_days = s.available_days ? JSON.parse(s.available_days) : null;
  return s;
}

export function serviceDuration(service, settings) {
  const d = Number(service.duration_minutes) || Number(settings.booking.default_duration) || 30;
  return Math.ceil(d / GRANULE) * GRANULE;
}

/** 5-minute granules occupied by an appointment [start, start+duration+buffer). */
export function granules(startMin, duration, buffer) {
  const from = Math.floor(startMin / GRANULE) * GRANULE;
  const to = Math.ceil((startMin + duration + (buffer || 0)) / GRANULE) * GRANULE;
  const out = [];
  for (let m = from; m < to && m < 1440; m += GRANULE) out.push(m);
  return out;
}

/** Normalise working-hours value into [[startMin,endMin],...] or [] (closed). */
export function dayRanges(workingHours, dow) {
  const v = workingHours?.[dow];
  if (!v || !Array.isArray(v) || !v.length) return [];
  const ranges = typeof v[0] === "string" ? [v] : v;
  return ranges
    .filter(r => Array.isArray(r) && r.length === 2)
    .map(([a, b]) => [toMin(a), toMin(b)])
    .filter(([a, b]) => b > a);
}

/**
 * Pure slot computation (unit-tested).
 * @returns {{open:boolean, reason?:string, slots:string[]}}
 */
export function computeDaySlots({ settings, service, ymd, now, lockedMinutes, blocks }) {
  const b = settings.booking;
  const offset = diffDays(now.ymd, ymd);
  if (offset < 0) return { open: false, reason: "PAST", slots: [] };
  if (offset > b.booking_window_days) return { open: false, reason: "OUT_OF_WINDOW", slots: [] };
  if (!service || !service.active) return { open: false, reason: "SERVICE_INACTIVE", slots: [] };

  const dow = dowKey(ymd);
  if (service.available_days && !service.available_days.includes(dow)) return { open: false, reason: "SERVICE_NOT_ON_DAY", slots: [] };
  const ranges = dayRanges(settings.working_hours, dow);
  if (!ranges.length) return { open: false, reason: "CLOSED", slots: [] };
  if (blocks.some(x => x.whole)) return { open: false, reason: "HOLIDAY", slots: [] };

  const duration = serviceDuration(service, settings);
  const buffer = Number(b.buffer_minutes) || 0;
  const step = Math.max(5, Number(b.slot_step_minutes) || duration);
  const earliest = offset === 0 ? now.minutes + (Number(b.min_notice_minutes) || 0) : -1;
  const slots = [];

  for (const [open, close] of ranges) {
    for (let start = open; start + duration <= close; start += step) {
      if (start < earliest) continue;
      const end = start + duration;
      if (blocks.some(x => !x.whole && start < x.end && end > x.start)) continue;
      const g = granules(start, duration, buffer);
      if (g.some(m => lockedMinutes.has(m))) continue;
      slots.push(fromMin(start));
    }
  }
  return { open: true, slots };
}

async function fetchDayData(db, environment, ymd) {
  const [locks, blocks] = await db.batch([
    db.prepare("SELECT slot_minute FROM slot_locks WHERE environment = ? AND slot_date = ?").bind(environment, ymd),
    db.prepare("SELECT start_time, end_time FROM blocked_times WHERE date = ?").bind(ymd)
  ]);
  return {
    lockedMinutes: new Set(locks.results.map(r => r.slot_minute)),
    blocks: blocks.results.map(r => r.start_time ? { start: toMin(r.start_time), end: toMin(r.end_time) } : { whole: true })
  };
}

export async function getDaySlots(db, environment, slug, ymd, preloaded) {
  if (!isValidYmd(ymd)) return { error: "INVALID_DATE" };
  const settings = preloaded?.settings || await loadSettings(db);
  const service = preloaded?.service || await loadService(db, slug);
  if (!service) return { error: "UNKNOWN_SERVICE" };
  const now = clinicNow(settings.timezone);
  const data = await fetchDayData(db, environment, ymd);
  return { settings, service, now, ...computeDaySlots({ settings, service, ymd, now, ...data }) };
}

export async function getCalendar(db, environment, slug) {
  const settings = await loadSettings(db);
  const service = await loadService(db, slug);
  if (!service) return { error: "UNKNOWN_SERVICE" };
  const now = clinicNow(settings.timezone);
  const last = addDays(now.ymd, settings.booking.booking_window_days);
  const [locks, blocks] = await db.batch([
    db.prepare("SELECT slot_date, slot_minute FROM slot_locks WHERE environment = ? AND slot_date BETWEEN ? AND ?").bind(environment, now.ymd, last),
    db.prepare("SELECT date, start_time, end_time FROM blocked_times WHERE date BETWEEN ? AND ?").bind(now.ymd, last)
  ]);
  const lockMap = new Map(), blockMap = new Map();
  for (const r of locks.results) { if (!lockMap.has(r.slot_date)) lockMap.set(r.slot_date, new Set()); lockMap.get(r.slot_date).add(r.slot_minute); }
  for (const r of blocks.results) {
    if (!blockMap.has(r.date)) blockMap.set(r.date, []);
    blockMap.get(r.date).push(r.start_time ? { start: toMin(r.start_time), end: toMin(r.end_time) } : { whole: true });
  }
  const days = [];
  for (let i = 0; i <= settings.booking.booking_window_days; i++) {
    const ymd = addDays(now.ymd, i);
    const res = computeDaySlots({ settings, service, ymd, now, lockedMinutes: lockMap.get(ymd) || new Set(), blocks: blockMap.get(ymd) || [] });
    days.push({ date: ymd, open: res.open, available: res.slots.length, reason: res.reason });
  }
  return { days, timezone: settings.timezone };
}
