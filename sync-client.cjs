const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const SYNC_FILE = 'sync.json';

// mode 'local': đọc / ghi private-data/geo-proxy-data.json. 'host': đọc / ghi qua API auto-post.
// installId: 4 ký tự cố định của bản cài này, ghép sau IP để hai máy chung IP (cùng mạng) không bị coi là một.
function normalizeSyncConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const installId = /^[0-9a-f]{4}$/.test(String(c.installId || '')) ? c.installId : randomBytes(2).toString('hex');
  return {
    mode: c.mode === 'host' || (c.mode === undefined && c.enabled === true) ? 'host' : 'local',
    url: String(c.url || '').trim().replace(/\/+$/, ''),
    key: String(c.key || '').trim(),
    installId,
  };
}

// Tên máy trên máy chủ = IP public lúc mở app + installId, ví dụ 113.161.5.20-a3f9.
function machineId(ip, installId) {
  return `${ip || 'khong-ro-ip'}-${installId}`;
}

// Gọi thẳng (không qua proxy của tab) để lấy IP public của máy lúc mở app.
async function detectPublicIp(fetcher) {
  const services = [
    ['https://api.ipify.org?format=json', (d) => d.ip],
    ['https://ipwho.is/', (d) => d.ip],
  ];
  for (const [url, pick] of services) {
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const ip = String(pick(await res.json()) || '').trim();
      if (/^[0-9a-f.:]+$/i.test(ip)) return ip;
    } catch { /* thử dịch vụ kế */ }
  }
  return '';
}

// Cấu hình đồng bộ riêng từng máy (khoá, installId), không nằm trong dữ liệu dùng chung.
// Lần đầu chưa có installId thì tạo và ghi lại để giữ cố định.
async function loadSyncConfig(dataDir) {
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(path.join(dataDir, SYNC_FILE), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const c = normalizeSyncConfig(raw);
  if (!raw || raw.installId !== c.installId) await saveSyncConfig(dataDir, c);
  return c;
}

async function saveSyncConfig(dataDir, config) {
  const c = normalizeSyncConfig(config);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, SYNC_FILE), JSON.stringify(c, null, 2), 'utf8');
  return c;
}

class SyncOfflineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncOfflineError';
    this.code = 'SYNC_OFFLINE';
  }
}

// Gọi POST {url}/api/geo-sync lần lượt từng lệnh, để "trả proxy" luôn tới trước "giữ proxy mới".
class SyncClient {
  constructor({ url, key, machine, fetcher, timeoutMs = 20000 }) {
    if (!/^https?:\/\//i.test(url || '')) throw Error('URL máy chủ đồng bộ phải bắt đầu bằng http:// hoặc https://');
    if (!key) throw Error('Thiếu khoá đồng bộ.');
    Object.assign(this, { url: url.replace(/\/+$/, ''), key, machine, fetcher, timeoutMs });
    this.queue = Promise.resolve();
    this.online = null;
    this.lastError = '';
  }

  _send(action, payload) {
    return (async () => {
      let res;
      try {
        res = await this.fetcher(this.url + '/api/geo-sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-geo-sync-key': this.key },
          body: JSON.stringify({ ...payload, action }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        this.online = false;
        this.lastError = e.message || String(e);
        throw new SyncOfflineError('Không kết nối được máy chủ đồng bộ: ' + this.lastError);
      }
      let body = null;
      try { body = await res.json(); } catch { /* body rỗng */ }
      if (res.status >= 500 && res.status !== 503) {
        this.online = false;
        this.lastError = `HTTP ${res.status}`;
        throw new SyncOfflineError('Máy chủ đồng bộ lỗi: HTTP ' + res.status);
      }
      this.online = true;
      if (!res.ok) {
        this.lastError = body?.error || `HTTP ${res.status}`;
        throw Error(this.lastError);
      }
      this.lastError = '';
      return body || {};
    })();
  }

  call(action, payload = {}) {
    const job = this.queue.then(() => this._send(action, payload));
    this.queue = job.catch(() => {});
    return job;
  }
}

module.exports = {
  SyncClient,
  SyncOfflineError,
  loadSyncConfig,
  saveSyncConfig,
  normalizeSyncConfig,
  machineId,
  detectPublicIp,
};
