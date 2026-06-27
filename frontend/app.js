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
  tbody.innerHTML = logs.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${l.name || 'Unknown'}</strong></td>
      <td>${l.finger_id}</td>
      <td>${l.device_id}</td>
      <td>${fmtTime(l.check_time)}</td>
      <td><span class="badge badge-in">เข้างาน</span></td>
    </tr>`).join('');
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
          <button class="btn btn-primary" onclick="editUser(${u.finger_id},'${u.name}','${u.employee_id || ''}','${u.department || ''}')">✏️</button>
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
  document.getElementById('enroll-step').textContent  = 'ขั้นตอนที่ 1/2';
  document.getElementById('fp-icon').style.display   = 'block';
  document.getElementById('fp-canvas').style.display = 'none';
  document.getElementById('enroll-modal').classList.add('show');

  await fetch(API_BASE + '/api/enroll-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finger_id: fingerId }),
  });

  document.getElementById('modal-status').textContent = '👆 วางนิ้วบน Sensor ได้เลย';

  enrollPolling = setInterval(async () => {
    const data = await fetch(API_BASE + '/api/enroll-pending').then(r => r.json());
    if (!data.pending && currentEnrollId !== null) {
      clearInterval(enrollPolling);
      document.getElementById('modal-status').textContent = '✅ ลงทะเบียนสำเร็จ!';
      document.getElementById('enroll-step').textContent  = 'เสร็จสิ้น ✅';

      const canvas = document.getElementById('fp-canvas');
      canvas.style.display = 'block';
      document.getElementById('fp-icon').style.display = 'none';
      drawFingerprint(canvas, fingerId * 137 + name.charCodeAt(0) * 31, true);

      setTimeout(() => {
        document.getElementById('enroll-modal').classList.remove('show');
        currentEnrollId = null;
        loadUsers();
      }, 2000);
    }
  }, 2000);
}

function cancelEnroll() {
  clearInterval(enrollPolling);
  currentEnrollId = null;
  document.getElementById('enroll-modal').classList.remove('show');
}

// ===== Save / Edit / Delete =====
function editUser(fid, name, empId, dept) {
  document.getElementById('f-finger-id').value = fid;
  document.getElementById('f-name').value       = name;
  document.getElementById('f-emp-id').value     = empId;
  document.getElementById('f-dept').value       = dept;
  document.querySelector('#tab-users').scrollTo(0, 0);
}

async function saveUser() {
  const finger_id   = document.getElementById('f-finger-id').value;
  const name        = document.getElementById('f-name').value;
  const employee_id = document.getElementById('f-emp-id').value;
  const department  = document.getElementById('f-dept').value;
  const status      = document.getElementById('user-status');

  if (!finger_id || !name) {
    status.className = 'status error';
    status.textContent = '⚠️ กรุณากรอก Finger ID และชื่อ';
    return;
  }

  const res = await fetch(API_BASE + '/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finger_id: parseInt(finger_id), name, employee_id, department }),
  });

  if (res.ok) {
    status.className = 'status success';
    status.textContent = '✅ บันทึกเรียบร้อย';
    ['f-finger-id', 'f-name', 'f-emp-id', 'f-dept'].forEach(id => {
      document.getElementById(id).value = '';
    });
    loadUsers();
  }
  setTimeout(() => { status.className = 'status'; }, 3000);
}

async function deleteUser(fid) {
  if (!confirm(`ลบ Finger ID ${fid} ใช่ไหม?`)) return;
  await fetch(API_BASE + '/api/users/' + fid, { method: 'DELETE' });
  loadUsers();
}

// ===== Init =====
loadLogs();
setInterval(() => {
  if (!document.getElementById('tab-logs').classList.contains('hidden')) loadLogs();
}, 10000);
