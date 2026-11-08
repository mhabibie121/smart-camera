import { api, $, $$, esc, toast, logout, confirmBox, promptBox, alertBox } from './common.js';

const data = { cameras: [], groups: [], users: [] };
const NO_LOC = 'Tanpa lokasi';

// ---------- Helper dialog ----------
// Submit tombol "cancel" menutup dialog. Tombol lain menjalankan onSave;
// dialog baru ditutup kalau onSave berhasil.
function bindDialog(dialog, onSave) {
  const form = $('form', dialog);
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    try {
      await onSave(form);
      dialog.close();
    } catch (ex) {
      toast(ex.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// ---------- Tabs ----------
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  location.hash = name;
  if (name === 'settings') { loadSettings(); loadHikSettings(); loadGuestSettings(); }
  if (name === 'record') loadRecord();
}
$('#tabs').addEventListener('click', (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));

// ---------- Load ----------
async function loadAll() {
  [data.cameras, data.groups, data.users] = await Promise.all([
    api('GET', '/api/admin/cameras'),
    api('GET', '/api/admin/groups'),
    api('GET', '/api/admin/users'),
  ]);
  renderCameras();
  renderGroups();
  renderUsers();
}

const groupName = (id) => data.groups.find((g) => g.id === id)?.name || '?';
const dot = (online) => `<span class="dot ${online === true ? 'on' : online === false ? 'off' : ''}"
  title="${online === true ? 'Online' : online === false ? 'Offline' : 'Belum dicek'}"></span>`;

// ---------- Kamera ----------
const camSel = new Set(); // id kamera yang dicentang
let camVisible = [];

function updateCamBulk() {
  for (const id of camSel) if (!data.cameras.some((c) => c.id === id)) camSel.delete(id);
  $('#camBulk').hidden = camSel.size === 0;
  $('#camSelCount').textContent = `${camSel.size} kamera dipilih`;
  const all = $('#camSelAll');
  const n = camVisible.filter((c) => camSel.has(c.id)).length;
  all.checked = camVisible.length > 0 && n === camVisible.length;
  all.indeterminate = n > 0 && n < camVisible.length;
}

function renderCameras() {
  const q = $('#camSearch').value.trim().toLowerCase();
  const list = data.cameras.filter((c) =>
    !q || [c.name, c.location, c.ip].some((v) => (v || '').toLowerCase().includes(q)));
  const online = data.cameras.filter((c) => c.online === true).length;
  $('#camCount').textContent = `${list.length} dari ${data.cameras.length} kamera · ${online} online`;
  $('#camRows').innerHTML = list.map((c, i) => `
    <tr class="${camSel.has(c.id) ? 'picked' : ''}">
      <td class="sel"><input type="checkbox" class="cam-pick" value="${c.id}" ${camSel.has(c.id) ? 'checked' : ''}></td>
      <td class="no muted">${i + 1}</td>
      <td>${dot(c.online)}</td>
      <td>${esc(c.name)}${c.ptz ? ' <span class="badge ptz" title="Kamera PTZ">PTZ</span>' : ''}</td>
      <td>${esc(c.location)}</td>
      <td>${esc(c.ip)}</td>
      <td>${c.port}</td>
      <td>${c.rtsp_main || c.hik_code ? '<span class="muted">-</span>' : c.channel}</td>
      <td class="muted">${c.hik_code ? `<span class="badge hik" title="${esc(c.hik_code)}">HikCentral</span>` : c.rtsp_main ?`<span class="badge url" title="${esc(c.rtsp_main)}">URL RTSP</span>`
        : c.username ? esc(c.username) : 'default'}</td>
      <td>${c.group_ids.map((id) => `<span class="badge">${esc(groupName(id))}</span>`).join(' ') || '<span class="muted">-</span>'}</td>
      <td>${c.enabled ? 'Ya' : '<span class="muted">Tidak</span>'}</td>
      <td><div class="actions">
        <button data-edit="${c.id}">Edit</button>
        <button class="danger" data-del="${c.id}">Hapus</button>
      </div></td>
    </tr>`).join('') || '<tr><td colspan="12" class="muted">Belum ada kamera. Tambah manual atau import CSV.</td></tr>';
  camVisible = list;
  updateCamBulk();
  $('#locList').innerHTML = [...new Set(data.cameras.map((c) => c.location).filter(Boolean))]
    .map((l) => `<option value="${esc(l)}">`).join('');
}

let editingCam = null;
function openCamDialog(cam) {
  editingCam = cam;
  const f = $('#camForm');
  f.reset();
  $('#camDialogTitle').textContent = cam ? 'Edit kamera' : 'Tambah kamera';
  f.name.value = cam?.name || '';
  f.location.value = cam?.location || '';
  f.ip.value = cam?.ip || '';
  f.port.value = cam?.port || 554;
  f.channel.value = cam?.channel || 1;
  f.username.value = cam?.username || '';
  f.password.value = '';
  f.password.placeholder = cam?.has_password ? '(tidak diubah)' : '(default)';
  f.enabled.checked = cam ? !!cam.enabled : true;
  f.ptz.checked = !!cam?.ptz;
  f.http_port.value = cam?.http_port || 80;
  f.rtsp_main.value = cam?.rtsp_main || '';
  f.rtsp_sub.value = cam?.rtsp_sub || '';
  f.hik_code.value = cam?.hik_code || '';
  setCamMode(cam?.hik_code ? 'hik' : cam?.rtsp_main ? 'url' : 'dahua');
  $('#camPwHint').textContent = cam?.has_password
    ? 'Password kamera ini tersimpan. Kosongkan kalau tidak ingin mengubahnya.'
    : 'Kosongkan untuk memakai login default dari Pengaturan.';
  $('#camDialog').showModal();
}

function setCamMode(mode) {
  const f = $('#camForm');
  f.mode.value = mode;
  $('#modeUrl').hidden = mode !== 'url';
  $('#modeDahua').hidden = mode !== 'dahua';
  $('#modeHik').hidden = mode !== 'hik';
  f.ip.required = mode === 'dahua';
  f.rtsp_main.required = mode === 'url';
  f.hik_code.required = mode === 'hik';
  $('#httpPortLabel').hidden = mode === 'hik';
}
$('#camForm').addEventListener('change', (e) => {
  if (e.target.name === 'mode') setCamMode(e.target.value);
});

bindDialog($('#camDialog'), async (f) => {
  const body = {
    name: f.name.value, location: f.location.value, enabled: f.enabled.checked,
    ptz: f.ptz.checked, http_port: f.http_port.value || 80,
  };
  if (f.mode.value === 'hik') {
    body.hik_code = f.hik_code.value.trim();
  } else if (f.mode.value === 'url') {
    body.hik_code = '';
    body.rtsp_main = f.rtsp_main.value.trim();
    body.rtsp_sub = f.rtsp_sub.value.trim();
  } else {
    Object.assign(body, {
      hik_code: '', rtsp_main: '', ip: f.ip.value, port: f.port.value, channel: f.channel.value, username: f.username.value,
    });
    // Password kosong saat edit = tidak diubah
    if (f.password.value || !editingCam) body.password = f.password.value;
  }
  if (editingCam) await api('PUT', `/api/admin/cameras/${editingCam.id}`, body);
  else await api('POST', '/api/admin/cameras', body);
  toast('Kamera disimpan');
  await loadAll();
});

$('#camAdd').addEventListener('click', () => openCamDialog(null));
$('#camSearch').addEventListener('input', renderCameras);
$('#camRows').addEventListener('change', (e) => {
  if (!e.target.classList.contains('cam-pick')) return;
  const id = Number(e.target.value);
  e.target.checked ? camSel.add(id) : camSel.delete(id);
  e.target.closest('tr').classList.toggle('picked', e.target.checked);
  updateCamBulk();
});
$('#camSelAll').addEventListener('change', (e) => {
  for (const c of camVisible) e.target.checked ? camSel.add(c.id) : camSel.delete(c.id);
  renderCameras();
});
$('#camBulk').addEventListener('click', async (e) => {
  const action = e.target.dataset.bulk;
  if (!action) return;
  if (action === 'clear') { camSel.clear(); renderCameras(); return; }
  const ids = [...camSel];
  const names = data.cameras.filter((c) => camSel.has(c.id)).map((c) => c.name);
  const label = { delete: 'HAPUS', enable: 'aktifkan', disable: 'nonaktifkan' }[action];
  const preview = names.slice(0, 15).join('\n') + (names.length > 15 ? `\n... dan ${names.length - 15} lainnya` : '');
  if (!(await confirmBox(`${preview}${action === 'delete' ? '\n\nKamera yang dihapus tidak bisa dikembalikan (kecuali dari backup).' : ''}`,
    { title: `${label[0].toUpperCase() + label.slice(1).toLowerCase()} ${ids.length} kamera?`, ok: label[0].toUpperCase() + label.slice(1).toLowerCase(), danger: action === 'delete' }))) return;
  try {
    const r = await api('POST', '/api/admin/cameras/bulk', { action, ids });
    toast(`${r.count} kamera di${action === 'delete' ? 'hapus' : action === 'enable' ? 'aktifkan' : 'nonaktifkan'}`);
    if (action === 'delete') camSel.clear();
    await loadAll();
  } catch (ex) { toast(ex.message, true); }
});
$('#camRows').addEventListener('click', async (e) => {
  const edit = e.target.dataset.edit, del = e.target.dataset.del;
  if (edit) openCamDialog(data.cameras.find((c) => c.id === Number(edit)));
  if (del) {
    const c = data.cameras.find((x) => x.id === Number(del));
    if (!(await confirmBox(`Kamera "${c.name}" akan dihapus.`, { title: 'Hapus kamera?', ok: 'Hapus', danger: true }))) return;
    await api('DELETE', `/api/admin/cameras/${del}`).catch((ex) => toast(ex.message, true));
    toast('Kamera dihapus');
    loadAll();
  }
});

// Import CSV
$('#camImport').addEventListener('click', () => {
  $('#importForm').reset();
  $('#importDialog').showModal();
});
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) $('#importText').value = await file.text();
});
bindDialog($('#importDialog'), async () => {
  const text = $('#importText').value.trim();
  if (!text) throw new Error('Isi CSV masih kosong');
  const r = await api('POST', '/api/admin/cameras/import', text);
  toast(`Import selesai: ${r.added} ditambah, ${r.updated} di-update` +
    (r.errors.length ? `, ${r.errors.length} gagal` : ''), r.errors.length > 0);
  if (r.errors.length) await alertBox(r.errors.slice(0, 30).join('\n'), { title: `${r.errors.length} baris gagal di-import` });
  await loadAll();
});

