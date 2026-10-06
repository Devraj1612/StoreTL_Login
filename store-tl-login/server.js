'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const FACE_THRESHOLD = Number(process.env.FACE_THRESHOLD || 0.5); // lower = stricter (face-api typical: 0.6)
const MAX_GPS_ACCURACY_M = Number(process.env.MAX_GPS_ACCURACY_M || 150);
const SESSION_HOURS = 8;
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Kolkata';
const SHIFT_DEADLINES = { morning: '06:30', midday: '10:30', evening: '15:30' };

// ---------- Database ----------
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  store_name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 100,
  UNIQUE(city, store_name)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  face_descriptor TEXT,
  photo_data TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  phone TEXT,
  shift_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  login_id TEXT,
  user_id INTEGER,
  result TEXT NOT NULL,
  reason TEXT,
  lat REAL, lng REAL,
  distance_m REAL,
  face_distance REAL
);
`);
const userColumns = new Set(db.pragma('table_info(users)').map((column) => column.name));
if (!userColumns.has('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
if (!userColumns.has('shift_code')) db.exec('ALTER TABLE users ADD COLUMN shift_code TEXT');
if (!userColumns.has('photo_data')) db.exec('ALTER TABLE users ADD COLUMN photo_data TEXT');
const duplicatePhoneGroups = db.prepare(`SELECT COUNT(*) AS count FROM (
  SELECT phone FROM users WHERE phone IS NOT NULL AND phone != '' GROUP BY phone HAVING COUNT(*) > 1
)`).get().count;
if (!duplicatePhoneGroups) db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone IS NOT NULL AND phone != ''");
db.exec(`
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shift_alerts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_date TEXT NOT NULL,
  recipient TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (user_id, shift_date, recipient)
);
CREATE TABLE IF NOT EXISTS performance_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  breach_percent REAL NOT NULL CHECK (breach_percent >= 0 AND breach_percent <= 100),
  delay_root_cause TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id, report_date)
);
`);

// Bootstrap first admin
if (!db.prepare('SELECT COUNT(*) c FROM admins').get().c) {
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASS || 'ChangeMe@123';
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(u, bcrypt.hashSync(p, 12));
  console.log(`[setup] Admin created -> username: ${u}  password: ${process.env.ADMIN_PASS ? '(from ADMIN_PASS)' : p}`);
  if (!process.env.ADMIN_PASS) console.log('[setup] Change this password after first login (Admin > Account).');
}

// JWT secret persisted so sessions survive restarts
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  const f = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  SECRET = fs.readFileSync(f, 'utf8');
}

// ---------- Helpers ----------
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function faceDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}
const validDescriptor = (d) => Array.isArray(d) && d.length === 128 && d.every((n) => typeof n === 'number' && Number.isFinite(n));
const validFacePhoto = (photo) => photo == null || (typeof photo === 'string' && photo.length <= 350000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo));
const validCoord = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const validPhone = (phone) => /^\+[1-9]\d{7,14}$/.test(String(phone || ''));
const validShift = (shift) => Object.hasOwn(SHIFT_DEADLINES, shift);
function getDuplicatePhoneUser(phone, excludeId = null) {
  if (!validPhone(phone)) return null;
  return excludeId == null
    ? db.prepare('SELECT id FROM users WHERE phone = ? LIMIT 1').get(phone)
    : db.prepare('SELECT id FROM users WHERE phone = ? AND id != ? LIMIT 1').get(phone, excludeId);
}
function hasDuplicateFace(descriptor, excludeId = null) {
  if (!validDescriptor(descriptor)) return false;
  const users = excludeId == null
    ? db.prepare('SELECT id, face_descriptor FROM users WHERE face_descriptor IS NOT NULL').all()
    : db.prepare('SELECT id, face_descriptor FROM users WHERE face_descriptor IS NOT NULL AND id != ?').all(excludeId);

  return users.some((user) => {
    try {
      const enrolled = JSON.parse(user.face_descriptor);
      return validDescriptor(enrolled) && faceDistance(descriptor, enrolled) <= FACE_THRESHOLD;
    } catch {
      return false;
    }
  });
}
const validIsoDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

function localDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function issue(res, req, payload) {
  const token = jwt.sign(payload, SECRET, { expiresIn: `${SESSION_HOURS}h` });
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_HOURS * 3600 * 1000,
  });
}
function auth(role) {
  return (req, res, next) => {
    try {
      const p = jwt.verify(req.cookies.session, SECRET);
      if (p.role !== role) throw new Error('role');
      req.auth = p;
      next();
    } catch {
      res.status(401).json({ error: 'Please sign in.' });
    }
  };
}
const addLog = db.prepare(`INSERT INTO login_logs (login_id, user_id, result, reason, lat, lng, distance_m, face_distance)
                           VALUES (@login_id, @user_id, @result, @reason, @lat, @lng, @distance_m, @face_distance)`);
const log = (o) => addLog.run({ login_id: null, user_id: null, reason: null, lat: null, lng: null, distance_m: null, face_distance: null, ...o });

// ---------- App ----------
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '500kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' } });

// ----- Team lead login -----
app.post('/api/login', limiter, (req, res) => {
  const { loginId, password, lat, lng, accuracy, descriptor } = req.body || {};
  const id = String(loginId || '').trim();
  const u = db.prepare(`SELECT u.*, s.city, s.store_name, s.lat slat, s.lng slng, s.radius_m
                        FROM users u JOIN stores s ON s.id = u.store_id WHERE u.login_id = ?`).get(id);

  const passOk = bcrypt.compareSync(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !passOk) {
    log({ login_id: id, user_id: u?.id, result: 'denied', reason: 'bad_credentials' });
    return res.status(401).json({ error: 'Incorrect ID or password.' });
  }
  if (!u.active) {
    log({ login_id: id, user_id: u.id, result: 'denied', reason: 'inactive' });
    return res.status(403).json({ error: 'This account is turned off. Contact your admin.' });
  }

  // Location check
  const la = Number(lat), lo = Number(lng);
  if (!validCoord(la, lo)) {
    log({ login_id: id, user_id: u.id, result: 'denied', reason: 'no_location' });
    return res.status(400).json({ error: 'Location is required. Allow location access and try again.' });
  }
  if (Number(accuracy) > MAX_GPS_ACCURACY_M) {
    log({ login_id: id, user_id: u.id, result: 'denied', reason: 'weak_gps', lat: la, lng: lo });
    return res.status(400).json({ error: `Location signal is too weak (±${Math.round(accuracy)} m). Move near a window or turn on GPS.` });
  }
  const dist = haversine(la, lo, u.slat, u.slng);
  if (!(dist <= u.radius_m)) { // fails closed if distance is NaN
    log({ login_id: id, user_id: u.id, result: 'denied', reason: 'outside_range', lat: la, lng: lo, distance_m: dist });
    return res.status(403).json({ error: `You are ${Math.round(dist)} m from ${u.store_name}, ${u.city}. Sign-in works within ${u.radius_m} m of the store.` });
  }

  // Face check
  if (!u.face_descriptor) {
    log({ login_id: id, user_id: u.id, result: 'denied', reason: 'face_not_enrolled', lat: la, lng: lo, distance_m: dist });
    return res.status(403).json({ error: 'Your face is not enrolled yet. Ask your admin to enrol it.' });
  }
  if (!validDescriptor(descriptor)) {
    return res.status(400).json({ error: 'No face captured. Look at the camera and try again.' });
  }
  const fd = faceDistance(descriptor, JSON.parse(u.face_descriptor));
  if (fd > FACE_THRESHOLD) {
    log({ login_id: id, user_id: u.id, result: 'denied', reason: 'face_mismatch', lat: la, lng: lo, distance_m: dist, face_distance: fd });
    return res.status(403).json({ error: 'Face did not match this account.' });
  }

  log({ login_id: id, user_id: u.id, result: 'allowed', lat: la, lng: lo, distance_m: dist, face_distance: fd });
  issue(res, req, { role: 'user', uid: u.id });
  res.json({ ok: true });
});

app.get('/api/me', auth('user'), (req, res) => {
  const u = db.prepare(`SELECT u.name, u.login_id, u.shift_code, s.city, s.store_name FROM users u JOIN stores s ON s.id = u.store_id
                        WHERE u.id = ? AND u.active = 1`).get(req.auth.uid);
  if (!u) return res.status(401).json({ error: 'Session ended.' });
  res.json({ ...u, today: localDateTime().date });
});

app.get('/api/performance', auth('user'), (req, res) => {
  const reportDate = req.query.date || localDateTime().date;
  if (!validIsoDate(reportDate)) return res.status(400).json({ error: 'Choose a valid report date.' });
  const user = db.prepare('SELECT active FROM users WHERE id = ?').get(req.auth.uid);
  if (!user?.active) return res.status(401).json({ error: 'Session ended.' });
  const report = db.prepare('SELECT report_date, breach_percent, delay_root_cause, submitted_at, updated_at FROM performance_reports WHERE user_id = ? AND report_date = ?')
    .get(req.auth.uid, reportDate);
  res.json({ report: report || null });
});

app.post('/api/performance', auth('user'), (req, res) => {
  const { report_date, breach_percent, delay_root_cause } = req.body || {};
  const rootCause = String(delay_root_cause || '').trim();
  if (!validIsoDate(report_date)) return res.status(400).json({ error: 'Choose a valid report date.' });
  if (typeof breach_percent !== 'number' || !Number.isFinite(breach_percent) || breach_percent < 0 || breach_percent > 100) {
    return res.status(400).json({ error: 'Breach percent must be a number from 0 to 100.' });
  }
  if (breach_percent > 0 && !rootCause) return res.status(400).json({ error: 'Add the delay root-cause analysis when breach is above 0%.' });
  if (rootCause.length > 2000) return res.status(400).json({ error: 'Root-cause analysis must be 2000 characters or less.' });
  const user = db.prepare('SELECT active FROM users WHERE id = ?').get(req.auth.uid);
  if (!user?.active) return res.status(401).json({ error: 'Session ended.' });
  db.prepare(`INSERT INTO performance_reports (user_id, report_date, breach_percent, delay_root_cause)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, report_date) DO UPDATE SET breach_percent=excluded.breach_percent,
    delay_root_cause=excluded.delay_root_cause, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(req.auth.uid, report_date, breach_percent, rootCause);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });

app.post('/api/register', limiter, (req, res) => {
  const { name, loginId, password, store_id, phone, shift_code, descriptor, photo_data } = req.body || {};
  const n = String(name || '').trim();
  const id = String(loginId || '').trim();
  const storeId = Number(store_id);

  if (!n) return res.status(400).json({ error: 'Full name is required.' });
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(id)) return res.status(400).json({ error: 'ID must be 3–32 letters, numbers, dot, dash or underscore.' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!db.prepare('SELECT 1 FROM stores WHERE id = ?').get(storeId)) return res.status(400).json({ error: 'Pick a store before signing up.' });
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter the mobile number in international format, such as +919876543210.' });
  if (getDuplicatePhoneUser(phone)) return res.status(400).json({ error: 'Mobile number is already registered.' });
  if (!validShift(shift_code)) return res.status(400).json({ error: 'Choose a valid shift.' });
  if (descriptor != null && !validDescriptor(descriptor)) return res.status(400).json({ error: 'Face data is invalid. Capture again.' });
  if (!validFacePhoto(photo_data)) return res.status(400).json({ error: 'Captured photo is invalid. Capture again.' });
  if (descriptor && hasDuplicateFace(descriptor)) return res.status(400).json({ error: 'This face is already registered to another account.' });

  try {
    const r = db.prepare('INSERT INTO users (login_id, password_hash, name, store_id, face_descriptor, photo_data, phone, shift_code) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, bcrypt.hashSync(password, 12), n, storeId, descriptor ? JSON.stringify(descriptor) : null, photo_data || null, phone, shift_code);

    const user = db.prepare(`SELECT u.id, u.login_id, u.name, u.phone, u.shift_code, u.face_descriptor IS NOT NULL AS face_enrolled,
      s.city, s.store_name FROM users u JOIN stores s ON s.id = u.store_id WHERE u.id = ?`).get(r.lastInsertRowid);

    issue(res, req, { role: 'user', uid: user.id });
    res.json({ ok: true, user: { id: user.id, name: user.name, login_id: user.login_id, city: user.city, store_name: user.store_name, phone: user.phone, shift_code: user.shift_code, face_enrolled: !!user.face_enrolled } });
  } catch {
    if (getDuplicatePhoneUser(phone)) return res.status(400).json({ error: 'Mobile number is already registered.' });
    res.status(400).json({ error: 'That login ID is already taken.' });
  }
});

// ----- Admin -----
app.post('/api/admin/login', limiter, (req, res) => {
  const { username, password } = req.body || {};
  const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || '').trim());
  const ok = bcrypt.compareSync(String(password || ''), a ? a.password_hash : DUMMY_HASH);
  if (!a || !ok) return res.status(401).json({ error: 'Incorrect username or password.' });
  issue(res, req, { role: 'admin', aid: a.id });
  res.json({ ok: true, username: a.username });
});
app.get('/api/admin/me', auth('admin'), (req, res) => {
  res.json(db.prepare('SELECT username FROM admins WHERE id = ?').get(req.auth.aid));
});
app.post('/api/admin/password', auth('admin'), (req, res) => {
  const { current, next } = req.body || {};
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.auth.aid);
  if (!bcrypt.compareSync(String(current || ''), a.password_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
  if (String(next || '').length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 12), a.id);
  res.json({ ok: true });
});

