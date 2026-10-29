/**
 * Ship signature abilities (P08.1): one active ability per hull, chosen by the
 * stable ship id (never the display name). Pure and deterministic: no DOM, no
 * clock, no randomness, no runtime import; every time is in fixed 60 Hz
 * simulation ticks (1 s = 60 ticks), so a paused run (not stepped) freezes the
 * effect and the cooldown alike.
 *
 * This module owns the definitions (one frozen table), the per-run state
 * shape, its tick and the small effect queries the existing systems call at
 * their own boundaries:
 *   Vector Burst       -> the boost tuning in sector/run.ts (the same flight path)
 *   Predator Focus     -> the lock-on acquisition in combat/playerMissile.ts
 *   Signal Calibration -> bearingSpread in sector/signal.ts
 *   Bulwark            -> damagePlayer in combat/world.ts
 *   Salvage Pulse, Deep Scan -> the contact scans in sector/run.ts
 * Activation, eligibility and the lifecycle live in sector/run.ts
 * (activateAbility), which owns the run. Nothing here is saved.
 *
 * Rules: an unknown ship has no ability (every query is neutral); one press
 * is at most one activation; a refused press consumes nothing; the effect
 * never outlasts durationTicks; the cooldown starts at activation, counts down
 * once per tick to 0 and never stacks or refills by itself.
 */
import type { SectorRun } from '../sector/run.ts';
import type { ShipId } from '../ships/types.ts';
import type { PlayerDamageSource } from './world.ts';

export type AbilityId = 'vector-burst' | 'predator-focus' | 'signal-calibration' | 'salvage-pulse' | 'bulwark' | 'deep-scan';

interface Base {
  readonly ship: ShipId;
  readonly name: string;
  /** Short HUD tag (P08.2 status representation). */
  readonly tag: string;
  readonly summary: string;
  readonly durationTicks: number;
  /** From activation (it includes the active period). */
  readonly cooldownTicks: number;
  /** An active emission: activating it ends Silent Running (like a boost or FIRE request). */
  readonly emits: boolean;
}

export type AbilityDef =
  /** Thrust and top speed multipliers through the boost tuning; eased in over rampTicks and out over the last fadeTicks. */
  | (Base & { readonly id: 'vector-burst'; readonly accelMul: number; readonly speedMul: number; readonly rampTicks: number; readonly fadeTicks: number })
  /** Lock-on missile: lock time multiplier (acquisition) and hold-cone multiplier (retention). Range, sight and the pick are unchanged. */
  | (Base & { readonly id: 'predator-focus'; readonly lockMul: number; readonly keepConeMul: number })
  /** Bearing error half-width multiplier for bearings recorded while active (the spread floor still applies). */
  | (Base & { readonly id: 'signal-calibration'; readonly spreadMul: number })
  /** Scan radius = sensor x rangeMul (salvage only). */
  | (Base & { readonly id: 'salvage-pulse'; readonly rangeMul: number })
  /** Incoming damage multiplier for combat hits (the sources that respect invulnerability). */
  | (Base & { readonly id: 'bulwark'; readonly damageMul: number })
  /** Scan radius = sensor x rangeMul (every POI marker and hostile the sensors could show). */
  | (Base & { readonly id: 'deep-scan'; readonly rangeMul: number });

type Entry<D> = D extends AbilityDef ? Omit<D, 'ship' | 'name' | 'durationTicks' | 'cooldownTicks'> & { readonly s: readonly [number, number] } : never;
/** Seconds -> ticks; the ship id from the key; the name from the id ("vector-burst" -> "Vector Burst"). */
const table = (t: Readonly<Record<ShipId, Entry<AbilityDef>>>): Readonly<Record<ShipId, AbilityDef>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(t).map(([ship, { s: [d, c], ...e }]) => [ship, Object.freeze({ ...e, ship, name: e.id.replace(/(^|-)(.)/g, (_, g: string, x: string) => (g ? ' ' : '') + x.toUpperCase()), durationTicks: d * 60, cooldownTicks: c * 60 })]),
    ) as Record<ShipId, AbilityDef>,
  );

