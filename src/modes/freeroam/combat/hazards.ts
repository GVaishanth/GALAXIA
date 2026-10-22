/**
 * Combat hazards (Free Roam Prompt 9). Asteroid fields and anomaly clouds
 * already exist in the layout (rocks block fire and ships; anomaly / nebula
 * effects drain or drag); this module adds the zones the generator places:
 *
 *  minefield     proximity mines (combat/projectiles.ts): a mine triggers on a
 *                hostile ship in range, its ring blinks faster for its fuse, then
 *                it blows. The pilot can shoot mines to clear a path.
 *  interference  sensors are jammed inside: no POI reveal, no hostile contacts
 *                on the map or edge markers, and sight ranges shrink to 60%
 *                (for both sides: a place to break contact).
 *  eruption      blasts on a fixed seeded schedule. Each blast point is shown
 *                COMBAT.eruptWarn ticks ahead as a filling ring, then hits once.
 *
 * Eruptions are a pure function of (zone, tick): nothing is stored, so the
 * schedule is reproducible and needs no cleanup.
 */
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { dist } from '../sector/grid.ts';
import type { HazardZone, SectorLayout } from '../sector/model.ts';
import { COMBAT } from './difficulty.ts';
import { FAMILIES } from './families.ts';
import { damageAgent, damagePlayer } from './world.ts';

export function inInterference(L: SectorLayout, p: { readonly x: number; readonly y: number }): boolean {
  for (const z of L.hazards) if (z.kind === 'interference' && dist(p, z) < z.r) return true;
  return false;
}

function hash(s: string, n: number): number {
  let h = 2166136261 ^ n;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export interface EruptionState {
  readonly x: number;
  readonly y: number;
  /** 0..1 during the warning (1 = blast this tick); null outside the warning. */
  readonly warn: number | null;
  readonly cycle: number;
}

/** Where and when the zone's next blast lands (pure). */
export function eruptionAt(z: HazardZone, tick: number): EruptionState {
  const period = Math.max(COMBAT.eruptWarn + 30, z.period);
  const offset = Math.floor(hash(z.id, 7) * period);
  const t = tick + offset;
  const cycle = Math.floor(t / period);
  const phase = t % period;
  const a = hash(z.id, cycle * 2 + 1) * Math.PI * 2;
  const r = Math.sqrt(hash(z.id, cycle * 2 + 2)) * Math.max(0, z.r - COMBAT.eruptRadius * 0.5);
  const warnFrom = period - COMBAT.eruptWarn;
  return { x: z.x + Math.cos(a) * r, y: z.y + Math.sin(a) * r, warn: phase >= warnFrom ? (phase - warnFrom + 1) / COMBAT.eruptWarn : null, cycle };
}

/** Blast every eruption whose warning completes this tick; each target is hit once per blast. */
export function stepEruptions(run: SectorRun, events: SectorEvent[]): void {
  for (const z of run.layout.hazards) {
    if (z.kind !== 'eruption') continue;
    // only zones near the pilot are simulated (nothing changes in a far corner of the sector)
    if (dist(run.ship, z) > z.r + COMBAT.sleepRadius) continue;
    const e = eruptionAt(z, run.tick);
    if (e.warn !== 1) continue;
    events.push({ type: 'blast', kind: 'eruption', x: e.x, y: e.y, r: COMBAT.eruptRadius });
    if (!run.docked && dist(run.ship, e) < COMBAT.eruptRadius + run.tune.radius) damagePlayer(run, COMBAT.eruptDamage, 'eruption', events, e);
    for (const a of run.hostiles) {
      if (a.state !== 'destroyed' && dist(a, e) < COMBAT.eruptRadius + FAMILIES[a.family].radius) damageAgent(run, a, COMBAT.eruptDamage, 'environment', events);
    }
  }
}
