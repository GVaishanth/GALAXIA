/**
 * Free Roam combat (Prompt 9): weapons, projectiles, damage, AI states,
 * encounters, hazards, caps, cleanup, defeat and persistence. Every run uses a
 * fixed seed, so each scenario replays identically.
 */
import { describe, expect, it } from 'vitest';
import { CAMERA, cameraZoom, stepFraming } from '../src/modes/freeroam/camera.ts';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { FACTION_IDS } from '../src/modes/freeroam/catalogue/types.ts';
import { spawnAgent, stepAgents } from '../src/modes/freeroam/combat/ai.ts';
import { COMBAT, compositionFor, difficultyRow, groupThreat } from '../src/modes/freeroam/combat/difficulty.ts';
import { createEncounters } from '../src/modes/freeroam/combat/encounters.ts';
import { FACTIONS, isHostile, RELATIONS, type Side } from '../src/modes/freeroam/combat/factions.ts';
import { CAPITAL_LAUNCH_TOTAL, FAMILIES, FAMILY_IDS, type FamilyId } from '../src/modes/freeroam/combat/families.ts';
import { eruptionAt } from '../src/modes/freeroam/combat/hazards.ts';
import { combatHud } from '../src/modes/freeroam/combat/hudModel.ts';
import { dropMine, spawnShot, stepBeam, stepEnemyShots, stepMines } from '../src/modes/freeroam/combat/projectiles.ts';
import { AI_STATES, type Agent, type AiState } from '../src/modes/freeroam/combat/state.ts';
import { WEAPONS } from '../src/modes/freeroam/combat/weapons.ts';
import { damageAgent, damagePlayer } from '../src/modes/freeroam/combat/world.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { addCargo, dropCargo, EMPTY_PROFILE, FREEROAM_VERSION, loadProfile, lostCargoUnits, recoverCargo, saveProfile, withSectorProgress } from '../src/modes/freeroam/profile.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type EncounterSite, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, disposeSectorRun, inCombat, restartSector, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const graph = buildNavGraph();
const ALL: readonly SectorLayout[] = getCatalogue().systems.map((s) => generateSector(s, sectorContext(graph, s.id)));
const SURVEYED = { ...EMPTY_SECTOR_SAVE, surveyed: true };
const idle: SectorInput = { moveX: 0, moveY: 0 };
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

/** A cleared copy of a sector of difficulty `d` (no solids, patrols, sites, hazards or POIs but the exit). */
function arena(d = 3): SectorLayout {
  const L = ALL.find((x) => x.difficulty === d)!;
  return { ...L, rocks: [], landmarks: [], regions: [], patrols: [], sites: [], hazards: [], pois: L.pois.filter((p) => p.kind === 'exit') };
}
/** The point (inset 700) farthest from the arrival zone. */
function spot(L: SectorLayout): { x: number; y: number } {
  const c = [
    { x: 700, y: 700 },
    { x: L.width - 700, y: 700 },
    { x: 700, y: L.height - 700 },
    { x: L.width - 700, y: L.height - 700 },
  ];
  return c.sort((a, b) => dist(b, L.arrival) - dist(a, L.arrival))[0]!;
}
/** A run past its arrival grace (unless `grace` is kept). */
function fight(L: SectorLayout, seed = 1, grace = false): SectorRun {
  const r = createSectorRun(L, SURVEYED, { seed });
  if (!grace) r.grace = 0;
  return r;
}
const hold = (r: SectorRun, p: { x: number; y: number }): void => {
  Object.assign(r.ship, { x: p.x, y: p.y, px: p.x, py: p.y, vx: 0, vy: 0 });
};
/** Step with the pilot pinned at `p`; optional per-tick hook. Returns every event. */
function run(r: SectorRun, ticks: number, p: { x: number; y: number } | null, each?: (t: number) => void, input: SectorInput = idle): SectorEvent[] {
  const out: SectorEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    if (p) hold(r, p);
    each?.(t);
    out.push(...stepSector(r, input));
  }
  return out;
}
const spawn = (r: SectorRun, family: FamilyId, x: number, y: number, faction: (typeof FACTION_IDS)[number] = 'red-tally', role: Agent['role'] = 'guard'): Agent => {
  const a = spawnAgent(r, family, faction, 'test', role, x, y);
  if (!a) throw new Error('spawn refused');
  return a;
};
/** A layout keeping exactly one site of `kind` (and the POIs it needs), without patrols, hazards and other sites. */
function siteLayout(kind: EncounterSite['kind'], minD = 1): { L: SectorLayout; s: EncounterSite } {
  for (const L of ALL) {
    if (L.difficulty < minD) continue;
    const s = L.sites.find((x) => x.kind === kind);
    if (s) return { L: { ...L, patrols: [], hazards: [], sites: [s], landmarks: [], regions: [] }, s };
  }
  throw new Error(`no ${kind} site`);
}
const of = <T extends SectorEvent['type']>(ev: readonly SectorEvent[], type: T): Extract<SectorEvent, { type: T }>[] => ev.filter((e): e is Extract<SectorEvent, { type: T }> => e.type === type);

/* ------------------------------------------------------------ weapons */
describe('enemy weapons and cooldowns', () => {
  it('a ship fires no faster than its cooldown (scaled by the region), with seeded spacing', () => {
    for (const family of ['raider', 'picket'] as const) {
      const L = arena(3);
      const P = spot(L);
      const fired: number[] = [];
      const r2 = fight(L, 11);
      const b = spawn(r2, family, P.x + 260, P.y);
      r2.invuln = 1e9;
      for (let t = 0; t < 1800; t++) {
        hold(r2, P);
        for (const e of stepSector(r2, idle)) if (e.type === 'enemyFired' && e.hostile === b.id) fired.push(t);
      }
      const w = WEAPONS[FAMILIES[family].weapons[0]!];
      const min = Math.floor(w.cooldown * r2.row.cooldown * 0.9);
      expect(fired.length, family).toBeGreaterThan(2);
      for (let i = 1; i < fired.length; i++) expect(fired[i]! - fired[i - 1]!, family).toBeGreaterThanOrEqual(min);
      expect(b.family).toBe(family);
    }
  });

  it('nothing fires and no ambush triggers during the arrival grace', () => {
    const L = arena(5);
    const r = fight(L, 12, true);
    expect(r.grace).toBe(difficultyRow(5).grace);
    const P = spot(L);
    for (const f of ['raider', 'lancer', 'heavy', 'elite'] as const) spawn(r, f, P.x + 200 + FAMILY_IDS.indexOf(f) * 30, P.y + 40);
    const ev = run(r, difficultyRow(5).grace - 1, P);
    expect(of(ev, 'enemyFired')).toHaveLength(0);
    expect(of(ev, 'telegraph')).toHaveLength(0);
    expect(r.enemyShots).toHaveLength(0);
    expect(of(ev, 'hit').filter((e) => e.source === 'fire')).toHaveLength(0);
    // after the grace the same ships open fire
    expect(of(run(r, 400, P), 'enemyFired').length).toBeGreaterThan(0);
  });

  it('heavy attacks are telegraphed before they land (windup >= 24 ticks) and aimed shots stay locked', () => {
    for (const id of ['cannon', 'flak', 'missile', 'beam', 'broadside', 'launch'] as const) {
      expect(WEAPONS[id].windup, id).toBeGreaterThanOrEqual(24);
      expect(WEAPONS[id].telegraph, id).not.toBe('none');
    }
    const L = arena(4);
    const r = fight(L, 13);
    const P = spot(L);
    const h = spawn(r, 'heavy', P.x + 300, P.y);
    let seen = false;
    for (let t = 0; t < 1200 && !seen; t++) {
      hold(r, P);
      r.shield = r.craft.stats.shield;
      r.hull = r.craft.stats.hull;
      for (const e of stepSector(r, idle)) {
        if (e.type === 'telegraph' && e.hostile === h.id) {
          seen = true;
          const angle = h.windup!.angle;
          // the pilot moves; a locked (non-missile) shot keeps its angle until release
          hold(r, { x: P.x, y: P.y + 150 });
          stepSector(r, idle);
          if (h.windup) expect(h.windup.angle).toBe(angle);
        }
      }
    }
    expect(seen).toBe(true);
  });
});

