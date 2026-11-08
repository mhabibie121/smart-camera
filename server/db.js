import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbPath);

// Kamera bisa ditambah dengan 2 cara:
//  - mode Dahua: ip + port + channel (+ login), URL RTSP dibuat otomatis
//  - mode URL RTSP: rtsp_main (+ rtsp_sub) diisi lengkap; ip/port diambil dari URL
//    hanya untuk cek online/offline.
const CAMERAS_COLUMNS = `
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    location  TEXT NOT NULL DEFAULT '',
    ip        TEXT NOT NULL,
    port      INTEGER NOT NULL DEFAULT 554,
    channel   INTEGER NOT NULL DEFAULT 1,
    username  TEXT,           -- NULL = pakai default dari pengaturan
    password  TEXT,           -- NULL = pakai default dari pengaturan
    enabled   INTEGER NOT NULL DEFAULT 1,
    rtsp_main TEXT,           -- NULL = mode Dahua
    rtsp_sub  TEXT,           -- NULL = turunan rtsp_main (subtype=1) atau sama dengan main
    hik_code  TEXT            -- cameraIndexCode HikCentral (URL diminta otomatis)
`;

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS groups (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    group_id        INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cameras (${CAMERAS_COLUMNS});

  CREATE TABLE IF NOT EXISTS group_cameras (
    group_id  INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    camera_id INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, camera_id)
  );

  -- Susunan tampilan tersimpan ("View") milik masing-masing user
  CREATE TABLE IF NOT EXISTS views (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    layout     TEXT NOT NULL,
    slots      TEXT NOT NULL,   -- JSON: [cameraId | null, ...]
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, name)
  );

  -- Tampilan terakhir user (dipulihkan setelah login lagi)
  CREATE TABLE IF NOT EXISTS user_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state   TEXT NOT NULL
  );
`);

// Migrasi kolom baru untuk database lama
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('groups', 'max_tiles', 'INTEGER'); // NULL = pakai default global

// Database lama: tabel cameras punya UNIQUE(ip, port, channel) yang tidak cocok
// untuk kamera mode URL RTSP. Bangun ulang tabelnya (data tetap utuh).
{
  const camSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cameras'").get().sql;
  if (camSql.includes('UNIQUE (ip, port, channel)')) {
    db.exec('PRAGMA foreign_keys = OFF');
    tx(() => {
      db.exec(`CREATE TABLE cameras_new (${CAMERAS_COLUMNS})`);
      db.exec(`INSERT INTO cameras_new (id, name, location, ip, port, channel, username, password, enabled)
               SELECT id, name, location, ip, port, channel, username, password, enabled FROM cameras`);
      db.exec('DROP TABLE cameras');
      db.exec('ALTER TABLE cameras_new RENAME TO cameras');
    });
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[db] tabel kamera dimigrasi (dukungan URL RTSP)');
  }
}
addColumn('cameras', 'hik_code', 'TEXT');
addColumn('cameras', 'ptz', 'INTEGER NOT NULL DEFAULT 0');       // 1 = kamera PTZ
addColumn('cameras', 'http_port', 'INTEGER NOT NULL DEFAULT 80'); // port HTTP untuk perintah PTZ
addColumn('groups', 'can_ptz', 'INTEGER NOT NULL DEFAULT 0');     // 1 = boleh menggerakkan PTZ
addColumn('users', 'can_ptz', 'INTEGER NOT NULL DEFAULT 0');      // izin PTZ khusus user ini
addColumn('views', 'shared', 'INTEGER NOT NULL DEFAULT 0');       // 1 = View dibagikan ke semua user & tamu
addColumn('users', 'monitor', 'INTEGER NOT NULL DEFAULT 0');      // 1 = tampilan monitor (hanya CCTV + playlist)
// ---- Modul rekaman ----
addColumn('cameras', 'record', 'INTEGER NOT NULL DEFAULT 0');           // 1 = direkam terus-menerus
addColumn('cameras', 'record_quality', "TEXT NOT NULL DEFAULT 'main'"); // 'main' | 'sub'
db.exec(`
  -- Rekaman yang dikunci (bukti kejadian): segmen yang beririsan tidak ikut terhapus
  CREATE TABLE IF NOT EXISTS record_locks (
    id         INTEGER PRIMARY KEY,
    camera_id  INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    start_at   TEXT NOT NULL,   -- ISO
    end_at     TEXT NOT NULL,   -- ISO
    note       TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Kamera mode Dahua tetap tidak boleh dobel; kamera HikCentral tidak boleh dobel kodenya
db.exec(`
  DROP INDEX IF EXISTS cameras_dahua_unique;
  CREATE UNIQUE INDEX IF NOT EXISTS cameras_dahua_unique2
    ON cameras (ip, port, channel) WHERE rtsp_main IS NULL AND hik_code IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS cameras_hik_unique ON cameras (hik_code) WHERE hik_code IS NOT NULL;
`);

export const ABSOLUTE_MAX_TILES = 64;

// Jumlah kotak maksimal yang boleh dipakai user di grid
export function maxTilesFor(user) {
  if (user.is_admin) return ABSOLUTE_MAX_TILES;
  const g = user.group_id ? db.prepare('SELECT max_tiles FROM groups WHERE id = ?').get(user.group_id) : null;
  const def = Number(getSetting('default_max_tiles', '36')) || 36;
  return Math.min(ABSOLUTE_MAX_TILES, g?.max_tiles || def);
}

// Boleh menggerakkan kamera PTZ? Admin selalu boleh.
// Izin bisa diberikan per user (orang tertentu) atau ke seluruh grup.
export function canControlPtz(user) {
  if (user.guest) return false; // tamu (tanpa login) tidak pernah boleh PTZ
  if (user.is_admin) return true;
  if (db.prepare('SELECT can_ptz FROM users WHERE id = ?').get(user.id)?.can_ptz) return true;
  if (!user.group_id) return false;
  return !!db.prepare('SELECT can_ptz FROM groups WHERE id = ?').get(user.group_id)?.can_ptz;
}

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Kamera yang boleh dilihat user. Admin = semua.
export function visibleCameras(user) {
  if (user.is_admin) {
    return db.prepare(
      'SELECT id, name, location, ptz FROM cameras WHERE enabled = 1 ORDER BY location, name'
    ).all();
  }
  if (!user.group_id) return [];
  return db.prepare(`
    SELECT c.id, c.name, c.location, c.ptz FROM cameras c
    JOIN group_cameras gc ON gc.camera_id = c.id
    WHERE gc.group_id = ? AND c.enabled = 1
    ORDER BY c.location, c.name
  `).all(user.group_id);
}

export function canViewCamera(user, cameraId) {
  const cam = db.prepare('SELECT enabled FROM cameras WHERE id = ?').get(cameraId);
  if (!cam || !cam.enabled) return false;
  if (user.is_admin) return true;
  if (!user.group_id) return false;
  return !!db.prepare(
    'SELECT 1 FROM group_cameras WHERE group_id = ? AND camera_id = ?'
  ).get(user.group_id, cameraId);
}
