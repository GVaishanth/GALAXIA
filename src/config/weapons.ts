/**
 * Shared weapon catalogue (Combat P03B, FR-TD-88): the one authoritative
 * definition of the four weapon types a pilot can carry. Mode-neutral and pure
 * (config/ imports nothing), so Free Roam, its save sanitiser, the Armory and
 * (later) Classic all read the same values.
 *
 * Units are the Free Roam simulation's: distances and radii in art px, speeds
 * in art px / s, accelerations in art px / s², times in 60 Hz ticks, turn
 * rates in rad / s. A Classic adapter converts them with its own playfield
 * scale; it must not keep a second set of numbers.
 *
 * Every weapon is LIVE since Combat P03C (FR-TD-89); `runtime` states it per
 * weapon and the Armory shows it as it is:
 *  - plasma: in Free Roam it fires the gun module fitted in the ship's first
 *    weapon slot (ships/equipment.ts): cadence, damage, speed and reach come
 *    from that module and its upgrades, so this entry carries no gun numbers
 *    of its own (one source per number). In Classic it is the original shot.
 *  - heavy-missile, lock-missile, nuke: fired with FIRE when selected
 *    (Free Roam: combat/playerMissile.ts; Classic: core/systems/ordnance.ts
 *    through CLASSIC_ORDNANCE below). The runtime state shared by both modes
 *    (rotation, selection, cooldowns, fire checks) is core/weapons/arsenal.ts.
 *
 * Compatibility is by mount: a weapon fits a ship whose data lists the
 * weapon's mount (Free Roam: ships/roster.ts `mounts`). Nothing in the UI
 * decides it.
 */

export const WEAPON_IDS = ['plasma', 'heavy-missile', 'lock-missile', 'nuke'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];

export type WeaponCategory = 'beam' | 'missile' | 'nuke';

/**
 * Mount types a hull can provide. `primary` = the gun hardpoint every ship
 * has; `missile-rack` = the pilot missile launcher; `heavy-rack` = a launcher
 * for the heavy missile; `nuke-bay` = the restricted bay of advanced ships.
 */
export const MOUNT_TYPES = ['primary', 'missile-rack', 'heavy-rack', 'nuke-bay'] as const;
export type MountType = (typeof MOUNT_TYPES)[number];

/** Ammunition rule. `stock` counts are saved in the pilot's profile (Free Roam: `ordnance`). */
export type AmmoRule =
  | { readonly kind: 'unlimited' }
  /** Spends the ship's boost energy per launch (no count). */
  | { readonly kind: 'energy'; readonly cost: number }
  /** A saved count, at most `capacity`; new pilots start with `initial`; refilled to `capacity` when docking at a station. */
  | { readonly kind: 'stock'; readonly capacity: number; readonly initial: number; readonly restock: 'dock' };

/** Explosion: every eligible ship within `radius` of the detonation takes damage falling linearly from `damage` (centre) to `damage × edgeMul` (edge). */
export interface Blast {
  readonly radius: number;
  readonly damage: number;
  readonly edgeMul: number;
}

/** A launched projectile (missiles, nuke). */
export interface Projectile {
  /** Speed added to the ship's forward speed at launch. */
  readonly launchSpeed: number;
  /** Top speed and acceleration. */
  readonly speed: number;
  readonly accel: number;
  /** Flight time. */
  readonly lifeTicks: number;
  /** Collision radius. */
  readonly radius: number;
  /** What the end of its life does: detonate there (timed fuse) or fizzle with no damage. */
  readonly onExpiry: 'detonate' | 'fizzle';
  /** At most this many in flight at once. */
  readonly maxLive: number;
}

/** Target acquisition before launch (lock-on weapons). */
export interface Acquisition {
  /** A target must be this close... */
  readonly range: number;
  /** ...and within this half-angle of the nose (rad). */
  readonly cone: number;
  /** The lock holds while the target stays inside this range and half-angle. */
  readonly keepRange: number;
  readonly keepCone: number;
  /** Sensor interference shortens the acquisition range by this factor. */
  readonly jammedRangeMul: number;
  /** Lock time before launch. */
  readonly lockTicks: number;
}

