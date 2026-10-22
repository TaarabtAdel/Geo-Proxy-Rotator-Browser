const { GeoDataStore } = require('./geo-data.cjs');
const { proxyStorageKey } = require('./done-store.cjs');
const { ProxyLease } = require('./proxy-lease.cjs');

const PULL_MIN_MS = 2000;
const BATCH_MAX = 500;

function pairUrl(entry) {
  return typeof entry === 'string' ? entry : (entry && entry.url) || '';
}

// Cùng giao diện GeoDataStore nhưng dữ liệu nằm trên máy chủ auto-post (/api/geo-sync).
// Ghi được áp dụng ngay trong bộ nhớ rồi gửi dồn lên máy chủ; mất mạng thì giữ lại gửi sau.
class RemoteGeoDataStore extends GeoDataStore {
  // presence(): thông tin máy gửi kèm mỗi lần kéo (để /geo thấy máy online). onCommands(list): lệnh từ /geo (tắt máy).
  constructor(client, machine, { presence, onCommands } = {}) {
    super('.');
    this.client = client;
    this.machine = machine;
    this.presence = presence;
    this.onCommands = onCommands;
    this.file = `${client.url} (máy ${machine})`;
    this.seq = -1;
    this.outbox = [];
    this.flushing = null;
    this.flushTimer = null;
    this.lastPull = 0;
  }

  // Không xếp sau lượt kéo dữ liệu (có thể đang chờ mạng): ghi bộ nhớ ngay, phần gửi lên đã có outbox.
  _mutate(fn) {
    if (fn() !== false) this.rev += 1;
    return Promise.resolve();
  }

  async seedFrom() {
    return false;
  }

  save() {
    return this.flush();
  }

  _apply(r) {
    if (r.full) {
      this.config = r.config && typeof r.config === 'object' ? r.config : {};
      this.health = r.proxyHealth || {};
      this.done = {};
      for (const [key, list] of Object.entries(r.proxyArticleDone || {})) {
        if (Array.isArray(list)) this.done[key] = list;
      }
    } else {
      if (r.config) this.config = r.config;
      for (const [key, h] of Object.entries(r.health || {})) {
        if (h) this.health[key] = h;
        else delete this.health[key];
      }
      for (const { proxyKey, entry } of r.done || []) {
        const list = this.done[proxyKey] || (this.done[proxyKey] = []);
        const url = pairUrl(entry);
        const idx = list.findIndex((e) => pairUrl(e) === url);
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
      }
    }
    this.lease = {};
    for (const l of r.leases || []) {
      if (!l.key.startsWith('proxy:')) continue;
      this.lease[l.key.slice(6)] = { owner: l.owner, machine: l.machine, claimedAt: l.claimedAt, expiresAt: l.expiresAt };
    }
    // rev chỉ tăng khi dữ liệu thật sự đổi, để các phép tính nhớ theo rev (thống kê, "còn việc không") không chạy lại mỗi lần kéo.
    const leaseSig = Object.entries(this.lease).map(([k, l]) => k + '@' + l.machine).sort().join('|');
    const changed = r.full || r.config || Object.keys(r.health || {}).length || (r.done || []).length
      || leaseSig !== this.leaseSig;
    this.leaseSig = leaseSig;
    this.seq = r.seq;
    this.lastPull = Date.now();
    if (changed) this.rev += 1;
  }

  async _pull(force) {
    const r = await this.client.call('pull', {
      since: force ? -1 : this.seq,
      machine: this.machine,
      presence: this.presence ? this.presence() : undefined,
    });
    this._apply(r);
    if (r.commands?.length && this.onCommands) {
      try { this.onCommands(r.commands); } catch { /* lệnh lỗi không làm hỏng đồng bộ */ }
    }
  }

  load() {
    return this._enqueue(async () => {
      await this.flush().catch(() => {});
      await this._pull(true);
    });
  }

  refreshIfChanged() {
    if (Date.now() - this.lastPull < PULL_MIN_MS) return Promise.resolve();
    return this._enqueue(async () => {
      if (Date.now() - this.lastPull < PULL_MIN_MS) return;
      await this.flush();
      await this._pull(false);
    });
  }

