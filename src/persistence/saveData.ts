/**
 * Versioned local save: high score, best stage, audio and display preferences.
 *
 * Format: one JSON record under SAVE_KEY with a numeric `version`.
 * Loading never throws: missing data -> defaults; unparsable or wrong-shaped
 * data -> defaults with per-field salvage; older versions -> migrated; a newer
 * (unknown) version -> read what we can but never overwrite it, so a future
 * build's data is not destroyed by an older build.
 */
import type { KeyValueStore } from './storage.ts';

export const SAVE_KEY = 'galaxia:save';
export const SAVE_VERSION = 1;
const MAX_SCORE = 9_999_990;
/** Sanity cap only: the game itself has no last stage (progression is endless). Was 255 before Stage 7. */
const MAX_STAGE = 9999;

export interface AudioPrefs {
  readonly muted: boolean;
  /** 0..1 */
  readonly master: number;
  readonly sfx: number;
  readonly music: number;
}

export interface DisplayPrefs {
  readonly glow: boolean;
  readonly pixelPerfect: boolean;
  /** 'system' follows prefers-reduced-motion. */
  readonly reducedMotion: 'system' | 'on' | 'off';
  /**
   * Classic presentation (TD-73): false = Responsive Display (the default;
   * the shared viewport sizing, playfield as large as it fits), true = Arcade
   * Display (centred, framed fixed-aspect arcade screen). Display only: never
   * a gameplay rule. Missing in older records = false (no migration needed).
   */
  readonly arcadeDisplay: boolean;
}

export interface SaveDataV1 {
  readonly version: 1;
  readonly highScore: number;
  readonly bestStage: number;
  readonly audio: AudioPrefs;
  readonly display: DisplayPrefs;
}

export type SaveData = SaveDataV1;

/**
 * Read/write access to the audio + display preferences. SaveManager satisfies
 * it (standalone Classic, as before); the shared PreferencesStore
 * (`galaxia:prefs`, shared/persistence/preferences.ts) is what the mode host
 * passes in since Free Roam Prompt 2.
 */
export interface PreferencesSource {
  get(): { readonly audio: AudioPrefs; readonly display: DisplayPrefs };
  setAudio(prefs: Partial<AudioPrefs>): boolean;
  setDisplay(prefs: Partial<DisplayPrefs>): boolean;
}

/** Where an unparsable Classic record is copied before it is reset (same scheme as shared/persistence/namespaces.ts backupKey()). */
export const SAVE_BACKUP_KEY = `${SAVE_KEY}:backup`;

export const DEFAULT_SAVE: SaveData = Object.freeze({
  version: 1,
  highScore: 0,
  bestStage: 0,
  audio: Object.freeze({ muted: false, master: 0.8, sfx: 1, music: 0.7 }),
  display: Object.freeze({ glow: true, pixelPerfect: false, reducedMotion: 'system' as const, arcadeDisplay: false }),
});

export type LoadStatus = 'ok' | 'missing' | 'corrupt' | 'repaired' | 'migrated' | 'future-version';

export interface LoadResult {
  readonly data: SaveData;
  readonly status: LoadStatus;
  /** False when the stored record must not be overwritten (future version). */
  readonly writable: boolean;
}

/* ---------------------------- field sanitizers ---------------------------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

interface Sanitizer {
  repaired: boolean;
}

function int(s: Sanitizer, v: unknown, fallback: number, max: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = Math.floor(v);
    if (n >= 0 && n <= max) {
      if (n !== v) s.repaired = true;
      return n;
    }
  }
  if (v !== undefined) s.repaired = true;
  return fallback;
}

function unit(s: Sanitizer, v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) return v;
  if (v !== undefined) s.repaired = true;
  return fallback;
}

function bool(s: Sanitizer, v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v !== undefined) s.repaired = true;
  return fallback;
}

function oneOf<T extends string>(s: Sanitizer, v: unknown, options: readonly T[], fallback: T): T {
  if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T;
  if (v !== undefined) s.repaired = true;
  return fallback;
}

/** Coerce any value into a valid SaveDataV1, salvaging valid fields. */
export function sanitizeV1(raw: unknown): { data: SaveDataV1; repaired: boolean } {
  const s: Sanitizer = { repaired: !isObj(raw) };
  const o = isObj(raw) ? raw : {};
  if ((o.audio !== undefined && !isObj(o.audio)) || (o.display !== undefined && !isObj(o.display))) s.repaired = true;
  const a: Obj = isObj(o.audio) ? o.audio : {};
  const d: Obj = isObj(o.display) ? o.display : {};
  const D = DEFAULT_SAVE;
  return {
    data: {
      version: 1,
      highScore: int(s, o.highScore, D.highScore, MAX_SCORE),
      bestStage: int(s, o.bestStage, D.bestStage, MAX_STAGE),
      audio: {
        muted: bool(s, a.muted, D.audio.muted),
        master: unit(s, a.master, D.audio.master),
        sfx: unit(s, a.sfx, D.audio.sfx),
        music: unit(s, a.music, D.audio.music),
      },
      display: {
        glow: bool(s, d.glow, D.display.glow),
        pixelPerfect: bool(s, d.pixelPerfect, D.display.pixelPerfect),
        reducedMotion: oneOf(s, d.reducedMotion, ['system', 'on', 'off'] as const, D.display.reducedMotion),
        arcadeDisplay: bool(s, d.arcadeDisplay, D.display.arcadeDisplay),
      },
    },
    repaired: s.repaired,
  };
}

