import { describe, expect, it } from 'vitest';
import { MemoryStore, openStore, WebStorageStore, type KeyValueStore, type StorageLike } from '../src/persistence/storage.ts';
import { DEFAULT_SAVE, SAVE_BACKUP_KEY, SAVE_KEY, SaveManager } from '../src/persistence/saveData.ts';
import { backupKey, NOTICE_TEXT, STORAGE_KEYS } from '../src/shared/persistence/namespaces.ts';
import { PreferencesStore } from '../src/shared/persistence/preferences.ts';
import { addFlight, EMPTY_PROFILE, EMPTY_PROGRESSION, formatTicks, loadProfile, profileSummary, recordSurvey, saveProfile, START_GALAXY, STARTER_SAVED_FLEET, startSession, withNavigation } from '../src/modes/freeroam/profile.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { initialProgress, progressFromSaved } from '../src/modes/freeroam/galaxy/progress.ts';

/** A Classic record exactly as Stage 2-9 builds wrote it (custom prefs, real progress). */
const CLASSIC_RECORD = JSON.stringify({
  version: 1,
  highScore: 33480,
  bestStage: 7,
  audio: { muted: true, master: 0.5, sfx: 0.9, music: 0.2 },
  display: { glow: false, pixelPerfect: true, reducedMotion: 'on' },
});

