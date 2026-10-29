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
import type { StealthStatus } from '../combat/stealth.ts';
import type { AbilityStatus } from '../combat/shipAbilities.ts';

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

/** `cooling`: an ordnance weapon that cannot fire yet (cooldown, in flight, empty); plasma never uses it. */
export type WeaponState = 'ready' | 'firing' | 'safe' | 'overheated' | 'cooling';

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
  /** The selected weapon (Combat P03C; the row under HEAT). Absent = plasma with no ordnance state. */
  readonly missile?: MissileCardInput;
}

/**
 * The selected weapon as the card needs it (plain numbers; the arsenal in
 * core/weapons/arsenal.ts and combat/playerMissile.ts own the state).
 */
export interface MissileCardInput {
  /** Row label: the catalogue's short name (PLASMA, HEAVY, LOCK-ON, NUKE). */
  readonly label: string;
  /** How it is fed: the gun (unlimited), a saved stock, or energy per launch. */
  readonly feed: 'gun' | 'stock' | 'energy';
  readonly stock: number;
  readonly capacity: number;
  /** 'cooldown' while this weapon's own cooldown runs. */
  readonly state: 'ready' | 'acquiring' | 'cooldown';
  readonly lock: number;
  readonly lockTicks: number;
  readonly cooldown: number;
  readonly cooldownTicks: number;
  /** One of this weapon's missiles is in flight. */
  readonly inFlight: boolean;
  /** Could fire now (`unavailable` = not fitted to this ship; never shown for a weapon in the rotation). */
  readonly gate: 'ok' | 'unavailable' | 'cooling' | 'empty' | 'lowEnergy' | 'busy';
  readonly notice: 'noTarget' | 'lowEnergy' | 'cooling' | 'empty' | 'unavailable' | 'busy' | 'lockLost' | 'launched' | 'hit' | 'kill' | 'miss' | 'blast' | null;
  /** P04 Admin Access sandbox: launches spend nothing (the gauge reads ∞ instead of a count). */
  readonly unlimited?: boolean | undefined;
}

export type MissileState = 'ready' | 'acquiring' | 'launching' | 'cooldown' | 'refused' | 'safe' | 'empty';

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
  /** Selected weapon row: fill = lock progress, cooldown recovered or magazine; text says the state (never colour alone). */
  readonly missile: Gauge;
  /** The row's label: the selected weapon's short name. */
  readonly missileLabel: string;
  readonly missileState: MissileState;
  /** A press during the cooldown (refused): the seconds stay, styled as a refusal. */
  readonly missileNudge: boolean;
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

const WEAPON_TEXT: Readonly<Record<WeaponState, string>> = { ready: 'READY', firing: 'FIRING', safe: 'SAFE', overheated: 'OVERHEAT', cooling: 'COOLING' };

/** Heat at or above which the gauge reads HOT (FR-TD-79). */
export const HEAT_HOT_AT = 0.7;

function heatGauge(level: number, overheated: boolean): Gauge {
  const pct = pctOf(level, 1);
  if (overheated) return { pct, text: 'OVERHEAT', low: true };
  const hot = level >= HEAT_HOT_AT;
  return { pct, text: hot ? `HOT ${pct}%` : `${pct}%`, low: hot };
}

/** Refusals: shown for the notice moment across the whole row (the longest is about 104 px at the card's 10 px). */
const MISSILE_REFUSAL = { noTarget: 'NO TARGET', lowEnergy: 'LOW ENERGY', lockLost: 'LOCK LOST', empty: 'EMPTY', unavailable: 'NOT FITTED', busy: 'IN FLIGHT' } as const;
/** Results: short enough for the value column (5 characters at most; 54 px on phones). */
const MISSILE_RESULT = { hit: 'HIT', kill: 'KILL', miss: 'MISS', blast: 'BLAST' } as const;

/**
 * The selected-weapon row (Combat P03 missile row, generalised in P03C).
 * Steady states fit the value column (5 characters at most): plasma reads
 * the infinity sign; a stocked weapon its count (3/4, fill = magazine) or
 * EMPTY; READY / LOCK (fill = lock) / AWAY (in flight) / seconds left (fill
 * = cooldown recovered) / SAFE; results HIT / KILL / MISS / BLAST. A refusal
 * (NO TARGET, LOW ENERGY, LOCK LOST, EMPTY, NOT FITTED, IN FLIGHT) is state
 * `refused`: for that moment the text takes the whole row (CSS). A press
 * during the cooldown keeps the seconds and sets `nudge`. `low` marks
 * "cannot fire now" for styling only; the text always says why.
 */
