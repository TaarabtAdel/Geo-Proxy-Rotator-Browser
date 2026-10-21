const fs = require('node:fs/promises');
const path = require('node:path');
const { parseProxySource, proxyKey } = require('./parse-proxy.cjs');

function listsDir(baseDir) {
  return baseDir || path.dirname(require.main?.filename || __filename);
}

function proxyToCandidate(p) {
  const protocol = p.protocol === 'socks5' || p.protocol === 'socks4' ? p.protocol : 'http';
  if (protocol !== 'http' && (p.username || p.password)) return null;
  const item = {
    id: proxyKey(p),
    type: protocol,
    host: p.host,
    port: p.port,
    user: p.username || '',
    password: p.password || '',
    source: 'list-proxy.txt',
    status: 'Chưa kiểm tra',
  };
  return item;
}

async function loadProxyList(baseDir) {
  const file = path.join(listsDir(baseDir), 'list-proxy.txt');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw Error('Không tìm thấy list-proxy.txt cạnh ứng dụng.');
    throw e;
  }
  const { proxies, skipped } = parseProxySource(text);
  const items = [];
  const seen = new Set();
  for (const p of proxies) {
    const item = proxyToCandidate(p);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  if (!items.length) throw Error('list-proxy.txt không có proxy hợp lệ.' + (skipped ? ` (${skipped} dòng bỏ qua)` : ''));
  return { items, skipped, file };
}

async function loadLinkList(baseDir) {
  const file = path.join(listsDir(baseDir), 'list-link.txt');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /^https?:\/\//i.test(line));
}

module.exports = { loadProxyList, loadLinkList, listsDir };
