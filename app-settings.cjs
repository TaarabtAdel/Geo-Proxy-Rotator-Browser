const { parseProxySource, proxyToLine, proxyKey } = require('./parse-proxy.cjs');
const { loadProxyList, loadLinkList, proxyToCandidate } = require('./local-lists.cjs');
const { normalizeConfig, loadRotatorConfig } = require('./rotator-config.cjs');
const { articlePairKey } = require('./geo-data.cjs');

// Giống data/proxy-sources.js của extension.
const DEFAULT_PROXY_SOURCES = [
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/http.txt',
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/socks4.txt|socks4',
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/socks5.txt|socks5',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/US/data.txt',
  'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/US/data.txt',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=US&ssl=all&anonymity=all',
  'https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/us/data.json',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=US&ssl=all&anonymity=all|socks5',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=US&ssl=all&anonymity=all|socks4',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&country=us',
].join('\n');

const TIMING_KEYS = [
  'waitMinSec', 'waitMaxSec', 'proxyTimeoutSec', 'articleLoadTimeoutSec',
  'scrollEnabled', 'scrollSpeed', 'scrollDepthPercent', 'loop',
];

function lines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function configProxies(config) {
  if (typeof config.proxyText === 'string' && config.proxyText.trim()) {
    return parseProxySource(config.proxyText).proxies;
  }
  if (Array.isArray(config.proxies) && config.proxies.length) {
    return parseProxySource(config.proxies.map((p) => proxyToLine(p)).join('\n')).proxies;
  }
  return [];
}

