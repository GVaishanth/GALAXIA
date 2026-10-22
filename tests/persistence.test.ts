import { describe, expect, it } from 'vitest';
import { DEFAULT_SAVE, SAVE_KEY, SAVE_VERSION, SaveManager, parseSave } from '../src/persistence/saveData.ts';
import { MemoryStore, WebStorageStore, openStore, type StorageLike } from '../src/persistence/storage.ts';

class FakeStorage implements StorageLike {
  data = new Map<string, string>();
  failGet = false;
  failSet = false;
  getItem(k: string): string | null {
    if (this.failGet) throw new Error('SecurityError');
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failSet) throw new Error('QuotaExceededError');
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

describe('parseSave', () => {
  it('missing -> defaults', () => {
    expect(parseSave(null)).toEqual({ data: DEFAULT_SAVE, status: 'missing', writable: true });
    expect(parseSave('').status).toBe('missing');
  });

  it.each(['{not json', '[]', '42', 'null', '"text"'])('corrupt %s -> defaults, no throw', (raw) => {
    const r = parseSave(raw);
    expect(r.status).toBe('corrupt');
    expect(r.data).toEqual(DEFAULT_SAVE);
  });

  it('round-trips a valid v1 document', () => {
    const doc = { ...DEFAULT_SAVE, highScore: 123450, bestStage: 12, display: { glow: false, pixelPerfect: true, reducedMotion: 'on', arcadeDisplay: true } };
    expect(parseSave(JSON.stringify(doc))).toEqual({ data: doc, status: 'ok', writable: true });
  });

  it('salvages valid fields and repairs bad ones', () => {
    const r = parseSave(JSON.stringify({ version: 1, highScore: 5000, bestStage: 'seven', audio: { master: 7, muted: true }, display: 'x' }));
    expect(r.status).toBe('repaired');
    expect(r.data.highScore).toBe(5000);
    expect(r.data.bestStage).toBe(0);
    expect(r.data.audio).toEqual({ ...DEFAULT_SAVE.audio, muted: true });
    expect(r.data.display).toEqual(DEFAULT_SAVE.display);
  });

  it.each([-1, Number.MAX_SAFE_INTEGER, 1e300])('rejects out-of-range high score %s', (hs) => {
    expect(parseSave(JSON.stringify({ version: 1, highScore: hs })).data.highScore).toBe(0);
  });

  it('migrates an unversioned legacy document', () => {
    const r = parseSave(JSON.stringify({ hiScore: 30000, muted: true }));
    expect(r.status).toBe('migrated');
    expect(r.data).toMatchObject({ version: SAVE_VERSION, highScore: 30000, audio: { muted: true } });
  });

  it('a newer version is read but marked read-only', () => {
    const r = parseSave(JSON.stringify({ version: 99, highScore: 777, newField: true }));
    expect(r).toMatchObject({ status: 'future-version', writable: false });
    expect(r.data.highScore).toBe(777);
  });

  it('a bogus version is treated as corrupt', () => {
    expect(parseSave(JSON.stringify({ version: 'one', highScore: 10 })).status).toBe('corrupt');
  });
});

describe('storage adapters', () => {
  it('openStore falls back to memory when storage is missing or throws', () => {
    expect(openStore(() => undefined).persistent).toBe(false);
    expect(
      openStore(() => {
        throw new Error('SecurityError');
      }).persistent,
    ).toBe(false);
    const failing = new FakeStorage();
    failing.failSet = true;
    expect(openStore(() => failing).persistent).toBe(false);
    expect(openStore(() => new FakeStorage()).persistent).toBe(true);
  });

  it('openStore cleans up its probe key', () => {
    const s = new FakeStorage();
    openStore(() => s);
    expect(s.data.size).toBe(0);
  });

  it('WebStorageStore never throws', () => {
    const s = new FakeStorage();
    const store = new WebStorageStore(s);
    s.failGet = true;
    s.failSet = true;
    expect(store.read('k')).toBeNull();
    expect(store.write('k', 'v')).toBe(false);
  });
});

describe('SaveManager', () => {
  it('records only improvements and persists them', () => {
    const store = new MemoryStore();
    const save = new SaveManager(store);
    expect(save.recordGameResult({ score: 12000, stage: 4 })).toEqual({ newHighScore: true, newBestStage: true, saved: true });
    expect(save.recordGameResult({ score: 9000, stage: 6 })).toEqual({ newHighScore: false, newBestStage: true, saved: true });
    expect(JSON.parse(store.read(SAVE_KEY)!)).toMatchObject({ version: 1, highScore: 12000, bestStage: 6 });
    expect(new SaveManager(store).get()).toMatchObject({ highScore: 12000, bestStage: 6 });
  });

  it('ignores invalid game results', () => {
    const save = new SaveManager(new MemoryStore());
    expect(save.recordGameResult({ score: Number.NaN, stage: -2 }).newHighScore).toBe(false);
    expect(save.get().highScore).toBe(0);
  });

  it('clamps preferences to valid ranges', () => {
    const save = new SaveManager(new MemoryStore());
    save.setAudio({ master: 3, sfx: -1, muted: true });
    expect(save.get().audio).toEqual({ ...DEFAULT_SAVE.audio, muted: true });
    save.setDisplay({ glow: false, reducedMotion: 'sometimes' as never });
    expect(save.get().display).toEqual({ ...DEFAULT_SAVE.display, glow: false });
  });

  it('keeps working in memory when writes fail (quota / private mode)', () => {
    const s = new FakeStorage();
    const store = new WebStorageStore(s);
    const save = new SaveManager(store);
    s.failSet = true;
    expect(save.recordGameResult({ score: 500, stage: 1 })).toMatchObject({ newHighScore: true, saved: false });
    expect(save.get().highScore).toBe(500);
    expect(save.lastWriteOk).toBe(false);
  });

  it('survives storage that throws on read', () => {
    const s = new FakeStorage();
    s.failGet = true;
    const save = new SaveManager(new WebStorageStore(s));
    expect(save.loadStatus).toBe('missing');
    expect(save.get()).toEqual(DEFAULT_SAVE);
  });

  it('rewrites a corrupt document with clean defaults', () => {
    const store = new MemoryStore();
    store.write(SAVE_KEY, '{garbage');
    const save = new SaveManager(store);
    expect(save.loadStatus).toBe('corrupt');
    expect(parseSave(store.read(SAVE_KEY)).status).toBe('ok');
  });

  it('never overwrites a newer-version document', () => {
    const store = new MemoryStore();
    const future = JSON.stringify({ version: 2, highScore: 900 });
    store.write(SAVE_KEY, future);
    const save = new SaveManager(store);
    expect(save.persistent).toBe(false);
    save.recordGameResult({ score: 5000, stage: 3 });
    save.setDisplay({ glow: false });
    expect(store.read(SAVE_KEY)).toBe(future);
    expect(save.get().highScore).toBe(5000); // still usable for this session
  });
});