export type Guidance =
  /** Flies straight where the nose pointed: aim and timing decide. */
  | { readonly kind: 'none' }
  /** Pure pursuit of the locked target, turning at most `turn` rad/s; flies straight for `lostLife` ticks if the target is lost. */
  | { readonly kind: 'lock'; readonly turn: number; readonly lostLife: number; readonly acquire: Acquisition };

/** Local time dilation around a detonation (the nuke). */
export interface TimeDilation {
  /** Simulation speed of affected entities (0.5 = half speed). */
  readonly scale: number;
  readonly durationTicks: number;
  /**
   * Radius of the dilation zone, centred on the detonation and fixed for its
   * duration. An eligible entity moves at `scale` while it is inside the zone:
   * one that enters later is slowed from then on, one that leaves (or outlives
   * the zone) is back to normal speed at once. Overlapping zones never stack:
   * the slowest applicable scale wins.
   */
  readonly radius: number;
  /** Which moving entities are eligible. The pilot's own ship is never slowed. */
  readonly affects: readonly ('hostile-ships' | 'hostile-shots')[];
}

/** Damage rules and exceptions that apply to every hit of the weapon. */
export interface DamageRules {
  /** Multiplier on damage to capital-class bosses (1 = full damage). */
  readonly bossMul: number;
  /** Ships hostile to the pilot only: never the pilot, stations or neutral traffic. */
  readonly hits: 'hostiles';
}

/** Presentation of the detonation (consumed by the renderer in the combat update). */
export interface DetonationEffect {
  /** Existing sprite drawn at the detonation. */
  readonly sprite: 'fx.explosion.enemy';
  /** Expanding blast ring and a full-screen flash (0 = none: no weapon flashes the whole screen), in ticks. */
  readonly ringTicks: number;
  readonly flashTicks: number;
}

interface WeaponBase {
  readonly id: WeaponId;
  readonly name: string;
  /** Short label for chips and the switching cycle (upper case). */
  readonly short: string;
  readonly category: WeaponCategory;
  /** Category line shown under the name. */
  readonly kind: string;
  /** Armory glyph (a distinct shape per weapon, see ships/armoryPanel.ts). */
  readonly icon: 'plasma' | 'heavy-missile' | 'lock-missile' | 'nuke';
  readonly mount: MountType;
  /** May be chosen as the weapon a ship starts a flight with. */
  readonly initialSelectable: boolean;
  /** Tactical role, one line. */
  readonly role: string;
  readonly description: string;
  /** Two or three short practical tips. */
  readonly tactics: readonly string[];
  readonly ammo: AmmoRule;
  readonly damageRules: DamageRules;
  /** Where the weapon stands in the game today (shown to the player as is). */
  readonly runtime: { readonly status: 'live' | 'partial' | 'pending'; readonly note: string };
}

/** The ship's fitted gun (Free Roam: the module in weapon slot 0). */
export interface GunWeapon extends WeaponBase {
  readonly fire: 'fitted-gun';
  /** Existing sprite of the bolt. */
  readonly sprite: 'fx.shot.player';
}

export interface OrdnanceWeapon extends WeaponBase {
  readonly fire: 'ordnance';
  readonly projectile: Projectile;
  readonly guidance: Guidance;
  /** Damage to the ship a projectile strikes directly (it then detonates; the blast does not hit that ship again). */
  readonly impactDamage: number;
  /** null = no explosion (direct hit only). */
  readonly blast: Blast | null;
  /** Ticks from one launch to the next. */
  readonly cooldownTicks: number;
  readonly dilation: TimeDilation | null;
  readonly effect: DetonationEffect;
}

export type WeaponDef = GunWeapon | OrdnanceWeapon;

/**
 * Tuning (initial values, derived from the game's scale): enemy hulls run
 * 16-140 (+ shields) for fighters to elites and 600 + 250 for the capital;
 * fighters are 8-13 px in radius and patrols fly 60-150 px apart. A heavy
 * blast of 96 px catches a tight patrol, the lock-on blast of 36 px splashes
 * a wingman, and the nuke's 300 px covers most of a fight seen on screen.
 */
