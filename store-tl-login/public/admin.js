'use strict';
const $ = (id) => document.getElementById(id);
let stores = [], users = [], newDescriptor = null, newPhoto = null;

function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text; t.className = 'msg ' + (bad ? 'err' : 'ok');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 4500);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
const fail = (e) => { if (e.status === 401) return showLogin(); toast(e.message, true); };

// ---------- Sign-in / session ----------
function showLogin() { $('appView').classList.add('hidden'); $('loginView').classList.remove('hidden'); }
async function showApp(name) {
  $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden');
  $('who').textContent = name ? `· ${name}` : '';
  await Promise.all([loadStores(), loadUsers(), loadAdminSettings()]);
}
function renderAdminOverview() {
  $('adminStoreCount').textContent = stores.length;
  $('adminLeadCount').textContent = users.length;
  $('adminActiveCount').textContent = users.filter((user) => user.active).length;
  $('adminFaceCount').textContent = users.filter((user) => user.face_enrolled).length;
}
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/admin/login', { method: 'POST', body: { username: $('au').value, password: $('ap').value } });
    $('ap').value = ''; $('loginMsg').classList.add('hidden'); showApp(r.username);
  } catch (err) { $('loginMsg').textContent = err.message; $('loginMsg').classList.remove('hidden'); }
});
$('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); showLogin(); };
api('/api/admin/me').then((m) => showApp(m.username)).catch(showLogin);

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', x === b));
  ['stores', 'users', 'logs', 'performance', 'account'].forEach((t) => $('tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
  if (b.dataset.tab === 'logs') loadLogs();
  if (b.dataset.tab === 'performance') loadPerformance();
  if (b.dataset.tab === 'account') loadAdminSettings();
}));

