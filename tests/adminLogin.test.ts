/**
 * P04 refinement: the hidden admin login (admin/login.ts rules, the login's
 * destination, admin-only unlimited ammunition). The DOM screen itself
 * (admin/loginScreen.ts) is exercised in the browser harness
 * docs/development/playtest/admin-access-p04.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEAPON_BY_ID } from '../src/config/weapons.ts';
import { baseOf, createGlitch, GLITCH_MARKS, GLITCH_TIMING, isAdminPassword, NAME_CELLS, OWNER_IDENTITY, renderSlots, REVEAL_TIMING, revealOrder, revealSlots, revealTimeline, seededRng, WELCOME_LINE, type GlitchMode } from '../src/modes/freeroam/admin/login.ts';
import { ADMIN_HOME, beginAdmin, resolveDestination, stationApproach, unlimitedAmmo } from '../src/modes/freeroam/admin/session.ts';
import { gateOf } from '../src/modes/freeroam/combat/playerMissile.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { initialProgress } from '../src/modes/freeroam/galaxy/progress.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, dockIfInRange, setRunUnlimitedAmmo, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { STARTER_FLEET } from '../src/modes/freeroam/ships/hangar.ts';
import { missileGauge, shipCard } from '../src/modes/freeroam/ui/hudModel.ts';
import { arena } from './helpers/combatProbe.ts';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const graph = buildNavGraph();
const normal = initialProgress(graph);

describe('admin password: exactly one ASCII space, validated as received', () => {
  it('accepts only U+0020 alone', () => {
    expect(isAdminPassword(' ')).toBe(true);
    expect(isAdminPassword('\u0020')).toBe(true);
  });

  it('rejects empty, several spaces, a space with anything else, and every other whitespace', () => {
    const bad = ['', '  ', '   ', ' a', 'a ', ' .', '. ', 'a', '\t', '\n', '\r', '\r\n', ' \n', '\n ', '\u00a0', '\u2002', '\u2003', '\u2009', '\u3000', '\u200b', ' \u200b', '\u200b ', '\ufeff', '\ufeff ', ' \u0301', 'space', 'G.Vaishanth', 'G.Vaishanth '];
    for (const v of bad) expect(isAdminPassword(v), JSON.stringify(v)).toBe(false);
  });

  it('never trims or normalises: the rule and the screen compare the raw field value', () => {
    const login = readFileSync(resolve(src, 'modes/freeroam/admin/login.ts'), 'utf8');
    const rule = login.slice(login.indexOf('export function isAdminPassword'), login.indexOf('\n}', login.indexOf('export function isAdminPassword')));
    expect(rule).toMatch(/return value === PASSWORD;/);
    expect(login).toMatch(/const PASSWORD = '\\u0020';/);
    expect(rule).not.toMatch(/trim|normalize|replace|toLowerCase|toUpperCase/);
    const screen = readFileSync(resolve(src, 'modes/freeroam/admin/loginScreen.ts'), 'utf8');
    expect(screen).toMatch(/isAdminPassword\(input\.value\)/);
    expect(screen).not.toMatch(/\.(trim|trimStart|trimEnd|normalize)\(/);
    // a password field without autofill, spellcheck or autocapitalisation
    expect(screen).toMatch(/input\.type = 'password'/);
    expect(screen).toMatch(/input\.autocomplete = 'off'/);
    expect(screen).toMatch(/input\.spellcheck = false/);
    expect(screen).toMatch(/setAttribute\('autocapitalize', 'off'\)/);
    // the value is cleared on every submit (rejected or accepted) and never kept
    expect(screen.match(/input\.value = ''/g)?.length).toBe(2);
    expect(screen).not.toMatch(/\b(console|localStorage|sessionStorage|fetch|sendBeacon)\b/);
  });

  it('the identity and the welcome are the exact texts', () => {
    expect(OWNER_IDENTITY).toBe('G.Vaishanth');
    expect(WELCOME_LINE).toBe('WELCOME, MASTER');
    expect(NAME_CELLS).toBe(11);
  });
});

describe('glitch operator name', () => {
  /** Step a glitch every `dt` ms for `ms`; returns the shown texts and mode visits. */
  function drive(seed: number, ms: number, dt = 16): { texts: string[]; changed: number; modes: Set<GlitchMode> } {
    const g = createGlitch(seed, 0);
    const texts: string[] = [];
    const modes = new Set<GlitchMode>();
    let changed = 0;
    for (let t = 0; t <= ms; t += dt) {
      if (g.step(t)) {
        changed += 1;
        texts.push(g.text);
      }
      modes.add(g.mode);
    }
    expect(g.changes).toBe(changed);
    return { texts, changed, modes };
  }

  it('keeps changing (substitutions, noise, decoding runs, holds) without settling', () => {
    const { texts, changed, modes } = drive(7, 20_000);
    expect(changed).toBeGreaterThan(150);
    expect(new Set(texts).size).toBeGreaterThan(120);
    expect([...modes].sort()).toEqual(['decode', 'drift', 'hold', 'noise']);
    // marks appear sometimes, never on every frame
    const marked = texts.filter((t) => GLITCH_MARKS.some((m) => t.includes(m))).length;
    expect(marked).toBeGreaterThan(texts.length * 0.2);
    expect(marked).toBeLessThan(texts.length);
  });

  it('bounded update rate: at most one change per 50 ms even when stepped every millisecond', () => {
    const fast = drive(3, 5000, 1);
    expect(fast.changed).toBeLessThanOrEqual(5000 / Math.min(...Object.values(GLITCH_TIMING)) + 1);
  });

  it('fixed width: always 11 cells, at most one mark per cell; never the real identity', () => {
    const g = createGlitch(11, 0);
    for (let t = 0; t <= 30_000; t += 16) {
      g.step(t);
      expect(g.slots.length).toBe(NAME_CELLS);
      for (const s of g.slots) {
        expect([...s.ch].length).toBe(1);
        expect(s.mark === '' || GLITCH_MARKS.includes(s.mark)).toBe(true);
      }
      expect(baseOf(g.slots)).not.toBe(OWNER_IDENTITY);
    }
  });

  it('a rejection burst switches to heavy noise at once, then calms down', () => {
    const g = createGlitch(5, 0);
    for (let t = 0; t < 400; t += 16) g.step(t);
    g.burst(400);
    expect(g.mode).toBe('noise');
    expect(g.intensity).toBeGreaterThan(0.8);
    expect(g.step(400)).toBe(true);
    for (let t = 416; t < 1400; t += 16) g.step(t);
    expect(g.mode).not.toBe('noise');
  });

  it('is deterministic per seed and differs across seeds', () => {
    expect(drive(42, 3000).texts).toEqual(drive(42, 3000).texts);
    expect(drive(42, 3000).texts).not.toEqual(drive(43, 3000).texts);
  });
});

