/**
 * Contextual flight HUD (Prompt 12): what the HUD shows this frame, from the
 * run's state. Pure (no DOM, no clock: time is the simulation tick), so the
 * rules are unit-tested and the view only renders the answer.
 *
 * Always: hull and shield, the ship and its weapon state (the ship card).
 * When relevant:
 *  - cargo: for a few seconds after the hold changes, or while nearly full /
 *    short of reactor cells (a warning);
 *  - the tracked objective: in full for a few seconds after it changes, then
 *    compact;
 *  - a nearby point of interest: only when calm and no interaction is in
 *    range (the interaction prompt takes its place);
 *  - danger: the hull is low.
 * In combat, non-combat information shrinks or steps aside: the location line
 * goes compact, the tracked objective and the nearby chip hide (the combat
 * objective replaces them) and only a cargo warning stays.
 */
import type { CombatLevel } from '../combat/state.ts';

/** Ticks (60 per second). */
export const HUD_TIMING = Object.freeze({
  /** Cargo chip after the hold changes. */
  cargoTicks: 240,
  /** Objective in full after it changes. */
  objectiveTicks: 360,
  /** The control hint after entering a sector. */
  hintTicks: 900,
});

export const HUD_LIMITS = Object.freeze({
  /** Hold use (fraction) at which the cargo chip stays up as a warning. */
  holdWarn: 0.85,
  /** Hull fraction below which the HUD flags danger. */
  hullCritical: 0.3,
  /** Shield fraction below which the shield bar is marked low. */
  shieldLow: 0.35,
  /** A revealed point of interest within this range (art px) counts as nearby. */
  nearbyRange: 900,
});

/** Change tracking: the tick at which each watched value last changed. */
export interface HudAttention {
  readonly cargoKey: string;
  readonly cargoTick: number;
  readonly objectiveKey: string;
  readonly objectiveTick: number;
  readonly sectorKey: string;
  readonly sectorTick: number;
}

export const NO_ATTENTION: HudAttention = Object.freeze({ cargoKey: '', cargoTick: -1e9, objectiveKey: '', objectiveTick: -1e9, sectorKey: '', sectorTick: -1e9 });

/** Advance the change tracking (returns the same object when nothing changed). */
export function stepAttention(a: HudAttention, tick: number, keys: { readonly cargo: string; readonly objective: string; readonly sector: string }): HudAttention {
  // a new sector resets the timers: the first cargo / objective readings there are not "changes"
  if (keys.sector !== a.sectorKey) return { cargoKey: keys.cargo, cargoTick: -1e9, objectiveKey: keys.objective, objectiveTick: keys.objective ? tick : -1e9, sectorKey: keys.sector, sectorTick: tick };
  if (keys.cargo === a.cargoKey && keys.objective === a.objectiveKey) return a;
  return {
    ...a,
    cargoKey: keys.cargo,
    cargoTick: keys.cargo !== a.cargoKey ? tick : a.cargoTick,
    objectiveKey: keys.objective,
    objectiveTick: keys.objective !== a.objectiveKey && keys.objective ? tick : a.objectiveTick,
  };
}

export interface HudInput {
  readonly tick: number;
  readonly level: CombatLevel;
  readonly hull: number;
  readonly hullMax: number;
  readonly shield: number;
  readonly shieldMax: number;
  readonly holdUsed: number;
  readonly holdCap: number;
  /** Reactor cells short of the cheapest jump from here. */
  readonly cellsShort: boolean;
  readonly hasObjective: boolean;
  /** An interaction is in range (its prompt is showing). */
  readonly focus: boolean;
  readonly nearby: NearbyPoi | null;
}

export type ChipState = 'hidden' | 'shown' | 'warn';

export interface HudView {
  readonly cargo: ChipState;
  readonly objective: 'hidden' | 'full' | 'compact';
  readonly nearby: NearbyPoi | null;
  readonly location: 'full' | 'compact';
  readonly critical: boolean;
  readonly shieldLow: boolean;
  readonly hint: boolean;
}

export function hudView(i: HudInput, a: HudAttention): HudView {
  const calm = i.level === 'calm';
  const engaged = i.level === 'engaged';
  const warn = (i.holdCap > 0 && i.holdUsed / i.holdCap >= HUD_LIMITS.holdWarn) || i.cellsShort;
  const fresh = i.tick - a.cargoTick < HUD_TIMING.cargoTicks;
  const cargo: ChipState = warn ? 'warn' : fresh && !engaged ? 'shown' : 'hidden';
  const objective = !i.hasObjective || !calm ? 'hidden' : i.tick - a.objectiveTick < HUD_TIMING.objectiveTicks ? 'full' : 'compact';
  return {
    cargo,
    objective,
    nearby: calm && !i.focus ? i.nearby : null,
    location: calm ? 'full' : 'compact',
    critical: i.hullMax > 0 && i.hull / i.hullMax < HUD_LIMITS.hullCritical,
    shieldLow: i.shieldMax > 0 && i.shield < i.shieldMax * HUD_LIMITS.shieldLow,
    hint: calm && i.tick - a.sectorTick < HUD_TIMING.hintTicks,
  };
}