// ---------- Tambah NVR ----------
let nvrData = null; // hasil baca terakhir

function nvrLoginBody() {
  const f = $('#nvrForm');
  return {
    ip: f.ip.value.trim(), http_port: f.http_port.value, rtsp_port: f.rtsp_port.value,
    username: f.username.value.trim(), password: f.password.value,
  };
}

function renderNvrRows() {
  if (!nvrData) return;
  const q = $('#nvrSearch').value.trim().toLowerCase();
  $('#nvrRows').innerHTML = nvrData.channels.map((c, i) => {
    const hide = q && ![c.name, c.cam_ip, c.model].some((v) => (v || '').toLowerCase().includes(q));
    const status = c.registered ? `<span class="badge" title="${esc(c.registered_name)}">Sudah terdaftar</span>`
      : c.empty ? '<span class="muted">Kosong</span>' : '<span class="badge ptz">Baru</span>';
    return `<tr data-i="${i}" ${hide ? 'hidden' : ''} class="${c.pick ? 'picked' : ''}">
      <td class="sel"><input type="checkbox" class="nvr-pick" ${c.pick ? 'checked' : ''}></td>
      <td class="no">${c.channel}</td>
      <td><input class="nvr-name" value="${esc(c.name)}"></td>
      <td class="muted">${esc(c.cam_ip || '-')}</td>
      <td class="muted">${esc(c.model || '-')}</td>
      <td class="sel"><input type="checkbox" class="nvr-ptz" ${c.ptz ? 'checked' : ''} title="Tandai sebagai kamera PTZ"></td>
      <td>${status}</td>
    </tr>`;
  }).join('');
  updateNvrCount();
}

