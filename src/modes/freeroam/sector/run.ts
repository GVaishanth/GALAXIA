/**
 * A visit to one local sector (pure, deterministic): the ship, temporary
 * hostile entities, encounters and interactions on top of a static
 * SectorLayout and the sector's persistent SectorSave.
 *
 * Entity management: nothing here exists before the pilot enters a sector.
 * Patrol ships are created only when the pilot comes near their route and are
 * removed again when the pilot is far away and they are idle; an
 * installation's wave exists only during its encounter. disposeSectorRun()
 * drops every temporary entity. Persistent progress leaves this module only
 * as events (recorded / collected / looted / cleared / docked / survey
 * complete); the shell writes them to the profile at once, together with any
 * reward, so a reward can never be granted twice.
 *
 * Combat (Prompt 7, FR-TD-45; Prompt 9, FR-TD-51..56): the pilot fires bolts
 * along the ship's nose. Bolts stop on solid objects and damage enemy ships,
 * missiles and mines. Enemy ships, their AI, projectiles, encounters and
 * hazards live in ../combat/ (factions, families, weapons, difficulty, ai,
 * projectiles, encounters, hazards, world); this module owns the tick order
 * and the run state. Ordinary kills drop no fixed loot (at most a
 * capped salvage pod, FR-TD-59); the Guild's capped marks bounty
 * (progression/marksRewards.ts, a per-system pool) is paid outside the run. An encounter pays its fixed loot once on completion. After arriving (and after
 * a recall) the region's grace period keeps every enemy from firing and every
 * encounter from starting.
 *
 * Ships (Prompt 8, FR-TD-49): the run flies one DerivedShip (ships/equipment.ts):
 * its stats set the handling (ShipTuning), shield, hull, boost energy, cargo
 * space and sensor range, and its weapon module sets the bolts. Damage drains
 * the shield first and the hull after it; the hull does not regenerate in
 * flight (docking restores it). An empty hull destroys the ship: it is
 * recalled to the arrival zone with a full hull; the shell leaves part of the
 * cargo in a recoverable wreck where it died (FR-TD-55). Boost spends energy for a short burst of thrust and
 * top speed, eased in and out. Salvage and containers are only taken when the
 * whole reward fits in the hold; installation rewards are always stowed (a
 * fight is never wasted). POIs within sensor range are revealed on the sector
 * map. Docking is refused while hostiles are engaged, so the hangar (and a
 * ship switch) is never reachable mid-combat.
 */
import { createRng, type Rng } from '../../../core/rng.ts';
import { freshShip, noseOf, SHIP, stepShip, type FlightInput, type FreeRoamPhase, type ShipModifiers, type ShipState, type ShipTuning } from '../sim.ts';
import { deriveShip } from '../ships/equipment.ts';
import type { DerivedShip } from '../ships/types.ts';
import type { FactionId } from '../catalogue/types.ts';
import { stepAgents } from '../combat/ai.ts';
import { COMBAT, difficultyRow, type DifficultyRow } from '../combat/difficulty.ts';
import { combatLevel, createEncounters, resetEncounters, salvageTaken, stepEncounters, stepPatrols, stepPending } from '../combat/encounters.ts';
import type { FamilyId } from '../combat/families.ts';
import { inInterference, stepEruptions } from '../combat/hazards.ts';
import { layFieldMines, stepEnemyShots, stepMines, triggerMine } from '../combat/projectiles.ts';
import { freshGravity, pullOn, wellsOf, type GravityState, type Well } from './gravityWells.ts';
import { freshMissileSkill, resetMissiles, stepMissiles, stepMissileSkill, switchWeapon, type MissileSkill, type PlayerMissile, type RefusalReason } from '../combat/playerMissile.ts';
import { stepDilation, type DilationZone } from '../combat/dilation.ts';
import { clearShipLock, cycleShipLock, endShipLock, freshShipLock, stepShipLock, toggleShipLock, type ShipLock, type ShipLockEnd } from '../combat/shipLock.ts';
import { cleanOrdnance, initialOrdnance, type WeaponId as PilotWeaponId } from '../../../config/weapons.ts';
import { createArsenal, type Arsenal, type ArsenalSpec } from '../../../core/weapons/arsenal.ts';
import { compatibleWeapons, defaultSetup } from '../ships/armory.ts';
import type { Agent, CombatLevel, EncounterRuntime, EnemyShot, Mine, Pending } from '../combat/state.ts';
import type { WeaponId } from '../combat/weapons.ts';
import { damageAgent, damagePlayer, shotBlocked, sweptHit, type PlayerDamageSource } from '../combat/world.ts';
import { FAMILIES } from '../combat/families.ts';
import { dist } from './grid.ts';
import { safeResumePoint, type ResumeAt } from './resume.ts';
import { initialDropBudget, interactContainer, killDrop, leftFromSave, lootStream, mineShot, persistentIds, spawnSavedCaches, stepOffer, stepPickups, touchPoi, touchWreck, type LootOffer, type Pickup, type PickupKind } from './collect.ts';
import type { AgentRole } from '../combat/state.ts';
import { NO_CONTROLS, type VectorControls } from './vectorFlight.ts';
import { clearStationKeeping, createRealisticFlight, freshStationKeeping, stepRealistic, updateStationKeeping, vectorMoving, type FlightMode, type RealisticFlight, type StationKeeping } from './realisticFlight.ts';
import { cancelBearing, createSignals, resetSignals, signalReach, startBearing, stepSignal, type SignalResult, type SignalRunState } from './signal.ts';
import { POI_RULES, type EncounterKind, type LootEntry, type Poi, type PoiKind, type SectorLayout, type SectorSave } from './model.ts';

export const RUN = Object.freeze({
  /** Shield regeneration starts this long after the last hit. */
  regenDelayTicks: 180,
  /** Impacts slower than this (art px/s along the normal) do no damage. */
  impactSpeed: 70,
  restitution: 0.4,
  /** Shield drain per second at full strength. */
  coronaDrain: 14,
  hazardDrain: 5,
  dustDrag: 1.4,
  ionSpeed: 0.7,
  shearPull: 220,
  /**
   * Weapon heat (FR-TD-79, owner request): every shot adds cooldownTicks /
   * fullTicks of heat, so about fullTicks of continuous fire overheats any
   * weapon module. Releasing fire cools it (coolTicks from full to cold). A
   * full bar locks the weapon until it cools to resumeAt.
   */
  heat: { fullTicks: 480, coolTicks: 120, resumeAt: 0.3 }, // 240 -> 480 at the owner's request: about 8 s of continuous fire
  /** Player bolts: pool cap and radius (rate, speed, life and damage come from the weapon module). */
  maxShots: 24,
  shotRadius: 3,
  /** After a recall, patrols stay asleep this long. */
  recallCooldownTicks: 600,
  /* Boost (Prompt 8): a ship-independent mechanic; capacity and recharge are ship stats. */
  boostSpeedMul: 1.45,
  boostAccelMul: 1.7,
  /** Energy spent per second while boosting. */
  boostDrain: 34,
  /** Energy needed to start a boost (prevents stutter at an empty tank). */
  boostMinStart: 20,
  /** Energy recharge starts this long after the boost ends. */
  energyDelayTicks: 45,
  /** Boost level easing per tick (in / out), so the top speed never jumps. */
  boostRise: 0.12,
  boostFall: 0.04,
  /** Shield impact flare duration (presentation). */
  shieldFlareTicks: 12,
});