// Stores
const admin = auth('admin');
function parseStore(b) {
  const city = String(b.city || '').trim(), store_name = String(b.store_name || '').trim();
  const lat = Number(b.lat), lng = Number(b.lng), radius_m = Math.round(Number(b.radius_m));
  if (!city || !store_name) return { error: 'City and store name are required.' };
  if (!validCoord(lat, lng)) return { error: 'Enter valid latitude and longitude.' };
  if (!(radius_m >= 20 && radius_m <= 5000)) return { error: 'Range must be between 20 and 5000 metres.' };
  return { city, store_name, lat, lng, radius_m };
}

app.post('/api/admin/stores/import', admin, (req, res) => {
  const raw = Array.isArray(req.body?.stores) ? req.body.stores : [];
  if (!raw.length) return res.status(400).json({ error: 'Upload a CSV file or an array of stores.' });

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const item of raw) {
    const parsed = parseStore({
      city: item.city,
      store_name: item.store_name || item.name,
      lat: item.lat ?? item.latitude,
      lng: item.lng ?? item.longitude ?? item.long,
      radius_m: item.radius_m ?? item.radius ?? item.range_m ?? 100,
    });

    if (parsed.error) {
      skipped += 1;
      errors.push(parsed.error);
      continue;
    }

    try {
      const existing = db.prepare('SELECT id FROM stores WHERE city = ? AND store_name = ?').get(parsed.city, parsed.store_name);
      db.prepare(`INSERT INTO stores (city, store_name, lat, lng, radius_m)
        VALUES (@city,@store_name,@lat,@lng,@radius_m)
        ON CONFLICT(city, store_name) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, radius_m=excluded.radius_m`).run(parsed);
      imported += 1;
      if (existing) updated += 1;
    } catch (e) {
      skipped += 1;
      errors.push(`Could not import store: ${parsed.city} / ${parsed.store_name}`);
    }
  }

  if (!imported && skipped) return res.status(400).json({ error: errors[0] || 'No valid stores were imported.' });
  res.json({ ok: true, imported, updated, skipped, errors });
});

