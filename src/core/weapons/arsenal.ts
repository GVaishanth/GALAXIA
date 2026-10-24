/**
 * Weapon arsenal runtime (Combat P03C, FR-TD-89): the mode-neutral state of
 * the weapons a pilot carries during one run. Pure (imports config only), so
 * Free Roam's sector runtime and the Classic engine share the same rules:
 *
 *  - the rotation is the order of the shared catalogue (config/weapons.ts),
 *    restricted to what the ship can mount; plasma is always in it;
 *  - the selected weapon is one of the rotation; an invalid start falls back
 *    to the first valid weapon (plasma);
 *  - cycling steps once per request, wraps, and never leaves the rotation;
 *  - every weapon keeps its own cooldown, and every cooldown keeps ticking
 *    whichever weapon is selected (switching never resets or skips one);
 *  - a weapon outside the ship's compatible set can never be fired, even if
 *    something forces it into the selection (validated here, the gameplay
 *    layer, not by the UI).
 *
 * Ammunition is not stored here: stock counts live in the mode's own saved
 * or per-run record (Free Roam: the profile's `ordnance`; Classic: the run's
 * magazine) and are passed to `fireGate`. No second inventory.
 */
import { PRIMARY_WEAPON, WEAPON_BY_ID, WEAPON_IDS, isWeaponId, type WeaponId } from '../../config/weapons.ts';

/** What a mode hands the runtime: the ship's mountable weapons, its saved rotation and start weapon. */
export interface ArsenalSpec {
  readonly compatible: readonly WeaponId[];
  readonly rotation: readonly WeaponId[];
  readonly start: WeaponId;
}

export interface Arsenal {
  /** Weapons the flown ship can mount (the only ones that can ever fire). */
  readonly compatible: readonly WeaponId[];
  /** Weapons reachable by switching, in catalogue order. */
  readonly rotation: readonly WeaponId[];
  selected: WeaponId;
  /** Ticks until each weapon can fire again (0 = ready). */
  readonly cooldown: Record<WeaponId, number>;
}

/** Why a weapon cannot fire right now ('ok' = it can). */
export type FireGate = 'ok' | 'unavailable' | 'cooling' | 'empty' | 'lowEnergy' | 'busy';

export interface FireContext {
  /** Stock left for counted weapons (ignored for others). */
  readonly stock: (id: WeaponId) => number;
  /** Energy available (energy-cost weapons); null = the mode has no energy (cost ignored). */
  readonly energy: number | null;
  /** Projectiles of this weapon in flight. */
  readonly live: number;
}

const freshCooldowns = (): Record<WeaponId, number> => Object.fromEntries(WEAPON_IDS.map((id) => [id, 0])) as Record<WeaponId, number>;

/** Clean a rotation: known, compatible, catalogue order, no duplicates, plasma always included. */
export function validRotation(compatible: readonly WeaponId[], rotation: readonly unknown[]): WeaponId[] {
  const ok = new Set(rotation.filter((w): w is WeaponId => isWeaponId(w) && compatible.includes(w)));
  ok.add(PRIMARY_WEAPON);
  return WEAPON_IDS.filter((id) => ok.has(id));
}

export function createArsenal(spec: ArsenalSpec, keep?: Arsenal): Arsenal {
  const compatible = WEAPON_IDS.filter((id) => spec.compatible.includes(id) || id === PRIMARY_WEAPON);
  const rotation = validRotation(compatible, spec.rotation);
  const start = rotation.includes(spec.start) && WEAPON_BY_ID.get(spec.start)!.initialSelectable ? spec.start : rotation[0]!;
  const cooldown = freshCooldowns();
  // a re-arm (ship change) keeps the clock of every weapon: no cooldown reset by swapping ships
  if (keep) for (const id of WEAPON_IDS) cooldown[id] = keep.cooldown[id];
  return { compatible, rotation, selected: start, cooldown };
}

/**
 * Step the selection once (`dir` 1 = next, -1 = previous), wrapping. A weapon
 * the ship cannot mount is skipped. Returns true when the selection changed.
 */
export function cycleWeapon(a: Arsenal, dir: 1 | -1): boolean {
  const usable = a.rotation.filter((id) => a.compatible.includes(id));
  if (usable.length < 2) {
    if (!usable.includes(a.selected) && usable[0]) a.selected = usable[0];
    return false;
  }
  const i = usable.indexOf(a.selected);
  const next = usable[(((i < 0 ? 0 : i + dir) % usable.length) + usable.length) % usable.length]!;
  if (next === a.selected) return false;
  a.selected = next;
  return true;
}

/** One tick of every cooldown (selected or not). `scale` < 1 only if a mode slows its pilot (none does). */
export function tickArsenal(a: Arsenal, scale = 1): string[] {
  const ready: string[] = [];
  for (const id of WEAPON_IDS) {
    if (a.cooldown[id] <= 0) continue;
    a.cooldown[id] = Math.max(0, a.cooldown[id] - scale);
    if (a.cooldown[id] === 0) ready.push(id);
  }
  return ready;
}

/** Whether `id` can fire now. The order of the checks is the order of the feedback the pilot sees. */
export function fireGate(a: Arsenal, id: WeaponId, ctx: FireContext): FireGate {
  const w = WEAPON_BY_ID.get(id);
  if (!w || !a.compatible.includes(id) || !a.rotation.includes(id)) return 'unavailable';
  if (w.fire === 'fitted-gun') return 'ok'; // the gun has its own cadence and heat (mode code)
  if (a.cooldown[id] > 0) return 'cooling';
  if (ctx.live >= w.projectile.maxLive) return 'busy';
  if (w.ammo.kind === 'stock' && ctx.stock(id) <= 0) return 'empty';
  if (w.ammo.kind === 'energy' && ctx.energy !== null && ctx.energy < w.ammo.cost) return 'lowEnergy';
  return 'ok';
}

/** Start the cooldown of `id` (call at launch). */
export function startCooldown(a: Arsenal, id: WeaponId): void {
  const w = WEAPON_BY_ID.get(id);
  if (w && w.fire === 'ordnance') a.cooldown[id] = w.cooldownTicks;
}

/** 0..1 of the cooldown still to run (HUD). */
export function cooldownLeft(a: Arsenal, id: WeaponId): number {
  const w = WEAPON_BY_ID.get(id);
  return w && w.fire === 'ordnance' && a.cooldown[id] > 0 ? Math.min(1, a.cooldown[id] / w.cooldownTicks) : 0;
}
