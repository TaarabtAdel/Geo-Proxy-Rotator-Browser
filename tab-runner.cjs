const { pickLocation } = require('./us-locations.cjs');
const { applyLocation } = require('./geo-spoof.cjs');
const { beginHumanScroll, stopHumanScroll } = require('./scroll.cjs');
const {
  ProxyFailError,
  articleSkipReason,
  articleOutcome,
  articleFailedToLoad,
  shouldFailProxy,
  beginArticleNav,
  endArticleNav,
  scheduleProbe,
} = require('./article-flow.cjs');

const PHASE_LABEL = {
  idle: 'Sẵn sàng',
  applying_proxy: 'Đang đặt proxy',
  checking: 'Đang kiểm tra kết nối',
  spoofing: 'Đang giả lập vị trí',
  loading_article: 'Đang mở bài viết',
  waiting: 'Đang chờ bài tiếp theo',
  switching: 'Đang chuyển proxy',
};

function pickWait(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).slice(0, 72);
  } catch {
    return String(url || '').slice(0, 72);
  }
}

function defaultRunnerState() {
  return {
    running: false,
    phase: 'idle',
    proxyIndex: 0,
    proxyTotal: 0,
    proxyLabel: '—',
    articleIndex: 0,
    articleTotal: 0,
    articleLabel: '—',
    articleUrl: '',
    locationLabel: '—',
    nextArticleAt: null,
    loadDeadline: null,
    checkDeadline: null,
    spoofDeadline: null,
    switchDeadline: null,
    failedCount: 0,
    donePairs: 0,
    logs: [],
  };
}

function addLog(state, level, message) {
  state.logs.unshift({ ts: Date.now(), level, message });
  if (state.logs.length > 80) state.logs.length = 80;
}

function sleep(ms, state) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (state && !state.running) { reject(Error('Đã dừng.')); return; }
      if (Date.now() - start >= ms) { resolve(); return; }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(message || 'Quá hạn.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function clearSpoofDisplay(tab, state) {
  tab.spoofLocation = null;
  tab.city = null;
  if (state) state.locationLabel = '—';
}

function setSpoofDisplay(tab, state, location) {
  tab.spoofLocation = location;
  tab.city = location.name;
  if (state) state.locationLabel = `${location.name} (${location.timezone})`;
}

function advanceProxyCursor(tab, usedIdx, total) {
  if (!total) return;
  const start = tab.proxySlot || 0;
  tab.proxyCursor = (usedIdx + 1 - start + total) % total;
}

function delay(ms, signal, tab, onPoll) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || Error('Đã dừng.')); return; }
    const start = Date.now();
    const tick = async () => {
      if (signal?.aborted) { reject(signal.reason || Error('Đã dừng.')); return; }
      if (tab?.skipWait) {
        tab.skipWait = false;
        resolve('next');
        return;
      }
      if (onPoll) {
        try {
          const action = await onPoll();
          if (action === 'skip') { resolve('skip'); return; }
          if (action === 'fail-proxy') { reject(new ProxyFailError('Proxy lỗi khi chờ bài')); return; }
        } catch (e) { reject(e); return; }
      }
      if (Date.now() - start >= ms) { resolve('done'); return; }
      setTimeout(tick, 400);
    };
    tick();
  });
}

function waitPageLoad(wc, timeoutMs, signal, tab) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result = 'done') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      wc.removeListener('did-stop-loading', onLoad);
      if (!wc.isDestroyed()) wc.stop();
      resolve(result);
    };
    const onLoad = () => { if (!wc.isLoading()) finish(); };
    const timer = setTimeout(finish, timeoutMs);
    const poll = setInterval(() => {
      if (!tab?.skipWait) return;
      tab.skipWait = false;
      finish('skip');
    }, 300);
    if (wc.isDestroyed()) { finish(); return; }
    if (!wc.isLoading()) finish();
    else wc.on('did-stop-loading', onLoad);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

class NoProxyError extends Error {
  constructor(message, busy) {
    super(message);
    this.name = 'NoProxyError';
    this.busy = busy;
  }
}