app.get('/api/stores', (req, res) => {
  res.json(db.prepare('SELECT * FROM stores ORDER BY city, store_name').all());
});
app.get('/api/admin/stores', admin, (req, res) => {
  res.json(db.prepare('SELECT * FROM stores ORDER BY city, store_name').all());
});
app.post('/api/admin/stores', admin, (req, res) => {
  const s = parseStore(req.body || {});
  if (s.error) return res.status(400).json(s);
  try {
    const r = db.prepare('INSERT INTO stores (city, store_name, lat, lng, radius_m) VALUES (@city,@store_name,@lat,@lng,@radius_m)').run(s);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'That store already exists in this city.' }); }
});
app.put('/api/admin/stores/:id', admin, (req, res) => {
  const s = parseStore(req.body || {});
  if (s.error) return res.status(400).json(s);
  try {
    db.prepare('UPDATE stores SET city=@city, store_name=@store_name, lat=@lat, lng=@lng, radius_m=@radius_m WHERE id=@id').run({ ...s, id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: 'That store already exists in this city.' }); }
});
app.delete('/api/admin/stores/:id', admin, (req, res) => {
  try { db.prepare('DELETE FROM stores WHERE id = ?').run(req.params.id); res.json({ ok: true }); }
  catch { res.status(400).json({ error: 'Move or delete this store\'s team leads first.' }); }
});

