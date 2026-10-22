const $ = (id) => document.getElementById(id);
const api = window.settingsAPI;

let rows = [];
let statusFilter = '';
let tableStamp = null;
let formDirty = false;
let loop = false;
let inspectTimer = null;

const KIND_CLASS = {
  live: 'status-live',
  dead: 'status-dead',
  pending: 'status-pending',
  busy: 'status-busy',
  untried: 'status-untried',
  unsupported: 'status-unsupported',
};

async function call(action, payload) {
  try {
    const r = await api.call(action, payload);
    if (!r.ok) throw Error(r.error || 'Lỗi không rõ.');
    return r;
  } catch (e) {
    setStatus(e.message || 'Mất kết nối ứng dụng.', true);
    throw e;
  }
}

function setStatus(text, isError) {
  $('status').textContent = text || '';
  $('status').className = isError ? 'error' : '';
}

function formFocused() {
  const el = document.activeElement;
  return Boolean(el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

// Chỉ gán khi khác, để ô không nhảy về đầu mỗi lần làm mới định kỳ.
function setVal(id, value) {
  const v = String(value ?? '');
  if ($(id).value !== v) $(id).value = v;
}

function applyForm(f) {
  setVal('sourceUrl', f.proxySourceUrl);
  setVal('proxyText', f.proxyText);
  setVal('articleText', f.articleText);
  setVal('waitMin', f.waitMinSec);
  setVal('waitMax', f.waitMaxSec);
  setVal('timeout', f.proxyTimeoutSec);
  setVal('articleTimeout', f.articleLoadTimeoutSec);
  $('scrollEnabled').checked = f.scrollEnabled !== false;
  setVal('scrollSpeed', ['slow', 'normal', 'fast'].includes(f.scrollSpeed) ? f.scrollSpeed : 'normal');
  setVal('scrollDepth', f.scrollDepthPercent);
  loop = Boolean(f.loop);
  formDirty = false;
  renderArticleHint();
}

function readForm() {
  return {
    proxySourceUrl: $('sourceUrl').value,
    proxyText: $('proxyText').value,
    articleText: $('articleText').value,
    waitMinSec: $('waitMin').value,
    waitMaxSec: $('waitMax').value,
    proxyTimeoutSec: $('timeout').value,
    articleLoadTimeoutSec: $('articleTimeout').value,
    scrollEnabled: $('scrollEnabled').checked,
    scrollSpeed: $('scrollSpeed').value,
    scrollDepthPercent: $('scrollDepth').value,
    loop,
  };
}

function renderInfo(info) {
  if (!info) return;
  const lines = [info.dataFile];
  if (info.listSource) lines.push('Các tab đang chạy theo: ' + info.listSource + '.');
  $('locationHint').textContent = lines.join('\n');
  const d = info.done;
  if (!d || !d.total) { $('doneHint').textContent = 'Chưa có cặp proxy–bài đã chạy.'; return; }
  const out = [`Đã lưu ${d.total} cặp. Lần chạy sau sẽ bỏ qua.`, `Chạy được ${d.ok} · Không được ${d.bad}`];
  if (d.unknown) out.push(`Chưa rõ ${d.unknown} (lưu từ trước, chưa ghi kết quả).`);
  if (d.reasons?.length) out.push('Lỗi hay gặp: ' + d.reasons.map((r) => `${r.note} (${r.count})`).join(', ') + '.');
  $('doneHint').textContent = out.join('\n');
}

function renderArticleHint() {
  const lines = $('articleText').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => { try { return !/^https?:$/.test(new URL(l).protocol); } catch { return true; } });
  $('articleHint').textContent = bad.length
    ? `${bad.length} dòng không phải URL http/https hợp lệ.`
    : (lines.length ? `${lines.length} URL hợp lệ.` : 'Chưa có bài viết.');
}

function renderTable(data) {
  rows = data.rows;
  $('proxyHint').textContent = data.skipped ? `Bỏ qua ${data.skipped} dòng không đúng định dạng.` : '';
  for (const button of document.querySelectorAll('#proxyFilters button')) {
    const status = button.dataset.status;
    button.classList.toggle('on', status === statusFilter);
    button.textContent = button.dataset.label + ' ' + (status ? (data.counts[status] || 0) : data.total);
  }
  const shown = statusFilter ? (data.counts[statusFilter] || 0) : data.total;
  $('copyProxies').disabled = shown === 0;
  $('proxyCount').textContent = statusFilter ? `${shown} / ${data.total} proxy` : `${data.total} proxy hợp lệ`;

  const stamp = statusFilter + '\n' + rows.map((r) => r.line + '\t' + r.status + '\t' + r.title).join('\n');
  if (stamp === tableStamp) return;
  tableStamp = stamp;
  const frag = document.createDocumentFragment();
  rows.forEach((r, index) => {
    if (statusFilter && r.status !== statusFilter) return;
    const tr = document.createElement('tr');
    for (const value of [index + 1, r.host, r.port, r.protocol, r.auth ? 'Có' : 'Không']) {
      const td = document.createElement('td');
      td.textContent = String(value);
      tr.append(td);
    }
    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'status-badge ' + (KIND_CLASS[r.kind] || '');
    badge.textContent = r.status;
    if (r.title) badge.title = r.title;
    statusCell.append(badge);
    const action = document.createElement('td');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link';
    del.textContent = 'Xoá';
    del.dataset.index = String(index);
    action.append(del);
    tr.append(statusCell, action);
    frag.append(tr);
  });
  if (!frag.childNodes.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = data.total ? 'Không có proxy ở trạng thái này.' : 'Chưa có proxy hợp lệ.';
    tr.append(td);
    frag.append(tr);
  }
  $('proxyTable').replaceChildren(frag);
}

async function inspect() {
  const r = await call('inspect', $('proxyText').value);
  renderTable(r);
  renderInfo(r);
}

function scheduleInspect() {
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(() => { inspect().catch(() => {}); }, 300);
}

async function load() {
  const r = await call('load');
  applyForm(r.form);
  renderInfo(r);
  await inspect();
}

async function save() {
  const r = await call('save', readForm());
  applyForm(r.form);
  renderInfo(r);
  tableStamp = null;
  await inspect();
  setStatus('Đã lưu lúc ' + new Date().toLocaleTimeString('vi-VN', { hour12: false }) + ' · ' + r.message, false);
}

async function fetchProxies() {
  const button = $('fetchProxies');
  button.disabled = true;
  setStatus('Đang tải danh sách proxy...', false);
  try {
    const r = await call('fetchProxies', $('sourceUrl').value);
    $('sourceUrl').value = r.sourceText;
    $('proxyText').value = r.proxyText;
    await save();
    const extra = r.errors.length ? ' Nguồn lỗi: ' + r.errors.join(' · ') + '.' : '';
    setStatus(`Đã gộp ${r.count} proxy (${r.notes.join(', ')}) và lưu.` + extra, false);
  } catch {
    /* lỗi đã hiện ở thanh trạng thái */
  } finally {
    button.disabled = false;
  }
}

$('proxyText').addEventListener('input', () => { formDirty = true; scheduleInspect(); });
$('articleText').addEventListener('input', () => { formDirty = true; renderArticleHint(); });
for (const id of ['sourceUrl', 'waitMin', 'waitMax', 'timeout', 'articleTimeout', 'scrollDepth']) {
  $(id).addEventListener('input', () => { formDirty = true; });
}
for (const id of ['scrollEnabled', 'scrollSpeed']) {
  $(id).addEventListener('change', () => { formDirty = true; });
}

$('proxyFilters').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-status]');
  if (!button) return;
  statusFilter = button.dataset.status;
  inspect().catch(() => {});
});

