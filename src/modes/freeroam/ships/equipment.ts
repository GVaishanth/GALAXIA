/**
 * Equipment foundations (Free Roam Prompt 8): the module catalogue, slot and
 * weapon-class compatibility, loadout validation and stat derivation.
 *
 * Rules (FR-TD-48):
 *  - every module has exactly one slot type (weapon, shield, engine, sensor, cargo);
 *  - a loadout may not fit more modules of a type than the ship has slots;
 *  - a weapon fits only if the ship's hardpoints accept its class, and a ship
 *    always carries at least one weapon (slot 0 is the one that fires);
 *  - modules change stats only through bounded modifiers: (base + Σadd) × Πmul,
 *    and every derived stat is clamped to STAT_BOUNDS, so no combination can
 *    produce a negative, zero-where-it-matters, NaN or runaway value.
 * Modules are built at the fabricator (Prompt 10) or bought at the exchange
 * (Prompt 11) and fitted through the same rules; per-ship upgrade tracks
 * (upgrades.ts) feed the same modifier sum and product, then the same clamp.
 */
import { SHIP_BY_ID } from './roster.ts';
import { SLOT_TYPES, STAT_KEYS, WEAPON_CLASSES, type DerivedShip, type EquipmentItem, type Loadout, type ShipDef, type ShipId, type ShipStats, type SlotType, type StatKey, type StatModifiers, type WeaponProfile } from './types.ts';

/** Inclusive bounds of every derived stat. */
export const STAT_BOUNDS: Readonly<Record<StatKey, readonly [number, number]>> = Object.freeze({
  hull: [20, 400],
  shield: [0, 400],
  shieldRegen: [0, 20],
  accel: [400, 2200],
  maxSpeed: [160, 520],
  turnRate: [3, 16],
  energy: [0, 300],
  energyRegen: [0, 60],
  cargo: [0, 400],
  sensor: [300, 2400],
  travel: [0.4, 2],
});

/** A single module's multiplier must stay inside this range (validated). */
export const MODULE_MUL_RANGE = Object.freeze([0.5, 2] as const);

export const EQUIPMENT: readonly EquipmentItem[] = [
  /* weapons */
  {
    id: 'pulse-cannon',
    slot: 'weapon',
    weaponClass: 'light',
    name: 'Pulse Cannon',
    description: 'Reliable light cannon: one bolt every 0.15 s.',
    weapon: { cooldownTicks: 9, damage: 1, shotSpeed: 640, lifeTicks: 54, bolts: 1, spread: 0 },
    mods: {},
  },
  {
    id: 'needle-repeater',
    slot: 'weapon',
    weaponClass: 'light',
    name: 'Needle Repeater',
    description: 'Rapid light repeater with a shorter reach.',
    weapon: { cooldownTicks: 6, damage: 1, shotSpeed: 700, lifeTicks: 38, bolts: 1, spread: 0 },
    mods: {},
  },
  {
    id: 'twin-pulse',
    slot: 'weapon',
    weaponClass: 'medium',
    name: 'Twin Pulse Battery',
    description: 'Medium battery firing paired bolts.',
    weapon: { cooldownTicks: 10, damage: 1, shotSpeed: 660, lifeTicks: 52, bolts: 2, spread: 9 },
    mods: {},
  },
  {
    id: 'lance-driver',
    slot: 'weapon',
    weaponClass: 'heavy',
    name: 'Lance Driver',
    description: 'Heavy driver: slow, fast bolts that hit three times as hard.',
    weapon: { cooldownTicks: 20, damage: 3, shotSpeed: 780, lifeTicks: 58, bolts: 1, spread: 0 },
    mods: { mul: { maxSpeed: 0.97 } },
  },
  /* shields */
  { id: 'deflector', slot: 'shield', name: 'Deflector Grid', description: 'Standard shield generator.', mods: {} },
  { id: 'bastion-array', slot: 'shield', name: 'Bastion Array', description: 'Heavy shield array: +40 capacity, faster recharge, slightly sluggish.', mods: { add: { shield: 40, shieldRegen: 2 }, mul: { accel: 0.95 } } },
  /* engines */
  { id: 'ion-drive', slot: 'engine', name: 'Ion Drive', description: 'Standard sublight drive.', mods: {} },
  { id: 'sprint-thrusters', slot: 'engine', name: 'Sprint Thrusters', description: 'Tuned thrusters: +10% thrust, +5% top speed, faster boost recharge.', mods: { add: { energyRegen: 4 }, mul: { accel: 1.1, maxSpeed: 1.05 } } },
  { id: 'cruise-drive', slot: 'engine', name: 'Cruise Drive', description: 'Long-haul drive: 15% less drive charge per route, +30 boost energy.', mods: { add: { energy: 30 }, mul: { travel: 0.85 } } },
  /* sensors */
  { id: 'survey-scanner', slot: 'sensor', name: 'Survey Scanner', description: 'Standard sensor suite.', mods: {} },
  { id: 'deep-array', slot: 'sensor', name: 'Deep Sensor Array', description: 'Long-baseline array: +450 sensor range.', mods: { add: { sensor: 450 } } },
  /* cargo */
  { id: 'cargo-pod', slot: 'cargo', name: 'Cargo Pod', description: 'Sealed pod: +20 hold capacity.', mods: { add: { cargo: 20 } } },
  { id: 'salvage-rig', slot: 'cargo', name: 'Salvage Rig', description: 'Industrial hold frame: +40 capacity, slightly slower.', mods: { add: { cargo: 40 }, mul: { maxSpeed: 0.97 } } },
];

