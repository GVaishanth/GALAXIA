/**
 * Free Roam save slots (Prompt 13, FR-TD-74). Browser-local only: every slot
 * lives in this browser's localStorage (or in memory when storage is
 * unavailable). Nothing is uploaded and nothing syncs across devices or
 * browsers.
 *
 *   slot 1  `galaxia:freeroam`        the original Free Roam key, unchanged, so
 *                                     existing progress simply is slot 1
 *   slot 2  `galaxia:freeroam:slot2`
 *   slot 3  `galaxia:freeroam:slot3`
 *   meta    `galaxia:freeroam:slots`  which slot is in use ({ active })
 *   prefs   `galaxia:freeroam:prefs`  Free Roam settings shared by every slot
 *                                     (flight controls)
 *
 * Every slot uses the same versioned record (profile.ts FREEROAM_SPEC with its
 * own key), so each slot migrates, repairs and backs up on its own: a damaged
 * or newer slot never affects another one. Shared, mode-independent settings
 * (audio, display) stay in `galaxia:prefs`; Classic keeps `galaxia:save`.
 *
 * Main bundle (the title screen card reads the active slot), so this module
 * checks shapes only and never imports the catalogue; the Free Roam chunk
 * checks ids against the game data (saveAudit.ts).
 */
import type { KeyValueStore } from '../../persistence/storage.ts';
import { FREEROAM_SLOT_KEYS, STORAGE_KEYS, versionKey } from '../../shared/persistence/namespaces.ts';
import { isObj, loadRecord, parseRecord, writeRecord, type RecordLoad, type RecordSpec, type RecordStatus } from '../../shared/persistence/record.ts';
import { DEFAULT_CONTROLS, FREEROAM_SPEC, sanitizeControls, type FlightControls, type FreeRoamProfile } from './profile.ts';

/** Seconds of active flight between timed autosaves (milestones also save on their own). */
export const AUTOSAVE_SECONDS = 60;

export const SLOT_NUMBERS = Object.freeze([1, 2, 3] as const);
export type SlotNo = (typeof SLOT_NUMBERS)[number];
export const isSlotNo = (n: unknown): n is SlotNo => n === 1 || n === 2 || n === 3;

export const slotKey = (n: SlotNo): string => FREEROAM_SLOT_KEYS[n - 1]!;

const SLOT_SPECS: readonly RecordSpec<FreeRoamProfile>[] = SLOT_NUMBERS.map((n) => (n === 1 ? FREEROAM_SPEC : Object.freeze({ ...FREEROAM_SPEC, key: slotKey(n) })));

/** The record spec of slot `n` (slot 1 is FREEROAM_SPEC itself). */
export const slotSpec = (n: SlotNo): RecordSpec<FreeRoamProfile> => SLOT_SPECS[n - 1]!;

/* ------------------------------------------------------------- slot meta */

export interface SlotMeta {
  readonly active: SlotNo;
}

export const SLOTS_SPEC: RecordSpec<SlotMeta> = Object.freeze({
  key: STORAGE_KEYS.freeroamSlots,
  version: 1,
  defaults: Object.freeze({ active: 1 as SlotNo }),
  sanitize(doc: Record<string, unknown>) {
    const ok = isSlotNo(doc['active']);
    return { data: { active: ok ? (doc['active'] as SlotNo) : 1 }, repaired: !ok };
  },
});

/** The slot Free Roam opens (slot 1 when nothing was chosen yet). Read-only. */
export function activeSlot(store: KeyValueStore): SlotNo {
  return parseRecord(store.read(SLOTS_SPEC.key), SLOTS_SPEC).data.active;
}

/** Choose the slot Free Roam opens next. False if it could not be stored. */
export function setActiveSlot(store: KeyValueStore, n: SlotNo): boolean {
  if (!parseRecord(store.read(SLOTS_SPEC.key), SLOTS_SPEC).writable) return false; // a newer build's meta stays
  return writeRecord(store, SLOTS_SPEC, { active: n });
}

/* ------------------------------------------------- shared Free Roam prefs */

export interface FreeRoamPrefs {
  readonly controls: FlightControls;
}

export const FR_PREFS_SPEC: RecordSpec<FreeRoamPrefs> = Object.freeze({
  key: STORAGE_KEYS.freeroamPrefs,
  version: 1,
  defaults: Object.freeze({ controls: DEFAULT_CONTROLS }),
  sanitize(doc: Record<string, unknown>) {
    const c = sanitizeControls(doc['controls']);
    return { data: { controls: c.controls }, repaired: c.repaired };
  },
});

export interface FreeRoamPrefsLoad extends RecordLoad<FreeRoamPrefs> {
  /** The controls were carried over from the single-profile record (v5-v9). */
  readonly seeded: boolean;
}

function legacyControls(raw: string | null): FlightControls | null {
  if (raw === null || raw === '') return null;
  try {
    const doc: unknown = JSON.parse(raw);
    if (!isObj(doc) || doc['controls'] === undefined) return null;
    return sanitizeControls(doc['controls']).controls;
  } catch {
    return null;
  }
}