$('proxyTable').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-index]');
  if (!button) return;
  const index = Number(button.dataset.index);
  $('proxyText').value = rows.filter((_, i) => i !== index).map((r) => r.line).join('\n');
  formDirty = true;
  setStatus('Đã xoá khỏi danh sách. Bấm Lưu cấu hình để áp dụng.', false);
  inspect().catch(() => {});
});

$('copyProxies').addEventListener('click', async () => {
  const lines = rows.filter((r) => !statusFilter || r.status === statusFilter).map((r) => r.line);
  if (!lines.length) { setStatus('Không có proxy để copy.', true); return; }
  try {
    await call('copy', lines.join('\n'));
    setStatus(`Đã copy ${lines.length} proxy (${statusFilter || 'Tất cả'}), mỗi dòng một proxy.`, false);
  } catch { /* đã báo lỗi */ }
});

$('clearHealth').addEventListener('click', async () => {
  if (!window.confirm('Xoá trạng thái Live / Không của mọi proxy? Proxy đang được tab dùng vẫn giữ nguyên.')) return;
  try {
    renderInfo(await call('clearHealth'));
    tableStamp = null;
    await inspect();
    setStatus('Đã xoá trạng thái proxy.', false);
  } catch { /* đã báo lỗi */ }
});

$('clearProxies').addEventListener('click', async () => {
  if ($('proxyText').value.trim() && !window.confirm('Xoá toàn bộ danh sách proxy và trạng thái của chúng?')) return;
  try {
    renderInfo(await call('clearProxies'));
    $('proxyText').value = '';
    tableStamp = null;
    await inspect();
    setStatus('Đã xoá danh sách proxy. Các tab sẽ dừng khi không còn proxy để thử.', false);
  } catch { /* đã báo lỗi */ }
});

