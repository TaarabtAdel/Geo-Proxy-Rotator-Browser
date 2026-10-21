class ProxyLease {
  constructor() {
    this.owner = new Map();
  }

  isAvailable(proxyId, tabId) {
    const o = this.owner.get(proxyId);
    return o === undefined || o.tabId === tabId;
  }

  // status: 'checking' khi đang kiểm tra kết nối, 'using' khi đã kết nối và đang chạy bài.
  lease(proxyId, tabId, status = 'using') {
    if (!this.isAvailable(proxyId, tabId)) {
      const e = Error('Proxy đang bận ở tab khác.');
      e.code = 'PROXY_BUSY';
      throw e;
    }
    this.owner.set(proxyId, { tabId, status });
  }

  has(proxyId) {
    return this.owner.has(proxyId);
  }

  status(proxyId) {
    return this.owner.get(proxyId)?.status || null;
  }

  release(tabId) {
    for (const [id, o] of this.owner) if (o.tabId === tabId) this.owner.delete(id);
  }
}

module.exports = { ProxyLease };
