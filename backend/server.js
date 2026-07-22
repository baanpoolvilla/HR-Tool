const express  = require('express');
const https    = require('https');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { Pool } = require('pg');
const app = express();

// ===== Required secrets — no insecure fallback, refuse to start without them =====
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH;
const SESSION_SECRET      = process.env.SESSION_SECRET;
const DEVICE_API_KEY      = process.env.DEVICE_API_KEY || null;
const DEVICE_KEY_REQUIRED = process.env.DEVICE_KEY_REQUIRED === 'true';

if (!ADMIN_PASSWORD_HASH || !SESSION_SECRET) {
  console.error('❌ Missing required env vars: ADMIN_PASSWORD_HASH and SESSION_SECRET must both be set. Refusing to start.');
  process.exit(1);
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 ชม.

function buildFlexCard(name, hhmm, device_id, check_type, is_late) {
  const isOut      = check_type === 'OUT';
  const color      = isOut ? '#1565C0' : (is_late ? '#C62828' : '#2E7D32');
  const headerText = isOut ? '🔴  ออกงาน' : (is_late ? '⚠️  เข้างาน  (สาย!)' : '✅  เข้างาน');
  return {
    type: 'bubble', size: 'kilo',
    header: {
      type: 'box', layout: 'vertical',
      backgroundColor: color, paddingAll: '14px',
      contents: [{ type: 'text', text: headerText, color: '#FFFFFF', size: 'lg', weight: 'bold' }]
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '14px',
      contents: [
        { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
            { type: 'text', text: '👤', size: 'sm', flex: 0 },
            { type: 'text', text: name, size: 'sm', weight: 'bold', flex: 1 }
        ]},
        { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
            { type: 'text', text: '🕐', size: 'sm', flex: 0 },
            { type: 'text', text: hhmm, size: 'sm', weight: 'bold', flex: 1 }
        ]},
        { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
            { type: 'text', text: '📍', size: 'sm', flex: 0 },
            { type: 'text', text: device_id, size: 'sm', color: '#888888', flex: 1 }
        ]},
      ]
    }
  };
}

