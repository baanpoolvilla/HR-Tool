const API_BASE = 'https://attendance.poolvillapattayaparty.com';

// ===== Auth-aware fetch =====
async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, { ...opts, credentials: 'include' });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthorized');
  }
  return res;
}

async function checkSession() {
  try {
    const res  = await fetch(API_BASE + '/api/admin/session', { credentials: 'include' });
    const data = await res.json();
    if (data.authenticated) { showApp(); return; }
  } catch (e) {}
  showLogin();
}

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  showPage('dashboard', document.querySelector('.nav-item[data-page="dashboard"]'));
}

async function login() {
  const password = document.getElementById('login-password').value;
  const statusEl = document.getElementById('login-status');
  statusEl.textContent = '';
  const res = await fetch(API_BASE + '/api/admin/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    document.getElementById('login-password').value = '';
    showApp();
  } else if (res.status === 429) {
    statusEl.className = 'status error';
    statusEl.textContent = '⏳ ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่';
  } else {
    statusEl.className = 'status error';
    statusEl.textContent = '❌ รหัสผ่านไม่ถูกต้อง';
  }
}

async function logout() {
  await fetch(API_BASE + '/api/admin/logout', { method: 'POST', credentials: 'include' });
  showLogin();
}

// ===== Navigation =====
const PAGE_TITLES = {
  dashboard: 'ภาพรวม', logs: 'บันทึกเวลา', users: 'พนักงาน',
  report: 'รายงาน & เงินเดือน', config: 'ตั้งค่าระบบ',
  shifts: 'กะ / ตารางเวร', holidays: 'วันหยุด',
  leave: 'การลา', ot: 'ล่วงเวลา (OT)', timesheet: 'Timesheet'
};

function showPage(page, el) {
  document.querySelectorAll('.content').forEach(e => e.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(e => e.classList.remove('active'));
  document.getElementById('tab-' + page).classList.remove('hidden');
  if (el) el.classList.add('active');
  else {
    const n = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (n) n.classList.add('active');
  }
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || '';
  closeSidebar();
  if (page === 'dashboard') loadDashboard();
  if (page === 'logs')   loadLogs();
  if (page === 'users')  { populateShiftDropdown(); loadUsers(); }
  if (page === 'report') {}
  if (page === 'config') { loadSettings(); loadDevices(); loadSystemInfo(); }
  if (page === 'shifts') loadShifts();
  if (page === 'holidays') {
    const y = document.getElementById('h-filter-year');
    if (!y.value) y.value = new Date().getFullYear();
    loadHolidays();
  }
  if (page === 'leave') loadLeave();
  if (page === 'ot') {
    fillMonthSelect('o-filter-month');
    const y = document.getElementById('o-filter-year'); if (!y.value) y.value = new Date().getFullYear();
    populateEmployeeSelect('o-emp');
    loadOvertime();
  }
  if (page === 'timesheet') {
    fillMonthSelect('t-month');
    const y = document.getElementById('t-year'); if (!y.value) y.value = new Date().getFullYear();
    loadTimesheet();
  }
}

// ===== Shared helpers: employee + month selects =====
const MONTHS_TH = ['','มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                   'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
let usersCache = [];

async function refreshUsersCache() {
  try { usersCache = await (await api('/api/users')).json(); } catch (e) {}
}
async function populateEmployeeSelect(selectId) {
  await refreshUsersCache();
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— เลือกพนักงาน —</option>' +
    usersCache.map(u => `<option value="${u.finger_id}">${u.name}</option>`).join('');
  sel.value = cur;
}
function fillMonthSelect(id) {
  const sel = document.getElementById(id);
  if (!sel || sel.options.length) return;
  sel.innerHTML = MONTHS_TH.slice(1).map((m, i) => `<option value="${i+1}">${m}</option>`).join('');
  sel.value = new Date().getMonth() + 1;
}

function openSidebar()  { document.getElementById('sidebar').classList.add('open');  document.getElementById('scrim').classList.add('show'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('scrim').classList.remove('show'); }

// ===== Modal helpers =====
function openModal(id)  { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// ===== Theme =====
function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else   document.documentElement.removeAttribute('data-theme');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = currentTheme() === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}
function initTheme() { applyTheme(localStorage.getItem('theme') || null); }

// ===== Formatters =====
function fmtTime(ts)  { return new Date(ts).toLocaleString('th-TH'); }
function fmtHHMM(ts)  {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}
function fmtMoney(n)  { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 }); }
function avatarColor(name) {
  const colors = ['#4f46e5','#0284c7','#16a34a','#d97706','#9333ea','#dc2626','#0891b2','#ca8a04'];
  let h = 0; for (let i=0;i<name.length;i++) h = name.charCodeAt(i) + ((h<<5)-h);
  return colors[Math.abs(h) % colors.length];
}

// ===== Dashboard =====
async function loadDashboard() {
  const res = await api('/api/dashboard');
  if (!res.ok) {
    document.getElementById('dash-recent').innerHTML =
      '<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">⚠️ ต้องอัปเดต backend ก่อน (endpoint /api/dashboard)</td></tr>';
    document.getElementById('dash-present-list').innerHTML =
      '<div class="muted" style="text-align:center;padding:20px">รอ backend เวอร์ชันใหม่</div>';
    return;
  }
  const d   = await res.json();

  document.getElementById('dash-present').textContent    = d.present_today;
  document.getElementById('dash-late').textContent       = d.late_today;
  document.getElementById('dash-absent').textContent     = d.absent_today;
  document.getElementById('dash-registered').textContent = d.registered;

  // แถบแจ้งเตือนรออนุมัติ
  try {
    const pa = await (await api('/api/pending-approvals')).json();
    const banner = document.getElementById('pending-banner');
    if (pa.total > 0) {
      document.getElementById('pending-text').textContent =
        `มีคำขอรออนุมัติ ${pa.total} รายการ (ลา ${pa.leave} · OT ${pa.overtime})`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch (e) {}

  const recent = document.getElementById('dash-recent');
  if (!d.recent_scans.length) {
    recent.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">ยังไม่มีการสแกนวันนี้</td></tr>';
  } else {
    recent.innerHTML = d.recent_scans.map(r => {
      const isOut     = r.check_type === 'OUT';
      const typeBadge = isOut ? '<span class="badge badge-out">🚪 OUT</span>' : '<span class="badge badge-in">✅ IN</span>';
      const statBadge = isOut ? '<span class="muted">-</span>'
        : (r.is_late ? '<span class="badge badge-late">⏰ สาย</span>' : '<span class="badge badge-ontime">✅ ตรงเวลา</span>');
      return `<tr><td><strong>${r.name || 'Unknown'}</strong></td><td>${fmtHHMM(r.check_time)}</td><td>${typeBadge}</td><td>${statBadge}</td></tr>`;
    }).join('');
  }

  const list = document.getElementById('dash-present-list');
  if (!d.present_list.length) {
    list.innerHTML = '<div class="muted" style="text-align:center;padding:20px">ยังไม่มีใครเข้างานวันนี้</div>';
  } else {
    list.innerHTML = d.present_list.map(p => {
      const initial = (p.name || '?').trim().charAt(0).toUpperCase();
      const late    = p.is_late ? '<span class="badge badge-late">สาย</span>' : '<span class="badge badge-ontime">ตรงเวลา</span>';
      return `<div class="person-row">
        <div class="avatar" style="background:${avatarColor(p.name || '')}">${initial}</div>
        <div class="who"><b>${p.name}</b><small>เข้างาน ${fmtHHMM(p.check_time)}</small></div>
        ${late}
      </div>`;
    }).join('');
  }
}

// ===== Fingerprint canvas =====
function drawFingerprint(canvas, seed, enrolled) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!enrolled) {
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, w, h);
    return;
  }

  const rng = s => { const x = Math.sin(s) * 10000; return x - Math.floor(x); };

  ctx.fillStyle = '#fff8f0';
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2, cy = h * 0.45;
  for (let i = 0; i < 18; i++) {
    const t = i / 18;
    const rx = (w * 0.35) * (0.4 + t * 0.6);
    const ry = (h * 0.4)  * (0.4 + t * 0.6);
    ctx.beginPath();
    ctx.ellipse(cx + (rng(seed + i*7) - 0.5)*6, cy, rx, ry, 0, 0, Math.PI*2);
    ctx.strokeStyle = `rgba(80,40,20,${0.5 - t*0.2})`;
    ctx.lineWidth = 1 + rng(seed + i*13) * 0.3;
    ctx.setLineDash(rng(seed + i*3) > 0.7 ? [rng(seed+i)*20+5, rng(seed+i*2)*4+1] : []);
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx + (rng(seed*2)-0.5)*4, cy - h*0.05, 5, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(80,40,20,0.3)';
  ctx.fill();
}

// ===== Logs =====
async function loadLogs() {
  const [logsRes, statsRes] = await Promise.all([ api('/api/logs'), api('/api/stats') ]);
  const logs  = await logsRes.json();
  const stats = await statsRes.json();

  document.getElementById('stat-today').textContent = stats.today;
  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-users').textContent = stats.registered;

  const tbody = document.getElementById('logs-body');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">ยังไม่มีบันทึก</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map((l, i) => {
    const isOut  = l.check_type === 'OUT';
    const badge  = isOut ? '<span class="badge badge-out">🚪 OUT</span>' : '<span class="badge badge-in">✅ IN</span>';
    const lateBadge = isOut ? '<span class="muted">-</span>'
      : (l.is_late ? '<span class="badge badge-late">⏰ สาย</span>' : '<span class="badge badge-ontime">✅ ตรงเวลา</span>');
    return `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${l.name || 'Unknown'}</strong></td>
      <td>${l.finger_id}</td>
      <td>${l.device_id}</td>
      <td>${fmtTime(l.check_time)}</td>
      <td>${badge}</td>
      <td>${lateBadge}</td>
    </tr>`;
  }).join('');
}

