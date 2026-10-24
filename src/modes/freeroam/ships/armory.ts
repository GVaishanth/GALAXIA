/**
 * Armory rules (pure, Combat P03B, FR-TD-88): which weapons a ship can carry,
 * the weapon a flight starts with and the weapons in the in-flight switching
 * cycle (the rotation). No DOM, no storage: the Armory page (armoryPanel.ts)
 * and the shell call these and write the returned fleet to the profile.
 *
 *  - Compatibility comes from data only: a weapon fits a ship when the ship's
 *    roster entry lists the weapon's mount (config/weapons.ts). Every change
 *    goes through `setStart` / `setInRotation`, which re-check it, so a
 *    disabled button or a direct call can never arm an incompatible weapon.
 *  - The primary gun (plasma) is always in the rotation: no ship can be left
 *    without a usable primary weapon.
 *  - A setup is stored per ship (FleetState.weapons). Every read goes through
 *    `cleanSetup`, which removes weapons the ship cannot mount from the
 *    rotation itself and falls back to the ship's default start weapon, so a
 *    stale or tampered save never points at an unavailable weapon.
 *  - `armedLoadout(fleet)` is the interface the combat runtime reads: the
 *    flown ship, the weapons it can carry, its rotation and its start weapon.
 */
import { PRIMARY_WEAPON, WEAPON_BY_ID, WEAPONS, isWeaponId, type WeaponDef, type WeaponId } from '../../../config/weapons.ts';
import type { FleetState } from './hangar.ts';
import { SHIP_BY_ID, SHIPS } from './roster.ts';
import type { ShipId } from './types.ts';

/** A ship's weapon preferences. `rotation` is in catalogue order and always contains the primary gun and `start`. */
export interface WeaponSetup {
  readonly start: WeaponId;
  readonly rotation: readonly WeaponId[];
}

/** What the combat runtime needs for the flown ship. */
export interface ArmedLoadout {
  readonly ship: ShipId;
  /** Every weapon this ship can carry (catalogue order). */
  readonly compatible: readonly WeaponId[];
  /** The in-flight switching cycle (catalogue order; a subset of `compatible`, always with the primary gun). */
  readonly rotation: readonly WeaponId[];
  /** The weapon selected when a flight starts (always in `rotation`). */
  readonly start: WeaponId;
}

/** Can `ship` carry `weapon` at all (its roster entry lists the weapon's mount)? */
export function canMount(ship: ShipId, weapon: WeaponId): boolean {
  const s = SHIP_BY_ID.get(ship);
  const w = WEAPON_BY_ID.get(weapon);
  return !!s && !!w && s.mounts.includes(w.mount);
}

/** The weapons `ship` can carry, in catalogue order. */
export function compatibleWeapons(ship: ShipId): WeaponId[] {
  return WEAPONS.filter((w) => canMount(ship, w.id)).map((w) => w.id);
}

/** The roster ships that can carry `weapon`, in yard order. */
export function shipsFor(weapon: WeaponId): ShipId[] {
  return SHIPS.filter((s) => canMount(s.id, weapon)).map((s) => s.id);
}

const MOUNT_NAME: Readonly<Record<WeaponDef['mount'], string>> = { primary: 'gun hardpoint', 'missile-rack': 'missile rack', 'heavy-rack': 'heavy missile rack', 'nuke-bay': 'nuke bay' };

/** Plain reason why `ship` cannot carry `weapon` (null = it can). Names the ships that can. */
export function mountReason(ship: ShipId, weapon: WeaponId): string | null {
  if (canMount(ship, weapon)) return null;
  const w = WEAPON_BY_ID.get(weapon);
  const s = SHIP_BY_ID.get(ship);
  if (!w || !s) return 'Unknown weapon or ship.';
  const fits = shipsFor(weapon).map((id) => SHIP_BY_ID.get(id)!.name);
  const restricted = w.mount === 'nuke-bay' ? ' Restricted to advanced ships:' : ' Fitted on:';
  return `The ${s.name} has no ${MOUNT_NAME[w.mount]}.${restricted} ${fits.join(', ')}.`;
}

const order = (ids: Iterable<WeaponId>): WeaponId[] => {
  const set = new Set(ids);
  return WEAPONS.filter((w) => set.has(w.id)).map((w) => w.id);
};

/** The start weapon used when no valid preference exists. */
export function defaultStart(ship: ShipId): WeaponId {
  const d = SHIP_BY_ID.get(ship)?.defaultWeapon;
  return d && canMount(ship, d) && WEAPON_BY_ID.get(d)!.initialSelectable ? d : PRIMARY_WEAPON;
}

/** A new ship's setup: every compatible weapon in the cycle, starting on the ship's default. */
export function defaultSetup(ship: ShipId): WeaponSetup {
  return { start: defaultStart(ship), rotation: compatibleWeapons(ship) };
}

/** Can `weapon` be the start weapon of `ship`? */
export function canStartWith(ship: ShipId, weapon: WeaponId): boolean {
  return canMount(ship, weapon) && WEAPON_BY_ID.get(weapon)!.initialSelectable;
}

/**
 * Any stored or tampered setup made valid for `ship`: unknown, duplicate and
 * unmountable weapons leave the rotation, the primary gun is always in it, and
 * a start weapon that is not usable falls back to the ship's default.
 */
