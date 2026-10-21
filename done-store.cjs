const fs = require('node:fs/promises');
const path = require('node:path');
const { proxyKey } = require('./parse-proxy.cjs');

function articlePathKey(raw) {
  try {
    const url = new URL(raw);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    return host + p;
  } catch {
    return '';
  }
}

function proxyStorageKey(proxy) {
  const protocol = proxy.type === 'socks5' || proxy.type === 'socks4' ? proxy.type : 'http';
  return proxyKey({ host: proxy.host, port: proxy.port, protocol, username: proxy.user });
}

class DoneStore {
  constructor(file) {
    this.file = file;
    this.map = {};
  }

  async load() {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const data = JSON.parse(text);
      this.map = data && typeof data.done === 'object' ? data.done : {};
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.map = {};
    }
    return this.map;
  }

  async save() {
    await fs.writeFile(this.file, JSON.stringify({ done: this.map, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  }

  alreadyRun(proxy, url) {
    const list = this.map[proxyStorageKey(proxy)];
    if (!Array.isArray(list)) return false;
    const key = articlePathKey(url);
    return list.some((e) => articlePathKey(e.url) === key);
  }

  remember(proxy, url, outcome) {
    const pk = proxyStorageKey(proxy);
    if (!this.map[pk]) this.map[pk] = [];
    const key = articlePathKey(url);
    const entry = { url, ok: outcome.ok === true, note: outcome.note || '', at: new Date().toISOString() };
    const idx = this.map[pk].findIndex((e) => articlePathKey(e.url) === key);
    if (idx >= 0) this.map[pk][idx] = entry;
    else this.map[pk].push(entry);
  }

  countPairs() {
    let n = 0;
    for (const list of Object.values(this.map)) if (Array.isArray(list)) n += list.length;
    return n;
  }
}

module.exports = { DoneStore, articlePathKey, proxyStorageKey };