// ===== Users =====
async function loadUsers() {
  const res   = await api('/api/users');
  const users = await res.json();
  const tbody = document.getElementById('users-body');

  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">ยังไม่มีพนักงาน</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const enrolled = u.enrolled || u.fp_pattern || u.confidence > 0;
    const seed     = u.finger_id * 137 + (u.name.charCodeAt(0) || 0) * 31;
    const badge    = enrolled
      ? '<span class="badge badge-ok">✅ ลงทะเบียนแล้ว</span>'
      : '<span class="badge badge-no">❌ ยังไม่ลงทะเบียน</span>';
    return `
      <tr>
        <td><strong>${u.finger_id}</strong></td>
        <td>
          <div class="fp-cell">
            <div class="fp-thumb ${enrolled ? 'enrolled' : 'not-enrolled'}"
                 onclick="viewFingerprint(${u.finger_id},'${u.name}',${seed},${enrolled})"
                 title="คลิกดูลายนิ้วมือ">
              <canvas id="fp-mini-${u.finger_id}" width="40" height="48"></canvas>
            </div>
          </div>
        </td>
        <td>${u.name}</td>
        <td>${u.employee_id || '-'}</td>
        <td>${u.department  || '-'}</td>
        <td>${badge}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-enroll" onclick="startEnroll(${u.finger_id},'${u.name}')">👆 ลงทะเบียนนิ้ว</button>
          <button class="btn btn-primary" onclick="editUser(${u.finger_id},'${u.name}','${u.employee_id||''}','${u.department||''}',${u.base_salary||0},${u.attendance_bonus||0},'${u.work_start_time||'08:00'}',${u.late_grace_minutes||15},'${u.checkout_start_time||'17:00'}',${u.shift_id||'null'},${u.sso_enabled||false},${u.pf_percent||0},${u.tax_enabled||false})">✏️</button>
          <button class="btn btn-danger"  onclick="deleteUser(${u.finger_id})">🗑️</button>
        </td>
      </tr>`;
  }).join('');

  setTimeout(() => {
    users.forEach(u => {
      const canvas = document.getElementById(`fp-mini-${u.finger_id}`);
      if (!canvas) return;
      const seed     = u.finger_id * 137 + (u.name.charCodeAt(0) || 0) * 31;
      const enrolled = u.enrolled || u.fp_pattern || u.confidence > 0;
      drawFingerprint(canvas, seed, enrolled);
    });
  }, 50);
}

// ===== View fingerprint modal =====
function viewFingerprint(fingerId, name, seed, enrolled) {
  document.getElementById('view-name').textContent = name;
  document.getElementById('view-info').textContent =
    `Finger ID: ${fingerId} • ${enrolled ? 'ลงทะเบียนแล้ว' : 'ยังไม่ลงทะเบียน'}`;
  drawFingerprint(document.getElementById('view-canvas'), seed, enrolled);
  document.getElementById('view-modal').classList.add('show');
}

// ===== Enroll =====
let enrollPolling   = null;
let currentEnrollId = null;

async function startEnroll(fingerId, name) {
  currentEnrollId = fingerId;
  document.getElementById('modal-title').textContent  = `ลงทะเบียนนิ้ว: ${name}`;
  document.getElementById('modal-desc').textContent   = 'วางนิ้วบน Sensor และค้างไว้จนจอแสดง "Remove Finger"';
  document.getElementById('modal-status').textContent = '⏳ กำลังส่งคำสั่งไปยังเครื่อง...';
  document.getElementById('enroll-step').textContent  = 'รอ ESP32...';
  document.getElementById('fp-icon').style.display   = 'block';
  document.getElementById('fp-canvas').style.display = 'none';
  document.getElementById('enroll-modal').classList.add('show');

  await api('/api/enroll-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finger_id: fingerId }),
  });

  let phase = 'waiting';
  let elapsed = 0;

  enrollPolling = setInterval(async () => {
    elapsed += 2;
    if (elapsed > 120) {
      clearInterval(enrollPolling);
      currentEnrollId = null;
      document.getElementById('modal-status').textContent = '⏰ หมดเวลา กรุณาลองใหม่';
      setTimeout(cancelEnroll, 2500);
      return;
    }

    if (phase === 'waiting') {
      const watch = await api('/api/enroll-watch').then(r => r.json());
      if (watch.picked_up || !watch.queued) {
        phase = 'enrolling';
        document.getElementById('enroll-step').textContent  = 'ขั้นตอนที่ 1/2';
        document.getElementById('modal-status').textContent = '👆 วางนิ้วบน Sensor ได้เลย';
      } else {
        document.getElementById('modal-status').textContent = `⏳ รอ ESP32 รับคำสั่ง... (${elapsed}s)`;
      }
    } else {
      const users = await api('/api/users').then(r => r.json());
      const user  = users.find(u => u.finger_id === fingerId);
      document.getElementById('modal-status').textContent = `👆 กำลังแสกนนิ้ว... (${elapsed}s)`;
      if (user && (user.enrolled || user.confidence > 0)) {
        clearInterval(enrollPolling);
        currentEnrollId = null;
        document.getElementById('modal-status').textContent = '✅ ลงทะเบียนสำเร็จ!';
        document.getElementById('enroll-step').textContent  = 'เสร็จสิ้น ✅';
        const canvas = document.getElementById('fp-canvas');
        canvas.style.display = 'block';
        document.getElementById('fp-icon').style.display = 'none';
        drawFingerprint(canvas, fingerId * 137 + name.charCodeAt(0) * 31, true);
        setTimeout(() => {
          document.getElementById('enroll-modal').classList.remove('show');
          loadUsers();
        }, 2000);
      }
    }
  }, 2000);
}

