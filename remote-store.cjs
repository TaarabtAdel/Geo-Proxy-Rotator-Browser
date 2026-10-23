const fs = require('node:fs');
const { GeoDataStore } = require('./geo-data.cjs');
const { proxyStorageKey } = require('./done-store.cjs');
const { ProxyLease } = require('./proxy-lease.cjs');

const PULL_MIN_MS = 2000;
const BATCH_MAX = 500;
const OUTBOX_SAVE_MS = 500;

function pairUrl(entry) {
  return typeof entry === 'string' ? entry : (entry && entry.url) || '';
}

// Cùng giao diện GeoDataStore nhưng dữ liệu nằm trên máy chủ auto-post (/api/geo-sync).
// Ghi được áp dụng ngay trong bộ nhớ rồi gửi dồn lên máy chủ; mất mạng thì giữ lại gửi sau.
class RemoteGeoDataStore extends GeoDataStore {
  // presence(): thông tin máy gửi kèm mỗi lần kéo (để /geo thấy máy online). onCommands(list): lệnh từ /geo (tắt máy).
  // outboxFile: nơi lưu các lệnh ghi chưa gửi được, để tắt app lúc mất mạng không mất kết quả đã chạy.
  constructor(client, machine, { presence, onCommands, outboxFile } = {}) {
    super('.');
    this.client = client;
    this.machine = machine;
    this.presence = presence;
    this.onCommands = onCommands;
    this.outboxFile = outboxFile || null;
    this.file = `${client.url} (máy ${machine})`;
    this.seq = -1;
    this.outbox = this._readOutbox();
    this.flushing = null;
    this.flushTimer = null;
    this.saveTimer = null;
    this.lastPull = 0;
  }

  // Hàng chờ chỉ thuộc đúng máy chủ + user đã ghi ra nó: đổi user thì không gửi nhầm sang tài khoản khác.
  _readOutbox() {
    if (!this.outboxFile) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.outboxFile, 'utf8'));
      if (data.url !== this.client.url || data.userId !== this.client.userId || !Array.isArray(data.ops)) return [];
      return data.ops;
    } catch {
      return [];
    }
  }

  persistOutboxSync() {
    if (!this.outboxFile) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      if (!this.outbox.length) {
        fs.rmSync(this.outboxFile, { force: true });
        return;
      }
      const tmp = this.outboxFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        url: this.client.url,
        userId: this.client.userId,
        savedAt: Date.now(),
        ops: this.outbox,
      }));
      fs.renameSync(tmp, this.outboxFile);
    } catch { /* ghi file lỗi: vẫn còn bản trong bộ nhớ */ }
  }

  _scheduleSave() {
    if (!this.outboxFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.persistOutboxSync(), OUTBOX_SAVE_MS);
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
    this._scheduleSave();
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
          this._scheduleSave();
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
// Chưa gia hạn được quá mốc này thì coi như mất chỗ giữ: dừng proxy đang dùng trước khi máy chủ (hạn 3 phút)
// trả nó cho máy khác. 110s = 180s hạn − 60s nhịp gia hạn − 10s dư.
const LEASE_LOST_AFTER_MS = 110000;

// Giữ chỗ proxy / IP đầu ra trên máy chủ để các máy không dùng trùng. Giữ chỗ trong máy vẫn qua ProxyLease.
class RemoteProxyLease extends ProxyLease {
  constructor(client, machine, { ttlMs = LEASE_TTL_MS, heartbeatMs = HEARTBEAT_MS, lostAfterMs = LEASE_LOST_AFTER_MS, now = Date.now } = {}) {
    super();
    this.client = client;
    this.machine = machine;
    this.ttlMs = ttlMs;
    this.heartbeatMs = heartbeatMs;
    this.lostAfterMs = lostAfterMs;
    this.now = now;
    this.held = new Map();
    this.timer = null;
    this.lastConfirmed = now();
    this.lostOnServer = false;
  }

  ownerOf(tabId) {
    return `${this.machine}#${tabId}`;
  }

  heldCount() {
    let n = 0;
    for (const keys of this.held.values()) n += keys.size;
    return n;
  }

  // true khi đang giữ proxy mà không chắc máy chủ còn giữ cho mình (mất mạng lâu, hoặc chỗ giữ bị trả trên /geo).
  leaseLost() {
    if (!this.heldCount()) return false;
    return this.lostOnServer || this.now() - this.lastConfirmed > this.lostAfterMs;
  }

  async renew() {
    const expected = this.heldCount();
    const r = await this.client.call('renew', { machine: this.machine, ttlMs: this.ttlMs });
    this.lastConfirmed = this.now();
    this.lostOnServer = expected > 0 && Number(r.renewed) < expected;
    return r;
  }

  async _claim(key, tabId) {
    const r = await this.client.call('claim', { key, owner: this.ownerOf(tabId), machine: this.machine, ttlMs: this.ttlMs });
    if (!r.ok) return false;
    if (!this.heldCount()) {
      this.lastConfirmed = this.now();
      this.lostOnServer = false;
    }
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
      if (!this.heldCount()) return;
      this.renew().catch(() => {});
    }, this.heartbeatMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    return this.client.call('release', { machine: this.machine }).catch(() => {});
  }
}

module.exports = { RemoteGeoDataStore, RemoteProxyLease };