async function sendLineFlex(token, to, altText, flexContent) {
  if (!token || !to) return;
  const body = JSON.stringify({ to, messages: [{ type: 'flex', altText, contents: flexContent }] });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.line.me',
      path:     '/v2/bot/message/push',
      method:   'POST',
      headers: {
        'Authorization':  'Bearer ' + token,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

// express.json ต้องเก็บ rawBody ไว้ด้วย — ใช้ตรวจ LINE webhook signature
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = [/\.vercel\.app$/, /localhost/, /poolvillapattayaparty\.com$/];
  if (origin && allowed.some(r => r.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const pool = new Pool({
  host: process.env.DB_HOST || '192.168.0.124',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'HR',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '123456',
});

let enrollQueue = null;
let enrollPickedUp = false;
let sensorClearPending = false;

// Bangkok UTC+7 offset helper
function toTH(d) { return new Date(new Date(d).getTime() + 7 * 3600 * 1000); }

// ===== Audit log =====
async function logAudit(action, target, detail, req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
  try {
    await pool.query(
      'INSERT INTO audit_log (action, target, detail, ip) VALUES ($1,$2,$3,$4)',
      [action, target ? String(target) : null, detail ? JSON.stringify(detail) : null, ip]
    );
  } catch (e) {
    console.error('audit log insert failed:', e.message);
  }
}

// ===== Admin session (stateless signed cookie) =====
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!verifySession(getCookie(req, 'admin_session'))) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ===== Device key (soft-enforced until DEVICE_KEY_REQUIRED=true) =====
function requireDeviceKey(req, res, next) {
  if (!DEVICE_API_KEY) return next(); // ยังไม่ได้ตั้งค่า → ไม่บังคับ
  const key = req.headers['x-device-key'];
  if (key === DEVICE_API_KEY) return next();
  if (DEVICE_KEY_REQUIRED) return res.status(401).json({ error: 'unauthorized' });
  console.warn(`⚠️  ${req.path} called without a valid X-Device-Key (soft phase — allowed through)`);
  logAudit('device_key_missing', req.path, {}, req);
  next();
}

// ===== Login rate limit (in-memory, per-IP) =====
const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + 15 * 60 * 1000 };
    loginAttempts.set(ip, rec);
  }
  if (rec.count >= 5) return res.status(429).json({ error: 'too_many_attempts' });
  req._loginIp = ip;
  req._loginRec = rec;
  next();
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fp_users (
      id          SERIAL PRIMARY KEY,
      finger_id   INTEGER UNIQUE NOT NULL,
      name        VARCHAR(100) NOT NULL,
      employee_id VARCHAR(20),
      department  VARCHAR(50),
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS confidence INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS enrolled BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS fp_pattern TEXT;`);
  await pool.query(`UPDATE fp_users SET enrolled = TRUE WHERE confidence > 0;`);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS base_salary DECIMAL(10,2) DEFAULT 0;`);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS attendance_bonus DECIMAL(10,2) DEFAULT 0;`);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS work_start_time VARCHAR(8) DEFAULT '08:00';`);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS late_grace_minutes INTEGER DEFAULT 15;`);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS checkout_start_time VARCHAR(8) DEFAULT '17:00';`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_logs (
      id         SERIAL PRIMARY KEY,
      device_id  VARCHAR(50),
      finger_id  INTEGER,
      name       VARCHAR(100),
      check_time TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS check_type VARCHAR(3) DEFAULT 'IN';`);
  await pool.query(`ALTER TABLE attendance_logs ADD COLUMN IF NOT EXISTS is_late BOOLEAN DEFAULT FALSE;`);
  // กันสแกนซ้ำแข่งกัน (race) สร้าง IN หรือ OUT ซ้ำในวันเดียวกัน
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_logs_daily_unique
    ON attendance_logs (finger_id, check_type, ((check_time + interval '7 hours')::date));
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key   VARCHAR(50) PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      label VARCHAR(100) DEFAULT ''
    );
  `);
  await pool.query(`
    INSERT INTO system_settings (key, value, label) VALUES
      ('default_work_start', '08:00', 'เวลาเข้างานค่าเริ่มต้น'),
      ('default_checkout',   '17:00', 'เวลา OUT ค่าเริ่มต้น'),
      ('default_grace',      '15',    'ผ่อนผัน (นาที)'),
      ('default_salary',     '0',     'ฐานเดือนค่าเริ่มต้น'),
      ('default_bonus',      '0',     'เบี้ยขยันค่าเริ่มต้น')
    ON CONFLICT (key) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO system_settings (key, value, label) VALUES
      ('line_channel_token',  '', 'LINE Channel Access Token'),
      ('line_channel_secret', '', 'LINE Channel Secret'),
      ('line_group_id',       '', 'LINE Group ID')
    ON CONFLICT (key) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monthly_commissions (
      id                SERIAL PRIMARY KEY,
      finger_id         INTEGER NOT NULL,
      year              INTEGER NOT NULL,
      month             INTEGER NOT NULL,
      commission_amount DECIMAL(10,2) DEFAULT 0,
      notes             TEXT DEFAULT '',
      created_at        TIMESTAMP DEFAULT NOW(),
      UNIQUE(finger_id, year, month)
    );
  `);

  // ===== Phase 2: กะ/ตารางเวร + วันหยุด =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shifts (
      id            SERIAL PRIMARY KEY,
      name          VARCHAR(60) NOT NULL,
      start_time    VARCHAR(8)  NOT NULL DEFAULT '08:00',
      end_time      VARCHAR(8)  NOT NULL DEFAULT '17:00',
      break_minutes INTEGER     NOT NULL DEFAULT 0,
      active        BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS shift_id INTEGER;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holidays (
      id           SERIAL PRIMARY KEY,
      holiday_date DATE UNIQUE NOT NULL,
      name         VARCHAR(100) NOT NULL DEFAULT '',
      is_paid      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMP DEFAULT NOW()
    );
  `);

  // ===== Phase 3: ลา + OT =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_types (
      id                  SERIAL PRIMARY KEY,
      name                VARCHAR(60) UNIQUE NOT NULL,
      is_paid             BOOLEAN NOT NULL DEFAULT TRUE,
      quota_days_per_year INTEGER NOT NULL DEFAULT 0,
      active              BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);
  await pool.query(`
    INSERT INTO leave_types (name, is_paid, quota_days_per_year) VALUES
      ('ลาป่วย', TRUE, 30), ('ลากิจ', TRUE, 3), ('ลาพักร้อน', TRUE, 6), ('ลาไม่รับค่าจ้าง', FALSE, 0)
    ON CONFLICT (name) DO NOTHING;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id         SERIAL PRIMARY KEY,
      finger_id  INTEGER NOT NULL,
      type_id    INTEGER NOT NULL,
      start_date DATE NOT NULL,
      end_date   DATE NOT NULL,
      days       NUMERIC(5,1) NOT NULL DEFAULT 1,
      reason     TEXT DEFAULT '',
      status     VARCHAR(10) NOT NULL DEFAULT 'APPROVED',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS overtime_records (
      id         SERIAL PRIMARY KEY,
      finger_id  INTEGER NOT NULL,
      work_date  DATE NOT NULL,
      minutes    INTEGER NOT NULL DEFAULT 0,
      multiplier NUMERIC(3,1) NOT NULL DEFAULT 1.5,
      reason     TEXT DEFAULT '',
      status     VARCHAR(10) NOT NULL DEFAULT 'APPROVED',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // ===== Phase 4: แก้เวลา + timesheet =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_corrections (
      id           SERIAL PRIMARY KEY,
      finger_id    INTEGER NOT NULL,
      work_date    DATE NOT NULL,
      type         VARCHAR(3) NOT NULL,
      correct_time VARCHAR(8) NOT NULL,
      reason       TEXT DEFAULT '',
      created_at   TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS timesheets (
      id         SERIAL PRIMARY KEY,
      finger_id  INTEGER NOT NULL,
      year       INTEGER NOT NULL,
      month      INTEGER NOT NULL,
      snapshot   JSONB,
      status     VARCHAR(10) NOT NULL DEFAULT 'CLOSED',
      closed_at  TIMESTAMP DEFAULT NOW(),
      UNIQUE(finger_id, year, month)
    );
  `);

  // ===== Phase 5: payroll เต็ม =====
  await pool.query(`ALTER TABLE fp_users ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN DEFAULT FALSE;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monthly_adjustments (
      id         SERIAL PRIMARY KEY,
      finger_id  INTEGER NOT NULL,
      year       INTEGER NOT NULL,
      month      INTEGER NOT NULL,
      allowance  NUMERIC(10,2) DEFAULT 0,
      deduction  NUMERIC(10,2) DEFAULT 0,
      note       TEXT DEFAULT '',
      UNIQUE(finger_id, year, month)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id         SERIAL PRIMARY KEY,
      actor      VARCHAR(50) DEFAULT 'admin',
      action     VARCHAR(50) NOT NULL,
      target     VARCHAR(100),
      detail     JSONB,
      ip         VARCHAR(45),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('✅ DB ready');
}

// ===== ADMIN AUTH =====
app.post('/api/admin/login', loginRateLimit, async (req, res) => {
  const { password } = req.body || {};
  const ok = typeof password === 'string' && password.length > 0 && await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!ok) {
    req._loginRec.count++;
    await logAudit('admin_login_failed', null, {}, req);
    return res.status(401).json({ error: 'invalid_password' });
  }
  loginAttempts.delete(req._loginIp);
  const token = signSession();
  res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  await logAudit('admin_login', null, {}, req);
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: verifySession(getCookie(req, 'admin_session')) });
});

app.get('/api/audit-log', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
  res.json(result.rows);
});