function cancelEnroll() {
  clearInterval(enrollPolling);
  currentEnrollId = null;
  document.getElementById('enroll-modal').classList.remove('show');
}

// ===== Save / Edit / Delete =====
async function openAddEmp() {
  document.getElementById('emp-modal-title').textContent = '➕ เพิ่มพนักงาน';
  ['f-finger-id','f-name','f-emp-id','f-dept','f-salary','f-bonus','f-grace','f-pf'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-shift').value = '';
  document.getElementById('f-sso').checked = false;
  document.getElementById('f-tax').checked = false;
  document.getElementById('f-finger-id').readOnly = false;
  document.getElementById('user-status').className = 'status';
  await populateShiftDropdown();
  await applyDefaultsToForm(true);   // เติมค่าเริ่มต้น (เวลา/ผ่อนผัน) จาก settings
  onShiftChange();
  openModal('emp-modal');
}

function editUser(fid, name, empId, dept, salary, bonus, startTime, grace, checkoutTime, shiftId, ssoEnabled, pfPercent, taxEnabled) {
  document.getElementById('emp-modal-title').textContent = '✏️ แก้ไขพนักงาน';
  document.getElementById('f-finger-id').value     = fid;
  document.getElementById('f-name').value           = name;
  document.getElementById('f-emp-id').value         = empId;
  document.getElementById('f-dept').value           = dept;
  document.getElementById('f-salary').value         = salary       || 0;
  document.getElementById('f-bonus').value          = bonus        || 0;
  document.getElementById('f-start-time').value     = startTime    || '08:00';
  document.getElementById('f-grace').value          = grace        || 15;
  document.getElementById('f-checkout-time').value  = checkoutTime || '17:00';
  document.getElementById('f-shift').value          = (shiftId !== null && shiftId !== undefined) ? String(shiftId) : '';
  document.getElementById('f-sso').checked          = ssoEnabled === true;
  document.getElementById('f-pf').value             = pfPercent    || 0;
  document.getElementById('f-tax').checked          = taxEnabled === true;
  document.getElementById('f-finger-id').readOnly   = true;   // ห้ามแก้ Finger ID ตอนแก้ไข
  document.getElementById('user-status').className  = 'status';
  onShiftChange();
  openModal('emp-modal');
}

async function saveUser() {
  const finger_id           = document.getElementById('f-finger-id').value;
  const name                = document.getElementById('f-name').value;
  const employee_id         = document.getElementById('f-emp-id').value;
  const department          = document.getElementById('f-dept').value;
  const base_salary         = parseFloat(document.getElementById('f-salary').value) || 0;
  const attendance_bonus    = parseFloat(document.getElementById('f-bonus').value)  || 0;
  const work_start_time     = document.getElementById('f-start-time').value    || '08:00';
  const late_grace_minutes  = parseInt(document.getElementById('f-grace').value)    || 15;
  const checkout_start_time = document.getElementById('f-checkout-time').value || '17:00';
  const shift_id            = document.getElementById('f-shift').value || null;
  const sso_enabled         = document.getElementById('f-sso').checked;
  const pf_percent          = parseFloat(document.getElementById('f-pf').value) || 0;
  const tax_enabled         = document.getElementById('f-tax').checked;
  const status              = document.getElementById('user-status');

  if (!finger_id || !name) {
    status.className = 'status error';
    status.textContent = '⚠️ กรุณากรอก Finger ID และชื่อ';
    return;
  }

  const res = await api('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finger_id: parseInt(finger_id), name, employee_id, department,
                           base_salary, attendance_bonus, work_start_time, late_grace_minutes,
                           checkout_start_time, shift_id, sso_enabled, pf_percent, tax_enabled }),
  });

  if (res.ok) {
    closeModal('emp-modal');
    loadUsers();
  } else {
    status.className = 'status error';
    status.textContent = '❌ บันทึกไม่สำเร็จ';
    setTimeout(() => { status.className = 'status'; }, 3000);
  }
}

async function deleteUser(fid) {
  if (!confirm(`ลบ Finger ID ${fid} ใช่ไหม?`)) return;
  await api('/api/users/' + fid, { method: 'DELETE' });
  loadUsers();
}

// ===== Clear Sensor =====
async function clearSensor() {
  if (!confirm('🗑️ ล้างลายนิ้วมือทั้งหมดในเครื่องสแกน?\nต้องวาง ESP32 ให้ออนไลน์ก่อน')) return;
  await api('/api/sensor-clear-request', { method: 'POST' });
  alert('✅ ส่งคำสั่งแล้ว — รอ ESP32 รับคำสั่ง (ภายใน 3 วินาที)\nจอเครื่องจะขึ้น "SENSOR CLEARED"');
}

// ===== Admin Reset =====
async function resetAllData() {
  if (!confirm('⚠️ ลบข้อมูลทั้งหมด? (พนักงาน + บันทึกเวลา)\nไม่สามารถย้อนกลับได้!')) return;
  if (!confirm('ยืนยันอีกครั้ง — ลบจริงๆ ใช่ไหม?')) return;
  const res = await api('/api/admin/reset', { method: 'DELETE' });
  if (res.ok) {
    alert('✅ ล้างข้อมูลเรียบร้อยแล้ว');
    loadDashboard();
    loadUsers();
  }
}

// ===== Config / Settings =====
async function loadSettings() {
  try {
    const res = await api('/api/settings');
    const s   = await res.json();
    document.getElementById('cfg-work-start').value  = s.default_work_start?.value || '08:00';
    document.getElementById('cfg-checkout').value    = s.default_checkout?.value   || '17:00';
    document.getElementById('cfg-grace').value       = s.default_grace?.value      || '15';
    document.getElementById('cfg-salary').value      = s.default_salary?.value     || '0';
    document.getElementById('cfg-bonus').value       = s.default_bonus?.value      || '0';
    document.getElementById('cfg-line-token').value  = s.line_channel_token?.value  || '';
    document.getElementById('cfg-line-secret').value = s.line_channel_secret?.value || '';
    const gid = s.line_group_id?.value || '';
    document.getElementById('cfg-line-user').value = gid;
    document.getElementById('group-id-badge').textContent = gid ? '✅ Captured' : '';
  } catch(e) {}
}

