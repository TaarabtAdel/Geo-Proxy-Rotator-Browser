const $ = (id) => document.getElementById(id);
const api = window.browserAPI;
let activeTabId = null;
let panel = null;
let busy = false;
let logStamp = '';

async function call(action, payload) {
  try {
    return await api.command(action, payload, activeTabId);
  } catch {
    $('message').textContent = 'Mất kết nối ứng dụng.';
    return { ok: false };
  }
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString('vi-VN', { hour12: false });
}

function secondsLeft() {
  if (!panel?.running) return null;
  const now = Date.now();
  if (panel.phase === 'waiting' && panel.nextArticleAt) return Math.max(0, Math.ceil((panel.nextArticleAt - now) / 1000));
  if (panel.phase === 'loading_article' && panel.loadDeadline) return Math.max(0, Math.ceil((panel.loadDeadline - now) / 1000));
  if (panel.phase === 'checking' && panel.checkDeadline) return Math.max(0, Math.ceil((panel.checkDeadline - now) / 1000));
  if (panel.phase === 'spoofing' && panel.spoofDeadline) return Math.max(0, Math.ceil((panel.spoofDeadline - now) / 1000));
  if (panel.phase === 'switching' && panel.switchDeadline) return Math.max(0, Math.ceil((panel.switchDeadline - now) / 1000));
  return null;
}

function renderLogs(logs) {
  $('logs').replaceChildren();
  for (const entry of logs || []) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = formatClock(entry.ts);
    const span = document.createElement('span');
    span.className = entry.level || 'info';
    span.textContent = ' ' + (entry.message || '');
    li.append(time, span);
    $('logs').append(li);
  }
}

let statsStamp = '';
function renderStats(stats) {
  const stamp = JSON.stringify(stats || null);
  if (stamp === statsStamp) return;
  statsStamp = stamp;
  const box = $('proxyStatus');
  box.replaceChildren();
  if (!stats) { $('doneHint').textContent = 'Chưa đọc geo-proxy-data.json.'; return; }
  const chips = [
    ['Tất cả', stats.total, ''],
    ['Chưa thử', stats.untried, ''],
    ['Hết bài', stats.exhausted || 0, ''],
    ['Không', stats.dead, 'dead'],
    ['Bận', stats.busy, ''],
    ['Đang kiểm tra', stats.checking, ''],
    ['Đang dùng', stats.inUse, ''],
    ['Live', stats.live, 'live'],
  ];
  for (const [label, n, cls] of chips) {
    const s = document.createElement('span');
    s.textContent = `${label} ${n}`;
    if (cls) s.className = cls;
    box.append(s);
  }
  const d = stats.done;
  if (!d.total) { $('doneHint').textContent = 'Chưa có cặp proxy–bài đã chạy.'; return; }
  const lines = [
    `Đã lưu ${d.total} cặp. Lần chạy sau sẽ bỏ qua.`,
    `Chạy được ${d.ok} · Không được ${d.bad}`,
  ];
  if (d.unknown) lines.push(`Chưa rõ ${d.unknown} (lưu từ trước, chưa ghi kết quả).`);
  if (d.reasons.length) lines.push('Lỗi hay gặp: ' + d.reasons.map((r) => `${r.note} (${r.count})`).join(', ') + '.');
  $('doneHint').textContent = lines.join('\n');
}