// Team leads
app.get('/api/admin/users', admin, (req, res) => {
  res.json(db.prepare(`SELECT u.id, u.login_id, u.name, u.store_id, u.active, u.created_at, u.phone, u.shift_code, u.photo_data,
      (u.face_descriptor IS NOT NULL) AS face_enrolled, s.city, s.store_name
      FROM users u JOIN stores s ON s.id = u.store_id ORDER BY s.city, s.store_name, u.name`).all());
});
app.post('/api/admin/users', admin, (req, res) => {
  const { name, loginId, password, store_id, descriptor, photo_data, phone, shift_code } = req.body || {};
  const n = String(name || '').trim(), id = String(loginId || '').trim();
  if (!n) return res.status(400).json({ error: 'Name is required.' });
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(id)) return res.status(400).json({ error: 'ID must be 3–32 letters, numbers, dot, dash or underscore.' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter the mobile number in international format, such as +919876543210.' });
  if (getDuplicatePhoneUser(phone)) return res.status(400).json({ error: 'Mobile number is already registered.' });
  if (!validShift(shift_code)) return res.status(400).json({ error: 'Choose a valid shift.' });
  if (!db.prepare('SELECT 1 FROM stores WHERE id = ?').get(store_id)) return res.status(400).json({ error: 'Pick a store.' });
  if (descriptor != null && !validDescriptor(descriptor)) return res.status(400).json({ error: 'Face data is invalid. Capture again.' });
  if (!validFacePhoto(photo_data)) return res.status(400).json({ error: 'Captured photo is invalid. Capture again.' });
  if (descriptor && hasDuplicateFace(descriptor)) return res.status(400).json({ error: 'This face is already registered to another account.' });
  try {
    const r = db.prepare('INSERT INTO users (login_id, password_hash, name, store_id, face_descriptor, photo_data, phone, shift_code) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, bcrypt.hashSync(password, 12), n, store_id, descriptor ? JSON.stringify(descriptor) : null, photo_data || null, phone, shift_code);
    res.json({ id: r.lastInsertRowid });
  } catch {
    if (getDuplicatePhoneUser(phone)) return res.status(400).json({ error: 'Mobile number is already registered.' });
    res.status(400).json({ error: 'That login ID is already taken.' });
  }
});
app.put('/api/admin/users/:id', admin, (req, res) => {
  const b = req.body || {}, id = req.params.id;
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Team lead not found.' });
  if (b.descriptor !== undefined) {
    if (!validDescriptor(b.descriptor)) return res.status(400).json({ error: 'Face data is invalid. Capture again.' });
    if (hasDuplicateFace(b.descriptor, id)) return res.status(400).json({ error: 'This face is already registered to another account.' });
  }
  if (b.photo_data !== undefined && !validFacePhoto(b.photo_data)) return res.status(400).json({ error: 'Captured photo is invalid. Capture again.' });
  if (b.name !== undefined) db.prepare('UPDATE users SET name=? WHERE id=?').run(String(b.name).trim(), id);
  if (b.store_id !== undefined) {
    if (!db.prepare('SELECT 1 FROM stores WHERE id = ?').get(b.store_id)) return res.status(400).json({ error: 'Pick a store.' });
    db.prepare('UPDATE users SET store_id=? WHERE id=?').run(b.store_id, id);
  }
  if (b.active !== undefined) db.prepare('UPDATE users SET active=? WHERE id=?').run(b.active ? 1 : 0, id);
  if (b.phone !== undefined) {
    if (!validPhone(b.phone)) return res.status(400).json({ error: 'Enter the mobile number in international format, such as +919876543210.' });
    if (getDuplicatePhoneUser(b.phone, id)) return res.status(400).json({ error: 'Mobile number is already registered.' });
    db.prepare('UPDATE users SET phone=? WHERE id=?').run(b.phone, id);
  }
  if (b.shift_code !== undefined) {
    if (!validShift(b.shift_code)) return res.status(400).json({ error: 'Choose a valid shift.' });
    db.prepare('UPDATE users SET shift_code=? WHERE id=?').run(b.shift_code, id);
  }
  if (b.password !== undefined) {
    if (String(b.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(b.password, 12), id);
  }
  if (b.descriptor !== undefined) {
    db.prepare('UPDATE users SET face_descriptor=?, photo_data=? WHERE id=?').run(JSON.stringify(b.descriptor), b.photo_data || null, id);
  } else if (b.photo_data !== undefined) {
    db.prepare('UPDATE users SET photo_data=? WHERE id=?').run(b.photo_data || null, id);
  }
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', admin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Sign-in log
app.get('/api/admin/logs', admin, (req, res) => {
  res.json(db.prepare(`SELECT l.*, u.name, s.city, s.store_name FROM login_logs l
      LEFT JOIN users u ON u.id = l.user_id LEFT JOIN stores s ON s.id = u.store_id
      ORDER BY l.id DESC LIMIT 300`).all());
});

app.get('/api/admin/performance', admin, (req, res) => {
  const { from, to } = req.query;
  if ((from && !validIsoDate(from)) || (to && !validIsoDate(to)) || (from && to && from > to)) {
    return res.status(400).json({ error: 'Enter a valid report date range.' });
  }
  const reports = db.prepare(`SELECT r.report_date, r.breach_percent, r.delay_root_cause, r.submitted_at, r.updated_at,
      u.name, u.login_id, u.shift_code, s.city, s.store_name
    FROM performance_reports r JOIN users u ON u.id = r.user_id JOIN stores s ON s.id = u.store_id
    WHERE (? IS NULL OR r.report_date >= ?) AND (? IS NULL OR r.report_date <= ?)
    ORDER BY r.report_date DESC, s.city, s.store_name, u.name`)
    .all(from || null, from || null, to || null, to || null);
  res.json(reports);
});

app.get('/api/admin/settings', admin, (req, res) => {
  const setting = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get('admin_phone');
  res.json({ admin_phone: setting?.value || '' });
});
app.put('/api/admin/settings', admin, (req, res) => {
  const phone = String(req.body?.admin_phone || '').trim();
  if (phone && !validPhone(phone)) return res.status(400).json({ error: 'Enter the mobile number in international format, such as +919876543210.' });
  if (phone) db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('admin_phone', phone);
  else db.prepare('DELETE FROM admin_settings WHERE key = ?').run('admin_phone');
  res.json({ ok: true });
});

app.get('/api/admin/logs.csv', admin, (req, res) => {
  const { from, to } = req.query;
  const validDate = (value) => {
    if (value === undefined) return true;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) return res.status(400).json({ error: 'Enter a valid date range.' });
  const logs = db.prepare(`SELECT l.*, u.name, u.login_id AS team_login_id, s.city, s.store_name
    FROM login_logs l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN stores s ON s.id = u.store_id
    ORDER BY l.id DESC`).all().filter((row) => {
    const date = localDateTime(new Date(row.ts)).date;
    return (!from || date >= from) && (!to || date <= to);
  });
  const rows = [
    [`Time (${APP_TIME_ZONE})`, 'Team lead', 'Login ID', 'City', 'Store', 'Result', 'Reason', 'Latitude', 'Longitude', 'Distance (m)', 'Face score'],
    ...logs.map((row) => [new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIME_ZONE, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(row.ts)), row.name, row.team_login_id || row.login_id, row.city, row.store_name,
      row.result, row.reason, row.lat, row.lng, row.distance_m, row.face_distance]),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sign-in-logs.csv"');
  res.send('\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
});

let smsConfigWarningLogged = false;
async function sendSms(to, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    if (!smsConfigWarningLogged) {
      console.warn('[alerts] Configure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER to enable SMS alerts.');
      smsConfigWarningLogged = true;
    }
    throw new Error('Twilio is not configured.');
  }
  const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Twilio returned HTTP ${response.status}.`);
}

async function checkShiftAlerts() {
  const { date, time } = localDateTime();
  const teamLeads = db.prepare('SELECT id, name, phone, shift_code FROM users WHERE active = 1 AND shift_code IS NOT NULL').all();
  const adminPhone = db.prepare('SELECT value FROM admin_settings WHERE key = ?').get('admin_phone')?.value;
  for (const teamLead of teamLeads) {
    const deadline = SHIFT_DEADLINES[teamLead.shift_code];
    if (!deadline || time < deadline) continue;
    const lastLogin = db.prepare("SELECT ts FROM login_logs WHERE user_id = ? AND result = 'allowed' ORDER BY id DESC LIMIT 1").get(teamLead.id);
    if (lastLogin) {
      const loginTime = localDateTime(new Date(lastLogin.ts));
      if (loginTime.date === date && loginTime.time <= deadline) continue;
    }
    const recipients = [{ key: 'team_lead', phone: teamLead.phone }, { key: 'admin', phone: adminPhone }];
    for (const recipient of recipients) {
      if (!validPhone(recipient.phone)) continue;
      const claim = db.prepare('INSERT OR IGNORE INTO shift_alerts (user_id, shift_date, recipient) VALUES (?, ?, ?)')
        .run(teamLead.id, date, recipient.key);
      if (!claim.changes) continue;
      const message = `${teamLead.name} (${teamLead.shift_code}) has not signed in by ${deadline} on ${date}.`;
      try {
        await sendSms(recipient.phone, message);
        db.prepare('UPDATE shift_alerts SET sent_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE user_id = ? AND shift_date = ? AND recipient = ?')
          .run(teamLead.id, date, recipient.key);
      } catch (error) {
        db.prepare('DELETE FROM shift_alerts WHERE user_id = ? AND shift_date = ? AND recipient = ?')
          .run(teamLead.id, date, recipient.key);
        if (error.message !== 'Twilio is not configured.') console.error(`[alerts] Could not send ${recipient.key} alert for ${teamLead.login_id}:`, error.message);
      }
    }
  }
}

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}  (admin console: /admin.html)`);
  checkShiftAlerts().catch((error) => console.error('[alerts] Check failed:', error.message));
  setInterval(() => checkShiftAlerts().catch((error) => console.error('[alerts] Check failed:', error.message)), 60_000);
});
