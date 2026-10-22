/**
 * Ship upgrades (Free Roam Prompt 11): eight per-ship tracks, Mk I to Mk III.
 *
 * Rules (all tested):
 *  - one level per track per ship; a ship owns a track's level, never the
 *    level twice (installing Mk II replaces Mk I: levels are cumulative
 *    totals, not stacked bonuses, so effects can never pile up);
 *  - levels install in order (Mk II needs Mk I fitted);
 *  - each ship caps some tracks (`UPGRADE_CAPS`): a cap of 0 = incompatible
 *    (no hold frame for the cargo track on an interceptor, and so on);
 *  - Mk II needs the `mk2` licence and Mk III the `mk3` licence, both earned
 *    from the story missions (progression/missionData.ts);
 *  - every cost is a non-negative integer of marks plus cargo materials;
 *  - effects are plain StatModifiers applied in deriveShip together with the
 *    modules (one sum, one product, then STAT_BOUNDS clamps), and a weapon
 *    tuning kept inside WEAPON_TUNING_RANGE.
 *
 * Pure data and rules: no DOM, no storage.
 */
import { deriveShip, MODULE_MUL_RANGE, STAT_BOUNDS, WEAPON_TUNING_RANGE, type ShipExtras, type WeaponTuning } from './equipment.ts';
import { SHIP_BY_ID } from './roster.ts';
import { STAT_KEYS, type DerivedShip, type Loadout, type ResourceCost, type ShipArchetype, type ShipId, type StatKey, type StatModifiers } from './types.ts';

export const UPGRADE_TRACKS = ['weapons', 'shields', 'hull', 'engines', 'handling', 'cargo', 'sensors', 'travel'] as const;
export type UpgradeTrack = (typeof UPGRADE_TRACKS)[number];
export type UpgradeLevel = 1 | 2 | 3;
export const MAX_UPGRADE_LEVEL = 3;
/** Installed levels of one ship (absent = not upgraded). */
export type UpgradeLevels = Readonly<Partial<Record<UpgradeTrack, UpgradeLevel>>>;

/** Licences the story chain awards (ids stored in the profile). */
export const UPGRADE_LICENCES = ['mk2', 'mk3'] as const;
export type UpgradeLicence = (typeof UPGRADE_LICENCES)[number];

export interface UpgradeCost {
  readonly marks: number;
  readonly materials: readonly ResourceCost[];
}

export interface UpgradeStep {
  readonly level: UpgradeLevel;
  /** Cumulative effect of the track at this level (replaces the previous level's). */
  readonly mods: StatModifiers;
  readonly weapon?: WeaponTuning | undefined;
  readonly cost: UpgradeCost;
  /** Licence needed (null = none). */
  readonly licence: UpgradeLicence | null;
}

export interface UpgradeTrackDef {
  readonly id: UpgradeTrack;
  readonly name: string;
  readonly description: string;
  /** Mk I, Mk II, Mk III (validated: exactly three, in order). */
  readonly steps: readonly UpgradeStep[];
}

const c = (marks: number, ...materials: [string, number][]): UpgradeCost => ({ marks, materials: materials.map(([resource, amount]) => ({ resource, amount })) });