describe('identity resolution', () => {
  const frozen = createGlitch(9, 0).slots;

  it('reveal order is a permutation that starts at the edges', () => {
    for (const seed of [1, 2, 3, 99]) {
      const o = revealOrder(seed);
      expect([...o].sort((a, b) => a - b)).toEqual([...Array(NAME_CELLS).keys()]);
      expect(Math.abs(o[0]! - 5)).toBeGreaterThanOrEqual(3);
    }
  });

  it('starts as the frozen glitch, locks cells monotonically, ends as exactly G.Vaishanth with no marks', () => {
    const order = revealOrder(4);
    const rng = seededRng(4);
    expect(renderSlots(revealSlots(frozen, OWNER_IDENTITY, 0, order, rng))).toBe(renderSlots(frozen));
    let locked = 0;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const s = revealSlots(frozen, OWNER_IDENTITY, t, order, rng);
      expect(s.length).toBe(NAME_CELLS);
      const lockT = (cell: number): number => 0.1 + (0.8 * order.indexOf(cell)) / (NAME_CELLS - 1);
      const n = s.filter((x, i) => t >= lockT(i) && x.ch === OWNER_IDENTITY[i]).length;
      expect(n).toBeGreaterThanOrEqual(locked);
      locked = n;
    }
    const end = revealSlots(frozen, OWNER_IDENTITY, 1, order, rng);
    expect(renderSlots(end)).toBe('G.Vaishanth');
    expect(end.every((x) => x.mark === '')).toBe(true);
  });
});