function renderPanel() {
  if (!panel) return;
  const running = !!panel.running;
  $('sideTabId').textContent = panel.tabId != null ? panel.tabId : '—';
  $('phase').textContent = panel.phaseLabel || 'Sẵn sàng';
  $('phase').className = 'phase' + (running ? ' on' : ' idle');
  $('badge').textContent = (panel.tabId ? `Tab ${panel.tabId} · ` : '') + (panel.phaseLabel || 'Sẵn sàng');
  $('start').disabled = busy || running;
  $('stop').disabled = busy || !running;
  const canNext = running && (panel.phase === 'waiting' || panel.phase === 'loading_article');
  $('nextAuto').disabled = busy || !canNext;

  const pTotal = panel.proxyTotal || 0;
  $('proxy').textContent = panel.proxyLabel && panel.proxyLabel !== '—'
    ? (pTotal ? `${panel.proxyIndex + 1}/${pTotal} · ${panel.proxyLabel}` : panel.proxyLabel)
    : '—';

  const c = panel.connection;
  $('ipLine').textContent = c?.connected ? `${c.ip}${c.country ? ' · ' + c.country : ''}` : '—';
  $('location').textContent = (panel.locationLabel && panel.locationLabel !== '—')
    ? panel.locationLabel
    : '—';

  const aTotal = panel.articleTotal || 0;
  const showArticle = running && panel.articleUrl
    && ['loading_article', 'waiting'].includes(panel.phase);
  if (!showArticle) {
    $('article').textContent = aTotal ? `— /${aTotal}` : '—';
    $('article').title = '';
  } else if (aTotal) {
    $('article').textContent = `${(panel.articleIndex ?? 0) + 1}/${aTotal} · ${panel.articleLabel || '—'}`;
    $('article').title = panel.articleUrl || '';
  } else {
    $('article').textContent = panel.articleLabel || '—';
    $('article').title = panel.articleUrl || '';
  }

  const left = secondsLeft();
  const label = $('countdownLabel');
  if (left == null) {
    $('countdown').textContent = '—';
    label.textContent = 'Còn lại';
  } else if (panel.phase === 'loading_article') {
    label.textContent = 'Còn lại tải bài';
    $('countdown').textContent = left + ' giây (timeout bài)';
  } else if (panel.phase === 'checking') {
    label.textContent = 'Còn lại kiểm tra proxy';
    $('countdown').textContent = left + ' giây';
  } else if (panel.phase === 'spoofing') {
    label.textContent = 'Còn lại giả lập vị trí';
    $('countdown').textContent = left + ' giây';
  } else if (panel.phase === 'switching') {
    label.textContent = 'Đang chuyển proxy';
    $('countdown').textContent = left + ' giây';
  } else {
    label.textContent = 'Còn lại tới bài tiếp';
    $('countdown').textContent = left + ' giây';
  }
  $('failed').textContent = String(panel.failedCount || 0);
  $('listsHint').textContent = panel.listsMessage || '';
  renderStats(panel.stats);

  const stamp = JSON.stringify(panel.logs || []);
  if (stamp !== logStamp) {
    logStamp = stamp;
    renderLogs(panel.logs);
  }
}

function displayTabs(s) {
  activeTabId = s.activeId;
  $('tabs').replaceChildren();
  for (const t of s.items) {
    const wrap = document.createElement('div');
    wrap.className = 'browser-tab' + (t.id === s.activeId ? ' active' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab-title';
    const title = document.createElement('span');
    const ip = t.connection?.connected ? t.connection.ip : '';
    const label = ip ? `${ip} - ${t.city || '—'}` : 'Đang tìm proxy…';
    title.textContent = (t.busy ? '◌ ' : t.connection?.connected ? '● ' : '○ ') + label;
    const small = document.createElement('small');
    small.textContent = `Tab ${t.id}`;
    btn.title = t.title || '';
    btn.append(title, small);
    btn.onclick = async () => {
      const r = await call('switchTab', t.id);
      if (r.panel) panel = r.panel;
      renderPanel();
    };
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.textContent = '×';
    close.onclick = () => call('closeTab', t.id);
    wrap.append(btn, close);
    $('tabs').append(wrap);
  }
  const active = s.items.find((t) => t.id === s.activeId);
  if (active && document.activeElement !== $('address')) $('address').value = active.url || '';
}

api.onTabs((s) => { displayTabs(s); });
api.onRunnerPanel((p) => {
  if (p.tabId === activeTabId) { panel = p; renderPanel(); }
});

$('start').onclick = async () => { busy = true; renderPanel(); const r = await call('runnerStart'); busy = false; if (r.panel) panel = r.panel; if (!r.ok) $('message').textContent = r.error; else $('message').textContent = ''; renderPanel(); };
$('stop').onclick = async () => { busy = true; const r = await call('runnerStop'); busy = false; if (r.panel) panel = r.panel; renderPanel(); };
$('nextAuto').onclick = async () => { busy = true; const r = await call('runnerNext'); busy = false; if (!r.ok) $('message').textContent = r.error; if (r.panel) panel = r.panel; renderPanel(); };
$('reloadLists').onclick = async () => { busy = true; const r = await call('reloadLists'); busy = false; if (r.panel) panel = r.panel; renderPanel(); };
$('openSettings').onclick = () => call('openSettings');
$('newTab').onclick = () => call('newTab');
$('addressForm').onsubmit = (e) => { e.preventDefault(); call('navigate', $('address').value); };
for (const b of document.querySelectorAll('[data-action]')) b.onclick = () => call(b.dataset.action);

call('init').then((r) => {
  if (!r.ok) return;
  panel = r.panel;
  if (r.config) $('listsHint').textContent = (panel?.listsMessage || '') + ` · chờ ${r.config.waitMinSec}–${r.config.waitMaxSec}s (geo-config.json)`;
  displayTabs(r.tabs);
  renderPanel();
});

setInterval(renderPanel, 300);