function configArticles(config) {
  const list = Array.isArray(config.articles) && config.articles.length
    ? config.articles
    : lines(config.articleText);
  return list.map(String).filter((u) => /^https?:\/\//i.test(u));
}

function toCandidates(proxies) {
  const items = [];
  const seen = new Set();
  for (const p of proxies) {
    const item = proxyToCandidate(p);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({ ...item, source: 'geo-proxy-data.json' });
  }
  return items;
}

// Đổi khi extension hoặc trang Cài đặt sửa proxy / bài / nhịp chạy trong geo-proxy-data.json.
function configStamp(config) {
  const c = config || {};
  return JSON.stringify([c.proxyText || '', c.proxyText ? 0 : c.proxies, c.articles, c.articleText, TIMING_KEYS.map((k) => c[k])]);
}

// geo-proxy-data.json (config) là nguồn chính. list-proxy.txt / list-link.txt / geo-config.json
// chỉ dùng khi config chưa có mục tương ứng (máy mới, file dữ liệu trống).
async function resolveLists(store, baseDir) {
  const cfg = store.config || {};
  const fileConfig = await loadRotatorConfig(baseDir);

  let candidates = toCandidates(configProxies(cfg));
  let proxySource = 'geo-proxy-data.json';
  if (!candidates.length) {
    const fromFile = await loadProxyList(baseDir).catch(() => null);
    candidates = fromFile ? fromFile.items : [];
    proxySource = fromFile ? 'list-proxy.txt' : '';
  }

  let links = configArticles(cfg);
  let linkSource = 'geo-proxy-data.json';
  if (!links.length) {
    links = await loadLinkList(baseDir);
    linkSource = links.length ? 'list-link.txt' : '';
  }

  const timing = {};
  for (const k of TIMING_KEYS) if (cfg[k] !== undefined) timing[k] = cfg[k];
  const runnerConfig = normalizeConfig({ ...fileConfig, ...timing });
  return { candidates, links, runnerConfig, proxySource, linkSource };
}

function parseSourceLine(raw) {
  const text = String(raw || '').trim();
  let urlText = text;
  let forceProtocol = '';
  const splitAt = text.lastIndexOf('|');
  if (splitAt > 0) {
    const tag = text.slice(splitAt + 1).trim().toLowerCase();
    if (tag === 'socks4' || tag === 'socks5') {
      urlText = text.slice(0, splitAt).trim();
      forceProtocol = tag;
    }
  }
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw Error('URL nguồn không hợp lệ: ' + text);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Error('URL nguồn phải là http hoặc https: ' + text);
  return { url: url.href, forceProtocol };
}

function formatSourceLine(source) {
  return source.forceProtocol ? source.url + '|' + source.forceProtocol : source.url;
}

function sourceEntries(text) {
  const entries = [];
  const seen = new Set();
  for (const raw of lines(text || DEFAULT_PROXY_SOURCES)) {
    const entry = parseSourceLine(raw);
    const key = formatSourceLine(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  if (!entries.length) throw Error('Chưa có URL nguồn proxy.');
  return entries;
}

function sourceLabel(url) {
  if (url.includes('cdn.jsdelivr.net')) return 'jsDelivr';
  if (url.includes('api.proxyscrape.com')) return 'ProxyScrape API';
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const SOURCE_MAX_BYTES = 8 * 1024 * 1024;

// Tải mọi nguồn cùng lúc, gộp theo thứ tự nguồn, bỏ trùng.
async function fetchProxySources(sourceText, fetcher) {
  const sources = sourceEntries(sourceText);
  const results = await Promise.all(sources.map(async (source) => {
    const label = sourceLabel(source.url) + (source.forceProtocol ? ' ' + source.forceProtocol : '');
    try {
      const res = await fetcher(source.url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length > SOURCE_MAX_BYTES) throw Error('danh sách quá lớn');
      const { proxies } = parseProxySource(text);
      if (source.forceProtocol) for (const p of proxies) p.protocol = source.forceProtocol;
      return { label, proxies };
    } catch (e) {
      return { label, error: e.message || 'không tải được' };
    }
  }));
  const merged = [];
  const seen = new Set();
  const notes = [];
  const errors = [];
  for (const r of results) {
    if (r.error) { errors.push(r.label + ': ' + r.error); continue; }
    notes.push(r.label + ' ' + r.proxies.length);
    for (const p of r.proxies) {
      const key = proxyKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
    }
  }
  if (!merged.length) throw Error(errors.join(' · ') || 'Không tìm thấy proxy trong các nguồn.');
  return {
    sourceText: sources.map(formatSourceLine).join('\n'),
    proxyText: merged.map(proxyToLine).join('\n'),
    count: merged.length,
    notes,
    errors,
  };
}

function validateArticles(text) {
  const urls = [];
  const seen = new Set();
  const errors = [];
  lines(text).forEach((line, index) => {
    let url;
    try {
      url = new URL(line);
    } catch {
      errors.push('Dòng ' + (index + 1) + ' không phải URL hợp lệ.');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push('Dòng ' + (index + 1) + ' phải là URL http hoặc https.');
      return;
    }
    // Bỏ trùng theo link gốc nhưng giữ nguyên URL (kể cả fbclid) để mở bài.
    const key = articlePairKey(url.href) || url.href;
    if (seen.has(key)) return;
    seen.add(key);
    urls.push(line);
  });
  return { urls, errors };
}

function intIn(value, min, max, message) {
  const n = Math.round(Number(value));
  if (!Number.isInteger(n) || n < min || n > max) throw Error(message);
  return n;
}

// Cùng quy tắc readForm() trong options.js của extension.
function settingsPatch(form) {
  const articles = validateArticles(form.articleText);
  if (articles.errors.length) throw Error(articles.errors[0]);
  const parsed = parseProxySource(form.proxyText);
  const rawLines = lines(form.proxyText).filter((l) => !l.startsWith('#'));
  if (rawLines.length && !parsed.proxies.length) {
    throw Error('Không có dòng proxy hợp lệ. Dùng ip:port, ip:port:user:pass hoặc socks5://ip:port.');
  }
  let waitMin = intIn(form.waitMinSec, 1, 3600, 'Thời gian chờ phải từ 1 đến 3600 giây.');
  let waitMax = intIn(form.waitMaxSec, 1, 3600, 'Thời gian chờ phải từ 1 đến 3600 giây.');
  if (waitMin > waitMax) [waitMin, waitMax] = [waitMax, waitMin];
  return {
    proxySourceUrl: sourceEntries(form.proxySourceUrl).map(formatSourceLine).join('\n'),
    proxyText: parsed.proxies.map(proxyToLine).join('\n'),
    proxies: parsed.proxies,
    articleText: articles.urls.join('\n'),
    articles: articles.urls,
    waitMinSec: waitMin,
    waitMaxSec: waitMax,
    proxyTimeoutSec: intIn(form.proxyTimeoutSec, 5, 180, 'Timeout proxy phải từ 5 đến 180 giây.'),
    articleLoadTimeoutSec: intIn(form.articleLoadTimeoutSec, 15, 300, 'Timeout tải bài phải từ 15 đến 300 giây.'),
    scrollEnabled: Boolean(form.scrollEnabled),
    scrollSpeed: ['slow', 'normal', 'fast'].includes(form.scrollSpeed) ? form.scrollSpeed : 'normal',
    scrollDepthPercent: intIn(form.scrollDepthPercent, 50, 100, 'Độ sâu cuộn phải từ 50 đến 100%.'),
    loop: Boolean(form.loop),
  };
}

// Giá trị đang chạy thật, để trang Cài đặt hiện đúng cả khi config còn trống (đang dùng file .txt).
function settingsForm(store, current) {
  const cfg = store.config || {};
  const c = current.runnerConfig;
  return {
    proxySourceUrl: cfg.proxySourceUrl || DEFAULT_PROXY_SOURCES,
    proxyText: current.candidates.map((p) => proxyToLine({ ...p, protocol: p.type, username: p.user })).join('\n'),
    articleText: current.links.join('\n'),
    waitMinSec: c.waitMinSec,
    waitMaxSec: c.waitMaxSec,
    proxyTimeoutSec: c.proxyTimeoutSec,
    articleLoadTimeoutSec: c.articleLoadTimeoutSec,
    scrollEnabled: c.scrollEnabled,
    scrollSpeed: c.scrollSpeed,
    scrollDepthPercent: c.scrollDepthPercent,
    loop: c.loop,
  };
}

const STATUS = {
  checking: 'Đang kiểm tra',
  using: 'Đang dùng',
  busy: 'Bận',
  live: 'Live',
  dead: 'Không',
  untried: 'Chưa thử',
  unsupported: 'Không hỗ trợ',
};

function proxyRow(p, store, leaseStatus) {
  const candidate = proxyToCandidate(p);
  const row = {
    line: proxyToLine(p),
    host: p.host,
    port: p.port,
    protocol: (p.protocol || 'http').toUpperCase(),
    auth: Boolean(p.username),
    status: STATUS.untried,
    kind: 'untried',
    title: '',
  };
  if (!candidate) {
    return { ...row, status: STATUS.unsupported, kind: 'unsupported', title: 'SOCKS có mật khẩu: app chỉ hỗ trợ tài khoản với HTTP proxy.' };
  }
  const health = store.healthOf(candidate);
  const ip = health && health.ip ? 'IP ' + health.ip : '';
  const lease = leaseStatus(candidate.id);
  if (lease) return { ...row, status: STATUS[lease], kind: lease === 'checking' ? 'pending' : 'busy', title: ip };
  if (store.isBusyExternal(candidate)) return { ...row, status: STATUS.busy, kind: 'busy', title: 'Extension đang dùng, app tạm bỏ qua.' };
  const s = health && health.status;
  if (s === 'live') return { ...row, status: STATUS.live, kind: 'live', title: ip || 'Kết nối thành công' };
  if (s && s !== 'unknown' && s !== 'pending') return { ...row, status: STATUS.dead, kind: 'dead', title: health.note || 'Proxy lỗi' };
  return row;
}

function inspectProxies(text, store, leaseStatus) {
  const { proxies, skipped } = parseProxySource(text);
  const rows = proxies.map((p) => proxyRow(p, store, leaseStatus));
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { rows, skipped, total: rows.length, counts };
}

module.exports = {
  DEFAULT_PROXY_SOURCES,
  STATUS,
  resolveLists,
  configStamp,
  fetchProxySources,
  sourceEntries,
  validateArticles,
  settingsPatch,
  settingsForm,
  inspectProxies,
};