// ESP32 — บันทึกเวลา (time-based IN/OUT)
app.post('/api/attendance', requireDeviceKey, async (req, res) => {
  const { device_id, finger_id } = req.body;

  // LEFT JOIN กะ (ถ้าผูกไว้) — ใช้เวลากะแทน work_start_time/checkout ต่อคน
  const user    = await pool.query(
    `SELECT u.*, s.start_time AS shift_start, s.end_time AS shift_end
     FROM fp_users u
     LEFT JOIN shifts s ON u.shift_id = s.id AND s.active = TRUE
     WHERE u.finger_id = $1`,
    [finger_id]
  );
  const userRow = user.rows[0];
  const name    = userRow ? userRow.name : 'Unknown';

  // เวลาปัจจุบัน Bangkok (UTC+7)
  const bangkokNow = toTH(new Date());
  const nowMin     = bangkokNow.getUTCHours() * 60 + bangkokNow.getUTCMinutes();
  const todayDate  = bangkokNow.toISOString().split('T')[0];

  // เวลาเข้างาน/ออกงาน: กะ > ค่าต่อคน > default + ผ่อนผัน
  const [wsh, wsm]   = (userRow?.shift_start || userRow?.work_start_time    || '08:00').split(':').map(Number);
  const [coh, com]   = (userRow?.shift_end   || userRow?.checkout_start_time || '17:00').split(':').map(Number);
  const workStartMin  = wsh * 60 + (wsm || 0);
  const grace         = parseInt(userRow?.late_grace_minutes || 15);
  const lateAfterMin  = workStartMin + grace;
  const checkoutMin   = coh * 60 + (com || 0);

  // ดู logs วันนี้ (Bangkok date)
  const logsRes = await pool.query(
    `SELECT check_type, check_time FROM attendance_logs
     WHERE finger_id = $1
       AND (check_time + INTERVAL '7 hours')::date = $2::date
     ORDER BY check_time ASC`,
    [finger_id, todayDate]
  );
  const todayIN  = logsRes.rows.find(r => r.check_type === 'IN');
  const todayOUT = logsRes.rows.find(r => r.check_type === 'OUT');

  let check_type, is_late = false;

  if (nowMin < checkoutMin) {
    // === IN zone (ก่อนเวลา OUT) ===
    if (todayIN) {
      const th   = toTH(todayIN.check_time);
      const hhmm = `${String(th.getUTCHours()).padStart(2,'0')}:${String(th.getUTCMinutes()).padStart(2,'0')}`;
      return res.json({ success: false, status: 'already_in', name, check_time_hhmm: hhmm });
    }
    check_type = 'IN';
    is_late    = nowMin > lateAfterMin;

  } else {
    // === OUT zone (หลังเวลา OUT) ===
    if (todayOUT) {
      return res.json({ success: false, status: 'already_out', name });
    }
    if (todayIN) {
      check_type = 'OUT';
    } else {
      // ไม่มี IN เลย (มาสายมาก หรือข้ามเที่ยงคืน) → อนุญาต IN
      check_type = 'IN';
      is_late    = true;
    }
  }

  try {
    await pool.query(
      'INSERT INTO attendance_logs (device_id, finger_id, name, check_type, is_late) VALUES ($1,$2,$3,$4,$5)',
      [device_id, finger_id, name, check_type, is_late]
    );
  } catch (err) {
    if (err.code === '23505') {
      // แข่งกันสแกนซ้ำ — อีก request หนึ่งเพิ่งบันทึกไปก่อนเสี้ยววินาที ให้ตอบสถานะปัจจุบันแทน error
      const retry = await pool.query(
        `SELECT check_type, check_time FROM attendance_logs
         WHERE finger_id = $1 AND (check_time + INTERVAL '7 hours')::date = $2::date
         ORDER BY check_time ASC`,
        [finger_id, todayDate]
      );
      const dupIN  = retry.rows.find(r => r.check_type === 'IN');
      const dupOUT = retry.rows.find(r => r.check_type === 'OUT');
      if (check_type === 'IN' && dupIN) {
        const th   = toTH(dupIN.check_time);
        const hhmm = `${String(th.getUTCHours()).padStart(2,'0')}:${String(th.getUTCMinutes()).padStart(2,'0')}`;
        return res.json({ success: false, status: 'already_in', name, check_time_hhmm: hhmm });
      }
      if (check_type === 'OUT' && dupOUT) {
        return res.json({ success: false, status: 'already_out', name });
      }
    }
    throw err;
  }

  // LINE Messaging API
  const [tokenRow, groupRow] = await Promise.all([
    pool.query(`SELECT value FROM system_settings WHERE key='line_channel_token'`),
    pool.query(`SELECT value FROM system_settings WHERE key='line_group_id'`),
  ]);
  const lineToken = tokenRow.rows[0]?.value;
  const lineUser  = groupRow.rows[0]?.value;
  if (lineToken && lineUser) {
    const th      = toTH(new Date());
    const hhmm    = `${String(th.getUTCHours()).padStart(2,'0')}:${String(th.getUTCMinutes()).padStart(2,'0')}`;
    const altText = check_type === 'OUT' ? `🔴 ออกงาน - ${name}` : (is_late ? `⚠️ เข้างาน สาย - ${name}` : `✅ เข้างาน - ${name}`);
    const flex    = buildFlexCard(name, hhmm, device_id, check_type, is_late);
    sendLineFlex(lineToken, lineUser, altText, flex).catch(() => {});
  }

  res.json({ success: true, status: 'ok', name, finger_id, check_type, is_late });
});

// WEB — Next ID (ไม่ได้ถูกเรียกโดย firmware ปัจจุบัน — คุ้มครองแบบ admin)
app.get('/api/next-finger-id', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT COALESCE(MAX(finger_id), 0) + 1 as next_id FROM fp_users');
  res.json({ next_id: result.rows[0].next_id });
});

// ESP32 — poll enroll (clears queue)
app.get('/api/enroll-pending', requireDeviceKey, (req, res) => {
  if (enrollQueue !== null) {
    const id = enrollQueue;
    enrollQueue = null;
    enrollPickedUp = true;
    res.json({ pending: true, finger_id: id });
  } else {
    res.json({ pending: false });
  }
});

// ESP32 — enroll complete
app.post('/api/enroll-complete', requireDeviceKey, async (req, res) => {
  const { finger_id, confidence, fp_pattern } = req.body;
  await pool.query(
    'UPDATE fp_users SET confidence=$2, fp_pattern=$3, enrolled=TRUE WHERE finger_id=$1',
    [finger_id, confidence || 50, fp_pattern || null]
  );
  enrollPickedUp = false;
  res.json({ success: true });
});

// WEB — request enroll
app.post('/api/enroll-request', requireAdmin, async (req, res) => {
  const { finger_id } = req.body;
  enrollQueue = finger_id;
  enrollPickedUp = false;
  await logAudit('enroll_request', finger_id, {}, req);
  res.json({ success: true, finger_id });
});