function updateNvrCount() {
  const n = nvrData.channels.filter((c) => c.pick).length;
  $('#nvrCount').textContent = `${n} dari ${nvrData.channels.length} channel dipilih`;
  $('#nvrImportBtn').disabled = n === 0;
  $('#nvrImportBtn').textContent = n ? `Import ${n} kamera` : 'Import';
  const shown = $$('#nvrRows tr:not([hidden])').map((tr) => nvrData.channels[Number(tr.dataset.i)]);
  $('#nvrAll').checked = shown.length > 0 && shown.every((c) => c.pick);
}

$('#nvrAdd').addEventListener('click', () => {
  const f = $('#nvrForm');
  f.reset();
  nvrData = null;
  $('#nvrPick').hidden = true;
  $('#nvrInfo').textContent = '';
  $('#nvrImportBtn').disabled = true;
  $('#nvrImportBtn').textContent = 'Import';
  f.group_id.innerHTML = '<option value="">- Tidak dimasukkan ke grup -</option>' +
    data.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  $('#nvrDialog').showModal();
  f.ip.focus();
});

$('#nvrScan').addEventListener('click', async () => {
  const body = nvrLoginBody();
  if (!body.ip) return toast('Isi IP NVR dulu', true);
  const btn = $('#nvrScan');
  btn.disabled = true;
  $('#nvrInfo').textContent = 'Membaca channel dari NVR...';
  try {
    nvrData = await api('POST', '/api/admin/nvr/scan', body);
    // Default: centang channel yang berisi kamera dan belum terdaftar
    for (const c of nvrData.channels) c.pick = !c.empty && !c.registered;
    const reg = nvrData.channels.filter((c) => c.registered).length;
    const empty = nvrData.channels.filter((c) => c.empty).length;
    $('#nvrInfo').innerHTML = `<b>${esc(nvrData.type || 'NVR Dahua')}</b> · ${nvrData.channels.length} channel`
      + (empty ? ` · ${empty} kosong` : '') + (reg ? ` · ${reg} sudah terdaftar` : '');
    const f = $('#nvrForm');
    if (!f.location.value) f.location.value = data.cameras.find((c) => c.ip === body.ip)?.location || '';
    $('#nvrSearch').value = '';
    $('#nvrPick').hidden = false;
    renderNvrRows();
  } catch (ex) {
    $('#nvrInfo').innerHTML = `<span style="color:var(--bad)">${esc(ex.message)}</span>`;
    $('#nvrPick').hidden = true;
  } finally {
    btn.disabled = false;
  }
});

$('#nvrSearch').addEventListener('input', () => {
  const q = $('#nvrSearch').value.trim().toLowerCase();
  for (const tr of $$('#nvrRows tr')) {
    const c = nvrData.channels[Number(tr.dataset.i)];
    tr.hidden = !!q && ![c.name, c.cam_ip, c.model].some((v) => (v || '').toLowerCase().includes(q));
  }
  updateNvrCount();
});
$('#nvrAll').addEventListener('change', (e) => {
  for (const tr of $$('#nvrRows tr:not([hidden])')) nvrData.channels[Number(tr.dataset.i)].pick = e.target.checked;
  renderNvrRows();
});
$('#nvrRows').addEventListener('change', (e) => {
  const tr = e.target.closest('tr');
  const c = nvrData.channels[Number(tr.dataset.i)];
  if (e.target.classList.contains('nvr-pick')) { c.pick = e.target.checked; tr.classList.toggle('picked', c.pick); updateNvrCount(); }
  if (e.target.classList.contains('nvr-ptz')) c.ptz = e.target.checked;
});
$('#nvrRows').addEventListener('input', (e) => {
  if (e.target.classList.contains('nvr-name')) nvrData.channels[Number(e.target.closest('tr').dataset.i)].name = e.target.value;
});
// Enter di kolom login = baca channel (bukan submit form)
$('#nvrForm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('.nvr-login')) { e.preventDefault(); $('#nvrScan').click(); }
  if (e.key === 'Enter' && e.target.classList.contains('nvr-name')) e.preventDefault();
});