/** Ship flight tuning from a derived ship (drag and reverse assist are shared; the aim turn rate scales with handling). */
export function shipTuning(d: DerivedShip): ShipTuning {
  const k = d.stats.turnRate / SHIP.turnRate;
  return Object.freeze({ ...SHIP, accel: d.stats.accel, maxSpeed: d.stats.maxSpeed, turnRate: d.stats.turnRate, aimTurnRate: SHIP.aimTurnRate * k, radius: d.radius });
}

export type GateState = 'open' | 'sealed' | 'dormant';

export interface GateInfo {
  readonly state: GateState;
  /** Shown on the map and the prompt, e.g. "Gate to Sirius" or "Sealed gate". */
  readonly label: string;
  /** Why it cannot be used (sealed / dormant), or the destination summary. */
  readonly detail: string;
}

/** A player bolt (temporary entity). It flies along the nose direction it was fired with. */
export interface Shot {
  readonly id: number;
  x: number;
  y: number;
  px: number;
  py: number;
  readonly vx: number;
  readonly vy: number;
  life: number;
  /** Hit points removed on impact (weapon module). */
  readonly damage: number;
}

/** One tick of controller-independent intent: movement, optional aim, fire held. */
export interface SectorInput extends FlightInput {
  readonly fire?: boolean | undefined;
  /** Boost held (Shift, LB / LT, the BOOST button). */
  readonly boost?: boolean | undefined;
  /**
   * Combat P03C: switch the selected weapon this tick, one step (1 next, -1
   * previous; the NEXT WEAPON key Q / R3 and the WPN button; since P04.1 the
   * wheel zooms instead). An edge command: the shell sends it for exactly one
   * tick per gesture.
   */
  readonly cycle?: 1 | -1 | 0 | undefined;
  /**
   * P04.1: toggle the ship target lock this tick (X / the LOCK button;
   * combat/shipLock.ts). An edge command like `cycle`. The lock only aims the
   * nose; it never moves, thrusts or fires.
   */
  readonly lockToggle?: boolean | undefined;
  /**
   * P04.1 polish: move the ship lock to the next eligible target this tick
   * (C / the NEXT TARGET button). An edge command; only while a lock holds.
   */
  readonly targetCycle?: boolean | undefined;
  /** Rotate-and-thrust controls; read by a flight hook (the Gravity Flight test sector, FR-TD-83) and by REALISTIC flight (P04.3). */
  readonly vector?: VectorControls | undefined;
  /**
   * P04.3: toggle STOP this tick (B / the STOP button). An edge command like
   * `lockToggle`. REALISTIC flight only; in NORMAL it changes nothing.
   */
  readonly stopToggle?: boolean | undefined;
  /** P07.1: toggle Silent Running this tick (Z). An edge command like `stopToggle`. */
  readonly silentToggle?: boolean | undefined;
}

/**
 * Replaces the ship's flight step for one run (FR-TD-83). Only the Gravity
 * Flight test sector installs one (gravity/lab.ts); every other run has
 * `flight: null` and flies exactly as before.
 */
export interface FlightHook {
  /** Moves the ship this tick instead of sim.ts stepShip (same modifiers and boosted tuning). */
  stepShip(run: SectorRun, input: SectorInput, mods: ShipModifiers, tune: ShipTuning, events: SectorEvent[]): { distance: number; pushed: boolean };
  /** Called just before enemy ships move. */
  beforeAgents?(run: SectorRun): void;
  /** Called at the end of the tick, after recalls and focus, before the tick counter advances. */
  afterTick?(run: SectorRun, events: SectorEvent[]): void;
  /**
   * Line of sight (FR-TD-84): true when something this hook owns (the lab's planet) blocks the
   * view from (ax, ay) to (bx, by). Enemy target choice treats a blocked target as out of sight.
   * Absent everywhere except the gravity lab (every sector's own bodies hide the pilot through combat/stealth.ts, P07.1).
   */
  sightBlocked?(ax: number, ay: number, bx: number, by: number): boolean;
}