export function missileGauge(m: MissileCardInput | undefined, docked: boolean): { gauge: Gauge; state: MissileState; nudge: boolean } {
  if (!m || m.feed === 'gun') return { gauge: { pct: 100, text: docked ? 'SAFE' : '\u221e', low: docked }, state: docked ? 'safe' : 'ready', nudge: false };
  const recovered = pctOf(m.cooldownTicks - m.cooldown, m.cooldownTicks);
  if (docked) return { gauge: { pct: m.state === 'cooldown' ? recovered : 100, text: 'SAFE', low: true }, state: 'safe', nudge: false };
  if (m.state === 'acquiring') return { gauge: { pct: pctOf(m.lock, m.lockTicks), text: 'LOCK', low: false }, state: 'acquiring', nudge: false };
  if (m.state === 'cooldown') {
    if (m.inFlight) return { gauge: { pct: recovered, text: 'AWAY', low: true }, state: 'launching', nudge: false };
    const result = m.notice === 'hit' || m.notice === 'kill' || m.notice === 'miss' || m.notice === 'blast' ? MISSILE_RESULT[m.notice] : null;
    return { gauge: { pct: recovered, text: result ?? `${Math.ceil(m.cooldown / 60)}s`, low: true }, state: 'cooldown', nudge: m.notice === 'cooling' };
  }
  if (m.notice === 'noTarget' || m.notice === 'lowEnergy' || m.notice === 'lockLost' || m.notice === 'unavailable' || m.notice === 'busy') return { gauge: { pct: 100, text: MISSILE_REFUSAL[m.notice], low: true }, state: 'refused', nudge: false };
  if (m.unlimited === true) return { gauge: { pct: 100, text: '\u221e', low: false }, state: 'ready', nudge: false };
  if (m.feed === 'stock') {
    if (m.stock <= 0) return { gauge: { pct: 0, text: 'EMPTY', low: true }, state: m.notice === 'empty' ? 'refused' : 'empty', nudge: false };
    return { gauge: { pct: pctOf(m.stock, m.capacity), text: `${m.stock}/${m.capacity}`, low: false }, state: 'ready', nudge: false };
  }
  return { gauge: { pct: 100, text: 'READY', low: m.gate === 'lowEnergy' }, state: 'ready', nudge: false };
}

/** The header state text for the selected weapon (plasma keeps READY / FIRING / OVERHEAT). */
const ORDNANCE_TEXT: Readonly<Record<MissileState, string>> = { ready: 'READY', acquiring: 'LOCKING', launching: 'AWAY', cooldown: 'COOLING', refused: 'READY', safe: 'SAFE', empty: 'EMPTY' };

export function shipCard(i: ShipCardInput): ShipCard {
  const overheated = i.overheated === true && !i.docked;
  const weaponState: WeaponState = i.docked ? 'safe' : overheated ? 'overheated' : i.firing ? 'firing' : 'ready';
  const heat = heatGauge(i.heat ?? 0, overheated);
  const shield = gauge(i.shield, i.shieldMax, HUD_LIMITS.shieldLow);
  const hull = gauge(i.hull, i.hullMax, HUD_LIMITS.hullCritical);
  const energy = gauge(i.energy, i.energyMax, 0.2);
  const missile = missileGauge(i.missile, i.docked);
  const gun = !i.missile || i.missile.feed === 'gun';
  const weaponText = gun || i.docked ? WEAPON_TEXT[weaponState] : missile.state === 'refused' && i.missile?.stock === 0 && i.missile.feed === 'stock' ? 'EMPTY' : ORDNANCE_TEXT[missile.state];
  const missileLabel = i.missile?.label ?? 'PLASMA';
  const ammo = gun || i.missile?.unlimited === true ? 'unlimited' : i.missile?.feed === 'stock' ? `${i.missile.stock} of ${i.missile.capacity} left` : 'energy';
  const label = `${i.ship}, ${i.weapon} ${weaponText.toLowerCase()}: shield ${shield.pct}%, hull ${hull.pct}%, energy ${energy.pct}%, weapon heat ${heat.text.toLowerCase()}, ${missileLabel.toLowerCase()} ${missile.gauge.text === '\u221e' ? 'unlimited' : missile.gauge.text.toLowerCase()}, ammunition ${ammo}${i.boosting ? ', boosting' : ''}`;
  return {
    ship: i.ship.toUpperCase(),
    weapon: i.weapon.toUpperCase(),
    weaponState: gun ? weaponState : i.docked ? 'safe' : missile.state === 'ready' || missile.state === 'acquiring' ? 'ready' : 'cooling',
    weaponText,
    shield,
    hull,
    energy,
    heat,
    missile: missile.gauge,
    missileLabel,
    missileState: missile.state,
    missileNudge: missile.nudge,
    boosting: i.boosting,
    label,
    key: `${i.ship}|${i.weapon}|${weaponState}|${shield.text}|${hull.text}|${energy.text}|${heat.text}|${missileLabel}|${missile.gauge.text}|${missile.gauge.pct}|${missile.state}|${missile.nudge}|${i.boosting}`,
  };
}

/** Cargo chip text: hold use and reactor cells. */
export function cargoText(used: number, cap: number, cells: number): string {
  return `HOLD ${used}/${cap} · CELLS ${cells}`;
}