/** The one table (seconds: [duration, cooldown]); tests, the HUD and the guide read it; nothing duplicates it. */
export const SHIP_ABILITIES = table({
  swift: { id: 'vector-burst', tag: 'BURST', summary: 'Stronger thrust and top speed for your own steering.', s: [1.75, 25], emits: true, accelMul: 1.9, speedMul: 1.35, rampTicks: 6, fadeTicks: 30 },
  shrike: { id: 'predator-focus', tag: 'FOCUS', summary: 'Lock-on missiles lock twice as fast, hold a wider cone.', s: [5, 28], emits: false, lockMul: 0.5, keepConeMul: 1.3 },
  petrel: { id: 'signal-calibration', tag: 'CALIB', summary: 'Signal bearings taken now have half the error.', s: [7, 30], emits: false, spreadMul: 0.5 },
  magpie: { id: 'salvage-pulse', tag: 'PULSE', summary: 'Marks salvage, derelicts, pods and your wreck far out.', s: [6, 30], emits: true, rangeMul: 1.75 },
  condor: { id: 'bulwark', tag: 'BULWARK', summary: '22% less damage from weapons, rams, mines and blasts.', s: [4, 40], emits: false, damageMul: 0.78 },
  albatross: { id: 'deep-scan', tag: 'SCAN', summary: 'Sensors reach 50% farther: markers and hostiles.', s: [6.5, 35], emits: true, rangeMul: 1.5 },
});

/** The ability of a ship id; null for anything unknown (fails safe). */
export const abilityOf = (ship: unknown): AbilityDef | null => (typeof ship === 'string' && Object.hasOwn(SHIP_ABILITIES, ship) ? SHIP_ABILITIES[ship as ShipId] : null);

/** Why a press does nothing (no cooldown is consumed). */
export type AbilityRefusal = 'unavailable' | 'docked' | 'paused' | 'active' | 'cooling' | 'noTarget' | 'noSignal' | 'noSalvage' | 'jammed';

/** What a scan shows: existing objects only, at their public positions (an anomaly's marker, never its source). */
export interface AbilityContact {
  readonly id: string;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
}

export interface AbilityState {
  /** Ticks of the active period left (0 = inactive). */
  active: number;
  /** Ticks until the next activation (0 = ready). */
  cooldown: number;
  /** The last refused press (cleared by an activation, by READY and by a lifecycle end). */
  refused: AbilityRefusal | null;
  /** Salvage Pulse / Deep Scan results while active (refreshed by the run; empty otherwise). */
  contacts: AbilityContact[];
  uses: number;
}

export const freshAbility = (): AbilityState => ({ active: 0, cooldown: 0, refused: null, contacts: [], uses: 0 });

/** End the active effect (lifecycle); the cooldown is kept. */
export function endAbility(st: AbilityState): void {
  st.active = 0;
  st.contacts = [];
  st.refused = null;
}

/** One tick: the effect and the cooldown count down; returns the edges ('end', 'ready') reached this tick. */
export function tickAbility(st: AbilityState): { end: boolean; ready: boolean } {
  const end = st.active > 0 && --st.active === 0;
  if (end) st.contacts = [];
  const ready = st.cooldown > 0 && --st.cooldown === 0;
  if (ready) st.refused = null;
  return { end, ready };
}

type AbilityHost = Pick<SectorRun, 'craft' | 'ability'>;

/** The flown ship's ability while its effect is active, if it is `id`. */
function live<I extends AbilityId>(run: AbilityHost, id: I): Extract<AbilityDef, { id: I }> | null {
  const d = abilityOf(run.craft.ship);
  return d && d.id === id && run.ability.active > 0 ? (d as Extract<AbilityDef, { id: I }>) : null;
}

/** Vector Burst level 0..1 this tick (eased; 0 when inactive, back to 0 by the end of the active period). */
export function burstLevel(run: AbilityHost): number {
  const d = live(run, 'vector-burst');
  if (!d) return 0;
  const left = run.ability.active;
  return Math.min(1, (d.durationTicks - left + 1) / d.rampTicks, left / d.fadeTicks);
}

/** Bulwark: the multiplier for one incoming hit (1 = unchanged). Star and hazard drain are not hits. */
export function incomingDamageMul(run: AbilityHost, source: PlayerDamageSource): number {
  const d = live(run, 'bulwark');
  return d && source !== 'star' && source !== 'hazard' ? d.damageMul : 1;
}