export type SectorEvent =
  | { readonly type: 'phase'; readonly phase: FreeRoamPhase }
  /** P04.3 STOP: engaged, released (toggle), cancelled (movement input), or unavailable (NORMAL flight). */
  | { readonly type: 'stop'; readonly change: 'engaged' | 'released' | 'cancelled' | 'unavailable' }
  /** P07.1 Silent Running: toggled on / off, or dropped by a FIRE or boost request (which then runs once as usual). */
  | { readonly type: 'silent'; readonly change: 'on' | 'off' | 'fire' | 'boost' }
  | { readonly type: 'recorded'; readonly id: string; readonly remaining: number }
  /** Salvage taken (`left` = what stays in the node; empty when it is done). */
  | { readonly type: 'collected'; readonly id: string; readonly loot: readonly LootEntry[]; readonly left: readonly LootEntry[] }
  | { readonly type: 'looted'; readonly id: string; readonly kind: PoiKind; readonly label: string; readonly loot: readonly LootEntry[]; readonly left: readonly LootEntry[] }
  /** P06.1 signal triangulation (sector/signal.ts): an observation started, was refused or broken, or a bearing was recorded. */
  | { readonly type: 'signal'; readonly id: string; readonly label: string; readonly result: SignalResult }
  /* collection (Prompt 10) */
  | { readonly type: 'picked'; readonly id: string; readonly kind: PickupKind; readonly label: string; readonly loot: readonly LootEntry[]; readonly left: readonly LootEntry[]; readonly persistent: boolean }
  | { readonly type: 'dropped'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly type: 'expired'; readonly id: string; readonly kind: PickupKind }
  | { readonly type: 'jettisoned'; readonly id: string; readonly units: number }
  | { readonly type: 'veinHit'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly type: 'chipped'; readonly id: string; readonly vein: string; readonly x: number; readonly y: number; readonly remaining: number }
  | { readonly type: 'docked'; readonly id: string; readonly first: boolean }
  | {
      readonly type: 'encounter';
      readonly id: string;
      readonly kind: EncounterKind;
      readonly label: string;
      readonly state: 'warning' | 'start' | 'broken' | 'cleared' | 'failed';
      readonly loot: readonly LootEntry[];
      /** Cleared: the part of the reward that did not fit (it floats at the site as a reward cache). */
      readonly left: readonly LootEntry[];
    }
  | { readonly type: 'hit'; readonly source: PlayerDamageSource; readonly damage: number }
  | { readonly type: 'recalled' }
  | { readonly type: 'wrecked'; readonly x: number; readonly y: number; readonly heading: number }
  | { readonly type: 'holdFull'; readonly id: string; readonly need: number; readonly space: number }
  | { readonly type: 'dockRefused' }
  | { readonly type: 'surveyComplete'; readonly ticks: number }
  | { readonly type: 'gate'; readonly id: string; readonly target: string; readonly gate: GateInfo }
  | { readonly type: 'exit' }
  | { readonly type: 'edge' }
  | { readonly type: 'fired' }
  /** Held fire overheated the weapon (FR-TD-79): locked until it cools. */
  | { readonly type: 'overheated' }
  /** The overheated weapon cooled enough to fire again. */
  | { readonly type: 'weaponCooled' }
  | { readonly type: 'struck'; readonly hostile: number; readonly x: number; readonly y: number; readonly shield: boolean; readonly by: 'player' | 'npc' }
  | {
      readonly type: 'destroyed';
      readonly hostile: number;
      readonly family: FamilyId;
      readonly faction: FactionId;
      readonly source: string;
      readonly by: 'player' | 'npc';
      readonly role: AgentRole;
      readonly x: number;
      readonly y: number;
      readonly size: 1 | 2 | 3 | 4;
    }
  /* combat (Prompt 9) */
  | { readonly type: 'enemyFired'; readonly hostile: number; readonly weapon: WeaponId; readonly x: number; readonly y: number }
  | { readonly type: 'telegraph'; readonly hostile: number; readonly weapon: WeaponId; readonly x: number; readonly y: number; readonly ticks: number }
  | { readonly type: 'disabled'; readonly hostile: number; readonly x: number; readonly y: number }
  | { readonly type: 'escaped'; readonly hostile: number; readonly source: string }
  | { readonly type: 'provoked'; readonly faction: FactionId; readonly why: 'shot' | 'claim' }
  | { readonly type: 'reinforcements'; readonly source: string; readonly count: number; readonly x: number; readonly y: number }
  | { readonly type: 'bossPhase'; readonly hostile: number; readonly x: number; readonly y: number }
  | { readonly type: 'blast'; readonly kind: 'mine' | 'eruption'; readonly x: number; readonly y: number; readonly r: number }
  | { readonly type: 'shotDown'; readonly x: number; readonly y: number }
  /* pilot missile skill (Combat P03, combat/playerMissile.ts) */
  | { readonly type: 'missileLock'; readonly hostile: number; readonly x: number; readonly y: number }
  | { readonly type: 'missileLockLost' }
  /* ship target lock (P04.1, combat/shipLock.ts): facing only */
  | { readonly type: 'shipLocked'; readonly hostile: number; readonly family: FamilyId; readonly x: number; readonly y: number; readonly from?: number }
  | { readonly type: 'shipLockRefused'; readonly why: 'noTarget' | 'unavailable' | 'noLock' | 'onlyTarget' }
  | { readonly type: 'shipLockEnded'; readonly hostile: number; readonly why: ShipLockEnd }
  | { readonly type: 'missileRefused'; readonly reason: RefusalReason; readonly weapon: PilotWeaponId }
  | { readonly type: 'missileLaunched'; readonly weapon: PilotWeaponId; readonly hostile: number | null; readonly x: number; readonly y: number }
  | { readonly type: 'missileHit'; readonly weapon: PilotWeaponId; readonly hostile: number; readonly x: number; readonly y: number; readonly damage: number; readonly killed: boolean }
  /** A missile that ended with no blast: a lock-on fizzling (rock, end of flight) or any missile leaving the sector. */
  | { readonly type: 'missileExpired'; readonly weapon: PilotWeaponId; readonly x: number; readonly y: number }
  | { readonly type: 'missileReady'; readonly weapon: PilotWeaponId }
  /* pilot ordnance (Combat P03C) */
  | { readonly type: 'weaponSwitched'; readonly weapon: PilotWeaponId }
  /** A stocked weapon spent one round (the shell writes the count to the profile and saves). */
  | { readonly type: 'ordnanceSpent'; readonly weapon: PilotWeaponId; readonly left: number }
  | { readonly type: 'detonation'; readonly weapon: PilotWeaponId; readonly x: number; readonly y: number; readonly r: number; readonly hits: number; readonly kills: number }
  | { readonly type: 'dilation'; readonly state: 'start' | 'end'; readonly x: number; readonly y: number; readonly r: number; readonly ticks: number }
  | { readonly type: 'combat'; readonly level: CombatLevel }
  | { readonly type: 'recovered'; readonly units: number; readonly loot: readonly LootEntry[]; readonly left: readonly LootEntry[] };

/** The recoverable cargo wreck left where the ship was destroyed (the shell owns its contents). */
export interface CargoWreck {
  readonly x: number;
  readonly y: number;
  /** Cargo units inside (for the hold check). */
  readonly units: number;
  /** Its contents, when known (enables TAKE WHAT FITS; without it the wreck is taken whole only). */
  readonly loot?: readonly LootEntry[] | undefined;
}

