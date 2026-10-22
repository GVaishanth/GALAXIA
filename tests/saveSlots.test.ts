/**
 * Free Roam Prompt 13: save slots, backups, migration, validation and storage
 * failures (FR-TD-74). Pure / in-memory: no browser.
 */
import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { EMPTY_PROFILE, EMPTY_PROGRESSION, FREEROAM_VERSION, startSession, type FreeRoamProfile } from '../src/modes/freeroam/profile.ts';
import { auditProfile, auditText } from '../src/modes/freeroam/saveAudit.ts';
import {
  activeSlot,
  AUTOSAVE_SECONDS,
  deleteSlot,
  FR_PREFS_SPEC,
  loadFreeRoamPrefs,
  loadSlot,
  readSlot,
  readSlots,
  saveSlot,
  setActiveSlot,
  slotKey,
  slotSpec,
  slotSummary,
  SLOTS_SPEC,
} from '../src/modes/freeroam/saveSlots.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { solidsOf } from '../src/modes/freeroam/sector/grid.ts';
import { safeResumePoint } from '../src/modes/freeroam/sector/resume.ts';
import { createSectorRun } from '../src/modes/freeroam/sector/run.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { slotCard, storageLines } from '../src/modes/freeroam/ui/savesPanel.ts';
import { parseSave, SAVE_KEY, SaveManager } from '../src/persistence/saveData.ts';
import { MemoryStore, openStore, type KeyValueStore } from '../src/persistence/storage.ts';
import { backupKey, FREEROAM_SLOT_KEYS, STORAGE_KEYS, versionKey } from '../src/shared/persistence/namespaces.ts';
import { loadRecord } from '../src/shared/persistence/record.ts';

const graph = buildNavGraph();
const SOL = 'milky-way/sol';

