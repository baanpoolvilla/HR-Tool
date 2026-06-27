const API_BASE = 'https://attendance.poolvillapattayaparty.com';

// ===== Fingerprint canvas =====
function drawFingerprint(canvas, seed, enrolled) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!enrolled) {
    ctx.fillStyle = '#f5f5f5';
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

// ===== Tabs =====
function showTab(tab, el) {
  document.querySelectorAll('.content').forEach(e => e.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(e => e.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  el.classList.add('active');
  if (tab === 'logs') loadLogs();
  if (tab === 'users') loadUsers();
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('th-TH');
}

function fmtHHMM(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

// ===== Logs =====
async function loadLogs() {
  const [logsRes, statsRes] = await Promise.all([
    fetch(API_BASE + '/api/logs'),
    fetch(API_BASE + '/api/stats'),
  ]);
  const logs  = await logsRes.json();
  const stats = await statsRes.json();

  document.getElementById('stat-today').textContent = stats.today;
  document.getElementById('stat-total').textContent = stats.total;
  document.getElementById('stat-users').textContent = stats.registered;

  const tbody = document.getElementById('logs-body');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px">ยังไม่มีบันทึก</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map((l, i) => {
    const isOut  = l.check_type === 'OUT';
    const badge  = isOut
      ? '<span class="badge" style="background:#fff3e0;color:#e65100">🚪 OUT</span>'
      : '<span class="badge badge-in">✅ IN</span>';
    return `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${l.name || 'Unknown'}</strong></td>
      <td>${l.finger_id}</td>
      <td>${l.device_id}</td>
      <td>${fmtTime(l.check_time)}</td>
      <td>${badge}</td>
    </tr>`;
  }).join('');
}

// ===== Users =====
async function loadUsers() {
  const res   = await fetch(API_BASE + '/api/users');
  const users = await res.json();
  const tbody = document.getElementById('users-body');

  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:20px">ยังไม่มีพนักงาน</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const enrolled = u.enrolled || u.fp_pattern || u.confidence > 0;
    const seed     = u.finger_id * 137 + (u.name.charCodeAt(0) || 0) * 31;
    const badge    = enrolled
      ? '<span class="badge" style="background:#e8f5e9;color:#2e7d32">✅ ลงทะเบียนแล้ว</span>'
      : '<span class="badge" style="background:#fce8e6;color:#c62828">❌ ยังไม่ลงทะเบียน</span>';
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
          <button class="btn btn-primary" onclick="editUser(${u.finger_id},'${u.name}','${u.employee_id||''}','${u.department||''}',${u.base_salary||0},${u.attendance_bonus||0},'${u.work_start_time||'08:00'}',${u.late_grace_minutes||15})">✏️</button>
          <button class="btn btn-danger"  onclick="deleteUser(${u.finger_id})">🗑️</button>
        </td>
      </tr>`;
  }).join('');

  setTimeout(() => {
    users.forEach(u => {
      const canvas = document.getElementById(`fp-mini-${u.finger_id}`);
      if (!canvas) return;
      const seed    = u.finger_id * 137 + (u.name.charCodeAt(0) || 0) * 31;
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

  await fetch(API_BASE + '/api/enroll-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finger_id: fingerId }),
  });

  // Phase 1: รอ ESP32 รับคำสั่ง (poll /api/enroll-watch — ไม่แตะ queue)
  // Phase 2: รอ enroll สำเร็จ (poll /api/users จนกว่า enrolled=true)
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
      const watch = await fetch(API_BASE + '/api/enroll-watch').then(r => r.json());
      if (watch.picked_up || !watch.queued) {
        phase = 'enrolling';
        document.getElementById('enroll-step').textContent  = 'ขั้นตอนที่ 1/2';
        document.getElementById('modal-status').textContent = '👆 วางนิ้วบน Sensor ได้เลย';
      } else {
        document.getElementById('modal-status').textContent = `⏳ รอ ESP32 รับคำสั่ง... (${elapsed}s)`;
      }
    } else {
      const users = await fetch(API_BASE + '/api/users').then(r => r.json());
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
function editUser(fid, name, empId, dept, salary, bonus, startTime, grace) {
  document.getElementById('f-finger-id').value   = fid;
  document.getElementById('f-name').value         = name;
  document.getElementById('f-emp-id').value       = empId;
  document.getElementById('f-dept').value         = dept;
  document.getElementById('f-salary').value       = salary || 0;
  document.getElementById('f-bonus').value        = bonus  || 0;
  document.getElementById('f-start-time').value   = startTime || '08:00';
  document.getElementById('f-grace').value        = grace  || 15;
  document.querySelector('#tab-users').scrollTo(0, 0);
  window.scrollTo(0, 0);
}

async function saveUser() {
  const finger_id         = document.getElementById('f-finger-id').value;
  const name              = document.getElementById('f-name').value;
  const employee_id       = document.getElementById('f-emp-id').value;
  const department        = document.getElementById('f-dept').value;
  const base_salary       = parseFloat(document.getElementById('f-salary').value) || 0;
  const attendance_bonus  = parseFloat(document.getElementById('f-bonus').value)  || 0;
  const work_start_time   = document.getElementById('f-start-time').value || '08:00';
  const late_grace_minutes = parseInt(document.getElementById('f-grace').value) || 15;
  const status            = document.getElementById('user-status');

  if (!finger_id || !name) {
    status.className = 'status error';
    status.textContent = '⚠️ กรุณากรอก Finger ID และชื่อ';
    return;
  }

  const res = await fetch(API_BASE + '/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finger_id: parseInt(finger_id), name, employee_id, department,
                           base_salary, attendance_bonus, work_start_time, late_grace_minutes }),
  });

  if (res.ok) {
    status.className = 'status success';
    status.textContent = '✅ บันทึกเรียบร้อย';
    ['f-finger-id','f-name','f-emp-id','f-dept','f-salary','f-bonus','f-grace'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('f-start-time').value = '08:00';
    loadUsers();
  }
  setTimeout(() => { status.className = 'status'; }, 3000);
}

async function deleteUser(fid) {
  if (!confirm(`ลบ Finger ID ${fid} ใช่ไหม?`)) return;
  await fetch(API_BASE + '/api/users/' + fid, { method: 'DELETE' });
  loadUsers();
}

// ===== Clear Sensor =====
async function clearSensor() {
  if (!confirm('🗑️ ล้างลายนิ้วมือทั้งหมดในเครื่องสแกน?\nต้องวาง ESP32 ให้ออนไลน์ก่อน')) return;
  await fetch(API_BASE + '/api/sensor-clear-request', { method: 'POST' });
  alert('✅ ส่งคำสั่งแล้ว — รอ ESP32 รับคำสั่ง (ภายใน 3 วินาที)\nจอเครื่องจะขึ้น "SENSOR CLEARED"');
}

// ===== Admin Reset =====
async function resetAllData() {
  if (!confirm('⚠️ ลบข้อมูลทั้งหมด? (พนักงาน + บันทึกเวลา)\nไม่สามารถย้อนกลับได้!')) return;
  if (!confirm('ยืนยันอีกครั้ง — ลบจริงๆ ใช่ไหม?')) return;
  const res = await fetch(API_BASE + '/api/admin/reset', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'reset-confirm' }),
  });
  if (res.ok) {
    alert('✅ ล้างข้อมูลเรียบร้อยแล้ว');
    loadLogs();
    loadUsers();
  }
}

// ===== Report & Payroll =====
let editingCommFid = null;
let currentReportData = null;

async function loadReport() {
  const month = document.getElementById('r-month').value;
  const year  = document.getElementById('r-year').value;
  document.getElementById('report-body').innerHTML =
    '<tr><td colspan="8" style="text-align:center;color:#999;padding:20px">กำลังโหลด...</td></tr>';

  const res  = await fetch(API_BASE + `/api/report?year=${year}&month=${month}`);
  const data = await res.json();
  currentReportData = data;
  renderReport(data);
}

function renderReport(data) {
  const tbody  = document.getElementById('report-body');
  const tfoot  = document.getElementById('report-foot');
  const sumDiv = document.getElementById('report-summary');

  if (!data.report.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;padding:20px">ไม่มีข้อมูลพนักงาน</td></tr>';
    return;
  }

  let totBase = 0, totBonus = 0, totComm = 0, totPay = 0, totPresent = 0;

  tbody.innerHTML = data.report.map(u => {
    totBase    += u.base_salary;
    totBonus   += u.bonus_earned;
    totComm    += u.commission;
    totPay     += u.total_pay;
    totPresent += u.days_present;

    const lateColor  = u.days_late > 0 ? '#c62828' : '#2e7d32';
    const lateTxt    = u.days_late > 0 ? `⚠️ ${u.days_late} วัน` : '✅ ไม่สาย';
    const bonusTxt   = u.attendance_bonus > 0 && u.bonus_earned === 0
      ? `<span style="color:#999;font-size:12px">(สาย)</span>` : '';

    return `
      <tr>
        <td>
          <div><strong>${u.name}</strong></div>
          <div style="font-size:11px;color:#888">${u.employee_id || ''} ${u.department ? '· '+u.department : ''}</div>
        </td>
        <td style="text-align:center">${u.days_present} วัน</td>
        <td style="text-align:center;color:${lateColor}">${lateTxt}</td>
        <td style="text-align:right">${fmtMoney(u.base_salary)}</td>
        <td style="text-align:right">
          <span style="color:${u.bonus_earned > 0 ? '#2e7d32' : '#999'}">${fmtMoney(u.bonus_earned)}</span>
          ${bonusTxt}
        </td>
        <td style="text-align:right" id="comm-cell-${u.finger_id}">
          <span>${fmtMoney(u.commission)}</span>
          <button class="btn btn-primary" style="padding:2px 8px;font-size:12px;margin-left:6px"
            onclick="openCommModal(${u.finger_id},'${u.name}',${u.commission},'${u.commission_notes.replace(/'/g,"\\'")}')">✏️</button>
        </td>
        <td style="text-align:right"><strong>${fmtMoney(u.total_pay)}</strong></td>
        <td>
          <button class="btn btn-primary" style="padding:4px 10px;font-size:12px"
            onclick="showDaily(${u.finger_id})">📅 รายวัน</button>
        </td>
      </tr>`;
  }).join('');

  tfoot.innerHTML = `
    <tr style="background:#f5f5f5;font-weight:bold">
      <td>รวมทั้งหมด (${data.report.length} คน)</td>
      <td style="text-align:center">${totPresent} วัน</td>
      <td></td>
      <td style="text-align:right">${fmtMoney(totBase)}</td>
      <td style="text-align:right">${fmtMoney(totBonus)}</td>
      <td style="text-align:right">${fmtMoney(totComm)}</td>
      <td style="text-align:right">${fmtMoney(totPay)}</td>
      <td></td>
    </tr>`;

  const monthNames = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                      'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  sumDiv.innerHTML = [
    { label: '👥 พนักงาน', value: data.report.length + ' คน', color: '#e3f2fd' },
    { label: '📅 วันทำงาน', value: Math.round(totPresent / (data.report.length || 1)) + ' วัน/คน', color: '#e8f5e9' },
    { label: '💰 ยอดรวม', value: '฿' + fmtMoney(totPay), color: '#fff3e0' },
  ].map(c => `
    <div class="stat" style="background:${c.color};flex:1;min-width:140px">
      <div class="stat-num" style="font-size:18px">${c.value}</div>
      <div class="stat-label">${c.label} ${monthNames[data.month]} ${data.year}</div>
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

  await fetch(API_BASE + '/api/commission', {
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
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;padding:16px">ไม่มีข้อมูล</td></tr>';
  } else {
    tbody.innerHTML = u.daily_records.map(r => {
      const dateObj  = new Date(r.date);
      const dateStr  = dateObj.toLocaleDateString('th-TH', { weekday:'short', day:'numeric', month:'short' });
      const lateBadge = r.is_late
        ? `<span class="badge" style="background:#fce4ec;color:#c62828">⚠️ สาย ${r.late_minutes} นาที</span>`
        : `<span class="badge" style="background:#e8f5e9;color:#2e7d32">✅ ตรงเวลา</span>`;
      return `
        <tr>
          <td>${dateStr}</td>
          <td>${fmtHHMM(r.first_in)}</td>
          <td>${r.last_out ? fmtHHMM(r.last_out) : '<span style="color:#999">-</span>'}</td>
          <td>${r.work_hours !== null ? r.work_hours + ' ชม.' : '<span style="color:#999">-</span>'}</td>
          <td>${lateBadge}</td>
        </tr>`;
    }).join('');
  }

  document.getElementById('detail-modal').classList.add('show');
}

// ===== Init =====
document.getElementById('r-month').value = new Date().getMonth() + 1;
document.getElementById('r-year').value  = new Date().getFullYear();

loadLogs();
setInterval(() => {
  if (!document.getElementById('tab-logs').classList.contains('hidden')) loadLogs();
}, 10000);