function proxyCandidatesForTab(deps, tab) {
  const { candidates, lease, dataStore, links } = deps;
  const result = { order: [], skippedDead: 0, skippedDone: 0, skippedBusy: 0 };
  if (!candidates.length) return result;
  const start = typeof tab.proxySlot === 'number' ? tab.proxySlot : 0;
  for (let i = 0; i < candidates.length; i++) {
    const idx = (start + tab.proxyCursor + i) % candidates.length;
    const item = candidates[idx];
    if (dataStore.isDead(item)) { result.skippedDead += 1; continue; }
    if (dataStore.isBusyExternal(item)) { result.skippedBusy += 1; continue; }
    if (!dataStore.pendingPairExists([item], links)) { result.skippedDone += 1; continue; }
    if (!lease.isAvailable(item.id, tab.id)) { result.skippedBusy += 1; continue; }
    result.order.push({ item, idx });
  }
  return result;
}

function skipDoneCursor(deps, proxy, links, from) {
  let cursor = from;
  while (cursor < links.length && deps.dataStore.alreadyRun(proxy, links[cursor])) cursor += 1;
  return cursor;
}

async function acquireProxy(deps, tab, state, signal) {
  const config = deps.config;
  if (!deps.links.length) throw Error('list-link.txt trống.');
  await deps.ensureLists(signal);
  await deps.dataStore.refreshIfChanged().catch(() => {});
  const picked = proxyCandidatesForTab(deps, tab);
  if (picked.skippedDead) addLog(state, 'info', `Bỏ qua ${picked.skippedDead} proxy trạng thái Không (dead).`);
  if (picked.skippedDone) addLog(state, 'info', `Bỏ qua ${picked.skippedDone} proxy đã chạy hết bài.`);
  if (picked.skippedBusy) addLog(state, 'info', `Bỏ qua ${picked.skippedBusy} proxy đang bận ở tab khác.`);
  if (!picked.order.length) {
    if (picked.skippedBusy) throw new NoProxyError('Proxy còn bài đang bận ở tab khác. Thử lại sau 20 giây.', true);
    throw new NoProxyError('Không còn proxy để thử. Proxy dead bị bỏ qua, proxy khác đã chạy hết bài.', false);
  }
  let lastErr = '';
  for (const { item, idx } of picked.order.slice(0, 36)) {
    if (signal.aborted || !state.running) throw signal.reason || Error('Đã dừng.');
    if (!deps.lease.isAvailable(item.id, tab.id)) continue;
    const location = pickLocation();
    addLog(state, 'info', `Proxy ${idx + 1}/${deps.candidates.length}: ${item.host}:${item.port}`);
    state.phase = 'applying_proxy';
    state.checkDeadline = null;
    state.spoofDeadline = null;
    state.proxyIndex = idx;
    state.proxyLabel = `${item.host}:${item.port}`;
    state.articleIndex = 0;
    state.articleLabel = '—';
    state.articleUrl = '';
    clearSpoofDisplay(tab, state);
    deps.publishPanel(tab);
    if (deps.publish) deps.publish();
    await delay(300, signal, tab);
    state.phase = 'checking';
    state.checkDeadline = Date.now() + config.proxyTimeoutSec * 1000;
    deps.publishPanel(tab);
    try {
      await deps.connectTab(tab, { ...item, id: item.id, skipGeo: true }, signal, false);
      deps.lease.lease(item.id, tab.id);
      tab.leasedProxyId = item.id;
      tab.currentProxy = item;
      state.checkDeadline = null;
      state.proxyIndex = idx;
      state.proxyLabel = `${item.host}:${item.port}`;
      await deps.dataStore.setHealth(item, 'live', { ip: tab.net.state.ip, note: 'Kết nối OK' }).catch(() => {});
      const spoofMs = config.proxyTimeoutSec * 1000;
      state.phase = 'spoofing';
      state.spoofDeadline = Date.now() + spoofMs;
      deps.publishPanel(tab);
      try {
        await withTimeout(
          applyLocation(tab, location),
          spoofMs,
          'Giả lập vị trí quá hạn hoặc không hoàn thành',
        );
        setSpoofDisplay(tab, state, location);
      } catch (e) {
        state.spoofDeadline = null;
        if (!tab.net.connected) throw e;
        addLog(state, 'info', `${e.message} · vẫn mở bài với proxy hiện tại.`);
        setSpoofDisplay(tab, state, location);
      }
      state.spoofDeadline = null;
      if (deps.publish) deps.publish();
      deps.publishPanel(tab);
      addLog(state, 'success', `Kết nối OK · IP ${tab.net.state.ip} · giả lập ${location.name}`);
      deps.publishPanel(tab);
      tab.runLocation = location;
      return { item, location };
    } catch (e) {
      deps.lease.release(tab.id);
      tab.leasedProxyId = null;
      tab.currentProxy = null;
      await deps.dataStore.setHealth(item, 'dead', { note: e.message || String(e) }).catch(() => {});
      lastErr = e.message || String(e);
      state.checkDeadline = null;
      state.spoofDeadline = null;
      addLog(state, 'error', `Proxy #${idx + 1} lỗi: ${lastErr}`);
      state.failedCount += 1;
      advanceProxyCursor(tab, idx, deps.candidates.length);
      deps.publishPanel(tab);
    }
  }
  throw Error(lastErr || 'Không tìm được proxy hoạt động.');
}