export const WEAPONS: readonly WeaponDef[] = Object.freeze([
  {
    id: 'plasma',
    name: 'Plasma Cannon',
    short: 'PLASMA',
    category: 'beam',
    kind: 'Primary · plasma bolts',
    icon: 'plasma',
    mount: 'primary',
    initialSelectable: true,
    role: 'Reliable primary weapon with unlimited fire.',
    description: 'Sustained, direct damage along the nose from the gun fitted in the first weapon slot. Never runs dry.',
    tactics: ['Your fallback: always in the cycle.', 'Lead moving targets; bolts inherit your speed.', 'Change the gun itself in EQUIPMENT.'],
    ammo: { kind: 'unlimited' },
    damageRules: { bossMul: 1, hits: 'hostiles' },
    runtime: { status: 'live', note: 'Fires with FIRE in every flight.' },
    fire: 'fitted-gun',
    sprite: 'fx.shot.player',
  },
  {
    id: 'heavy-missile',
    name: 'Heavy AoE Missile',
    short: 'HEAVY',
    category: 'missile',
    kind: 'Unguided missile · large blast',
    icon: 'heavy-missile',
    mount: 'heavy-rack',
    initialSelectable: true,
    role: 'Direct-fire missile with a large explosion.',
    description: 'No lock needed: it flies straight where you aim and bursts on contact or when its fuse runs out, hitting everything in a wide radius.',
    tactics: ['Rewards manual aim and timing.', 'Fire into groups: the blast hits them all.', 'The fuse bursts it at full range, even on a miss.'],
    ammo: { kind: 'stock', capacity: 4, initial: 4, restock: 'dock' },
    damageRules: { bossMul: 1, hits: 'hostiles' },
    runtime: { status: 'live', note: 'Select it and press FIRE: one missile per press.' },
    fire: 'ordnance',
    projectile: { launchSpeed: 120, speed: 400, accel: 700, lifeTicks: 108, radius: 5, onExpiry: 'detonate', maxLive: 2 },
    guidance: { kind: 'none' },
    impactDamage: 28,
    blast: { radius: 96, damage: 28, edgeMul: 0.5 },
    cooldownTicks: 240,
    dilation: null,
    effect: { sprite: 'fx.explosion.enemy', ringTicks: 24, flashTicks: 0 },
  },
  {
    id: 'lock-missile',
    name: 'Lock-On Missile',
    short: 'LOCK-ON',
    category: 'missile',
    kind: 'Guided missile · standard blast',
    icon: 'lock-missile',
    mount: 'missile-rack',
    initialSelectable: true,
    role: 'Guided attack against one chosen enemy.',
    description: 'Point the nose at a target to lock on, then the missile steers itself after it. Better guidance, smaller blast.',
    tactics: ['Hold the target in front of the nose until the lock closes.', 'A hard break can outturn it; elites may dodge.', 'Fizzles if it runs out of flight time.'],
    ammo: { kind: 'energy', cost: 30 },
    damageRules: { bossMul: 1, hits: 'hostiles' },
    runtime: { status: 'live', note: 'Select it and press FIRE with a target ahead: the lock closes, then it launches.' },
    fire: 'ordnance',
    projectile: { launchSpeed: 200, speed: 470, accel: 900, lifeTicks: 150, radius: 4, onExpiry: 'fizzle', maxLive: 2 },
    guidance: { kind: 'lock', turn: 3.2, lostLife: 45, acquire: { range: 600, cone: 0.55, keepRange: 720, keepCone: 1.0, jammedRangeMul: 0.6, lockTicks: 18 } },
    impactDamage: 18,
    blast: { radius: 36, damage: 9, edgeMul: 0.5 },
    cooldownTicks: 720,
    dilation: null,
    effect: { sprite: 'fx.explosion.enemy', ringTicks: 16, flashTicks: 0 },
  },
  {
    id: 'nuke',
    name: 'Nuke',
    short: 'NUKE',
    category: 'nuke',
    kind: 'Area weapon · time dilation',
    icon: 'nuke',
    mount: 'nuke-bay',
    initialSelectable: false,
    role: 'Rare, high-impact area weapon that slows time around it.',
    description: 'A slow warhead on a short fuse. Its blast covers most of a fight, and for 2 seconds every hostile ship and shot near it moves at half speed.',
    tactics: ['One charge: save it for a swarm or a turning fight.', 'Use the slow-down to escape or to line up shots.', 'Capital ships take half damage.'],
    ammo: { kind: 'stock', capacity: 1, initial: 1, restock: 'dock' },
    damageRules: { bossMul: 0.5, hits: 'hostiles' },
    runtime: { status: 'live', note: 'Select it and press FIRE: one charge per press, refilled when docking.' },
    fire: 'ordnance',
    projectile: { launchSpeed: 80, speed: 260, accel: 300, lifeTicks: 60, radius: 6, onExpiry: 'detonate', maxLive: 1 },
    guidance: { kind: 'none' },
    impactDamage: 60,
    blast: { radius: 300, damage: 60, edgeMul: 0.4 },
    cooldownTicks: 600,
    dilation: { scale: 0.5, durationTicks: 120, radius: 300, affects: ['hostile-ships', 'hostile-shots'] },
    effect: { sprite: 'fx.explosion.enemy', ringTicks: 40, flashTicks: 0 },
  },
] satisfies readonly WeaponDef[]);

