-- ============================================================
-- Quantum Queen X — License Server : Skema D1 (SQLite)
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

CREATE INDEX IF NOT EXISTS idx_devices_key  ON devices(key_id);
CREATE INDEX IF NOT EXISTS idx_logs_key     ON checkin_logs(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_time    ON checkin_logs(created_at DESC);