async function runArticles(deps, tab, state, signal, proxy) {
  const config = deps.config;
  const links = deps.links;
  let cursor = skipDoneCursor(deps, proxy, links, 0);
  if (cursor >= links.length) {
    addLog(state, 'info', 'Proxy này đã chạy hết bài, chuyển proxy.');
    return;
  }
  if (cursor > 0) addLog(state, 'info', `Bỏ qua ${cursor} bài proxy này đã chạy trước đó.`);
  addLog(state, 'info', `Proxy ${state.proxyLabel}: chạy lần lượt bài ${cursor + 1} → ${links.length}.`);

  while (cursor < links.length) {
    if (signal.aborted || !state.running) break;
    tab.skipWait = false;
    const url = links[cursor];
    state.articleIndex = cursor;
    state.articleLabel = shortenUrl(url);
    state.articleUrl = url;
    state.phase = 'loading_article';
    state.loadDeadline = Date.now() + config.articleLoadTimeoutSec * 1000;
    state.nextArticleAt = null;
    addLog(state, 'info', `Mở bài ${cursor + 1}/${links.length}: ${state.articleLabel}`);
    deps.publishPanel(tab);

    if (tab.runLocation) {
      const budget = Math.max(config.proxyTimeoutSec * 1000, 30000);
      try {
        await withTimeout(applyLocation(tab, tab.runLocation), budget, 'Quá hạn giả lập vị trí');
      } catch (e) {
        addLog(state, 'info', `Không giả lập được vị trí, vẫn mở bài: ${e.message}`);
      }
    }

    const nav = beginArticleNav(tab, url);
    const navId = nav.id;
    deps.loadTab(tab, url);
    layoutSafe(deps);
    scheduleProbe(tab, nav, navId).catch(() => {});

    const loadResult = await waitPageLoad(tab.view.webContents, config.articleLoadTimeoutSec * 1000, signal, tab);
    state.loadDeadline = null;

    const wc = tab.view.webContents;
    const wcUrl = wc.isDestroyed() ? '' : wc.getURL();

    if (loadResult === 'skip') {
      const reason = 'Next tự động: chuyển bài tiếp.';
      await deps.dataStore.remember(proxy, url, articleOutcome({ ...nav, phase: 'loading_article' }, reason));
      endArticleNav(nav);
      addLog(state, 'info', reason);
      cursor = skipDoneCursor(deps, proxy, links, cursor + 1);
      continue;
    }

    if (shouldFailProxy(nav)) {
      endArticleNav(nav);
      throw new ProxyFailError(`Mất kết nối proxy khi mở bài: ${nav.error || nav.status || 'HTTP 407'}`);
    }

    const skipReason = articleSkipReason(nav.status, nav.error);
    if (skipReason) {
      await deps.dataStore.remember(proxy, url, { ok: false, note: skipReason });
      endArticleNav(nav);
      addLog(state, 'info', `${skipReason} → bỏ qua, chuyển bài tiếp.`);
      cursor = skipDoneCursor(deps, proxy, links, cursor + 1);
      continue;
    }

    if (articleFailedToLoad(nav, wcUrl)) {
      const outcome = articleOutcome({ ...nav, phase: 'loading_article' }, 'Timeout tải bài');
      await deps.dataStore.remember(proxy, url, outcome);
      endArticleNav(nav);
      const why = nav.error || (nav.status >= 400 ? `HTTP ${nav.status}` : 'trang chưa tải');
      addLog(state, 'timeout', `Bài không tải được: ${why} → chuyển bài tiếp.`);
      cursor = skipDoneCursor(deps, proxy, links, cursor + 1);
      continue;
    }

    await deps.dataStore.remember(proxy, url, { ok: true });
    state.donePairs = deps.dataStore.countPairs();
    nav.phase = 'waiting';

    const waitSec = pickWait(config.waitMinSec, config.waitMaxSec);
    state.phase = 'waiting';
    state.nextArticleAt = Date.now() + waitSec * 1000;
    const next = cursor + 1;
    if (next >= links.length) {
      addLog(state, 'info', `Cuộn trang + chờ ${waitSec}s trước khi đổi proxy.`);
    } else {
      addLog(state, 'info', `Cuộn trang + chờ ${waitSec}s trước bài ${next + 1}/${links.length}.`);
    }
    deps.publishPanel(tab);
    await beginHumanScroll(wc, config);

    const waitPoll = async () => {
      if (shouldFailProxy(nav)) return 'fail-proxy';
      const skip = articleSkipReason(nav.status, nav.error);
      if (skip) {
        await deps.dataStore.remember(proxy, url, { ok: false, note: skip });
        addLog(state, 'info', `${skip} → bỏ qua chờ, chuyển bài tiếp.`);
        return 'skip';
      }
      return null;
    };

    try {
      const waitResult = await delay(waitSec * 1000, signal, tab, waitPoll);
      if (waitResult === 'next') addLog(state, 'info', 'Next tự động: bỏ qua thời gian chờ, chuyển bài tiếp.');
    } finally {
      await stopHumanScroll(wc);
    }
    state.nextArticleAt = null;
    endArticleNav(nav);
    cursor = skipDoneCursor(deps, proxy, links, cursor + 1);
  }

  addLog(state, 'success', `Đã xem hết bài với proxy ${state.proxyLabel}.`);
}