export const UPGRADES: readonly UpgradeTrackDef[] = Object.freeze([
  {
    id: 'weapons',
    name: 'Weapon tuning',
    description: 'Retimed capacitors: the fitted weapon fires sooner and its bolts fly faster.',
    steps: [
      { level: 1, mods: {}, weapon: { cooldownMul: 0.92, shotSpeedMul: 1 }, cost: c(60, ['alloy', 3], ['circuits', 1]), licence: null },
      { level: 2, mods: {}, weapon: { cooldownMul: 0.85, shotSpeedMul: 1.05 }, cost: c(160, ['circuits', 3], ['components', 1]), licence: 'mk2' },
      { level: 3, mods: {}, weapon: { cooldownMul: 0.78, shotSpeedMul: 1.1 }, cost: c(360, ['circuits', 4], ['components', 3]), licence: 'mk3' },
    ],
  },
  {
    id: 'shields',
    name: 'Shield lattice',
    description: 'Denser emitter lattice: more shield capacity, then faster recharge.',
    steps: [
      { level: 1, mods: { add: { shield: 15 } }, cost: c(60, ['crystal', 2]), licence: null },
      { level: 2, mods: { add: { shield: 30, shieldRegen: 1 } }, cost: c(160, ['crystal', 4], ['circuits', 1]), licence: 'mk2' },
      { level: 3, mods: { add: { shield: 50, shieldRegen: 2 } }, cost: c(360, ['crystal', 6], ['components', 2]), licence: 'mk3' },
    ],
  },
  {
    id: 'hull',
    name: 'Hull plating',
    description: 'Extra alloy plating on the frame: more hull points.',
    steps: [
      { level: 1, mods: { add: { hull: 15 } }, cost: c(50, ['alloy', 4]), licence: null },
      { level: 2, mods: { add: { hull: 30 } }, cost: c(140, ['alloy', 8]), licence: 'mk2' },
      { level: 3, mods: { add: { hull: 50 } }, cost: c(320, ['alloy', 10], ['components', 2]), licence: 'mk3' },
    ],
  },
  {
    id: 'engines',
    name: 'Drive tuning',
    description: 'Rebalanced thrust chambers: more acceleration and top speed.',
    steps: [
      { level: 1, mods: { mul: { accel: 1.05, maxSpeed: 1.03 } }, cost: c(60, ['fuel', 2], ['alloy', 2]), licence: null },
      { level: 2, mods: { mul: { accel: 1.1, maxSpeed: 1.06 } }, cost: c(160, ['fuel', 3], ['circuits', 2]), licence: 'mk2' },
      { level: 3, mods: { mul: { accel: 1.15, maxSpeed: 1.1 } }, cost: c(360, ['fuel', 4], ['components', 2]), licence: 'mk3' },
    ],
  },
  {
    id: 'handling',
    name: 'Attitude jets',
    description: 'Stronger attitude jets: the nose turns faster.',
    steps: [
      { level: 1, mods: { mul: { turnRate: 1.06 } }, cost: c(50, ['scrap', 6], ['circuits', 1]), licence: null },
      { level: 2, mods: { mul: { turnRate: 1.12 } }, cost: c(140, ['circuits', 3]), licence: 'mk2' },
      { level: 3, mods: { mul: { turnRate: 1.2 } }, cost: c(320, ['circuits', 4], ['components', 2]), licence: 'mk3' },
    ],
  },
  {
    id: 'cargo',
    name: 'Hold bracing',
    description: 'Braced bulkheads: more cargo capacity in the same hull.',
    steps: [
      { level: 1, mods: { add: { cargo: 10 } }, cost: c(50, ['scrap', 8]), licence: null },
      { level: 2, mods: { add: { cargo: 20 } }, cost: c(140, ['alloy', 6]), licence: 'mk2' },
      { level: 3, mods: { add: { cargo: 35 } }, cost: c(320, ['alloy', 8], ['components', 1]), licence: 'mk3' },
    ],
  },
  {
    id: 'sensors',
    name: 'Sensor gain',
    description: 'Cooled receivers: longer sensor range on the sector map.',
    steps: [
      { level: 1, mods: { add: { sensor: 120 } }, cost: c(50, ['samples', 2]), licence: null },
      { level: 2, mods: { add: { sensor: 250 } }, cost: c(140, ['samples', 3], ['circuits', 2]), licence: 'mk2' },
      { level: 3, mods: { add: { sensor: 400 } }, cost: c(320, ['samples', 4], ['nav-data', 4]), licence: 'mk3' },
    ],
  },
  {
    id: 'travel',
    name: 'Drive efficiency',
    description: 'Charge recovery coils: fewer reactor cells per jump.',
    steps: [
      { level: 1, mods: { mul: { travel: 0.92 } }, cost: c(70, ['nav-data', 2]), licence: null },
      { level: 2, mods: { mul: { travel: 0.85 } }, cost: c(180, ['nav-data', 4], ['fuel', 2]), licence: 'mk2' },
      { level: 3, mods: { mul: { travel: 0.78 } }, cost: c(380, ['nav-data', 6], ['components', 2]), licence: 'mk3' },
    ],
  },
] satisfies UpgradeTrackDef[]);

export const UPGRADE_BY_TRACK: ReadonlyMap<UpgradeTrack, UpgradeTrackDef> = new Map(UPGRADES.map((u) => [u.id, u]));

