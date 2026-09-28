-- =====================================================================
-- Dr. Ali Al-Zubaidi Dental Clinic — Booking database (Cloudflare D1 / SQLite)
-- Apply:  npx wrangler d1 execute alz_booking --remote --file=./schema.sql
-- Idempotent: safe to re-run.
-- =====================================================================
PRAGMA foreign_keys = ON;

-- ---------- Services ----------
CREATE TABLE IF NOT EXISTS services (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9-]*' AND length(slug) BETWEEN 2 AND 60),
  name_ar          TEXT NOT NULL,
  name_en          TEXT NOT NULL,
  description_ar   TEXT,
  description_en   TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 480), -- NULL = clinic default
  available_days   TEXT,            -- JSON array e.g. ["sat","mon"]; NULL = all clinic working days
  sort_order       INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- Appointments ----------
CREATE TABLE IF NOT EXISTS appointments (
  id                TEXT PRIMARY KEY,                       -- UUID
  booking_reference TEXT NOT NULL UNIQUE,                   -- e.g. ALZ-2026-7KQ2M
  environment       TEXT NOT NULL CHECK (environment IN ('test','production')),
  patient_name      TEXT NOT NULL CHECK (length(patient_name) BETWEEN 2 AND 80),
  phone             TEXT NOT NULL CHECK (phone GLOB '+9647[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  email             TEXT,
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  service_id        INTEGER NOT NULL REFERENCES services(id),
  appointment_date  TEXT NOT NULL CHECK (appointment_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_time        TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time          TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  timezone          TEXT NOT NULL DEFAULT 'Asia/Baghdad',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  lang              TEXT NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  idempotency_key   TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (environment, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_appt_env_date   ON appointments(environment, appointment_date, start_time);
CREATE INDEX IF NOT EXISTS idx_appt_status     ON appointments(environment, status);
CREATE INDEX IF NOT EXISTS idx_appt_phone      ON appointments(phone);

-- ---------- Slot locks: THE double-booking guard ----------
-- Every active appointment owns one row per 5-minute granule it occupies
-- (duration + buffer). The composite PRIMARY KEY makes it physically
-- impossible for two appointments in the same environment to own the same
-- granule. Inserts happen inside the same atomic D1 batch as the
-- appointment row, so either everything commits or nothing does.
CREATE TABLE IF NOT EXISTS slot_locks (
  environment    TEXT NOT NULL CHECK (environment IN ('test','production')),
  slot_date      TEXT NOT NULL,
  slot_minute    INTEGER NOT NULL CHECK (slot_minute BETWEEN 0 AND 1435 AND slot_minute % 5 = 0),
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  PRIMARY KEY (environment, slot_date, slot_minute)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_locks_appt ON slot_locks(appointment_id);

-- ---------- Idempotency ----------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  environment     TEXT NOT NULL,
  idem_key        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  appointment_id  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (environment, idem_key)
) WITHOUT ROWID;

-- ---------- Notifications (outbox) ----------
CREATE TABLE IF NOT EXISTS notifications (
  id                  TEXT PRIMARY KEY,
  appointment_id      TEXT REFERENCES appointments(id) ON DELETE CASCADE,
  environment         TEXT NOT NULL CHECK (environment IN ('test','production')),
  type                TEXT NOT NULL CHECK (type IN ('clinic_new_booking','patient_confirmation','system_test')),
  channel             TEXT NOT NULL DEFAULT 'whatsapp',
  recipient           TEXT,              -- resolved at send time; stored for audit
  lang                TEXT NOT NULL DEFAULT 'ar',
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','delivered','read','failed','retrying')),
  provider_message_id TEXT UNIQUE,
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 5,
  next_attempt_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  locked_until        TEXT,
  last_attempt_at     TEXT,
  last_error          TEXT,
  sent_at             TEXT,
  delivered_at        TEXT,
  read_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Notification identity: booking + type + environment → never sent twice
  UNIQUE (appointment_id, type, environment)
);
CREATE INDEX IF NOT EXISTS idx_notif_due ON notifications(status, next_attempt_at);

-- ---------- Clinic settings (single row) ----------
CREATE TABLE IF NOT EXISTS clinic_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  timezone         TEXT NOT NULL DEFAULT 'Asia/Baghdad',
  phone            TEXT NOT NULL,
  address_ar       TEXT NOT NULL,
  address_en       TEXT NOT NULL,
  working_hours    TEXT NOT NULL,        -- JSON {sat:[["15:00","20:00"]], ..., fri:null}
  booking_settings TEXT NOT NULL,        -- JSON {default_duration, buffer_minutes, slot_step_minutes, booking_window_days, min_notice_minutes}
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- Blocked times / holidays ----------
CREATE TABLE IF NOT EXISTS blocked_times (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  start_time  TEXT,        -- NULL with end_time NULL = whole day (holiday)
  end_time    TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((start_time IS NULL AND end_time IS NULL) OR (start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time))
);
CREATE INDEX IF NOT EXISTS idx_blocked_date ON blocked_times(date);

-- ---------- Admins & sessions ----------
CREATE TABLE IF NOT EXISTS admins (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash    TEXT NOT NULL,       -- pbkdf2-sha256$iterations$salt_b64$hash_b64
  role             TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff')),
  failed_attempts  INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  TEXT PRIMARY KEY,          -- SHA-256 of the cookie token (raw token never stored)
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) WITHOUT ROWID;

-- ---------- Rate limiting ----------
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT PRIMARY KEY,        -- "<scope>:<sha256(ip)>"
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL         -- epoch seconds
) WITHOUT ROWID;

-- ---------- Audit log (admin actions) ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER,
  action      TEXT NOT NULL,
  target      TEXT,
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- =====================================================================
-- Seed data — ONLY clinic-supplied facts. Durations left NULL (clinic default).
-- =====================================================================
INSERT OR IGNORE INTO clinic_settings (id, timezone, phone, address_ar, address_en, working_hours, booking_settings) VALUES (
  1, 'Asia/Baghdad', '+9647706266800',
  'شارع الربيعي، زيونة، بغداد، محافظة بغداد، العراق',
  'Al-Rubaie Street, Zayouna, Baghdad, Baghdad Governorate, Iraq',
  '{"sat":[["15:00","20:00"]],"sun":[["15:00","20:00"]],"mon":[["15:00","20:00"]],"tue":[["15:00","20:00"]],"wed":[["15:00","20:00"]],"thu":[["15:00","20:00"]],"fri":null}',
  '{"default_duration":30,"buffer_minutes":0,"slot_step_minutes":30,"booking_window_days":30,"min_notice_minutes":120}'
);

INSERT OR IGNORE INTO services (slug, name_ar, name_en, sort_order) VALUES
  ('teeth-whitening',         'تبييض الأسنان',                 'Teeth Whitening', 1),
  ('emax',                    'إيماكس EMAX',                    'EMAX', 2),
  ('cosmetic-dentistry',      'تجميل الأسنان والتجميل الوجهي', 'Cosmetic Dentistry & Facial Aesthetics', 3),
  ('orthodontic-treatment',   'تقويم الأسنان',                 'Orthodontic Treatment', 4),
  ('gold-braces',             'التقويم الذهبي',                'Gold Braces', 5),
  ('metal-braces',            'التقويم المعدني',               'Metal Braces', 6),
  ('clear-braces',            'التقويم الشفاف',                'Clear Braces', 7),
  ('clear-aligners',          'التقويم الشفاف المتحرك',        'Removable Clear Aligners', 8),
  ('dental-fillings',         'حشوات الأسنان',                 'Dental Fillings', 9),
  ('wisdom-tooth-extraction', 'قلع ضرس العقل',                 'Wisdom Tooth Extraction', 10);
