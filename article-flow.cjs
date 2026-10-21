const { net } = require('electron');

const CHECK_HOST = 'ipwho.is';

function hostKey(hostname) {
  return String(hostname || '').replace(/^www\./i, '').toLowerCase();
}

function articlePathKey(raw) {
  try {
    const url = new URL(raw);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    return hostKey(url.hostname) + p;
  } catch {
    return '';
  }
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isArticlePageUrl(url) {
  if (!url || url === 'about:blank' || url.startsWith('chrome-error://')) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return hostKey(parsed.hostname) !== hostKey(CHECK_HOST);
  } catch {
    return false;
  }
}

function isFatalProxyError(error) {
  const text = String(error || '');
  return /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CERTIFICATE_INVALID|ERR_PROXY_AUTH_UNSUPPORTED|ERR_PROXY_AUTH_REQUESTED|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED|407/i.test(text);
}

function articleSkipReason(status, error) {
  const text = String(error || '');
  if (/ERR_CERT_AUTHORITY_INVALID/i.test(text)) return 'ERR_CERT_AUTHORITY_INVALID';
  if (Number(status) === 403) return 'HTTP 403';
  return '';
}

function articleOutcome(nav, reason) {
  const err = String(nav?.error || '');
  const status = Number(nav?.status) || 0;
  if ((err && err !== 'net::ERR_ABORTED') || status >= 400) {
    const note = err && err !== 'chrome-error' ? err : (`HTTP ${status}`);
    return { ok: false, note: note.slice(0, 160) };
  }
  if (nav?.phase === 'loading_article') {
    return { ok: false, note: String(reason || 'Chưa tải xong').slice(0, 160) };
  }
  return { ok: true };
}

function articleFailedToLoad(nav, tabUrl) {
  const url = String(tabUrl || '');
  const err = String(nav?.error || '');
  const status = Number(nav?.status) || 0;
  if (status === 407 || isFatalProxyError(err)) return false;
  if (url.startsWith('chrome-error://')) return true;
  if (err && err !== 'net::ERR_ABORTED' && err !== 'chrome-error') return true;
  if (status >= 400) return true;
  if (!isArticlePageUrl(url)) return true;
  return false;
}

function shouldFailProxy(nav) {
  const status = Number(nav?.status) || 0;
  const err = String(nav?.error || '');
  return status === 407 || isFatalProxyError(err);
}

class ProxyFailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyFailError';
  }
}

// Electron chỉ cho 1 listener mỗi sự kiện webRequest trên một session,
// nên gắn một bộ phân phối duy nhất rồi thêm/bớt handler trong Set.
const hooks = new WeakMap();

function sessionHooks(session) {
  let h = hooks.get(session);
  if (h) return h;
  h = { completed: new Set(), error: new Set() };
  hooks.set(session, h);
  session.webRequest.onCompleted((details) => {
    for (const fn of [...h.completed]) { try { fn(details); } catch { /* ignore */ } }
  });
  session.webRequest.onErrorOccurred((details) => {
    for (const fn of [...h.error]) { try { fn(details); } catch { /* ignore */ } }
  });
  return h;
}

function listen(session, onComplete, onError) {
  const h = sessionHooks(session);
  h.completed.add(onComplete);
  h.error.add(onError);
  return () => {
    h.completed.delete(onComplete);
    h.error.delete(onError);
  };
}

function createArticleNav() {
  return {
    id: 0,
    expectedUrl: '',
    startedAt: 0,
    status: 0,
    error: '',
    phase: 'idle',
    cleanup: null,
  };
}

function beginArticleNav(tab, url) {
  const nav = tab.articleNav || (tab.articleNav = createArticleNav());
  if (nav.cleanup) {
    try { nav.cleanup(); } catch { /* ignore */ }
    nav.cleanup = null;
  }
  nav.id += 1;
  const navId = nav.id;
  nav.expectedUrl = url;
  nav.startedAt = Date.now();
  nav.status = 0;
  nav.error = '';
  nav.phase = 'loading_article';

  const wc = tab.view.webContents;
  const session = tab.session;
  if (wc.isDestroyed()) return nav;

  const wcId = wc.id;
  const onFail = (_e, _code, desc, _url, isMainFrame) => {
    if (!isMainFrame || nav.id !== navId) return;
    nav.error = String(desc || 'Load failed');
  };
  wc.on('did-fail-load', onFail);

  const onComplete = (details) => {
    if (details.webContentsId !== wcId) return;
    if (details.resourceType !== 'mainFrame') return;
    if (nav.id !== navId) return;
    const code = Number(details.statusCode) || 0;
    if (code >= 300 && code < 400) return;
    nav.status = code;
    nav.error = '';
  };
  const onError = (details) => {
    if (details.webContentsId !== wcId) return;
    if (details.resourceType !== 'mainFrame') return;
    if (nav.id !== navId) return;
    nav.error = String(details.error || nav.error || '');
    if (details.statusCode) nav.status = Number(details.statusCode) || nav.status;
  };
  const unlisten = listen(session, onComplete, onError);

  nav.cleanup = () => {
    wc.removeListener('did-fail-load', onFail);
    unlisten();
  };
  return nav;
}

function endArticleNav(nav, phase) {
  if (!nav) return;
  nav.phase = phase || 'idle';
  if (nav.cleanup) {
    try { nav.cleanup(); } catch { /* ignore */ }
    nav.cleanup = null;
  }
}

function probeArticleStatus(session, url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!isHttpUrl(url)) { resolve(null); return; }
    let origin;
    try { origin = new URL(url).origin; } catch { resolve(null); return; }
    let settled = false;
    let timer;
    let unlisten = () => {};
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten();
      resolve(v);
    };
    const match = (details) => {
      try { return new URL(details.url).origin === origin; } catch { return false; }
    };
    const onComplete = (details) => {
      if (!match(details)) return;
      const code = Number(details.statusCode) || 0;
      if (code >= 300 && code < 400) return;
      finish({ status: code, error: '' });
    };
    const onError = (details) => {
      if (!match(details)) return;
      finish({ status: Number(details.statusCode) || 0, error: String(details.error || '') });
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      unlisten = listen(session, onComplete, onError);
      const req = net.request({ url, session, method: 'HEAD', redirect: 'follow' });
      req.on('response', (res) => {
        finish({ status: res.statusCode || 0, error: '' });
        res.on('data', () => {});
        res.on('error', () => {});
      });
      req.on('error', (e) => finish({ status: 0, error: e.message || String(e) }));
      req.end();
    } catch (e) {
      finish(null);
    }
  });
}

async function scheduleProbe(tab, nav, navId) {
  await new Promise((r) => setTimeout(r, 800));
  if (!nav || nav.id !== navId || nav.status || nav.error) return;
  if (!isHttpUrl(nav.expectedUrl)) return;
  const result = await probeArticleStatus(tab.session, nav.expectedUrl);
  if (!result || nav.id !== navId) return;
  if (!nav.status && result.status) nav.status = result.status;
  if (!nav.error && result.error) nav.error = result.error;
}

module.exports = {
  CHECK_HOST,
  ProxyFailError,
  articlePathKey,
  articleSkipReason,
  articleOutcome,
  articleFailedToLoad,
  shouldFailProxy,
  isArticlePageUrl,
  beginArticleNav,
  endArticleNav,
  scheduleProbe,
};