describe('reveal timeline', () => {
  for (const reduced of [false, true]) {
    const T = reduced ? REVEAL_TIMING.reduced : REVEAL_TIMING.full;
    const at = (ms: number) => revealTimeline(ms, reduced);
    const label = reduced ? 'reduced motion' : 'full motion';

    it(`${label}: freeze and dim, travel, resolve, welcome, arrive under an opaque overlay, fade out, done once`, () => {
      expect(at(0).card).toBe(1);
      expect(at(T.cardFadeEnd).card).toBeLessThan(0.01);
      expect(at(0).overlay).toBe(1);
      // the name appears before the welcome; the welcome begins before the name has fully resolved
      expect(T.nameIn).toBeLessThan(T.welcomeStart);
      expect(T.welcomeStart).toBeLessThan(T.resolveEnd);
      expect(at(T.resolveEnd).name.resolve).toBe(1);
      expect(at(T.resolveEnd).name.opacity).toBe(1);
      expect(at(T.resolveEnd).name.blur).toBe(0);
      expect(at(T.welcomeEnd).welcome.opacity).toBe(1);
      // the destination is set up while the overlay is still fully opaque, after the welcome has been readable
      expect(at(T.arrive - 1).arrive).toBe(false);
      expect(at(T.arrive).arrive).toBe(true);
      expect(at(T.arrive).overlay).toBe(1);
      expect(T.arrive).toBeGreaterThan(T.welcomeEnd);
      expect(T.arrive).toBeLessThan(T.outStart);
      expect(at(T.total - 1).done).toBe(false);
      expect(at(T.total).done).toBe(true);
      expect(at(T.total).overlay).toBe(0);
      expect(at(T.total + 10_000).overlay).toBe(0);
      // a time jump (backgrounded tab) lands on a finished frame, with arrive also true
      expect(at(1e9)).toMatchObject({ arrive: true, done: true });
      for (let ms = 0; ms <= T.total; ms += 25) {
        const f = at(ms);
        for (const v of [f.card, f.flyer.p, f.flyer.opacity, f.flyer.scale, f.name.opacity, f.name.scale, f.welcome.opacity, f.overlay]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    });

    it(`${label}: the travelling name and the central name cross-fade (no gap, no double)`, () => {
      expect(at(T.flyerOut).flyer.opacity).toBe(0);
      const mid = at(T.nameIn + 150);
      expect(mid.flyer.opacity).toBeGreaterThan(0);
      expect(mid.name.opacity).toBeGreaterThan(0);
    });
  }

  it('full motion: the name is pulled to the centre while it compresses, then settles sharp', () => {
    const T = REVEAL_TIMING.full;
    const f = (ms: number) => revealTimeline(ms, false);
    expect(f(T.moveStart).flyer.p).toBe(0);
    expect(f(T.moveEnd).flyer.p).toBe(1);
    expect(f(T.moveEnd).flyer.scale).toBeLessThan(0.7);
    expect(f(T.lockEnd - 1).lockShake).toBeGreaterThan(0);
    expect(f(T.lockEnd).lockShake).toBe(0);
    let last = -1;
    for (let ms = T.moveStart; ms <= T.moveEnd; ms += 20) {
      expect(f(ms).flyer.p).toBeGreaterThanOrEqual(last);
      last = f(ms).flyer.p;
    }
    expect(f(T.nameIn).name.blur).toBeGreaterThan(2);
    expect(f(T.nameIn).name.spacing).toBeGreaterThan(f(T.resolveEnd).name.spacing);
  });

  it('reduced motion: no travel, no scaling, no blur, no shake: fades and the glyph resolve only', () => {
    const T = REVEAL_TIMING.reduced;
    expect(T.total).toBeLessThan(REVEAL_TIMING.full.total);
    for (let ms = 0; ms <= T.total; ms += 25) {
      const f = revealTimeline(ms, true);
      expect(f.flyer.p).toBe(0);
      expect(f.flyer.scale).toBe(1);
      expect(f.flyer.blur).toBe(0);
      expect(f.name.scale).toBe(1);
      expect(f.name.blur).toBe(0);
      expect(f.welcome.dy).toBe(0);
    }
  });
});

describe('the login destination: Sol, Haven Guild station, hangar', () => {
  it('ADMIN_HOME is the real Sol (the Milky Way gateway) and resolves only inside a session', () => {
    expect(ADMIN_HOME).toEqual({ galaxy: 'milky-way', system: 'milky-way/sol', arrival: 'station' });
    const sol = graph.system('milky-way/sol')!;
    expect(sol.name).toBe('Sol');
    expect(normal.current).toBe('milky-way');
    expect(normal.system).toBe('milky-way/sol');
    const s = beginAdmin(STARTER_FLEET, normal, 'title');
    const d = resolveDestination(s, graph, ADMIN_HOME);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.system.id).toBe('milky-way/sol');
    expect(resolveDestination(null, graph, ADMIN_HOME).ok).toBe(false);
  });

  it("Sol's station is the Haven Guild station (there is no 'Sol Base Station'); the arrival docks there at once", () => {
    const sol = graph.system('milky-way/sol')!;
    const L = generateSector(sol, sectorContext(graph, sol.id));
    const stations = L.pois.filter((p) => p.kind === 'station');
    expect(stations.map((p) => [p.id, p.label])).toEqual([['station', 'Haven Guild station']]);
    const at = stationApproach(L)!;
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { spawn: 'arrival', at, seed: 1, phase: 'flight' });
    const ev = dockIfInRange(run);
    expect(ev.map((e) => e.type)).toContain('docked');
    expect(run.docked).not.toBeNull();
    expect(dockIfInRange(run)).toEqual([]); // already docked: nothing twice
  });

  it('dockIfInRange does nothing away from a station', () => {
    const sol = graph.system('milky-way/sol')!;
    const L = generateSector(sol, sectorContext(graph, sol.id));
    const run = createSectorRun(L, EMPTY_SECTOR_SAVE, { spawn: 'arrival', seed: 1, phase: 'flight' });
    const st = L.pois.find((p) => p.kind === 'station')!;
    const far = { x: st.x > L.width / 2 ? 200 : L.width - 200, y: st.y > L.height / 2 ? 200 : L.height - 200 };
    Object.assign(run.ship, { ...far, px: far.x, py: far.y });
    expect(dockIfInRange(run)).toEqual([]);
    expect(run.docked).toBeNull();
  });
});

