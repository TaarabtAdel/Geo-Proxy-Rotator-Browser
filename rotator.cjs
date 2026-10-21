const path = require('node:path');
const { pickLocation } = require('./us-locations.cjs');
const { DoneStore } = require('./done-store.cjs');
const { beginHumanScroll, stopHumanScroll } = require('./scroll.cjs');
const { applyLocation } = require('./geo-spoof.cjs');
const { loadRotatorConfig } = require('./rotator-config.cjs');
const { targetURL } = require('./core.cjs');

const PHASE_LABEL = {
  idle: 'Sẵn sàng',
  applying_proxy: 'Đang đặt proxy',
  checking: 'Đang kiểm tra kết nối',
  spoofing: 'Đang giả lập vị trí',
  loading_article: 'Đang mở bài viết',
  waiting: 'Đang chờ bài tiếp theo',
  switching: 'Đang chuyển proxy',
};

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || Error('Đã dừng.')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || Error('Đã dừng.')); }, { once: true });
  });
}

function pickWait(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname + u.search).slice(0, 72);
  } catch {
    return String(url || '').slice(0, 72);
  }
}

function formatProxy(p) {
  return `${p.host}:${p.port}`;
}

class Rotator {
  constructor(deps) {
    this.deps = deps;
    this.running = false;
    this.gen = 0;
    this.logs = [];
    this.failedCount = 0;
    this.config = null;
    this.proxies = [];
    this.articles = [];
    this.queue = [];
    this.doneStore = null;
    this.workers = new Map();
    this.deadProxies = new Set();
    this._publish = deps.publish || (() => {});
  }

  workerState(tabId) {
    return this.workers.get(tabId) || {
      phase: 'idle',
      proxyIndex: 0,
      articleIndex: 0,
      proxyLabel: '—',
      locationLabel: '—',
      articleLabel: '—',
      articleUrl: '',
      nextArticleAt: null,
      loadDeadline: null,
      checkDeadline: null,
    };
  }

  addLog(level, message) {
    this.logs.unshift({ ts: Date.now(), level, message });
    if (this.logs.length > 80) this.logs.length = 80;
    this._publish();
  }

  snapshot(activeTabId) {
    const w = activeTabId ? this.workerState(activeTabId) : {};
    const tab = activeTabId ? this.deps.findTab(activeTabId) : null;
    const phase = this.running ? (w.phase !== 'idle' ? w.phase : 'applying_proxy') : 'idle';
    const listTotal = this.proxies.length || (this.deps.getCandidates?.()?.length ?? 0);
    return {
      running: this.running,
      phase,
      phaseLabel: PHASE_LABEL[phase] || PHASE_LABEL.idle,
      proxyIndex: w.proxyIndex ?? 0,
      proxyTotal: listTotal,
      proxyLabel: w.proxyLabel || '—',
      articleIndex: w.articleIndex ?? 0,
      articleTotal: this.articles.length,
      articleLabel: w.articleLabel || '—',
      articleUrl: w.articleUrl || '',
      locationLabel: w.locationLabel || '—',
      nextArticleAt: w.nextArticleAt,
      loadDeadline: w.loadDeadline,
      checkDeadline: w.checkDeadline,
      failedCount: this.failedCount,
      logs: this.logs,
      proxyCount: this.proxies.length,
      articleCount: this.articles.length,
      donePairs: this.doneStore?.countPairs() ?? 0,
      parallelTabs: this.config?.parallelTabs ?? 1,
      listsMessage: this.listsMessage || '',
      testInfo: tab?.testInfo ?? null,
    };
  }

  setWorker(tabId, patch) {
    const cur = this.workerState(tabId);
    this.workers.set(tabId, { ...cur, ...patch });
    this._publish();
  }

  buildQueue() {
    const q = [];
    for (let pi = 0; pi < this.proxies.length; pi++) {
      const proxy = this.proxies[pi];
      const pid = `${proxy.host}:${proxy.port}`;
      if (this.deadProxies.has(pid)) continue;
      for (let ai = 0; ai < this.articles.length; ai++) {
        const url = this.articles[ai];
        if (this.doneStore.alreadyRun(proxy, url)) continue;
        q.push({ proxy, article: url, proxyIndex: pi, articleIndex: ai });
      }
    }
    return q;
  }

  async prepareLists() {
    const info = await this.deps.loadLists();
    this.proxies = this.deps.getCandidates();
    this.articles = this.deps.getLinks();
    this.listsMessage = info.message || '';
    if (!this.proxies.length) throw Error('Chưa có proxy trong list-proxy.txt.');
    if (!this.articles.length) throw Error('Chưa có link trong list-link.txt.');
    this.config = await loadRotatorConfig(this.deps.appRoot);
    const file = path.join(this.deps.appRoot, 'geo-proxy-data.json');
    this.doneStore = new DoneStore(file);
    await this.doneStore.load();
  }

  async start() {
    if (this.running) throw Error('Rotator đang chạy.');
    await this.prepareLists();
    this.queue = this.buildQueue();
    if (!this.queue.length) throw Error('Mọi cặp proxy–bài đã chạy. Xoá geo-proxy-data.json để chạy lại.');
    this.running = true;
    this.gen += 1;
    const gen = this.gen;
    this.logs = [];
    this.failedCount = 0;
    this.workers.clear();
    this.addLog('info', `Bắt đầu: ${this.proxies.length} proxy, ${this.articles.length} bài, ${this.queue.length} việc, ${this.config.parallelTabs} tab song song.`);
    await this.deps.ensureWorkerTabs(this.config.parallelTabs);
    for (const tab of this.deps.getWorkerTabs()) {
      this.runWorker(tab, gen).catch((e) => this.addLog('error', e.message || String(e)));
    }
    this._publish();
    return this.snapshot(this.deps.getActiveTabId());
  }