/** A store whose writes fail for keys matching `fail` (quota / blocked storage). */
class FlakyStore implements KeyValueStore {
  readonly persistent = true;
  readonly data = new Map<string, string>();
  writes: string[] = [];
  fail: (key: string) => boolean;
  constructor(fail: (key: string) => boolean = () => false) {
    this.fail = fail;
  }
  read(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  write(k: string, v: string): boolean {
    if (this.fail(k)) return false;
    this.writes.push(k);
    this.data.set(k, v);
    return true;
  }
  remove(k: string): boolean {
    if (this.fail(k)) return false;
    this.data.delete(k);
    return true;
  }
}

const pilot = (over: Partial<FreeRoamProfile> = {}): FreeRoamProfile => ({
  ...startSession(EMPTY_PROFILE, 1000),
  currentSystem: SOL,
  visitedSystems: [SOL],
  cargo: { scrap: 12 },
  progression: { ...EMPTY_PROGRESSION, marks: 250 },
  ...over,
});
const v9 = (over: Record<string, unknown> = {}): string => {
  const { savedAt: _s, resume: _r, ...rest } = pilot();
  return JSON.stringify({ ...rest, version: 9, controls: { bindings: {}, mouseAim: true, zoom: 1.3 }, ...over });
};

/* ------------------------------------------------------------------ keys */
describe('slot keys and namespaces', () => {
  it('slot 1 is the original Free Roam key; slots 2 / 3, meta and prefs have their own keys', () => {
    expect(slotKey(1)).toBe('galaxia:freeroam');
    expect(slotKey(2)).toBe('galaxia:freeroam:slot2');
    expect(slotKey(3)).toBe('galaxia:freeroam:slot3');
    expect(slotSpec(1)).toBe(slotSpec(1));
    expect(slotSpec(2).key).toBe('galaxia:freeroam:slot2');
    expect(SLOTS_SPEC.key).toBe('galaxia:freeroam:slots');
    expect(FR_PREFS_SPEC.key).toBe('galaxia:freeroam:prefs');
    const all = [...FREEROAM_SLOT_KEYS, STORAGE_KEYS.classic, STORAGE_KEYS.prefs, STORAGE_KEYS.freeroamSlots, STORAGE_KEYS.freeroamPrefs];
    const derived = FREEROAM_SLOT_KEYS.flatMap((k) => [backupKey(k), versionKey(k, 9)]);
    expect(new Set([...all, ...derived]).size).toBe(all.length + derived.length);
    expect(STORAGE_KEYS.classic).toBe('galaxia:save'); // Classic key unchanged
  });

  it('the timed autosave interval is bounded (no per-frame saving)', () => {
    expect(AUTOSAVE_SECONDS).toBeGreaterThanOrEqual(30);
    expect(AUTOSAVE_SECONDS).toBeLessThanOrEqual(120);
  });
});

/* -------------------------------------------------------------- backups */
describe('record backups: no recoverable data is overwritten without a copy', () => {
  it('migration keeps the old raw record at <key>:v<N>, once; a later different copy never replaces it', () => {
    const store = new FlakyStore();
    store.data.set(slotKey(1), v9({ sessions: 4 }));
    const r = loadSlot(store, 1);
    expect(r.status).toBe('migrated');
    expect(r.writable).toBe(true);
    expect(r.backups).toEqual(['galaxia:freeroam:v9']);
    expect(store.read('galaxia:freeroam:v9')).toBe(v9({ sessions: 4 }));
    store.data.set(slotKey(1), v9({ sessions: 99 }));
    loadSlot(store, 1);
    expect(JSON.parse(store.read('galaxia:freeroam:v9')!).sessions).toBe(4); // the first copy stays
  });

  it('a repaired record is copied to <key>:backup before anything rewrites it', () => {
    const store = new FlakyStore();
    const raw = JSON.stringify({ ...pilot(), version: FREEROAM_VERSION, flightSeconds: -9 });
    store.data.set(slotKey(2), raw);
    const r = loadSlot(store, 2);
    expect(r.status).toBe('repaired');
    expect(r.backups).toEqual(['galaxia:freeroam:slot2:backup']);
    expect(store.read('galaxia:freeroam:slot2:backup')).toBe(raw);
    expect(r.data.flightSeconds).toBe(0); // invalid statistic clamped
  });

  it('corrupt JSON: defaults, raw text backed up; if the backup cannot be written the record is left untouched', () => {
    const ok = new FlakyStore();
    ok.data.set(slotKey(1), '{oops');
    const a = loadSlot(ok, 1);
    expect(a.status).toBe('corrupt');
    expect(a.backedUp).toBe(true);
    expect(ok.read('galaxia:freeroam:backup')).toBe('{oops');
    const full = new FlakyStore((k) => k.endsWith(':backup'));
    full.data.set(slotKey(1), '{oops');
    const b = loadSlot(full, 1);
    expect(b.backupFailed).toBe(true);
    expect(b.writable).toBe(false); // the mode never overwrites it
    expect(full.read(slotKey(1))).toBe('{oops');
  });

  it('a failed pre-migration copy also blocks writing; a newer-version record is never writable', () => {
    const full = new FlakyStore((k) => k.includes(':v'));
    full.data.set(slotKey(1), v9());
    const r = loadSlot(full, 1);
    expect(r.status).toBe('migrated');
    expect(r.backupFailed).toBe(true);
    expect(r.writable).toBe(false);
    const store = new FlakyStore();
    store.data.set(slotKey(3), JSON.stringify({ version: FREEROAM_VERSION + 1, sessions: 3 }));
    const f = loadSlot(store, 3);
    expect(f.status).toBe('future-version');
    expect(f.writable).toBe(false);
    expect(f.data.sessions).toBe(3);
    expect(store.writes).toEqual([]);
  });

  it('an unknown older version without a migration path resets with a backup (corrupt)', () => {
    const store = new FlakyStore();
    store.data.set(slotKey(1), JSON.stringify({ version: 0, sessions: 2 }));
    const r = loadSlot(store, 1);
    expect(r.status).toBe('corrupt');
    expect(store.read(backupKey(slotKey(1)))).toContain('"version":0');
  });

  it('missing data: an absent slot is empty, an absent field gets its default (not a repair)', () => {
    const store = new FlakyStore();
    expect(loadSlot(store, 2).status).toBe('missing');
    store.data.set(slotKey(2), JSON.stringify({ version: FREEROAM_VERSION, sessions: 2 }));
    const r = loadSlot(store, 2);
    expect(r.status).toBe('ok');
    expect(r.data).toMatchObject({ sessions: 2, cargo: {}, resume: null, savedAt: 0 });
  });
});

/* ---------------------------------------------------------------- slots */
describe('three independent slots', () => {
  it('saving one slot never changes another; each reads back its own progress', () => {
    const store = new MemoryStore();
    saveSlot(store, 1, pilot({ cargo: { scrap: 1 } }));
    saveSlot(store, 2, pilot({ cargo: { scrap: 2 } }));
    const one = store.read(slotKey(1));
    saveSlot(store, 3, pilot({ cargo: { scrap: 3 } }));
    saveSlot(store, 2, pilot({ cargo: { scrap: 22 } }));
    expect(store.read(slotKey(1))).toBe(one);
    expect([1, 2, 3].map((n) => loadSlot(store, n as 1 | 2 | 3).data.cargo['scrap'])).toEqual([1, 22, 3]);
  });

  it('a damaged slot affects no other slot', () => {
    const store = new MemoryStore();
    saveSlot(store, 1, pilot());
    store.write(slotKey(2), 'garbage');
    saveSlot(store, 3, pilot({ progression: { ...EMPTY_PROGRESSION, marks: 9 } }));
    expect(readSlots(store).map((s) => s.state)).toEqual(['ready', 'damaged', 'ready']);
    expect(loadSlot(store, 3).data.progression.marks).toBe(9);
  });

  it('readSlot is a read-only peek (no writes, no backups, no migration in storage)', () => {
    const store = new FlakyStore();
    store.data.set(slotKey(1), v9());
    store.data.set(slotKey(2), 'garbage');
    store.data.set(slotKey(3), JSON.stringify({ version: 99, sessions: 1 }));
    expect(readSlots(store).map((s) => s.state)).toEqual(['ready', 'damaged', 'newer']);
    expect(store.writes).toEqual([]);
    expect(readSlot(store, 1).facts).toMatchObject({ marks: 250, systemsVisited: 1, ship: 'petrel' });
  });

  it('the active slot defaults to 1; invalid meta falls back to 1; a newer meta is never overwritten', () => {
    const store = new MemoryStore();
    expect(activeSlot(store)).toBe(1);
    expect(setActiveSlot(store, 3)).toBe(true);
    expect(activeSlot(store)).toBe(3);
    store.write(SLOTS_SPEC.key, JSON.stringify({ version: 1, active: 7 }));
    expect(activeSlot(store)).toBe(1);
    store.write(SLOTS_SPEC.key, JSON.stringify({ version: 2, active: 2 }));
    expect(setActiveSlot(store, 1)).toBe(false);
    expect(activeSlot(store)).toBe(2);
  });

  it('delete removes only that slot record (other slots, prefs, Classic and backups stay)', () => {
    const store = new MemoryStore();
    saveSlot(store, 1, pilot());
    saveSlot(store, 2, pilot());
    store.write(backupKey(slotKey(2)), 'old');
    store.write(STORAGE_KEYS.freeroamPrefs, '{"version":1}');
    store.write(SAVE_KEY, '{"version":1,"highScore":5}');
    expect(deleteSlot(store, 2)).toBe(true);
    expect(store.read(slotKey(2))).toBeNull();
    expect(store.read(slotKey(1))).not.toBeNull();
    expect(store.read(backupKey(slotKey(2)))).toBe('old');
    expect(store.read(STORAGE_KEYS.freeroamPrefs)).toBe('{"version":1}');
    expect(store.read(SAVE_KEY)).toBe('{"version":1,"highScore":5}');
  });

  it('slot summaries for the title card and the cards in the panel show progress before load', () => {
    const store = new MemoryStore();
    saveSlot(store, 2, pilot({ flightSeconds: 3900, savedAt: Date.UTC(2026, 9, 21, 9, 5) }));
    store.write(slotKey(3), 'garbage');
    expect(slotSummary(readSlot(store, 1))).toBe('SLOT 1 · NEW PILOT');
    expect(slotSummary(readSlot(store, 2))).toBe('SLOT 2 · 1 SYSTEM · 250 MARKS · 1:05 H');
    expect(slotSummary(readSlot(store, 3))).toBe('SLOT 3 · UNREADABLE (BACKUP KEPT)');
    const names = { galaxy: () => 'Milky Way', system: () => 'Sol', ship: () => 'Petrel' };
    const c = slotCard(readSlot(store, 2), 1, names);
    expect(c.title).toBe('SLOT 2');
    expect(c.lines[0]).toBe('Sol · Milky Way');
    expect(c.lines.join(' ')).toMatch(/250 marks · missions 0 done, 0 active/);
    expect(c.lines.join(' ')).toMatch(/saved 21 Oct 2026/);
    expect(slotCard(readSlot(store, 1), 1, names)).toMatchObject({ title: 'SLOT 1 · IN USE', lines: ['Empty slot.'] });
    expect(slotCard(readSlot(store, 3), 1, names).lines[0]).toMatch(/could not be read/);
  });
});

/* ----------------------------------------------------------- prefs */
describe('shared Free Roam prefs (controls) are separate from slots', () => {
  it('carried over from slot 1 once, or from its kept v9 copy when slot 1 was already migrated', () => {
    const store = new MemoryStore();
    store.write(versionKey(slotKey(1), 9), v9());
    saveSlot(store, 1, pilot()); // v10, no controls
    const r = loadFreeRoamPrefs(store);
    expect(r.seeded).toBe(true);
    expect(r.data.controls).toMatchObject({ mouseAim: true, zoom: 1.3 });
  });

  it('a new slot uses the shared controls; the prefs record is never part of a slot', () => {
    const store = new MemoryStore();
    store.write(slotKey(1), v9());
    loadFreeRoamPrefs(store);
    saveSlot(store, 2, startSession(EMPTY_PROFILE, 1));
    expect(JSON.parse(store.read(slotKey(2))!)).not.toHaveProperty('controls');
    expect(loadFreeRoamPrefs(store).data.controls.zoom).toBe(1.3);
  });
});

/* --------------------------------------------------------------- audit */
describe('save audit against the game data', () => {
  it('a valid slot passes unchanged', () => {
    const r = auditProfile(graph, pilot());
    expect(r.changed).toBe(0);
    expect(auditText(r)).toBe('');
  });

  it('nonexistent systems, unknown ships / missions / milestones and stale points are removed; unknown cargo stays', () => {
    const bad = pilot({
      currentSystem: 'milky-way/nowhere',
      visitedSystems: [SOL, 'milky-way/nowhere'],
      chartedSystems: ['andromeda/void'],
      visitedGalaxies: ['milky-way', 'no-galaxy'],
      sectors: { 'milky-way/nowhere': { done: ['cache-1'], surveyed: true }, [SOL]: { done: [], surveyed: false } },
      cargo: { scrap: 5, 'mystery-ore': 3 },
      fleet: { active: 'ghost-ship', owned: ['petrel', 'ghost-ship'], loadouts: { 'ghost-ship': { weapon: ['x'] } } },
      lostCargo: { systemId: 'milky-way/nowhere', x: 1, y: 1, cargo: { scrap: 2 } },
      resume: { systemId: 'milky-way/nowhere', x: 1, y: 1, heading: 0 },
      milestones: ['no-such-milestone'],
      progression: { ...EMPTY_PROGRESSION, licences: ['mk9'], missions: { ...EMPTY_PROGRESSION.missions, completed: ['story-made-up'] } },
    });
    const r = auditProfile(graph, bad);
    const p = r.profile;
    expect(p.currentSystem).not.toBe('milky-way/nowhere');
    expect(graph.system(p.currentSystem)).toBeDefined();
    expect(p.visitedSystems).not.toContain('milky-way/nowhere');
    expect(p.chartedSystems).toEqual([]);
    expect(p.visitedGalaxies).toEqual(['milky-way']);
    expect(Object.keys(p.sectors)).toEqual([SOL]);
    expect(p.fleet).toEqual({ active: 'petrel', owned: ['petrel'], loadouts: {} });
    expect(p.lostCargo).toBeNull();
    expect(p.resume).toBeNull();
    expect(p.milestones).toEqual([]);
    expect(p.progression.licences).toEqual([]);
    expect(p.progression.missions.completed).toEqual([]);
    expect(p.cargo).toEqual({ scrap: 5, 'mystery-ore': 3 }); // nothing in the hold vanishes
    expect(r.issues.map((i) => i.area).sort()).toEqual(['fleet', 'milestones', 'missions', 'navigation', 'resume', 'sectors', 'upgrades', 'wreck']);
    expect(auditText(r)).toMatch(/no longer matched the game data .* A backup copy of the slot was kept\./);
  });

  it('a resume point in another (valid) system is stale: dropped silently, not an issue', () => {
    const r = auditProfile(graph, pilot({ resume: { systemId: 'milky-way/sirius', x: 10, y: 10, heading: 0 } }));
    expect(r.profile.resume).toBeNull();
    expect(r.changed).toBe(0);
  });

  it('duplicate inventory records and invalid statistics are cleaned by the shape check', () => {
    const store = new MemoryStore();
    store.write(
      slotKey(1),
      JSON.stringify({ ...pilot(), version: FREEROAM_VERSION, fleet: { active: 'petrel', owned: ['petrel', 'petrel'], loadouts: {} }, milestones: ['first-survey', 'first-survey'], cargo: { scrap: -4, ice: 2.5, alloy: 3 }, progression: { ...EMPTY_PROGRESSION, marks: -10, missions: { ...EMPTY_PROGRESSION.missions, completed: ['story-first-light', 'story-first-light'] } }, sessions: Number.MAX_SAFE_INTEGER * 4 }),
    );
    const r = loadSlot(store, 1);
    expect(r.status).toBe('repaired');
    expect(r.data.fleet.owned).toEqual(['petrel']);
    expect(r.data.milestones).toEqual(['first-survey']);
    expect(r.data.cargo).toEqual({ alloy: 3 });
    expect(r.data.progression.marks).toBe(0);
    expect(r.data.progression.missions.completed).toEqual(['story-first-light']);
    expect(r.data.sessions).toBe(0);
  });
});

/* -------------------------------------------------------------- resume */
describe('resume points are checked against the sector layout', () => {
  const sys = getCatalogue().systems.find((s) => s.id === SOL)!;
  const L = generateSector(sys, sectorContext(graph, SOL));

  it('a safe point is used; the spawn id stays (a recall still goes to the arrival)', () => {
    const sp = L.spawns[0]!;
    const at = { x: sp.x + 30, y: sp.y, heading: 7 };
    expect(safeResumePoint(L, at)).toMatchObject({ x: at.x, y: at.y });
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 1, at });
    expect(run.ship.x).toBe(at.x);
    expect(run.spawn).toBe('arrival');
  });

