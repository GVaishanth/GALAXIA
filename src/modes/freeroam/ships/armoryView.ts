/**
 * Armory view model (pure, Combat P03B, FR-TD-88): what the Armory page shows,
 * computed from the shared weapon catalogue (config/weapons.ts), the ship's
 * mounts (armory.ts) and the saved ammunition. No DOM, no storage, no clock.
 *
 * Units are the same everywhere on the page: distances in px (the game's art
 * px), times in seconds, speeds in px/s, damage in hit points. Nothing is
 * folded into a single power score: weapons differ along several axes.
 */
import { WEAPON_BY_ID, WEAPONS, type OrdnanceWeapon, type WeaponDef, type WeaponId } from '../../../config/weapons.ts';
import { canMount, canStartWith, mountReason, setupOf, shipsFor } from './armory.ts';
import type { FleetState } from './hangar.ts';
import { SHIP_BY_ID, SHIPS } from './roster.ts';
import type { ShipId, WeaponProfile } from './types.ts';

const TICK_S = 1 / 60;
const sec = (ticks: number): string => `${(ticks * TICK_S).toFixed(ticks % 60 === 0 ? 0 : 1)} s`;

/** How a weapon stands on the selected ship. */
export type WeaponState = 'start' | 'rotation' | 'off' | 'unavailable';

export function weaponState(fleet: FleetState, ship: ShipId, weapon: WeaponId): WeaponState {
  if (!canMount(ship, weapon)) return 'unavailable';
  const s = setupOf(fleet, ship);
  if (s.start === weapon) return 'start';
  return s.rotation.includes(weapon) ? 'rotation' : 'off';
}

export const STATE_TEXT: Readonly<Record<WeaponState, string>> = { start: 'START · IN CYCLE', rotation: 'IN CYCLE', off: 'NOT IN CYCLE', unavailable: 'NOT FITTED' };

/** Ammunition as the player sees it: the saved count for stocked weapons, never anything else. */
export interface AmmoLine {
  /** Compact badge: "∞", "30 EN", "4 / 4". */
  readonly badge: string;
  /** Full sentence for the details. */
  readonly text: string;
  /** Saved count and capacity (stocked weapons only). */
  readonly count: number | null;
  readonly capacity: number | null;
}

export function ammoLine(w: WeaponDef, ordnance: Readonly<Record<string, number>>, energyCap: number): AmmoLine {
  const a = w.ammo;
  if (a.kind === 'unlimited') return { badge: '∞', text: 'Unlimited: it never runs dry.', count: null, capacity: null };
  if (a.kind === 'energy') {
    const per = a.cost > 0 ? Math.floor(energyCap / a.cost) : 0;
    return { badge: `${a.cost} EN`, text: `${a.cost} boost energy per launch (${per} per full bar of ${Math.round(energyCap)}); no count to run out.`, count: null, capacity: null };
  }
  const n = ordnance[w.id] ?? 0;
  return { badge: `${n} / ${a.capacity}`, text: `${n} of ${a.capacity} aboard (saved). Refilled to ${a.capacity} whenever you dock at a station.`, count: n, capacity: a.capacity };
}

/** Distance a projectile covers in its life (launch boost, then acceleration to top speed), excluding the ship's own speed. */
export function flightDistance(w: OrdnanceWeapon): number {
  const p = w.projectile;
  const life = p.lifeTicks * TICK_S;
  const v0 = Math.min(p.launchSpeed, p.speed);
  const tAcc = Math.min(life, (p.speed - v0) / p.accel);
  return v0 * tAcc + 0.5 * p.accel * tAcc * tAcc + p.speed * (life - tAcc);
}

/** Damage at distance `d` from a detonation (0 outside the blast). */
export function blastDamageAt(w: OrdnanceWeapon, d: number): number {
  const b = w.blast;
  if (!b || d > b.radius) return 0;
  const k = Math.max(0, d) / b.radius;
  return b.damage * (1 - k * (1 - b.edgeMul));
}