async function saveSettings() {
  const updates = {
    default_work_start:  document.getElementById('cfg-work-start').value,
    default_checkout:    document.getElementById('cfg-checkout').value,
    default_grace:       document.getElementById('cfg-grace').value,
    default_salary:      document.getElementById('cfg-salary').value,
    default_bonus:       document.getElementById('cfg-bonus').value,
    line_channel_token:  document.getElementById('cfg-line-token').value,
    line_channel_secret: document.getElementById('cfg-line-secret').value,
    line_group_id:       document.getElementById('cfg-line-user').value,
  };
  const res    = await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  const status = document.getElementById('config-status');
  if (res.ok) {
    status.className = 'status success';
    status.textContent = '✅ บันทึกค่าเริ่มต้นแล้ว';
  } else {
    status.className = 'status error';
    status.textContent = '❌ เกิดข้อผิดพลาด';
  }
  setTimeout(() => { status.className = 'status'; }, 3000);
}

async function applyDefaultsToForm() {
  if (document.getElementById('f-finger-id').value) return; // กำลัง edit อยู่
  try {
    const res = await api('/api/settings');
    const s   = await res.json();
    document.getElementById('f-start-time').value    = s.default_work_start?.value || '08:00';
    document.getElementById('f-checkout-time').value = s.default_checkout?.value   || '17:00';
    document.getElementById('f-grace').value         = s.default_grace?.value      || '15';
    document.getElementById('f-salary').value        = s.default_salary?.value     || '0';
    document.getElementById('f-bonus').value         = s.default_bonus?.value      || '0';
  } catch(e) {}
}

async function loadDevices() {
  const res   = await api('/api/devices');
  const devs  = await res.json();
  const tbody = document.getElementById('devices-body');
  if (!devs.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:16px">ยังไม่มีอุปกรณ์</td></tr>';
    return;
  }
  tbody.innerHTML = devs.map(d => `
    <tr>
      <td><strong>${d.device_id}</strong></td>
      <td style="text-align:center">${Number(d.scan_count).toLocaleString()} ครั้ง</td>
      <td style="text-align:center">${d.unique_users} คน</td>
      <td>${fmtTime(d.last_seen)}</td>
    </tr>`).join('');
}

async function loadSystemInfo() {
  try {
    const res  = await api('/api/system-info');
    const info = await res.json();
    const thTime = new Date(info.server_time).toLocaleString('th-TH');
    document.getElementById('system-info').innerHTML = [
      { label: '👥 พนักงาน',         value: info.total_users    + ' คน' },
      { label: '📋 บันทึกเวลาทั้งหมด', value: info.total_logs.toLocaleString() + ' รายการ' },
      { label: '📡 อุปกรณ์',          value: info.total_devices  + ' เครื่อง' },
      { label: '🕐 เวลาเซิร์ฟเวอร์',  value: thTime },
    ].map(c => `
      <div class="stat" style="flex:1;min-width:180px">
        <div><div class="stat-num" style="font-size:18px">${c.value}</div><div class="stat-label">${c.label}</div></div>
      </div>`).join('');
  } catch(e) {}
}

// ===== Shifts =====
let shiftsCache = [];

async function loadShifts() {
  const res = await api('/api/shifts');
  shiftsCache = await res.json();
  const tbody = document.getElementById('shifts-body');
  if (!shiftsCache.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px">ยังไม่มีกะ</td></tr>';
    return;
  }
  tbody.innerHTML = shiftsCache.map(s => `
    <tr>
      <td><strong>${s.name}</strong></td>
      <td>${s.start_time}</td>
      <td>${s.end_time}</td>
      <td>${s.break_minutes} นาที</td>
      <td>${s.active ? '<span class="badge badge-ok">ใช้งาน</span>' : '<span class="badge badge-no">ปิด</span>'}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="editShift(${s.id})">✏️</button>
        <button class="btn btn-danger" onclick="deleteShift(${s.id},'${s.name.replace(/'/g,"\\'")}')">🗑️</button>
      </td>
    </tr>`).join('');
}

function openAddShift() {
  resetShiftForm();
  document.getElementById('shift-status').className = 'status';
  openModal('shift-modal');
}

function editShift(id) {
  const s = shiftsCache.find(x => x.id === id);
  if (!s) return;
  document.getElementById('s-id').value    = s.id;
  document.getElementById('s-name').value  = s.name;
  document.getElementById('s-start').value = s.start_time;
  document.getElementById('s-end').value   = s.end_time;
  document.getElementById('s-break').value = s.break_minutes;
  document.getElementById('shift-modal-title').textContent = '✏️ แก้ไขกะ';
  document.getElementById('shift-status').className = 'status';
  openModal('shift-modal');
}

function resetShiftForm() {
  document.getElementById('s-id').value    = '';
  document.getElementById('s-name').value  = '';
  document.getElementById('s-start').value = '08:00';
  document.getElementById('s-end').value   = '17:00';
  document.getElementById('s-break').value = '0';
  document.getElementById('shift-modal-title').textContent = '➕ เพิ่มกะ';
}

async function saveShift() {
  const status = document.getElementById('shift-status');
  const payload = {
    id:            document.getElementById('s-id').value || null,
    name:          document.getElementById('s-name').value.trim(),
    start_time:    document.getElementById('s-start').value,
    end_time:      document.getElementById('s-end').value,
    break_minutes: parseInt(document.getElementById('s-break').value) || 0,
  };
  if (!payload.name) {
    status.className = 'status error'; status.textContent = '⚠️ กรุณากรอกชื่อกะ';
    return;
  }
  const res = await api('/api/shifts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (res.ok) {
    closeModal('shift-modal'); loadShifts();
  } else {
    status.className = 'status error'; status.textContent = '❌ บันทึกไม่สำเร็จ';
    setTimeout(() => { status.className = 'status'; }, 3000);
  }
}

async function deleteShift(id, name) {
  if (!confirm(`ลบกะ "${name}"?\nพนักงานที่ผูกกะนี้จะกลับไปใช้เวลาส่วนตัวแทน`)) return;
  await api('/api/shifts/' + id, { method: 'DELETE' });
  loadShifts();
}

// ===== Shift dropdown บนฟอร์มพนักงาน =====
async function populateShiftDropdown() {
  try {
    const res = await api('/api/shifts');
    shiftsCache = await res.json();
  } catch (e) { return; }
  const sel = document.getElementById('f-shift');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— ไม่ใช้กะ —</option>' +
    shiftsCache.filter(s => s.active).map(s =>
      `<option value="${s.id}">${s.name} (${s.start_time}-${s.end_time})</option>`).join('');
  sel.value = cur;
}

function onShiftChange() {
  const sel = document.getElementById('f-shift');
  const s   = shiftsCache.find(x => String(x.id) === sel.value);
  const st  = document.getElementById('f-start-time');
  const ct  = document.getElementById('f-checkout-time');
  if (s) {
    st.value = s.start_time; ct.value = s.end_time;
    st.disabled = true; ct.disabled = true;
  } else {
    st.disabled = false; ct.disabled = false;
  }
}

// ===== Holidays =====
async function loadHolidays() {
  const year = document.getElementById('h-filter-year').value || new Date().getFullYear();
  document.getElementById('holiday-year-label').textContent = year;
  const res = await api('/api/holidays?year=' + year);
  const rows = await res.json();
  const tbody = document.getElementById('holidays-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">ยังไม่มีวันหยุดในปีนี้</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(h => {
    const d = new Date(h.holiday_date + 'T00:00:00');
    const dateStr = d.toLocaleDateString('th-TH', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    const paid = h.is_paid ? '<span class="badge badge-ok">มีค่าจ้าง</span>' : '<span class="badge badge-out">ไม่มีค่าจ้าง</span>';
    return `<tr>
      <td>${dateStr}</td>
      <td>${h.name || '-'}</td>
      <td>${paid}</td>
      <td><button class="btn btn-danger" onclick="deleteHoliday(${h.id})">🗑️</button></td>
    </tr>`;
  }).join('');
}