bindDialog($('#nvrDialog'), async (f) => {
  if (!nvrData) throw new Error('Klik "Baca channel" dulu');
  const channels = nvrData.channels.filter((c) => c.pick).map((c) => ({ channel: c.channel, name: c.name, ptz: !!c.ptz }));
  const r = await api('POST', '/api/admin/nvr/import', {
    ...nvrLoginBody(), channels, location: f.location.value.trim(),
    group_id: f.group_id.value || null, update_existing: f.update_existing.checked,
  });
  toast(`NVR: ${r.added} kamera ditambah` + (r.updated ? `, ${r.updated} diperbarui` : '') + (r.skipped ? `, ${r.skipped} dilewati (sudah ada)` : ''));
  await loadAll();
});

// ---------- Grup ----------
let selectedGroup = null;

function renderGroups() {
  $('#groupList').innerHTML = data.groups.map((g) => `
    <div class="g ${selectedGroup === g.id ? 'active' : ''}" data-id="${g.id}">
      <span>${esc(g.name)}</span>
      <small>${g.camera_count} kamera · ${g.user_count} user${g.max_tiles ? ` · maks ${g.max_tiles}` : ''}${g.can_ptz ? ' · PTZ' : ''}</small>
    </div>`).join('') || '<div class="muted">Belum ada grup.</div>';
  if (selectedGroup && !data.groups.some((g) => g.id === selectedGroup)) selectedGroup = null;
  renderGroupEditor();
}

function renderGroupEditor() {
  const box = $('#groupEditor');
  const g = data.groups.find((x) => x.id === selectedGroup);
  if (!g) {
    box.innerHTML = '<div class="muted">Pilih grup di sebelah kiri, atau buat grup baru.</div>';
    return;
  }
  const checked = new Set(g.camera_ids);
  const byLoc = new Map();
  for (const c of data.cameras) {
    const l = c.location || NO_LOC;
    (byLoc.get(l) || byLoc.set(l, []).get(l)).push(c);
  }
  const sections = [...byLoc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([loc, cams]) => `
    <div class="check-loc" data-loc="${esc(loc)}">
      <div class="head">
        <label class="check"><input type="checkbox" class="loc-all"> ${esc(loc)}</label>
        <span class="muted"></span>
      </div>
      <div class="cams">${cams.map((c) => `
        <label class="check" data-name="${esc(c.name.toLowerCase())}">
          <input type="checkbox" class="cam" value="${c.id}" ${checked.has(c.id) ? 'checked' : ''}>
          ${esc(c.name)}
        </label>`).join('')}
      </div>
    </div>`).join('');

  box.innerHTML = `
    <div class="toolbar">
      <input id="groupName" value="${esc(g.name)}" style="max-width:240px" aria-label="Nama grup">
      <label class="check" title="Jumlah kotak grid maksimal untuk user grup ini. Kosong = ikut default di Pengaturan.">
        Maks kotak
        <input type="number" id="groupMax" min="1" max="64" value="${g.max_tiles ?? ''}" placeholder="default" style="width:80px">
      </label>
      <label class="check" title="User grup ini boleh menggerakkan kamera PTZ (arah, zoom, preset).">
        <input type="checkbox" id="groupPtz" ${g.can_ptz ? 'checked' : ''}> Boleh kontrol PTZ
      </label>
      <input type="search" id="groupSearch" placeholder="Cari kamera...">
      <span class="muted" id="groupCount"></span>
      <button class="danger" id="groupDelete">Hapus grup</button>
      <button class="primary" id="groupSave">Simpan</button>
    </div>
    <div class="toolbar">
      <button id="groupCheckAll">Centang semua</button>
      <button id="groupUncheckAll">Kosongkan</button>
    </div>
    ${sections || '<div class="muted">Belum ada kamera.</div>'}`;
  updateGroupCounts();
}

function updateGroupCounts() {
  $$('#groupEditor .check-loc').forEach((sec) => {
    const boxes = $$('input.cam', sec);
    const n = boxes.filter((b) => b.checked).length;
    const all = $('.loc-all', sec);
    all.checked = n === boxes.length && n > 0;
    all.indeterminate = n > 0 && n < boxes.length;
    $('.head .muted', sec).textContent = `${n} / ${boxes.length}`;
  });
  const total = $$('#groupEditor input.cam:checked').length;
  if ($('#groupCount')) $('#groupCount').textContent = `${total} kamera dipilih`;
}

$('#groupList').addEventListener('click', (e) => {
  const el = e.target.closest('.g');
  if (!el) return;
  selectedGroup = Number(el.dataset.id);
  renderGroups();
});

