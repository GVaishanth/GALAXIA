/**
 * Combat HUD model (pure): what the flight HUD shows about the fight, derived
 * from the run each frame. The DOM view (freeroam/combatHud.ts) only renders
 * it, so the priorities below are unit tested without a browser.
 *
 *  - banner: the most urgent warning, one at a time, in this order:
 *      MISSILE LOCK / BEAM CHARGING (a heavy attack is winding up on the pilot)
 *      INCOMING MISSILE (a missile in flight homes on the pilot)
 *      AMBUSH (warp signatures around the pilot)
 *      MINE ARMED / ERUPTION (a hazard is about to go off next to the pilot)
 *      HOSTILES INBOUND (any other warp-in)
 *      SENSORS JAMMED (inside sensor interference)
 *    Text plus a tone; never colour alone.
 *  - objective: the active encounter's goal with its clock or progress.
 *  - boss: name and hull / shield fractions of the elite or capital ship being
 *    fought (only once its encounter is active).
 */
import type { SectorRun } from '../sector/run.ts';
import { encounterLabel, encounterPos, combatLevel, siteOf } from './encounters.ts';
import { FACTIONS, shipName } from './factions.ts';
import { FAMILIES } from './families.ts';
import { eruptionAt, inInterference } from './hazards.ts';
import { COMBAT } from './difficulty.ts';
import { hostileTo } from './world.ts';
import type { CombatLevel } from './state.ts';

export type BannerTone = 'danger' | 'warn' | 'info';

export interface CombatHudModel {
  readonly level: CombatLevel;
  readonly banner: { readonly text: string; readonly tone: BannerTone } | null;
  readonly objective: string | null;
  readonly boss: { readonly name: string; readonly hull: number; readonly shield: number; readonly phase2: boolean } | null;
}

const dist = (a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const clock = (ticks: number): string => {
  const s = Math.max(0, Math.ceil(ticks / 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Distance under which a hazard about to go off is announced. */
const HAZARD_WARN_RANGE = 170;
/** Missiles closer than this that home on the pilot are announced. */
const MISSILE_WARN_RANGE = 520;

function banner(run: SectorRun): CombatHudModel['banner'] {
  const P = run.ship;
  if (run.phase !== 'flight') return null;
  for (const a of run.hostiles) {
    if (a.state === 'destroyed' || !a.windup || a.target !== 'player') continue;
    if (a.windup.weapon === 'missile') return { text: 'MISSILE LOCK', tone: 'danger' };
    if (a.windup.weapon === 'beam') return { text: 'BEAM CHARGING', tone: 'danger' };
  }
  if (run.enemyShots.some((s) => s.kind === 'missile' && s.target === 'player' && dist(s, P) < MISSILE_WARN_RANGE)) return { text: 'INCOMING MISSILE', tone: 'danger' };
  if (run.encounters.some((e) => e.kind === 'ambush' && e.state === 'warning')) return { text: 'AMBUSH · WARP SIGNATURES', tone: 'danger' };
  if (run.mines.some((m) => m.fuse >= 0 && dist(m, P) < HAZARD_WARN_RANGE)) return { text: 'MINE ARMED · BREAK AWAY', tone: 'warn' };
  for (const z of run.layout.hazards) {
    if (z.kind !== 'eruption') continue;
    const s = eruptionAt(z, run.tick);
    if (s.warn !== null && dist(s, P) < COMBAT.eruptRadius + HAZARD_WARN_RANGE) return { text: 'ERUPTION · CLEAR THE RING', tone: 'warn' };
  }
  if (run.pending.length > 0) return { text: 'HOSTILES INBOUND', tone: 'warn' };
  if (inInterference(run.layout, P)) return { text: 'SENSORS JAMMED', tone: 'info' };
  return null;
}

function objective(run: SectorRun): string | null {
  const L = run.layout;
  for (const e of run.encounters) {
    if (e.state !== 'active') continue;
    const label = encounterLabel(L, e).toUpperCase();
    const left = run.hostiles.filter((a) => a.source === e.id && a.state !== 'destroyed' && hostileTo(run, a.faction, 'player')).length + run.pending.filter((p) => p.source === e.id).length;
    switch (e.kind) {
      case 'outpost':
        return `${label} · DESTROY ${left} OR HOLD ${clock(e.holdLeft)}`;
      case 'ambush':
        return `AMBUSH · ${left} HOSTILE${left === 1 ? '' : 'S'} LEFT`;
      case 'defence': {
        const s = siteOf(L, e.id);
        const near = s ? dist(run.ship, encounterPos(L, e)) < s.r * 2.4 : true;
        return `DEFEND THE WRECK · ${clock(e.holdLeft)}${near ? '' : ' (STAY CLOSE)'} · WRECK ${Math.max(0, Math.ceil((100 * e.integrity) / COMBAT.wreckIntegrity))}%`;
      }
      case 'dispute':
        return left > 0 ? `CLAIM CONTESTED · ${left} HOSTILE${left === 1 ? '' : 'S'}` : 'GLEANER CLAIM · HANDS OFF THE SALVAGE';
      case 'elite':
      case 'capital':
        return `${label} · ENGAGED`;
    }
  }
  return null;
}

function boss(run: SectorRun): CombatHudModel['boss'] {
  for (const e of run.encounters) {
    if (e.state !== 'active' || (e.kind !== 'elite' && e.kind !== 'capital')) continue;
    const a = run.hostiles.find((h) => h.source === e.id && h.role === 'boss' && h.state !== 'destroyed');
    if (!a) continue;
    return {
      name: shipName(a.faction, a.family, FAMILIES[a.family].label).toUpperCase(),
      hull: Math.max(0, Math.min(1, a.hull / a.maxHull)),
      shield: a.maxShield > 0 ? Math.max(0, Math.min(1, a.shield / a.maxShield)) : 0,
      phase2: a.phase2,
    };
  }
  return null;
}

export function combatHud(run: SectorRun): CombatHudModel {
  return { level: combatLevel(run), banner: banner(run), objective: objective(run), boss: boss(run) };
}

/** Faction display name (toasts). */
export const factionName = (f: keyof typeof FACTIONS): string => FACTIONS[f].name;