// ---------- Stores ----------
async function loadStores() {
  try { stores = await api('/api/admin/stores'); renderStores(); fillStoreSelect(); fillCityFilter(); renderAdminOverview(); } catch (e) { fail(e); }
}
function renderStores() {
  const count = (id) => users.filter((u) => u.store_id === id).length;
  $('storeTable').innerHTML = stores.length ? `<table><thead><tr><th>City</th><th>Store</th><th>Coordinates</th><th>Range</th><th>Team leads</th><th></th></tr></thead><tbody>${
    stores.map((s) => `<tr><td>${esc(s.city)}</td><td>${esc(s.store_name)}</td><td>${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}</td><td>${s.radius_m} m</td><td>${count(s.id)}</td>
      <td class="act"><button class="ghost small" data-edit="${s.id}">Edit</button><button class="danger small" data-del="${s.id}">Delete</button></td></tr>`).join('')
  }</tbody></table>` : '<div class="empty">No stores yet. Add your first store above.</div>';
}
$('storeTable').addEventListener('click', async (e) => {
  const ed = e.target.dataset.edit, del = e.target.dataset.del;
  if (ed) {
    const s = stores.find((x) => x.id == ed);
    $('sId').value = s.id; $('sCity').value = s.city; $('sName').value = s.store_name;
    $('sLat').value = s.lat; $('sLng').value = s.lng; $('sRad').value = s.radius_m;
    $('storeFormTitle').textContent = 'Edit store'; $('storeCancel').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  if (del && confirm('Delete this store?')) {
    try { await api('/api/admin/stores/' + del, { method: 'DELETE' }); toast('Store deleted.'); loadStores(); } catch (err) { fail(err); }
  }
});
function resetStoreForm() {
  $('storeForm').reset(); $('sId').value = ''; $('sRad').value = 100;
  $('storeFormTitle').textContent = 'Add a store'; $('storeCancel').classList.add('hidden');
}
$('storeCancel').onclick = resetStoreForm;

function parseCsvCell(value) {
  return String(value ?? '').trim().replace(/^"|"$/g, '').replace(/""/g, '"');
}

function parseCsvStores(text) {
  const rows = text.split(/\r?\n/).map((line) => {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells.map(parseCsvCell);
  }).filter((row) => row.some((cell) => cell !== ''));

  if (!rows.length) return [];

  const headerRow = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const startIndex = headerRow.some((h) => ['city', 'store_name', 'store', 'name', 'lat', 'latitude', 'lng', 'longitude', 'long'].includes(h)) ? 1 : 0;
  const entries = [];

  for (const row of rows.slice(startIndex)) {
    const normalized = {};
    const keys = [
      { key: 'city', alt: ['city'] },
      { key: 'store_name', alt: ['store_name', 'store name', 'name'] },
      { key: 'lat', alt: ['lat', 'latitude'] },
      { key: 'lng', alt: ['lng', 'longitude', 'long'] },
      { key: 'radius_m', alt: ['radius_m', 'radius', 'range_m'] },
    ];

    for (const item of keys) {
      const idx = item.alt.map((label) => headerRow.indexOf(label)).find((index) => index >= 0);
      if (idx !== undefined && idx >= 0 && row[idx] !== undefined) normalized[item.key] = row[idx];
    }

    if (!normalized.city && !normalized.store_name && !normalized.lat && !normalized.lng) continue;

    entries.push({
      city: (normalized.city || row[0] || '').trim(),
      store_name: (normalized.store_name || row[1] || '').trim(),
      lat: normalized.lat || row[2] || '',
      lng: normalized.lng || row[3] || '',
      radius_m: normalized.radius_m || row[4] || 100,
    });
  }

  return entries.filter((entry) => entry.city && entry.store_name && entry.lat !== '' && entry.lng !== '');
}

async function importStoresCsv() {
  const file = $('storeCsvInput').files[0];
  if (!file) return toast('Choose a CSV file first.', true);
  try {
    const text = await file.text();
    const rows = parseCsvStores(text);
    if (!rows.length) throw new Error('No valid store rows were found in the CSV file.');

    const result = await api('/api/admin/stores/import', { method: 'POST', body: { stores: rows } });
    $('storeCsvInput').value = '';
    toast(result.imported ? `Imported ${result.imported} stores.` : 'CSV import is complete.', !result.imported);
    if (result.skipped) toast(`${result.skipped} rows were skipped.`, true);
    loadStores();
  } catch (err) {
    fail(err);
  }
}

$('importStoresCsv').onclick = importStoresCsv;
$('useHere').onclick = async () => {
  try {
    const p = (await getPosition()).coords;
    $('sLat').value = p.latitude.toFixed(6); $('sLng').value = p.longitude.toFixed(6);
    toast(`Coordinates filled from this device (±${Math.round(p.accuracy)} m). Stand inside the store for the best result.`);
  } catch (e) { toast(e.message, true); }
};
$('storeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { city: $('sCity').value, store_name: $('sName').value, lat: $('sLat').value, lng: $('sLng').value, radius_m: $('sRad').value };
  const id = $('sId').value;
  try {
    await api(id ? '/api/admin/stores/' + id : '/api/admin/stores', { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Store updated.' : 'Store saved.'); resetStoreForm(); loadStores();
  } catch (err) { fail(err); }
});

// ---------- Team leads ----------
async function loadUsers() {
  try { users = await api('/api/admin/users'); renderUsers(); renderStores(); renderAdminOverview(); } catch (e) { fail(e); }
}
function fillStoreSelect() {
  const cities = [...new Set(stores.map((s) => s.city))];
  $('uStore').innerHTML = '<option value="">Choose a store</option>' + cities.map((c) =>
    `<optgroup label="${esc(c)}">${stores.filter((s) => s.city === c).map((s) => `<option value="${s.id}">${esc(s.store_name)}</option>`).join('')}</optgroup>`).join('');
}
function fillCityFilter() {
  const cur = $('cityFilter').value;
  $('cityFilter').innerHTML = '<option value="">All cities</option>' + [...new Set(stores.map((s) => s.city))].map((c) => `<option>${esc(c)}</option>`).join('');
  $('cityFilter').value = cur;
}
function storeOptions(sel) {
  return stores.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.city)} – ${esc(s.store_name)}</option>`).join('');
}
function renderUsers() {
  const city = $('cityFilter').value, q = $('search').value.toLowerCase();
  const list = users.filter((u) => (!city || u.city === city) && (!q || u.name.toLowerCase().includes(q) || u.login_id.toLowerCase().includes(q)));
  $('userTable').innerHTML = list.length ? `<table><thead><tr><th>Name</th><th>Login ID</th><th>Store</th><th>Mobile</th><th>Shift</th><th>Rider photo</th><th>Status</th><th></th></tr></thead><tbody>${
    list.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.login_id)}</td>
      <td><select data-move="${u.id}" aria-label="Store for ${esc(u.name)}">${storeOptions(u.store_id)}</select></td>
      <td><input type="tel" data-phone="${u.id}" value="${esc(u.phone || '')}" placeholder="+919876543210" aria-label="Mobile for ${esc(u.name)}"></td>
      <td><select data-shift="${u.id}" aria-label="Shift for ${esc(u.name)}"><option value="">Choose shift</option>
        <option value="morning" ${u.shift_code === 'morning' ? 'selected' : ''}>6 AM – 3 PM</option>
        <option value="midday" ${u.shift_code === 'midday' ? 'selected' : ''}>10 AM – 7 PM</option>
        <option value="evening" ${u.shift_code === 'evening' ? 'selected' : ''}>3 PM – 12:30 AM</option></select></td>
      <td class="photo-cell">${u.photo_data ? `<img class="rider-photo-thumb" src="${esc(u.photo_data)}" alt="Captured rider photo for ${esc(u.name)}" title="Captured rider photo">` : `<span class="pill warn">${u.face_enrolled ? 'Recapture photo' : 'Missing'}</span>`}</td>
      <td><span class="pill ${u.active ? 'good' : 'bad'}">${u.active ? 'Active' : 'Off'}</span></td>
      <td class="act"><button class="ghost small" data-face="${u.id}">${u.face_enrolled ? 'Update photo' : 'Capture photo'}</button>
        <button class="ghost small" data-pass="${u.id}">Set password</button>
        <button class="ghost small" data-toggle="${u.id}">${u.active ? 'Turn off' : 'Turn on'}</button>
        <button class="danger small" data-remove="${u.id}">Delete</button></td></tr>`).join('')
  }</tbody></table>` : '<div class="empty">No team leads match. Add one above.</div>';
}
$('cityFilter').onchange = renderUsers; $('search').oninput = renderUsers;