/**
 * Load the Free Roam prefs. The first time (no prefs record yet) the controls a
 * pre-slot profile saved are carried over, from slot 1 or its kept v9 copy, so
 * moving them out of the slot loses nothing. Call before slot 1 is migrated.
 */
export function loadFreeRoamPrefs(store: KeyValueStore): FreeRoamPrefsLoad {
  const r = loadRecord(store, FR_PREFS_SPEC);
  if (r.status !== 'missing') return { ...r, seeded: false };
  const legacy = legacyControls(store.read(slotKey(1))) ?? legacyControls(store.read(versionKey(slotKey(1), 9)));
  if (!legacy) return { ...r, seeded: false };
  const data: FreeRoamPrefs = { controls: legacy };
  writeRecord(store, FR_PREFS_SPEC, data); // if this fails the controls still apply now; the original stays in slot 1 / its v9 copy
  return { ...r, data, status: 'migrated', seeded: true };
}

export function saveFreeRoamPrefs(store: KeyValueStore, prefs: FreeRoamPrefs): boolean {
  return writeRecord(store, FR_PREFS_SPEC, prefs);
}

/* ------------------------------------------------------------------ slots */

/** empty: no record · ready: loads normally · damaged: unreadable (loading starts it fresh,
 *  keeping a backup) · newer: from a newer build (loads read-only, never overwritten). */
export type SlotState = 'empty' | 'ready' | 'damaged' | 'newer';

/** What a slot card shows (ids only; the Free Roam chunk turns them into names). */
export interface SlotFacts {
  readonly sessions: number;
  readonly galaxy: string;
  /** '' = the galaxy's gateway. */
  readonly system: string;
  readonly ship: string;
  readonly ships: number;
  readonly marks: number;
  readonly galaxies: number;
  readonly systemsVisited: number;
  readonly charted: number;
  readonly missionsDone: number;
  readonly missionsActive: number;
  readonly flightSeconds: number;
  readonly savedAt: number;
  readonly createdAt: number;
}

export interface SlotInfo {
  readonly n: SlotNo;
  readonly key: string;
  readonly state: SlotState;
  readonly status: RecordStatus;
  /** null for empty and damaged slots. */
  readonly facts: SlotFacts | null;
}

export function slotFacts(p: FreeRoamProfile): SlotFacts {
  return {
    sessions: p.sessions,
    galaxy: p.currentGalaxy,
    system: p.currentSystem,
    ship: p.fleet.active,
    ships: p.fleet.owned.length,
    marks: p.progression.marks,
    galaxies: p.visitedGalaxies.length,
    systemsVisited: p.visitedSystems.length,
    charted: p.chartedSystems.length,
    missionsDone: p.progression.missions.completed.length,
    missionsActive: p.progression.missions.active.length,
    flightSeconds: p.flightSeconds,
    savedAt: p.savedAt,
    createdAt: p.createdAt,
  };
}

/** Peek at one slot: never writes, never backs up, never migrates in storage. */
export function readSlot(store: KeyValueStore, n: SlotNo): SlotInfo {
  const r = parseRecord(store.read(slotKey(n)), slotSpec(n));
  const state: SlotState = r.status === 'missing' ? 'empty' : r.status === 'corrupt' ? 'damaged' : r.status === 'future-version' ? 'newer' : 'ready';
  return { n, key: slotKey(n), state, status: r.status, facts: state === 'ready' || state === 'newer' ? slotFacts(r.data) : null };
}

export function readSlots(store: KeyValueStore): readonly SlotInfo[] {
  return SLOT_NUMBERS.map((n) => readSlot(store, n));
}

/** Load a slot for play (migrates / repairs with a backup copy; see record.ts). */
export function loadSlot(store: KeyValueStore, n: SlotNo): RecordLoad<FreeRoamProfile> {
  return loadRecord(store, slotSpec(n));
}

export function saveSlot(store: KeyValueStore, n: SlotNo, profile: FreeRoamProfile): boolean {
  return writeRecord(store, slotSpec(n), profile);
}

/**
 * Delete slot `n` (the caller has confirmed). Only that slot's record goes: the
 * other slots, the shared prefs, Classic's save and this slot's backup copies
 * (`:backup`, `:v<N>`) are untouched.
 */
export function deleteSlot(store: KeyValueStore, n: SlotNo): boolean {
  return store.remove(slotKey(n));
}

/** "1:05" (hours:minutes) or "12m" from whole seconds. */
export function formatPlayTime(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} H` : `${m} MIN`;
}

/** The title screen card line for the active slot. */
export function slotSummary(info: SlotInfo): string {
  const head = `SLOT ${info.n}`;
  if (info.state === 'empty') return `${head} · NEW PILOT`;
  if (info.state === 'damaged') return `${head} · UNREADABLE (BACKUP KEPT)`;
  const f = info.facts!;
  if (f.sessions === 0) return `${head} · NEW PILOT`;
  const newer = info.state === 'newer' ? ' · NEWER VERSION' : '';
  return `${head} · ${f.systemsVisited} ${f.systemsVisited === 1 ? 'SYSTEM' : 'SYSTEMS'} · ${f.marks.toLocaleString('en-US')} MARKS · ${formatPlayTime(f.flightSeconds)}${newer}`;
}