export interface SectorRun {
  readonly layout: SectorLayout;
  phase: FreeRoamPhase;
  /** Ticks flown in this visit. */
  tick: number;
  ship: ShipState;
  /** The ship flown (stats, weapon, radius, sprite) and its flight tuning. */
  craft: DerivedShip;
  tune: ShipTuning;
  shield: number;
  hull: number;
  energy: number;
  /** 0..1, eased: how much boost is applied this tick. */
  boost: number;
  boosting: boolean;
  sinceBoost: number;
  /**
   * P07.1 Silent Running (combat/stealth.ts): the signature drops to
   * STEALTH.silent and the shield does not regenerate. Temporary: off on
   * entry, dock, recall / restart, ship change and unload; never saved.
   */
  silent: boolean;
  /** Free cargo space (units); the shell sets it from the profile. Infinity = unlimited. */
  cargoSpace: number;
  /* collection (Prompt 10, sector/collect.ts) */
  /** Floating collectibles of this visit: salvage pods, ore fragments, reward caches, jettisoned cargo. */
  readonly pickups: Pickup[];
  nextPickup: number;
  /** Loot still inside partly taken containers and reward caches (from the save, updated this visit). */
  readonly left: Map<string, LootEntry[]>;
  /** Ids awarded in this visit: the same id is never awarded twice. */
  readonly claimed: Set<string>;
  /** Enemy ships that already rolled for a salvage pod. */
  readonly dropRolled: Set<number>;
  /** Salvage pods this visit can still drop (a restart or recall does not refill it). */
  dropBudget: number;
  /** Bolt hits on each vein since its last chip. */
  readonly veinHits: Map<string, number>;
  /** Seeded loot stream for run-time rolls (salvage pods); separate from `rng`. */
  readonly lootRng: Rng;
  /** The full-hold choice currently open (null = none). */
  offer: LootOffer | null;
  /** A find the pilot already decided about (LEAVE IT, or took what fitted): no new prompt until the ship has left its reach. */
  snooze: { readonly id: string; readonly x: number; readonly y: number; readonly reach: number } | null;
  /** POIs the sensors have picked up in this visit (all of them once the sector is surveyed). */
  readonly revealed: Set<string>;
  /** Last shield impact: direction (radians, world) and tick, for the flare. */
  shieldHit: { readonly angle: number; readonly tick: number } | null;
  /** Station the ship is docked at (hangar open), or null. */
  docked: string | null;
  invuln: number;
  sinceHit: number;
  /** Completed one-time interactions (persistent ones loaded from the save, plus this visit). */
  readonly done: Set<string>;
  /** The survey was already complete when the pilot entered. */
  readonly surveyedAtEntry: boolean;
  surveyed: boolean;
  /** Enemy ships alive in this visit (temporary; combat/ai.ts). */
  readonly hostiles: Agent[];
  nextHostile: number;
  /** Per patrol: whether its ships exist, and a sleep cooldown in ticks. */
  readonly patrols: Map<string, { awake: boolean; cooldown: number }>;
  /** Outposts and encounter sites not yet completed (combat/encounters.ts). */
  readonly encounters: EncounterRuntime[];
  /** Warp-ins waiting to materialise (telegraphed by markers). */
  pending: Pending[];
  readonly enemyShots: EnemyShot[];
  nextEnemyShot: number;
  readonly mines: Mine[];
  nextMine: number;
  /** Wary factions the pilot has provoked in this visit (hostile until the pilot leaves). */
  readonly provoked: Set<FactionId>;
  /** Regional difficulty row (combat/difficulty.ts). */
  readonly row: DifficultyRow;
  /** Ticks left of the arrival grace: no enemy fires and no encounter starts. */
  grace: number;
  combat: CombatLevel;
  /** The cargo wreck in this sector, or null. */
  cargoWreck: CargoWreck | null;
  readonly shots: Shot[];
  nextShot: number;
  /** Ticks until the weapon can fire again. */
  fireCooldown: number;
  /** Weapon heat 0..1 (FR-TD-79), and whether it is locked until it cools. */
  heat: number;
  overheated: boolean;
  /** Pilot ordnance (Combat P03 / P03C): the lock-on acquisition and notices, and the missiles in flight (temporary). */
  missile: MissileSkill;
  /** P04.1: the ship target lock (X / LOCK): which hostile the nose faces, and its HUD notice (temporary). */
  shipLock: ShipLock;
  readonly missiles: PlayerMissile[];
  nextMissile: number;
  /** Combat P03C: the flown ship's weapons (rotation, selection, per-weapon cooldowns; core/weapons/arsenal.ts). */
  arsenal: Arsenal;
  /**
   * Stocked ammunition (heavy missile, nuke): the profile's `ordnance`
   * counts, handed in at entry; every launch reports `ordnanceSpent` so the
   * shell writes the same count back to the profile (one count, no second
   * inventory). Docking refills it through the shell (`setRunOrdnance`).
   */
  readonly ammo: Record<string, number>;
  /**
   * P04 Admin Access sandbox: launches spend no magazine round and no energy
   * (cooldowns, recovery and mounts unchanged). Set by the shell only during
   * an admin session; never saved.
   */
  unlimitedAmmo: boolean;
  /** Nuke time-dilation zones (combat/dilation.ts; temporary). */
  readonly dilation: DilationZone[];
  shotsFired: number;
  kills: number;
  /** The nearest usable button interaction in range, or null. */
  focus: string | null;
  gates: Readonly<Record<string, GateInfo>>;
  distance: number;
  recalls: number;
  completeTick: number;
  disposed: boolean;
  /** Temporary variation only (spawn jitter, enemy traits, aim jitter, evade rolls); never layout, loot or rewards. */
  readonly rng: Rng;
  /** Spawn point used on entry (and after a recall when it was the arrival). */
  readonly spawn: string;
  /** Flight step override (FR-TD-83); null everywhere except the Gravity Flight test sector. */
  flight: FlightHook | null;
  /** FR-TD-86: the pull of this sector's planets and stars (built once from the layout). */
  readonly wells: readonly Well[];
  /** FR-TD-86: the pull on the ship this tick (zero while a flight hook owns the physics). */
  readonly gravity: GravityState;
  /**
   * P04.3: the pilot's flight mode (a preference, set by the shell). NORMAL =
   * sim.ts stepShip, exactly as before; REALISTIC = sector/realisticFlight.ts.
   * Ignored while a flight hook (the gravity lab) owns the physics.
   */
  flightMode: FlightMode;
  /** P04.3: STOP (REALISTIC only); never saved, cleared on every reset. */
  readonly stop: StationKeeping;
  /** P04.3: REALISTIC step scratch (built once). */
  readonly realistic: RealisticFlight;
  /** P06.1: signal triangulation of this visit's anomalies (temporary; never saved; sector/signal.ts). */
  readonly signal: SignalRunState;
}

export interface RunOptions {
  /** Spawn point id (`arrival` or `gate:<system id>`); unknown ids fall back to the arrival. */
  readonly spawn?: string | undefined;
  readonly gates?: Readonly<Record<string, GateInfo>> | undefined;
  /** Seed of the harmless-variation stream (the shell passes a random one; tests a fixed one). */
  readonly seed?: number | undefined;
  readonly phase?: FreeRoamPhase | undefined;
  /** The ship flown (default: the starter with its stock loadout). */
  readonly ship?: DerivedShip | undefined;
  /** Free cargo space at entry (default unlimited). */
  readonly cargoSpace?: number | undefined;
  /** Combat P03C: the flown ship's weapons (ships/armory.ts armedLoadout; default: the ship's default setup). */
  readonly loadout?: ArsenalSpec | undefined;
  /** Combat P03C: the profile's stocked ammunition (default: a new pilot's). */
  readonly ordnance?: Readonly<Record<string, number>> | undefined;
  /** The pilot's cargo wreck in this sector, if any. */
  readonly cargoWreck?: CargoWreck | null | undefined;
  /** Prompt 13: start here instead of the spawn point (a saved resume point; checked with
   *  sector/resume.ts safeResumePoint, an unsafe point is ignored). */
  readonly at?: ResumeAt | null | undefined;
  /** P04 Admin Access sandbox: launches spend no ammunition (SectorRun.unlimitedAmmo). */
  readonly unlimitedAmmo?: boolean | undefined;
  /** P04.3: the pilot's flight mode preference (default NORMAL). */
  readonly flightMode?: FlightMode | undefined;
}

/** POIs every pilot knows on arrival: the station, the gates and the exit beacon (navigation beacons). */
const BEACON_KINDS: readonly string[] = ['station', 'gate', 'exit'];

const poiById = (L: SectorLayout, id: string): Poi | undefined => L.pois.find((p) => p.id === id);

