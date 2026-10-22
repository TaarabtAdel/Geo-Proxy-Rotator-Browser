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
  waiting_work: 'Chờ việc mới (hết proxy / bài)',
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

function sleep(ms, alive) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (alive && !alive()) { reject(Error('Đã dừng.')); return; }
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
    if (signal?.aborted) { finish('abort'); return; }
    signal?.addEventListener('abort', () => finish('abort'), { once: true });
  });
}

// Phân loại lỗi khi kiểm tra proxy. Chỉ 'dead' mới ghi trạng thái Không.
// 'skip': proxy vẫn chạy nhưng không dùng được lúc này (IP đầu ra trùng tab khác, ipwho.is giới hạn lượt).
// 'local': mạng của máy đang lỗi, không phải lỗi proxy.
function checkFailureKind(e) {
  const text = String(e?.message || e || '');
  if (e?.code === 'DUPLICATE_IP') return 'skip';
  if (e?.code === 'SYNC_OFFLINE') return 'local';
  if (/HTTP 429\b/.test(text)) return 'skip';
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED/i.test(text)) return 'local';
  return 'dead';
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
  if (picked.skippedBusy) addLog(state, 'info', `Bỏ qua ${picked.skippedBusy} proxy đang được tab khác kiểm tra/dùng.`);
  if (!picked.order.length) {
    if (picked.skippedBusy) throw new NoProxyError('Proxy còn bài đang bận ở tab khác. Thử lại sau 20 giây.', true);
    throw new NoProxyError('Không còn proxy để thử. Proxy dead bị bỏ qua, proxy khác đã chạy hết bài.', false);
  }
  let lastErr = '';
  let tried = 0;
  let remoteBusy = 0;
  for (const { item, idx } of picked.order) {
    if (tried >= 36) break;
    if (signal.aborted || !state.running) throw signal.reason || Error('Đã dừng.');
    // Danh sách được lọc từ trước; trong lúc tab này thử proxy khác, tab khác có thể đã giữ hoặc đánh dead proxy này.
    if (!deps.lease.isAvailable(item.id, tab.id) || deps.dataStore.isDead(item)) continue;
    deps.lease.release(tab.id);
    deps.lease.lease(item.id, tab.id, 'checking');
    tab.leasedProxyId = item.id;
    // Chế độ đồng bộ online: máy chủ quyết định proxy có đang bị máy khác giữ không.
    if (deps.lease.claimRemote) {
      let claimed;
      try {
        claimed = await deps.lease.claimRemote(item, tab.id);
      } catch (e) {
        deps.lease.release(tab.id);
        tab.leasedProxyId = null;
        throw new NoProxyError(`${e.message}. Thử lại sau 20 giây.`, true);
      }
      if (!claimed) {
        deps.lease.release(tab.id);
        tab.leasedProxyId = null;
        remoteBusy += 1;
        continue;
      }
    }
    tried += 1;
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
      if (deps.lease.claimIp) await deps.lease.claimIp(tab.id, tab.net.state.ip);
      if (remoteBusy) addLog(state, 'info', `Bỏ qua ${remoteBusy} proxy đang được máy khác giữ.`);
      remoteBusy = 0;
      deps.lease.lease(item.id, tab.id, 'using');
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
      state.checkDeadline = null;
      state.spoofDeadline = null;
      // Dừng hoặc đóng tab giữa chừng không phải lỗi proxy: không đánh dead, không đếm lỗi.
      if (signal.aborted || !state.running || tab.closing) throw signal.reason || e;
      lastErr = e.message || String(e);
      const kind = checkFailureKind(e);
      if (kind === 'local') {
        throw new NoProxyError(`Mạng máy đang lỗi (${lastErr}), không đánh dấu proxy. Thử lại sau 20 giây.`, true);
      }
      if (kind === 'skip') {
        addLog(state, 'info', `Proxy #${idx + 1} tạm bỏ qua (không đánh Không): ${lastErr}`);
      } else {
        await deps.dataStore.setHealth(item, 'dead', { note: lastErr }).catch(() => {});
        addLog(state, 'error', `Proxy #${idx + 1} lỗi → Không: ${lastErr}`);
        state.failedCount += 1;
      }
      advanceProxyCursor(tab, idx, deps.candidates.length);
      deps.publishPanel(tab);
    }
  }
  if (!tried) throw new NoProxyError('Proxy còn bài đang được tab khác (hoặc máy khác) kiểm tra/dùng. Thử lại sau 20 giây.', true);
  const err = Error(lastErr || 'Không tìm được proxy hoạt động.');
  err.name = 'BatchFailedError';
  throw err;
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
    if (loadResult === 'abort' || signal.aborted) {
      endArticleNav(nav);
      throw signal.reason || Error('Đã dừng.');
    }

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

// Dừng rồi bấm Chạy lại ngay: vòng cũ có thể còn đang dọn dẹp. Vòng mới chờ vòng cũ xong
// và mỗi vòng có số thế hệ riêng, để vòng cũ không chạy tiếp hay tắt nhầm vòng mới.
function runTabLoop(deps, tab) {
  const state = tab.runner || (tab.runner = defaultRunnerState());
  if (state.running) return tab.runnerLoop || Promise.resolve();
  state.running = true;
  const gen = (tab.runGen || 0) + 1;
  tab.runGen = gen;
  const prev = tab.runnerLoop;
  const job = (async () => {
    if (prev) await prev.catch(() => {});
    await tabLoop(deps, tab, state, gen);
  })();
  tab.runnerLoop = job;
  job.catch(() => {}).finally(() => { if (tab.runnerLoop === job) tab.runnerLoop = null; });
  return job;
}