export interface DetailRow {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

/** The fitted gun as plasma numbers (the profile the flight uses, upgrades included). */
export function gunRows(gun: WeaponProfile, gunName: string): DetailRow[] {
  const rate = 60 / gun.cooldownTicks;
  return [
    { label: 'FITTED GUN', value: gunName },
    { label: 'DAMAGE', value: `${gun.damage} per bolt · ${gun.bolts === 2 ? '2 bolts' : '1 bolt'} per volley` },
    { label: 'FIRE RATE', value: `${rate.toFixed(1)} volleys/s`, note: `${(rate * gun.damage * gun.bolts).toFixed(1)} dmg/s if every bolt hits` },
    { label: 'BOLT SPEED', value: `${gun.shotSpeed} px/s`, note: 'plus your own speed' },
    { label: 'REACH', value: `${Math.round((gun.shotSpeed * gun.lifeTicks) / 60)} px`, note: 'bolt travel at rest' },
  ];
}

export function ordnanceRows(w: OrdnanceWeapon): DetailRow[] {
  const rows: DetailRow[] = [];
  const g = w.guidance;
  if (g.kind === 'lock') {
    const q = g.acquire;
    rows.push({ label: 'TARGETING', value: `Lock-on · ${sec(q.lockTicks)} lock`, note: `target within ${q.range} px and ±${Math.round((q.cone * 180) / Math.PI)}° of the nose; held to ${q.keepRange} px` });
    rows.push({ label: 'GUIDANCE', value: `Steers after the target · turns ${g.turn} rad/s`, note: `flies straight ${sec(g.lostLife)} more if the target is lost` });
  } else rows.push({ label: 'TARGETING', value: 'None: no lock needed', note: 'flies straight where the nose points' });
  rows.push({ label: 'DIRECT HIT', value: `${w.impactDamage} dmg` });
  if (w.blast) rows.push({ label: 'BLAST', value: `${w.blast.radius} px radius`, note: `${w.blast.damage} dmg at the centre, ${Math.round(w.blast.damage * w.blast.edgeMul)} at the edge${w.impactDamage ? '; the ship hit directly is not hit twice' : ''}` });
  rows.push({ label: 'FLIGHT', value: `${w.projectile.speed} px/s top · ${sec(w.projectile.lifeTicks)}`, note: `≈ ${Math.round(flightDistance(w))} px, then it ${w.projectile.onExpiry === 'detonate' ? 'detonates (timed fuse)' : 'fizzles with no damage'}` });
  if (w.dilation) {
    const d = w.dilation;
    rows.push({ label: 'TIME DILATION', value: `${d.scale}× speed for ${sec(d.durationTicks)}`, note: `hostile ships and shots within ${d.radius} px of the blast; your ship is never slowed` });
  }
  rows.push({ label: 'COOLDOWN', value: sec(w.cooldownTicks), note: 'from one launch to the next' });
  if (w.damageRules.bossMul < 1) rows.push({ label: 'EXCEPTION', value: `Capital ships take ${Math.round(w.damageRules.bossMul * 100)}%` });
  return rows;
}

/** Every roster ship with whether it can carry `weapon`. */
export function compatibility(weapon: WeaponId): { readonly ship: ShipId; readonly name: string; readonly fits: boolean }[] {
  return SHIPS.map((s) => ({ ship: s.id, name: s.name, fits: canMount(s.id, weapon) }));
}

/** The availability line for the selected ship (with the reason when it cannot). */
export function availability(fleet: FleetState, ship: ShipId, weapon: WeaponId): { readonly ok: boolean; readonly text: string } {
  const why = mountReason(ship, weapon);
  const name = SHIP_BY_ID.get(ship)!.name;
  if (why) return { ok: false, text: why };
  const w = WEAPON_BY_ID.get(weapon)!;
  const st = weaponState(fleet, ship, weapon);
  const tail = !canStartWith(ship, weapon) ? ' It can be switched to in flight, but never selected as the start weapon.' : '';
  const restricted = w.mount === 'nuke-bay' ? ` Advanced ships only (${shipsFor(weapon).map((id) => SHIP_BY_ID.get(id)!.name).join(', ')}).` : '';
  return { ok: true, text: `Fits the ${name}: ${STATE_TEXT[st].toLowerCase()}.${restricted}${tail}` };
}

/** Comparison of the two missiles and the nuke on the same units (no combined score). */
export interface ComparisonColumn {
  readonly id: WeaponId;
  readonly short: string;
  readonly guidance: string;
  readonly lock: string;
  readonly blast: number;
  /** Blast radius on the comparison's own scale (largest = 1). */
  readonly blastFill: number;
  readonly centre: string;
  readonly direct: string;
  readonly cooldown: string;
  readonly ammo: string;
}

export function ordnanceComparison(): ComparisonColumn[] {
  const ords = WEAPONS.filter((w): w is OrdnanceWeapon => w.fire === 'ordnance');
  const maxR = Math.max(...ords.map((w) => w.blast?.radius ?? 0), 1);
  return ords.map((w) => ({
    id: w.id,
    short: w.short,
    guidance: w.guidance.kind === 'lock' ? 'Lock-on' : 'Aimed',
    lock: w.guidance.kind === 'lock' ? sec(w.guidance.acquire.lockTicks) : '—',
    blast: w.blast?.radius ?? 0,
    blastFill: (w.blast?.radius ?? 0) / maxR,
    centre: w.blast ? `${w.blast.damage}` : '—',
    direct: `${w.impactDamage}`,
    cooldown: sec(w.cooldownTicks),
    ammo: w.ammo.kind === 'stock' ? `${w.ammo.capacity} (dock)` : w.ammo.kind === 'energy' ? `${w.ammo.cost} energy` : '∞',
  }));
}

/**
 * Illustration data for the bay diagram: a patrol of `count` fighters spaced
 * `spacing` px apart around the detonation point, and how many the blast
 * reaches (centres inside the radius). Plasma and a direct hit reach one.
 */
export function blastCatch(w: WeaponDef, spacing: number, count: number): { readonly offsets: readonly (readonly [number, number])[]; readonly caught: number } {
  // a fixed loose wedge: centre, then rings outward (deterministic, no randomness)
  const ring = [[0, 0], [1, 0.6], [-1, 0.6], [0.5, -0.9], [-0.5, -0.9], [2, 1.2], [-2, 1.2]] as const;
  const offsets = ring.slice(0, Math.max(1, Math.min(count, ring.length))).map(([x, y]) => [x * spacing, y * spacing] as const);
  if (w.fire !== 'ordnance' || !w.blast) return { offsets, caught: 1 };
  const r = w.blast.radius;
  return { offsets, caught: offsets.filter(([x, y]) => Math.hypot(x, y) <= r).length };
}

/** What runs in flight today, shown under the weapon name. */
export function runtimeLine(w: WeaponDef): { readonly status: 'live' | 'partial' | 'pending'; readonly label: string; readonly note: string } {
  const label = w.runtime.status === 'live' ? 'LIVE IN FLIGHT' : w.runtime.status === 'partial' ? 'LIVE · BLAST COMING' : 'NOT FIREABLE YET';
  return { status: w.runtime.status, label, note: w.runtime.note };
}