$('userTable').addEventListener('click', async (e) => {
  const d = e.target.dataset, u = users.find((x) => x.id == (d.face || d.pass || d.toggle || d.remove));
  try {
    if (d.face) {
      const captured = await captureFace(`Enrol face for ${u.name}`);
      if (captured) { await api('/api/admin/users/' + u.id, { method: 'PUT', body: captured }); toast('Photo and face saved.'); loadUsers(); }
    } else if (d.pass) {
      const p = prompt(`New password for ${u.name} (8+ characters):`);
      if (p) { await api('/api/admin/users/' + u.id, { method: 'PUT', body: { password: p } }); toast('Password updated.'); }
    } else if (d.toggle) {
      await api('/api/admin/users/' + u.id, { method: 'PUT', body: { active: !u.active } }); loadUsers();
    } else if (d.remove && confirm(`Delete ${u.name}? This cannot be undone.`)) {
      await api('/api/admin/users/' + u.id, { method: 'DELETE' }); toast('Team lead deleted.'); loadUsers();
    }
  } catch (err) { fail(err); }
});
$('userTable').addEventListener('change', async (e) => {
  const field = e.target.dataset;
  if (!field.move && !field.phone && !field.shift) return;
  const id = field.move || field.phone || field.shift;
  const body = field.move ? { store_id: Number(e.target.value) } : field.phone ? { phone: e.target.value.trim() } : { shift_code: e.target.value };
  try { await api('/api/admin/users/' + id, { method: 'PUT', body }); toast(field.move ? 'Store changed.' : field.phone ? 'Mobile number saved.' : 'Shift saved.'); loadUsers(); }
  catch (err) { fail(err); }
});

$('genPass').onclick = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$%';
  const a = crypto.getRandomValues(new Uint32Array(12));
  $('uPass').value = Array.from(a, (n) => chars[n % chars.length]).join('');
};
$('enrolNew').onclick = async () => {
  const captured = await captureFace('Enrol face');
  if (captured) { newDescriptor = captured.descriptor; newPhoto = captured.photo_data; $('enrolStatus').textContent = 'Photo captured'; $('enrolStatus').className = 'pill good'; }
};
$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/users', { method: 'POST', body: {
      name: $('uName').value, loginId: $('uId').value, password: $('uPass').value,
      store_id: Number($('uStore').value), descriptor: newDescriptor, photo_data: newPhoto,
      phone: $('uPhone').value.trim(), shift_code: $('uShift').value } });
    toast(`Team lead created. ID: ${$('uId').value}`);
    $('userForm').reset(); newDescriptor = null; newPhoto = null;
    $('enrolStatus').textContent = 'Face not captured'; $('enrolStatus').className = 'pill warn';
    loadUsers();
  } catch (err) { fail(err); }
});

// ---------- Face dialog ----------
function captureFace(title) {
  return new Promise(async (resolve) => {
    const dlg = $('faceDlg'), video = $('faceVideo'), go = $('faceGo'), m = $('faceMsg');
    $('faceTitle').textContent = title; m.classList.add('hidden'); go.disabled = true; $('facePh').classList.remove('hidden');
    let done = false;
    const finish = (v) => { if (done) return; done = true; Face.stopCamera(video); dlg.close(); resolve(v); };
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Capturing…';
      try {
        const descriptor = await Face.enrol(video);
        if (!descriptor) throw new Error('Could not get a clear face. Improve the light and try again.');
        const photo_data = Face.capturePhoto(video);
        finish({ descriptor, photo_data });
      } catch (error) {
        m.textContent = error.message || 'Could not capture the face photo.';
        m.classList.remove('hidden');
        go.disabled = false;
      } finally {
        go.textContent = 'Capture';
      }
    };
    $('faceCancel').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    dlg.showModal();
    try {
      await Face.load(); await Face.startCamera(video);
      $('facePh').classList.add('hidden'); go.disabled = false;
    } catch (e) { m.textContent = e.message || 'Camera or face model failed to load.'; m.classList.remove('hidden'); }
  });
}