// WEB — watch enroll (safe, no queue change)
app.get('/api/enroll-watch', requireAdmin, (req, res) => {
  res.json({ queued: enrollQueue !== null, picked_up: enrollPickedUp });
});

// ESP32 — poll sensor clear
app.get('/api/sensor-clear-pending', requireDeviceKey, (req, res) => {
  if (sensorClearPending) {
    sensorClearPending = false;
    res.json({ pending: true });
  } else {
    res.json({ pending: false });
  }
});

// WEB — request sensor clear
app.post('/api/sensor-clear-request', requireAdmin, async (req, res) => {
  sensorClearPending = true;
  await logAudit('sensor_clear_request', null, {}, req);
  res.json({ success: true });
});

// ADMIN — reset all data
app.delete('/api/admin/reset', requireAdmin, async (req, res) => {
  await pool.query('TRUNCATE attendance_logs, fp_users, monthly_commissions RESTART IDENTITY');
  await logAudit('admin_reset', null, {}, req);
  res.json({ success: true });
});

// WEB — list users
app.get('/api/users', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM fp_users ORDER BY finger_id');
  res.json(result.rows);
});

// WEB — upsert user (with payroll settings)
app.post('/api/users', requireAdmin, async (req, res) => {
  const { finger_id, name, employee_id, department,
          base_salary, attendance_bonus, work_start_time, late_grace_minutes,
          checkout_start_time, shift_id, sso_enabled } = req.body;
  await pool.query(`
    INSERT INTO fp_users
      (finger_id, name, employee_id, department, base_salary, attendance_bonus,
       work_start_time, late_grace_minutes, checkout_start_time, shift_id, sso_enabled)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (finger_id) DO UPDATE SET
      name=$2, employee_id=$3, department=$4,
      base_salary=$5, attendance_bonus=$6,
      work_start_time=$7, late_grace_minutes=$8, checkout_start_time=$9,
      shift_id=$10, sso_enabled=$11
  `, [finger_id, name, employee_id, department,
      base_salary || 0, attendance_bonus || 0,
      work_start_time || '08:00', late_grace_minutes || 15,
      checkout_start_time || '17:00', shift_id ? parseInt(shift_id) : null,
      sso_enabled === true || sso_enabled === 'true']);
  await logAudit('user_upsert', finger_id, { name, employee_id, department }, req);
  res.json({ success: true });
});

// WEB — delete user
app.delete('/api/users/:finger_id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM fp_users WHERE finger_id = $1', [req.params.finger_id]);
  await logAudit('user_delete', req.params.finger_id, {}, req);
  res.json({ success: true });
});

// ===== Phase 2: Shifts =====
app.get('/api/shifts', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM shifts ORDER BY start_time, name');
  res.json(result.rows);
});

app.post('/api/shifts', requireAdmin, async (req, res) => {
  const { id, name, start_time, end_time, break_minutes, active } = req.body;
  if (!name || !start_time || !end_time) return res.status(400).json({ error: 'missing_fields' });
  if (id) {
    await pool.query(
      `UPDATE shifts SET name=$2, start_time=$3, end_time=$4, break_minutes=$5, active=$6 WHERE id=$1`,
      [id, name, start_time, end_time, parseInt(break_minutes) || 0, active !== false]
    );
  } else {
    await pool.query(
      `INSERT INTO shifts (name, start_time, end_time, break_minutes, active) VALUES ($1,$2,$3,$4,$5)`,
      [name, start_time, end_time, parseInt(break_minutes) || 0, active !== false]
    );
  }
  await logAudit('shift_upsert', name, { id, start_time, end_time }, req);
  res.json({ success: true });
});

app.delete('/api/shifts/:id', requireAdmin, async (req, res) => {
  // ปลดกะออกจากพนักงานที่ผูกไว้ก่อน แล้วจึงลบ
  await pool.query('UPDATE fp_users SET shift_id = NULL WHERE shift_id = $1', [req.params.id]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [req.params.id]);
  await logAudit('shift_delete', req.params.id, {}, req);
  res.json({ success: true });
});

// ===== Phase 2: Holidays =====
app.get('/api/holidays', requireAdmin, async (req, res) => {
  const year = parseInt(req.query.year);
  const cols = `id, to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name, is_paid`;
  const result = year
    ? await pool.query(`SELECT ${cols} FROM holidays WHERE EXTRACT(YEAR FROM holiday_date) = $1 ORDER BY holiday_date`, [year])
    : await pool.query(`SELECT ${cols} FROM holidays ORDER BY holiday_date`);
  res.json(result.rows);
});

app.post('/api/holidays', requireAdmin, async (req, res) => {
  const { holiday_date, name, is_paid } = req.body;
  if (!holiday_date) return res.status(400).json({ error: 'missing_date' });
  await pool.query(
    `INSERT INTO holidays (holiday_date, name, is_paid) VALUES ($1,$2,$3)
     ON CONFLICT (holiday_date) DO UPDATE SET name=$2, is_paid=$3`,
    [holiday_date, name || '', is_paid !== false]
  );
  await logAudit('holiday_upsert', holiday_date, { name }, req);
  res.json({ success: true });
});

app.delete('/api/holidays/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM holidays WHERE id = $1', [req.params.id]);
  await logAudit('holiday_delete', req.params.id, {}, req);
  res.json({ success: true });
});

