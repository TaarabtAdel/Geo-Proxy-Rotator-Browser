const { app, BrowserWindow, WebContentsView, session, ipcMain, dialog, Menu, net } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserTabs } = require('./tabs.cjs');
const { TabConnection, IPRegistry, BLOCKED, waitFor } = require('./tab-network.cjs');
const { verifyIPAny } = require('./verify.cjs');
const { cities, targetURL } = require('./core.cjs');
const { loadProxyList, loadLinkList, listsDir } = require('./local-lists.cjs');
const { loadRotatorConfig } = require('./rotator-config.cjs');
const { ProxyLease } = require('./proxy-lease.cjs');
const { runTabLoop, panelSnapshot, stopRunner, requestNext, defaultRunnerState } = require('./tab-runner.cjs');
const { GeoDataStore } = require('./geo-data.cjs');

app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
const appRoot = listsDir(__dirname);
let win, tabs, uiReady = false, candidates = [], links = [], listTask = null, nextProxySlot = 0;
let runnerConfig = null;
let geoData = null;
let listInfo = { source: '', updatedAt: '', message: 'Chưa đọc list.' };
const registry = new IPRegistry();
const lease = new ProxyLease();
const runId = randomUUID();
const ASIDE_W = 360;

const emit = (name, data) => { if (uiReady && win && !win.isDestroyed()) win.webContents.send(name, data); };

function snapshot(tab) {
  const stats = geoData ? geoData.stats(candidates, (id) => lease.has(id)) : null;
  return { ...panelSnapshot(tab, listInfo.message), stats };
}

function publishPanel(tab) {
  emit('runner-panel', snapshot(tab || tabs?.active));
}

function publish() {
  if (!tabs) return;
  layout();
  emit('tabs', tabs.snapshot());
  publishPanel(tabs.active);
  for (const t of tabs.items) {
    if (t.runner?.running && t.id !== tabs.activeId) publishPanel(t);
  }
}

async function geo(tab, city) {
  if (!Object.hasOwn(cities, city)) throw Error('Thành phố không hợp lệ.');
  if (tab.closing) throw Error('Tab đã đóng.');
  const wc = tab.view.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const [latitude, longitude] = cities[city];
  await wc.debugger.sendCommand('Emulation.setGeolocationOverride', { latitude, longitude, accuracy: 50 });
}

function loadTab(tab, url) {
  if (tab.closing || !tab.net.connected) return;
  tab.url = targetURL(url);
  tabs.changed();
  tab.view.webContents.loadURL(tab.url).catch(() => {});
  layout();
}

async function loadLists() {
  const [proxyResult, linkLines] = await Promise.all([loadProxyList(appRoot), loadLinkList(appRoot)]);
  candidates = proxyResult.items;
  links = linkLines;
  listInfo = {
    source: 'list-proxy.txt + list-link.txt',
    updatedAt: new Date().toISOString(),
    message: `${candidates.length} proxy · ${links.length} link`,
  };
  if (!links.length) throw Error('list-link.txt trống hoặc không có URL hợp lệ.');
  return listInfo;
}

async function ensureLists(signal) {
  if (candidates.length && links.length) return;
  if (!listTask) listTask = loadLists().finally(() => { listTask = null; });
  await waitFor(listTask, signal);
  signal?.throwIfAborted();
}

async function connectTab(tab, p, signal, openPage = true) {
  if (!p.id) p = { ...p, id: `${p.type}://${p.host}:${p.port}` };
  const result = await tab.net.connect(p, signal);
  if (openPage !== false && tab.url) loadTab(tab, tab.url);
  layout();
  return result;
}

const runnerDeps = () => ({
  net,
  registry,
  lease,
  candidates,
  links,
  config: runnerConfig,
  dataStore: geoData,
  layout,
  ensureLists,
  connectTab,
  loadTab,
  publishPanel,
  publish,
});

