/**
 * Combat P03 measurement probe (simulation only, never a human result).
 *
 * Runs repeatable duels in an empty arena at a chosen regional difficulty with
 * the stock starter ship, using ordinary flight input only (move / aim / fire /
 * boost / missile), and records what decides how long a fight takes:
 *  - time to kill, damage taken, win / recall;
 *  - enemy recovery: shield points regenerated, evade-on-hit jinks, retreat
 *    ticks, escapes (a retreater removed without a kill);
 *  - missile launches, hits, kills, damage per launch, refusals, cooldown downtime;
 *  - pool sizes (player shots, missiles, enemy shots) and step cost.
 *
 * Two simulated pilots:
 *  - 'lead':   the balance-test pilot (charges the nearest, perfect lead aim);
 *  - 'jitter': the same with a seeded aim error (±0.14 rad, re-rolled every
 *              12 ticks) and fire only inside 480 px - a rougher stand-in for a
 *              person, still not a person;
 *  - 'skirmish': the jitter pilot that breaks off for 2 s out of every 6 s
 *              (strafes away with boost, no fire), as a person dodging does.
 *              This is the pilot that exposes recovery between attacks.
 */
import { getCatalogue } from '../../src/modes/freeroam/catalogue/index.ts';
import { spawnAgent } from '../../src/modes/freeroam/combat/ai.ts';
import type { FamilyId } from '../../src/modes/freeroam/combat/families.ts';
import { buildNavGraph } from '../../src/modes/freeroam/galaxy/graph.ts';
import { sectorContext } from '../../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../../src/modes/freeroam/sector/generate.ts';
import { EMPTY_SECTOR_SAVE, type SectorLayout } from '../../src/modes/freeroam/sector/model.ts';
import { createSectorRun, stepSector, type SectorInput, type SectorRun } from '../../src/modes/freeroam/sector/run.ts';
import { attackInput } from './frPilot.ts';

const graph = buildNavGraph();
const SYSTEMS = getCatalogue().systems;

const arenas = new Map<number, SectorLayout>();
/** An empty arena at difficulty d (open space, only the exit) - same as balance.test.ts. */
export function arena(d: number): SectorLayout {
  let L = arenas.get(d);
  if (!L) {
    const sys = SYSTEMS.find((s) => s.difficulty === d)!;
    const full = generateSector(sys, sectorContext(graph, sys.id));
    L = { ...full, rocks: [], landmarks: [], regions: [], patrols: [], sites: [], hazards: [], pois: full.pois.filter((p) => p.kind === 'exit') };
    arenas.set(d, L);
  }
  return L;
}

export type Pilot = 'lead' | 'jitter' | 'skirmish';

export interface ProbeOptions {
  readonly pilot: Pilot;
  /** Use the missile skill (whenever the HUD would show it ready and a hostile is in front). */
  readonly missile: boolean;
  readonly maxSecs?: number;
  readonly spawnRadius?: number;
}

export interface Duel {
  readonly won: boolean;
  readonly recalled: boolean;
  readonly secs: number;
  readonly damageTaken: number;
  readonly hull0: number;
  readonly minHull: number;
  /* enemy recovery */
  readonly regen: number;
  readonly evades: number;
  readonly retreatTicks: number;
  readonly escaped: number;
  /* missile */
  readonly launches: number;
  readonly missileHits: number;
  readonly missileKills: number;
  readonly missileDamage: number;
  readonly refusals: number;
  readonly lockLost: number;
  readonly cooldownTicks: number;
  /* pools and cost */
  readonly maxShots: number;
  readonly maxMissiles: number;
  readonly maxEnemyShots: number;
  readonly stepMs: number;
}