/** Predator Focus: the lock time for a lock-on weapon's own `lockTicks`. */
export function focusLockTicks(run: AbilityHost, lockTicks: number): number {
  const d = live(run, 'predator-focus');
  return d ? Math.max(1, Math.ceil(lockTicks * d.lockMul)) : lockTicks;
}

/** Predator Focus: the hold cone for the lock-on weapon's own `keepCone`. */
export function focusKeepCone(run: AbilityHost, keepCone: number): number {
  const d = live(run, 'predator-focus');
  return d ? Math.min(Math.PI, keepCone * d.keepConeMul) : keepCone;
}

/** Signal Calibration: the bearing spread multiplier (exactly 1 when inactive). */
export function calibration(run: AbilityHost): number {
  return live(run, 'signal-calibration')?.spreadMul ?? 1;
}

/** Read-only status for the HUD (P08.2) and the browser checks: never the owner of anything. */
export interface AbilityStatus {
  readonly id: AbilityId | null;
  readonly name: string;
  readonly tag: string;
  /** The one-line explanation from the table (P08.2 HUD). */
  readonly summary: string;
  /** A press now would pass the general gate (the target / signal / salvage checks run on the press). */
  readonly available: boolean;
  readonly active: boolean;
  readonly activeTicks: number;
  readonly durationTicks: number;
  readonly cooldownTicks: number;
  readonly cooldownMax: number;
  /** Why a press would be refused now (general gate), else the last refused press since the last activation / READY, else null. */
  readonly reason: AbilityRefusal | null;
  readonly contacts: readonly AbilityContact[];
}

/** The general gate: unknown ship, docked, not in flight, active, cooling (null = a press may proceed). */
export function abilityGate(run: Pick<SectorRun, 'craft' | 'ability' | 'docked' | 'phase' | 'disposed'>): AbilityRefusal | null {
  const st = run.ability;
  if (!abilityOf(run.craft.ship)) return 'unavailable';
  if (run.docked) return 'docked';
  if (run.phase !== 'flight' || run.disposed) return 'paused';
  if (st.active > 0) return 'active';
  return st.cooldown > 0 ? 'cooling' : null;
}

export function abilityStatus(run: Pick<SectorRun, 'craft' | 'ability' | 'docked' | 'phase' | 'disposed'>): AbilityStatus {
  const d = abilityOf(run.craft.ship);
  const st = run.ability;
  const gate = abilityGate(run);
  return {
    id: d?.id ?? null,
    name: d?.name ?? '',
    tag: d?.tag ?? '',
    summary: d?.summary ?? '',
    available: gate === null,
    active: st.active > 0,
    activeTicks: st.active,
    durationTicks: d?.durationTicks ?? 0,
    cooldownTicks: st.cooldown,
    cooldownMax: d?.cooldownTicks ?? 0,
    reason: gate ?? st.refused,
    contacts: st.contacts,
  };
}

/** The corner-log line for an ability event (the shell shows it; no second copy of the names). */
export function abilityLine(e: { readonly id: AbilityId | null; readonly change: 'start' | 'end' | 'ready' | 'refused'; readonly why?: AbilityRefusal | undefined; readonly ticks?: number | undefined; readonly found?: number | undefined; readonly hostiles?: number | undefined }): string {
  const n = (Object.values(SHIP_ABILITIES).find((a) => a.id === e.id)?.name ?? 'Ship ability').toUpperCase();
  // a scan's result: Salvage Pulse counts its targets; Deep Scan counts markers and hostiles apart (each contact once)
  const f = e.found ?? 0;
  const h = e.hostiles;
  if (e.change !== 'refused') return `${n} ${e.change === 'start' ? 'ACTIVE' : e.change === 'end' ? 'ENDED' : 'READY'}${e.found === undefined ? '' : h === undefined ? ` · ${f} FOUND` : ` · ${f - h} MARKER${f - h === 1 ? '' : 'S'} · ${h} HOSTILE${h === 1 ? '' : 'S'}`}`;
  // the refusal id in words ("noTarget" -> "NO TARGET"), with the seconds left while cooling
  return `${n} · ${(e.why ?? 'unavailable').replace(/[A-Z]/g, ' $&').toUpperCase()}${e.why === 'cooling' && e.ticks ? ` ${Math.ceil(e.ticks / 60)} s` : ''}`;
}