function assignProxySlot(tab) {
  if (typeof tab.proxySlot !== 'number') {
    tab.proxySlot = nextProxySlot;
    nextProxySlot = candidates.length ? (nextProxySlot + 1) % candidates.length : nextProxySlot + 1;
  }
  tab.proxyCursor = 0;
  if (!tab.runner) tab.runner = defaultRunnerState();
  return tab.proxySlot;
}

function startRunner(tab) {
  if (!tab || tab.closing) return;
  assignProxySlot(tab);
  runTabLoop(runnerDeps(), tab).catch(() => {});
}

async function newTab() {
  const tab = await tabs.create('');
  if (uiReady) startRunner(tab);
  publish();
  return tab;
}

async function closeTab(id) {
  const tab = tabs.items.find((t) => t.id === id);
  if (tab) {
    stopRunner(tab);
    lease.release(tab.id);
  }
  const before = new Set(tabs.items.map((t) => t.id));
  await tabs.close(id);
  for (const t of tabs.items) if (!before.has(t.id)) startRunner(t);
  publish();
}

function layout() {
  if (!win || !tabs || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  for (const tab of tabs.items) {
    tab.view.setBounds({ x: ASIDE_W, y: 170, width: Math.max(0, w - ASIDE_W), height: Math.max(0, h - 170) });
    tab.view.setVisible(tab.net.connected && tab.id === tabs.activeId);
  }
}

function shortcuts(wc) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key.toLowerCase();
    if (!['t', 'w', 'tab', 'l'].includes(key)) return;
    event.preventDefault();
    if (key === 't') newTab().catch((e) => dialog.showErrorBox('Tab', e.message));
    if (key === 'w') closeTab(tabs.activeId).catch(() => {});
    if (key === 'tab') tabs.cycle(input.shift ? -1 : 1);
    if (key === 'l') { win.webContents.focus(); emit('focus-address', null); }
  });
}

function protect(tab) {
  const wc = tab.view.webContents;
  shortcuts(wc);
  wc.setWindowOpenHandler(({ url }) => {
    newTab().then((t) => { if (tab.net.connected) loadTab(t, url); }).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('context-menu', (_, p) => {
    if (p.linkURL && /^https?:\/\//i.test(p.linkURL)) {
      Menu.buildFromTemplate([{
        label: 'Mở link tab mới (proxy riêng)',
        click: () => newTab().then((t) => startRunner(t)).catch(() => {}),
      }]).popup({ window: win });
    }
  });
  for (const name of ['will-navigate', 'will-redirect']) {
    wc.on(name, (e, url) => { if (!tab.net.connected || !/^https?:\/\//i.test(url)) e.preventDefault(); });
  }
  for (const name of ['did-navigate', 'did-navigate-in-page']) {
    wc.on(name, (_, url) => { tab.url = url; tabs.changed(); publish(); });
  }
  wc.on('page-title-updated', (_, title) => { tab.title = title.slice(0, 160) || 'Tab ' + tab.id; tabs.changed(); publish(); });
  wc.on('did-start-loading', () => { tab.loading = true; tabs.changed(); });
  wc.on('did-stop-loading', () => { tab.loading = false; tabs.changed(); });
  wc.debugger.on('detach', () => {
    if (tab.net.connected && !tab.closing && !tab.runner?.running) tab.net.lock('Thiết lập vị trí bị ngắt.').catch(() => {});
  });
}

function createView(tab) {
  const ses = session.fromPartition(`browser-${runId}-${tab.id}`, { cache: false });
  tab.session = ses;
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webRTCIPHandlingPolicy: 'disable_non_proxied_udp',
    },
  });
  view.setVisible(false);
  tab.net = new TabConnection({
    id: tab.id,
    session: ses,
    registry,
    verify: (s, signal, auth) => verifyIPAny(net, s, signal, auth, 12000),
    geo: (city) => tabs.changeCity(tab.id, city),
    stop: () => { if (!view.webContents.isDestroyed()) { view.webContents.stop(); view.setVisible(false); } },
    onChange: publish,
  });
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !tab.net.connected && !(tab.net.checking && d.url === 'https://ipwho.is/') }));
  ses.setPermissionCheckHandler((wc, p, origin) => tab.net.connected && p === 'geolocation' && origin.startsWith('https://'));
  ses.setPermissionRequestHandler((wc, p, cb, d) => cb(tab.net.connected && p === 'geolocation' && String(d.requestingUrl || wc?.getURL() || '').startsWith('https://')));
  ses.on('will-download', (e) => { e.preventDefault(); });
  return view;
}

