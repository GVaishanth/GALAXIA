/**
 * Free Roam test pilot (Prompt 14): flies a sector run with ordinary flight
 * input only (move / aim / fire / boost), never by teleporting the ship.
 * Shared by the journey, balance and performance tests.
 */
import { buildGrid, cellOf, solidsOf, type OccupancyGrid } from '../../src/modes/freeroam/sector/grid.ts';
import type { Point } from '../../src/modes/freeroam/sector/model.ts';
import { stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../../src/modes/freeroam/sector/run.ts';
import type { Agent } from '../../src/modes/freeroam/combat/state.ts';

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Grid path (4-neighbour BFS) from `a` to the free cell nearest `b`. */
export function gridPath(g: OccupancyGrid, a: Point, b: Point): Point[] {
  const start = cellOf(g, a);
  const prev = new Int32Array(g.cols * g.rows).fill(-1);
  const seen = new Uint8Array(g.cols * g.rows);
  const q = [start];
  seen[start] = 1;
  let best = start;
  let bestD = Infinity;
  for (let h = 0; h < q.length; h++) {
    const i = q[h]!;
    const c = i % g.cols;
    const r = (i - c) / g.cols;
    const d = Math.hypot((c + 0.5) * g.cell - b.x, (r + 0.5) * g.cell - b.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
    for (const j of [c > 0 ? i - 1 : -1, c < g.cols - 1 ? i + 1 : -1, r > 0 ? i - g.cols : -1, r < g.rows - 1 ? i + g.cols : -1]) {
      if (j < 0 || seen[j] || g.blocked[j]) continue;
      seen[j] = 1;
      prev[j] = i;
      q.push(j);
    }
  }
  const out: Point[] = [b];
  for (let i = best; i !== -1 && i !== start; i = prev[i]!) {
    const c = i % g.cols;
    out.unshift({ x: (c + 0.5) * g.cell, y: ((i - c) / g.cols + 0.5) * g.cell });
  }
  return out;
}

/** The nearest live hostile that is chasing or shooting the pilot within `range` (null = none). */
export function threatNear(run: SectorRun, range = 520): Agent | null {
  let best: Agent | null = null;
  let bd = range;
  for (const h of run.hostiles) {
    if (h.hull <= 0) continue;
    const d = dist(h, run.ship);
    if (d < bd) {
      bd = d;
      best = h;
    }
  }
  return best;
}

/** Combat input against `h`: charge in with a lead-corrected aim and fire in range (the tactic the balance probe found most reliable). */
export function attackInput(run: SectorRun, h: Agent, shotSpeed = 640): SectorInput {
  const s = run.ship;
  const dx = h.x - s.x;
  const dy = h.y - s.y;
  const d = Math.hypot(dx, dy) || 1;
  const t = d / shotSpeed;
  const close = d < 140; // do not ram: hold position and keep shooting
  return { moveX: close ? 0 : dx / d, moveY: close ? 0 : dy / d, aimX: h.x + h.vx * t - s.x, aimY: h.y + h.vy * t - s.y, fire: d < 560 };
}

export interface FlyOptions {
  readonly maxTicks?: number;
  /** Fight anything that comes within this distance on the way (0 = ignore hostiles). */
  readonly fight?: number;
}

/**
 * Fly to `target` along a grid path around solids, slowing on the last leg.
 * Stops when `until` holds (checked on every tick's events) or after maxTicks.
 */
export function flyTo(run: SectorRun, target: Point, until: (ev: SectorEvent[]) => boolean, o: FlyOptions = {}): SectorEvent[] {
  const g = buildGrid(run.layout.width, run.layout.height, solidsOf(run.layout), 18);
  let path = gridPath(g, run.ship, target);
  const all: SectorEvent[] = [];
  const max = o.maxTicks ?? 60 * 120;
  for (let t = 0; t < max && run.phase === 'flight'; t++) {
    const foe = o.fight ? threatNear(run, o.fight) : null;
    let input: SectorInput;
    if (foe) input = attackInput(run, foe);
    else {
      if (t % 90 === 0) path = gridPath(g, run.ship, target);
      while (path.length > 1 && dist(run.ship, path[0]!) < 40) path.shift();
      const wp = path[0]!;
      const dx = wp.x - run.ship.x;
      const dy = wp.y - run.ship.y;
      const d = Math.hypot(dx, dy) || 1;
      const speed = Math.hypot(run.ship.vx, run.ship.vy);
      const k = path.length === 1 && d < 120 && speed > 120 ? 0 : 1; // coast in on the last leg
      input = { moveX: (dx / d) * k, moveY: (dy / d) * k };
    }
    const ev = stepSector(run, input);
    all.push(...ev);
    if (until(ev)) break;
  }
  return all;
}

/** Fight until no hostile is within `range` (or `until`), up to maxTicks. */
export function fightAll(run: SectorRun, until: (ev: SectorEvent[]) => boolean = () => false, range = 900, maxTicks = 60 * 120): SectorEvent[] {
  const all: SectorEvent[] = [];
  for (let t = 0; t < maxTicks && run.phase === 'flight'; t++) {
    const foe = threatNear(run, range);
    const ev = stepSector(run, foe ? attackInput(run, foe) : { moveX: 0, moveY: 0 });
    all.push(...ev);
    if (until(ev) || (!foe && t > 30)) break;
  }
  return all;
}

export const eventsOf = <T extends SectorEvent['type']>(ev: readonly SectorEvent[], type: T): Extract<SectorEvent, { type: T }>[] => ev.filter((e): e is Extract<SectorEvent, { type: T }> => e.type === type);