export function createSectorRun(layout: SectorLayout, save: SectorSave, o: RunOptions = {}): SectorRun {
  const spawnPoint = layout.spawns.find((s) => s.id === o.spawn) ?? layout.spawns[0]!;
  const at = o.at ? safeResumePoint(layout, o.at) : null;
  // a resume point keeps the spawn id (a recall still returns to the arrival / that gate)
  const sp = at ? { ...spawnPoint, x: at.x, y: at.y, heading: at.heading } : spawnPoint;
  const ids = persistentIds(layout);
  const craft = o.ship ?? deriveShip('petrel');
  const revealed = new Set(layout.pois.filter((p) => save.surveyed || BEACON_KINDS.includes(p.kind)).map((p) => p.id));
  const done = new Set(save.done.filter((id) => ids.has(id)));
  const left = leftFromSave(layout, save, done);
  const row = difficultyRow(layout.difficulty);
  const run: SectorRun = {
    layout,
    phase: o.phase ?? 'flight',
    tick: 0,
    ship: freshShip(sp.x, sp.y, sp.heading),
    craft,
    tune: shipTuning(craft),
    shield: craft.stats.shield,
    hull: craft.stats.hull,
    energy: craft.stats.energy,
    boost: 0,
    boosting: false,
    sinceBoost: RUN.energyDelayTicks,
    silent: false,
    cargoSpace: o.cargoSpace ?? Infinity,
    pickups: [],
    nextPickup: 1,
    left,
    claimed: new Set(),
    dropRolled: new Set(),
    dropBudget: initialDropBudget(layout),
    veinHits: new Map(),
    lootRng: lootStream(o.seed ?? layout.seed),
    offer: null,
    snooze: null,
    revealed,
    shieldHit: null,
    docked: null,
    invuln: 0,
    sinceHit: RUN.regenDelayTicks,
    done,
    surveyedAtEntry: save.surveyed,
    surveyed: save.surveyed,
    hostiles: [],
    nextHostile: 1,
    patrols: new Map(layout.patrols.map((p) => [p.id, { awake: false, cooldown: 0 }])),
    encounters: createEncounters(layout, done),
    pending: [],
    enemyShots: [],
    nextEnemyShot: 1,
    mines: [],
    nextMine: 1,
    provoked: new Set(),
    row,
    grace: row.grace,
    combat: 'calm',
    cargoWreck: o.cargoWreck ?? null,
    shots: [],
    nextShot: 1,
    fireCooldown: 0,
    heat: 0,
    overheated: false,
    missile: freshMissileSkill(),
    shipLock: freshShipLock(),
    missiles: [],
    nextMissile: 1,
    arsenal: createArsenal(o.loadout ?? { compatible: compatibleWeapons(craft.ship), ...defaultSetup(craft.ship) }),
    ammo: { ...(o.ordnance ? cleanOrdnance(o.ordnance).counts : initialOrdnance()) },
    unlimitedAmmo: o.unlimitedAmmo === true,
    dilation: [],
    shotsFired: 0,
    kills: 0,
    focus: null,
    gates: o.gates ?? {},
    distance: 0,
    recalls: 0,
    completeTick: 0,
    disposed: false,
    rng: createRng((o.seed ?? layout.seed) >>> 0),
    spawn: sp.id,
    flight: null,
    wells: wellsOf(layout.landmarks),
    gravity: freshGravity(),
    flightMode: o.flightMode === 'realistic' ? 'realistic' : 'normal',
    stop: freshStationKeeping(),
    realistic: createRealisticFlight(),
    signal: createSignals(layout, done, left),
  };
  layFieldMines(run);
  spawnSavedCaches(run);
  sense(run);
  return run;
}

/** Put a different ship (or loadout) into the run: full hull, shield and energy; the pose is kept. */
export function applyShip(run: SectorRun, craft: DerivedShip): void {
  run.craft = craft;
  run.tune = shipTuning(craft);
  run.shield = craft.stats.shield;
  run.hull = craft.stats.hull;
  run.energy = craft.stats.energy;
  run.boost = 0;
  run.boosting = false;
  run.sinceBoost = RUN.energyDelayTicks;
  run.silent = false; // P07.1: a new hull starts at its normal signature
  run.fireCooldown = 0;
  run.heat = 0;
  run.overheated = false;
  clearStationKeeping(run.stop); // P04.3: a new hull (new thrust): STOP starts over
  cancelBearing(run); // P06.1: a bearing is taken with one ship's sensors
  sense(run);
}

/**
 * P04.3: switch the flight model mid-flight. Position, velocity, heading, the
 * target lock and the weapons carry over untouched (no impulse, no jump); STOP
 * and its hold point are cleared, so no controller force is left behind.
 */
export function setRunFlightMode(run: SectorRun, mode: FlightMode): void {
  const next: FlightMode = mode === 'realistic' ? 'realistic' : 'normal';
  if (run.flightMode === next) return;
  run.flightMode = next;
  clearStationKeeping(run.stop);
}

/** Reveal the POIs within sensor range of the ship (jammed inside sensor interference). */
function sense(run: SectorRun): void {
  if (inInterference(run.layout, run.ship)) return;
  const r = run.craft.stats.sensor;
  for (const p of run.layout.pois) if (!run.revealed.has(p.id) && dist(run.ship, p) <= r + p.r) run.revealed.add(p.id);
}

/** Hostiles are engaged: an encounter is live, or a ship hunting the pilot is near. Docking (and so the hangar) is refused. */
export function inCombat(run: SectorRun): boolean {
  return combatLevel(run) === 'engaged';
}

/** Place (or clear) the pilot's cargo wreck in this run (the shell owns its contents). */
export function setCargoWreck(run: SectorRun, w: CargoWreck | null): void {
  run.cargoWreck = w;
  if (run.offer?.kind === 'wreck') run.offer = null;
}

/** May the pilot switch ships now? Only while docked at a station with no hostile engaged. */
export function canSwitchShip(run: SectorRun): boolean {
  return run.docked !== null && !run.disposed && !inCombat(run);
}

/** Is this POI's one-time interaction complete? Survey marks count as done once the survey is. */
export function isDone(run: SectorRun, p: Poi): boolean {
  if (p.kind === 'survey') return run.surveyed || run.done.has(p.id);
  return POI_RULES[p.kind].once && run.done.has(p.id);
}

export function marksLeft(run: SectorRun): number {
  return run.layout.pois.filter((p) => p.kind === 'survey' && !isDone(run, p)).length;
}

/* ---------------------------------------------------------- player weapon */

/** Fire one bolt from the nose tip along the nose (cooldown and pool cap permitting). */
function fire(run: SectorRun, events: SectorEvent[]): void {
  const w = run.craft.weapon;
  if (run.fireCooldown > 0 || run.shots.length + w.bolts > RUN.maxShots) return;
  const sh = run.ship;
  const n = noseOf(sh.heading);
  // the bolt keeps exactly the nose direction; the ship's forward speed is added so bolts never lag a fast ship
  const speed = w.shotSpeed + Math.max(0, sh.vx * n.x + sh.vy * n.y);
  for (let b = 0; b < w.bolts; b++) {
    // twin bolts sit side by side across the nose, both parallel to it
    const off = w.bolts === 1 ? 0 : (b === 0 ? -0.5 : 0.5) * w.spread;
    const x = sh.x + n.x * (run.tune.radius + 4) - n.y * off;
    const y = sh.y + n.y * (run.tune.radius + 4) + n.x * off;
    run.shots.push({ id: run.nextShot++, x, y, px: x, py: y, vx: n.x * speed, vy: n.y * speed, life: w.lifeTicks, damage: w.damage });
  }
  run.fireCooldown = w.cooldownTicks;
  run.shotsFired += 1;
  events.push({ type: 'fired' });
  // heat per shot scales with the module's cadence: the same hold time overheats every weapon
  run.heat = Math.min(1, run.heat + w.cooldownTicks / RUN.heat.fullTicks);
  if (run.heat >= 1) {
    run.overheated = true;
    events.push({ type: 'overheated' });
  }
}

/** Cool the weapon for one tick (fire released, or locked); unlock at resumeAt. */
function coolWeapon(run: SectorRun, held: boolean, events: SectorEvent[]): void {
  if (held && !run.overheated) return; // holding fire: no cooling between shots
  run.heat = Math.max(0, run.heat - 1 / RUN.heat.coolTicks);
  if (run.overheated && run.heat <= RUN.heat.resumeAt) {
    run.overheated = false;
    events.push({ type: 'weaponCooled' });
  }
}

/**
 * Move bolts; stop them on solids and the sector edge. Each bolt makes at most
 * one impact: the first enemy ship, missile or mine it touches takes its damage
 * and the bolt is removed in the same step (damage once per impact).
 */