  _push(op) {
    this.outbox.push(op);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flush().catch(() => {}); }, 300);
  }

  flush() {
    if (this.flushing) return this.flushing;
    if (!this.outbox.length) return Promise.resolve();
    this.flushing = (async () => {
      try {
        while (this.outbox.length) {
          const ops = this.outbox.slice(0, BATCH_MAX);
          await this.client.call('batch', { ops });
          this.outbox.splice(0, ops.length);
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  async remember(proxy, url, outcome) {
    await super.remember(proxy, url, outcome);
    this._push({ action: 'remember', proxyKey: proxyStorageKey(proxy), url, outcome: outcome || null });
  }

  async setHealth(proxy, status, extra = {}) {
    await super.setHealth(proxy, status, extra);
    this._push({
      action: 'setHealth',
      proxyKey: proxyStorageKey(proxy),
      entry: { status, ip: extra.ip || '', note: String(extra.note || '').slice(0, 160), owner: this.machine },
    });
  }

  async updateConfig(patch) {
    await this.client.call('updateConfig', { patch });
    return super.updateConfig(patch);
  }

  async clearHealth() {
    await this.client.call('clear', { what: 'health' });
    return super.clearHealth();
  }

  async clearDone() {
    await this.client.call('clear', { what: 'done' });
    return super.clearDone();
  }

  async clearProxies() {
    await this.client.call('clear', { what: 'proxies' });
    return super.clearProxies();
  }

  // Proxy đang được máy khác giữ (theo lần đồng bộ gần nhất). Giữ chỗ thật vẫn do máy chủ quyết định.
  isBusyExternal(proxy) {
    const l = this.lease[proxyStorageKey(proxy)];
    return Boolean(l && l.machine !== this.machine && l.expiresAt > Date.now());
  }
}

const LEASE_TTL_MS = 180000;
const HEARTBEAT_MS = 60000;

// Giữ chỗ proxy / IP đầu ra trên máy chủ để các máy không dùng trùng. Giữ chỗ trong máy vẫn qua ProxyLease.
class RemoteProxyLease extends ProxyLease {
  constructor(client, machine, { ttlMs = LEASE_TTL_MS } = {}) {
    super();
    this.client = client;
    this.machine = machine;
    this.ttlMs = ttlMs;
    this.held = new Map();
    this.timer = null;
  }

  ownerOf(tabId) {
    return `${this.machine}#${tabId}`;
  }

  async _claim(key, tabId) {
    const r = await this.client.call('claim', { key, owner: this.ownerOf(tabId), machine: this.machine, ttlMs: this.ttlMs });
    if (!r.ok) return false;
    if (!this.held.has(tabId)) this.held.set(tabId, new Set());
    this.held.get(tabId).add(key);
    return true;
  }

  claimRemote(proxy, tabId) {
    return this._claim('proxy:' + proxyStorageKey(proxy), tabId);
  }

  async claimIp(tabId, ip) {
    if (await this._claim('ip:' + ip, tabId)) return;
    const e = Error('IP đầu ra trùng với tab ở máy khác.');
    e.code = 'DUPLICATE_IP';
    throw e;
  }

  release(tabId) {
    super.release(tabId);
    const keys = this.held.get(tabId);
    if (!keys || !keys.size) return;
    this.held.delete(tabId);
    this.client.call('release', { owner: this.ownerOf(tabId), keys: [...keys] }).catch(() => {});
  }

  // Lần chạy trước tắt đột ngột có thể còn giữ chỗ: trả hết của máy này rồi mới bắt đầu.
  async start() {
    await this.client.call('release', { machine: this.machine }).catch(() => {});
    this.timer = setInterval(() => {
      if (!this.held.size) return;
      this.client.call('renew', { machine: this.machine, ttlMs: this.ttlMs }).catch(() => {});
    }, HEARTBEAT_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    return this.client.call('release', { machine: this.machine }).catch(() => {});
  }
}

module.exports = { RemoteGeoDataStore, RemoteProxyLease };