export const EQUIPMENT_BY_ID: ReadonlyMap<string, EquipmentItem> = new Map(EQUIPMENT.map((e) => [e.id, e]));

/* --------------------------------------------------------------- validation */

export type LoadoutIssue =
  | { readonly code: 'unknown-item'; readonly slot: SlotType; readonly item: string }
  | { readonly code: 'wrong-slot'; readonly slot: SlotType; readonly item: string }
  | { readonly code: 'too-many'; readonly slot: SlotType; readonly count: number; readonly max: number }
  | { readonly code: 'weapon-class'; readonly item: string; readonly weaponClass: string }
  | { readonly code: 'no-weapon' };

/** Every reason a loadout cannot be fitted to a ship (empty = valid). */
export function loadoutIssues(ship: ShipDef, loadout: Loadout): LoadoutIssue[] {
  const out: LoadoutIssue[] = [];
  for (const slot of SLOT_TYPES) {
    const ids = loadout[slot] ?? [];
    if (ids.length > ship.slots[slot]) out.push({ code: 'too-many', slot, count: ids.length, max: ship.slots[slot] });
    for (const id of ids) {
      const item = EQUIPMENT_BY_ID.get(id);
      if (!item) out.push({ code: 'unknown-item', slot, item: id });
      else if (item.slot !== slot) out.push({ code: 'wrong-slot', slot, item: id });
      else if (item.slot === 'weapon' && !ship.weaponClasses.includes(item.weaponClass)) out.push({ code: 'weapon-class', item: id, weaponClass: item.weaponClass });
    }
  }
  if ((loadout.weapon ?? []).length === 0) out.push({ code: 'no-weapon' });
  return out;
}

export function isValidLoadout(ship: ShipDef, loadout: Loadout): boolean {
  return loadoutIssues(ship, loadout).length === 0;
}

/** Can `itemId` go into the `index`-th slot of its type on `ship` (replacing what is there)? */
export function canFit(ship: ShipDef, loadout: Loadout, itemId: string, index: number): boolean {
  const item = EQUIPMENT_BY_ID.get(itemId);
  if (!item || !Number.isInteger(index) || index < 0 || index >= ship.slots[item.slot]) return false;
  return isValidLoadout(ship, fitItem(loadout, item.slot, index, itemId));
}

/** Pure: the loadout with `itemId` in slot `index` of `slot` (null = empty the slot). Not validated. */
export function fitItem(loadout: Loadout, slot: SlotType, index: number, itemId: string | null): Loadout {
  const list = [...(loadout[slot] ?? [])];
  if (itemId === null) list.splice(index, 1);
  else if (index < list.length) list[index] = itemId;
  else list.push(itemId);
  return { ...loadout, [slot]: list };
}

/** A clean copy of a loadout (unknown slot keys dropped, missing ones empty). */
export function normalLoadout(raw: Partial<Record<string, readonly string[]>>): Loadout {
  const out = {} as Record<SlotType, readonly string[]>;
  for (const s of SLOT_TYPES) out[s] = Array.isArray(raw[s]) ? [...raw[s]!] : [];
  return out;
}

/** Is a module's modifier set within the allowed shape (finite, bounded multipliers)? */
export function modifiersValid(item: EquipmentItem): boolean {
  for (const [k, v] of Object.entries(item.mods.add ?? {})) {
    if (!STAT_KEYS.includes(k as StatKey) || typeof v !== 'number' || !Number.isFinite(v)) return false;
    const [lo, hi] = STAT_BOUNDS[k as StatKey];
    if (Math.abs(v) > hi - lo) return false;
  }
  for (const [k, v] of Object.entries(item.mods.mul ?? {})) {
    if (!STAT_KEYS.includes(k as StatKey) || typeof v !== 'number' || !Number.isFinite(v) || v < MODULE_MUL_RANGE[0] || v > MODULE_MUL_RANGE[1]) return false;
  }
  if (item.slot === 'weapon') {
    const w = item.weapon;
    if (!WEAPON_CLASSES.includes(item.weaponClass)) return false;
    if (!(w.cooldownTicks >= 3 && w.cooldownTicks <= 60 && w.damage >= 1 && w.damage <= 10 && w.shotSpeed >= 200 && w.shotSpeed <= 1400 && w.lifeTicks >= 10 && w.lifeTicks <= 120)) return false;
    if (w.bolts !== 1 && w.bolts !== 2) return false;
  }
  return true;
}