// ---------- Logs ----------
const reasons = { bad_credentials: 'Wrong ID or password', inactive: 'Account off', no_location: 'No location sent', weak_gps: 'Weak GPS signal',
  outside_range: 'Outside store range', face_not_enrolled: 'Face not enrolled', face_mismatch: 'Face did not match' };
async function loadLogs() {
  try {
    const logs = await api('/api/admin/logs');
    $('logTable').innerHTML = logs.length ? `<table><thead><tr><th>Time</th><th>ID</th><th>Store</th><th>Result</th><th>Reason</th><th>Distance</th><th>Face score</th></tr></thead><tbody>${
      logs.map((l) => `<tr><td>${new Date(l.ts).toLocaleString()}</td><td>${esc(l.login_id)}</td><td>${l.store_name ? esc(l.city + ' – ' + l.store_name) : '—'}</td>
        <td><span class="pill ${l.result === 'allowed' ? 'good' : 'bad'}">${l.result === 'allowed' ? 'Signed in' : 'Refused'}</span></td>
        <td>${esc(reasons[l.reason] || '')}</td><td>${l.distance_m == null ? '—' : Math.round(l.distance_m) + ' m'}</td>
        <td>${l.face_distance == null ? '—' : l.face_distance.toFixed(2)}</td></tr>`).join('')
    }</tbody></table>` : '<div class="empty">No sign-in attempts yet.</div>';
  } catch (e) { fail(e); }
}
$('refreshLogs').onclick = loadLogs;
$('filterPerformance').onclick = loadPerformance;
$('refreshPerformance').onclick = loadPerformance;

async function loadPerformance() {
  const from = $('performanceFrom').value, to = $('performanceTo').value;
  if (from && to && from > to) return toast('The start date must be before the end date.', true);
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  try {
    const reports = await api('/api/admin/performance' + (params.size ? '?' + params.toString() : ''));
    const average = reports.length ? reports.reduce((sum, r) => sum + r.breach_percent, 0) / reports.length : 0;
    $('performanceMetrics').innerHTML = `<div class="metric"><span>Reports submitted</span><strong>${reports.length}</strong></div>
      <div class="metric"><span>Average breach</span><strong>${reports.length ? average.toFixed(2) + '%' : '—'}</strong></div>
      <div class="metric"><span>Reports with breach</span><strong>${reports.filter((r) => r.breach_percent > 0).length}</strong></div>`;
    $('performanceTable').innerHTML = reports.length ? `<table><thead><tr><th>Date</th><th>Team lead</th><th>Login ID</th><th>Store</th><th>Shift</th><th>Breach</th><th>Root cause analysis</th><th>Updated</th></tr></thead><tbody>${
      reports.map((r) => `<tr><td>${esc(r.report_date)}</td><td>${esc(r.name)}</td><td>${esc(r.login_id)}</td>
        <td>${esc(r.city)} · ${esc(r.store_name)}</td><td>${esc(shifts[r.shift_code] || '—')}</td>
        <td><span class="breach-badge ${r.breach_percent > 0 ? 'has-breach' : ''}">${Number(r.breach_percent).toFixed(2)}%</span></td>
        <td class="cause-cell">${r.delay_root_cause ? esc(r.delay_root_cause).replace(/\n/g, '<br>') : '<span class="muted">No delay reported</span>'}</td>
        <td>${new Date(r.updated_at).toLocaleString()}</td></tr>`).join('')
    }</tbody></table>` : '<div class="empty">No performance reports for this date range.</div>';
  } catch (e) { fail(e); }
}

const shifts = { morning: '6 AM – 3 PM', midday: '10 AM – 7 PM', evening: '3 PM – 12:30 AM' };
$('downloadLogs').onclick = () => {
  const from = $('logFrom').value, to = $('logTo').value;
  if (from && to && from > to) return toast('The start date must be before the end date.', true);
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  window.location.href = '/api/admin/logs.csv' + (params.size ? '?' + params.toString() : '');
};

async function loadAdminSettings() {
  try { const settings = await api('/api/admin/settings'); $('adminPhone').value = settings.admin_phone; }
  catch (e) { fail(e); }
}
$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/settings', { method: 'PUT', body: { admin_phone: $('adminPhone').value.trim() } });
    toast('Admin alert number saved.');
  } catch (err) { fail(err); }
});

// ---------- Admin password ----------
$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/admin/password', { method: 'POST', body: { current: $('pwCur').value, next: $('pwNew').value } });
    $('pwForm').reset(); toast('Password changed.'); } catch (err) { toast(err.message, true); }
});