  it('inside a solid, outside the bounds, or not a number: ignored (the run starts at the arrival)', () => {
    const solid = solidsOf(L)[0]!;
    expect(safeResumePoint(L, { x: solid.x, y: solid.y, heading: 0 })).toBeNull();
    expect(safeResumePoint(L, { x: -50, y: 10, heading: 0 })).toBeNull();
    expect(safeResumePoint(L, { x: L.width + 10, y: 10, heading: 0 })).toBeNull();
    expect(safeResumePoint(L, { x: Number.NaN, y: 10, heading: 0 })).toBeNull();
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { seed: 1, at: { x: solid.x, y: solid.y, heading: 0 } });
    expect(run.ship.x).toBe(L.spawns[0]!.x);
  });

  it('every generated spawn point counts as a safe resume point (same clearances)', () => {
    for (const sp of L.spawns) expect(safeResumePoint(L, sp)).not.toBeNull();
  });
});

/* ---------------------------------------------------- storage failures */
describe('unavailable storage and write failures', () => {
  it('storage that throws falls back to memory: slots still work for this page, persistent is false', () => {
    const store = openStore(() => {
      throw new Error('SecurityError');
    });
    expect(store.persistent).toBe(false);
    expect(saveSlot(store, 2, pilot())).toBe(true);
    expect(loadSlot(store, 2).data.progression.marks).toBe(250);
    expect(storageLines({ slots: [], active: 2, persistent: false, writable: true, lastSaveAt: 0, lastSaveFailed: false })[0]!.text).toMatch(/progress lasts only until this tab closes/);
  });

  it('a full quota: the write reports failure and the stored slot is unchanged', () => {
    const store = new FlakyStore();
    saveSlot(store, 1, pilot());
    const before = store.read(slotKey(1));
    store.fail = () => true;
    expect(saveSlot(store, 1, pilot({ cargo: { scrap: 999 } }))).toBe(false);
    expect(store.read(slotKey(1))).toBe(before);
    const lines = storageLines({ slots: [], active: 1, persistent: true, writable: true, lastSaveAt: 0, lastSaveFailed: true });
    expect(lines[0]).toEqual({ text: expect.stringMatching(/last save FAILED/), warn: true });
  });

  it('the panel always says saves are local to this browser and do not sync across devices', () => {
    const lines = storageLines({ slots: [], active: 1, persistent: true, writable: true, lastSaveAt: 0, lastSaveFailed: false });
    expect(lines.map((l) => l.text).join(' ')).toMatch(/do not sync to other devices or browsers/);
  });
});