$('#groupAdd').addEventListener('click', async () => {
  const name = await promptBox('', { title: 'Grup baru', placeholder: 'mis. Operasional', ok: 'Buat' });
  if (!name?.trim()) return;
  try {
    const r = await api('POST', '/api/admin/groups', { name });
    selectedGroup = r.id;
    await loadAll();
  } catch (ex) { toast(ex.message, true); }
});

$('#groupEditor').addEventListener('change', (e) => {
  if (e.target.classList.contains('loc-all')) {
    const sec = e.target.closest('.check-loc');
    $$('input.cam', sec).forEach((b) => {
      if (b.closest('label').style.display !== 'none') b.checked = e.target.checked;
    });
  }
  updateGroupCounts();
});

$('#groupEditor').addEventListener('input', (e) => {
  if (e.target.id !== 'groupSearch') return;
  const q = e.target.value.trim().toLowerCase();
  $$('#groupEditor .check-loc').forEach((sec) => {
    const locMatch = sec.dataset.loc.toLowerCase().includes(q);
    let visible = 0;
    $$('.cams label', sec).forEach((l) => {
      const show = !q || locMatch || l.dataset.name.includes(q);
      l.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    sec.style.display = visible ? '' : 'none';
  });
});

$('#groupEditor').addEventListener('click', async (e) => {
  const g = data.groups.find((x) => x.id === selectedGroup);
  if (!g) return;
  if (e.target.id === 'groupCheckAll' || e.target.id === 'groupUncheckAll') {
    $$('#groupEditor input.cam').forEach((b) => { b.checked = e.target.id === 'groupCheckAll'; });
    updateGroupCounts();
  }
  if (e.target.id === 'groupSave') {
    const camera_ids = $$('#groupEditor input.cam:checked').map((b) => Number(b.value));
    try {
      await api('PUT', `/api/admin/groups/${g.id}`, {
        name: $('#groupName').value, camera_ids, max_tiles: $('#groupMax').value || null,
        can_ptz: $('#groupPtz').checked,
      });
      toast(`Grup "${$('#groupName').value}" disimpan (${camera_ids.length} kamera)`);
      await loadAll();
    } catch (ex) { toast(ex.message, true); }
  }
  if (e.target.id === 'groupDelete') {
    if (!(await confirmBox(`User di grup "${g.name}" tidak akan bisa melihat kamera apa pun.`, { title: 'Hapus grup?', ok: 'Hapus', danger: true }))) return;
    await api('DELETE', `/api/admin/groups/${g.id}`);
    selectedGroup = null;
    toast('Grup dihapus');
    await loadAll();
  }
});

// ---------- User ----------
function renderUsers() {
  $('#userRows').innerHTML = data.users.map((u) => `
    <tr>
      <td>${esc(u.username)}</td>
      <td>${u.is_admin ? '<span class="badge admin">Admin</span>' : '<span class="badge">Viewer</span>'}${!u.is_admin && u.monitor ? ' <span class="badge url" title="Tampilan hanya CCTV + playlist">Monitor</span>' : ''}</td>
      <td>${u.is_admin ? '<span class="muted">semua kamera</span>' : u.group_name ? esc(u.group_name) : '<span class="muted">- (tidak bisa lihat apa pun)</span>'}</td>
      <td>${u.is_admin ? '<span class="muted">Ya (admin)</span>' : u.can_ptz ? '<span class="badge ptz">Boleh</span>' : '<span class="muted">Lihat saja</span>'}</td>
      <td class="muted">${esc(u.created_at)}</td>
      <td><div class="actions">
        <button data-edit="${u.id}">Edit</button>
        <button class="danger" data-del="${u.id}">Hapus</button>
      </div></td>
    </tr>`).join('');
}

let editingUser = null;
function openUserDialog(u) {
  editingUser = u;
  const f = $('#userForm');
  f.reset();
  $('#userDialogTitle').textContent = u ? `Edit user ${u.username}` : 'Tambah user';
  f.username.value = u?.username || '';
  f.username.disabled = !!u;
  f.password.required = !u;
  $('#userPwHint').textContent = u ? 'Kosongkan kalau tidak ingin mengganti password.' : 'Minimal 6 karakter.';
  f.role.value = u?.is_admin ? 'admin' : 'viewer';
  f.group_id.innerHTML = '<option value="">- Tanpa grup -</option>' +
    data.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  f.group_id.value = u?.group_id || '';
  f.can_ptz.checked = !!u?.can_ptz;
  f.monitor.checked = !!u?.monitor;
  $('#userDialog').showModal();
}

bindDialog($('#userDialog'), async (f) => {
  const body = { is_admin: f.role.value === 'admin', group_id: f.group_id.value || null, can_ptz: f.can_ptz.checked, monitor: f.monitor.checked };
  if (f.password.value) body.password = f.password.value;
  if (editingUser) await api('PUT', `/api/admin/users/${editingUser.id}`, body);
  else await api('POST', '/api/admin/users', { ...body, username: f.username.value });
  toast('User disimpan');
  await loadAll();
});

$('#userAdd').addEventListener('click', () => openUserDialog(null));
$('#userRows').addEventListener('click', async (e) => {
  const edit = e.target.dataset.edit, del = e.target.dataset.del;
  if (edit) openUserDialog(data.users.find((u) => u.id === Number(edit)));
  if (del) {
    const u = data.users.find((x) => x.id === Number(del));
    if (!(await confirmBox(`User "${u.username}" akan dihapus.`, { title: 'Hapus user?', ok: 'Hapus', danger: true }))) return;
    try {
      await api('DELETE', `/api/admin/users/${del}`);
      toast('User dihapus');
      await loadAll();
    } catch (ex) { toast(ex.message, true); }
  }
});

// ---------- Backup / restore ----------
let restoreData = null;
$('#restoreFile').addEventListener('change', async (e) => {
  restoreData = null;
  $('#restoreBtn').disabled = true;
  const file = e.target.files[0];
  if (!file) { $('#restoreInfo').textContent = ''; return; }
  try {
    const b = JSON.parse(await file.text());
    if (b.app !== 'cctv-backup') throw new Error('bukan file backup CCTV');
    restoreData = b;
    $('#restoreInfo').textContent = `Backup tanggal ${new Date(b.created_at).toLocaleString('id-ID')}: `
      + `${b.cameras?.length ?? 0} kamera, ${b.groups?.length ?? 0} grup, ${b.users?.length ?? 0} user.`;
    $('#restoreCams').disabled = !b.cameras; $('#restoreCams').checked = !!b.cameras;
    $('#restoreUsers').disabled = !b.users; $('#restoreUsers').checked = !!b.users;
    $('#restoreBtn').disabled = false;
  } catch (ex) {
    $('#restoreInfo').textContent = 'File tidak bisa dibaca: ' + ex.message;
  }
});
$('#restoreForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!restoreData) return;
  const parts = [];
  if ($('#restoreCams').checked) parts.push('cameras');
  if ($('#restoreUsers').checked) parts.push('users');
  if (!parts.length) return toast('Pilih minimal satu yang mau di-restore', true);
  if (!(await confirmBox('Data yang sama akan ditimpa dengan isi backup. Data yang tidak ada di backup tidak dihapus.', { title: 'Restore dari backup?', ok: 'Restore' }))) return;
  $('#restoreBtn').disabled = true;
  try {
    const r = await api('POST', '/api/admin/restore', { backup: restoreData, parts });
    toast(`Restore selesai: kamera +${r.cameras_added} / ${r.cameras_updated} diperbarui, `
      + `user +${r.users_added} / ${r.users_updated} diperbarui` + (r.errors.length ? `, ${r.errors.length} gagal` : ''), r.errors.length > 0);
    if (r.errors.length) await alertBox(r.errors.slice(0, 30).join('\n'), { title: `${r.errors.length} data gagal di-restore` });
    await loadAll();
  } catch (ex) { toast(ex.message, true); }
  $('#restoreBtn').disabled = false;
});

// ---------- Rekaman ----------
let recData = null;
const recSel = new Set();
const gb = (b) => (b / 1024 ** 3).toFixed(b >= 100 * 1024 ** 3 ? 0 : 1) + ' GB';
const when = (t) => (t ? new Date(t).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-');

async function loadRecord() {
  recData = await api('GET', '/api/admin/record');
  const s = recData.settings, f = $('#recForm');
  f.record_enabled.checked = s.enabled;
  f.record_path.value = s.root;
  f.record_min_free_gb.value = s.minFreeGb;
  f.record_max_days.value = s.maxDays;
  f.record_segment_min.value = s.segmentMin;
  const d = recData.disk;
  const usedPct = d.total ? ((d.total - d.free) / d.total) * 100 : 0;
  const recPct = d.total ? (recData.used / d.total) * 100 : 0;
  $('#recDiskUsed').style.width = `${usedPct}%`;
  $('#recDiskRec').style.width = `${recPct}%`;
  const days = recData.oldest ? (Date.now() - new Date(recData.oldest)) / 86400_000 : 0;
  $('#recDiskText').innerHTML = d.total
    ? `Hardisk ${gb(d.total)} · terisi ${gb(d.total - d.free)} · <b>rekaman ${gb(recData.used)}</b> · sisa ${gb(d.free)}
       ${recData.oldest ? `<br>Rekaman tersedia sejak <b>${when(recData.oldest)}</b> (± ${days.toFixed(1)} hari)` : '<br>Belum ada rekaman.'}
       ${s.minFreeGb ? `<br>Rekaman terlama dihapus otomatis kalau sisa ruang di bawah <b>${s.minFreeGb} GB</b>` : ''}
       ${s.maxDays ? ` · disimpan maksimal <b>${s.maxDays} hari</b>` : ''}`
    : 'Folder rekaman tidak bisa dibaca.';
  renderRecRows();
}

function renderRecRows() {
  if (!recData) return;
  const q = $('#recSearch').value.trim().toLowerCase();
  const list = recData.cameras.filter((c) => !q || [c.name, c.location].some((v) => (v || '').toLowerCase().includes(q)));
  const on = recData.cameras.filter((c) => c.record).length;
  $('#recCount').textContent = `${on} kamera direkam${recSel.size ? ` · ${recSel.size} dipilih` : ''}`;
  $('#recRows').innerHTML = list.map((c) => {
    const status = !c.supported ? '<span class="muted">HikCentral belum didukung</span>'
      : !c.record ? '<span class="muted">-</span>'
      : !recData.settings.enabled ? '<span class="muted">Modul mati</span>'
      : c.active ? '<span class="badge ptz">● Merekam</span>'
      : '<span class="badge" style="color:var(--bad);border-color:var(--bad)">Tidak ada data baru</span>';
    return `<tr class="${recSel.has(c.id) ? 'picked' : ''}">
      <td class="sel"><input type="checkbox" class="rec-pick" value="${c.id}" ${recSel.has(c.id) ? 'checked' : ''}></td>
      <td>${esc(c.name)}</td><td class="muted">${esc(c.location)}</td>
      <td>${c.record ? 'Ya' : '<span class="muted">Tidak</span>'}</td>
      <td>${c.quality === 'sub' ? 'Sub' : 'Main'}</td>
      <td>${status}</td>
      <td>${c.size ? gb(c.size) : '<span class="muted">-</span>'}</td>
      <td class="muted">${when(c.oldest)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">Belum ada kamera.</td></tr>';
  $('#recAll').checked = list.length > 0 && list.every((c) => recSel.has(c.id));
}

$('#recSearch').addEventListener('input', renderRecRows);
$('#recRows').addEventListener('change', (e) => {
  if (!e.target.classList.contains('rec-pick')) return;
  const id = Number(e.target.value);
  e.target.checked ? recSel.add(id) : recSel.delete(id);
  renderRecRows();
});
$('#recAll').addEventListener('change', (e) => {
  const q = $('#recSearch').value.trim().toLowerCase();
  for (const c of recData.cameras) {
    if (q && ![c.name, c.location].some((v) => (v || '').toLowerCase().includes(q))) continue;
    e.target.checked ? recSel.add(c.id) : recSel.delete(c.id);
  }
  renderRecRows();
});
document.querySelector('[data-panel="record"] .toolbar').addEventListener('click', async (e) => {
  const act = e.target.dataset.rec;
  if (!act) return;
  if (!recSel.size) return toast('Centang kamera dulu', true);
  const body = { ids: [...recSel] };
  if (act === 'on' || act === 'off') body.record = act === 'on';
  else body.quality = act;
  try {
    await api('PUT', '/api/admin/record/cameras', body);
    toast(act === 'on' ? `${recSel.size} kamera mulai direkam` : act === 'off' ? `${recSel.size} kamera berhenti direkam` : `Kualitas rekaman: ${act}`);
    recSel.clear();
    loadRecord();
  } catch (ex) { toast(ex.message, true); }
});
$('#recForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('PUT', '/api/admin/record', {
      record_enabled: f.record_enabled.checked, record_path: f.record_path.value,
      record_min_free_gb: f.record_min_free_gb.value, record_max_days: f.record_max_days.value,
      record_segment_min: f.record_segment_min.value,
    });
    toast(f.record_enabled.checked ? 'Pengaturan rekaman disimpan' : 'Modul rekaman dimatikan');
    loadRecord();
  } catch (ex) { toast(ex.message, true); }
});
// Status diperbarui berkala selama tab Rekaman terbuka
setInterval(() => { if (!$('[data-panel="record"]').hidden) loadRecord().catch(() => {}); }, 30_000);

// ---------- Pengaturan ----------
async function loadSettings() {
  const s = await api('GET', '/api/admin/settings');
  const f = $('#settingsForm');
  f.default_cam_user.value = s.default_cam_user;
  f.default_cam_pass.value = '';
  f.default_max_tiles.value = s.default_max_tiles;
  f.default_cam_pass.placeholder = s.has_default_cam_pass ? '(tersimpan, tidak diubah)' : '(belum diisi)';
  const m = s.mediamtx;
  $('#mtxStatus').innerHTML = m.ok
    ? `<span class="dot on" style="display:inline-block"></span> Terhubung · ${m.pathCount} path · sync terakhir ${new Date(m.lastSync).toLocaleTimeString('id-ID')}`
    : `<span class="dot off" style="display:inline-block"></span> Tidak terhubung ke MediaMTX<br><code>${esc(m.lastError || 'belum pernah sync')}</code>`;
}

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('PUT', '/api/admin/settings', {
      default_cam_user: f.default_cam_user.value,
      default_cam_pass: f.default_cam_pass.value || undefined,
      default_max_tiles: f.default_max_tiles.value,
    });
    toast('Pengaturan disimpan');
    loadSettings();
  } catch (ex) { toast(ex.message, true); }
});

// ---------- Tampilan tanpa login (tamu) ----------
async function loadGuestSettings() {
  const s = await api('GET', '/api/admin/settings');
  const f = $('#guestForm');
  f.guest_enabled.checked = s.guest_enabled;
  f.guest_group_id.innerHTML = '<option value="">- Tidak ada kamera -</option>' +
    data.groups.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.camera_count} kamera)</option>`).join('');
  f.guest_group_id.value = s.guest_group_id || '';
  f.guest_ips.value = s.guest_ips || '';
}
$('#guestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.guest_enabled.checked && !f.guest_group_id.value && !(await confirmBox('Tamu tidak akan melihat kamera apa pun sampai grupnya dipilih.', { title: 'Belum ada grup dipilih', ok: 'Simpan saja' }))) return;
  try {
    await api('PUT', '/api/admin/settings', {
      guest_enabled: f.guest_enabled.checked, guest_group_id: f.guest_group_id.value || null, guest_ips: f.guest_ips.value,
    });
    toast(f.guest_enabled.checked ? 'Tampilan tanpa login aktif' : 'Tampilan tanpa login dimatikan');
    loadGuestSettings();
  } catch (ex) { toast(ex.message, true); }
});

// ---------- HikCentral: pengaturan ----------
async function loadHikSettings() {
  const s = await api('GET', '/api/admin/settings');
  const f = $('#hikForm');
  f.hik_host.value = s.hik_host;
  f.hik_app_key.value = s.hik_app_key;
  f.hik_app_secret.value = '';
  f.hik_app_secret.placeholder = s.has_hik_app_secret ? '(tersimpan, tidak diubah)' : '(belum diisi)';
  f.hik_insecure.checked = s.hik_insecure;
}

async function saveHikSettings() {
  const f = $('#hikForm');
  await api('PUT', '/api/admin/settings', {
    hik_host: f.hik_host.value,
    hik_app_key: f.hik_app_key.value,
    hik_app_secret: f.hik_app_secret.value || undefined,
    hik_insecure: f.hik_insecure.checked,
  });
}

$('#hikForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await saveHikSettings(); toast('Pengaturan HikCentral disimpan'); loadHikSettings(); }
  catch (ex) { toast(ex.message, true); }
});

$('#hikTest').addEventListener('click', async () => {
  const out = $('#hikTestResult');
  out.style.color = '';
  out.textContent = 'Menyimpan & menghubungi HikCentral...';
  try {
    await saveHikSettings();
    const list = await api('GET', '/api/admin/hik/cameras');
    out.style.color = 'var(--ok)';
    out.textContent = `Berhasil ✓ ${list.length} kamera ditemukan`;
    loadHikSettings();
  } catch (ex) {
    out.style.color = 'var(--bad)';
    out.textContent = ex.message;
  }
});

// ---------- HikCentral: import kamera ----------
let hikCams = [];

function renderHikList() {
  const q = $('#hikSearch').value.trim().toLowerCase();
  const shown = hikCams.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));
  $('#hikList').innerHTML = shown.map((c) => `
    <label class="check">
      <input type="checkbox" class="hik-cam" value="${esc(c.code)}" ${c.imported ? 'disabled' : ''}>
      ${esc(c.name)}
      <span class="muted">${c.imported ? 'sudah di-import' : c.online === false ? 'offline' : ''}</span>
    </label>`).join('') || '<div class="muted">Tidak ada kamera.</div>';
  updateHikCount();
}

