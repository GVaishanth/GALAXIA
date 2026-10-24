/**
 * Local time dilation (Combat P03C, FR-TD-89): the slow-down a nuke leaves at
 * its detonation. Pure simulation on the fixed 60 Hz step; the global tick
 * never changes.
 *
 * Rules (values from the catalogue, config/weapons.ts `nuke.dilation`):
 *  - a zone is a fixed circle (detonation point, `radius`) that lasts
 *    `durationTicks` ticks of normal simulation time;
 *  - eligible: ships hostile to the pilot and shots from factions hostile to
 *    the pilot. The pilot's ship, its bolts and missiles, wary and neutral
 *    traffic, mines and the environment are never slowed;
 *  - an eligible entity is slowed while its position is inside any zone: one
 *    that flies in later is slowed from then on, one that leaves is back to
 *    full speed on the next tick. Overlapping zones never stack: the slowest
 *    scale of the zones it is in applies (min, not product);
 *  - ships: an accumulator. A ship at scale s gains s per tick and runs one
 *    full AI / movement / weapon / regeneration step whenever it reaches 1,
 *    so every timer it owns (cooldowns, wind-ups, evade, regen delay) runs
 *    at s and nothing is skipped or doubled. The renderer interpolates with
 *    the accumulator (smooth motion at half speed);
 *  - shots: movement, homing turn and remaining life scale by s;
 *  - cleanup: a destroyed ship is removed with its state; recall, restart
 *    and unload drop every zone (sector/run.ts); a paused run is not
 *    stepped, so a zone neither advances nor expires while paused.
 */
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import type { Agent } from './state.ts';
import { hostileTo } from './world.ts';

export interface DilationZone {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly scale: number;
  ticksLeft: number;
  readonly duration: number;
}

/** Simulation scale at a point (1 = normal): the slowest zone containing it. */
export function dilationAt(zones: readonly DilationZone[], x: number, y: number): number {
  let s = 1;
  for (const z of zones) {
    if (z.ticksLeft <= 0) continue;
    const dx = x - z.x;
    const dy = y - z.y;
    if (dx * dx + dy * dy <= z.r * z.r && z.scale < s) s = z.scale;
  }
  return s;
}

/** Open a zone (nuke detonation). */
export function openZone(run: SectorRun, x: number, y: number, d: { readonly scale: number; readonly durationTicks: number; readonly radius: number }, events: SectorEvent[]): void {
  run.dilation.push({ x, y, r: d.radius, scale: d.scale, ticksLeft: d.durationTicks, duration: d.durationTicks });
  events.push({ type: 'dilation', state: 'start', x, y, r: d.radius, ticks: d.durationTicks });
}

/** Count every zone down by one tick of normal time; expired zones are dropped. */
export function stepDilation(run: SectorRun, events: SectorEvent[]): void {
  for (let i = run.dilation.length - 1; i >= 0; i--) {
    const z = run.dilation[i]!;
    z.ticksLeft -= 1;
    if (z.ticksLeft <= 0) {
      run.dilation.splice(i, 1);
      events.push({ type: 'dilation', state: 'end', x: z.x, y: z.y, r: z.r, ticks: 0 });
    }
  }
}

/** The scale that applies to a ship this tick (1 for ships that are not eligible). */
export function agentScale(run: SectorRun, a: Agent): number {
  if (run.dilation.length === 0 || a.state === 'destroyed' || !hostileTo(run, a.faction, 'player')) return 1;
  return dilationAt(run.dilation, a.x, a.y);
}

/**
 * Whether a ship runs its step this tick (accumulator). A ship outside every
 * zone always steps and its accumulator is cleared, so leaving restores full
 * speed at once.
 */
export function agentSteps(run: SectorRun, a: Agent): boolean {
  const s = agentScale(run, a);
  if (s >= 1) {
    a.tacc = 0;
    a.tscale = 1;
    return true;
  }
  a.tscale = s;
  a.tacc = (a.tacc ?? 0) + s;
  if (a.tacc >= 1 - 1e-9) {
    a.tacc -= 1;
    return true;
  }
  return false;
}

/** The scale for a shot of `faction` at (x, y). */
export function shotScale(run: SectorRun, faction: Parameters<typeof hostileTo>[1], x: number, y: number): number {
  if (run.dilation.length === 0 || !hostileTo(run, faction, 'player')) return 1;
  return dilationAt(run.dilation, x, y);
}

/** Render interpolation for a ship: a slowed ship spreads one step over 1/scale frames. */
export function agentAlpha(a: Agent, alpha: number): number {
  const s = a.tscale ?? 1;
  return s >= 1 ? alpha : Math.min(1, (a.tacc ?? 0) + alpha * s);
}
