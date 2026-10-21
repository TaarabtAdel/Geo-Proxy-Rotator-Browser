class ProxyLease {
  constructor() {
    this.owner = new Map();
  }

  isAvailable(proxyId, tabId) {
    const o = this.owner.get(proxyId);
    return o === undefined || o === tabId;
  }

  lease(proxyId, tabId) {
    if (!this.isAvailable(proxyId, tabId)) {
      const e = Error('Proxy đang bận ở tab khác.');
      e.code = 'PROXY_BUSY';
      throw e;
    }
    this.owner.set(proxyId, tabId);
  }

  has(proxyId) {
    return this.owner.has(proxyId);
  }

  release(tabId) {
    for (const [id, owner] of this.owner) if (owner === tabId) this.owner.delete(id);
  }
}

module.exports = { ProxyLease };
