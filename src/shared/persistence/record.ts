/**
 * Versioned JSON records in a KeyValueStore, with the same guarantees as the
 * Classic save (persistence/saveData.ts): loading never throws, damaged data
 * falls back to defaults with per-field salvage, older versions migrate, and a
 * record from a newer build is read but never overwritten.
 *
 * No recoverable older data is overwritten without a copy (FR-TD-74):
 *  - corrupt / repaired: the raw text is copied to `<key>:backup` first;
 *  - migrated: the raw text is copied once to `<key>:v<old version>` (an
 *    existing copy of that version is never replaced);
 *  - if that copy cannot be written (storage full or blocked), the load is
 *    marked not writable, so the caller never overwrites the original.
 */
import type { KeyValueStore } from '../../persistence/storage.ts';
import { backupKey, versionKey } from './namespaces.ts';

export type RecordStatus = 'ok' | 'missing' | 'corrupt' | 'repaired' | 'migrated' | 'future-version';

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface RecordSpec<T> {
  readonly key: string;
  readonly version: number;
  readonly defaults: T;
  /** Coerce a parsed record object (any shape) into T; report whether anything had to be fixed. */
  sanitize(doc: Obj): { data: T; repaired: boolean };
  /** migrations[n] turns a version-n record object into version n+1. */
  readonly migrations?: Readonly<Record<number, (doc: Obj) => Obj>>;
}

export interface RecordLoad<T> {
  readonly data: T;
  readonly status: RecordStatus;
  /** False for a future-version record: it must not be overwritten. */
  readonly writable: boolean;
  /** True when the unparsable raw text was copied to `<key>:backup`. */
  readonly backedUp: boolean;
  /** Keys the raw text was copied to by this load (`<key>:backup`, `<key>:v<N>`). */
  readonly backups: readonly string[];
  /** A needed backup copy could not be written: the record is left untouched (writable is false). */
  readonly backupFailed: boolean;
}

export function parseRecord<T>(raw: string | null, spec: RecordSpec<T>): Omit<RecordLoad<T>, 'backedUp' | 'backups' | 'backupFailed'> {
  if (raw === null || raw === '') return { data: spec.defaults, status: 'missing', writable: true };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { data: spec.defaults, status: 'corrupt', writable: true };
  }
  if (!isObj(doc)) return { data: spec.defaults, status: 'corrupt', writable: true };
  let version = doc['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { data: spec.sanitize(doc).data, status: 'corrupt', writable: true };
  }
  if (version > spec.version) return { data: spec.sanitize(doc).data, status: 'future-version', writable: false };
  let current: Obj = doc;
  let migrated = false;
  while (version < spec.version) {
    const step = spec.migrations?.[version];
    if (!step) return { data: spec.defaults, status: 'corrupt', writable: true };
    current = step(current);
    version += 1;
    migrated = true;
  }
  const { data, repaired } = spec.sanitize(current);
  return { data, status: migrated ? 'migrated' : repaired ? 'repaired' : 'ok', writable: true };
}

/** The integer `version` of a raw record, or null. */
export function rawVersion(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  try {
    const doc: unknown = JSON.parse(raw);
    const v = isObj(doc) ? doc['version'] : undefined;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

export function loadRecord<T>(store: KeyValueStore, spec: RecordSpec<T>): RecordLoad<T> {
  const raw = store.read(spec.key);
  const result = parseRecord(raw, spec);
  const backups: string[] = [];
  let backedUp = false;
  let backupFailed = false;
  if (raw !== null && raw !== '' && result.writable) {
    if (result.status === 'corrupt' || result.status === 'repaired') {
      const key = backupKey(spec.key);
      // an identical copy already kept counts as written
      if (store.read(key) === raw || store.write(key, raw)) {
        backups.push(key);
        backedUp = result.status === 'corrupt';
      } else backupFailed = true;
    } else if (result.status === 'migrated') {
      const key = versionKey(spec.key, rawVersion(raw) ?? 0);
      if (store.read(key) !== null || store.write(key, raw)) backups.push(key);
      else backupFailed = true;
    }
  }
  // without a copy the original must stay as it is: the game runs on the loaded data, unsaved
  return { ...result, writable: result.writable && !backupFailed, backedUp, backups, backupFailed };
}

export function writeRecord<T extends object>(store: KeyValueStore, spec: RecordSpec<T>, data: T): boolean {
  return store.write(spec.key, JSON.stringify({ ...data, version: spec.version }));
}

/* small sanitizer helpers shared by record specs */
export interface Fix {
  repaired: boolean;
}
export function intField(f: Fix, v: unknown, fallback: number, max: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = Math.floor(v);
    if (n >= 0 && n <= max) {
      if (n !== v) f.repaired = true;
      return n;
    }
  }
  if (v !== undefined) f.repaired = true;
  return fallback;
}