/* ------------------------------------------------------------ nearby POI */

export interface PoiCandidate {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

export interface NearbyPoi {
  readonly id: string;
  readonly label: string;
  /** Rounded distance, art px. */
  readonly distance: number;
  /** Compass arrow toward it (screen up = north). */
  readonly arrow: string;
}

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'] as const;

/** Eight-way arrow for a direction (canvas axes: +y is down). */
export function arrowFor(dx: number, dy: number): string {
  const a = Math.atan2(dy, dx);
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return ARROWS[i]!;
}

/** The closest candidate within range (ties: the first listed), or null. */
export function nearestPoi(ship: { readonly x: number; readonly y: number }, candidates: readonly PoiCandidate[], range: number = HUD_LIMITS.nearbyRange): NearbyPoi | null {
  let best: PoiCandidate | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - ship.x, c.y - ship.y);
    if (d <= range && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  if (!best) return null;
  return { id: best.id, label: best.label, distance: Math.round(bestD / 10) * 10, arrow: arrowFor(best.x - ship.x, best.y - ship.y) };
}

/* ------------------------------------------------------------ ship card */

export type WeaponState = 'ready' | 'firing' | 'safe' | 'overheated';

export interface ShipCardInput {
  readonly ship: string;
  readonly weapon: string;
  readonly firing: boolean;
  readonly docked: boolean;
  readonly shield: number;
  readonly shieldMax: number;
  readonly hull: number;
  readonly hullMax: number;
  readonly energy: number;
  readonly energyMax: number;
  readonly boosting: boolean;
  /** Weapon heat 0..1 and the overheat lock (FR-TD-79). Absent = cold. */
  readonly heat?: number;
  readonly overheated?: boolean;
}

export interface Gauge {
  /** 0..100, rounded. */
  readonly pct: number;
  /** Text for readers and colour-independent display (e.g. "72%" or "LOW 20%"). */
  readonly text: string;
  readonly low: boolean;
}

export interface ShipCard {
  readonly ship: string;
  readonly weapon: string;
  readonly weaponState: WeaponState;
  readonly weaponText: string;
  readonly shield: Gauge;
  readonly hull: Gauge;
  readonly energy: Gauge;
  /** Weapon heat: `low` means hot (70% and up) or locked; the text says OVERHEAT while locked. */
  readonly heat: Gauge;
  readonly boosting: boolean;
  /** One line for assistive tech. */
  readonly label: string;
  /** Changes whenever anything visible changes (the view skips identical frames). */
  readonly key: string;
}

const pctOf = (v: number, max: number): number => (max > 0 && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round((100 * v) / max))) : 0);

function gauge(v: number, max: number, lowAt: number): Gauge {
  const pct = pctOf(v, max);
  const low = max > 0 && v < max * lowAt;
  return { pct, text: low ? `LOW ${pct}%` : `${pct}%`, low };
}

const WEAPON_TEXT: Readonly<Record<WeaponState, string>> = { ready: 'READY', firing: 'FIRING', safe: 'SAFE', overheated: 'OVERHEAT' };

/** Heat at or above which the gauge reads HOT (FR-TD-79). */
export const HEAT_HOT_AT = 0.7;

function heatGauge(level: number, overheated: boolean): Gauge {
  const pct = pctOf(level, 1);
  if (overheated) return { pct, text: 'OVERHEAT', low: true };
  const hot = level >= HEAT_HOT_AT;
  return { pct, text: hot ? `HOT ${pct}%` : `${pct}%`, low: hot };
}

export function shipCard(i: ShipCardInput): ShipCard {
  const overheated = i.overheated === true && !i.docked;
  const weaponState: WeaponState = i.docked ? 'safe' : overheated ? 'overheated' : i.firing ? 'firing' : 'ready';
  const heat = heatGauge(i.heat ?? 0, overheated);
  const shield = gauge(i.shield, i.shieldMax, HUD_LIMITS.shieldLow);
  const hull = gauge(i.hull, i.hullMax, HUD_LIMITS.hullCritical);
  const energy = gauge(i.energy, i.energyMax, 0.2);
  const label = `${i.ship}, ${i.weapon} ${WEAPON_TEXT[weaponState].toLowerCase()}: shield ${shield.pct}%, hull ${hull.pct}%, energy ${energy.pct}%, weapon heat ${heat.text.toLowerCase()}${i.boosting ? ', boosting' : ''}`;
  return {
    ship: i.ship.toUpperCase(),
    weapon: i.weapon.toUpperCase(),
    weaponState,
    weaponText: WEAPON_TEXT[weaponState],
    shield,
    hull,
    energy,
    heat,
    boosting: i.boosting,
    label,
    key: `${i.ship}|${i.weapon}|${weaponState}|${shield.text}|${hull.text}|${energy.text}|${heat.text}|${i.boosting}`,
  };
}

/** Cargo chip text: hold use and reactor cells. */
export function cargoText(used: number, cap: number, cells: number): string {
  return `HOLD ${used}/${cap} · CELLS ${cells}`;
}