function layoutSafe(deps) {
  if (deps.layout) deps.layout();
}

async function cleanupSession(tab, deps, state) {
  deps.lease.release(tab.id);
  tab.leasedProxyId = null;
  tab.currentProxy = null;
  tab.runLocation = null;
  clearSpoofDisplay(tab, state);
  endArticleNav(tab.articleNav);
  if (tab.net.connected || tab.net.checking) {
    await tab.net.lock('Chuẩn bị proxy tiếp theo…').catch(() => {});
  }
  if (deps.publish) deps.publish();
}

async function runTabLoop(deps, tab) {
  const state = tab.runner || (tab.runner = defaultRunnerState());
  if (state.running) return;
  await deps.dataStore.load();
  state.running = true;
  state.articleTotal = deps.links.length;
  state.proxyTotal = deps.candidates.length;
  state.donePairs = deps.dataStore.countPairs();
  tab.proxyCursor = tab.proxyCursor || 0;
  tab.skipWait = false;

  if (!deps.dataStore.pendingPairExists(deps.candidates, deps.links, { skipDead: true })) {
    addLog(state, 'info', 'Mọi cặp proxy–bài đã chạy (hoặc proxy còn lại đều dead). Xoá geo-proxy-data.json để chạy lại.');
    state.running = false;
    state.phase = 'idle';
    deps.publishPanel(tab);
    return;
  }

  addLog(state, 'info', `Tab ${tab.id}: 1 proxy → ${deps.links.length} link → đổi proxy (${state.donePairs} cặp đã lưu).`);
  deps.publishPanel(tab);

  try {
    while (state.running && !tab.closing) {
      if (!deps.dataStore.pendingPairExists(deps.candidates, deps.links, { skipDead: true })) {
        addLog(state, 'success', 'Đã chạy hết cặp proxy–bài (proxy dead bị bỏ qua).');
        break;
      }

      let passOk = false;
      let forceSwitch = false;
      let retryMs = 0;
      try {
        await tab.net.run(async (signal) => {
          const { item } = await acquireProxy(deps, tab, state, signal);
          await runArticles(deps, tab, state, signal, item);
          passOk = true;
        });
      } catch (e) {
        if (e.name === 'AbortError' && !state.running) break;
        if (e.name === 'NoProxyError') {
          addLog(state, 'info', e.message);
          deps.publishPanel(tab);
          if (!e.busy) break;
          retryMs = 20000;
        } else if (e instanceof ProxyFailError || e.name === 'ProxyFailError') {
          addLog(state, 'error', e.message);
          if (tab.currentProxy) {
            await deps.dataStore.setHealth(tab.currentProxy, 'dead', { note: e.message }).catch(() => {});
          }
          state.failedCount += 1;
          forceSwitch = true;
          deps.publishPanel(tab);
        } else if (e.name !== 'AbortError') {
          addLog(state, 'error', e.message || String(e));
          state.failedCount += 1;
          deps.publishPanel(tab);
        }
      } finally {
        await cleanupSession(tab, deps, state);
      }
      if (!state.running || tab.closing) break;
      if (passOk || forceSwitch) {
        advanceProxyCursor(tab, state.proxyIndex, deps.candidates.length);
        const switchMs = deps.config.proxyTimeoutSec * 1000;
        state.phase = 'switching';
        state.switchDeadline = Date.now() + switchMs;
        const nextIdx = deps.candidates.length
          ? (state.proxyIndex + 1) % deps.candidates.length
          : 0;
        addLog(state, 'info', `Chuyển proxy kế (${nextIdx + 1}/${deps.candidates.length}).`);
        deps.publishPanel(tab);
        await sleep(Math.min(switchMs, 1500), state);
        state.switchDeadline = null;
      } else if (retryMs) {
        state.phase = 'switching';
        state.switchDeadline = Date.now() + retryMs;
        deps.publishPanel(tab);
        await sleep(retryMs, state);
        state.switchDeadline = null;
      } else {
        state.phase = 'switching';
        addLog(state, 'info', 'Lô proxy vừa thử đều lỗi · thử lô kế.');
        deps.publishPanel(tab);
        await sleep(1000, state);
      }
    }
  } finally {
    state.running = false;
    state.phase = 'idle';
    state.checkDeadline = null;
    state.loadDeadline = null;
    state.nextArticleAt = null;
    state.donePairs = deps.dataStore.countPairs();
    deps.lease.release(tab.id);
    await cleanupSession(tab, deps, state);
    deps.publishPanel(tab);
  }
}

function panelSnapshot(tab, listsMessage) {
  const state = tab?.runner || defaultRunnerState();
  return {
    tabId: tab?.id,
    ...state,
    phaseLabel: PHASE_LABEL[state.phase] || PHASE_LABEL.idle,
    listsMessage: listsMessage || '',
    connection: tab?.net?.state,
    busy: !!tab?.net?.task,
  };
}

function stopRunner(tab) {
  const state = tab.runner;
  if (state) state.running = false;
  tab.skipWait = false;
  tab.net.cancel();
}

function requestNext(tab) {
  const state = tab.runner;
  if (!state?.running) throw Error('Tab chưa chạy.');
  if (state.phase !== 'waiting' && state.phase !== 'loading_article') {
    throw Error('Chỉ Next khi đang chờ hoặc đang tải bài.');
  }
  tab.skipWait = true;
}

module.exports = {
  PHASE_LABEL,
  ProxyFailError,
  defaultRunnerState,
  runTabLoop,
  panelSnapshot,
  stopRunner,
  requestNext,
  runArticles,
};