/**
 * Highest level each archetype accepts per track (default 3; 0 = incompatible).
 * Small frames cannot take the heaviest work; specialists stay specialists.
 */
export const UPGRADE_CAPS: Readonly<Record<ShipArchetype, Partial<Record<UpgradeTrack, 0 | 1 | 2>>>> = Object.freeze({
  explorer: {},
  scout: { hull: 2, cargo: 1, weapons: 2 },
  interceptor: { cargo: 0, sensors: 2, travel: 2 },
  defender: { engines: 2, handling: 1 },
  salvager: { weapons: 2, handling: 2 },
  'long-range': { weapons: 2, handling: 1 },
});

export function maxLevel(ship: ShipId, track: UpgradeTrack): number {
  const def = SHIP_BY_ID.get(ship);
  if (!def) return 0;
  const cap = UPGRADE_CAPS[def.archetype][track];
  return cap === undefined ? MAX_UPGRADE_LEVEL : cap;
}

const isTrack = (x: unknown): x is UpgradeTrack => typeof x === 'string' && (UPGRADE_TRACKS as readonly string[]).includes(x);

/** Drop unknown tracks and levels above the ship's caps (old or edited saves). */
export function cleanLevels(ship: ShipId, raw: Readonly<Record<string, number>> | undefined): UpgradeLevels {
  const out: Partial<Record<UpgradeTrack, UpgradeLevel>> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!isTrack(k) || !Number.isInteger(v) || v < 1) continue;
    const lv = Math.min(v, maxLevel(ship, k));
    if (lv >= 1) out[k] = lv as UpgradeLevel;
  }
  return out;
}

/** The modifier sets and weapon tuning of the installed levels (capped per ship). */
export function upgradeEffects(ship: ShipId, levels: UpgradeLevels): ShipExtras {
  const clean = cleanLevels(ship, levels);
  const mods: StatModifiers[] = [];
  let weapon: WeaponTuning | undefined;
  for (const t of UPGRADE_TRACKS) {
    const lv = clean[t];
    if (!lv) continue;
    const step = UPGRADE_BY_TRACK.get(t)!.steps[lv - 1]!;
    mods.push(step.mods);
    if (step.weapon) weapon = step.weapon;
  }
  return { mods, weapon };
}

/** deriveShip with the ship's installed upgrades. */
export function upgradedShip(ship: ShipId, loadout: Loadout | undefined, levels: UpgradeLevels): DerivedShip {
  return deriveShip(ship, loadout, upgradeEffects(ship, levels));
}

export type UpgradeBlock = 'unknown' | 'incompatible' | 'max' | 'licence' | 'marks' | 'materials';

export interface UpgradeCheck {
  readonly ok: boolean;
  readonly reason: UpgradeBlock | null;
  readonly track: UpgradeTrack | null;
  /** Level installed now (0 = none). */
  readonly from: number;
  /** Level the purchase would install (0 when nothing can be installed). */
  readonly to: number;
  readonly cost: UpgradeCost | null;
  /** Materials still missing (empty when affordable). */
  readonly missing: readonly ResourceCost[];
  readonly licence: UpgradeLicence | null;
}

/** Can `track` go one level up on `ship`? Only the next level is ever offered (no skipping, no repeats). */
export function checkUpgrade(ship: ShipId, levels: UpgradeLevels, trackId: string, wallet: { readonly marks: number; readonly hold: Readonly<Record<string, number>> }, licences: readonly string[]): UpgradeCheck {
  if (!isTrack(trackId) || !SHIP_BY_ID.has(ship)) return { ok: false, reason: 'unknown', track: null, from: 0, to: 0, cost: null, missing: [], licence: null };
  const from = cleanLevels(ship, levels)[trackId] ?? 0;
  const cap = maxLevel(ship, trackId);
  const base = { track: trackId, from };
  if (cap === 0) return { ...base, ok: false, reason: 'incompatible', to: 0, cost: null, missing: [], licence: null };
  if (from >= cap) return { ...base, ok: false, reason: 'max', to: 0, cost: null, missing: [], licence: null };
  const step = UPGRADE_BY_TRACK.get(trackId)!.steps[from]!;
  const missing = step.cost.materials.filter((m) => (wallet.hold[m.resource] ?? 0) < m.amount).map((m) => ({ resource: m.resource, amount: m.amount - (wallet.hold[m.resource] ?? 0) }));
  const out = { ...base, to: step.level, cost: step.cost, missing, licence: step.licence };
  if (step.licence && !licences.includes(step.licence)) return { ...out, ok: false, reason: 'licence' };
  if (wallet.marks < step.cost.marks) return { ...out, ok: false, reason: 'marks' };
  if (missing.length) return { ...out, ok: false, reason: 'materials' };
  return { ...out, ok: true, reason: null };
}