/* ---------------------------------------------------------------- Classic */
describe('Classic saves stay compatible', () => {
  it('Free Roam slot operations never touch galaxia:save; the Classic record still parses as before', () => {
    const store = new FlakyStore();
    const classic = JSON.stringify({ version: 1, highScore: 4200, bestStage: 3 });
    store.data.set(SAVE_KEY, classic);
    store.data.set(slotKey(1), v9());
    loadFreeRoamPrefs(store);
    loadSlot(store, 1);
    saveSlot(store, 1, pilot());
    saveSlot(store, 2, pilot());
    setActiveSlot(store, 2);
    deleteSlot(store, 2);
    readSlots(store);
    expect(store.read(SAVE_KEY)).toBe(classic);
    expect(store.writes.filter((k) => k.startsWith(SAVE_KEY))).toEqual([]);
    const parsed = parseSave(classic);
    expect(parsed.status).not.toBe('corrupt');
    expect(parsed.data).toMatchObject({ highScore: 4200, bestStage: 3 });
    const mgr = new SaveManager(store);
    expect(mgr.get().highScore).toBe(4200);
  });

  it('the shared record layer keeps its old behaviour for an intact record (no extra writes)', () => {
    const store = new FlakyStore();
    saveSlot(store, 1, pilot());
    store.writes = [];
    const r = loadRecord(store, slotSpec(1));
    expect(r.status).toBe('ok');
    expect(r.backups).toEqual([]);
    expect(store.writes).toEqual([]);
  });
});
