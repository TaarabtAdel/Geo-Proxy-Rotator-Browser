const fs = require('node:fs/promises');
const path = require('node:path');
const { proxyStorageKey } = require('./done-store.cjs');

// Cùng định dạng geo-proxy-data.json của extension Geo-Proxy-Rotator (data/shared-store.js).
const OWNER = 'geo-proxy-rotator-browser';
const TRACKING = ['fbclid', 'gclid', 'dclid', 'msclkid', 'twclid', 'wbraid', 'gbraid', 'mc_eid'];

function articlePairKey(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    for (const name of TRACKING) url.searchParams.delete(name);
    for (const name of [...url.searchParams.keys()]) if (/^utm_/i.test(name)) url.searchParams.delete(name);
    url.hash = '';
    return url.href;
  } catch {
    return text.replace(/([?&])fbclid=[^&#]*/gi, '$1').replace(/[?&]$/, '');
  }
}

function pairUrl(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.url === 'string') return entry.url;
  return '';
}

function pairOk(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.ok !== 'boolean') return null;
  return entry.ok;
}

// Thành công giữ lại. Lỗi chỉ ghi khi chưa từng chạy được. Chuỗi là cặp chưa rõ kết quả.
function mergePair(prev, next) {
  const url = articlePairKey(pairUrl(next) || pairUrl(prev));
  if (!url) return null;
  const prevOk = pairOk(prev);
  const nextOk = pairOk(next);
  if (prevOk === true || nextOk === true) return { url, ok: true, at: Date.now() };
  if (prevOk === false || nextOk === false) {
    const source = nextOk === false ? next : prev;
    const note = String((source && source.note) || '').slice(0, 160);
    const item = { url, ok: false, at: Number(source && source.at) || Date.now() };
    if (note) item.note = note;
    return item;
  }
  return url;
}

function normalizeEntry(entry) {
  const url = articlePairKey(pairUrl(entry));
  if (!url) return null;
  if (typeof entry === 'string') return url;
  const atNum = Number(entry.at);
  const at = Number.isFinite(atNum) && atNum > 0 ? atNum : (Date.parse(entry.at) || Date.now());
  if (entry.ok === true) return { url, ok: true, at };
  if (entry.ok === false) {
    const item = { url, ok: false, at };
    if (entry.note) item.note = String(entry.note).slice(0, 160);
    return item;
  }
  return url;
}

function rank(entry) {
  const ok = pairOk(entry);
  return ok === true ? 2 : ok === false ? 1 : 0;
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

const LEASE_MS = 180000;

// Cứu file JSON bị cắt ngang: giữ mọi phần tử đã đủ trước dấu phẩy cuối cùng
// rồi đóng các ngoặc còn mở.
function salvageJson(text) {
  const stack = [];
  let inString = false;
  let escape = false;
  let cut = -1;
  let closers = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.length) {
      cut = i;
      closers = stack.slice().reverse().join('');
    }
  }
  if (cut < 0) return null;
  try {
    return JSON.parse(text.slice(0, cut) + closers);
  } catch {
    return null;
  }
}

