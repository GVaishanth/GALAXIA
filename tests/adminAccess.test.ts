/**
 * P04 Hidden Admin Access: activation detectors, session rules, navigator and
 * the station arrival. The shell wiring (save gateway, exit restart, panel
 * presence) is exercised in the browser harness
 * (docs/development/playtest/admin-access-p04.mjs) against real storage.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_GESTURE, ADMIN_KEY_TIMING, ADMIN_REQUEST_TTL_MS, ADMIN_SEQUENCE, createGestureDetector, createSequenceDetector, dropAdminRequest, requestAdminLaunch, takeAdminRequest, type KeyStroke } from '../src/modes/freeroam/admin/activation.ts';
import { allDestinations, navigatorGalaxies, navigatorSystems } from '../src/modes/freeroam/admin/navigator.ts';
import { adminArrive, adminFleet, adminOnlyShips, adminSelectShip, beginAdmin, isAdmin, mayPersist, resolveDestination, stationApproach, travelCost, type AdminSession } from '../src/modes/freeroam/admin/session.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { checkTravel, deriveView, initialProgress } from '../src/modes/freeroam/galaxy/progress.ts';
import { applySystemTravel, deriveSystemView } from '../src/modes/freeroam/galaxy/systems.ts';
import { DEFAULT_BINDINGS, PANEL_KEYS, RESERVED_KEYS, ZOOM_KEYS } from '../src/modes/freeroam/bindings.ts';
import { MAP_KEYS } from '../src/modes/freeroam/input.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { safeResumePoint } from '../src/modes/freeroam/sector/resume.ts';
import { createSectorRun, interact, stepSector } from '../src/modes/freeroam/sector/run.ts';
import { compatibleWeapons } from '../src/modes/freeroam/ships/armory.ts';
import { selectShip, STARTER_FLEET, type FleetState } from '../src/modes/freeroam/ships/hangar.ts';
import { SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { SHIP_IDS } from '../src/modes/freeroam/ships/types.ts';

const graph = buildNavGraph();
const catalogue = getCatalogue();
const normal = initialProgress(graph);
const session = (from: AdminSession['from'] = 'map', fleet: FleetState = STARTER_FLEET): AdminSession => beginAdmin(fleet, normal, from);
const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/* ------------------------------------------------------------ keyboard */

const stroke = (code: string, t: number, o: Partial<KeyStroke> = {}): KeyStroke => ({ code, t, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...o });
/** Feed codes `gap` ms apart; returns the indices of the strokes that completed the sequence. */
function feed(codes: readonly string[], gap = 200, o: Partial<KeyStroke> = {}, d = createSequenceDetector()): number[] {
  const hits: number[] = [];
  codes.forEach((c, i) => {
    if (d.feed(stroke(c, 1000 + i * gap, o))) hits.push(i);
  });
  return hits;
}