export const WEAPON_BY_ID: ReadonlyMap<WeaponId, WeaponDef> = new Map(WEAPONS.map((w) => [w.id, w]));

export const isWeaponId = (x: unknown): x is WeaponId => typeof x === 'string' && (WEAPON_IDS as readonly string[]).includes(x);

/** The weapon every ship keeps: the primary gun (never removable from a rotation). */
export const PRIMARY_WEAPON: WeaponId = 'plasma';

/* ------------------------------------------------------------ validation */

/** Every reason a definition is unusable (empty = valid). Tests run it on the whole catalogue. */
export function weaponIssues(w: WeaponDef): string[] {
  const out: string[] = [];
  const pos = (v: number, name: string): void => {
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) out.push(`${w.id}: ${name} must be a positive number`);
  };
  if (!isWeaponId(w.id)) out.push(`${w.id}: unknown id`);
  if (!(MOUNT_TYPES as readonly string[]).includes(w.mount)) out.push(`${w.id}: unknown mount ${w.mount}`);
  if (!w.name || !w.short || !w.description || !w.role || w.tactics.length === 0) out.push(`${w.id}: missing text`);
  if (!(w.damageRules.bossMul > 0 && w.damageRules.bossMul <= 1)) out.push(`${w.id}: bossMul outside (0, 1]`);
  const a = w.ammo;
  if (a.kind === 'energy') pos(a.cost, 'energy cost');
  if (a.kind === 'stock') {
    pos(a.capacity, 'capacity');
    if (!Number.isInteger(a.capacity) || !Number.isInteger(a.initial) || a.initial < 0 || a.initial > a.capacity) out.push(`${w.id}: stock must be whole numbers with 0 <= initial <= capacity`);
  }
  if (w.fire === 'ordnance') {
    const p = w.projectile;
    for (const k of ['speed', 'accel', 'lifeTicks', 'radius', 'maxLive'] as const) pos(p[k], k);
    if (!(p.launchSpeed >= 0)) out.push(`${w.id}: launchSpeed must be >= 0`);
    pos(w.cooldownTicks, 'cooldownTicks');
    pos(w.impactDamage, 'impactDamage');
    if (w.blast) {
      pos(w.blast.radius, 'blast radius');
      pos(w.blast.damage, 'blast damage');
      if (!(w.blast.edgeMul >= 0 && w.blast.edgeMul <= 1)) out.push(`${w.id}: blast edgeMul outside [0, 1]`);
    }
    if (w.guidance.kind === 'lock') {
      pos(w.guidance.turn, 'turn');
      const q = w.guidance.acquire;
      for (const k of ['range', 'cone', 'keepRange', 'keepCone', 'jammedRangeMul', 'lockTicks'] as const) pos(q[k], k);
      if (q.keepRange < q.range || q.keepCone < q.cone) out.push(`${w.id}: the lock must hold at least as far as it is acquired`);
    }
    if (w.dilation) {
      if (!(w.dilation.scale > 0 && w.dilation.scale < 1)) out.push(`${w.id}: dilation scale outside (0, 1)`);
      pos(w.dilation.durationTicks, 'dilation duration');
      pos(w.dilation.radius, 'dilation radius');
    }
  } else if (a.kind !== 'unlimited') out.push(`${w.id}: the primary gun must have unlimited ammunition`);
  return out;
}