// Kiểm tra "còn cặp proxy–bài chưa chạy" duyệt hết list (vài nghìn proxy × số bài): nhớ kết quả
// theo đúng list + phiên bản dữ liệu, để nhiều tab đang chờ việc không tính lại liên tục.
const workMemo = { candidates: null, links: null, rev: -1, value: false };

function hasPendingWork(deps) {
  const store = deps.dataStore;
  if (workMemo.candidates === deps.candidates && workMemo.links === deps.links && workMemo.rev === store.rev) {
    return workMemo.value;
  }
  const value = store.pendingPairExists(deps.candidates, deps.links, { skipDead: true });
  Object.assign(workMemo, { candidates: deps.candidates, links: deps.links, rev: store.rev, value });
  return value;
}

async function refreshLists(deps) {
  if (!deps.ensureLists) return;
  try {
    await deps.ensureLists();
  } catch { /* list trống hoặc mất mạng: dùng bản đang có */ }
}

const WORK_POLL_MS = 5000;

// Hết proxy / hết bài: không dừng tab mà chờ. Khi Cài đặt (app hoặc /geo) thêm link hay proxy, tab tự chạy tiếp.
async function waitForWork(deps, tab, state, alive, reason) {
  addLog(state, 'success', `${reason} Chờ link / proxy mới, có là tự chạy tiếp.`);
  state.phase = 'waiting_work';
  state.proxyLabel = '—';
  state.articleLabel = '—';
  state.articleUrl = '';
  deps.publishPanel(tab);
  while (alive()) {
    await sleep(deps.workPollMs || WORK_POLL_MS, alive);
    await refreshLists(deps);
    if (hasPendingWork(deps)) {
      state.articleTotal = deps.links.length;
      state.proxyTotal = deps.candidates.length;
      tab.proxyCursor = 0;
      addLog(state, 'info', `Có việc mới (${deps.candidates.length} proxy · ${deps.links.length} bài), chạy tiếp.`);
      deps.publishPanel(tab);
      return;
    }
  }
}

async function tabLoop(deps, tab, state, gen) {
  const alive = () => state.running && tab.runGen === gen && !tab.closing;
  try {
    if (!alive()) return;
    try {
      await deps.dataStore.load();
    } catch (e) {
      addLog(state, 'error', `Không đọc lại được dữ liệu, dùng bản đang có: ${e.message}`);
    }
    await refreshLists(deps);
    if (!alive()) return;
    state.articleTotal = deps.links.length;
    state.proxyTotal = deps.candidates.length;
    state.donePairs = deps.dataStore.countPairs();
    tab.proxyCursor = tab.proxyCursor || 0;
    tab.skipWait = false;

    addLog(state, 'info', `Tab ${tab.id}: 1 proxy → ${deps.links.length} link → đổi proxy (${state.donePairs} cặp đã lưu).`);
    deps.publishPanel(tab);

    while (alive()) {
      if (!hasPendingWork(deps)) {
        await waitForWork(deps, tab, state, alive, 'Đã chạy hết cặp proxy–bài (proxy dead bị bỏ qua).');
        continue;
      }

      let passOk = false;
      let forceSwitch = false;
      let retryMs = 0;
      let outOfWork = '';
      try {
        await tab.net.run(async (signal) => {
          const { item } = await acquireProxy(deps, tab, state, signal);
          await runArticles(deps, tab, state, signal, item);
          passOk = true;
        });
      } catch (e) {
        if (!alive()) break;
        if (e.name === 'NoProxyError') {
          if (e.busy) {
            addLog(state, 'info', e.message);
            deps.publishPanel(tab);
            retryMs = 20000;
          } else {
            outOfWork = e.message;
          }
        } else if (e instanceof ProxyFailError || e.name === 'ProxyFailError') {
          addLog(state, 'error', e.message);
          if (tab.currentProxy) {
            await deps.dataStore.setHealth(tab.currentProxy, 'dead', { note: e.message }).catch(() => {});
          }
          state.failedCount += 1;
          forceSwitch = true;
          deps.publishPanel(tab);
        } else if (e.name === 'BatchFailedError') {
          deps.publishPanel(tab);
        } else if (e.name !== 'AbortError') {
          addLog(state, 'error', e.message || String(e));
          state.failedCount += 1;
          deps.publishPanel(tab);
        }
      } finally {
        await cleanupSession(tab, deps, state);
      }
      if (!alive()) break;
      if (outOfWork) {
        await waitForWork(deps, tab, state, alive, outOfWork);
        continue;
      }
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
        await sleep(Math.min(switchMs, 1500), alive);
        state.switchDeadline = null;
      } else if (retryMs) {
        state.phase = 'switching';
        state.switchDeadline = Date.now() + retryMs;
        deps.publishPanel(tab);
        await sleep(retryMs, alive);
        state.switchDeadline = null;
      } else {
        state.phase = 'switching';
        addLog(state, 'info', 'Lô proxy vừa thử đều lỗi · thử lô kế.');
        deps.publishPanel(tab);
        await sleep(1000, alive);
      }
    }
  } catch (e) {
    if (alive()) throw e;
  } finally {
    await cleanupSession(tab, deps, state);
    if (tab.runGen === gen) {
      state.running = false;
      state.phase = 'idle';
      state.checkDeadline = null;
      state.loadDeadline = null;
      state.spoofDeadline = null;
      state.switchDeadline = null;
      state.nextArticleAt = null;
      state.donePairs = deps.dataStore.countPairs();
    }
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
  acquireProxy,
  checkFailureKind,
};
