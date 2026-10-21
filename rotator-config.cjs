const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = {
  waitMinSec: 100,
  waitMaxSec: 120,
  proxyTimeoutSec: 15,
  articleLoadTimeoutSec: 60,
  scrollEnabled: true,
  scrollSpeed: 'normal',
  scrollDepthPercent: 95,
  loop: false,
  parallelTabs: 5,
};

function clampSec(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.floor(n)) : fallback;
}

function normalizeConfig(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  c.waitMinSec = clampSec(c.waitMinSec, DEFAULTS.waitMinSec);
  c.waitMaxSec = clampSec(c.waitMaxSec, DEFAULTS.waitMaxSec);
  c.proxyTimeoutSec = clampSec(c.proxyTimeoutSec, DEFAULTS.proxyTimeoutSec);
  c.articleLoadTimeoutSec = clampSec(c.articleLoadTimeoutSec, DEFAULTS.articleLoadTimeoutSec);
  c.scrollDepthPercent = Math.min(100, Math.max(50, Number(c.scrollDepthPercent) || DEFAULTS.scrollDepthPercent));
  c.scrollSpeed = ['slow', 'normal', 'fast'].includes(c.scrollSpeed) ? c.scrollSpeed : 'normal';
  c.scrollEnabled = c.scrollEnabled !== false;
  c.loop = Boolean(c.loop);
  c.parallelTabs = Math.min(30, Math.max(1, Math.floor(Number(c.parallelTabs) || DEFAULTS.parallelTabs)));
  return c;
}

// Bỏ chú thích // và /* */ (ngoài chuỗi) để geo-config.json ghi được giải thích.
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function loadRotatorConfig(baseDir) {
  const file = path.join(baseDir, 'geo-config.json');
  try {
    const text = await fs.readFile(file, 'utf8');
    return normalizeConfig(JSON.parse(stripJsonComments(text)));
  } catch (e) {
    if (e.code === 'ENOENT') return normalizeConfig({});
    throw e;
  }
}

module.exports = { DEFAULTS, normalizeConfig, loadRotatorConfig, stripJsonComments };