function updateHikCount() {
  const n = $$('#hikList input.hik-cam:checked').length;
  $('#hikCount').textContent = `${n} dipilih dari ${hikCams.length}`;
}

$('#hikImport').addEventListener('click', async () => {
  const f = $('#hikImportForm');
  f.reset();
  f.group_id.innerHTML = '<option value="">- Tanpa grup -</option>' +
    data.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  $('#hikList').innerHTML = '<div class="muted">Memuat daftar kamera dari HikCentral...</div>';
  $('#hikDialog').showModal();
  try {
    hikCams = await api('GET', '/api/admin/hik/cameras');
    renderHikList();
  } catch (ex) {
    $('#hikList').innerHTML = `<div style="color:var(--bad)">${esc(ex.message)}</div>
      <div class="muted" style="margin-top:6px">Periksa pengaturan HikCentral di tab Pengaturan.</div>`;
  }
});
$('#hikSearch').addEventListener('input', renderHikList);
$('#hikList').addEventListener('change', updateHikCount);
$('#hikAll').addEventListener('change', (e) => {
  $$('#hikList input.hik-cam:not(:disabled)').forEach((b) => { b.checked = e.target.checked; });
  updateHikCount();
});

bindDialog($('#hikDialog'), async (f) => {
  const codes = new Set($$('#hikList input.hik-cam:checked').map((b) => b.value));
  if (!codes.size) throw new Error('Pilih minimal satu kamera');
  const cameras = hikCams.filter((c) => codes.has(c.code)).map((c) => ({ code: c.code, name: c.name }));
  const r = await api('POST', '/api/admin/hik/import', {
    cameras, location: f.location.value, group_id: f.group_id.value || null,
  });
  toast(`${r.added} kamera HikCentral ditambahkan${r.skipped ? `, ${r.skipped} dilewati` : ''}`);
  await loadAll();
});

// ---------- Ganti password sendiri ----------
$('#changePw').addEventListener('click', () => { $('#pwForm').reset(); $('#pwDialog').showModal(); });
bindDialog($('#pwDialog'), async (f) => {
  await api('POST', '/api/me/password', { current: f.current.value, next: f.next.value });
  toast('Password diganti');
});

$('#logout').addEventListener('click', logout);

// ---------- Mulai ----------
const me = await api('GET', '/api/me');
if (!me.features?.record) document.querySelector('[data-tab="record"]')?.remove();
$('#userInfo').textContent = me.username;
await loadAll();
const startTab = location.hash.slice(1);
showTab(startTab && document.querySelector(`[data-tab="${startTab}"]`) ? startTab : 'cameras');
setInterval(() => api('GET', '/api/admin/cameras').then((c) => { data.cameras = c; renderCameras(); }).catch(() => {}), 60_000);
