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
          checkout_start_time, shift_id } = req.body;
  await pool.query(`
    INSERT INTO fp_users
      (finger_id, name, employee_id, department, base_salary, attendance_bonus,
       work_start_time, late_grace_minutes, checkout_start_time, shift_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (finger_id) DO UPDATE SET
      name=$2, employee_id=$3, department=$4,
      base_salary=$5, attendance_bonus=$6,
      work_start_time=$7, late_grace_minutes=$8, checkout_start_time=$9, shift_id=$10
  `, [finger_id, name, employee_id, department,
      base_salary || 0, attendance_bonus || 0,
      work_start_time || '08:00', late_grace_minutes || 15,
      checkout_start_time || '17:00', shift_id ? parseInt(shift_id) : null]);
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

  const [usersRes, logsRes, commRes] = await Promise.all([
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
    )
  ]);

  const commMap = {};
  commRes.rows.forEach(c => { commMap[c.finger_id] = c; });

  // group by finger_id → Bangkok date string
  const logsByUser = {};
  logsRes.rows.forEach(log => {
    const fid = log.finger_id;
    if (!logsByUser[fid]) logsByUser[fid] = {};
    const th   = toTH(log.check_time);
    const date = th.toISOString().split('T')[0];
    if (!logsByUser[fid][date]) logsByUser[fid][date] = [];
    logsByUser[fid][date].push({ type: log.check_type, time: th });
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
        work_hours
      });
    });

    const commission   = parseFloat(commMap[u.finger_id]?.commission_amount || 0);
    const bonus_earned = (days_late === 0 && days_present > 0)
      ? parseFloat(u.attendance_bonus || 0) : 0;
    const total_pay = parseFloat(u.base_salary || 0) + bonus_earned + commission;

    return {
      finger_id: u.finger_id, name: u.name,
      employee_id: u.employee_id, department: u.department,
      base_salary:       parseFloat(u.base_salary || 0),
      attendance_bonus:  parseFloat(u.attendance_bonus || 0),
      work_start_time:   effStart,
      late_grace_minutes: grace,
      days_present, days_late, commission,
      commission_notes: commMap[u.finger_id]?.notes || '',
      bonus_earned, total_pay, daily_records
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