/**
 * Migrations from version N to N+1. Version 0 = any unversioned legacy
 * record of the shape { highScore?, hiScore?, muted? } (pre-release builds).
 */
const MIGRATIONS: Readonly<Record<number, (doc: Obj) => Obj>> = {
  0: (doc) => ({
    version: 1,
    highScore: doc.highScore ?? doc.hiScore,
    bestStage: doc.bestStage,
    audio: { muted: doc.muted },
    display: {},
  }),
};

export function parseSave(raw: string | null): LoadResult {
  if (raw === null || raw === '') return { data: DEFAULT_SAVE, status: 'missing', writable: true };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { data: DEFAULT_SAVE, status: 'corrupt', writable: true };
  }
  if (!isObj(doc)) return { data: DEFAULT_SAVE, status: 'corrupt', writable: true };

  let version = doc.version === undefined ? 0 : doc.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { data: sanitizeV1(doc).data, status: 'corrupt', writable: true };
  }
  if (version > SAVE_VERSION) {
    return { data: sanitizeV1(doc).data, status: 'future-version', writable: false };
  }
  let migrated = false;
  let current: Obj = doc;
  while (version < SAVE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return { data: DEFAULT_SAVE, status: 'corrupt', writable: true };
    current = step(current);
    version += 1;
    migrated = true;
  }
  const { data, repaired } = sanitizeV1(current);
  return { data, status: migrated ? 'migrated' : repaired ? 'repaired' : 'ok', writable: true };
}

/* ------------------------------- SaveManager ------------------------------ */

export interface GameResult {
  readonly score: number;
  readonly stage: number;
}

export class SaveManager {
  private readonly store: KeyValueStore;
  private data: SaveData;
  readonly loadStatus: LoadStatus;
  private writable: boolean;
  /** Result of the most recent write attempt (true if none yet). */
  lastWriteOk = true;
  /** True when a corrupt record was copied to SAVE_BACKUP_KEY at load. */
  backedUp = false;

  constructor(store: KeyValueStore) {
    this.store = store;
    const raw = store.read(SAVE_KEY);
    const result = parseSave(raw);
    this.data = result.data;
    this.loadStatus = result.status;
    this.writable = result.writable;
    // Keep a copy of damaged data before the reset below overwrites it (Free Roam Prompt 2).
    if (result.status === 'corrupt' && raw !== null && raw !== '') this.backedUp = store.write(SAVE_BACKUP_KEY, raw);
    // Persist repaired/migrated records immediately so the next load is clean.
    if (this.writable && (result.status === 'migrated' || result.status === 'repaired' || result.status === 'corrupt')) this.flush();
  }

  get persistent(): boolean {
    return this.store.persistent && this.writable;
  }

  get(): SaveData {
    return this.data;
  }

  setAudio(prefs: Partial<AudioPrefs>): boolean {
    this.data = sanitizeV1({ ...this.data, audio: { ...this.data.audio, ...prefs } }).data;
    return this.flush();
  }

  setDisplay(prefs: Partial<DisplayPrefs>): boolean {
    this.data = sanitizeV1({ ...this.data, display: { ...this.data.display, ...prefs } }).data;
    return this.flush();
  }

  /** Record a finished (or interrupted) game. Only improvements are written. */
  recordGameResult(result: GameResult): { newHighScore: boolean; newBestStage: boolean; saved: boolean } {
    const score = Number.isSafeInteger(result.score) && result.score >= 0 ? Math.min(result.score, MAX_SCORE) : 0;
    const stage = Number.isSafeInteger(result.stage) && result.stage >= 0 ? Math.min(result.stage, MAX_STAGE) : 0;
    const newHighScore = score > this.data.highScore;
    const newBestStage = stage > this.data.bestStage;
    if (!newHighScore && !newBestStage) return { newHighScore, newBestStage, saved: true };
    this.data = {
      ...this.data,
      highScore: newHighScore ? score : this.data.highScore,
      bestStage: newBestStage ? stage : this.data.bestStage,
    };
    return { newHighScore, newBestStage, saved: this.flush() };
  }

  /** Erase stored data (e.g. a "reset scores" option). */
  reset(): boolean {
    this.data = DEFAULT_SAVE;
    this.writable = true;
    return this.flush();
  }

  private flush(): boolean {
    if (!this.writable) {
      this.lastWriteOk = false;
      return false;
    }
    this.lastWriteOk = this.store.write(SAVE_KEY, JSON.stringify(this.data));
    return this.lastWriteOk;
  }
}
