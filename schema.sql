-- ============================================================
-- Seven Sigma — License Server : Skema D1 (SQLite)
-- Jalankan: npx wrangler d1 execute quantum-queen-license --remote --file=./schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS license_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT    NOT NULL UNIQUE,          -- kunci: QQX-XXXXX-XXXXX-XXXXX
  key_norm        TEXT    NOT NULL UNIQUE,          -- versi tanpa tanda hubung (pencarian)
  label           TEXT    NOT NULL DEFAULT '',      -- nama pembeli / catatan admin
  status          TEXT    NOT NULL DEFAULT 'active',-- active | revoked
  duration_days   INTEGER NOT NULL DEFAULT 30,      -- masa aktif sejak aktivasi pertama
  max_devices     INTEGER NOT NULL DEFAULT 1,       -- 1 device 1 key
  created_at      INTEGER NOT NULL,                 -- epoch detik (UTC)
  activated_at    INTEGER,                          -- epoch aktivasi pertama
  expires_at      INTEGER,                          -- epoch kadaluarsa (dihitung saat aktivasi)
  last_checkin_at INTEGER,
  last_account    TEXT,
  last_broker     TEXT,
  last_ip         TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id      INTEGER NOT NULL,
  account     TEXT    NOT NULL,                     -- nomor akun trading MT5
  broker      TEXT    NOT NULL DEFAULT '',          -- nama broker
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  last_ip     TEXT,
  balance     REAL    DEFAULT 0,                    -- statistik trading dari EA
  equity      REAL    DEFAULT 0,
  float_pl    REAL    DEFAULT 0,
  wins        INTEGER DEFAULT 0,
  losses      INTEGER DEFAULT 0,
  closed_pl   REAL    DEFAULT 0,
  stats_at    INTEGER,
  stats_full  TEXT,                                 -- JSON portofolio lengkap ala MQL5 Signal
  UNIQUE(key_id, account)
);

CREATE TABLE IF NOT EXISTS checkin_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id     INTEGER,
  key_text   TEXT    NOT NULL DEFAULT '',
  account    TEXT    NOT NULL DEFAULT '',
  broker     TEXT    NOT NULL DEFAULT '',
  ip         TEXT    NOT NULL DEFAULT '',
  event      TEXT    NOT NULL,                     -- ACTIVATE | VALID | NOT_FOUND | REVOKED | EXPIRED | DEVICE_LIMIT | INVALID
  detail     TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Key-value store konfigurasi runtime (dikelola dari dashboard admin):
--   admin_pw_hash  : hash PBKDF2 password admin (hasil "Ganti Password" dashboard)
--   tg_bot_token   : token bot Telegram utk notifikasi
--   tg_chat_id     : chat ID tujuan notifikasi
--   tg_enabled     : '1' aktif / '0' mati
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Rate-limit sederhana utk halaman cek key publik (1 baris per IP, window per jam)
CREATE TABLE IF NOT EXISTS check_rate (
  ip           TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  n            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_devices_key  ON devices(key_id);
CREATE INDEX IF NOT EXISTS idx_logs_key     ON checkin_logs(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_time    ON checkin_logs(created_at DESC);