function openAddHoliday() {
  document.getElementById('h-date').value = '';
  document.getElementById('h-name').value = '';
  document.getElementById('h-paid').value = 'true';
  document.getElementById('holiday-status').className = 'status';
  openModal('holiday-modal');
}

async function saveHoliday() {
  const status = document.getElementById('holiday-status');
  const holiday_date = document.getElementById('h-date').value;
  if (!holiday_date) {
    status.className = 'status error'; status.textContent = '⚠️ กรุณาเลือกวันที่';
    return;
  }
  const res = await api('/api/holidays', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      holiday_date,
      name:    document.getElementById('h-name').value.trim(),
      is_paid: document.getElementById('h-paid').value === 'true',
    }),
  });
  if (res.ok) {
    document.getElementById('h-filter-year').value = new Date(holiday_date).getFullYear();
    closeModal('holiday-modal');
    loadHolidays();
  } else {
    status.className = 'status error'; status.textContent = '❌ บันทึกไม่สำเร็จ';
    setTimeout(() => { status.className = 'status'; }, 3000);
  }
}

async function deleteHoliday(id) {
  if (!confirm('ลบวันหยุดนี้?')) return;
  await api('/api/holidays/' + id, { method: 'DELETE' });
  loadHolidays();
}

// ===== Leave =====
let leaveTypesCache = [];

async function loadLeave() {
  const y = document.getElementById('l-filter-year');
  if (!y.value) y.value = new Date().getFullYear();
  populateEmployeeSelect('l-emp');
  await loadLeaveTypesDropdown();
  loadLeaveRequests();
  loadLeaveBalance();
  loadLeaveTypesTable();
}

async function loadLeaveTypesDropdown() {
  try { leaveTypesCache = await (await api('/api/leave-types')).json(); } catch (e) { return; }
  const sel = document.getElementById('l-type');
  sel.innerHTML = leaveTypesCache.filter(t => t.active)
    .map(t => `<option value="${t.id}">${t.name}${t.is_paid ? '' : ' (ไม่รับค่าจ้าง)'}</option>`).join('');
}

async function openAddLeave() {
  await populateEmployeeSelect('l-emp');
  await loadLeaveTypesDropdown();
  document.getElementById('l-start').value = '';
  document.getElementById('l-end').value = '';
  document.getElementById('l-reason').value = '';
  document.getElementById('leave-status').className = 'status';
  openModal('leave-modal');
}

async function saveLeave() {
  const status = document.getElementById('leave-status');
  const payload = {
    finger_id:  document.getElementById('l-emp').value,
    type_id:    document.getElementById('l-type').value,
    start_date: document.getElementById('l-start').value,
    end_date:   document.getElementById('l-end').value,
    reason:     document.getElementById('l-reason').value.trim(),
  };
  if (!payload.finger_id || !payload.type_id || !payload.start_date || !payload.end_date) {
    status.className = 'status error'; status.textContent = '⚠️ กรอกข้อมูลให้ครบ'; return;
  }
  if (payload.end_date < payload.start_date) {
    status.className = 'status error'; status.textContent = '⚠️ วันสิ้นสุดต้องไม่ก่อนวันเริ่ม'; return;
  }
  const res = await api('/api/leave-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    document.getElementById('l-filter-year').value = new Date(payload.start_date).getFullYear();
    closeModal('leave-modal');
    loadLeaveRequests(); loadLeaveBalance();
  } else {
    status.className = 'status error'; status.textContent = '❌ บันทึกไม่สำเร็จ';
    setTimeout(() => { status.className = 'status'; }, 3000);
  }
}

async function loadLeaveRequests() {
  const year = document.getElementById('l-filter-year').value || new Date().getFullYear();
  document.getElementById('leave-year-label').textContent = year;
  const rows = await (await api('/api/leave-requests?year=' + year)).json();
  const tbody = document.getElementById('leave-body');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">ไม่มีรายการลา</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => {
    const sb = r.status === 'APPROVED' ? '<span class="badge badge-ok">อนุมัติ</span>'
      : (r.status === 'REJECTED' ? '<span class="badge badge-no">ปฏิเสธ</span>' : '<span class="badge badge-out">รอ</span>');
    const range = r.start_date === r.end_date ? r.start_date : `${r.start_date} → ${r.end_date}`;
    return `<tr>
      <td><strong>${r.name || '-'}</strong></td>
      <td>${r.type_name || '-'}${r.is_paid ? '' : ' <span class="muted">(ไม่รับค่าจ้าง)</span>'}</td>
      <td>${range}</td><td>${r.days}</td><td>${r.reason || '-'}</td><td>${sb}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        ${r.status !== 'APPROVED' ? `<button class="btn btn-success" onclick="setLeaveStatus(${r.id},'APPROVED')">✓</button>` : ''}
        ${r.status !== 'REJECTED' ? `<button class="btn btn-warning" onclick="setLeaveStatus(${r.id},'REJECTED')">✕</button>` : ''}
        <button class="btn btn-danger" onclick="deleteLeave(${r.id})">🗑️</button>
      </td></tr>`;
  }).join('');
}