describe('admin sandbox ammunition (unlimited, admin session only)', () => {
  const NONE: SectorInput = { moveX: 0, moveY: 0 };
  const FIRE: SectorInput = { moveX: 0, moveY: 0, fire: true };
  const NEXT: SectorInput = { moveX: 0, moveY: 0, cycle: 1 };
  const ALL = { compatible: ['plasma', 'lock-missile', 'heavy-missile', 'nuke'], rotation: ['plasma', 'lock-missile', 'heavy-missile', 'nuke'], start: 'plasma' } as const;
  const LIGHT = { compatible: ['plasma', 'lock-missile'], rotation: ['plasma', 'lock-missile'], start: 'plasma' } as const;
  function setup(loadout: typeof ALL | typeof LIGHT, unlimited: boolean, ordnance: Record<string, number> = { 'heavy-missile': 1, nuke: 0 }): SectorRun {
    const L = arena(1);
    const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 1, loadout, ordnance, unlimitedAmmo: unlimited });
    r.grace = 100_000;
    Object.assign(r.ship, { x: L.width / 2, y: L.height / 2, px: L.width / 2, py: L.height / 2, vx: 0, vy: 0, heading: 0 });
    return r;
  }
  const step = (r: SectorRun, n: number, input: SectorInput = NONE): SectorEvent[] => {
    const out: SectorEvent[] = [];
    for (let i = 0; i < n; i++) out.push(...stepSector(r, input));
    return out;
  };
  const select = (r: SectorRun, id: string): void => {
    for (let i = 0; i < 4 && r.arsenal.selected !== id; i++) step(r, 1, NEXT);
    expect(r.arsenal.selected).toBe(id);
  };
  const press = (r: SectorRun): SectorEvent[] => [...step(r, 1), ...step(r, 1, FIRE)];

  it('only an admin session switches it on', () => {
    expect(unlimitedAmmo(null)).toBe(false);
    expect(unlimitedAmmo(beginAdmin(STARTER_FLEET, normal, 'map'))).toBe(true);
    expect(setup(ALL, false).unlimitedAmmo).toBe(false);
  });

  it('stock never runs down, nothing is reported for saving, the cooldown still gates', () => {
    const r = setup(ALL, true, { 'heavy-missile': 0, nuke: 0 });
    select(r, 'heavy-missile');
    expect(gateOf(r, 'heavy-missile')).toBe('ok'); // an empty magazine still fires in the sandbox
    for (let k = 0; k < 3; k++) {
      const ev = press(r);
      expect(ev.filter((e) => e.type === 'missileLaunched').length).toBe(1);
      expect(ev.some((e) => e.type === 'ordnanceSpent')).toBe(false);
      expect(r.ammo['heavy-missile']).toBe(0); // the count itself is untouched (never written back)
      expect(gateOf(r, 'heavy-missile')).toBe('cooling');
      const w = WEAPON_BY_ID.get('heavy-missile')!;
      step(r, (w.fire === 'ordnance' ? w.cooldownTicks : 0) + 2);
      r.missiles.length = 0;
    }
  });

  it('the lock-on needs no energy; mounts still decide what can fire', () => {
    const r = setup(LIGHT, true);
    r.energy = 0;
    expect(gateOf(r, 'lock-missile')).toBe('ok');
    expect(gateOf(r, 'heavy-missile')).toBe('unavailable'); // not fitted on this ship: unchanged
    expect(gateOf(r, 'nuke')).toBe('unavailable');
    const normalRun = setup(LIGHT, false);
    normalRun.energy = 0;
    expect(gateOf(normalRun, 'lock-missile')).toBe('lowEnergy');
  });

  it('normal play is unchanged: a launch spends a round and reports it', () => {
    const r = setup(ALL, false, { 'heavy-missile': 1, nuke: 0 });
    select(r, 'heavy-missile');
    const ev = press(r);
    expect(ev.find((e) => e.type === 'ordnanceSpent')).toMatchObject({ weapon: 'heavy-missile', left: 0 });
    expect(r.ammo['heavy-missile']).toBe(0);
  });

  it('setRunUnlimitedAmmo switches a running sector; the HUD reads ∞ and says unlimited', () => {
    const r = setup(ALL, false);
    setRunUnlimitedAmmo(r, true);
    expect(r.unlimitedAmmo).toBe(true);
    const base = { label: 'HEAVY', feed: 'stock', state: 'ready', stock: 0, capacity: 4, gate: 'ok', lock: 0, lockTicks: 0, cooldown: 0, cooldownTicks: 300, inFlight: false, notice: null } as const;
    expect(missileGauge({ ...base, unlimited: true }, false)).toMatchObject({ gauge: { pct: 100, text: '\u221e', low: false }, state: 'ready' });
    expect(missileGauge({ ...base }, false).gauge.text).toBe('EMPTY');
    // the cooldown is still shown in the sandbox
    expect(missileGauge({ ...base, unlimited: true, state: 'cooldown', cooldown: 120 }, false).state).toBe('cooldown');
    const card = shipCard({ ship: 'Condor', weapon: 'Heavy', shield: 1, shieldMax: 1, hull: 1, hullMax: 1, energy: 1, energyMax: 1, docked: false, firing: false, missile: { ...base, unlimited: true } } as Parameters<typeof shipCard>[0]);
    expect(card.label).toMatch(/ammunition unlimited/);
  });
});