// ===== Phase 3: Leave types =====
app.get('/api/leave-types', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM leave_types ORDER BY id');
  res.json(r.rows);
});
app.post('/api/leave-types', requireAdmin, async (req, res) => {
  const { id, name, is_paid, quota_days_per_year, active } = req.body;
  if (!name) return res.status(400).json({ error: 'missing_name' });
  if (id) {
    await pool.query('UPDATE leave_types SET name=$2, is_paid=$3, quota_days_per_year=$4, active=$5 WHERE id=$1',
      [id, name, is_paid !== false, parseInt(quota_days_per_year) || 0, active !== false]);
  } else {
    await pool.query('INSERT INTO leave_types (name, is_paid, quota_days_per_year) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET is_paid=$2, quota_days_per_year=$3',
      [name, is_paid !== false, parseInt(quota_days_per_year) || 0]);
  }
  await logAudit('leave_type_upsert', name, {}, req);
  res.json({ success: true });
});
app.delete('/api/leave-types/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM leave_types WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ===== Phase 3: Leave requests =====
app.get('/api/leave-requests', requireAdmin, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const r = await pool.query(
    `SELECT lr.id, lr.finger_id, u.name, lr.type_id, lt.name AS type_name, lt.is_paid,
            to_char(lr.start_date,'YYYY-MM-DD') AS start_date,
            to_char(lr.end_date,'YYYY-MM-DD')   AS end_date,
            lr.days, lr.reason, lr.status
     FROM leave_requests lr
     LEFT JOIN fp_users u   ON u.finger_id = lr.finger_id
     LEFT JOIN leave_types lt ON lt.id = lr.type_id
     WHERE EXTRACT(YEAR FROM lr.start_date) = $1
     ORDER BY lr.start_date DESC`, [year]);
  res.json(r.rows);
});
app.post('/api/leave-requests', requireAdmin, async (req, res) => {
  const { finger_id, type_id, start_date, end_date, reason, status } = req.body;
  if (!finger_id || !type_id || !start_date || !end_date) return res.status(400).json({ error: 'missing_fields' });
  // นับจำนวนวัน (รวมวันเริ่ม-สิ้นสุด)
  const days = Math.max(1, Math.round((new Date(end_date) - new Date(start_date)) / 86400000) + 1);
  await pool.query(
    `INSERT INTO leave_requests (finger_id, type_id, start_date, end_date, days, reason, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [finger_id, type_id, start_date, end_date, days, reason || '', status || 'APPROVED']);
  await logAudit('leave_create', finger_id, { type_id, start_date, end_date, days }, req);
  res.json({ success: true, days });
});
app.post('/api/leave-requests/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  await pool.query('UPDATE leave_requests SET status=$2 WHERE id=$1', [req.params.id, status]);
  await logAudit('leave_status', req.params.id, { status }, req);
  res.json({ success: true });
});
app.delete('/api/leave-requests/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM leave_requests WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ===== Phase 3: Leave balance (quota - approved days) per employee/type/year =====
app.get('/api/leave-balance', requireAdmin, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const [usersR, typesR, usedR] = await Promise.all([
    pool.query('SELECT finger_id, name FROM fp_users ORDER BY finger_id'),
    pool.query('SELECT * FROM leave_types WHERE active = TRUE ORDER BY id'),
    pool.query(
      `SELECT finger_id, type_id, COALESCE(SUM(days),0) AS used
       FROM leave_requests
       WHERE status = 'APPROVED' AND EXTRACT(YEAR FROM start_date) = $1
       GROUP BY finger_id, type_id`, [year]),
  ]);
  const usedMap = {};
  usedR.rows.forEach(u => { usedMap[`${u.finger_id}_${u.type_id}`] = parseFloat(u.used); });
  const balance = usersR.rows.map(u => ({
    finger_id: u.finger_id, name: u.name,
    types: typesR.rows.map(t => {
      const used = usedMap[`${u.finger_id}_${t.id}`] || 0;
      return { type_id: t.id, type_name: t.name, is_paid: t.is_paid,
               quota: t.quota_days_per_year, used, remaining: t.quota_days_per_year - used };
    })
  }));
  res.json({ year, types: typesR.rows, balance });
});

// ===== Phase 3: Overtime =====
app.get('/api/overtime', requireAdmin, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month);
  const params = [year];
  let sql = `SELECT ot.id, ot.finger_id, u.name, to_char(ot.work_date,'YYYY-MM-DD') AS work_date,
                    ot.minutes, ot.multiplier, ot.reason, ot.status
             FROM overtime_records ot LEFT JOIN fp_users u ON u.finger_id = ot.finger_id
             WHERE EXTRACT(YEAR FROM ot.work_date) = $1`;
  if (month) { sql += ` AND EXTRACT(MONTH FROM ot.work_date) = $2`; params.push(month); }
  sql += ` ORDER BY ot.work_date DESC`;
  const r = await pool.query(sql, params);
  res.json(r.rows);
});
app.post('/api/overtime', requireAdmin, async (req, res) => {
  const { finger_id, work_date, minutes, multiplier, reason, status } = req.body;
  if (!finger_id || !work_date || !minutes) return res.status(400).json({ error: 'missing_fields' });
  await pool.query(
    `INSERT INTO overtime_records (finger_id, work_date, minutes, multiplier, reason, status)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [finger_id, work_date, parseInt(minutes), parseFloat(multiplier) || 1.5, reason || '', status || 'APPROVED']);
  await logAudit('overtime_create', finger_id, { work_date, minutes }, req);
  res.json({ success: true });
});
app.post('/api/overtime/:id/status', requireAdmin, async (req, res) => {
  await pool.query('UPDATE overtime_records SET status=$2 WHERE id=$1', [req.params.id, req.body.status]);
  res.json({ success: true });
});
app.delete('/api/overtime/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM overtime_records WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ===== Phase 4: Attendance corrections =====
app.get('/api/corrections', requireAdmin, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month);
  const params = [year];
  let sql = `SELECT c.id, c.finger_id, u.name, to_char(c.work_date,'YYYY-MM-DD') AS work_date,
                    c.type, c.correct_time, c.reason
             FROM attendance_corrections c LEFT JOIN fp_users u ON u.finger_id = c.finger_id
             WHERE EXTRACT(YEAR FROM c.work_date) = $1`;
  if (month) { sql += ` AND EXTRACT(MONTH FROM c.work_date) = $2`; params.push(month); }
  sql += ` ORDER BY c.work_date DESC`;
  const r = await pool.query(sql, params);
  res.json(r.rows);
});
app.post('/api/corrections', requireAdmin, async (req, res) => {
  const { finger_id, work_date, type, correct_time, reason } = req.body;
  if (!finger_id || !work_date || !type || !correct_time) return res.status(400).json({ error: 'missing_fields' });
  await pool.query(
    `INSERT INTO attendance_corrections (finger_id, work_date, type, correct_time, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [finger_id, work_date, type, correct_time, reason || '']);
  await logAudit('correction_add', finger_id, { work_date, type, correct_time }, req);
  res.json({ success: true });
});
app.delete('/api/corrections/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM attendance_corrections WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ===== Phase 4: Exceptions inbox (คำนวณสด — วันที่มี IN ไม่มี OUT ฯลฯ) =====
app.get('/api/exceptions', requireAdmin, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  const [logsRes, corrRes, usersRes] = await Promise.all([
    pool.query(
      `SELECT finger_id, name, check_type, check_time FROM attendance_logs
       WHERE EXTRACT(YEAR FROM check_time)=$1 AND EXTRACT(MONTH FROM check_time)=$2
       ORDER BY check_time ASC`, [year, month]),
    pool.query(
      `SELECT finger_id, to_char(work_date,'YYYY-MM-DD') AS d, type FROM attendance_corrections
       WHERE EXTRACT(YEAR FROM work_date)=$1 AND EXTRACT(MONTH FROM work_date)=$2`, [year, month]),
    pool.query('SELECT finger_id, name FROM fp_users'),
  ]);

  const nameMap = {}; usersRes.rows.forEach(u => nameMap[u.finger_id] = u.name);
  // key finger_id|date -> {in, out}
  const day = {};
  logsRes.rows.forEach(l => {
    const th = toTH(l.check_time); const d = th.toISOString().split('T')[0];
    const k = `${l.finger_id}|${d}`;
    if (!day[k]) day[k] = { finger_id: l.finger_id, date: d, in: 0, out: 0 };
    if (l.check_type === 'IN') day[k].in++; else day[k].out++;
  });
  corrRes.rows.forEach(c => {
    const k = `${c.finger_id}|${c.d}`;
    if (!day[k]) day[k] = { finger_id: c.finger_id, date: c.d, in: 0, out: 0 };
    if (c.type === 'IN') day[k].in++; else day[k].out++;
  });

  const today = toTH(new Date()).toISOString().split('T')[0];
  const exceptions = [];
  Object.values(day).forEach(v => {
    if (v.date >= today) return; // ยังไม่จบวัน ไม่นับ
    if (v.in > 0 && v.out === 0)  exceptions.push({ ...v, code: 'MISSING_OUT', name: nameMap[v.finger_id] });
    else if (v.in === 0 && v.out > 0) exceptions.push({ ...v, code: 'MISSING_IN', name: nameMap[v.finger_id] });
  });
  exceptions.sort((a, b) => b.date.localeCompare(a.date));
  res.json({ year, month, exceptions });
});

// ===== Phase 5: Monthly adjustments (เบิก/หัก รายเดือน) =====
app.post('/api/adjustment', requireAdmin, async (req, res) => {
  const { finger_id, year, month, allowance, deduction, note } = req.body;
  await pool.query(
    `INSERT INTO monthly_adjustments (finger_id, year, month, allowance, deduction, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (finger_id, year, month) DO UPDATE SET allowance=$4, deduction=$5, note=$6`,
    [finger_id, year, month, allowance || 0, deduction || 0, note || '']);
  await logAudit('adjustment_upsert', finger_id, { year, month, allowance, deduction }, req);
  res.json({ success: true });
});

// ===== Phase 4: Timesheets (ปิดงวด snapshot) =====
app.get('/api/timesheets', requireAdmin, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
  const r = await pool.query(
    `SELECT t.finger_id, u.name, t.status, t.closed_at
     FROM timesheets t LEFT JOIN fp_users u ON u.finger_id = t.finger_id
     WHERE t.year=$1 AND t.month=$2 ORDER BY t.finger_id`, [year, month]);
  res.json({ year, month, closed: r.rows.length > 0, rows: r.rows });
});
app.post('/api/timesheets/close', requireAdmin, async (req, res) => {
  const { year, month, report } = req.body; // report = array snapshot จาก frontend
  if (!year || !month || !Array.isArray(report)) return res.status(400).json({ error: 'missing_fields' });
  for (const row of report) {
    await pool.query(
      `INSERT INTO timesheets (finger_id, year, month, snapshot, status, closed_at)
       VALUES ($1,$2,$3,$4,'CLOSED',NOW())
       ON CONFLICT (finger_id, year, month) DO UPDATE SET snapshot=$4, status='CLOSED', closed_at=NOW()`,
      [row.finger_id, year, month, JSON.stringify(row)]);
  }
  await logAudit('timesheet_close', `${year}-${month}`, { count: report.length }, req);
  res.json({ success: true });
});
app.post('/api/timesheets/reopen', requireAdmin, async (req, res) => {
  const { year, month } = req.body;
  await pool.query('DELETE FROM timesheets WHERE year=$1 AND month=$2', [year, month]);
  await logAudit('timesheet_reopen', `${year}-${month}`, {}, req);
  res.json({ success: true });
});

// WEB — logs (include check_type)
app.get('/api/logs', requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT id, device_id, finger_id, name, check_time, check_type, is_late
    FROM attendance_logs ORDER BY check_time DESC LIMIT 100
  `);
  res.json(result.rows);
});

// WEB — dashboard summary (วันนี้ + รายการล่าสุด)
app.get('/api/dashboard', requireAdmin, async (req, res) => {
  const bangkokNow = toTH(new Date());
  const todayDate  = bangkokNow.toISOString().split('T')[0];

  const [todayLogsRes, usersRes, logsRes] = await Promise.all([
    pool.query(
      `SELECT device_id, finger_id, name, check_time, check_type, is_late
       FROM attendance_logs
       WHERE (check_time + INTERVAL '7 hours')::date = $1::date
       ORDER BY check_time DESC`,
      [todayDate]
    ),
    pool.query('SELECT COUNT(*) AS c FROM fp_users'),
    pool.query('SELECT COUNT(*) AS c FROM attendance_logs'),
  ]);

  const rows       = todayLogsRes.rows;
  const registered = parseInt(usersRes.rows[0].c);

  // คนที่เข้างานแล้ววันนี้ (IN, ไม่นับ Unknown) — เก็บ IN ล่าสุดต่อคน
  const presentMap = new Map();
  for (const r of rows) {
    if (r.check_type === 'IN' && r.name !== 'Unknown' && !presentMap.has(r.finger_id)) {
      presentMap.set(r.finger_id, r);
    }
  }
  const lateIds = new Set(
    rows.filter(r => r.check_type === 'IN' && r.is_late && r.name !== 'Unknown').map(r => r.finger_id)
  );

  res.json({
    today_date:    todayDate,
    present_today: presentMap.size,
    late_today:    lateIds.size,
    absent_today:  Math.max(0, registered - presentMap.size),
    registered,
    total_logs:    parseInt(logsRes.rows[0].c),
    present_list:  Array.from(presentMap.values()).map(r => ({
      finger_id: r.finger_id, name: r.name, check_time: r.check_time, is_late: r.is_late
    })),
    recent_scans:  rows.slice(0, 12),
  });
});

// WEB — stats
app.get('/api/stats', requireAdmin, async (req, res) => {
  const today = await pool.query(`
    SELECT COUNT(DISTINCT finger_id) as count FROM attendance_logs
    WHERE check_time::date = CURRENT_DATE AND name != 'Unknown'
  `);
  const total = await pool.query('SELECT COUNT(*) as count FROM attendance_logs');
  const users = await pool.query('SELECT COUNT(*) as count FROM fp_users');
  res.json({
    today:      parseInt(today.rows[0].count),
    total:      parseInt(total.rows[0].count),
    registered: parseInt(users.rows[0].count)
  });
});

// WEB — monthly payroll report
app.get('/api/report', requireAdmin, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  const pad = n => String(n).padStart(2, '0');
  const lastDay    = new Date(year, month, 0).getDate();
  const monthStart = `${year}-${pad(month)}-01`;
  const monthEnd   = `${year}-${pad(month)}-${pad(lastDay)}`;

  const [usersRes, logsRes, commRes, corrRes, leaveRes, otRes, adjRes] = await Promise.all([
    pool.query(
      `SELECT u.*, s.start_time AS shift_start, s.end_time AS shift_end
       FROM fp_users u
       LEFT JOIN shifts s ON u.shift_id = s.id AND s.active = TRUE
       ORDER BY u.finger_id`
    ),
    pool.query(
      `SELECT finger_id, check_type, check_time FROM attendance_logs
       WHERE EXTRACT(YEAR FROM check_time) = $1 AND EXTRACT(MONTH FROM check_time) = $2
       ORDER BY check_time ASC`,
      [year, month]
    ),
    pool.query(
      `SELECT finger_id, commission_amount, notes FROM monthly_commissions
       WHERE year = $1 AND month = $2`,
      [year, month]
    ),
    pool.query(
      `SELECT finger_id, to_char(work_date,'YYYY-MM-DD') AS d, type, correct_time
       FROM attendance_corrections
       WHERE EXTRACT(YEAR FROM work_date) = $1 AND EXTRACT(MONTH FROM work_date) = $2`,
      [year, month]
    ),
    pool.query(
      `SELECT lr.finger_id, lt.is_paid,
              to_char(lr.start_date,'YYYY-MM-DD') AS s, to_char(lr.end_date,'YYYY-MM-DD') AS e
       FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.type_id
       WHERE lr.status = 'APPROVED' AND lr.start_date <= $2::date AND lr.end_date >= $1::date`,
      [monthStart, monthEnd]
    ),
    pool.query(
      `SELECT finger_id, minutes, multiplier FROM overtime_records
       WHERE status = 'APPROVED' AND EXTRACT(YEAR FROM work_date) = $1 AND EXTRACT(MONTH FROM work_date) = $2`,
      [year, month]
    ),
    pool.query(
      `SELECT finger_id, allowance, deduction, note FROM monthly_adjustments
       WHERE year = $1 AND month = $2`, [year, month]
    ),
  ]);

  const commMap = {}; commRes.rows.forEach(c => { commMap[c.finger_id] = c; });
  const adjMap  = {}; adjRes.rows.forEach(a => { adjMap[a.finger_id] = a; });

  // group logs by finger_id → Bangkok date string
  const logsByUser = {};
  logsRes.rows.forEach(log => {
    const fid = log.finger_id;
    if (!logsByUser[fid]) logsByUser[fid] = {};
    const th   = toTH(log.check_time);
    const date = th.toISOString().split('T')[0];
    if (!logsByUser[fid][date]) logsByUser[fid][date] = [];
    logsByUser[fid][date].push({ type: log.check_type, time: th });
  });
  // merge corrections as synthetic punches (raw logs stay untouched)
  corrRes.rows.forEach(c => {
    if (!logsByUser[c.finger_id]) logsByUser[c.finger_id] = {};
    if (!logsByUser[c.finger_id][c.d]) logsByUser[c.finger_id][c.d] = [];
    const [Y, M, D] = c.d.split('-').map(Number);
    const [hh, mi]  = c.correct_time.split(':').map(Number);
    logsByUser[c.finger_id][c.d].push({
      type: c.type, corrected: true,
      time: new Date(Date.UTC(Y, M - 1, D, hh || 0, mi || 0)),
    });
  });

  // leave days within the month, split paid/unpaid, per user
  const leaveMap = {};
  leaveRes.rows.forEach(l => {
    const a = l.s > monthStart ? l.s : monthStart;
    const b = l.e < monthEnd   ? l.e : monthEnd;
    if (a > b) return;
    const days = Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
    if (!leaveMap[l.finger_id]) leaveMap[l.finger_id] = { paid: 0, unpaid: 0 };
    if (l.is_paid) leaveMap[l.finger_id].paid += days; else leaveMap[l.finger_id].unpaid += days;
  });

  // OT per user: raw minutes + weighted minutes (Σ minutes*multiplier)
  const otMap = {};
  otRes.rows.forEach(o => {
    if (!otMap[o.finger_id]) otMap[o.finger_id] = { minutes: 0, weighted: 0 };
    otMap[o.finger_id].minutes  += o.minutes;
    otMap[o.finger_id].weighted += o.minutes * parseFloat(o.multiplier);
  });

  const report = usersRes.rows.map(u => {
    const userLogs = logsByUser[u.finger_id] || {};
    const effStart = u.shift_start || u.work_start_time || '08:00';
    const [sh, sm] = effStart.split(':').map(Number);
    const startMin = sh * 60 + (sm || 0);
    const grace    = parseInt(u.late_grace_minutes) || 15;

    let days_present = 0, days_late = 0;
    const daily_records = [];

    Object.entries(userLogs).sort().forEach(([date, dayLogs]) => {
      dayLogs.sort((a, b) => a.time - b.time);
      const inLogs  = dayLogs.filter(l => l.type === 'IN');
      const outLogs = dayLogs.filter(l => l.type === 'OUT');
      if (inLogs.length === 0) return;
      days_present++;

      const firstIn = inLogs[0].time;
      const inMin   = firstIn.getUTCHours() * 60 + firstIn.getUTCMinutes();
      const isLate  = inMin > startMin + grace;
      if (isLate) days_late++;

      const lastOut    = outLogs.length > 0 ? outLogs[outLogs.length - 1].time : null;
      const work_hours = lastOut ? +((lastOut - firstIn) / 3600000).toFixed(1) : null;

      daily_records.push({
        date,
        first_in:     firstIn.toISOString(),
        last_out:     lastOut ? lastOut.toISOString() : null,
        is_late:      isLate,
        late_minutes: isLate ? inMin - startMin - grace : 0,
        work_hours,
        corrected:    dayLogs.some(l => l.corrected),
      });
    });

    const base         = parseFloat(u.base_salary || 0);
    const commission   = parseFloat(commMap[u.finger_id]?.commission_amount || 0);
    const bonus_earned = (days_late === 0 && days_present > 0) ? parseFloat(u.attendance_bonus || 0) : 0;

    // OT pay: (weighted minutes / 60) × hourly rate (base/30/8)
    const hourlyRate  = base > 0 ? base / 30 / 8 : 0;
    const ot          = otMap[u.finger_id] || { minutes: 0, weighted: 0 };
    const ot_minutes  = ot.minutes;
    const ot_pay      = +(ot.weighted / 60 * hourlyRate).toFixed(2);

    const lv               = leaveMap[u.finger_id] || { paid: 0, unpaid: 0 };
    const paid_leave_days  = lv.paid;
    const unpaid_leave_days = lv.unpaid;
    const unpaid_leave_deduction = +(unpaid_leave_days * (base / 30)).toFixed(2);

    const sso = (u.sso_enabled) ? Math.min(Math.round(base * 0.05), 750) : 0;

    const adj        = adjMap[u.finger_id] || {};
    const allowance  = parseFloat(adj.allowance || 0);
    const deduction  = parseFloat(adj.deduction || 0);
    const adj_note   = adj.note || '';

    const gross_pay       = +(base + bonus_earned + commission + ot_pay + allowance).toFixed(2);
    const total_deduction = +(sso + unpaid_leave_deduction + deduction).toFixed(2);
    const net_pay         = +(gross_pay - total_deduction).toFixed(2);

    return {
      finger_id: u.finger_id, name: u.name,
      employee_id: u.employee_id, department: u.department,
      base_salary: base,
      attendance_bonus:  parseFloat(u.attendance_bonus || 0),
      work_start_time:   effStart,
      late_grace_minutes: grace,
      days_present, days_late,
      commission, commission_notes: commMap[u.finger_id]?.notes || '',
      bonus_earned,
      ot_minutes, ot_pay,
      paid_leave_days, unpaid_leave_days, unpaid_leave_deduction,
      sso_enabled: !!u.sso_enabled, sso,
      allowance, deduction, adj_note,
      gross_pay, total_deduction, net_pay,
      total_pay: net_pay, // backward compat
      daily_records,
    };
  });

  res.json({ year, month, report });
});