  async stop() {
    this.running = false;
    this.gen += 1;
    for (const tab of this.deps.getWorkerTabs()) {
      tab.net?.cancel();
      await stopHumanScroll(tab.view.webContents).catch(() => {});
      this.setWorker(tab.id, { phase: 'idle', nextArticleAt: null, loadDeadline: null });
    }
    this.addLog('info', 'Đã dừng rotator.');
    this._publish();
  }

  async nextArticle(activeTabId) {
    const tab = this.deps.findTab(activeTabId);
    if (!tab) throw Error('Chọn tab worker.');
    const w = this.workerState(tab.id);
    if (!this.running || (w.phase !== 'waiting' && w.phase !== 'loading_article')) {
      throw Error('Tab chưa ở giai đoạn chờ hoặc đang mở bài.');
    }
    tab._rotatorSkipWait = true;
    tab.net?.cancel();
    this.addLog('info', `Tab ${tab.id}: Next tự động — chuyển bài ngay.`);
    this._publish();
    return this.snapshot(activeTabId);
  }

  async runWorker(tab, gen) {
    while (this.running && this.gen === gen && !tab.closing) {
      const job = this.queue.shift();
      if (!job) break;
      try {
        await this.runJob(tab, job, gen);
      } catch (e) {
        if (!this.running || this.gen !== gen) break;
        this.failedCount += 1;
        this.addLog('error', `Tab ${tab.id}: ${e.message || e}`);
        const pid = `${job.proxy.host}:${job.proxy.port}`;
        this.deadProxies.add(pid);
      }
    }
    if (this.running && this.gen === gen && !this.queue.length) {
      if (this.config.loop) {
        this.queue = this.buildQueue();
        if (this.queue.length) {
          this.addLog('info', 'Lặp lại danh sách — tiếp tục queue.');
          return this.runWorker(tab, gen);
        }
      }
      this.addLog('success', 'Hoàn tất hàng đợi.');
      this.running = false;
      this._publish();
    }
  }

  async runJob(tab, job, gen) {
    const { proxy, article, proxyIndex, articleIndex } = job;
    const signal = { aborted: false, throwIfAborted() { if (this.aborted) throw Error('Đã dừng.'); } };
    const abort = () => { signal.aborted = true; };
    tab._rotatorAbort = abort;
    tab._rotatorSkipWait = false;

    this.setWorker(tab.id, {
      phase: 'applying_proxy',
      proxyIndex,
      articleIndex,
      proxyLabel: formatProxy(proxy),
      articleLabel: shortenUrl(article),
      articleUrl: article,
      locationLabel: '—',
    });
    this.addLog('info', `Tab ${tab.id} · Proxy ${proxyIndex + 1}/${this.proxies.length}: ${formatProxy(proxy)}`);

    const location = pickLocation();
    await tab.net.run(async (netSignal) => {
      netSignal.throwIfAborted();
      this.setWorker(tab.id, { phase: 'checking', checkDeadline: Date.now() + this.config.proxyTimeoutSec * 1000 });
      await this.deps.connectTab(tab, { ...proxy, city: location.name }, netSignal);
      if (!this.running || this.gen !== gen) throw Error('Đã dừng.');
      this.setWorker(tab.id, { phase: 'spoofing', locationLabel: `${location.name} (${location.timezone})` });
      await applyLocation(tab, location);
      this.addLog('info', `Tab ${tab.id}: Vị trí ${location.name}`);
      this.setWorker(tab.id, {
        phase: 'loading_article',
        loadDeadline: Date.now() + this.config.articleLoadTimeoutSec * 1000,
      });
      await this.deps.loadTabUrl(tab, targetURL(article));
      await this.waitForArticle(tab, this.config.articleLoadTimeoutSec * 1000, gen);
      if (!this.running || this.gen !== gen) throw Error('Đã dừng.');
      await this.doneStore.remember(proxy, article, { ok: true });
      await this.doneStore.save();
      const waitSec = pickWait(this.config.waitMinSec, this.config.waitMaxSec);
      const when = Date.now() + waitSec * 1000;
      this.setWorker(tab.id, { phase: 'waiting', nextArticleAt: when, loadDeadline: null });
      this.addLog('info', `Tab ${tab.id}: Cuộn + chờ ${waitSec}s trước bài tiếp.`);
      await beginHumanScroll(tab.view.webContents, this.config);
      await this.waitUntil(tab, when, gen);
      await stopHumanScroll(tab.view.webContents);
    });
    this.setWorker(tab.id, { phase: 'switching' });
    await delay(300);
    this.setWorker(tab.id, { phase: 'idle', nextArticleAt: null });
  }

  waitForArticle(tab, timeoutMs, gen) {
    const wc = tab.view.webContents;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wc.removeListener('did-stop-loading', onLoad);
        resolve();
      };
      const onLoad = () => {
        if (!wc.isLoading()) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      if (!wc.isLoading()) finish();
      else wc.on('did-stop-loading', onLoad);
      const poll = setInterval(() => {
        if (!this.running || this.gen !== gen) { clearInterval(poll); finish(); }
      }, 500);
    });
  }

  waitUntil(tab, when, gen) {
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (!this.running || this.gen !== gen) { resolve(); return; }
        if (tab._rotatorSkipWait || Date.now() >= when) { resolve(); return; }
        setTimeout(tick, 400);
      };
      tick();
    });
  }
}

module.exports = { Rotator, PHASE_LABEL };
