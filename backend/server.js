const express  = require('express');
const https    = require('https');
const { Pool } = require('pg');
const app = express();

async function sendLineMessage(token, to, message) {
  if (!token || !to) return;
  const body = JSON.stringify({ to, messages: [{ type: 'text', text: message }] });
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

app.use(express.json());

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = [/\.vercel\.app$/, /localhost/, /poolvillapattayaparty\.com$/];
  if (origin && allowed.some(r => r.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
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
      ('line_channel_token', '', 'LINE Channel Access Token'),
      ('line_user_id',       '', 'LINE User ID / Group ID')
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

  console.log('✅ DB ready');
}

// ESP32 — บันทึกเวลา (time-based IN/OUT)
app.post('/api/attendance', async (req, res) => {
  const { device_id, finger_id } = req.body;

  const user    = await pool.query('SELECT * FROM fp_users WHERE finger_id = $1', [finger_id]);
  const userRow = user.rows[0];
  const name    = userRow ? userRow.name : 'Unknown';

  // เวลาปัจจุบัน Bangkok (UTC+7)
  const bangkokNow = toTH(new Date());
  const nowMin     = bangkokNow.getUTCHours() * 60 + bangkokNow.getUTCMinutes();
  const todayDate  = bangkokNow.toISOString().split('T')[0];

  // เวลาเข้างาน + ผ่อนผัน
  const [wsh, wsm]   = (userRow?.work_start_time   || '08:00').split(':').map(Number);
  const [coh, com]   = (userRow?.checkout_start_time || '17:00').split(':').map(Number);
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

  await pool.query(
    'INSERT INTO attendance_logs (device_id, finger_id, name, check_type, is_late) VALUES ($1,$2,$3,$4,$5)',
    [device_id, finger_id, name, check_type, is_late]
  );

  // LINE Messaging API
  const [tokenRow, userRow] = await Promise.all([
    pool.query(`SELECT value FROM system_settings WHERE key='line_channel_token'`),
    pool.query(`SELECT value FROM system_settings WHERE key='line_user_id'`),
  ]);
  const lineToken = tokenRow.rows[0]?.value;
  const lineUser  = userRow.rows[0]?.value;
  if (lineToken && lineUser) {
    const th       = toTH(new Date());
    const hhmm     = `${String(th.getUTCHours()).padStart(2,'0')}:${String(th.getUTCMinutes()).padStart(2,'0')}`;
    const typeIcon = check_type === 'IN' ? '🟢 เข้างาน' : '🔴 ออกงาน';
    const lateText = (check_type === 'IN' && is_late) ? '  ⚠️ สาย!' : '';
    const msg = `${typeIcon}${lateText}\n👤 ${name}\n🕐 ${hhmm}\n📍 ${device_id}`;
    sendLineMessage(lineToken, lineUser, msg).catch(() => {});
  }

  res.json({ success: true, status: 'ok', name, finger_id, check_type, is_late });
});

// ESP32 — Next ID
app.get('/api/next-finger-id', async (req, res) => {
  const result = await pool.query('SELECT COALESCE(MAX(finger_id), 0) + 1 as next_id FROM fp_users');
  res.json({ next_id: result.rows[0].next_id });
});

// ESP32 — poll enroll (clears queue)
app.get('/api/enroll-pending', (req, res) => {
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
app.post('/api/enroll-complete', async (req, res) => {
  const { finger_id, confidence, fp_pattern } = req.body;
  await pool.query(
    'UPDATE fp_users SET confidence=$2, fp_pattern=$3, enrolled=TRUE WHERE finger_id=$1',
    [finger_id, confidence || 50, fp_pattern || null]
  );
  enrollPickedUp = false;
  res.json({ success: true });
});

// WEB — request enroll
app.post('/api/enroll-request', (req, res) => {
  const { finger_id } = req.body;
  enrollQueue = finger_id;
  enrollPickedUp = false;
  res.json({ success: true, finger_id });
});

// WEB — watch enroll (safe, no queue change)
app.get('/api/enroll-watch', (req, res) => {
  res.json({ queued: enrollQueue !== null, picked_up: enrollPickedUp });
});

// ESP32 — poll sensor clear
app.get('/api/sensor-clear-pending', (req, res) => {
  if (sensorClearPending) {
    sensorClearPending = false;
    res.json({ pending: true });
  } else {
    res.json({ pending: false });
  }
});

// WEB — request sensor clear
app.post('/api/sensor-clear-request', (req, res) => {
  sensorClearPending = true;
  res.json({ success: true });
});

// ADMIN — reset all data
app.delete('/api/admin/reset', async (req, res) => {
  if (req.body.key !== 'reset-confirm') return res.status(403).json({ error: 'Forbidden' });
  await pool.query('TRUNCATE attendance_logs, fp_users, monthly_commissions RESTART IDENTITY');
  res.json({ success: true });
});

// WEB — list users
app.get('/api/users', async (req, res) => {
  const result = await pool.query('SELECT * FROM fp_users ORDER BY finger_id');
  res.json(result.rows);
});

// WEB — upsert user (with payroll settings)
app.post('/api/users', async (req, res) => {
  const { finger_id, name, employee_id, department,
          base_salary, attendance_bonus, work_start_time, late_grace_minutes, checkout_start_time } = req.body;
  await pool.query(`
    INSERT INTO fp_users
      (finger_id, name, employee_id, department, base_salary, attendance_bonus,
       work_start_time, late_grace_minutes, checkout_start_time)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (finger_id) DO UPDATE SET
      name=$2, employee_id=$3, department=$4,
      base_salary=$5, attendance_bonus=$6,
      work_start_time=$7, late_grace_minutes=$8, checkout_start_time=$9
  `, [finger_id, name, employee_id, department,
      base_salary || 0, attendance_bonus || 0,
      work_start_time || '08:00', late_grace_minutes || 15,
      checkout_start_time || '17:00']);
  res.json({ success: true });
});

// WEB — delete user
app.delete('/api/users/:finger_id', async (req, res) => {
  await pool.query('DELETE FROM fp_users WHERE finger_id = $1', [req.params.finger_id]);
  res.json({ success: true });
});

// WEB — logs (include check_type)
app.get('/api/logs', async (req, res) => {
  const result = await pool.query(`
    SELECT id, device_id, finger_id, name, check_time, check_type, is_late
    FROM attendance_logs ORDER BY check_time DESC LIMIT 100
  `);
  res.json(result.rows);
});

// WEB — stats
app.get('/api/stats', async (req, res) => {
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
app.get('/api/report', async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  const [usersRes, logsRes, commRes] = await Promise.all([
    pool.query('SELECT * FROM fp_users ORDER BY finger_id'),
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
    const [sh, sm] = (u.work_start_time || '08:00').split(':').map(Number);
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
      work_start_time:   u.work_start_time || '08:00',
      late_grace_minutes: grace,
      days_present, days_late, commission,
      commission_notes: commMap[u.finger_id]?.notes || '',
      bonus_earned, total_pay, daily_records
    };
  });

  res.json({ year, month, report });
});

// WEB — upsert monthly commission
app.post('/api/commission', async (req, res) => {
  const { finger_id, year, month, commission_amount, notes } = req.body;
  await pool.query(`
    INSERT INTO monthly_commissions (finger_id, year, month, commission_amount, notes)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (finger_id, year, month)
    DO UPDATE SET commission_amount=$4, notes=$5
  `, [finger_id, year, month, commission_amount || 0, notes || '']);
  res.json({ success: true });
});

// WEB — อ่าน settings
app.get('/api/settings', async (req, res) => {
  const result = await pool.query('SELECT key, value, label FROM system_settings ORDER BY key');
  const out = {};
  result.rows.forEach(r => { out[r.key] = { value: r.value, label: r.label }; });
  res.json(out);
});

// WEB — บันทึก settings
app.post('/api/settings', async (req, res) => {
  const updates = req.body;
  for (const [key, value] of Object.entries(updates)) {
    await pool.query('UPDATE system_settings SET value=$2 WHERE key=$1', [key, String(value)]);
  }
  res.json({ success: true });
});

// WEB — อุปกรณ์ที่สแกนมาแล้ว
app.get('/api/devices', async (req, res) => {
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
app.get('/api/system-info', async (req, res) => {
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
