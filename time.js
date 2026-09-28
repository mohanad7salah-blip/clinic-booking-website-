// Clinic-timezone helpers. All booking maths is done on clinic-local wall-clock
// values (YYYY-MM-DD + minutes since midnight) derived from Asia/Baghdad —
// never from the server's or the browser's local timezone.

export const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Current wall-clock time in the clinic timezone. */
export function clinicNow(tz = "Asia/Baghdad", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const g = t => parts.find(p => p.type === t).value;
  const hour = Number(g("hour")) % 24; // some engines emit "24" at midnight
  const ymd = `${g("year")}-${g("month")}-${g("day")}`;
  return { ymd, minutes: hour * 60 + Number(g("minute")), dow: dowKey(ymd) };
}

export function isValidYmd(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidHm(s) {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function dowKey(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return DOW_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function toMin(hm) { const [h, m] = hm.split(":").map(Number); return h * 60 + m; }
export function fromMin(min) { return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"); }

export function diffDays(a, b) {
  const pa = a.split("-").map(Number), pb = b.split("-").map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