function stepShots(run: SectorRun, events: SectorEvent[]): void {
  const L = run.layout;
  const dt = 1 / 60;
  for (let i = run.shots.length - 1; i >= 0; i--) {
    const s = run.shots[i]!;
    s.px = s.x;
    s.py = s.y;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life -= 1;
    const blocked = shotBlocked(L, s.px, s.py, s.x, s.y, RUN.shotRadius);
    if (blocked && L.veins.length) mineShot(run, s.px, s.py, s.x, s.y, RUN.shotRadius, events); // a marked vein chips ore
    let dead = s.life <= 0 || s.x < 0 || s.y < 0 || s.x > L.width || s.y > L.height || blocked;
    if (!dead) {
      for (const a of run.hostiles) {
        if (a.state === 'destroyed' || !sweptHit(s.px, s.py, s.x, s.y, a.x, a.y, FAMILIES[a.family].radius + RUN.shotRadius)) continue;
        dead = true;
        damageAgent(run, a, s.damage, 'player', events);
        break;
      }
    }
    if (!dead) {
      for (let j = run.enemyShots.length - 1; j >= 0; j--) {
        const m = run.enemyShots[j]!;
        if (m.kind !== 'missile' || !sweptHit(s.px, s.py, s.x, s.y, m.x, m.y, m.radius + RUN.shotRadius + 2)) continue;
        dead = true;
        m.hp -= s.damage;
        if (m.hp <= 0) {
          run.enemyShots.splice(j, 1);
          events.push({ type: 'shotDown', x: m.x, y: m.y });
        }
        break;
      }
    }
    if (!dead) {
      for (const m of run.mines) {
        if (!sweptHit(s.px, s.py, s.x, s.y, m.x, m.y, 7 + RUN.shotRadius)) continue;
        dead = true;
        triggerMine(m);
        break;
      }
    }
    if (dead) run.shots.splice(i, 1);
  }
}

/* ------------------------------------------------------------------ step */