describe('P04 desktop activation sequence', () => {
  it('is Shift held + G L X 0 4 (physical keys)', () => {
    expect([...ADMIN_SEQUENCE]).toEqual(['KeyG', 'KeyL', 'KeyX', 'Digit0', 'Digit4']);
    expect(ADMIN_KEY_TIMING).toEqual({ stepMs: 1500, totalMs: 6000 });
  });

  it('completes exactly on the last key, once', () => {
    expect(feed(ADMIN_SEQUENCE)).toEqual([4]);
    const d = createSequenceDetector();
    expect(feed([...ADMIN_SEQUENCE, ...ADMIN_SEQUENCE], 200, {}, d)).toEqual([4, 9]); // a fresh start after completing
  });

  it('needs Shift and refuses Ctrl / Alt / Meta', () => {
    expect(feed(ADMIN_SEQUENCE, 200, { shiftKey: false })).toEqual([]);
    expect(feed(ADMIN_SEQUENCE, 200, { ctrlKey: true })).toEqual([]);
    expect(feed(ADMIN_SEQUENCE, 200, { altKey: true })).toEqual([]);
    expect(feed(ADMIN_SEQUENCE, 200, { metaKey: true })).toEqual([]);
  });

  it('resets on a wrong key, a slow step, a slow sequence or auto-repeat', () => {
    expect(feed(['KeyG', 'KeyL', 'KeyQ', 'KeyX', 'Digit0', 'Digit4'])).toEqual([]);
    expect(feed(['KeyG', 'KeyL', 'KeyQ', ...ADMIN_SEQUENCE])).toEqual([7]); // restarting works
    expect(feed(ADMIN_SEQUENCE, ADMIN_KEY_TIMING.stepMs + 1)).toEqual([]);
    expect(feed(ADMIN_SEQUENCE, ADMIN_KEY_TIMING.stepMs)).toEqual([4]); // the limits are inclusive
    expect(feed(ADMIN_SEQUENCE, 1000, {}, createSequenceDetector(ADMIN_SEQUENCE, { stepMs: 1500, totalMs: 3000 }))).toEqual([]); // whole-sequence limit
    const d = createSequenceDetector();
    d.feed(stroke('KeyG', 0));
    d.feed(stroke('KeyL', 100));
    expect(d.feed(stroke('KeyL', 150, { repeat: true }))).toBe(false);
    expect(d.progress).toBe(0);
  });

  it('ignores lone modifier keys inside the sequence (Shift is held, not typed)', () => {
    expect(feed(['ShiftLeft', 'KeyG', 'KeyL', 'ShiftRight', 'KeyX', 'Digit0', 'Digit4'])).toEqual([6]);
  });

  it('never completes from ordinary map / menu / flight input, with or without Shift', () => {
    const mapKeys = Object.values(MAP_KEYS).flat() as string[];
    const play = [...mapKeys, 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyJ', 'KeyK', 'KeyM', 'KeyI', 'KeyP', 'KeyR', 'Space', 'Enter', 'Escape', 'Equal', 'Minus', 'BracketLeft', 'BracketRight', 'Digit1', 'Digit2', 'Digit3'];
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const codes = Array.from({ length: 4000 }, () => play[Math.floor(rnd() * play.length)]!);
    expect(feed(codes, 120)).toEqual([]);
    expect(feed(codes, 120, { shiftKey: false })).toEqual([]);
  });

  it('uses keys no map, menu or flight binding uses (no conflicts)', () => {
    // G, L, X, 0 and 4 do nothing on the maps, the station panels or with the default flight bindings.
    // P04.1 exception, by request: X is the default LOCK TARGET flight key. The two never listen at the same
    // time: the sequence is observed only on the maps and while docked in the station panels, and the lock
    // key only in open flight (pinned by the next test), so neither can trigger the other.
    const flight = (Object.entries(DEFAULT_BINDINGS) as [string, readonly (string | null)[]][]).filter(([a]) => a !== 'lock').flatMap(([, k]) => k).filter((x): x is string => x !== null);
    const used = new Set<string>([...Object.values(MAP_KEYS).flat(), ...flight, ...Object.values(PANEL_KEYS).flat(), RESERVED_KEYS.back, ...ZOOM_KEYS.in, ...ZOOM_KEYS.out] as string[]);
    for (const c of ADMIN_SEQUENCE) expect(used.has(c), c).toBe(false);
    expect(DEFAULT_BINDINGS.lock.filter((k) => k !== null && ADMIN_SEQUENCE.includes(k))).toEqual(['KeyX']);
    // the title menu reads arrows / WASD / Enter / Space / Escape only
    const title = readFileSync(resolve(src, 'shared/ui/titleScreen.ts'), 'utf8') + readFileSync(resolve(src, 'shared/ui/menuList.ts'), 'utf8');
    for (const c of ADMIN_SEQUENCE) expect(title, c).not.toContain(`'${c}'`);
  });

  it('P04.1: the sequence is never observed in open flight, and the LOCK key is read only there (no shared context)', () => {
    const mode = readFileSync(resolve(src, 'modes/freeroam/freeRoamMode.ts'), 'utf8');
    const ctx = mode.slice(mode.indexOf('const adminContext = (): boolean => {'), mode.indexOf('/** Capture-phase keydown: observes only'));
    expect(ctx).toContain("if (screen === 'map' || screen === 'systems') return true;");
    // in flight only while docked with a station panel open (no flight key is read behind a panel)
    expect(ctx).toContain("return screen === 'flight' && run !== null && run.docked !== null && (panel === 'station' || panel === 'hangar' || panel === 'armory');");
    // the lock key: in the no-panel branch of the press loop, in flight only
    const loop = mode.slice(mode.indexOf('for (const code of keys.takePresses()) {'), mode.indexOf('if (panel) for (const c of panelPadCommands(update))'));
    expect(loop).toMatch(/if \(panel\) for \(const c of panelKeyCommands/);
    expect(loop).toContain("if (run?.phase === 'flight' && (binds.lock[0] === code || binds.lock[1] === code)) lockPending = !lockPending;");
  });
});

/* ------------------------------------------------------------ touch */

describe('P04 mobile activation gesture (title logo)', () => {
  const hold = (d = createGestureDetector(), ms = 2000, t0 = 0): number => {
    d.down(1, 100, 100, t0);
    expect(d.up(1, t0 + ms)).toBe(false);
    return t0 + ms;
  };
  const taps = (d: ReturnType<typeof createGestureDetector>, from: number, n: number, gap = 200, len = 80, x = 100): boolean[] =>
    Array.from({ length: n }, (_, i) => {
      const t = from + (i + 1) * gap;
      d.down(2 + i, x, 100, t);
      return d.up(2 + i, t + len);
    });

  it('is a 1.5-6 s hold, then 4 quick taps within 2.5 s', () => {
    expect(ADMIN_GESTURE).toMatchObject({ holdMs: 1500, holdMaxMs: 6000, taps: 4, tapMaxMs: 350, windowMs: 2500, slopPx: 16 });
    const d = createGestureDetector();
    const t = hold(d);
    expect(d.stage).toBe('tapping');
    expect(taps(d, t, 4)).toEqual([false, false, false, true]);
    expect(d.stage).toBe('idle');
  });

  it('ordinary taps and short presses never complete it', () => {
    const d = createGestureDetector();
    expect(taps(d, 0, 40).some(Boolean)).toBe(false);
    const t = hold(d, 1200); // too short
    expect(taps(d, t, 4).some(Boolean)).toBe(false);
  });

  it('cancels on a too-long hold, slow taps, long taps, movement or a second finger', () => {
    let d = createGestureDetector();
    expect(taps(d, hold(d, 6500), 4).some(Boolean)).toBe(false);
    d = createGestureDetector();
    expect(taps(d, hold(d), 4, 700).some(Boolean)).toBe(false); // 4 x 700 > 2500 ms window
    d = createGestureDetector();
    expect(taps(d, hold(d), 4, 500, 400).some(Boolean)).toBe(false); // a 400 ms press is not a tap
    d = createGestureDetector();
    d.down(1, 100, 100, 0);
    d.move(1, 130, 100); // a drag (look-around), not a hold
    expect(d.up(1, 2000)).toBe(false);
    expect(d.stage).toBe('idle');
    d = createGestureDetector();
    d.down(1, 100, 100, 0);
    d.down(9, 200, 100, 500); // second finger
    expect(d.up(1, 2000)).toBe(false);
    expect(d.stage).toBe('idle');
  });
});

describe('P04 title -> Free Roam handoff', () => {
  it('is one-shot and expires', () => {
    dropAdminRequest();
    expect(takeAdminRequest(0)).toBe(false);
    requestAdminLaunch(1000);
    expect(takeAdminRequest(2000)).toBe(true);
    expect(takeAdminRequest(2001)).toBe(false); // consumed
    requestAdminLaunch(1000);
    expect(takeAdminRequest(1000 + ADMIN_REQUEST_TTL_MS + 1)).toBe(false); // expired
    requestAdminLaunch(1000);
    dropAdminRequest();
    expect(takeAdminRequest(1001)).toBe(false);
  });
});

/* ------------------------------------------------------------ session */

describe('P04 admin session rules', () => {
  it('has no privileges without a session; persistence is blocked only while one is active', () => {
    expect(isAdmin(null)).toBe(false);
    expect(mayPersist(null)).toBe(true);
    const s = session();
    expect(isAdmin(s)).toBe(true);
    expect(mayPersist(s)).toBe(false);
    expect(Object.isFrozen(s)).toBe(true);
    expect(s.owned).toEqual(['petrel']);
    expect(s.origin).toEqual({ ship: 'petrel', galaxy: normal.current, system: normal.system });
  });

  it('lets the sandbox fly every real roster ship, with unchanged stats and weapon restrictions', () => {
    const before = JSON.stringify(SHIPS);
    const f = adminFleet(STARTER_FLEET);
    expect(f.owned).toEqual([...SHIP_IDS]);
    expect(f.active).toBe('petrel');
    expect(f.loadouts).toBe(STARTER_FLEET.loadouts);
    expect(STARTER_FLEET.owned).toEqual(['petrel']); // the normal fleet object is not touched
    expect([...adminOnlyShips(session())].sort()).toEqual(SHIP_IDS.filter((id) => id !== 'petrel').sort());
    expect(adminOnlyShips(null).size).toBe(0);
    for (const id of SHIP_IDS.filter((x) => x !== 'petrel')) {
      const r = adminSelectShip(session(), STARTER_FLEET, id, true);
      expect(r.ok, id).toBe(true);
      if (r.ok) expect(r.fleet.active).toBe(id);
    }
    expect(JSON.stringify(SHIPS)).toBe(before); // no stat, price or licence edited
    // the Armory rule is the ship's own: no universal nuke
    const nuke = SHIP_IDS.filter((id) => compatibleWeapons(id).includes('nuke')).sort();
    expect(nuke).toEqual(['albatross', 'condor']);
  });

  it('keeps the safe-place rule and refuses unknown ships', () => {
    expect(adminSelectShip(session(), STARTER_FLEET, 'condor', false)).toMatchObject({ ok: false });
    expect(adminSelectShip(session(), STARTER_FLEET, 'not-a-ship', true)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('leaves the normal restrictions exactly as they were', () => {
    for (const id of SHIP_IDS.filter((x) => x !== 'petrel')) {
      expect(selectShip(STARTER_FLEET, id, true)).toEqual({ ok: false, reason: 'not-owned' });
      expect(adminSelectShip(null, STARTER_FLEET, id, true)).toEqual({ ok: false, reason: 'not-owned' });
    }
    expect(travelCost(null, 3)).toBe(3);
    expect(travelCost(session(), 3)).toBe(0);
    const view = deriveView(graph, normal);
    const locked = graph.nodes.filter((n) => !view.galaxyUnlocked(n.id));
    expect(locked.length).toBeGreaterThan(0);
    for (const n of locked) expect(checkTravel(view, n.id).ok, n.id).toBe(false);
    const sv = deriveSystemView(view, normal.current);
    const sealed = graph.systemsIn(normal.current).filter((s) => !sv.unlocked(s.id));
    expect(sealed.length).toBeGreaterThan(0);
    for (const s of sealed) expect(applySystemTravel(graph, normal, s.id).ok, s.id).toBe(false);
  });
});

/* ------------------------------------------------------------ destinations */

describe('P04 admin destinations', () => {
  it('lists exactly the catalogue: every galaxy and every system', () => {
    const view = deriveView(graph, normal);
    const gal = navigatorGalaxies(view);
    expect(gal.map((g) => g.id)).toEqual(graph.nodes.map((n) => n.id));
    expect(gal.reduce((n, g) => n + g.systems, 0)).toBe(catalogue.systems.length);
    expect(gal.reduce((n, g) => n + g.stations, 0)).toBe(catalogue.systems.filter((s) => s.sector.station).length);
    expect(gal.filter((g) => g.here).map((g) => g.id)).toEqual([normal.current]);
    for (const g of gal) expect(navigatorSystems(view, g.id).map((r) => r.id)).toEqual(graph.systemsIn(g.id).map((s) => s.id));
    // normal-play notes come from the normal progress
    const rows = graph.nodes.flatMap((n) => navigatorSystems(view, n.id));
    expect(rows.some((r) => r.normal === 'other-galaxy-locked')).toBe(true);
    expect(rows.some((r) => r.normal === 'locked')).toBe(true);
    expect(rows.find((r) => r.id === normal.system)!.normal).toBe('open');
  });

  it('searches across galaxies by name, id, category or "station"', () => {
    const view = deriveView(graph, normal);
    const target = catalogue.systems.find((s) => s.galaxyId !== normal.current)!;
    const hits = navigatorSystems(view, normal.current, target.name.toUpperCase());
    expect(hits.map((r) => r.id)).toContain(target.id);
    const stations = navigatorSystems(view, normal.current, 'station');
    expect(stations.length).toBe(catalogue.systems.filter((s) => s.sector.station).length);
    expect(navigatorSystems(view, normal.current, 'zzzz-no-such-place')).toEqual([]);
  });

  it('resolves every destination in admin, none without it, and refuses invalid ids', () => {
    const s = session();
    const all = allDestinations(graph);
    expect(all.length).toBe(catalogue.systems.length + catalogue.systems.filter((x) => x.sector.station).length);
    for (const d of all) {
      const r = resolveDestination(s, graph, d);
      expect(r.ok, `${d.system} ${d.arrival}`).toBe(true);
      expect(resolveDestination(null, graph, d)).toEqual({ ok: false, reason: 'not-admin' });
    }
    expect(resolveDestination(s, graph, { galaxy: 'nowhere' })).toEqual({ ok: false, reason: 'unknown-galaxy' });
    expect(resolveDestination(s, graph, { galaxy: 'milky-way', system: 'milky-way/nowhere' })).toEqual({ ok: false, reason: 'unknown-system' });
    const foreign = catalogue.systems.find((x) => x.galaxyId !== 'milky-way')!;
    expect(resolveDestination(s, graph, { galaxy: 'milky-way', system: foreign.id })).toEqual({ ok: false, reason: 'wrong-galaxy' });
    const bare = catalogue.systems.find((x) => !x.sector.station)!;
    expect(resolveDestination(s, graph, { galaxy: bare.galaxyId, system: bare.id, arrival: 'station' })).toEqual({ ok: false, reason: 'no-station' });
    const gw = resolveDestination(s, graph, { galaxy: 'andromeda' });
    expect(gw.ok && gw.system.id).toBe(graph.node('andromeda')!.galaxy.gameplay.gatewaySystemId);
  });

  it('arrives without charting, surveying or completing anything, and leaves the normal progress object alone', () => {
    const s = session();
    const frozen = JSON.stringify(normal);
    const before = deriveView(graph, normal);
    for (const d of allDestinations(graph)) {
      const r = resolveDestination(s, graph, d);
      if (!r.ok) throw new Error(d.system);
      const p = adminArrive(normal, r);
      expect(p.current).toBe(d.galaxy);
      expect(p.system).toBe(d.system);
      expect(p.charted).toBe(normal.charted);
      expect(p.surveys).toBe(normal.surveys);
      const after = deriveView(graph, p);
      expect(after.completed.map((m) => m.id)).toEqual(before.completed.map((m) => m.id));
      expect(after.driveTier).toBe(before.driveTier);
    }
    expect(JSON.stringify(normal)).toBe(frozen);
    expect(JSON.stringify(s.normalProgress)).toBe(frozen);
  });

  it('generates every destination sector through the normal generator; station arrivals start inside docking range', () => {
    let stations = 0;
    for (const d of allDestinations(graph)) {
      const sys = graph.system(d.system)!;
      const L = generateSector(sys, sectorContext(graph, d.system));
      expect(L.spawns.length, d.system).toBeGreaterThan(0);
      if (d.arrival !== 'station') continue;
      stations += 1;
      const at = stationApproach(L);
      expect(at, d.system).not.toBeNull();
      if (!at) continue;
      expect(safeResumePoint(L, at), d.system).toMatchObject({ x: at.x, y: at.y });
      const st = L.pois.find((p) => p.kind === 'station')!;
      expect(Math.hypot(at.x - st.x, at.y - st.y), d.system).toBeGreaterThan(st.solidR);
      const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { spawn: 'arrival', at, seed: 1 });
      expect(run.ship.x).toBe(at.x);
      expect(run.ship.y).toBe(at.y);
      stepSector(run, { moveX: 0, moveY: 0 }); // one idle tick: the station becomes the focus
      expect(run.focus, d.system).toBe(st.id);
      const ev = interact(run);
      expect(ev.map((e) => e.type), d.system).toContain('docked');
    }
    expect(stations).toBe(catalogue.systems.filter((s) => s.sector.station).length);
  });
});

/* ------------------------------------------------------------ shell wiring */

describe('P04 Free Roam shell wiring (source checks)', () => {
  const shell = readFileSync(resolve(src, 'modes/freeroam/freeRoamMode.ts'), 'utf8');
  const lines = shell.split('\n');

  it('routes every reactor-cell travel cost through travelCost (no other cost path)', () => {
    const uses = lines.filter((l) => /\b(routeCells|galaxyJumpCells|hopCells)\(/.test(l) && !/^\s*(import|\*|\/\/)/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const l of uses) expect(l.trim()).toMatch(/travelCost\(admin, (routeCells|galaxyJumpCells|hopCells)\(/);
  });

  it('gates the single save gateway and the shared ship registry on mayPersist', () => {
    const save = shell.indexOf('const save = (): boolean => {');
    expect(save).toBeGreaterThan(0);
    expect(shell.slice(save, save + 260)).toMatch(/if \(!mayPersist\(admin\)\) return true;/);
    for (const l of lines.filter((x) => /recordOwned\(/.test(x) && !/^\s*import/.test(x))) expect(l).toMatch(/mayPersist\(admin\)/);
  });

  it('exits by restarting from the untouched slot, never by writing', () => {
    const at = shell.indexOf('const exitAdmin = (): void => {');
    const body = shell.slice(at, shell.indexOf('};', at));
    expect(body).toMatch(/writable = false/);
    expect(body).toMatch(/ctx\.requestRestart\(\)/);
    expect(body).not.toMatch(/\b(save|persist|saveSlot|recordOwned)\(/);
  });

  it('builds no admin UI before a correct login (created lazily by beginSession only)', () => {
    const calls = lines.filter((l) => /\bbuildAdminUi\(\)/.test(l) && !/const buildAdminUi/.test(l));
    expect(calls.length).toBe(1);
    const enter = shell.indexOf('const beginSession = ');
    expect(shell.slice(enter, shell.indexOf('\n  };', enter))).toMatch(/buildAdminUi\(\)/);
  });

  it('routes both hidden activations to the login screen, never straight into a session', () => {
    expect(shell).not.toMatch(/enterAdmin/);
    expect(lines.filter((l) => /\bopenLogin\(/.test(l) && !/const openLogin/.test(l)).length).toBe(2);
    expect(shell).toMatch(/takeAdminRequest\(performance\.now\(\)\)\) openLogin\('title'\)/);
    // the session starts only inside the login's arrive callback (after a correct password)
    const begins = lines.filter((l) => /\bbeginSession\(/.test(l) && !/const beginSession/.test(l));
    expect(begins.length).toBe(1);
    const open = shell.indexOf('const openLogin = ');
    const body = shell.slice(open, shell.indexOf('\n  };', open));
    expect(body).toMatch(/arrive: \(\) => \{\s*beginSession\(from\);\s*return adminHomeHangar\(\);/);
  });

  it('gives unlimited ammunition only through the admin session', () => {
    expect(shell).toMatch(/unlimitedAmmo: unlimitedAmmo\(admin\)/);
    const sets = lines.filter((l) => /setRunUnlimitedAmmo\(/.test(l) && !/^\s*import/.test(l));
    expect(sets.length).toBe(1);
    const at = shell.indexOf('const beginSession = ');
    expect(shell.slice(at, shell.indexOf('\n  };', at))).toMatch(/setRunUnlimitedAmmo\(run, true\)/);
  });
});
