/**
 * Storage adapters. Browser storage can be missing (old/locked-down browsers),
 * throw on access (sandboxed iframes, disabled cookies), or throw on write
 * (quota, Safari private mode). Every call here is wrapped; callers get a
 * boolean, never an exception.
 */
export interface KeyValueStore {
  /** True if data survives a page reload. */
  readonly persistent: boolean;
  read(key: string): string | null;
  /** Returns false if the write failed. */
  write(key: string, value: string): boolean;
  remove(key: string): boolean;
}

export class MemoryStore implements KeyValueStore {
  readonly persistent = false;
  private readonly data = new Map<string, string>();
  read(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  write(key: string, value: string): boolean {
    this.data.set(key, value);
    return true;
  }
  remove(key: string): boolean {
    this.data.delete(key);
    return true;
  }
}

/** Minimal shape of the Web Storage API so tests can pass fakes. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class WebStorageStore implements KeyValueStore {
  readonly persistent = true;
  private readonly storage: StorageLike;
  constructor(storage: StorageLike) {
    this.storage = storage;
  }
  read(key: string): string | null {
    try {
      const v = this.storage.getItem(key);
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  write(key: string, value: string): boolean {
    try {
      this.storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
  remove(key: string): boolean {
    try {
      this.storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }
}

const PROBE_KEY = 'galaxia:probe';

/**
 * Use `getStorage()` (default: globalThis.localStorage) if it works, else an
 * in-memory store. Probes with a real write/remove because some browsers expose
 * localStorage but throw on setItem.
 */
export function openStore(getStorage: () => StorageLike | undefined = defaultStorage): KeyValueStore {
  try {
    const storage = getStorage();
    if (!storage) return new MemoryStore();
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return new WebStorageStore(storage);
  } catch {
    return new MemoryStore();
  }
}

function defaultStorage(): StorageLike | undefined {
  // Property access itself can throw (SecurityError) in sandboxed contexts.
  return (globalThis as { localStorage?: StorageLike }).localStorage;
}