function summarizeDone(map) {
  const stat = { total: 0, ok: 0, bad: 0, unknown: 0, notes: {} };
  for (const list of Object.values(map || {})) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      stat.total += 1;
      if (entry && typeof entry === 'object' && entry.ok === true) stat.ok += 1;
      else if (entry && typeof entry === 'object' && entry.ok === false) {
        stat.bad += 1;
        const note = String(entry.note || 'Không tải được').slice(0, 80);
        stat.notes[note] = (stat.notes[note] || 0) + 1;
      } else stat.unknown += 1;
    }
  }
  const reasons = Object.entries(stat.notes)
    .map(([note, count]) => ({ note, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  return { total: stat.total, ok: stat.ok, bad: stat.bad, unknown: stat.unknown, reasons };
}

class GeoDataStore {
  constructor(baseDir) {
    this.file = path.join(baseDir, 'geo-proxy-data.json');
    this.config = {};
    this.done = {};
    this.health = {};
    this.lease = {};
    this.mtimeMs = null;
    this.rev = 0;
    this._stats = null;
    this._queue = Promise.resolve();
  }

  _enqueue(fn) {
    const job = this._queue.then(fn, fn);
    this._queue = job.catch(() => {});
    return job;
  }

  async _mtime() {
    try {
      return (await fs.stat(this.file)).mtimeMs;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async _read() {
    let raw = {};
    let text = '';
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch (e) {
        const backup = this.file.replace(/\.json$/, `.broken-${Date.now()}.json`);
        await fs.copyFile(this.file, backup);
        raw = salvageJson(text) || {};
        this.recovered = { backup: path.basename(backup), error: e.message };
      }
    }
    this.mtimeMs = await this._mtime();
    this.config = isObject(raw.config) ? raw.config : {};
    this.health = isObject(raw.proxyHealth) ? raw.proxyHealth : {};
    this.lease = isObject(raw.proxyLease) ? raw.proxyLease : {};
    this.done = {};
    const done = isObject(raw.proxyArticleDone) ? raw.proxyArticleDone : (isObject(raw.done) ? raw.done : {});
    for (const [key, list] of Object.entries(done)) {
      if (!Array.isArray(list)) continue;
      const byUrl = new Map();
      for (const entry of list) {
        const item = normalizeEntry(entry);
        if (!item) continue;
        const k = pairUrl(item);
        const prev = byUrl.get(k);
        if (!prev || rank(item) > rank(prev)) byUrl.set(k, item);
      }
      this.done[key] = [...byUrl.values()];
    }
    for (const h of Object.values(this.health)) {
      if (h && h.updatedAt == null && h.at != null) { h.updatedAt = h.at; delete h.at; }
    }
    this.rev += 1;
  }

  async _write() {
    const payload = {
      version: 1,
      savedAt: Date.now(),
      config: this.config,
      proxyHealth: this.health,
      proxyArticleDone: this.done,
      proxyLease: this.lease,
    };
    // Ghi ra file tạm rồi đổi tên: tắt app giữa chừng không làm hỏng file đang có.
    const tmp = `${this.file}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
    this.mtimeMs = await this._mtime();
  }

  async _syncFromDisk() {
    const m = await this._mtime();
    if (m !== this.mtimeMs) await this._read();
  }

  // Đọc lại nếu file bị thay bên ngoài (vd. chép file từ extension khi app đang chạy),
  // rồi mới sửa + ghi, để không đè mất dữ liệu mới.
  _mutate(fn) {
    return this._enqueue(async () => {
      await this._syncFromDisk();
      if (fn() === false) return;
      this.rev += 1;
      await this._write();
    });
  }

  // Máy mới clone từ git chưa có geo-proxy-data.json thì lấy dữ liệu mẫu đã commit.
  async seedFrom(sampleFile) {
    try {
      await fs.copyFile(sampleFile, this.file, fs.constants.COPYFILE_EXCL);
      return true;
    } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'ENOENT') return false;
      throw e;
    }
  }

  load() {
    return this._enqueue(() => this._read());
  }

  refreshIfChanged() {
    return this._enqueue(() => this._syncFromDisk());
  }

  save() {
    return this._enqueue(() => this._write());
  }

  alreadyRun(proxy, url) {
    const list = this.done[proxyStorageKey(proxy)];
    if (!Array.isArray(list)) return false;
    const key = articlePairKey(url);
    return list.some((e) => pairUrl(e) === key);
  }

  remember(proxy, url, outcome) {
    return this._mutate(() => {
      const pk = proxyStorageKey(proxy);
      const list = Array.isArray(this.done[pk]) ? this.done[pk] : (this.done[pk] = []);
      const key = articlePairKey(url);
      const incoming = outcome && typeof outcome.ok === 'boolean'
        ? { url: key, ok: outcome.ok, note: outcome.ok ? '' : String(outcome.note || '').slice(0, 160) }
        : key;
      const idx = list.findIndex((e) => pairUrl(e) === key);
      const merged = mergePair(idx >= 0 ? list[idx] : null, incoming);
      if (!merged) return false;
      if (idx >= 0) list[idx] = merged;
      else list.push(merged);
      return true;
    });
  }

  setHealth(proxy, status, extra = {}) {
    return this._mutate(() => {
      const pk = proxyStorageKey(proxy);
      const prev = this.health[pk] || {};
      this.health[pk] = {
        status,
        updatedAt: Date.now(),
        owner: OWNER,
        ip: extra.ip || prev.ip || '',
        note: String(extra.note || '').slice(0, 160),
      };
      return true;
    });
  }

  saveHealth() {
    return this._enqueue(() => {});
  }

  // Giữ nguyên các khoá config khác (extension có thể ghi thêm), chỉ thay khoá trong patch.
  updateConfig(patch) {
    return this._mutate(() => {
      this.config = { ...this.config, ...patch };
      return true;
    });
  }

  clearHealth() {
    return this._mutate(() => {
      this.health = {};
      return true;
    });
  }

  clearDone() {
    return this._mutate(() => {
      this.done = {};
      return true;
    });
  }

  clearProxies() {
    return this._mutate(() => {
      this.config = { ...this.config, proxyText: '', proxies: [] };
      this.health = {};
      this.lease = {};
      return true;
    });
  }

  healthOf(proxy) {
    return this.health[proxyStorageKey(proxy)] || null;
  }

  doneSummary() {
    return summarizeDone(this.done);
  }

  isDead(proxy) {
    return this.health[proxyStorageKey(proxy)]?.status === 'dead';
  }

  // Proxy đang được extension (owner khác) giữ, lease còn hạn.
  isBusyExternal(proxy) {
    const l = this.lease[proxyStorageKey(proxy)];
    return Boolean(l && l.owner !== OWNER && Date.now() - Number(l.claimedAt || 0) < LEASE_MS);
  }

  countPairs() {
    let n = 0;
    for (const list of Object.values(this.done)) if (Array.isArray(list)) n += list.length;
    return n;
  }

  pendingPairExists(proxies, articles, { skipDead = false } = {}) {
    for (const proxy of proxies || []) {
      if (skipDead && this.isDead(proxy)) continue;
      for (const url of articles || []) {
        if (!this.alreadyRun(proxy, url)) return true;
      }
    }
    return false;
  }

  // 'pending' là extension ghi khi giữ proxy ("Đang dùng") và có thể bị bỏ lại khi extension tắt.
  // Bận thật hay không đã do proxyLease quyết định, nên pending tính như Chưa thử (app vẫn thử nó).
  healthBucket(proxy) {
    if (this.isBusyExternal(proxy)) return 'busy';
    const s = this.health[proxyStorageKey(proxy)]?.status;
    if (!s || s === 'unknown' || s === 'pending') return 'untried';
    if (s === 'live') return 'live';
    return 'dead';
  }

  // Giống trang Cài đặt của extension: thống kê cặp + tình trạng proxy trong list.
  // leaseStatus(id) trả về 'checking' (tab đang kiểm tra), 'using' (tab đang chạy bài) hoặc null.
  stats(candidates, leaseStatus) {
    const list = candidates || [];
    if (!this._stats || this._stats.rev !== this.rev || this._stats.list !== list) {
      const buckets = new Map();
      const counts = { untried: 0, dead: 0, busy: 0, live: 0 };
      for (const p of list) {
        const b = this.healthBucket(p);
        buckets.set(p.id, b);
        counts[b] += 1;
      }
      this._stats = { rev: this.rev, list, buckets, counts, done: summarizeDone(this.done) };
    }
    const counts = { ...this._stats.counts, inUse: 0, checking: 0 };
    for (const p of list) {
      const status = leaseStatus ? leaseStatus(p.id) : null;
      if (!status) continue;
      if (status === 'checking') counts.checking += 1;
      else counts.inUse += 1;
      counts[this._stats.buckets.get(p.id)] -= 1;
    }
    return { total: list.length, ...counts, done: this._stats.done };
  }
}

module.exports = { GeoDataStore, articlePairKey, mergePair, summarizeDone, salvageJson };

