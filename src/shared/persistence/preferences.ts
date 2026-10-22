/**
 * Shared preferences (audio + display) under their own namespace,
 * `galaxia:prefs`, used by every mode.
 *
 * Migration: before Free Roam Prompt 2 these preferences lived inside the
 * Classic record (`galaxia:save`). On first load, when `galaxia:prefs` does
 * not exist yet, they are copied from there once. The Classic record is only
 * read, never modified or deleted, so its high score / best stage are safe and
 * an older build still finds valid (if stale) preferences in it.
 */
import { DEFAULT_SAVE, parseSave, sanitizeV1, SAVE_KEY, type AudioPrefs, type DisplayPrefs, type PreferencesSource } from '../../persistence/saveData.ts';
import type { KeyValueStore } from '../../persistence/storage.ts';
import { STORAGE_KEYS } from './namespaces.ts';
import { loadRecord, writeRecord, type RecordSpec, type RecordStatus } from './record.ts';

export interface SharedPrefs {
  readonly audio: AudioPrefs;
  readonly display: DisplayPrefs;
}

export const PREFS_VERSION = 1;

export const PREFS_SPEC: RecordSpec<SharedPrefs> = Object.freeze({
  key: STORAGE_KEYS.prefs,
  version: PREFS_VERSION,
  defaults: Object.freeze({ audio: DEFAULT_SAVE.audio, display: DEFAULT_SAVE.display }),
  sanitize(doc: Record<string, unknown>) {
    // reuse the Classic field sanitizers so both namespaces accept exactly the same values
    const s = sanitizeV1({ audio: doc['audio'], display: doc['display'] });
    return { data: { audio: s.data.audio, display: s.data.display }, repaired: s.repaired };
  },
});

/** Where the current preferences came from at load time. */
export type PrefsSource = 'prefs' | 'migrated-from-classic' | 'defaults';

export class PreferencesStore implements PreferencesSource {
  private readonly store: KeyValueStore;
  private data: SharedPrefs;
  private writable: boolean;
  readonly loadStatus: RecordStatus;
  readonly source: PrefsSource;
  readonly backedUp: boolean;
  /** The record needed a backup copy that could not be written: it is left as it is (not writable). */
  readonly backupFailed: boolean;
  lastWriteOk = true;
  /** Incremented on every change (cheap "did prefs change?" checks for renderers). */
  revision = 0;

  constructor(store: KeyValueStore) {
    this.store = store;
    const r = loadRecord(store, PREFS_SPEC);
    this.writable = r.writable;
    this.backedUp = r.backedUp;
    this.backupFailed = r.backupFailed;
    if (r.status === 'missing') {
      const legacy = parseSave(store.read(SAVE_KEY));
      if (legacy.status !== 'missing' && legacy.status !== 'corrupt') {
        this.data = { audio: legacy.data.audio, display: legacy.data.display };
        this.source = 'migrated-from-classic';
        this.loadStatus = 'migrated';
      } else {
        this.data = PREFS_SPEC.defaults;
        this.source = 'defaults';
        this.loadStatus = 'missing';
      }
      if (this.source === 'migrated-from-classic') this.flush();
    } else {
      this.data = r.data;
      this.source = 'prefs';
      this.loadStatus = r.status;
      if (r.status === 'repaired' || r.status === 'corrupt' || r.status === 'migrated') this.flush();
    }
  }

  get persistent(): boolean {
    return this.store.persistent && this.writable;
  }

  get(): SharedPrefs {
    return this.data;
  }

  setAudio(prefs: Partial<AudioPrefs>): boolean {
    return this.update({ audio: { ...this.data.audio, ...prefs }, display: this.data.display });
  }

  setDisplay(prefs: Partial<DisplayPrefs>): boolean {
    return this.update({ audio: this.data.audio, display: { ...this.data.display, ...prefs } });
  }

  private update(next: SharedPrefs): boolean {
    this.data = PREFS_SPEC.sanitize(next as unknown as Record<string, unknown>).data;
    this.revision += 1;
    return this.flush();
  }

  private flush(): boolean {
    if (!this.writable) {
      this.lastWriteOk = false;
      return false;
    }
    this.lastWriteOk = writeRecord(this.store, PREFS_SPEC, this.data);
    return this.lastWriteOk;
  }
}