/** Seeded LCG for the pilot's aim error (independent of the run's own rng). */
function lcg(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type MissileRun = SectorRun & { missile?: { state: string; cooldown: number }; missiles?: readonly unknown[] };

/** One duel: the starter against `fams` spawned around it. */
export function duel(d: number, fams: readonly FamilyId[], seed: number, o: ProbeOptions): Duel {
  const L = arena(d);
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed }) as MissileRun;
  r.grace = 0;
  const cx = L.width / 2;
  const cy = L.height / 2;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0 });
  const R = o.spawnRadius ?? 450;
  fams.forEach((f, i) => {
    const a = (i / fams.length) * Math.PI * 2;
    spawnAgent(r, f, 'red-tally', 'probe', 'guard', cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  });
  const rand = lcg(seed + 7919);
  let err = 0;
  const hull0 = r.hull;
  let minHull = r.hull;
  let damageTaken = 0;
  let regen = 0;
  let evades = 0;
  let retreatTicks = 0;
  let escaped = 0;
  let launches = 0;
  let missileHits = 0;
  let missileKills = 0;
  let missileDamage = 0;
  let refusals = 0;
  let lockLost = 0;
  let cooldownTicks = 0;
  let maxShots = 0;
  let maxMissiles = 0;
  let maxEnemyShots = 0;
  let recalled = false;
  const prev = new Map<number, { shield: number; state: string }>();
  const max = 60 * (o.maxSecs ?? 90);
  let t = 0;
  const t0 = performance.now();
  for (; t < max; t++) {
    const live = r.hostiles.filter((h) => h.hull > 0 && h.state !== 'destroyed');
    if (!live.length) break;
    const s = r.ship;
    const h = live.reduce((b, x) => (Math.hypot(x.x - s.x, x.y - s.y) < Math.hypot(b.x - s.x, b.y - s.y) ? x : b));
    let input: SectorInput = attackInput(r, h);
    if (o.pilot !== 'lead') {
      if (t % 12 === 0) err = (rand() * 2 - 1) * 0.14;
      const ax = input.aimX ?? 0;
      const ay = input.aimY ?? 0;
      const c = Math.cos(err);
      const sn = Math.sin(err);
      const dd = Math.hypot(h.x - s.x, h.y - s.y);
      input = { ...input, aimX: ax * c - ay * sn, aimY: ax * sn + ay * c, fire: dd < 480 };
    }
    if (o.pilot === 'skirmish' && t % 360 >= 240) {
      const dx = s.x - h.x;
      const dy = s.y - h.y;
      const dd = Math.hypot(dx, dy) || 1;
      input = { moveX: (dx / dd) * 0.6 - (dy / dd) * 0.8, moveY: (dy / dd) * 0.6 + (dx / dd) * 0.8, boost: true };
    }
    if (o.missile) {
      // Combat P03C: FIRE fires the selected weapon, so a pilot using the lock-on switches to it when it is
      // ready, presses FIRE (the skill itself checks range and cone; a refusal costs nothing), lets the lock
      // run, and switches back to plasma (one step per tick, as one wheel notch or tap per frame at most)
      const a = r.arsenal;
      const m = r.missile;
      const lockReady = a.cooldown['lock-missile'] === 0 && r.energy >= 30 && a.rotation.includes('lock-missile');
      if (m.state === 'acquiring') input = { ...input, fire: false };
      else if (a.selected === 'lock-missile') {
        if (!lockReady || m.notice === 'noTarget' || m.notice === 'lowEnergy') input = { ...input, fire: false, cycle: 1 };
        else input = { ...input, fire: t % 6 === 0 };
      } else if (lockReady && t % 6 === 0 && (input.fire ?? false)) input = { ...input, fire: false, cycle: 1 };
      else if (a.selected !== 'plasma') input = { ...input, fire: false, cycle: 1 };
    }
    for (const a of r.hostiles) prev.set(a.id, { shield: a.shield, state: a.state });
    const ev = stepSector(r, input);
    minHull = Math.min(minHull, r.hull);
    for (const e of ev) {
      if (e.type === 'hit') damageTaken += e.damage;
      else if (e.type === 'escaped') escaped += 1;
      else if (e.type === 'recalled') recalled = true;
      else if ((e as { type: string }).type === 'missileLaunched') launches += 1;
      else if ((e as { type: string }).type === 'missileHit') {
        const m = e as unknown as { damage: number; killed: boolean };
        missileHits += 1;
        missileDamage += m.damage;
        if (m.killed) missileKills += 1;
      } else if ((e as { type: string }).type === 'missileRefused') refusals += 1;
      else if ((e as { type: string }).type === 'missileLockLost') lockLost += 1;
    }
    for (const a of r.hostiles) {
      const p = prev.get(a.id);
      if (!p) continue;
      if (a.shield > p.shield && a.sinceHit > 0) regen += a.shield - p.shield;
      if (a.state === 'evade' && p.state !== 'evade' && a.sinceHit <= 2) evades += 1;
      if (a.state === 'retreat') retreatTicks += 1;
    }
    if (r.arsenal && r.arsenal.cooldown['lock-missile'] > 0) cooldownTicks += 1;
    maxShots = Math.max(maxShots, r.shots.length);
    maxMissiles = Math.max(maxMissiles, r.missiles?.length ?? 0);
    maxEnemyShots = Math.max(maxEnemyShots, r.enemyShots.length);
    if (recalled) break;
  }
  const stepMs = (performance.now() - t0) / Math.max(1, t);
  const won = !recalled && r.hostiles.every((x) => x.hull <= 0 || x.state === 'destroyed') && escaped === 0;
  return { won, recalled, secs: t / 60, damageTaken, hull0, minHull, regen, evades, retreatTicks, escaped, launches, missileHits, missileKills, missileDamage, refusals, lockLost, cooldownTicks, maxShots, maxMissiles, maxEnemyShots, stepMs };
}

export const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2) : 0;
};

/** Summary row over seeds. */
export function summarise(label: string, res: readonly Duel[]): string {
  const wins = res.filter((x) => x.won).length;
  const f = (n: number, k = 1): string => n.toFixed(k);
  const L = mean(res.map((x) => x.launches));
  const hits = mean(res.map((x) => x.missileHits));
  return [
    label.padEnd(34),
    `win ${wins}/${res.length}`,
    `ttk med ${f(median(res.map((x) => x.secs)))}s mean ${f(mean(res.map((x) => x.secs)))}s`,
    `dmg ${f(mean(res.map((x) => x.damageTaken)))}`,
    `regen ${f(mean(res.map((x) => x.regen)))}`,
    `evade ${f(mean(res.map((x) => x.evades)))}`,
    `retreat ${f(mean(res.map((x) => x.retreatTicks)) / 60)}s`,
    `esc ${res.reduce((a, x) => a + x.escaped, 0)}`,
    L > 0 ? `msl ${f(L)} hit ${f(hits / L * 100, 0)}% dpl ${f(mean(res.map((x) => x.missileDamage)) / L)} kills ${f(mean(res.map((x) => x.missileKills)))} cd ${f(mean(res.map((x) => x.cooldownTicks)) / 60)}s` : 'msl -',
    `pools ${Math.max(...res.map((x) => x.maxShots))}/${Math.max(...res.map((x) => x.maxMissiles))}/${Math.max(...res.map((x) => x.maxEnemyShots))}`,
    `${f(mean(res.map((x) => x.stepMs)), 3)}ms/step`,
  ].join(' | ');
}
