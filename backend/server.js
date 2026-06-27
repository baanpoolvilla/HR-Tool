const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json());

// CORS — allow Vercel deployments and local dev
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_logs (
      id          SERIAL PRIMARY KEY,
      device_id   VARCHAR(50),
      finger_id   INTEGER,
      name        VARCHAR(100),
      check_time  TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ DB ready');
}

// ESP32 — บันทึกเวลา
app.post('/api/attendance', async (req, res) => {
  const { device_id, finger_id } = req.body;
  const user = await pool.query('SELECT * FROM fp_users WHERE finger_id = $1', [finger_id]);
  const name = user.rows.length > 0 ? user.rows[0].name : 'Unknown';
  await pool.query(
    'INSERT INTO attendance_logs (device_id, finger_id, name) VALUES ($1, $2, $3)',
    [device_id, finger_id, name]
  );
  res.json({ success: true, name, finger_id });
});

// ESP32 — ดึง Next ID
app.get('/api/next-finger-id', async (req, res) => {
  const result = await pool.query('SELECT COALESCE(MAX(finger_id), 0) + 1 as next_id FROM fp_users');
  res.json({ next_id: result.rows[0].next_id });
});

// ESP32 — poll คำสั่ง enroll
app.get('/api/enroll-pending', (req, res) => {
  if (enrollQueue !== null) {
    const id = enrollQueue;
    enrollQueue = null;
    res.json({ pending: true, finger_id: id });
  } else {
    res.json({ pending: false });
  }
});

// ESP32 — บันทึก enroll สำเร็จ
app.post('/api/enroll-complete', async (req, res) => {
  const { finger_id, confidence, fp_pattern } = req.body;
  await pool.query(
    'UPDATE fp_users SET confidence=$2, fp_pattern=$3, enrolled=TRUE WHERE finger_id=$1',
    [finger_id, confidence || 50, fp_pattern || null]
  );
  res.json({ success: true });
});

// WEB — สั่ง enroll จากเว็บ
app.post('/api/enroll-request', (req, res) => {
  const { finger_id } = req.body;
  enrollQueue = finger_id;
  res.json({ success: true, finger_id });
});

// WEB — รายชื่อพนักงาน
app.get('/api/users', async (req, res) => {
  const result = await pool.query('SELECT * FROM fp_users ORDER BY finger_id');
  res.json(result.rows);
});

// WEB — เพิ่ม/แก้ไข พนักงาน
app.post('/api/users', async (req, res) => {
  const { finger_id, name, employee_id, department } = req.body;
  await pool.query(`
    INSERT INTO fp_users (finger_id, name, employee_id, department)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (finger_id) DO UPDATE SET name=$2, employee_id=$3, department=$4
  `, [finger_id, name, employee_id, department]);
  res.json({ success: true });
});

// WEB — ลบพนักงาน
app.delete('/api/users/:finger_id', async (req, res) => {
  await pool.query('DELETE FROM fp_users WHERE finger_id = $1', [req.params.finger_id]);
  res.json({ success: true });
});

// WEB — Logs
app.get('/api/logs', async (req, res) => {
  const result = await pool.query(`
    SELECT id, device_id, finger_id, name, check_time
    FROM attendance_logs ORDER BY check_time DESC LIMIT 100
  `);
  res.json(result.rows);
});

// WEB — Stats
app.get('/api/stats', async (req, res) => {
  const today = await pool.query(`
    SELECT COUNT(DISTINCT finger_id) as count FROM attendance_logs
    WHERE check_time::date = CURRENT_DATE AND name != 'Unknown'
  `);
  const total = await pool.query('SELECT COUNT(*) as count FROM attendance_logs');
  const users = await pool.query('SELECT COUNT(*) as count FROM fp_users');
  res.json({
    today: parseInt(today.rows[0].count),
    total: parseInt(total.rows[0].count),
    registered: parseInt(users.rows[0].count)
  });
});

initDB().then(() => {
  app.listen(3001, '0.0.0.0', () => console.log('🚀 Server running on http://localhost:3001'));
});