/** P07.2: the Silent Running control and the stealth status tag (flight HUD, every frame). */
export interface StealthHud {
  /** The SILENT button: its state, its two kinds of text and its accessible name. */
  readonly on: boolean;
  readonly state: string;
  readonly hint: string;
  readonly aria: string;
  /** The status tag lines (empty: no tag): Gravity Shadow and contact memory, only from the AI's own counts. */
  readonly tag: readonly string[];
}

/**
 * What the HUD says about stealth, from combat/stealth.ts stealthStatus (the
 * simulation's own counts; never geometry here). `key`: the bound Silent
 * Running key; `touch`: the touch layout (the button is tapped, not keyed).
 * Off: discoverable, not alarming (the key and what it does). On: on, low
 * signature, shield recharge paused, fire or boost ends it (shorter words on
 * touch, so the button stays clear of LOCK / NEXT TARGET on a 320 px phone). The tag never
 * claims protection from every hostile: it counts the blocked ones and says
 * how many still see the pilot.
 */
export function stealthHud(s: Pick<StealthStatus, 'silent' | 'tracking' | 'searching' | 'shadowed'>, key: string, touch: boolean): StealthHud {
  const tag: string[] = [];
  const k = touch ? '' : ` (${key})`; // the key only where a key is in use
  const n = (k: number): string => `${k} ${k === 1 ? 'HOSTILE' : 'HOSTILES'}`;
  if (s.shadowed > 0) tag.push('GRAVITY SHADOW', `HIDDEN FROM ${n(s.shadowed)}`);
  if (s.shadowed > 0 && s.tracking > 0) tag.push(`${n(s.tracking)} STILL TRACKING`);
  if (s.searching > 0) tag.push(`${n(s.searching)} SEARCHING`, 'LAST KNOWN POSITION');
  return s.silent
    ? { on: true, state: 'SILENT RUNNING', hint: touch ? 'LOW SIGNATURE\nSHIELD PAUSED\nFIRE/BOOST ENDS' : 'LOW SIGNATURE\nSHIELD RECHARGE PAUSED\nFIRE OR BOOST ENDS IT', aria: `Silent running is on${k}: low signature, shield recharge paused; firing or boosting ends it. Press to turn off`, tag }
    : { on: false, state: 'SILENT', hint: touch ? 'LOW SIGNATURE' : `${key} · LOW SIGNATURE`, aria: `Silent running${k}: off. Lowers your signature and pauses shield recharge`, tag };
}

/** P08.2: the ship ability control (HUD panel on a desktop, the touch button on a phone): one element, every frame. */
export interface AbilityHud {
  readonly show: boolean;
  /** ready / on (the effect is active) / cooling: the words carry it too, never colour alone. */
  readonly state: 'ready' | 'on' | 'cooling';
  readonly label: string;
  readonly hint: string;
  readonly aria: string;
}

/** A line split at the space nearest its middle (two short lines in the narrow HUD column). */
const halves = (t: string): string => {
  const m = t.length / 2;
  const i = [...t].reduce((b, c, j) => (c === ' ' && Math.abs(j - m) < Math.abs(b - m) ? j : b), -t.length);
  return i < 0 ? t : `${t.slice(0, i)}\n${t.slice(i + 1)}`;
};

/**
 * What the HUD says about the flown ship's ability, from combat/shipAbilities.ts
 * abilityStatus only (the run's ticks; no clock here, so a paused run shows a
 * frozen count). ACTIVE · 1.2 s while the effect runs (tenths), COOLDOWN · 18 s
 * while it recharges (whole seconds, rounded up), else READY with the bound key
 * (`key`, '' when unbound). `touch`: the short tag and no key or explanation (the
 * button is tapped); a desktop shows the name and the one-line explanation.
 * A refused press changes nothing here: the corner log says why.
 */
export function abilityHud(s: Pick<AbilityStatus, 'id' | 'name' | 'tag' | 'summary' | 'active' | 'activeTicks' | 'cooldownTicks'> | null, key: string, touch: boolean): AbilityHud {
  const t = (n: number): number => Math.max(0, Number.isFinite(n) ? n : 0) / 60;
  if (!s?.id) return { show: false, state: 'ready', label: '', hint: '', aria: '' };
  const state = s.active ? 'on' : s.cooldownTicks > 0 ? 'cooling' : 'ready';
  const now = state === 'on' ? `ACTIVE · ${(Math.ceil(t(s.activeTicks) * 10) / 10).toFixed(1)} s` : state === 'cooling' ? `COOLDOWN · ${Math.ceil(t(s.cooldownTicks))} s` : 'READY';
  const k = key && !touch ? `, key ${key}` : '';
  return {
    show: true,
    state,
    label: touch ? s.tag : s.name.toUpperCase(),
    hint: touch ? now : `${state === 'ready' && key ? `${key} · ` : ''}${now}\n${halves(s.summary)}`,
    aria: `${s.name}, ship ability${k}: ${now.toLowerCase().replace(' · ', ', ').replace(' s', ' seconds')}. ${s.summary}`,
  };
}