app.on('login', (event, wc, details, info, cb) => {
  if (!wc) return;
  event.preventDefault();
  const tab = tabs?.items.find((t) => t.view.webContents === wc);
  const creds = tab?.net.creds;
  if (creds && info.isProxy && info.host === creds.host && +info.port === +creds.port) cb(creds.user, creds.password);
  else cb();
});

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#f3f6f4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  runnerConfig = await loadRotatorConfig(appRoot);
  geoData = new GeoDataStore(appRoot);
  await geoData.load();
  tabs = new BrowserTabs({
    cities: Object.keys(cities),
    createView,
    attach: (v) => win.contentView.addChildView(v),
    remove: (v) => win.contentView.removeChildView(v),
    configure: async (tab, city) => {
      if (!tab.protected) {
        await tab.session.setProxy(BLOCKED);
        protect(tab);
        tab.protected = true;
      }
      if (city) await geo(tab, city);
    },
    destroy: async (tab) => {
      stopRunner(tab);
      lease.release(tab.id);
      await tab.net.dispose();
    },
    onChange: publish,
  });
  shortcuts(win.webContents);
  await newTab();
  win.on('resize', layout);
  win.on('closed', () => { uiReady = false; tabs.dispose(); });
  await win.loadFile('index.html');
  uiReady = true;
  try { await loadLists(); } catch (e) { listInfo.message = e.message; }
  publish();
  startRunner(tabs.active);
  setInterval(() => {
    if (tabs?.active?.runner?.running) publishPanel(tabs.active);
  }, 500);
}).catch((e) => { dialog.showErrorBox('Geo Proxy Rotator Browser', e.message); app.exit(1); });

ipcMain.handle('command', async (event, action, payload, tabId) => {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    return { ok: false, error: 'Không được phép.' };
  }
  try {
    if (action === 'init') {
      return {
        ok: true,
        tabs: tabs.snapshot(),
        panel: snapshot(tabs.active),
        config: runnerConfig,
      };
    }
    if (action === 'newTab') { await newTab(); return { ok: true }; }
    if (action === 'switchTab') {
      tabs.activate(payload);
      publish();
      return { ok: true, panel: snapshot(tabs.active) };
    }
    if (action === 'closeTab') { await closeTab(payload); return { ok: true }; }
    if (action === 'reloadLists') {
      await loadLists();
      publish();
      return { ok: true, panel: snapshot(tabs.active) };
    }
    const tab = tabs.items.find((t) => t.id === (tabId ?? tabs.activeId));
    if (!tab || tab.closing) throw Error('Chọn tab đang mở.');
    if (action === 'runnerStart') { startRunner(tab); publish(); return { ok: true, panel: snapshot(tab) }; }
    if (action === 'runnerStop') { stopRunner(tab); publish(); return { ok: true, panel: snapshot(tab) }; }
    if (action === 'runnerNext') { requestNext(tab); publish(); return { ok: true, panel: snapshot(tab) }; }
    if (action === 'navigate') {
      if (!tab.net.connected) throw Error('Tab chưa kết nối proxy.');
      loadTab(tab, payload);
      return { ok: true };
    }
    if (['back', 'forward', 'reload'].includes(action)) {
      if (!tab.net.connected) throw Error('Tab chưa kết nối.');
      const wc = tab.view.webContents;
      if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      if (action === 'reload') wc.reload();
      return { ok: true };
    }
    throw Error('Thao tác không hợp lệ.');
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (e) => { dialog.showErrorBox('Geo Proxy Rotator Browser', e.message); app.exit(1); });