/* -------------------------------------------------------- projectiles */
describe('projectiles: movement, collision and lifetime', () => {
  it('a fast shot hits the pilot by swept collision exactly once and is spent', () => {
    const L = arena(3);
    const r = fight(L, 21);
    const P = spot(L);
    hold(r, P);
    const a = spawn(r, 'raider', P.x + 400, P.y, 'red-tally');
    // 3000 px/s = 50 px per tick: more than the ship's diameter, so only a swept test can catch it
    r.enemyShots.push({ id: 999, owner: a.id, faction: 'red-tally', weapon: 'spark', kind: 'bolt', x: P.x + 60, y: P.y, px: P.x + 60, py: P.y, vx: -3000, vy: 0, life: 60, damage: 7, radius: 3, target: null, hp: 0 });
    const ev: SectorEvent[] = [];
    const shield = r.shield;
    for (let t = 0; t < 5; t++) stepEnemyShots(r, ev);
    expect(of(ev, 'hit')).toHaveLength(1);
    expect(r.shield).toBeCloseTo(shield - 7, 6);
    expect(r.enemyShots.find((s) => s.id === 999)).toBeUndefined();
  });

  it('shield hits grant no invulnerability; hull hits grant a short one; a shot absorbed by invulnerability is still spent', () => {
    const L = arena(3);
    const r = fight(L, 22);
    const P = spot(L);
    hold(r, P);
    const ev: SectorEvent[] = [];
    expect(damagePlayer(r, 5, 'fire', ev)).toBe(5);
    expect(r.invuln).toBe(0);
    r.shield = 0;
    expect(damagePlayer(r, 5, 'fire', ev)).toBe(5);
    expect(r.invuln).toBe(COMBAT.hitInvulnTicks);
    const hull = r.hull;
    expect(damagePlayer(r, 5, 'fire', ev)).toBe(0);
    expect(r.hull).toBe(hull);
    const a = spawn(r, 'raider', P.x + 400, P.y);
    r.enemyShots.push({ id: 5, owner: a.id, faction: 'red-tally', weapon: 'spark', kind: 'bolt', x: P.x + 20, y: P.y, px: P.x + 20, py: P.y, vx: -600, vy: 0, life: 60, damage: 5, radius: 3, target: null, hp: 0 });
    stepEnemyShots(r, ev);
    expect(r.enemyShots).toHaveLength(0);
    expect(r.hull).toBe(hull);
  });

  it('the shot pool is capped, every shot expires within its life cap, and shots stop at rocks', () => {
    const L = arena(3);
    const r = fight(L, 23);
    const P = spot(L);
    hold(r, { x: P.x - 1500, y: P.y });
    const a = spawn(r, 'raider', P.x, P.y);
    let ok = 0;
    for (let i = 0; i < 120; i++) if (spawnShot(r, a, 'spark', (i / 120) * Math.PI * 2)) ok += 1;
    expect(ok).toBe(COMBAT.maxShots);
    expect(r.enemyShots.length).toBe(COMBAT.maxShots);
    for (const s of r.enemyShots) expect(s.life).toBeLessThanOrEqual(COMBAT.maxShotLife);
    const ev: SectorEvent[] = [];
    for (let t = 0; t < COMBAT.maxShotLife && r.enemyShots.length; t++) stepEnemyShots(r, ev);
    expect(r.enemyShots).toHaveLength(0);
    // a rock between shooter and pilot stops the shot
    const rock = { x: P.x - 150, y: P.y, r: 30, field: 'field-1', shape: 1 };
    const L2: SectorLayout = { ...L, rocks: [rock] };
    const r2 = fight(L2, 24);
    hold(r2, { x: P.x - 300, y: P.y });
    const b = spawn(r2, 'raider', P.x, P.y);
    spawnShot(r2, b, 'spark', Math.PI);
    const ev2: SectorEvent[] = [];
    for (let t = 0; t < 90; t++) stepEnemyShots(r2, ev2);
    expect(of(ev2, 'hit')).toHaveLength(0);
    expect(r2.enemyShots).toHaveLength(0);
  });

  it('a sweep beam damages each target at most once per firing', () => {
    const L = arena(4);
    const r = fight(L, 25);
    const P = spot(L);
    hold(r, P);
    const c = spawn(r, 'capital', P.x + 300, P.y, 'tessellate', 'boss');
    const angle = Math.atan2(P.y - c.y, P.x - c.x);
    c.beam = { start: angle, sweep: 0, ticks: 0, total: 24, angle, hit: new Set() };
    const ev: SectorEvent[] = [];
    for (let t = 0; t < 24; t++) {
      r.invuln = 0; // even without invulnerability: once per firing
      stepBeam(r, c, ev);
    }
    expect(of(ev, 'hit')).toHaveLength(1);
    expect(c.beam).toBeNull();
  });

  it('missiles home, can be shot down by a bolt, and expire', () => {
    const L = arena(4);
    const r = fight(L, 26);
    const P = spot(L);
    hold(r, P);
    const e = spawn(r, 'elite', P.x + 500, P.y, 'cordon', 'boss');
    expect(spawnShot(r, e, 'missile', -Math.PI / 2, 0, 'player')).toBe(true); // launched sideways
    const m = r.enemyShots[0]!;
    const ev: SectorEvent[] = [];
    for (let t = 0; t < 30; t++) stepEnemyShots(r, ev);
    expect(m.vx).toBeLessThan(0); // turned toward the pilot
    // a pilot bolt aimed at the missile shoots it down (one impact)
    r.shots.push({ id: 1, x: m.x + 20, y: m.y, px: m.x + 20, py: m.y, vx: -700, vy: 0, life: 30, damage: 1 });
    r.enemyShots.length = 1;
    const out: SectorEvent[] = [];
    hold(r, P);
    out.push(...stepSector(r, idle));
    expect(of(out, 'shotDown').length + (r.enemyShots.length === 0 ? 0 : 1)).toBeGreaterThanOrEqual(1);
    expect(r.enemyShots.filter((s) => s.kind === 'missile')).toHaveLength(0);
    expect(r.shots).toHaveLength(0);
    expect(WEAPONS.missile.life).toBeLessThanOrEqual(COMBAT.maxShotLife);
  });

  it('mines arm, blink (telegraph) when triggered, detonate once, and dropped mines expire', () => {
    const L = arena(3);
    const r = fight(L, 27);
    const P = spot(L);
    hold(r, P);
    r.mines.push({ id: 1, x: P.x + 60, y: P.y, faction: 'red-tally', owner: 'minefield-1', arm: 0, fuse: -1, life: Infinity });
    const ev: SectorEvent[] = [];
    stepMines(r, ev);
    expect(of(ev, 'telegraph').map((e) => e.weapon)).toEqual(['mine']);
    for (let t = 0; t < WEAPONS.mine.fuse + 2; t++) stepMines(r, ev);
    expect(of(ev, 'blast')).toHaveLength(1);
    expect(of(ev, 'hit').filter((e) => e.source === 'mine')).toHaveLength(1);
    expect(r.mines).toHaveLength(0);
    // a dropped mine expires after its life cap, untouched
    const a = spawn(r, 'hauler', P.x - 1200, P.y);
    expect(dropMine(r, a)).toBe(true);
    for (let t = 0; t <= COMBAT.maxMineLife; t++) stepMines(r, []);
    expect(r.mines).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- damage */
describe('damage rules', () => {
  it('shield absorbs first; NPC fire deals half; a destroyed ship is destroyed exactly once', () => {
    const L = arena(3);
    const r = fight(L, 31);
    const P = spot(L);
    hold(r, { x: P.x - 1000, y: P.y });
    const a = spawn(r, 'picket', P.x, P.y, 'cordon');
    const ev: SectorEvent[] = [];
    damageAgent(r, a, 10, 'player', ev);
    expect([a.shield, a.hull]).toEqual([5, 30]);
    damageAgent(r, a, 10, 'red-tally', ev); // infighting: 5 effective
    expect([a.shield, a.hull]).toEqual([0, 30]);
    expect(damageAgent(r, a, 1000, 'player', ev)).toBe(true);
    expect(damageAgent(r, a, 1000, 'player', ev)).toBe(false);
    expect(of(ev, 'destroyed')).toHaveLength(1);
    expect(r.kills).toBe(1);
    expect(damageAgent(r, a, 5, 'player', ev)).toBe(false);
    expect(ev.filter((e) => e.type === 'struck' || e.type === 'destroyed')).toHaveLength(3);
    // ignore junk amounts
    const b = spawn(r, 'raider', P.x, P.y + 100);
    damageAgent(r, b, Number.NaN, 'player', ev);
    damageAgent(r, b, -5, 'player', ev);
    expect(b.hull).toBe(FAMILIES.raider.hull);
  });

  it('a pilot bolt damages only the first ship it touches (once per impact)', () => {
    const L = arena(3);
    const r = fight(L, 32);
    const P = spot(L);
    hold(r, P);
    r.ship.heading = Math.PI / 2; // nose +x
    // two wary scavengers in a line ahead: they hold position until provoked
    const a = spawn(r, 'picket', P.x + 90, P.y, 'gleaners', 'guard');
    const b = spawn(r, 'picket', P.x + 125, P.y, 'gleaners', 'guard');
    const ev = run(r, 1, P, undefined, { moveX: 0, moveY: 0, fire: true });
    ev.push(...run(r, 20, P));
    const hits = ev.filter((e) => (e.type === 'struck' || e.type === 'destroyed') && e.by === 'player');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.type === 'struck' && hits[0]!.hostile).toBe(a.id);
    expect(b.shield).toBe(FAMILIES.picket.shield);
    // shooting the scavengers provokes them
    expect(r.provoked.has('gleaners')).toBe(true);
    expect(of(ev, 'provoked')).toEqual([{ type: 'provoked', faction: 'gleaners', why: 'shot' }]);
  });

  it('no AI state is invulnerable: damage applies in every live state', () => {
    const L = arena(3);
    const r = fight(L, 33);
    const P = spot(L);
    hold(r, { x: P.x - 1000, y: P.y });
    for (const s of AI_STATES) {
      if (s === 'destroyed') continue;
      const a = spawn(r, 'heavy', P.x, P.y + AI_STATES.indexOf(s) * 40);
      a.state = s;
      const before = a.hull + a.shield;
      damageAgent(r, a, 10, 'player', []);
      expect(a.hull + a.shield, s).toBe(before - 10);
      expect(damageAgent(r, a, 1e6, 'player', []), s).toBe(true);
      expect(a.state).toBe('destroyed');
    }
  });
});

/* ----------------------------------------------------------------- AI */
describe('enemy AI states', () => {
  /** States a ship goes through, run-length compressed. */
  const trail = (states: AiState[]): AiState[] => states.filter((s, i) => i === 0 || states[i - 1] !== s);

  it('idle -> pursue -> attack; hurt -> retreat once; a retreater far away escapes', () => {
    const L = arena(3);
    const r = fight(L, 41);
    const P = spot(L);
    const a = spawn(r, 'picket', P.x + 420, P.y);
    r.invuln = 1e9;
    const seen: AiState[] = [a.state];
    run(r, 240, P, () => seen.push(a.state));
    expect(trail(seen).slice(0, 3)).toEqual(['idle', 'pursue', 'attack']);
    damageAgent(r, a, a.shield + a.hull * 0.85, 'player', []);
    run(r, 2, P);
    expect(a.state).toBe('retreat');
    expect(a.retreatUsed).toBe(true);
    // it does not retreat a second time while hurt
    const after: AiState[] = [];
    run(r, 900, P, () => after.push(a.state));
    const retreats = trail(after).filter((s) => s === 'retreat').length;
    expect(retreats).toBeLessThanOrEqual(1);
    // a retreating ship far from the pilot escapes (removed with an event)
    a.state = 'retreat';
    a.stateTicks = 0;
    const ev: SectorEvent[] = [];
    hold(r, { x: a.x - COMBAT.sleepRadius - 50, y: a.y });
    stepAgents(r, ev);
    expect(of(ev, 'escaped').map((e) => e.hostile)).toEqual([a.id]);
    expect(r.hostiles).not.toContain(a);
  });

  it('shot by an unseen pilot: investigate the shot, then give up and return to its post', () => {
    const L = arena(3);
    const r = fight(L, 42);
    const P = spot(L);
    const a = spawn(r, 'raider', P.x + 900, P.y); // beyond its sight (420)
    hold(r, P);
    damageAgent(r, a, 1, 'player', []);
    expect(a.state).toBe('investigate');
    const far = { x: P.x, y: P.y + 2600 > L.height - 100 ? P.y - 2600 : P.y + 2600 };
    const seen: AiState[] = [];
    run(r, 900, far, () => seen.push(a.state));
    expect(trail(seen)).toContain('idle');
    expect(dist(a, { x: a.homeX, y: a.homeY })).toBeLessThan(400);
  });

  it('disabled once at its threshold: drifts, stays damageable and always recovers', () => {
    const L = arena(3);
    const r = fight(L, 43);
    const P = spot(L);
    hold(r, P);
    const h = spawn(r, 'heavy', P.x + 700, P.y);
    const ev: SectorEvent[] = [];
    damageAgent(r, h, h.shield + h.hull * 0.9, 'player', ev);
    expect(h.state).toBe('disabled');
    expect(of(ev, 'disabled')).toHaveLength(1);
    const hull = h.hull;
    damageAgent(r, h, 1, 'player', ev);
    expect(h.hull).toBe(hull - 1);
    r.invuln = 1e9;
    run(r, FAMILIES.heavy.disableTicks + 2, P);
    expect(h.state).not.toBe('disabled');
    damageAgent(r, h, 1, 'player', ev);
    expect(of(ev, 'disabled')).toHaveLength(1); // never twice
  });

  it('interceptors charge through and break off (evade), then come round again', () => {
    const L = arena(3);
    const r = fight(L, 44);
    const P = spot(L);
    const a = spawn(r, 'lancer', P.x + 450, P.y);
    r.invuln = 1e9;
    const seen: AiState[] = [];
    run(r, 900, P, () => seen.push(a.state));
    const t = trail(seen);
    expect(t).toContain('evade');
    expect(t.lastIndexOf('attack')).toBeGreaterThan(t.indexOf('evade'));
  });

  it('families fight differently: range kept and speed differ by role', () => {
    const L = arena(4);
    const keep: Record<string, number> = {};
    for (const f of ['raider', 'picket', 'lancer', 'heavy', 'recon', 'hauler'] as const) {
      const r = fight(L, 45);
      const P = spot(L);
      const a = spawn(r, f, P.x + 380, P.y);
      r.invuln = 1e9;
      let sum = 0;
      let n = 0;
      run(r, 900, P, (t) => {
        if (t > 200 && a.state !== 'destroyed') {
          sum += dist(a, P);
          n += 1;
        }
      });
      keep[f] = sum / Math.max(1, n);
    }
    expect(keep.recon!).toBeGreaterThan(keep.heavy!);
    expect(keep.heavy!).toBeGreaterThan(keep.raider!);
    expect(new Set(Object.values(keep).map((x) => Math.round(x / 25))).size).toBeGreaterThanOrEqual(4);
  });

  it('seeded variation is reproducible; different seeds and ships vary', () => {
    const L = arena(3);
    const P = spot(L);
    const sim = (seed: number): string => {
      const r = fight(L, seed);
      spawn(r, 'raider', P.x + 300, P.y);
      spawn(r, 'raider', P.x - 300, P.y);
      r.invuln = 1e9;
      run(r, 600, P);
      return r.hostiles.map((h) => `${h.x.toFixed(3)},${h.y.toFixed(3)},${h.state}`).join('|');
    };
    expect(sim(7)).toBe(sim(7));
    expect(sim(7)).not.toBe(sim(8));
    const r = fight(L, 9);
    const a = spawn(r, 'raider', P.x, P.y);
    const b = spawn(r, 'raider', P.x, P.y + 50);
    expect(a.trait).not.toBe(b.trait);
  });

  it('a recon ship that keeps the pilot in sight calls its idle allies once', () => {
    const L = arena(3);
    const r = fight(L, 46);
    const P = spot(L);
    const rc = spawn(r, 'recon', P.x + 600, P.y, 'cordon');
    const ally = spawn(r, 'picket', P.x + 1300, P.y, 'cordon');
    r.invuln = 1e9;
    const ev = run(r, 300, P);
    const calls = of(ev, 'reinforcements').filter((e) => e.source === 'test');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.count).toBeGreaterThanOrEqual(1);
    expect(rc.called).toBe(true);
    expect(['investigate', 'pursue', 'attack', 'evade']).toContain(ally.state);
  });
});

/* ------------------------------------------------------- relationships */
describe('faction relationships and infighting', () => {
  const sides: Side[] = ['player', ...FACTION_IDS];

  it('the matrix is complete and symmetric; scavengers are wary of the pilot until provoked', () => {
    for (const a of sides) for (const b of sides) expect(RELATIONS[a][b], `${a}/${b}`).toBe(RELATIONS[b][a]);
    expect(isHostile('gleaners', 'player', new Set())).toBe(false);
    expect(isHostile('gleaners', 'player', new Set(['gleaners']))).toBe(true);
    expect(isHostile('cordon', 'gleaners', new Set())).toBe(false);
    expect(isHostile('red-tally', 'gleaners', new Set())).toBe(true);
    expect(isHostile('haven-guild', 'player', new Set())).toBe(false);
    for (const f of FACTION_IDS) expect(FACTIONS[f].name).not.toMatch(/ashen|syndicate|loom|empire|federation|alliance/i);
  });

  it('infighting is real but capped, and NPC kills credit nobody', () => {
    const L = arena(5);
    const r = fight(L, 51);
    const P = spot(L);
    for (let i = 0; i < 6; i++) spawn(r, 'raider', P.x + 1200 + i * 30, P.y + 1000, 'red-tally', 'guard');
    for (let i = 0; i < 6; i++) spawn(r, 'raider', P.x + 1200 + i * 30, P.y + 1200, 'cordon', 'guard');
    hold(r, { x: P.x - 600, y: P.y - 600 });
    let peak = 0;
    const ev = run(r, 900, { x: P.x - 600, y: P.y - 600 }, () => {
      peak = Math.max(peak, r.hostiles.filter((h) => typeof h.target === 'number').length);
    });
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(COMBAT.maxInfighters);
    expect(r.kills).toBe(0);
    for (const e of of(ev, 'destroyed')) expect(e.by).toBe('npc');
  });
});

/* --------------------------------------------------------- encounters */
describe('encounters', () => {
  it('ambush: telegraphed warp-ins after the grace, cleared once with its loot, never again', () => {
    const { L, s } = siteLayout('ambush');
    const r = createSectorRun(L, SURVEYED, { seed: 61 });
    // inside the trigger during the grace: nothing happens
    expect(of(run(r, 10, s), 'encounter')).toHaveLength(0);
    r.grace = 0;
    r.invuln = 1e9;
    const warn = run(r, 1, s);
    expect(of(warn, 'encounter').map((e) => e.state)).toEqual(['warning']);
    expect(r.pending.length).toBeGreaterThan(0);
    expect(r.pending.length).toBeLessThanOrEqual(COMBAT.maxPending);
    expect(combatHud(r).banner?.text).toMatch(/AMBUSH/);
    for (const p of r.pending) expect(dist(p, s)).toBeGreaterThan(200); // a ring around the pilot, not on top
    run(r, COMBAT.ambushWarnTicks + 1, s);
    expect(r.pending).toHaveLength(0);
    const ships = r.hostiles.filter((h) => h.source === s.id);
    expect(ships.length).toBeGreaterThan(0);
    // the pilot destroys them
    const ev = run(r, 3, s, () => {
      for (const h of r.hostiles.filter((x) => x.source === s.id)) damageAgent(r, h, 1e6, 'player', []);
    });
    const done = of(ev, 'encounter').filter((e) => e.state === 'cleared');
    expect(done).toHaveLength(1);
    expect(done[0]!.loot).toEqual(s.loot);
    expect(r.done.has(s.id)).toBe(true);
    expect(of(run(r, 300, s), 'encounter')).toHaveLength(0);
  });

  it('ambush refused entirely at the active cap resets instead of paying', () => {
    const { L, s } = siteLayout('ambush');
    const r = createSectorRun(L, SURVEYED, { seed: 62 });
    r.grace = 0;
    const far = { x: s.x < L.width / 2 ? L.width - 300 : 300, y: s.y < L.height / 2 ? L.height - 300 : 300 };
    for (let i = 0; i < r.row.maxActive; i++) spawn(r, 'raider', far.x, far.y + i * 2, 'gleaners', 'guard');
    expect(spawnAgent(r, 'raider', 'red-tally', 'x', 'wave', far.x, far.y)).toBeNull();
    const ev = run(r, COMBAT.ambushWarnTicks + 10, s);
    expect(of(ev, 'encounter').some((e) => e.state === 'cleared')).toBe(false);
    expect(r.done.has(s.id)).toBe(false);
  });

  it('wreck defence: fails (no pay) when cargo raiders strip the wreck; a recall lets the pilot retry; holding pays once', () => {
    const { L, s } = siteLayout('defence');
    const wreck = L.pois.find((p) => p.id === s.anchor)!;
    const r = createSectorRun(L, SURVEYED, { seed: 63 });
    r.grace = 0;
    r.invuln = 1e9;
    // trigger it, then hang back (inside the leash, outside the hold radius) so the raiders get to the wreck
    run(r, 1, { x: s.x, y: s.y });
    const back = { x: wreck.x + (wreck.x > L.width / 2 ? -1 : 1) * 1000, y: wreck.y };
    let ev: SectorEvent[] = [];
    for (let t = 0; t < 6000 && !ev.some((e) => e.type === 'encounter' && e.state === 'failed'); t++) {
      ev = ev.concat(run(r, 1, back));
      // keep the haulers at the wreck (as if the pilot never interfered)
      for (const h of r.hostiles) if (h.source === s.id && h.family === 'hauler') Object.assign(h, { x: wreck.x + 30, y: wreck.y, vx: 0, vy: 0 });
    }
    expect(of(ev, 'encounter').filter((e) => e.state === 'failed')).toHaveLength(1);
    expect(of(ev, 'encounter').some((e) => e.state === 'cleared')).toBe(false);
    expect(r.done.has(s.id)).toBe(false);
    // a death resets it (not paid); then holding next to the wreck (destroying the raiders) pays once
    r.hull = 0;
    run(r, 1, null);
    expect(r.encounters.find((e) => e.id === s.id)!.state).toBe('dormant');
    r.grace = 0;
    r.invuln = 1e9;
    let win: SectorEvent[] = [];
    for (let t = 0; t < 8000 && !r.done.has(s.id); t++) {
      win = win.concat(run(r, 1, { x: wreck.x + 40, y: wreck.y + 40 }));
      for (const h of r.hostiles.filter((x) => x.source === s.id)) damageAgent(r, h, 1e6, 'player', []);
    }
    const cleared = of(win, 'encounter').filter((e) => e.state === 'cleared');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.loot).toEqual(s.loot);
  });

  it('salvage dispute: scavengers leave a peaceful pilot alone; taking salvage provokes them; settling pays once', () => {
    const { L, s } = siteLayout('dispute');
    const r = createSectorRun({ ...L, sites: [{ ...s, factions: ['gleaners'] }] }, SURVEYED, { seed: 64 });
    r.grace = 0;
    r.invuln = 1e9;
    const near = { x: s.x + s.r * 0.5, y: s.y };
    const calm = run(r, 300, near);
    expect(r.hostiles.filter((h) => h.source === s.id).length).toBeGreaterThan(0);
    expect(r.hostiles.some((h) => h.target === 'player')).toBe(false);
    expect(of(calm, 'hit').filter((e) => e.source === 'fire')).toHaveLength(0);
    expect(of(calm, 'encounter').filter((e) => e.state === 'cleared')).toHaveLength(0);
    // fly through a salvage find of their claim
    const salvage = L.pois.find((p) => p.kind === 'salvage' && p.group === s.anchor)!;
    expect(salvage).toBeDefined();
    const ev = run(r, 2, salvage);
    expect(of(ev, 'provoked')).toEqual([{ type: 'provoked', faction: 'gleaners', why: 'claim' }]);
    expect(inCombat(r) || r.hostiles.some((h) => h.source === s.id)).toBe(true);
    const fightEv = run(r, 4, near, () => {
      for (const h of r.hostiles.filter((x) => x.source === s.id)) damageAgent(r, h, 1e6, 'player', []);
    });
    expect(of(fightEv, 'encounter').filter((e) => e.state === 'cleared')).toHaveLength(1);
    expect(of(run(r, 120, near), 'encounter')).toHaveLength(0);
  });

  it('elite and capital encounters are one-time: the boss never escapes, and stays defeated after re-entry', () => {
    for (const kind of ['elite', 'capital'] as const) {
      const { L, s } = siteLayout(kind, kind === 'capital' ? 4 : 3);
      const r = createSectorRun(L, SURVEYED, { seed: 65 });
      r.grace = 0;
      r.invuln = 1e9;
      const near = { x: s.x + 250, y: s.y };
      run(r, 3, near);
      const boss = r.hostiles.find((h) => h.source === s.id && h.role === 'boss')!;
      expect(boss.family).toBe(kind);
      // a hurt boss in retreat is never removed as escaped
      boss.state = 'retreat';
      const ev: SectorEvent[] = [];
      hold(r, { x: boss.x + COMBAT.sleepRadius + 100, y: boss.y });
      stepAgents(r, ev);
      expect(of(ev, 'escaped')).toHaveLength(0);
      expect(r.hostiles).toContain(boss);
      boss.state = 'attack';
      const kill = run(r, 3, near, () => {
        if (boss.state !== 'destroyed') damageAgent(r, boss, 1e6, 'player', []);
      });
      const cleared = of(kill, 'encounter').filter((e) => e.state === 'cleared');
      expect(cleared, kind).toHaveLength(1);
      expect(cleared[0]!.loot).toEqual(s.loot);
      // re-entry with the saved id: no boss, no encounter
      const again = createSectorRun(L, { done: [s.id], surveyed: true }, { seed: 66 });
      again.grace = 0;
      const ev2 = run(again, 120, near);
      expect(again.hostiles.filter((h) => h.source === s.id)).toHaveLength(0);
      expect(of(ev2, 'encounter')).toHaveLength(0);
    }
  });

  it('a capital ship enters phase two once and its launch bay is bounded', () => {
    const L = arena(5);
    const r = fight(L, 67);
    const P = spot(L);
    const c = spawn(r, 'capital', P.x + 420, P.y, 'tessellate', 'boss');
    r.invuln = 1e9;
    let launchedPeak = 0;
    const ev = run(r, 4000, P, (t) => {
      r.shield = r.craft.stats.shield;
      r.hull = r.craft.stats.hull;
      if (t === 100) damageAgent(r, c, c.shield + c.hull * 0.55, 'player', []);
      launchedPeak = Math.max(launchedPeak, r.hostiles.filter((h) => h.role === 'launched').length);
    });
    expect(of(ev, 'bossPhase')).toHaveLength(1);
    expect(launchedPeak).toBeGreaterThan(0);
    expect(launchedPeak).toBeLessThanOrEqual(WEAPONS.launch.maxLive);
    expect(c.launched).toBeLessThanOrEqual(CAPITAL_LAUNCH_TOTAL);
  });

  it('hazards: eruptions telegraph before every blast; sensor interference is reported', () => {
    const L = ALL.find((x) => x.hazards.some((h) => h.kind === 'eruption'))!;
    const z = L.hazards.find((h) => h.kind === 'eruption')!;
    let warned = false;
    let blasts = 0;
    let prevCycle = eruptionAt(z, 0).cycle;
    for (let t = 1; t < 2000; t++) {
      const e = eruptionAt(z, t);
      if (e.warn !== null) warned = true;
      if (e.cycle !== prevCycle) {
        expect(warned).toBe(true); // every blast had its warning first
        warned = false;
        blasts += 1;
        prevCycle = e.cycle;
      }
    }
    expect(blasts).toBeGreaterThan(3);
    const I = ALL.find((x) => x.hazards.some((h) => h.kind === 'interference'))!;
    const zi = I.hazards.find((h) => h.kind === 'interference')!;
    const r = createSectorRun({ ...I, patrols: [], sites: [] }, SURVEYED, { seed: 68 });
    hold(r, zi);
    expect(combatHud(r).banner?.text).toBe('SENSORS JAMMED');
  });
});

/* --------------------------------------------------------- generation */
describe('combat content generation', () => {
  it('every encounter and hazard kind appears, gated by difficulty, deterministic and validated', () => {
    const kinds = new Set<string>();
    for (const L of ALL) {
      for (const s of L.sites) {
        kinds.add(s.kind);
        if (s.kind === 'defence') expect(L.difficulty).toBeGreaterThanOrEqual(2);
        if (s.kind === 'elite') expect(L.difficulty).toBeGreaterThanOrEqual(3);
        if (s.kind === 'capital') expect(L.difficulty).toBeGreaterThanOrEqual(4);
        expect(dist(s, L.arrival)).toBeGreaterThan(L.arrival.r + 600); // never sprung at the arrival
      }
      L.sites.forEach((a, i) => L.sites.slice(i + 1).forEach((b) => expect(dist(a, b), `${L.systemId} ${a.id}/${b.id}`).toBeGreaterThanOrEqual(a.kind === 'elite' || a.kind === 'capital' || b.kind === 'elite' || b.kind === 'capital' ? 999 : 699)));
      for (const z of L.hazards) kinds.add(z.kind);
      expect(L.hazards.reduce((n, z) => n + z.mines.length, 0)).toBeLessThanOrEqual(24);
    }
    for (const k of ['ambush', 'defence', 'dispute', 'elite', 'capital', 'minefield', 'interference', 'eruption']) expect(kinds, k).toContain(k);
    const sys = getCatalogue().systems.find((x) => x.difficulty >= 4)!;
    const a = generateSector(sys, sectorContext(graph, sys.id));
    const b = generateSector(sys, sectorContext(graph, sys.id));
    expect(JSON.stringify(a.sites)).toBe(JSON.stringify(b.sites));
    expect(JSON.stringify(a.hazards)).toBe(JSON.stringify(b.hazards));
  });
});

describe('warp-ins are fair', () => {
  it('every ambush in the catalogue queues its warp-ins clear of rocks and landmarks', () => {
    let checked = 0;
    for (const L of ALL) {
      for (const site of L.sites.filter((x) => x.kind === 'ambush')) {
        const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5 });
        r.grace = 0;
        Object.assign(r.ship, { x: site.x + 120, y: site.y, vx: 0, vy: 0 });
        stepSector(r, { moveX: 0, moveY: 0 });
        const mine = r.pending.filter((q) => q.source === site.id);
        expect(mine.length, `${L.systemId} ${site.id}`).toBeGreaterThan(0);
        for (const q of mine) {
          checked += 1;
          for (const k of L.rocks) expect(dist(k, q), `${L.systemId} ${site.id} in a rock`).toBeGreaterThanOrEqual(k.r);
          for (const l of L.landmarks) expect(dist(l, q)).toBeGreaterThanOrEqual(l.r);
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});

/* -------------------------------------------------- difficulty and caps */
describe('regional difficulty and bounds', () => {
  it('rows scale monotonically, and group threat grows with difficulty', () => {
    for (let d = 2; d <= 5; d++) {
      const a = difficultyRow(d - 1);
      const b = difficultyRow(d);
      expect(b.damage).toBeGreaterThanOrEqual(a.damage);
      expect(b.reaction).toBeLessThanOrEqual(a.reaction);
      expect(b.maxActive).toBeGreaterThanOrEqual(a.maxActive);
      expect(b.maxActive).toBeLessThanOrEqual(COMBAT.maxAgents);
    }
    const t1 = groupThreat(compositionFor('patrol', 1, 4, 'cordon', 1, 'k'));
    const t3 = groupThreat(compositionFor('patrol', 3, 4, 'cordon', 5, 'k'));
    expect(t3).toBeGreaterThan(t1);
    for (let d = 1; d <= 5; d++) for (const f of compositionFor('outpost', 3, 6, 'tessellate', d, `x${d}`)) expect(difficultyRow(d).families).toContain(f);
  });

  it('spawns stop at the regional cap (bosses up to the hard cap)', () => {
    const L = arena(2);
    const r = fight(L, 71);
    const P = spot(L);
    let n = 0;
    while (spawnAgent(r, 'raider', 'red-tally', 'x', 'wave', P.x, P.y) && n < 100) n += 1;
    expect(n).toBe(difficultyRow(2).maxActive);
    let b = 0;
    while (spawnAgent(r, 'elite', 'cordon', 'y', 'boss', P.x, P.y) && b < 100) b += 1;
    expect(n + b).toBe(COMBAT.maxAgents);
  });

  it('a long flight through hostile sectors keeps every pool bounded, every projectile short-lived, and the arrival safe', () => {
    const hard = ALL.filter((L) => L.difficulty >= 4 && L.sites.length >= 3).slice(0, 4);
    expect(hard.length).toBeGreaterThan(0);
    for (const L of hard) {
      const r = createSectorRun(L, SURVEYED, { seed: 72 });
      const route = [L.arrival, ...L.sites.map((s) => ({ x: s.x, y: s.y }))];
      let ev: SectorEvent[] = [];
      for (let t = 0; t < 4000; t++) {
        const goal = route[Math.min(route.length - 1, Math.floor(t / 500))]!;
        const k = Math.min(1, (t % 500) / 300);
        const prev = route[Math.max(0, Math.min(route.length - 1, Math.floor(t / 500) - 1))]!;
        hold(r, { x: prev.x + (goal.x - prev.x) * k, y: prev.y + (goal.y - prev.y) * k });
        r.invuln = Math.max(r.invuln, 2); // survive the tour; damage still resolves
        const e = stepSector(r, { moveX: 0, moveY: 0, fire: t % 2 === 0 });
        if (t < r.row.grace) {
          expect(e.some((x) => x.type === 'enemyFired' || (x.type === 'encounter' && x.state !== 'broken'))).toBe(false);
        }
        ev = ev.concat(e.filter((x) => x.type === 'encounter'));
        expect(r.hostiles.length).toBeLessThanOrEqual(COMBAT.maxAgents);
        expect(r.hostiles.filter((h) => h.state !== 'destroyed').length).toBeLessThanOrEqual(r.row.maxActive + 2); // + a boss beyond the regional cap
        expect(r.enemyShots.length).toBeLessThanOrEqual(COMBAT.maxShots);
        expect(r.mines.length).toBeLessThanOrEqual(COMBAT.maxMines);
        expect(r.pending.length).toBeLessThanOrEqual(COMBAT.maxPending);
        for (const s of r.enemyShots) expect(s.life).toBeLessThanOrEqual(COMBAT.maxShotLife);
        for (const m of r.mines) if (typeof m.owner === 'number') expect(m.life).toBeLessThanOrEqual(COMBAT.maxMineLife);
        for (const h of r.hostiles) {
          expect(Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.hull)).toBe(true);
          expect(dist(h, L.arrival)).toBeGreaterThanOrEqual(L.arrival.r - 1e-6);
        }
      }
      // completion events are unique per encounter
      const cleared = ev.filter((e) => e.type === 'encounter' && e.state === 'cleared').map((e) => (e.type === 'encounter' ? e.id : ''));
      expect(new Set(cleared).size).toBe(cleared.length);
    }
  });
});

/* ------------------------------------------- cleanup, defeat, persistence */
describe('cleanup, defeat and persistence', () => {
  it('unloading a sector drops every combat entity, and nothing mutates it afterwards', () => {
    const { L, s } = siteLayout('ambush');
    const r = createSectorRun(L, SURVEYED, { seed: 81 });
    r.grace = 0;
    run(r, COMBAT.ambushWarnTicks + 20, s);
    const a = r.hostiles[0]!;
    expect(a).toBeDefined();
    disposeSectorRun(r);
    for (const k of ['hostiles', 'shots', 'enemyShots', 'mines', 'pending', 'encounters'] as const) expect(r[k], k).toHaveLength(0);
    const tick = r.tick;
    expect(stepSector(r, { moveX: 1, moveY: 0, fire: true })).toEqual([]);
    expect(r.tick).toBe(tick);
    const ev: SectorEvent[] = [];
    expect(damageAgent(r, a, 5, 'player', ev)).toBe(false);
    expect(damagePlayer(r, 5, 'fire', ev)).toBe(0);
    expect(spawnAgent(r, 'raider', 'red-tally', 'x', 'wave', s.x, s.y)).toBeNull();
    stepAgents(r, ev);
    expect(ev).toEqual([]);
    expect(r.done.has(s.id)).toBe(false);
  });

  it('defeat: one wreck and one recall per death; live encounters reset unpaid; the grace and recall shield restart', () => {
    const { L, s } = siteLayout('ambush');
    const r = createSectorRun(L, SURVEYED, { seed: 82 });
    r.grace = 0;
    run(r, COMBAT.ambushWarnTicks + 5, s);
    expect(r.encounters.find((e) => e.id === s.id)!.state).toBe('active');
    r.hull = 0;
    const ev = run(r, 1, null);
    expect(of(ev, 'wrecked')).toHaveLength(1);
    expect(of(ev, 'recalled')).toHaveLength(1);
    expect(of(ev, 'encounter').some((e) => e.state === 'cleared')).toBe(false);
    expect(r.encounters.find((e) => e.id === s.id)!.state).toBe('dormant');
    expect(r.hostiles).toHaveLength(0);
    expect(r.enemyShots).toHaveLength(0);
    expect(r.pending).toHaveLength(0);
    expect(r.grace).toBe(r.row.grace); // the recall comes after this tick's grace step
    expect(r.invuln).toBeGreaterThan(COMBAT.recallInvulnTicks - 5);
    expect(of(run(r, 30, null), 'wrecked')).toHaveLength(0);
    // restart behaves the same way
    restartSector(r);
    expect(r.hostiles).toHaveLength(0);
    expect(r.done.has(s.id)).toBe(false);
  });

  it('the cargo wreck: half of each common stack, rare kept; a second death replaces it; recovery restores once', () => {
    let p = addCargo(EMPTY_PROFILE, [
      { resource: 'scrap', amount: 9 },
      { resource: 'alloy', amount: 1 },
      { resource: 'relic', amount: 2 },
    ]);
    p = dropCargo(p, 'milky-way/sol', 100.04, 200, COMBAT.wreckShare, ['core-shard', 'relic']);
    expect(p.cargo).toEqual({ scrap: 5, alloy: 1, relic: 2 });
    expect(p.lostCargo).toEqual({ systemId: 'milky-way/sol', x: 100, y: 200, cargo: { scrap: 4 } });
    expect(lostCargoUnits(p)).toBe(4);
    const second = dropCargo(p, 'milky-way/sirius', 5, 5, COMBAT.wreckShare, ['relic']);
    expect(second.lostCargo).toEqual({ systemId: 'milky-way/sirius', x: 5, y: 5, cargo: { scrap: 2 } });
    expect(second.cargo).toEqual({ scrap: 3, alloy: 1, relic: 2 }); // the first wreck is lost
    const back = recoverCargo(second);
    expect(back.cargo).toEqual({ scrap: 5, alloy: 1, relic: 2 });
    expect(back.lostCargo).toBeNull();
    expect(recoverCargo(back)).toBe(back);
    // an empty hold leaves no wreck
    expect(dropCargo(EMPTY_PROFILE, 'milky-way/sol', 1, 1, 0.5, []).lostCargo).toBeNull();
  });

  it('the cargo wreck in flight: recovered once on fly-through; a full hold notifies once and keeps it', () => {
    const L = arena(2);
    const P = spot(L);
    const r = createSectorRun(L, SURVEYED, { seed: 83, cargoWreck: { x: P.x, y: P.y, units: 6 }, cargoSpace: 4 });
    const full = run(r, 30, P);
    expect(of(full, 'holdFull').filter((e) => e.id === 'wreck')).toHaveLength(1);
    expect(r.cargoWreck).not.toBeNull();
    run(r, 2, { x: P.x + 400, y: P.y });
    r.cargoSpace = 10;
    const got = run(r, 30, P);
    expect(of(got, 'recovered')).toMatchObject([{ type: 'recovered', units: 6, left: [] }]);
    expect(r.cargoWreck).toBeNull();
    expect(r.cargoSpace).toBe(4);
  });

  it('profile v7 saves the cargo wreck, repairs junk and migrates v6 saves without one', () => {
    expect(FREEROAM_VERSION).toBe(10);
    const store = new MemoryStore();
    const p = dropCargo(addCargo(EMPTY_PROFILE, [{ resource: 'scrap', amount: 6 }]), 'milky-way/sol', 10, 20, 0.5, []);
    saveProfile(store, p);
    expect(loadProfile(store).data.lostCargo).toEqual({ systemId: 'milky-way/sol', x: 10, y: 20, cargo: { scrap: 3 } });
    store.write('galaxia:freeroam', JSON.stringify({ ...EMPTY_PROFILE, version: 10, lostCargo: { systemId: 'BAD', x: 1, y: 2, cargo: { scrap: 1 } } }));
    const bad = loadProfile(store);
    expect(bad.status).toBe('repaired');
    expect(bad.data.lostCargo).toBeNull();
    store.write('galaxia:freeroam', JSON.stringify({ ...EMPTY_PROFILE, version: 10, lostCargo: { systemId: 'milky-way/sol', x: 1, y: Infinity, cargo: { scrap: 1 } } }));
    expect(loadProfile(store).data.lostCargo).toBeNull();
    const { lostCargo: _drop, ...v6 } = EMPTY_PROFILE;
    void _drop;
    store.write('galaxia:freeroam', JSON.stringify({ ...v6, version: 6 }));
    const mig = loadProfile(store);
    expect(mig.status).toBe('migrated');
    expect(mig.data.lostCargo).toBeNull();
  });

  it('encounter completion persists once: a saved id never pays or spawns again', () => {
    const { L, s } = siteLayout('elite', 3);
    let profile = EMPTY_PROFILE;
    const pay = (id: string): void => {
      if (profile.sectors[L.systemId]?.done.includes(id)) return; // the shell's guard
      profile = addCargo(withSectorProgress(profile, L.systemId, [id]), s.loot);
    };
    const r = createSectorRun(L, SURVEYED, { seed: 84 });
    r.grace = 0;
    r.invuln = 1e9;
    const near = { x: s.x + 250, y: s.y };
    const ev = run(r, 4, near, () => {
      for (const h of r.hostiles.filter((x) => x.source === s.id && x.role === 'boss')) damageAgent(r, h, 1e6, 'player', []);
    });
    for (const e of of(ev, 'encounter')) if (e.state === 'cleared') pay(e.id);
    // a replayed event (e.g. a duplicate delivery) pays nothing more
    for (const e of of(ev, 'encounter')) if (e.state === 'cleared') pay(e.id);
    const units = Object.values(profile.cargo).reduce((n, x) => n + x, 0);
    expect(units).toBe(s.loot.reduce((n, l) => n + l.amount, 0));
    const store = new MemoryStore();
    saveProfile(store, profile);
    const saved = loadProfile(store).data.sectors[L.systemId]!;
    expect(saved.done).toContain(s.id);
    expect(createEncounters(L, new Set(saved.done)).find((e) => e.id === s.id)?.state ?? 'done').toBe('done');
  });
});

/* ---------------------------------------------------------------- HUD */
describe('combat HUD model', () => {
  it('a missile lock outranks every other warning; the boss bar shows the elite being fought', () => {
    const { L, s } = siteLayout('elite', 3);
    const r = createSectorRun(L, SURVEYED, { seed: 91 });
    r.grace = 0;
    r.invuln = 1e9;
    const near = { x: s.x + 250, y: s.y };
    run(r, 3, near);
    const boss = r.hostiles.find((h) => h.role === 'boss')!;
    run(r, 120, near);
    const m = combatHud(r);
    expect(m.level).toBe('engaged');
    expect(m.boss?.name).toContain(FACTIONS[boss.faction].short.toUpperCase());
    boss.windup = { slot: 0, weapon: 'missile', ticks: 20, total: 45, angle: 0 };
    boss.target = 'player';
    r.pending.push({ at: r.tick + 50, x: 0, y: 0, family: 'raider', faction: 'red-tally', source: 'z', role: 'wave', heading: 0 });
    expect(combatHud(r).banner).toEqual({ text: 'MISSILE LOCK', tone: 'danger' });
    boss.windup = null;
    expect(combatHud(r).banner?.text).toBe('HOSTILES INBOUND');
  });
});

/* ------------------------------------------------------ combat framing */
describe('combat framing (presentation only)', () => {
  it('eases out while engaged, back to 1 after, faster with reduced motion, never past its bounds', () => {
    let f = 1;
    const seen: number[] = [];
    for (let i = 0; i < 120; i++) seen.push((f = stepFraming(f, true, 1 / 60, false)));
    expect(f).toBe(CAMERA.combatFraming);
    expect(seen.every((x, i) => i === 0 || x <= seen[i - 1]!)).toBe(true); // monotonic, no overshoot
    expect(seen[5]!).toBeGreaterThan(0.9); // eased, not a jump
    expect(stepFraming(1, true, 6 / 60, true)).toBeLessThan(stepFraming(1, true, 6 / 60, false)); // reduced motion settles faster
    for (let i = 0; i < 180; i++) f = stepFraming(f, false, 1 / 60, false);
    expect(f).toBe(1);
    expect(stepFraming(Number.NaN, false, 1 / 60, false)).toBe(1);
  });

  it('the engaged view keeps every non-recon stand-off range inside the long half-extent on desktop and phone', () => {
    for (const [w, h] of [[1280, 800], [2532, 1170]] as const) {
      const z = cameraZoom(w, h) * CAMERA.combatFraming;
      const halfLong = Math.max(w, h) / z / 2;
      const halfShort = Math.min(w, h) / z / 2;
      for (const id of FAMILY_IDS) if (id !== 'recon') expect(FAMILIES[id].prefer, `${id} ${w}x${h}`).toBeLessThanOrEqual(halfLong);
      expect(COMBAT.ambushRing).toBeLessThanOrEqual(halfShort + 60); // warp-in rings sit at (or just past) the short edge
    }
  });
});