/* -------------------------------------------- saved ammunition (ordnance) */

/** Weapons whose ammunition is a saved count. */
export const STOCKED_WEAPONS: readonly WeaponId[] = WEAPONS.filter((w) => w.ammo.kind === 'stock').map((w) => w.id);

const stockOf = (id: WeaponId): Extract<AmmoRule, { kind: 'stock' }> | null => {
  const a = WEAPON_BY_ID.get(id)?.ammo;
  return a && a.kind === 'stock' ? a : null;
};

/** Ammunition counts a new pilot starts with. */
export function initialOrdnance(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of STOCKED_WEAPONS) out[id] = stockOf(id)!.initial;
  return Object.freeze(out);
}

/**
 * Saved counts made valid: one entry per stocked weapon, whole numbers in
 * 0..capacity. A missing record (a save from before P03B) or a missing entry
 * starts at the initial stock; anything else malformed is repaired.
 */
export function cleanOrdnance(raw: unknown): { readonly counts: Readonly<Record<string, number>>; readonly repaired: boolean } {
  if (raw === undefined) return { counts: initialOrdnance(), repaired: false };
  const ok = typeof raw === 'object' && raw !== null && !Array.isArray(raw);
  let repaired = !ok;
  const src = ok ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const id of STOCKED_WEAPONS) {
    const s = stockOf(id)!;
    const v = src[id];
    if (v === undefined) out[id] = s.initial;
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= s.capacity) out[id] = v;
    else {
      repaired = true;
      out[id] = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(s.capacity, Math.floor(v))) : s.initial;
    }
  }
  for (const k of Object.keys(src)) if (!STOCKED_WEAPONS.includes(k as WeaponId)) repaired = true;
  return { counts: out, repaired };
}

/** Docking at a station refills every `restock: 'dock'` weapon to capacity. */
export function restockOrdnance(counts: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
  const out: Record<string, number> = { ...cleanOrdnance(counts).counts };
  for (const id of STOCKED_WEAPONS) {
    const s = stockOf(id)!;
    if (s.restock === 'dock') out[id] = s.capacity;
  }
  return out;
}

/* ------------------------------------------------- Classic playfield adapter */

/**
 * Classic (Combat P03C, after Wave 20 is completed): how the catalogue's
 * Free Roam units map onto the fixed 448 x 576 Classic playfield. Classic
 * enemies are 16-20 units wide and 1-2 hits strong and the field is far
 * smaller than a Free Roam fight, so distances and speeds are scaled and
 * damage is converted to Classic hits. These are conversion factors, not a
 * second set of weapon numbers: every weapon value still comes from WEAPONS.
 */
export const CLASSIC_ORDNANCE = Object.freeze({
  /** Radii, acquisition range and launch offsets (art px -> Classic units). */
  distance: 0.5,
  /**
   * Lock-on acquisition / keep ranges. Not scaled down like radii: the fighter
   * sits at the bottom of a 576-unit field and the formation 330-450 units
   * above it, so half the Free Roam range (300) could never reach it.
   */
  acquireRange: 1,
  /** Speeds and accelerations (heavy missile reaches the top of the field within its fuse). */
  speed: 0.8,
  /** Damage per Classic hit: an enemy loses round(damage / hitDamage) hits, at least 1 inside a blast. */
  hitDamage: 14,
  /** Lock-on: Classic has no energy, so the cooldown alone gates it. */
  energy: false,
  /** Stock weapons start full and refill at every stage start (Classic has no stations). */
  refill: 'stage' as const,
  /** Weapon switching and cross-mode ships open once this Classic stage is COMPLETED (modes/crossMode.ts). */
  gateStage: 20,
});