// WEB — upsert monthly commission
app.post('/api/commission', requireAdmin, async (req, res) => {
  const { finger_id, year, month, commission_amount, notes } = req.body;
  await pool.query(`
    INSERT INTO monthly_commissions (finger_id, year, month, commission_amount, notes)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (finger_id, year, month)
    DO UPDATE SET commission_amount=$4, notes=$5
  `, [finger_id, year, month, commission_amount || 0, notes || '']);
  await logAudit('commission_update', finger_id, { year, month, commission_amount }, req);
  res.json({ success: true });
});

// LINE Webhook — auto-capture Group ID เมื่อบอทอยู่ในกลุ่ม (ตรวจ signature ก่อนเชื่อ body)
app.post('/api/line-webhook', async (req, res) => {
  const secretRow = await pool.query(`SELECT value FROM system_settings WHERE key='line_channel_secret'`);
  const secret    = secretRow.rows[0]?.value;
  const signature = req.headers['x-line-signature'];

  if (!secret || !signature || !req.rawBody) return res.sendStatus(401);

  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);

  res.sendStatus(200); // ต้องตอบ 200 ทันที ไม่งั้น LINE retry
  const events = req.body?.events || [];
  for (const event of events) {
    const groupId = event.source?.groupId;
    if (groupId) {
      await pool.query(
        `INSERT INTO system_settings (key, value, label) VALUES ('line_group_id', $1, 'LINE Group ID')
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [groupId]
      ).catch(() => {});
      break;
    }
  }
});

// WEB — อ่าน settings
app.get('/api/settings', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT key, value, label FROM system_settings ORDER BY key');
  const out = {};
  result.rows.forEach(r => { out[r.key] = { value: r.value, label: r.label }; });
  res.json(out);
});

// WEB — บันทึก settings
app.post('/api/settings', requireAdmin, async (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    await pool.query('UPDATE system_settings SET value=$2 WHERE key=$1', [key, String(value)]);
  }
  // ไม่ log ค่า token/secret จริงลง audit — เก็บแค่ชื่อ key ที่ถูกแก้
  await logAudit('settings_update', null, { keys: Object.keys(updates) }, req);
  res.json({ success: true });
});

// WEB — อุปกรณ์ที่สแกนมาแล้ว
app.get('/api/devices', requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT device_id,
           COUNT(*)         AS scan_count,
           MAX(check_time)  AS last_seen,
           COUNT(DISTINCT finger_id) AS unique_users
    FROM attendance_logs
    GROUP BY device_id
    ORDER BY last_seen DESC
  `);
  res.json(result.rows);
});

// WEB — สรุประบบ
app.get('/api/system-info', requireAdmin, async (req, res) => {
  const [users, logs, devs] = await Promise.all([
    pool.query('SELECT COUNT(*) as count FROM fp_users'),
    pool.query('SELECT COUNT(*) as count FROM attendance_logs'),
    pool.query('SELECT COUNT(DISTINCT device_id) as count FROM attendance_logs'),
  ]);
  res.json({
    total_users:   parseInt(users.rows[0].count),
    total_logs:    parseInt(logs.rows[0].count),
    total_devices: parseInt(devs.rows[0].count),
    server_time:   new Date().toISOString(),
  });
});

initDB().then(() => {
  app.listen(3001, '0.0.0.0', () => console.log('🚀 Server running on http://localhost:3001'));
});