class RecordingStore implements KeyValueStore {
  readonly persistent = true;
  readonly data = new Map<string, string>();
  writes: string[] = [];
  failWrites = false;
  read(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  write(key: string, value: string): boolean {
    if (this.failWrites) return false;
    this.writes.push(key);
    this.data.set(key, value);
    return true;
  }
  remove(key: string): boolean {
    this.data.delete(key);
    return true;
  }
}

describe('storage namespaces', () => {
  it('keeps the Classic key unchanged and gives each mode / shared prefs its own key', () => {
    expect(STORAGE_KEYS.classic).toBe('galaxia:save');
    expect(SAVE_KEY).toBe('galaxia:save');
    expect(STORAGE_KEYS.prefs).toBe('galaxia:prefs');
    expect(STORAGE_KEYS.freeroam).toBe('galaxia:freeroam');
    expect(new Set(Object.values(STORAGE_KEYS)).size).toBe(Object.values(STORAGE_KEYS).length);
    expect(SAVE_BACKUP_KEY).toBe(backupKey(SAVE_KEY));
    expect(Object.keys(NOTICE_TEXT).sort()).toEqual(['backup-failed', 'corrupt-reset', 'future-version', 'unavailable', 'write-failed']);
  });
});

describe('shared preferences (galaxia:prefs)', () => {
  it('migrates audio / display from an existing Classic save once, without touching the Classic record', () => {
    const store = new RecordingStore();
    store.data.set(SAVE_KEY, CLASSIC_RECORD);
    const prefs = new PreferencesStore(store);
    expect(prefs.source).toBe('migrated-from-classic');
    expect(prefs.get().audio).toEqual({ muted: true, master: 0.5, sfx: 0.9, music: 0.2 });
    // a pre-TD-73 record has no arcadeDisplay: Responsive Display (false), no repair
    expect(prefs.get().display).toEqual({ glow: false, pixelPerfect: true, reducedMotion: 'on', arcadeDisplay: false });
    expect(store.data.get(SAVE_KEY)).toBe(CLASSIC_RECORD); // byte-identical
    expect(store.writes).toEqual(['galaxia:prefs']);

    // later changes go to galaxia:prefs only; a second load reads them, not the Classic copy
    prefs.setAudio({ muted: false });
    expect(store.data.get(SAVE_KEY)).toBe(CLASSIC_RECORD);
    const again = new PreferencesStore(store);
    expect(again.source).toBe('prefs');
    expect(again.get().audio.muted).toBe(false);
  });

  it('starts from defaults (and writes nothing) when there is no save at all', () => {
    const store = new RecordingStore();
    const prefs = new PreferencesStore(store);
    expect(prefs.source).toBe('defaults');
    expect(prefs.get().audio).toEqual(DEFAULT_SAVE.audio);
    expect(store.writes).toEqual([]);
  });

  it('backs up a corrupt prefs record before resetting it, leaving Classic intact', () => {
    const store = new RecordingStore();
    store.data.set(SAVE_KEY, CLASSIC_RECORD);
    store.data.set('galaxia:prefs', '{not json');
    const prefs = new PreferencesStore(store);
    expect(prefs.backedUp).toBe(true);
    expect(store.data.get('galaxia:prefs:backup')).toBe('{not json');
    expect(JSON.parse(store.data.get('galaxia:prefs')!).version).toBe(1);
    expect(store.data.get(SAVE_KEY)).toBe(CLASSIC_RECORD);
  });

  it('never overwrites prefs written by a newer build', () => {
    const store = new RecordingStore();
    const future = JSON.stringify({ version: 99, audio: { muted: true }, display: {}, extra: 'x' });
    store.data.set('galaxia:prefs', future);
    const prefs = new PreferencesStore(store);
    expect(prefs.loadStatus).toBe('future-version');
    expect(prefs.get().audio.muted).toBe(true);
    expect(prefs.setAudio({ muted: false })).toBe(false);
    expect(prefs.persistent).toBe(false);
    expect(store.data.get('galaxia:prefs')).toBe(future);
  });

  it('bumps the revision on every change (renderer redraw check)', () => {
    const prefs = new PreferencesStore(new MemoryStore());
    const r = prefs.revision;
    prefs.setDisplay({ glow: false });
    expect(prefs.revision).toBe(r + 1);
    expect(prefs.get().display.glow).toBe(false);
  });
});

describe('Classic save stays intact', () => {
  it('SaveManager still reads the Stage 2-9 record unchanged', () => {
    const store = new RecordingStore();
    store.data.set(SAVE_KEY, CLASSIC_RECORD);
    const save = new SaveManager(store);
    expect(save.loadStatus).toBe('ok');
    expect(save.get()).toMatchObject({ highScore: 33480, bestStage: 7 });
    expect(store.writes).toEqual([]);
  });

  it('Free Roam progress never writes to or reads from the Classic key', () => {
    const store = new RecordingStore();
    store.data.set(SAVE_KEY, CLASSIC_RECORD);
    const loaded = loadProfile(store);
    let p = startSession(loaded.data, 1_700_000_000_000);
    p = addFlight(p, 95, 3);
    p = recordSurvey(p, 3725).profile;
    expect(saveProfile(store, p)).toBe(true);
    expect(store.writes).toEqual(['galaxia:freeroam']);
    expect(store.data.get(SAVE_KEY)).toBe(CLASSIC_RECORD);
    // and a Classic result never touches the Free Roam record
    const fr = store.data.get('galaxia:freeroam');
    new SaveManager(store).recordGameResult({ score: 40000, stage: 9 });
    expect(store.data.get('galaxia:freeroam')).toBe(fr);
    expect(JSON.parse(store.data.get(SAVE_KEY)!)).toMatchObject({ highScore: 40000, bestStage: 9, audio: { muted: true } });
  });

  it('copies an unreadable Classic record to galaxia:save:backup before replacing it', () => {
    const store = new RecordingStore();
    store.data.set(SAVE_KEY, '<<garbage>>');
    const save = new SaveManager(store);
    expect(save.loadStatus).toBe('corrupt');
    expect(save.backedUp).toBe(true);
    expect(store.data.get(SAVE_BACKUP_KEY)).toBe('<<garbage>>');
    save.recordGameResult({ score: 1200, stage: 2 });
    expect(store.data.get(SAVE_BACKUP_KEY)).toBe('<<garbage>>');
    expect(JSON.parse(store.data.get(SAVE_KEY)!).highScore).toBe(1200);
  });
});

describe('Free Roam profile (galaxia:freeroam)', () => {
  it('round-trips and tracks sessions, flight time, beacons and best survey', () => {
    const store = new MemoryStore();
    expect(loadProfile(store).status).toBe('missing');
    let p = startSession(EMPTY_PROFILE, 1000);
    expect(profileSummary(p)).toBe('SURVEYS 0');
    expect(profileSummary(EMPTY_PROFILE)).toBe('NEW PILOT · FLIGHT TEST');
    p = addFlight(p, 12.9, 2);
    const first = recordSurvey(p, 3600);
    expect(first.newBest).toBe(true);
    const slower = recordSurvey(first.profile, 4000);
    expect(slower.newBest).toBe(false);
    const faster = recordSurvey(slower.profile, 3000);
    expect(faster.newBest).toBe(true);
    saveProfile(store, faster.profile);
    const back = loadProfile(store);
    expect(back.status).toBe('ok');
    expect(back.data).toEqual({ createdAt: 1000, sessions: 1, flightSeconds: 12, beaconsCharted: 2, surveysCompleted: 3, bestSurveyTicks: 3000, currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [], galaxySurveys: {}, currentSystem: '', visitedSystems: [], sectors: {}, cargo: {}, fleet: STARTER_SAVED_FLEET, lostCargo: null, modules: {}, milestones: [], progression: EMPTY_PROGRESSION, savedAt: 0, resume: null, ordnance: { 'heavy-missile': 4, nuke: 1 } });
    expect(startSession(back.data, 5000).createdAt).toBe(1000); // creation time is kept
    expect(profileSummary(back.data)).toBe('SURVEYS 3 · BEST 0:50.0');
  });

  it('salvages valid fields from a damaged record and backs up unparsable text', () => {
    const store = new RecordingStore();
    store.data.set('galaxia:freeroam', JSON.stringify({ version: 10, sessions: 4, flightSeconds: -5, beaconsCharted: 'many', bestSurveyTicks: 1.5 }));
    const repaired = loadProfile(store);
    expect(repaired.status).toBe('repaired');
    expect(repaired.data).toMatchObject({ sessions: 4, flightSeconds: 0, beaconsCharted: 0, bestSurveyTicks: 1 });

    store.data.set(
      'galaxia:freeroam',
      JSON.stringify({ version: 10, currentGalaxy: 'Not An Id', visitedGalaxies: ['lmc', 'lmc', 7, 'BAD'], chartedSystems: 'sol', galaxySurveys: { lmc: 2, 'milky-way': -1, x: 1.5, '../evil': 3 } }),
    );
    const nav = loadProfile(store);
    expect(nav.status).toBe('repaired');
    expect(nav.data).toMatchObject({ currentGalaxy: 'milky-way', visitedGalaxies: ['lmc'], chartedSystems: [], galaxySurveys: { lmc: 2 } });

    store.data.set('galaxia:freeroam', 'NaN{');
    const corrupt = loadProfile(store);
    expect(corrupt.status).toBe('corrupt');
    expect(corrupt.backedUp).toBe(true);
    expect(corrupt.data).toEqual(EMPTY_PROFILE);
    expect(store.data.get('galaxia:freeroam:backup')).toBe('NaN{');
  });

  it('marks a newer-version profile read-only', () => {
    const store = new RecordingStore();
    store.data.set('galaxia:freeroam', JSON.stringify({ version: 11, sessions: 9, galaxy: { sectors: 400 } }));
    const r = loadProfile(store);
    expect(r.status).toBe('future-version');
    expect(r.writable).toBe(false);
    expect(r.data.sessions).toBe(9);
  });

  it('migrates a v1 (Prompt 2) profile through v2 to v10 without losing its stats (starter fleet, no cargo wreck, empty storage, fresh progression)', () => {
    const store = new RecordingStore();
    const v1 = { version: 1, createdAt: 77, sessions: 5, flightSeconds: 300, beaconsCharted: 21, surveysCompleted: 4, bestSurveyTicks: 2400 };
    store.data.set('galaxia:freeroam', JSON.stringify(v1));
    const r = loadProfile(store);
    expect(r.status).toBe('migrated');
    expect(r.writable).toBe(true);
    expect(r.data).toEqual({ ...v1, version: undefined, currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [], galaxySurveys: {}, currentSystem: '', visitedSystems: [], sectors: {}, cargo: {}, fleet: STARTER_SAVED_FLEET, lostCargo: null, modules: {}, milestones: [], progression: EMPTY_PROGRESSION, savedAt: 0, resume: null, ordnance: { 'heavy-missile': 4, nuke: 1 } });
    saveProfile(store, r.data);
    expect(JSON.parse(store.data.get('galaxia:freeroam')!)).toMatchObject({ version: 10, sessions: 5, currentGalaxy: 'milky-way' });
    expect(loadProfile(store).status).toBe('ok');
  });

  it('migrates a v2 (Prompt 4) profile to v4: the pilot stands at the gateway of their galaxy, charts kept, charted sectors count as surveyed', () => {
    const graph = buildNavGraph();
    const store = new RecordingStore();
    const v2 = { version: 2, createdAt: 1, sessions: 3, flightSeconds: 90, beaconsCharted: 15, surveysCompleted: 3, bestSurveyTicks: 2000, currentGalaxy: 'lmc', visitedGalaxies: ['milky-way', 'lmc'], chartedSystems: ['milky-way/sol', 'milky-way/alpha-centauri'], galaxySurveys: { 'milky-way': 2, lmc: 1 } };
    store.data.set('galaxia:freeroam', JSON.stringify(v2));
    const r = loadProfile(store);
    expect(r.status).toBe('migrated');
    expect(r.data.currentSystem).toBe('');
    expect(r.data.visitedSystems).toEqual([]);
    expect(r.data.chartedSystems).toEqual(v2.chartedSystems);
    expect(r.data.sectors).toEqual({ 'milky-way/sol': { done: [], surveyed: true }, 'milky-way/alpha-centauri': { done: [], surveyed: true } });
    const p = progressFromSaved(graph, r.data);
    expect(p.system).toBe(graph.node('lmc')!.galaxy.gameplay.gatewaySystemId);
    expect(p.visitedSystems).toEqual([p.system]);
  });

  it('falls back to the gateway when the saved system is unknown, in another galaxy, or locked', () => {
    const graph = buildNavGraph();
    const gate = graph.node('milky-way')!.galaxy.gameplay.gatewaySystemId;
    for (const currentSystem of ['milky-way/nowhere', 'lmc/southwind-landing', 'milky-way/sagittarius-a-star']) {
      const p = progressFromSaved(graph, { ...EMPTY_PROFILE, currentSystem });
      expect(p.system).toBe(gate);
    }
    const ok = progressFromSaved(graph, { ...EMPTY_PROFILE, currentSystem: 'milky-way/sirius', visitedSystems: ['milky-way/sirius'] });
    expect(ok.system).toBe('milky-way/sirius');
  });

  it('sanitises bad v3 navigation fields instead of discarding the profile', () => {
    const store = new RecordingStore();
    store.data.set('galaxia:freeroam', JSON.stringify({ ...EMPTY_PROFILE, version: 3, currentSystem: 42, visitedSystems: ['milky-way/sol', 'NOT AN ID', 7] }));
    const r = loadProfile(store);
    expect(r.data.currentSystem).toBe('');
    expect(r.data.visitedSystems).toEqual(['milky-way/sol']);
  });

  it('stores navigation progress and starts new pilots in the catalogue start galaxy', () => {
    const graph = buildNavGraph();
    expect(START_GALAXY).toBe(graph.start);
    const nav = {
      current: 'lmc' as const,
      visited: ['milky-way' as const, 'lmc' as const],
      charted: ['milky-way/sol'],
      surveys: { 'milky-way': 1 },
      system: 'lmc/southwind-landing',
      visitedSystems: ['milky-way/sol', 'lmc/southwind-landing'],
    };
    const p = withNavigation(EMPTY_PROFILE, nav);
    expect(progressFromSaved(graph, p)).toEqual(nav);
    expect(progressFromSaved(graph, EMPTY_PROFILE)).toEqual(initialProgress(graph));
    const store = new MemoryStore();
    saveProfile(store, p);
    expect(progressFromSaved(graph, loadProfile(store).data)).toEqual(nav);
  });

  it('formats flight times from 60 Hz ticks', () => {
    expect(formatTicks(0)).toBe('0:00.0');
    expect(formatTicks(59)).toBe('0:00.9');
    expect(formatTicks(3725)).toBe('1:02.0');
    expect(formatTicks(60 * 600 + 6)).toBe('10:00.1');
    expect(formatTicks(-10)).toBe('0:00.0');
  });
});

describe('unavailable or failing storage', () => {
  const throwing: StorageLike = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => undefined,
  };

  it('falls back to an in-memory store when storage is missing or throws', () => {
    expect(openStore(() => undefined).persistent).toBe(false);
    expect(openStore(() => throwing).persistent).toBe(false);
    expect(
      openStore(() => {
        throw new Error('blocked');
      }).persistent,
    ).toBe(false);
  });

  it('keeps every mode working on a store whose reads and writes fail', () => {
    const store = new WebStorageStore(throwing);
    const prefs = new PreferencesStore(store);
    expect(prefs.get().audio).toEqual(DEFAULT_SAVE.audio);
    expect(prefs.setAudio({ muted: true })).toBe(false);
    expect(prefs.get().audio.muted).toBe(true); // the session still uses the change
    expect(loadProfile(store).status).toBe('missing');
    expect(saveProfile(store, startSession(EMPTY_PROFILE, 1))).toBe(false);
    expect(new SaveManager(store).get().highScore).toBe(0);
  });

  it('reports write failures without throwing (storage full)', () => {
    const store = new RecordingStore();
    store.failWrites = true;
    expect(saveProfile(store, EMPTY_PROFILE)).toBe(false);
    const prefs = new PreferencesStore(store);
    prefs.setDisplay({ glow: false });
    expect(prefs.lastWriteOk).toBe(false);
  });
});