/* --------------------------------------------------------------- derivation */

const clamp = (k: StatKey, v: number): number => {
  const [lo, hi] = STAT_BOUNDS[k];
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
};

/**
 * (base + Σadd) × Πmul for every stat, clamped to STAT_BOUNDS. Unknown or
 * misplaced modules are ignored. `extra` = further validated modifier sets
 * (Prompt 11: installed upgrades), applied with the modules in the same sum
 * and product, so the result is still clamped once.
 */
export function deriveStats(ship: ShipDef, loadout: Loadout, extra: readonly StatModifiers[] = []): ShipStats {
  const add: Record<string, number> = {};
  const mul: Record<string, number> = {};
  for (const m of extra) {
    for (const [k, v] of Object.entries(m.add ?? {})) if (STAT_KEYS.includes(k as StatKey) && Number.isFinite(v)) add[k] = (add[k] ?? 0) + v;
    for (const [k, v] of Object.entries(m.mul ?? {})) if (STAT_KEYS.includes(k as StatKey) && Number.isFinite(v) && v >= MODULE_MUL_RANGE[0] && v <= MODULE_MUL_RANGE[1]) mul[k] = (mul[k] ?? 1) * v;
  }
  for (const slot of SLOT_TYPES) {
    for (const id of (loadout[slot] ?? []).slice(0, ship.slots[slot])) {
      const item = EQUIPMENT_BY_ID.get(id);
      if (!item || item.slot !== slot || !modifiersValid(item)) continue;
      for (const [k, v] of Object.entries(item.mods.add ?? {})) add[k] = (add[k] ?? 0) + v;
      for (const [k, v] of Object.entries(item.mods.mul ?? {})) mul[k] = (mul[k] ?? 1) * v;
    }
  }
  const out = {} as Record<StatKey, number>;
  for (const k of STAT_KEYS) out[k] = clamp(k, (ship.base[k] + (add[k] ?? 0)) * (mul[k] ?? 1));
  return out;
}

/** Fallback weapon if a loadout somehow has none (never happens for a validated loadout). */
export const FALLBACK_WEAPON = (EQUIPMENT_BY_ID.get('pulse-cannon') as Extract<EquipmentItem, { slot: 'weapon' }>).weapon;

/** Weapon tuning from upgrades (Prompt 11): multipliers inside WEAPON_TUNING_RANGE. */
export interface WeaponTuning {
  readonly cooldownMul: number;
  readonly shotSpeedMul: number;
}
export const WEAPON_TUNING_RANGE = Object.freeze({ cooldownMul: [0.7, 1] as const, shotSpeedMul: [1, 1.2] as const });

/** Apply a tuning, keeping the profile inside the validated weapon ranges (cooldown 3..60, shot speed 200..1400). */
export function tuneWeapon(w: WeaponProfile, t: WeaponTuning | undefined): WeaponProfile {
  if (!t) return w;
  const cm = Math.min(WEAPON_TUNING_RANGE.cooldownMul[1], Math.max(WEAPON_TUNING_RANGE.cooldownMul[0], Number.isFinite(t.cooldownMul) ? t.cooldownMul : 1));
  const sm = Math.min(WEAPON_TUNING_RANGE.shotSpeedMul[1], Math.max(WEAPON_TUNING_RANGE.shotSpeedMul[0], Number.isFinite(t.shotSpeedMul) ? t.shotSpeedMul : 1));
  return { ...w, cooldownTicks: Math.max(3, Math.min(60, Math.round(w.cooldownTicks * cm))), shotSpeed: Math.max(200, Math.min(1400, Math.round(w.shotSpeed * sm))) };
}

/** Upgrade effects passed to deriveShip (ships/upgrades.ts upgradeEffects builds them). */
export interface ShipExtras {
  readonly mods: readonly StatModifiers[];
  readonly weapon?: WeaponTuning | undefined;
}

/** Everything the flight needs from a ship and its loadout. An invalid loadout falls back to the stock one. */
export function deriveShip(id: ShipId, loadout?: Loadout, extras?: ShipExtras): DerivedShip {
  const ship = SHIP_BY_ID.get(id)!;
  const fit = loadout && isValidLoadout(ship, loadout) ? loadout : ship.stock;
  const first = EQUIPMENT_BY_ID.get(fit.weapon[0] ?? '');
  return {
    ship: id,
    stats: deriveStats(ship, fit, extras?.mods ?? []),
    weapon: tuneWeapon(first && first.slot === 'weapon' ? first.weapon : FALLBACK_WEAPON, extras?.weapon),
    radius: ship.radius,
    sprite: ship.sprite,
  };
}