export function cleanSetup(ship: ShipId, raw: { readonly start?: unknown; readonly rotation?: unknown } | undefined): WeaponSetup {
  if (!raw) return defaultSetup(ship);
  const ids = Array.isArray(raw.rotation) ? raw.rotation.filter(isWeaponId) : compatibleWeapons(ship);
  const rotation = order([PRIMARY_WEAPON, ...ids.filter((id) => canMount(ship, id))]);
  const s = raw.start;
  const start = isWeaponId(s) && canStartWith(ship, s) && rotation.includes(s) ? s : defaultStart(ship);
  return { start, rotation: rotation.includes(start) ? rotation : order([...rotation, start]) };
}

/** The (cleaned) setup of `ship` in `fleet`. */
export function setupOf(fleet: FleetState, ship: ShipId): WeaponSetup {
  return cleanSetup(ship, fleet.weapons?.[ship]);
}

/** The interface for the combat runtime: everything about the flown ship's weapons, always valid. */
export function armedLoadout(fleet: FleetState): ArmedLoadout {
  const s = setupOf(fleet, fleet.active);
  return { ship: fleet.active, compatible: compatibleWeapons(fleet.active), rotation: s.rotation, start: s.start };
}

export type ArmoryRefusal = 'not-owned' | 'unknown-weapon' | 'incompatible' | 'not-initial' | 'primary-required';
export type ArmoryResult =
  | { readonly ok: true; readonly fleet: FleetState; readonly setup: WeaponSetup; readonly changed: boolean; readonly startReset: boolean }
  | { readonly ok: false; readonly reason: ArmoryRefusal };

const withSetup = (fleet: FleetState, ship: ShipId, setup: WeaponSetup): FleetState => ({ ...fleet, weapons: { ...(fleet.weapons ?? {}), [ship]: setup } });
const same = (a: WeaponSetup, b: WeaponSetup): boolean => a.start === b.start && a.rotation.join() === b.rotation.join();

function guard(fleet: FleetState, ship: ShipId, weapon: unknown): ArmoryRefusal | null {
  if (!fleet.owned.includes(ship)) return 'not-owned';
  if (!isWeaponId(weapon)) return 'unknown-weapon';
  if (!canMount(ship, weapon)) return 'incompatible';
  return null;
}

/** Make `weapon` the start weapon of `ship` (it joins the rotation if it was out). */
export function setStart(fleet: FleetState, ship: ShipId, weapon: unknown): ArmoryResult {
  const bad = guard(fleet, ship, weapon);
  if (bad) return { ok: false, reason: bad };
  const w = weapon as WeaponId;
  if (!WEAPON_BY_ID.get(w)!.initialSelectable) return { ok: false, reason: 'not-initial' };
  const cur = setupOf(fleet, ship);
  const next = cleanSetup(ship, { start: w, rotation: [...cur.rotation, w] });
  return { ok: true, fleet: withSetup(fleet, ship, next), setup: next, changed: !same(cur, next), startReset: false };
}

/**
 * Put `weapon` into (`on`) or take it out of the rotation of `ship`. The
 * primary gun cannot leave it. Taking out the start weapon moves the start
 * back to the ship's default (`startReset`).
 */
export function setInRotation(fleet: FleetState, ship: ShipId, weapon: unknown, on: boolean): ArmoryResult {
  const bad = guard(fleet, ship, weapon);
  if (bad) return { ok: false, reason: bad };
  const w = weapon as WeaponId;
  if (!on && w === PRIMARY_WEAPON) return { ok: false, reason: 'primary-required' };
  const cur = setupOf(fleet, ship);
  const rotation = on ? [...cur.rotation, w] : cur.rotation.filter((id) => id !== w);
  const startReset = !on && cur.start === w;
  const next = cleanSetup(ship, { start: startReset ? defaultStart(ship) : cur.start, rotation });
  return { ok: true, fleet: withSetup(fleet, ship, next), setup: next, changed: !same(cur, next), startReset };
}

/** Player-facing text for a refusal. */
export function refusalText(reason: ArmoryRefusal, ship: ShipId, weapon: unknown): string {
  const w = isWeaponId(weapon) ? WEAPON_BY_ID.get(weapon)! : null;
  switch (reason) {
    case 'incompatible':
      return w ? mountReason(ship, w.id)! : 'That weapon does not fit this ship.';
    case 'not-initial':
      return `The ${w?.name ?? 'weapon'} cannot be the start weapon; switch to it in flight.`;
    case 'primary-required':
      return 'The plasma cannon always stays in the cycle: it is the fallback that never runs dry.';
    case 'not-owned':
      return 'Only ships you own can be configured.';
    default:
      return 'Unknown weapon.';
  }
}

/** Setups for storage: one cleaned entry per owned ship that has one (ids are re-checked on load). */
export function setupsForSave(fleet: FleetState): Record<string, { readonly start: string; readonly rotation: readonly string[] }> {
  const out: Record<string, { start: string; rotation: string[] }> = {};
  for (const id of fleet.owned) {
    const raw = fleet.weapons?.[id];
    if (!raw) continue;
    const s = cleanSetup(id, raw);
    out[id] = { start: s.start, rotation: [...s.rotation] };
  }
  return out;
}