$('clearDone').addEventListener('click', async () => {
  if (!window.confirm('Xoá lịch sử proxy đã chạy cho từng bài? Lần sau sẽ chạy lại những cặp này.')) return;
  try {
    renderInfo(await call('clearDone'));
    setStatus('Đã xoá lịch sử đã chạy.', false);
  } catch { /* đã báo lỗi */ }
});

function readSync() {
  return {
    mode: $('modeHost').checked ? 'host' : 'local',
    url: $('syncUrl').value,
    userId: $('syncUserId').value,
    key: $('syncKey').value,
  };
}

function renderSyncState(r) {
  if (!r.active) {
    $('syncHint').textContent = r.sync.mode === 'host'
      ? 'Đã chọn Host nhưng app vẫn đang chạy Local: khởi động lại app để áp dụng.'
      : 'Đang chạy Local.';
    return;
  }
  const state = (r.online === false ? `Host: mất kết nối máy chủ (${r.lastError}).` : 'Đang chạy Host, đồng bộ với máy chủ.')
    + ` Máy này: ${r.machine}.`;
  $('syncHint').textContent = state + (r.pending ? ` ${r.pending} thay đổi chờ gửi.` : '');
}

let syncDirty = false;
for (const id of ['syncUrl', 'syncUserId', 'syncKey']) $(id).addEventListener('input', () => { syncDirty = true; });
for (const id of ['modeLocal', 'modeHost']) $(id).addEventListener('change', () => { syncDirty = true; });

async function loadSync() {
  const r = await call('syncLoad');
  if (!syncDirty && !formFocused()) {
    $('modeHost').checked = r.sync.mode === 'host';
    $('modeLocal').checked = r.sync.mode !== 'host';
    setVal('syncUrl', r.sync.url);
    setVal('syncUserId', r.sync.userId);
    setVal('syncKey', r.sync.key);
  }
  renderSyncState(r);
}

$('syncTest').addEventListener('click', async () => {
  $('syncHint').textContent = 'Đang kiểm tra…';
  try {
    const { server: s } = await call('syncTest', readSync());
    $('syncHint').textContent = `Kết nối OK (user ${s.userId}). Máy chủ có ${s.health} proxy có trạng thái (${s.dead} Không), `
      + `${s.done} cặp proxy–bài, ${s.leases} chỗ đang giữ, ${s.hasConfig ? 'đã có' : 'chưa có'} cài đặt.`;
  } catch (e) {
    $('syncHint').textContent = e.message;
  }
});

$('syncUpload').addEventListener('click', async () => {
  const overwrite = window.confirm(
    'Đẩy dữ liệu máy này lên máy chủ (gộp trạng thái proxy và lịch sử, không xoá gì trên máy chủ).\n\n'
    + 'OK: dùng luôn cài đặt (proxy, bài, nhịp chạy) của máy này cho mọi máy.\n'
    + 'Cancel: giữ cài đặt đang có trên máy chủ (nếu máy chủ chưa có thì vẫn lấy của máy này).',
  );
  $('syncHint').textContent = 'Đang đẩy dữ liệu…';
  try {
    const r = await call('syncUpload', { sync: readSync(), overwriteConfig: overwrite });
    $('syncHint').textContent = `Đã gộp ${r.health} trạng thái proxy, ${r.done} cặp proxy–bài`
      + (r.configTaken ? ', và cài đặt của máy này.' : ', giữ cài đặt trên máy chủ.');
  } catch (e) {
    $('syncHint').textContent = e.message;
  }
});

$('syncSave').addEventListener('click', async () => {
  try {
    const r = await call('syncSave', readSync());
    syncDirty = false;
    setStatus(r.restartNeeded ? 'Đã lưu chế độ. Khởi động lại app để áp dụng.' : 'Đã lưu chế độ.', false);
    await loadSync();
  } catch { /* đã báo lỗi */ }
});

$('fetchProxies').addEventListener('click', () => fetchProxies());
$('save').addEventListener('click', () => { save().catch(() => {}); });

// Trạng thái proxy đổi liên tục khi các tab chạy; config có thể bị extension hoặc nút khác sửa.
setInterval(() => {
  if (!formDirty && !formFocused()) {
    call('load').then((r) => { applyForm(r.form); renderInfo(r); return inspect(); }).catch(() => {});
  } else {
    inspect().catch(() => {});
  }
  if (!formFocused()) loadSync().catch(() => {});
}, 4000);

load().catch(() => {});
loadSync().catch(() => {});