/** Advance one fixed tick. Only the 'flight' phase moves anything. */
export function stepSector(run: SectorRun, input: SectorInput): SectorEvent[] {
  if (run.phase !== 'flight' || run.disposed) return [];
  const L = run.layout;
  const sh = run.ship;
  const events: SectorEvent[] = [];

  /* environment: clouds modify handling; stars burn the shield inside their glow */
  let speedMul = 1;
  let extraDrag = 0;
  let pullX = 0;
  let pullY = 0;
  let drain = 0;
  for (const g of L.regions) {
    if (g.kind !== 'nebula' || g.effect === 'none') continue;
    const d = dist(sh, g);
    if (d > g.r) continue;
    const k = g.strength;
    if (g.effect === 'dust') extraDrag += RUN.dustDrag * k;
    else if (g.effect === 'ion-storm') speedMul = Math.min(speedMul, 1 - (1 - RUN.ionSpeed) * k);
    else if (g.effect === 'gravity-shear') {
      pullX += ((g.x - sh.x) / (d || 1)) * RUN.shearPull * k;
      pullY += ((g.y - sh.y) / (d || 1)) * RUN.shearPull * k;
    } else drain += RUN.hazardDrain * k; // radiation, flare
  }
  for (const l of L.landmarks) {
    if (l.hazardR <= l.r) continue;
    const d = dist(sh, l);
    if (d < l.hazardR) drain += RUN.coronaDrain * Math.min(1, (l.hazardR - d) / (l.hazardR - l.r));
  }
  const mods: ShipModifiers = { speedMul, extraDrag, pullX, pullY };
  /* P04.3 REALISTIC: STOP's toggle and hand-back come first (while STOP flies the ship, the engine and boost stay silent) */
  const vec = run.flightMode === 'realistic' && !run.flight ? (input.vector ?? NO_CONTROLS) : null;
  if (vec) {
    const change = updateStationKeeping(run.stop, input.stopToggle === true, vectorMoving(vec));
    if (change) events.push({ type: 'stop', change });
  } else if (input.stopToggle === true) events.push({ type: 'stop', change: 'unavailable' });
  /* P07.1 Silent Running: the toggle; a boost or FIRE request drops it, then runs once through its normal path below */
  if (input.silentToggle === true && !run.docked) {
    run.silent = !run.silent;
    events.push({ type: 'silent', change: run.silent ? 'on' : 'off' });
  }
  if (run.silent && (input.fire === true || input.boost === true)) {
    run.silent = false;
    events.push({ type: 'silent', change: input.fire === true ? 'fire' : 'boost' });
  }
  /* boost: spend energy while held with thrust; the level eases so the top speed never jumps */
  const st = run.craft.stats;
  const thrustIn = Math.hypot(Number.isFinite(input.moveX) ? input.moveX : 0, Number.isFinite(input.moveY) ? input.moveY : 0) > 0.05 && !(vec && run.stop.phase !== 'off');
  run.boosting = input.boost === true && thrustIn && (run.boosting ? run.energy > 0 : run.energy >= RUN.boostMinStart);
  if (run.boosting) {
    run.energy = Math.max(0, run.energy - RUN.boostDrain / 60);
    run.sinceBoost = 0;
    run.boost = Math.min(1, run.boost + RUN.boostRise);
  } else {
    run.sinceBoost += 1;
    if (run.sinceBoost > RUN.energyDelayTicks) run.energy = Math.min(st.energy, run.energy + st.energyRegen / 60);
    run.boost = Math.max(0, run.boost - RUN.boostFall);
  }
  const tune = run.boost > 0 ? { ...run.tune, accel: run.tune.accel * (1 + (RUN.boostAccelMul - 1) * run.boost), maxSpeed: run.tune.maxSpeed * (1 + (RUN.boostSpeedMul - 1) * run.boost) } : run.tune;
  /* P04.1 ship lock: the toggle, then a re-check; a held lock becomes the aim of the one orientation rule
     (sim.ts stepShip), replacing mouse aim / right stick. Position, velocity and thrust are never touched. */
  if (input.lockToggle === true) toggleShipLock(run, events);
  if (input.targetCycle === true) cycleShipLock(run, events);
  const lockAim = stepShipLock(run, events);
  if (lockAim && !run.flight) input = { ...input, aimX: lockAim.x, aimY: lockAim.y };
  let moved: { distance: number; pushed: boolean };
  if (run.flight) {
    // the gravity lab owns the physics (its own planet and pull): no landmark pull on top
    if (run.gravity.g !== 0) Object.assign(run.gravity, freshGravity());
    moved = run.flight.stepShip(run, input, mods, tune, events);
  } else if (vec) {
    // P04.3 REALISTIC: vector flight in the sector's real wells (the same capped field as below), STOP inside the substeps
    moved = stepRealistic(run.realistic, { ship: sh, controls: vec, base: run.tune, tune, mods, wells: run.wells, lockAim, stop: run.stop, width: L.width, height: L.height, gravityOut: run.gravity });
  } else {
    // FR-TD-86: planets and stars pull the ship through the same modifier as gravity-shear clouds
    const g = pullOn(run.wells, sh.x, sh.y, run.tune.accel, run.gravity);
    moved = stepShip(sh, input, L.width, L.height, g.g > 0 ? { ...mods, pullX: pullX + g.x, pullY: pullY + g.y } : mods, tune);
  }
  run.distance += moved.distance;
  if (moved.pushed) events.push({ type: 'edge' });
  if (drain > 0) damagePlayer(run, drain / 60, 'hazard', events);

  /* collisions with solids: push out, bounce, damage on hard impacts */
  const collide = (x: number, y: number, r: number): void => {
    const dx = sh.x - x;
    const dy = sh.y - y;
    const d = Math.hypot(dx, dy);
    const min = r + run.tune.radius;
    if (d >= min) return;
    const nx = d > 0 ? dx / d : 0;
    const ny = d > 0 ? dy / d : -1;
    sh.x = x + nx * min;
    sh.y = y + ny * min;
    const vn = sh.vx * nx + sh.vy * ny;
    if (vn < 0) {
      sh.vx -= (1 + RUN.restitution) * vn * nx;
      sh.vy -= (1 + RUN.restitution) * vn * ny;
      if (-vn > RUN.impactSpeed && run.invuln === 0) damagePlayer(run, Math.round(2 + -vn / 50), 'impact', events, { x, y });
    }
  };
  for (const l of L.landmarks) collide(l.x, l.y, l.r);
  for (const r of L.rocks) if (Math.abs(r.x - sh.x) < r.r + 40 && Math.abs(r.y - sh.y) < r.r + 40) collide(r.x, r.y, r.r);
  for (const p of L.pois) if (p.solidR > 0) collide(p.x, p.y, p.solidR);
  sh.x = Math.min(L.width, Math.max(0, sh.x));
  sh.y = Math.min(L.height, Math.max(0, sh.y));

  /* weapons (Combat P03C): one switch step, then FIRE drives the selected weapon only */
  if (input.cycle === 1 || input.cycle === -1) switchWeapon(run, input.cycle, events);
  const gun = run.arsenal.selected === 'plasma';
  const firing = input.fire === true;
  if (run.fireCooldown > 0) run.fireCooldown -= 1;
  coolWeapon(run, gun && firing, events);
  if (gun && firing && !run.overheated) fire(run, events);
  stepShots(run, events);
  /* ordnance: cooldowns, the FIRE press edge, the lock; then move every missile (one impact each) */
  stepMissileSkill(run, firing, events);
  stepMissiles(run, events);

  /* fly-through interactions: survey marks and salvage (a find that does not fit opens the full-hold offer) */
  for (const p of L.pois) {
    if (p.kind !== 'survey' && p.kind !== 'salvage') continue;
    if (isDone(run, p) || dist(sh, p) > p.r + run.tune.radius) continue;
    if (p.kind === 'salvage') {
      const n = events.length;
      touchPoi(run, p, events);
      if (events.slice(n).some((e) => e.type === 'collected')) salvageTaken(run, p, events);
      continue;
    }
    run.done.add(p.id);
    events.push({ type: 'recorded', id: p.id, remaining: marksLeft(run) });
  }
  /* the cargo wreck: fly through it to recover what was left there */
  const w = run.cargoWreck;
  if (w && dist(sh, w) <= COMBAT.wreckPickup + run.tune.radius) touchWreck(run, events, COMBAT.wreckPickup + run.tune.radius);
  if (run.tick % 6 === 0) sense(run);

  /* combat: warp-ins, encounters, patrols, enemy ships, their fire, mines and hazards */
  stepPending(run);
  stepEncounters(run, events);
  stepPatrols(run);
  run.flight?.beforeAgents?.(run);
  stepAgents(run, events);
  stepEnemyShots(run, events);
  stepMines(run, events);
  stepEruptions(run, events);
  stepDilation(run, events);
  /* the locked ship was destroyed or escaped this tick (it is already out of the list): end the lock with that reason */
  if (run.shipLock.target !== null) {
    const id = run.shipLock.target;
    const gone = events.find((e) => (e.type === 'destroyed' || e.type === 'escaped') && e.hostile === id);
    if (gone) endShipLock(run, gone.type === 'destroyed' ? 'destroyed' : 'gone', events);
  }
  /* collection: salvage pods from ships the pilot destroyed (once per ship, capped), floating pickups, the offer */
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === 'destroyed') killDrop(run, e, events);
  }
  stepPickups(run, events);
  stepOffer(run);
  if (run.grace > 0) run.grace -= 1;
  const level = combatLevel(run);
  if (level !== run.combat) {
    run.combat = level;
    events.push({ type: 'combat', level });
  }

  /* shield: invulnerability time, regeneration; an empty hull destroys the ship (recall) */
  if (run.invuln > 0) run.invuln -= 1;
  run.sinceHit += 1;
  if (run.sinceHit > RUN.regenDelayTicks && run.shield < st.shield && !run.silent) run.shield = Math.min(st.shield, run.shield + st.shieldRegen / 60);
  if (run.hull <= 0) {
    events.push({ type: 'wrecked', x: run.ship.x, y: run.ship.y, heading: run.ship.heading });
    recall(run);
    events.push({ type: 'recalled' });
  }

  /* P06.1: a signal observation in progress (after the ship moved; a recall above already reset it) */
  stepSignal(run, events);

  /* button interactions: the nearest usable one in range */
  run.focus = focusOf(run);
  run.flight?.afterTick?.(run, events);

  run.tick += 1;
  if (!run.surveyed && marksLeft(run) === 0) {
    run.surveyed = true;
    run.completeTick = run.tick;
    run.phase = 'complete';
    sh.thrusting = false;
    clearShipLock(run); // the survey-complete panel covers the flight view
    clearStationKeeping(run.stop);
    cancelBearing(run);
    events.push({ type: 'surveyComplete', ticks: run.tick }, { type: 'phase', phase: 'complete' });
  }
  return events;
}

function focusOf(run: SectorRun): string | null {
  // P06.2: the signal being observed keeps the prompt (its hold progress) until the bearing ends
  const obs = run.signal.obs;
  if (obs) return obs.id;
  let best: string | null = null;
  let bestD = Infinity;
  let far: string | null = null;
  let farD = Infinity;
  for (const p of run.layout.pois) {
    if (POI_RULES[p.kind].auto) continue;
    if (isDone(run, p)) continue;
    if (p.kind === 'gate' && run.gates[p.id]?.state === 'dormant') continue;
    // P06.1: an anomaly's signal answers within sensor range (bearings), then at its fix (investigation)
    const at = p.kind === 'anomaly' ? signalReach(run, p) : null;
    const d = dist(run.ship, at ?? p);
    if (d <= p.r + run.tune.radius) {
      if (d < bestD) {
        best = p.id;
        bestD = d;
      }
    } else if (at && d <= at.r && d < farD) {
      // P06.2: a bearing from afar never takes the prompt from a station, gate or find within its own reach
      far = p.id;
      farD = d;
    }
  }
  return best ?? far;
}

/**
 * Return the ship to the arrival zone with a full hull, shield and energy;
 * every temporary entity is reset (live encounters reset without pay, field
 * mines are re-laid) and the arrival grace starts again.
 */
