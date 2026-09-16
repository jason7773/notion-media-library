export class TtlCache {
  constructor({ maxEntries = 100, maxBytes = Number.POSITIVE_INFINITY } = {}) {
    this.items = new Map();
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.totalBytes = 0;
  }

  delete(key) {
    const entry = this.items.get(key);
    if (!entry) {
      return;
    }
    this.totalBytes -= entry.size || 0;
    this.items.delete(key);
  }

  get(key) {
    const entry = this.items.get(key);
    if (!entry) {
      return undefined;
    }

    if (!entry.pending && entry.expiresAt <= Date.now()) {
      this.delete(key);
      return undefined;
    }

    this.items.delete(key);
    this.items.set(key, entry);
    return entry.pending || entry.value;
  }

  set(key, value, ttlMs, size = 0) {
    this.delete(key);
    this.items.set(key, {
      expiresAt: Date.now() + ttlMs,
      size,
      value,
    });
    this.totalBytes += size;
    this.prune();
    return value;
  }

  async getOrSet(key, ttlMs, loader, sizeOf = () => 0) {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = Promise.resolve()
      .then(loader)
      .then((value) => this.set(key, value, ttlMs, sizeOf(value)))
      .catch((error) => {
        const entry = this.items.get(key);
        if (entry?.pending === pending) {
          this.items.delete(key);
        }
        throw error;
      });

    this.items.set(key, {
      expiresAt: Date.now() + Math.min(ttlMs, 30_000),
      pending,
      size: 0,
    });
    return pending;
  }

  prune() {
    for (const [key, entry] of this.items) {
      if (!entry.pending && entry.expiresAt <= Date.now()) {
        this.delete(key);
      }
    }

    while (this.items.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.delete(oldestKey);
    }
  }
}
