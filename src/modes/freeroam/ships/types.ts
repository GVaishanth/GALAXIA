/**
 * Free Roam ship and equipment types (Free Roam Prompt 8). Pure types: the
 * balance values live in roster.ts (ships) and equipment.ts (modules) only.
 */
import type { MountType, WeaponId } from '../../../config/weapons.ts';
import type { UnlockRequirement } from '../catalogue/types.ts';

export const SHIP_IDS = ['petrel', 'swift', 'shrike', 'condor', 'magpie', 'albatross'] as const;
export type ShipId = (typeof SHIP_IDS)[number];

export type ShipArchetype = 'scout' | 'interceptor' | 'explorer' | 'defender' | 'salvager' | 'long-range';

/** Equipment slot types. Every module fits exactly one type. */
export const SLOT_TYPES = ['weapon', 'shield', 'engine', 'sensor', 'cargo'] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

/** Weapon size classes; a ship lists the classes its hardpoints accept. */
export const WEAPON_CLASSES = ['light', 'medium', 'heavy'] as const;
export type WeaponClass = (typeof WEAPON_CLASSES)[number];

/**
 * The numeric stats every ship defines (base values) and every loadout
 * derives (base + modules, clamped to STAT_BOUNDS).
 */
export interface ShipStats {
  /** Maximum hull points. The hull takes damage once the shield is empty; 0 = destroyed. */
  readonly hull: number;
  /** Shield capacity (points). */
  readonly shield: number;
  /** Shield points regenerated per second (after the regeneration delay). */
  readonly shieldRegen: number;
  /** Thrust acceleration, art px / s². */
  readonly accel: number;
  /** Speed cap, art px / s. */
  readonly maxSpeed: number;
  /** Handling: the nose turn rate, rad / s (the aim turn rate is derived from it). */
  readonly turnRate: number;
  /** Boost energy capacity. */
  readonly energy: number;
  /** Boost energy regenerated per second (after the regeneration delay). */
  readonly energyRegen: number;
  /** Cargo hold capacity in resource units. */
  readonly cargo: number;
  /** Sensor range, art px: points of interest and hostiles inside it appear on the sector map. */
  readonly sensor: number;
  /** Drive charge multiplier for route estimates (lower = more efficient). */
  readonly travel: number;
}

export type StatKey = keyof ShipStats;
export const STAT_KEYS: readonly StatKey[] = ['hull', 'shield', 'shieldRegen', 'accel', 'maxSpeed', 'turnRate', 'energy', 'energyRegen', 'cargo', 'sensor', 'travel'];

/** Number of slots of each type. */
export type SlotCounts = Readonly<Record<SlotType, number>>;

/** A cost or reward entry in cargo resources (same shape as sector LootEntry). */
export interface ResourceCost {
  readonly resource: string;
  readonly amount: number;
}

export interface ShipDef {
  readonly id: ShipId;
  readonly name: string;
  readonly archetype: ShipArchetype;
  /** Role line, e.g. "Scout". */
  readonly role: string;
  /** One or two sentences for the hangar. */
  readonly description: string;
  /** Sprite registry id (assets/sprites/fleet.ts). */
  readonly sprite: 'ship.swift' | 'ship.shrike' | 'ship.petrel' | 'ship.condor' | 'ship.magpie' | 'ship.albatross';
  /** Collision radius, art px (checked against the sprite by a test). */
  readonly radius: number;
  readonly base: ShipStats;
  readonly slots: SlotCounts;
  /** Weapon classes the hardpoints accept. */
  readonly weaponClasses: readonly WeaponClass[];
  /** Stock modules, one list per slot type (shorter than the slot count = empty slots). */
  readonly stock: Loadout;
  /**
   * Combat P03B: weapon mounts the hull provides (config/weapons.ts). A weapon
   * can be carried only if its mount is listed here; this is the only place
   * ship-to-weapon compatibility is decided (ships/armory.ts reads it).
   */
  readonly mounts: readonly MountType[];
  /** The weapon a flight starts with when no valid preference is saved (must be mountable and initial-selectable). */
  readonly defaultWeapon: WeaponId;
  /** Licence: every requirement must be met before the ship can be acquired (empty = starter). */
  readonly licence: readonly UnlockRequirement[];
  /** Price in cargo resources, paid once at a station hangar. */
  readonly cost: readonly ResourceCost[];
  /**
   * P05.1: crew seats on the bridge (crew/seats.ts reads it; 0 = solo hull). The
   * pilot's own seat is not counted: a ship always flies with no crew at all.
   */
  readonly crewSeats: number;
}

/** Additive and multiplicative changes to stats. Applied as (base + Σadd) × Πmul, then clamped. */
export interface StatModifiers {
  readonly add?: Partial<Record<StatKey, number>>;
  readonly mul?: Partial<Record<StatKey, number>>;
}

/** What a weapon module fires. */
export interface WeaponProfile {
  /** Ticks between volleys. */
  readonly cooldownTicks: number;
  /** Hit points removed per bolt. */
  readonly damage: number;
  /** Bolt speed, art px / s (the ship's forward speed is added). */
  readonly shotSpeed: number;
  readonly lifeTicks: number;
  /** Bolts per volley, side by side (1 or 2). */
  readonly bolts: 1 | 2;
  /** Lateral distance between twin bolts, art px. */
  readonly spread: number;
}

interface ModuleBase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mods: StatModifiers;
}

export type EquipmentItem =
  | (ModuleBase & { readonly slot: 'weapon'; readonly weaponClass: WeaponClass; readonly weapon: WeaponProfile })
  | (ModuleBase & { readonly slot: 'shield' | 'engine' | 'sensor' | 'cargo' });

/** Fitted module ids per slot type, in slot order. */
export type Loadout = Readonly<Record<SlotType, readonly string[]>>;

/** Final stats of a ship with its loadout, plus everything the flight needs. */
export interface DerivedShip {
  readonly ship: ShipId;
  readonly stats: ShipStats;
  /** The first fitted weapon's profile (a ship always has one: validation enforces it). */
  readonly weapon: WeaponProfile;
  readonly radius: number;
  readonly sprite: ShipDef['sprite'];
}