/** Install the next level of a track (after checkUpgrade). Returns null when the check fails. */
export function installUpgrade(ship: ShipId, levels: UpgradeLevels, trackId: string, wallet: { readonly marks: number; readonly hold: Readonly<Record<string, number>> }, licences: readonly string[]): { readonly levels: UpgradeLevels; readonly check: UpgradeCheck } | null {
  const check = checkUpgrade(ship, levels, trackId, wallet, licences);
  if (!check.ok || !check.track) return null;
  return { levels: { ...cleanLevels(ship, levels), [check.track]: check.to as UpgradeLevel }, check };
}

/* ---------------------------------------------------------------- validation */

/** Data problems (a valid table has none; tests assert that). */
export function upgradeIssues(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of UPGRADES) {
    if (seen.has(u.id)) out.push(`${u.id}: duplicate track`);
    seen.add(u.id);
    if (u.steps.length !== MAX_UPGRADE_LEVEL) out.push(`${u.id}: needs ${MAX_UPGRADE_LEVEL} levels`);
    let prevMarks = -1;
    u.steps.forEach((s, i) => {
      if (s.level !== i + 1) out.push(`${u.id}: step ${i} has level ${s.level}`);
      if (!Number.isInteger(s.cost.marks) || s.cost.marks < 0) out.push(`${u.id} Mk${s.level}: bad marks cost`);
      if (s.cost.marks <= prevMarks) out.push(`${u.id} Mk${s.level}: cost does not rise`);
      prevMarks = s.cost.marks;
      for (const m of s.cost.materials) if (!Number.isInteger(m.amount) || m.amount <= 0) out.push(`${u.id} Mk${s.level}: bad material ${m.resource}`);
      for (const [k, v] of Object.entries(s.mods.add ?? {})) {
        if (!STAT_KEYS.includes(k as StatKey) || !Number.isFinite(v) || v < 0) out.push(`${u.id} Mk${s.level}: bad add ${k}`);
        else if (v > (STAT_BOUNDS[k as StatKey][1] - STAT_BOUNDS[k as StatKey][0]) / 4) out.push(`${u.id} Mk${s.level}: ${k} add too large`);
      }
      for (const [k, v] of Object.entries(s.mods.mul ?? {})) {
        if (!STAT_KEYS.includes(k as StatKey) || !Number.isFinite(v) || v < MODULE_MUL_RANGE[0] || v > MODULE_MUL_RANGE[1]) out.push(`${u.id} Mk${s.level}: bad mul ${k}`);
        else if (Math.abs(v - 1) > 0.25) out.push(`${u.id} Mk${s.level}: ${k} mul beyond ±25%`);
      }
      if (s.weapon) {
        const w = s.weapon;
        if (w.cooldownMul < WEAPON_TUNING_RANGE.cooldownMul[0] || w.cooldownMul > WEAPON_TUNING_RANGE.cooldownMul[1] || w.shotSpeedMul < WEAPON_TUNING_RANGE.shotSpeedMul[0] || w.shotSpeedMul > WEAPON_TUNING_RANGE.shotSpeedMul[1]) out.push(`${u.id} Mk${s.level}: weapon tuning out of range`);
      }
      if ((i === 0 && s.licence !== null) || (i === 1 && s.licence !== 'mk2') || (i === 2 && s.licence !== 'mk3')) out.push(`${u.id} Mk${s.level}: licence ladder broken`);
    });
  }
  if (UPGRADES.length !== UPGRADE_TRACKS.length) out.push('track list and table differ');
  return out;
}

export const LEVEL_NAME = (lv: number): string => (lv <= 0 ? '—' : `MK ${'I'.repeat(Math.min(3, lv))}`);