function recall(run: SectorRun): void {
  const sp = run.layout.spawns[0]!;
  run.ship = freshShip(sp.x, sp.y, sp.heading);
  run.shield = run.craft.stats.shield;
  run.hull = run.craft.stats.hull;
  run.energy = run.craft.stats.energy;
  run.boost = 0;
  run.boosting = false;
  run.silent = false; // P07.1
  run.shieldHit = null;
  run.docked = null;
  run.offer = null; // pickups stay where they are; the budget is not refilled
  run.snooze = null;
  run.invuln = COMBAT.recallInvulnTicks;
  run.sinceHit = RUN.regenDelayTicks;
  resetEncounters(run);
  run.hostiles.length = 0;
  run.shots.length = 0;
  run.enemyShots.length = 0;
  run.mines.length = 0;
  layFieldMines(run);
  run.provoked.clear();
  run.grace = run.row.grace;
  run.combat = 'calm';
  run.fireCooldown = 0;
  run.heat = 0;
  run.overheated = false;
  resetMissiles(run);
  clearShipLock(run);
  clearStationKeeping(run.stop); // P04.3: no STOP or hold point survives a recall / restart
  resetSignals(run); // P06.1: partial bearings are temporary sector state
  Object.assign(run.gravity, freshGravity());
  for (const st of run.patrols.values()) {
    st.awake = false;
    st.cooldown = RUN.recallCooldownTicks;
  }
  run.recalls += 1;
}

/** Use the focused POI (Enter / Space / pad A / the INTERACT button). */
export function interact(run: SectorRun): SectorEvent[] {
  if (run.phase !== 'flight' || run.disposed || !run.focus) return [];
  const p = poiById(run.layout, run.focus);
  if (!p) return [];
  if (p.kind === 'anomaly') {
    // P06.1: an unresolved signal takes a bearing; a resolved one is investigated (the existing path) at its fix
    const r = startBearing(run, p);
    if (r) return [{ type: 'signal', id: p.id, label: p.label, result: r }];
    const fix = run.signal.tracks.get(p.id)?.fix;
    const ev = interactContainer(run, p, fix ?? p);
    run.focus = focusOf(run);
    return ev;
  }
  if (p.kind === 'derelict' || p.kind === 'cache') {
    const ev = interactContainer(run, p);
    run.focus = focusOf(run);
    return ev;
  }
  if (p.kind === 'station') {
    if (inCombat(run)) return [{ type: 'dockRefused' }];
    const first = !run.done.has(p.id);
    run.done.add(p.id);
    // docking repairs and recharges everything, and holds the ship still at the station
    run.shield = run.craft.stats.shield;
    run.hull = run.craft.stats.hull;
    run.energy = run.craft.stats.energy;
    run.ship.vx = 0;
    run.ship.vy = 0;
    run.docked = p.id;
    run.silent = false; // P07.1: the station holds the ship at its normal signature
    cancelBearing(run); // P06.1: docking ends a signal observation
    clearShipLock(run); // docked: no combat lock
    clearStationKeeping(run.stop); // docked: the station holds the ship
    return [{ type: 'docked', id: p.id, first }];
  }
  if (p.kind === 'gate') return [{ type: 'gate', id: p.id, target: p.target!, gate: run.gates[p.id] ?? { state: 'dormant', label: 'Dormant gate', detail: 'No signal.' } }];
  if (p.kind === 'exit') return [{ type: 'exit' }];
  return [];
}

/* collection API for the shell (sector/collect.ts) */
export { chipsLeft, jettison, leaveOffer, lootOf, takeOffer, type LootOffer, type Pickup, type PickupKind } from './collect.ts';

export function pauseSector(run: SectorRun): SectorEvent[] {
  if (run.phase !== 'flight') return [];
  run.phase = 'paused';
  run.ship.thrusting = false;
  cancelBearing(run);
  return [{ type: 'phase', phase: 'paused' }];
}

/** Resume from the pause menu, or keep exploring after the survey-complete panel. */
export function resumeSector(run: SectorRun): SectorEvent[] {
  if (run.phase !== 'paused' && run.phase !== 'complete' && run.phase !== 'briefing') return [];
  run.phase = 'flight';
  run.docked = null; // launching from the hangar undocks
  cancelBearing(run);
  return [{ type: 'phase', phase: 'flight' }];
}

/** Restart from the arrival: temporary state resets, persistent progress stays. */
export function restartSector(run: SectorRun): SectorEvent[] {
  recall(run);
  run.recalls -= 1;
  for (const st of run.patrols.values()) st.cooldown = 0;
  run.invuln = 0;
  run.tick = 0;
  run.distance = 0;
  run.phase = 'flight';
  return [{ type: 'phase', phase: 'flight' }];
}

/** Drop every temporary entity. The run must not be stepped afterwards (stepping a disposed run is a no-op). */
export function disposeSectorRun(run: SectorRun): void {
  run.hostiles.length = 0;
  run.shots.length = 0;
  run.enemyShots.length = 0;
  resetMissiles(run);
  clearShipLock(run);
  run.mines.length = 0;
  run.pending.length = 0;
  run.encounters.length = 0;
  run.provoked.clear();
  run.cargoWreck = null;
  run.pickups.length = 0;
  run.offer = null;
  run.snooze = null;
  run.patrols.clear();
  run.signal.tracks.clear();
  cancelBearing(run);
  run.focus = null;
  run.silent = false;
  run.disposed = true;
}

/** The objective the navigation arrow points to: next survey mark, else the exit beacon. */
export function objectiveOf(run: SectorRun): Poi | null {
  let best: Poi | null = null;
  let bestD = Infinity;
  for (const p of run.layout.pois) {
    if (p.kind !== 'survey' || isDone(run, p)) continue;
    const d = dist(run.ship, p);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best ?? run.layout.pois.find((p) => p.kind === 'exit') ?? null;
}

/**
 * Combat P03C: re-arm after a change in the hangar or the armory (ship, start
 * weapon, rotation) and set the stocked counts (docking restock). Cooldowns
 * carry over; the selection is validated against the new rotation (an
 * illegal weapon can never stay selected); a lock in progress is dropped.
 */
export function setRunLoadout(run: SectorRun, loadout: ArsenalSpec, shipChanged: boolean): void {
  const keep = run.arsenal;
  const next = createArsenal(loadout, keep);
  // a new ship starts on its own start weapon; the same ship keeps the selection while it stays legal
  if (!shipChanged && next.rotation.includes(keep.selected)) next.selected = keep.selected;
  run.arsenal = next;
  if (run.missile.state === 'acquiring') {
    run.missile.state = 'ready';
    run.missile.target = null;
    run.missile.lock = 0;
  }
}

/** P04: switch the admin sandbox's unlimited ammunition on or off for a running sector. */
export function setRunUnlimitedAmmo(run: SectorRun, on: boolean): void {
  run.unlimitedAmmo = on;
}

/**
 * P04: dock at once when the ship already sits inside a station's docking
 * range (an admin arrival beside the station). The same check and the same
 * docking as an INTERACT press; nothing happens anywhere else.
 */
export function dockIfInRange(run: SectorRun): SectorEvent[] {
  if (run.phase !== 'flight' || run.disposed || run.docked) return [];
  const focus = focusOf(run);
  const p = focus ? poiById(run.layout, focus) : undefined;
  if (p?.kind !== 'station') return [];
  run.focus = focus;
  return interact(run);
}

export function setRunOrdnance(run: SectorRun, counts: Readonly<Record<string, number>>): void {
  const c = cleanOrdnance(counts).counts;
  for (const k of Object.keys(run.ammo)) delete run.ammo[k];
  Object.assign(run.ammo, c);
}