async function setLeaveStatus(id, status) {
  await api(`/api/leave-requests/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  loadLeaveRequests(); loadLeaveBalance();
}
async function deleteLeave(id) {
  if (!confirm('ลบรายการลานี้?')) return;
  await api('/api/leave-requests/' + id, { method: 'DELETE' });
  loadLeaveRequests(); loadLeaveBalance();
}

async function loadLeaveBalance() {
  const year = document.getElementById('l-filter-year').value || new Date().getFullYear();
  const data = await (await api('/api/leave-balance?year=' + year)).json();
  document.getElementById('leave-balance-head').innerHTML =
    '<tr><th>พนักงาน</th>' + data.types.map(t => `<th>${t.name}</th>`).join('') + '</tr>';
  document.getElementById('leave-balance-body').innerHTML = data.balance.map(b =>
    '<tr><td><strong>' + b.name + '</strong></td>' + b.types.map(t => {
      const color = (t.quota > 0 && t.remaining <= 0) ? 'var(--danger)' : 'var(--text)';
      return `<td style="color:${color}">${t.used}/${t.quota || '∞'}</td>`;
    }).join('') + '</tr>').join('');
}

async function loadLeaveTypesTable() {
  document.getElementById('leave-types-body').innerHTML = leaveTypesCache.map(t => `<tr>
    <td>${t.name}</td>
    <td>${t.is_paid ? '<span class="badge badge-ok">มีค่าจ้าง</span>' : '<span class="badge badge-out">ไม่มี</span>'}</td>
    <td>${t.quota_days_per_year}</td>
    <td><button class="btn btn-danger" onclick="deleteLeaveType(${t.id})">🗑️</button></td></tr>`).join('');
}
function openAddLtype() {
  document.getElementById('lt-name').value = '';
  document.getElementById('lt-quota').value = '0';
  document.getElementById('lt-paid').value = 'true';
  openModal('ltype-modal');
}

async function saveLeaveType() {
  const name = document.getElementById('lt-name').value.trim();
  if (!name) { alert('กรอกชื่อประเภท'); return; }
  await api('/api/leave-types', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    name, quota_days_per_year: parseInt(document.getElementById('lt-quota').value) || 0,
    is_paid: document.getElementById('lt-paid').value === 'true',
  }) });
  closeModal('ltype-modal');
  await loadLeaveTypesDropdown(); loadLeaveTypesTable(); loadLeaveBalance();
}
async function deleteLeaveType(id) {
  if (!confirm('ลบประเภทการลานี้?')) return;
  await api('/api/leave-types/' + id, { method: 'DELETE' });
  await loadLeaveTypesDropdown(); loadLeaveTypesTable(); loadLeaveBalance();
}

// ===== Overtime =====
async function loadOvertime() {
  const year  = document.getElementById('o-filter-year').value || new Date().getFullYear();
  const month = document.getElementById('o-filter-month').value;
  const rows = await (await api(`/api/overtime?year=${year}&month=${month}`)).json();
  const tbody = document.getElementById('ot-body');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">ไม่มีรายการ OT</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => {
    const sb = r.status === 'APPROVED' ? '<span class="badge badge-ok">อนุมัติ</span>'
      : (r.status === 'REJECTED' ? '<span class="badge badge-no">ปฏิเสธ</span>' : '<span class="badge badge-out">รอ</span>');
    return `<tr>
      <td><strong>${r.name || '-'}</strong></td><td>${r.work_date}</td>
      <td>${(r.minutes/60).toFixed(1)} ชม.</td><td>×${r.multiplier}</td><td>${r.reason || '-'}</td><td>${sb}</td>
      <td style="display:flex;gap:4px;flex-wrap:wrap">
        ${r.status !== 'APPROVED' ? `<button class="btn btn-success" onclick="setOtStatus(${r.id},'APPROVED')">✓</button>` : ''}
        ${r.status !== 'REJECTED' ? `<button class="btn btn-warning" onclick="setOtStatus(${r.id},'REJECTED')">✕</button>` : ''}
        <button class="btn btn-danger" onclick="deleteOvertime(${r.id})">🗑️</button>
      </td></tr>`;
  }).join('');
}
async function openAddOt() {
  await populateEmployeeSelect('o-emp');
  document.getElementById('o-date').value = '';
  document.getElementById('o-hours').value = '';
  document.getElementById('o-mult').value = '1.5';
  document.getElementById('o-reason').value = '';
  document.getElementById('ot-status').className = 'status';
  openModal('ot-modal');
}

async function saveOvertime() {
  const status = document.getElementById('ot-status');
  const hours  = parseFloat(document.getElementById('o-hours').value);
  const payload = {
    finger_id:  document.getElementById('o-emp').value,
    work_date:  document.getElementById('o-date').value,
    minutes:    Math.round((hours || 0) * 60),
    multiplier: parseFloat(document.getElementById('o-mult').value) || 1.5,
    reason:     document.getElementById('o-reason').value.trim(),
  };
  if (!payload.finger_id || !payload.work_date || !payload.minutes) {
    status.className = 'status error'; status.textContent = '⚠️ กรอกข้อมูลให้ครบ'; return;
  }
  const res = await api('/api/overtime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    const d = new Date(payload.work_date);
    document.getElementById('o-filter-year').value = d.getFullYear();
    document.getElementById('o-filter-month').value = d.getMonth() + 1;
    closeModal('ot-modal');
    loadOvertime();
  } else {
    status.className = 'status error'; status.textContent = '❌ บันทึกไม่สำเร็จ';
    setTimeout(() => { status.className = 'status'; }, 3000);
  }
}
async function setOtStatus(id, status) {
  await api(`/api/overtime/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  loadOvertime();
}
async function deleteOvertime(id) {
  if (!confirm('ลบรายการ OT นี้?')) return;
  await api('/api/overtime/' + id, { method: 'DELETE' });
  loadOvertime();
}

// ===== Timesheet + Exceptions =====
async function loadTimesheet() {
  const year  = document.getElementById('t-year').value || new Date().getFullYear();
  const month = document.getElementById('t-month').value;
  const ts = await (await api(`/api/timesheets?year=${year}&month=${month}`)).json();
  document.getElementById('t-status-badge').innerHTML = ts.closed
    ? '<span class="badge badge-ok">🔒 ปิดงวดแล้ว</span>'
    : '<span class="badge badge-out">🔓 ยังเปิดอยู่</span>';
  loadExceptions();
}
async function loadExceptions() {
  const year  = document.getElementById('t-year').value || new Date().getFullYear();
  const month = document.getElementById('t-month').value;
  const data = await (await api(`/api/exceptions?year=${year}&month=${month}`)).json();
  const tbody = document.getElementById('exceptions-body');
  if (!data.exceptions.length) { tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:20px">✅ ไม่มีรายการที่ต้องตรวจ</td></tr>'; return; }
  tbody.innerHTML = data.exceptions.map(e => {
    const issue   = e.code === 'MISSING_OUT' ? '⚠️ มีเข้า ไม่มีออก' : '⚠️ มีออก ไม่มีเข้า';
    const fixType = e.code === 'MISSING_OUT' ? 'OUT' : 'IN';
    return `<tr>
      <td><strong>${e.name || ('ID ' + e.finger_id)}</strong></td><td>${e.date}</td><td>${issue}</td>
      <td><button class="btn btn-primary" onclick="openCorrection(${e.finger_id},'${e.date}','${fixType}')">✏️ เพิ่ม ${fixType}</button></td>
    </tr>`;
  }).join('');
}
async function closeTimesheet() {
  const year  = parseInt(document.getElementById('t-year').value)  || new Date().getFullYear();
  const month = parseInt(document.getElementById('t-month').value);
  if (!confirm(`ปิดงวด ${month}/${year}? ระบบจะบันทึก snapshot สรุปเงินเดือนของเดือนนี้ไว้`)) return;
  const status = document.getElementById('timesheet-status');
  const rep = await (await api(`/api/report?year=${year}&month=${month}`)).json();
  const res = await api('/api/timesheets/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year, month, report: rep.report }) });
  if (res.ok) { status.className = 'status success'; status.textContent = '🔒 ปิดงวดเรียบร้อย'; loadTimesheet(); }
  setTimeout(() => { status.className = 'status'; }, 3000);
}
async function reopenTimesheet() {
  const year  = parseInt(document.getElementById('t-year').value)  || new Date().getFullYear();
  const month = parseInt(document.getElementById('t-month').value);
  if (!confirm(`เปิดงวด ${month}/${year} ใหม่?`)) return;
  const status = document.getElementById('timesheet-status');
  const res = await api('/api/timesheets/reopen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year, month }) });
  if (res.ok) { status.className = 'status success'; status.textContent = '🔓 เปิดงวดใหม่แล้ว'; loadTimesheet(); }
  setTimeout(() => { status.className = 'status'; }, 3000);
}

// ===== Correction modal =====
function openCorrection(fid, date, type) {
  document.getElementById('corr-fid').value    = fid;
  document.getElementById('corr-date').value   = date || '';
  document.getElementById('corr-type').value   = type || 'OUT';
  document.getElementById('corr-time').value   = '';
  document.getElementById('corr-reason').value = '';
  document.getElementById('corr-modal').classList.add('show');
}
async function saveCorrection() {
  const payload = {
    finger_id:    document.getElementById('corr-fid').value,
    work_date:    document.getElementById('corr-date').value,
    type:         document.getElementById('corr-type').value,
    correct_time: document.getElementById('corr-time').value,
    reason:       document.getElementById('corr-reason').value.trim(),
  };
  if (!payload.work_date || !payload.correct_time) { alert('กรอกวันที่และเวลา'); return; }
  const res = await api('/api/corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    document.getElementById('corr-modal').classList.remove('show');
    if (!document.getElementById('tab-timesheet').classList.contains('hidden')) loadExceptions();
    if (!document.getElementById('tab-report').classList.contains('hidden')) loadReport();
  }
}

// ===== Adjustment (เบิก/หัก) modal =====
function openAdjust(fid, name, allowance, deduction, note) {
  document.getElementById('adj-fid').value = fid;
  document.getElementById('adj-title').textContent = 'เบิก/หัก: ' + name;
  document.getElementById('adj-allowance').value = allowance || 0;
  document.getElementById('adj-deduction').value = deduction || 0;
  document.getElementById('adj-note').value = note || '';
  document.getElementById('adj-modal').classList.add('show');
}
async function saveAdjustment() {
  const month = parseInt(document.getElementById('r-month').value);
  const year  = parseInt(document.getElementById('r-year').value);
  await api('/api/adjustment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    finger_id: document.getElementById('adj-fid').value, year, month,
    allowance: parseFloat(document.getElementById('adj-allowance').value) || 0,
    deduction: parseFloat(document.getElementById('adj-deduction').value) || 0,
    note:      document.getElementById('adj-note').value.trim(),
  }) });
  document.getElementById('adj-modal').classList.remove('show');
  loadReport();
}

// ===== Payslip =====
function openPayslip(fid) {
  if (!currentReportData) return;
  const u = currentReportData.report.find(r => r.finger_id === fid);
  if (!u) return;
  const M = MONTHS_TH;
  const line = (label, val, neg) =>
    `<div style="display:flex;justify-content:space-between;padding:5px 0"><span>${label}</span><span style="color:${neg ? 'var(--danger)' : 'var(--text)'}">${neg ? '-' : ''}${fmtMoney(val)}</span></div>`;
  const noDed = u.sso === 0 && u.pf === 0 && u.income_tax === 0 && u.unpaid_leave_deduction === 0 && u.deduction === 0;
  document.getElementById('payslip-content').innerHTML = `
    <div id="payslip-print">
      <h3 style="text-align:center;margin-bottom:2px">สลิปเงินเดือน</h3>
      <p class="muted" style="text-align:center;margin-bottom:12px">${M[currentReportData.month]} ${currentReportData.year}</p>
      <div style="border:1px solid var(--border);border-radius:10px;padding:14px">
        <div style="font-weight:700;font-size:16px">${u.name}</div>
        <div class="muted" style="font-size:12px;margin-bottom:10px">${u.employee_id || ''} ${u.department ? '· ' + u.department : ''}</div>
        <div style="font-weight:700;color:var(--success);border-bottom:1px solid var(--border);padding-bottom:4px;margin-bottom:4px">รายรับ</div>
        ${line('ฐานเงินเดือน', u.base_salary)}
        ${u.ot_pay > 0 ? line('ค่าล่วงเวลา OT (' + (u.ot_minutes/60).toFixed(1) + ' ชม.)', u.ot_pay) : ''}
        ${u.bonus_earned > 0 ? line('เบี้ยขยัน', u.bonus_earned) : ''}
        ${u.commission > 0 ? line('ค่าคอมมิชชั่น', u.commission) : ''}
        ${u.allowance > 0 ? line('เงินเบิก/เพิ่ม', u.allowance) : ''}
        <div style="display:flex;justify-content:space-between;font-weight:700;padding-top:4px"><span>รวมรายรับ</span><span>${fmtMoney(u.gross_pay)}</span></div>
        <div style="font-weight:700;color:var(--danger);border-bottom:1px solid var(--border);padding-bottom:4px;margin:10px 0 4px">รายการหัก</div>
        ${u.sso > 0 ? line('ประกันสังคม 5%', u.sso, true) : ''}
        ${u.pf > 0 ? line('กองทุนสำรองเลี้ยงชีพ ' + u.pf_percent + '%', u.pf, true) : ''}
        ${u.income_tax > 0 ? line('ภาษีเงินได้ (ประมาณการ)', u.income_tax, true) : ''}
        ${u.unpaid_leave_deduction > 0 ? line('ลาไม่รับค่าจ้าง (' + u.unpaid_leave_days + ' วัน)', u.unpaid_leave_deduction, true) : ''}
        ${u.deduction > 0 ? line('เงินหัก' + (u.adj_note ? ' (' + u.adj_note + ')' : ''), u.deduction, true) : ''}
        ${noDed ? '<div class="muted" style="padding:4px 0">— ไม่มีรายการหัก —</div>' : ''}
        <div style="display:flex;justify-content:space-between;font-weight:700;padding-top:4px"><span>รวมรายการหัก</span><span>${fmtMoney(u.total_deduction)}</span></div>
        <div style="display:flex;justify-content:space-between;font-weight:800;font-size:18px;border-top:2px solid var(--text);margin-top:10px;padding-top:8px"><span>เงินได้สุทธิ</span><span style="color:var(--success)">฿${fmtMoney(u.net_pay)}</span></div>
      </div>
      <div class="muted" style="font-size:11px;text-align:center;margin-top:8px">มา ${u.days_present} วัน · สาย ${u.days_late} วัน · ลา ${u.paid_leave_days + u.unpaid_leave_days} วัน</div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="printPayslip()">🖨️ พิมพ์</button>
      <button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="document.getElementById('payslip-modal').classList.remove('show')">ปิด</button>
    </div>`;
  document.getElementById('payslip-modal').classList.add('show');
}
function printPayslip() {
  const html = document.getElementById('payslip-print').innerHTML;
  const w = window.open('', '', 'width=480,height=760');
  if (!w) { alert('เบราว์เซอร์บล็อก popup — โปรดอนุญาต popup แล้วลองใหม่'); return; }
  w.document.write(`<html><head><title>สลิปเงินเดือน</title><meta charset="utf-8"><style>
    :root{--danger:#dc2626;--success:#16a34a;--text:#1e293b;--border:#e2e8f0;--text-muted:#64748b}
    body{font-family:'Segoe UI','Sarabun',sans-serif;padding:24px;color:#1e293b}
    .muted{color:#64748b}
  </style></head><body>${html}</body></html>`);
  w.document.close(); w.focus();
  setTimeout(() => { w.print(); }, 250);
}

// ===== Report & Payroll =====
let editingCommFid = null;
let currentReportData = null;

async function loadReport() {
  const month = document.getElementById('r-month').value;
  const year  = document.getElementById('r-year').value;
  document.getElementById('report-body').innerHTML =
    '<tr><td colspan="11" class="muted" style="text-align:center;padding:20px">กำลังโหลด...</td></tr>';

  const res  = await api(`/api/report?year=${year}&month=${month}`);
  const data = await res.json();
  currentReportData = data;
  renderReport(data);
}

function renderReport(data) {
  const tbody  = document.getElementById('report-body');
  const tfoot  = document.getElementById('report-foot');
  const sumDiv = document.getElementById('report-summary');

  if (!data.report.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:20px">ไม่มีข้อมูลพนักงาน</td></tr>';
    tfoot.innerHTML = '';
    sumDiv.innerHTML = '';
    return;
  }

  let tBase = 0, tOt = 0, tBonus = 0, tComm = 0, tDed = 0, tNet = 0, tPresent = 0;

  tbody.innerHTML = data.report.map(u => {
    tBase += u.base_salary; tOt += u.ot_pay; tBonus += u.bonus_earned;
    tComm += u.commission; tDed += u.total_deduction; tNet += u.net_pay; tPresent += u.days_present;

    const lateColor = u.days_late > 0 ? 'var(--danger)' : 'var(--success)';
    const lateTxt   = u.days_late > 0 ? `⚠️ ${u.days_late}` : '✅ 0';
    const leaveDays = u.paid_leave_days + u.unpaid_leave_days;
    const nm = u.name.replace(/'/g, "\\'");
    const cn = (u.commission_notes || '').replace(/'/g, "\\'");
    const an = (u.adj_note || '').replace(/'/g, "\\'");

    return `
      <tr>
        <td><div><strong>${u.name}</strong></div>
          <div class="muted" style="font-size:11px">${u.employee_id || ''} ${u.department ? '· '+u.department : ''}</div></td>
        <td style="text-align:center">${u.days_present}</td>
        <td style="text-align:center;color:${lateColor}">${lateTxt}</td>
        <td style="text-align:center">${leaveDays || '-'}</td>
        <td style="text-align:right">${fmtMoney(u.base_salary)}</td>
        <td style="text-align:right;color:${u.ot_pay > 0 ? 'var(--success)' : 'var(--text-muted)'}">${fmtMoney(u.ot_pay)}</td>
        <td style="text-align:right;color:${u.bonus_earned > 0 ? 'var(--success)' : 'var(--text-muted)'}">${fmtMoney(u.bonus_earned)}</td>
        <td style="text-align:right">${fmtMoney(u.commission)}</td>
        <td style="text-align:right;color:${u.total_deduction > 0 ? 'var(--danger)' : 'var(--text-muted)'}">${fmtMoney(u.total_deduction)}</td>
        <td style="text-align:right"><strong>${fmtMoney(u.net_pay)}</strong></td>
        <td><div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-success" style="padding:3px 8px;font-size:12px" onclick="openPayslip(${u.finger_id})" title="สลิป">🧾</button>
          <button class="btn btn-primary" style="padding:3px 8px;font-size:12px" onclick="showDaily(${u.finger_id})" title="รายวัน">📅</button>
          <button class="btn btn-warning" style="padding:3px 8px;font-size:12px" onclick="openAdjust(${u.finger_id},'${nm}',${u.allowance},${u.deduction},'${an}')" title="เบิก/หัก">💵</button>
          <button class="btn btn-ghost" style="padding:3px 8px;font-size:12px" onclick="openCommModal(${u.finger_id},'${nm}',${u.commission},'${cn}')" title="ค่าคอม">✏️</button>
        </div></td>
      </tr>`;
  }).join('');

  tfoot.innerHTML = `
    <tr style="background:var(--surface-2);font-weight:bold">
      <td>รวม (${data.report.length} คน)</td>
      <td style="text-align:center">${tPresent}</td><td></td><td></td>
      <td style="text-align:right">${fmtMoney(tBase)}</td>
      <td style="text-align:right">${fmtMoney(tOt)}</td>
      <td style="text-align:right">${fmtMoney(tBonus)}</td>
      <td style="text-align:right">${fmtMoney(tComm)}</td>
      <td style="text-align:right">${fmtMoney(tDed)}</td>
      <td style="text-align:right">${fmtMoney(tNet)}</td>
      <td></td>
    </tr>`;

  const monthNames = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  sumDiv.innerHTML = [
    { label: '👥 พนักงาน', value: data.report.length + ' คน', ico: 'blue' },
    { label: '⏱️ OT รวม', value: '฿' + fmtMoney(tOt), ico: 'green' },
    { label: '➖ หักรวม', value: '฿' + fmtMoney(tDed), ico: 'red' },
    { label: '💰 จ่ายสุทธิ', value: '฿' + fmtMoney(tNet), ico: 'amber' },
  ].map(c => `
    <div class="stat" style="flex:1;min-width:150px">
      <div class="stat-ico ${c.ico}">${c.label.split(' ')[0]}</div>
      <div><div class="stat-num" style="font-size:18px">${c.value}</div>
      <div class="stat-label">${c.label.substring(2)} ${monthNames[data.month]} ${data.year}</div></div>
    </div>`).join('');
}

function openCommModal(fid, name, amount, notes) {
  editingCommFid = fid;
  document.getElementById('comm-modal-title').textContent = `ค่าคอม: ${name}`;
  document.getElementById('comm-amount').value = amount;
  document.getElementById('comm-notes').value  = notes;
  document.getElementById('comm-modal').classList.add('show');
}

async function saveCommission() {
  if (!editingCommFid) return;
  const month  = parseInt(document.getElementById('r-month').value);
  const year   = parseInt(document.getElementById('r-year').value);
  const amount = parseFloat(document.getElementById('comm-amount').value) || 0;
  const notes  = document.getElementById('comm-notes').value;

  await api('/api/commission', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finger_id: editingCommFid, year, month, commission_amount: amount, notes }),
  });

  document.getElementById('comm-modal').classList.remove('show');
  editingCommFid = null;
  loadReport();
}

function showDaily(fingerId) {
  if (!currentReportData) return;
  const u = currentReportData.report.find(r => r.finger_id === fingerId);
  if (!u) return;

  const monthNames = ['','มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                      'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  document.getElementById('detail-title').textContent = `📅 ${u.name}`;
  document.getElementById('detail-meta').textContent  =
    `${monthNames[currentReportData.month]} ${currentReportData.year} · `+
    `มา ${u.days_present} วัน · สาย ${u.days_late} วัน · `+
    `เข้างาน ${u.work_start_time} (ผ่อนผัน ${u.late_grace_minutes} นาที)`;

  const tbody = document.getElementById('detail-body');
  if (!u.daily_records.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center;padding:16px">ไม่มีข้อมูล</td></tr>';
  } else {
    tbody.innerHTML = u.daily_records.map(r => {
      const dateObj  = new Date(r.date);
      const dateStr  = dateObj.toLocaleDateString('th-TH', { weekday:'short', day:'numeric', month:'short' });
      const lateBadge = r.is_late
        ? `<span class="badge badge-late">⚠️ สาย ${r.late_minutes} นาที</span>`
        : `<span class="badge badge-ontime">✅ ตรงเวลา</span>`;
      return `
        <tr>
          <td>${dateStr}</td>
          <td>${fmtHHMM(r.first_in)}</td>
          <td>${r.last_out ? fmtHHMM(r.last_out) : '<span class="muted">-</span>'}</td>
          <td>${r.work_hours !== null ? r.work_hours + ' ชม.' : '<span class="muted">-</span>'}</td>
          <td>${lateBadge}</td>
        </tr>`;
    }).join('');
  }

  document.getElementById('detail-modal').classList.add('show');
}

// ===== Init =====
document.getElementById('r-month').value = new Date().getMonth() + 1;
document.getElementById('r-year').value  = new Date().getFullYear();

initTheme();
checkSession();

setInterval(() => {
  if (document.getElementById('app-shell').classList.contains('hidden')) return;
  if (!document.getElementById('tab-dashboard').classList.contains('hidden'))      loadDashboard();
  else if (!document.getElementById('tab-logs').classList.contains('hidden'))       loadLogs();
}, 10000);
