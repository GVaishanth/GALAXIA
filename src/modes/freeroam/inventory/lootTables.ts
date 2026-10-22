/**
 * Central loot tables (Free Roam Prompt 10). Every reward in Free Roam is
 * rolled here: sector containers (generation time, from each POI's own seed
 * stream), encounter sites, ore veins, enemy salvage pods and missions.
 * Nothing else defines drop weights.
 *
 * Rules (tests/inventoryLoot.test.ts):
 *  - deterministic: rollLoot only draws from the Rng it is given (the
 *    generator's per-POI streams, or the run's seeded loot stream);
 *  - rare resources are never guaranteed: the per-roll rare chance is 0 at
 *    difficulty 1 and capped below 0.5 everywhere (RARE_CAP), and a sector
 *    never has every container rare (generate.ts demotes the last one);
 *  - every amount is an integer in 1..99, and entries are merged per resource
 *    in catalogue order.
 *
 * Tokens: `primary` / `secondary` stand for the sector's catalogue resources
 * (SystemRecord.resources). A token that resolves to a rare resource, or to
 * nothing, is skipped in the common picks (rares come only from the rare roll).
 */
import type { Rng } from '../../../core/rng.ts';
import { RESOURCE_IDS, type FactionId, type ResourceId } from '../catalogue/types.ts';
import type { FamilyId } from '../combat/families.ts';
import type { LootEntry } from '../sector/model.ts';
import { RARE_IDS, type LootSource } from './resources.ts';

export type LootToken = ResourceId | 'primary' | 'secondary';

export interface LootPick {
  readonly item: LootToken;
  readonly weight: number;
  /** Units per pick before richness and the table multiplier. */
  readonly amount: readonly [number, number];
}

export interface RarePick {
  readonly item: ResourceId;
  readonly weight: number;
  /** Lowest sector difficulty this rare can appear in (a rare-rich sector lowers it to 2). */
  readonly minDifficulty: number;
}

export interface LootTable {
  readonly source: LootSource;
  /** Picks per roll (inclusive range). */
  readonly rolls: readonly [number, number];
  readonly picks: readonly LootPick[];
  /** Weight multiplier for picks of the sector's own resources (primary / secondary). */
  readonly localBoost: number;
  /** Added to a pick's maximum amount per sector richness point above 1. */
  readonly richBonus: number;
  /** Amount multiplier. */
  readonly mult: number;
  /** Rare chance per pick: base + perLevel × (difficulty − 1), from difficulty 2, at most `cap`. */
  readonly rareBase: number;
  readonly rarePerLevel: number;
  readonly rareCap: number;
  readonly rare: readonly RarePick[];
}

export const LOOT_TABLE_IDS = ['salvage', 'container', 'wreck', 'anomaly', 'outpost', 'ambush', 'defence', 'dispute', 'elite', 'capital', 'enemy', 'mining', 'mission'] as const;
export type LootTableId = (typeof LOOT_TABLE_IDS)[number];

/** No table may ever make a rare likelier than this per pick (validated). */
export const RARE_CAP = 0.45;
/** A sector whose own resources include a rare doubles every rare chance (still capped). */
export const RARE_RICH_MUL = 2;
/** Weight multiplier for the sector's own rare resource in the rare pool. */
export const RARE_LOCAL_WEIGHT = 4;

const RARES: readonly RarePick[] = [
  { item: 'core-shard', weight: 3, minDifficulty: 2 },
  { item: 'relic', weight: 1, minDifficulty: 4 },
];

const SITE_PICKS: readonly LootPick[] = [
  { item: 'primary', weight: 4, amount: [1, 2] },
  { item: 'secondary', weight: 3, amount: [1, 2] },
  { item: 'scrap', weight: 3, amount: [1, 2] },
  { item: 'alloy', weight: 2, amount: [1, 2] },
  { item: 'fuel', weight: 1, amount: [1, 2] },
  { item: 'components', weight: 2, amount: [1, 1] },
  { item: 'circuits', weight: 1, amount: [1, 1] },
  { item: 'nav-data', weight: 1, amount: [1, 1] },
];

const T = (t: LootTable): LootTable => Object.freeze(t);

export const LOOT_TABLES: Readonly<Record<LootTableId, LootTable>> = Object.freeze({
  /** Salvage nodes: small single finds, flown through. */
  salvage: T({
    source: 'salvage',
    rolls: [1, 1],
    picks: [
      { item: 'primary', weight: 5, amount: [1, 2] },
      { item: 'secondary', weight: 3, amount: [1, 2] },
      { item: 'scrap', weight: 2, amount: [1, 2] },
      { item: 'fuel', weight: 2, amount: [1, 1] },
      { item: 'components', weight: 1, amount: [1, 1] },
    ],
    localBoost: 1,
    richBonus: 1,
    mult: 1,
    rareBase: 0,
    rarePerLevel: 0.008,
    rareCap: 0.1,
    rare: RARES,
  }),
  /** Caches (opened containers). */
  container: T({
    source: 'container',
    rolls: [1, 3],
    picks: [
      { item: 'primary', weight: 5, amount: [1, 2] },
      { item: 'secondary', weight: 3, amount: [1, 2] },
      { item: 'scrap', weight: 2, amount: [1, 2] },
      { item: 'fuel', weight: 1, amount: [1, 2] },
      { item: 'circuits', weight: 2, amount: [1, 2] },
      { item: 'components', weight: 2, amount: [1, 1] },
      { item: 'nav-data', weight: 1, amount: [1, 1] },
      { item: 'samples', weight: 1, amount: [1, 1] },
    ],
    localBoost: 1,
    richBonus: 1,
    mult: 2,
    rareBase: 0,
    rarePerLevel: 0.025,
    rareCap: 0.3,
    rare: RARES,
  }),
  /** Derelicts (wreck exploration). */
  wreck: T({
    source: 'wreck',
    rolls: [1, 2],
    picks: [
      { item: 'primary', weight: 4, amount: [1, 2] },
      { item: 'secondary', weight: 2, amount: [1, 2] },
      { item: 'scrap', weight: 3, amount: [1, 2] },
      { item: 'alloy', weight: 2, amount: [1, 2] },
      { item: 'components', weight: 3, amount: [1, 1] },
      { item: 'circuits', weight: 2, amount: [1, 1] },
      { item: 'nav-data', weight: 1, amount: [1, 1] },
    ],
    localBoost: 1,
    richBonus: 1,
    mult: 2,
    rareBase: 0,
    rarePerLevel: 0.015,
    rareCap: 0.3,
    rare: RARES,
  }),
  /** Anomaly investigation: readings and crystals. */
  anomaly: T({
    source: 'anomaly',
    rolls: [1, 2],
    picks: [
      { item: 'samples', weight: 5, amount: [1, 2] },
      { item: 'crystal', weight: 3, amount: [1, 2] },
      { item: 'nav-data', weight: 2, amount: [1, 1] },
    ],
    localBoost: 1,
    richBonus: 0,
    mult: 1,
    rareBase: 0,
    rarePerLevel: 0.03,
    rareCap: 0.3,
    rare: RARES,
  }),
  /** Hostile outposts (installations): paid once when silenced. */
  outpost: T({
    source: 'outpost',
    rolls: [2, 3],
    picks: [
      { item: 'primary', weight: 5, amount: [1, 2] },
      { item: 'secondary', weight: 3, amount: [1, 2] },
      { item: 'scrap', weight: 2, amount: [1, 2] },
      { item: 'alloy', weight: 2, amount: [1, 2] },
      { item: 'components', weight: 2, amount: [1, 1] },
      { item: 'nav-data', weight: 1, amount: [1, 1] },
    ],
    localBoost: 1,
    richBonus: 1,
    mult: 3,
    rareBase: 0.06,
    rarePerLevel: 0.03,
    rareCap: 0.3,
    rare: RARES,
  }),
  /** Encounter sites (completion pays once). */
  ambush: T({ source: 'encounter', rolls: [2, 2], picks: SITE_PICKS, localBoost: 1, richBonus: 1, mult: 2, rareBase: 0.06, rarePerLevel: 0.03, rareCap: 0.3, rare: RARES }),
  defence: T({ source: 'encounter', rolls: [2, 2], picks: SITE_PICKS, localBoost: 1, richBonus: 1, mult: 2, rareBase: 0.06, rarePerLevel: 0.03, rareCap: 0.3, rare: RARES }),
  dispute: T({ source: 'encounter', rolls: [2, 2], picks: SITE_PICKS, localBoost: 1, richBonus: 1, mult: 2, rareBase: 0.03, rarePerLevel: 0.015, rareCap: 0.15, rare: RARES }),
  elite: T({ source: 'encounter', rolls: [3, 3], picks: SITE_PICKS, localBoost: 1, richBonus: 1, mult: 3, rareBase: 0.09, rarePerLevel: 0.045, rareCap: 0.45, rare: RARES }),
  capital: T({ source: 'encounter', rolls: [4, 4], picks: SITE_PICKS, localBoost: 1, richBonus: 1, mult: 4, rareBase: 0.12, rarePerLevel: 0.06, rareCap: 0.45, rare: RARES }),
  /** Salvage pods from destroyed enemy ships (rolled at the kill, from the run's loot stream). */
  enemy: T({
    source: 'enemy',
    rolls: [1, 1],
    picks: [
      { item: 'scrap', weight: 4, amount: [1, 2] },
      { item: 'alloy', weight: 2, amount: [1, 1] },
      { item: 'fuel', weight: 2, amount: [1, 1] },
      { item: 'components', weight: 2, amount: [1, 1] },
      { item: 'circuits', weight: 1, amount: [1, 1] },
      { item: 'crystal', weight: 1, amount: [1, 1] },
    ],
    localBoost: 1,
    richBonus: 0,
    mult: 1,
    rareBase: 0,
    rarePerLevel: 0.01,
    rareCap: 0.05,
    rare: [{ item: 'core-shard', weight: 1, minDifficulty: 2 }],
  }),
  /** Ore chips from marked veins (rolled at generation, one entry per chip). */
  mining: T({
    source: 'mining',
    rolls: [1, 1],
    picks: [
      { item: 'alloy', weight: 3, amount: [1, 2] },
      { item: 'ice', weight: 3, amount: [1, 2] },
      { item: 'crystal', weight: 2, amount: [1, 1] },
      { item: 'scrap', weight: 2, amount: [1, 2] },
      { item: 'samples', weight: 1, amount: [1, 1] },
    ],
    localBoost: 4,
    richBonus: 1,
    mult: 1,
    rareBase: 0,
    rarePerLevel: 0,
    rareCap: 0,
    rare: [],
  }),
  /** Mission rewards (no missions yet: the interface is ready for a later prompt). */
  mission: T({
    source: 'mission',
    rolls: [2, 3],
    picks: [
      { item: 'primary', weight: 3, amount: [1, 2] },
      { item: 'secondary', weight: 2, amount: [1, 2] },
      { item: 'scrap', weight: 1, amount: [1, 2] },
      { item: 'alloy', weight: 1, amount: [1, 2] },
      { item: 'fuel', weight: 1, amount: [1, 2] },
      { item: 'circuits', weight: 1, amount: [1, 1] },
      { item: 'crystal', weight: 1, amount: [1, 1] },
      { item: 'ice', weight: 1, amount: [1, 2] },
      { item: 'samples', weight: 1, amount: [1, 1] },
      { item: 'nav-data', weight: 2, amount: [1, 1] },
      { item: 'components', weight: 2, amount: [1, 1] },
    ],
    localBoost: 1,
    richBonus: 1,
    mult: 2,
    rareBase: 0.05,
    rarePerLevel: 0.03,
    rareCap: 0.3,
    rare: RARES,
  }),
});

/** What a roll needs to know about its sector. */
export interface LootContext {
  /** Sector difficulty 1..5. */
  readonly difficulty: number;
  /** Catalogue richness 1..3. */
  readonly richness: number;
  readonly primary: ResourceId | null;
  readonly secondary: ResourceId | null;
}

/** Extra weights for enemy salvage pods by faction and by ship family (added to the enemy table). */
export const FACTION_LOOT_BIAS: Readonly<Record<FactionId, Partial<Record<ResourceId, number>>>> = Object.freeze({
  tessellate: { circuits: 3, components: 2, crystal: 1 },
  'red-tally': { scrap: 2, fuel: 2, alloy: 1 },
  cordon: { components: 2, 'nav-data': 2 },
  gleaners: { scrap: 2, samples: 2 },
  'haven-guild': { 'nav-data': 2, fuel: 1 },
});
export const FAMILY_LOOT_BIAS: Readonly<Partial<Record<FamilyId, Partial<Record<ResourceId, number>>>>> = Object.freeze({
  recon: { 'nav-data': 3 },
  hauler: { alloy: 2, fuel: 2 },
  heavy: { components: 2 },
});

/**
 * Enemy salvage pods (capped kill drops, FR-TD-58). Only ships the pilot
 * destroys can drop one, at most once per ship; launched drones never drop.
 * A sector visit has a budget of pods (budgetBase + difficulty), kept through
 * a restart or a recall, so a patrol cannot be farmed. Encounter completion
 * still pays its own reward once.
 */
export const KILL_DROPS = Object.freeze({
  chance: Object.freeze({ raider: 0.25, picket: 0.3, lancer: 0.3, heavy: 0.6, recon: 0.45, hauler: 0.85, elite: 1, capital: 1 } satisfies Record<FamilyId, number>),
  extraRolls: Object.freeze({ raider: 0, picket: 0, lancer: 0, heavy: 1, recon: 0, hauler: 1, elite: 2, capital: 3 } satisfies Record<FamilyId, number>),
  budgetBase: 3 as number,
  /** Pod lifetime in ticks (40 s) and the final blinking stretch (10 s). */
  lifeTicks: 2400 as number,
  blinkTicks: 600 as number,
});

/** Mining tuning (veins are placed by sector/generate.ts from this config). */
export const MINING = Object.freeze({
  /** Veins per sector: at most this many, only on rocks at least minRockR in radius. */
  maxVeins: 4 as number,
  minRockR: 18 as number,
  /** Chips per vein (inclusive range). */
  chips: Object.freeze([3, 5] as const),
  /** Bolt hits that chip one fragment loose. */
  hitsPerChip: 3 as number,
  /** Ore fragment speed when chipped (art px / s); fragments slow to a stop. */
  chipSpeed: 70 as number,
});

/** Pickup radius for floating collectibles (pods, ore fragments, caches), art px; the ship radius is added. */
export const PICKUP_RADIUS = 18;
/** Jettisoned cargo floats for 60 s and can be picked up again until then. */
export const JETTISON_LIFE_TICKS = 3600;

/* ------------------------------------------------------------------ rolls */

const isRare = (id: ResourceId): boolean => RARE_IDS.includes(id);

function resolve(t: LootToken, ctx: LootContext): ResourceId | null {
  if (t === 'primary') return ctx.primary;
  if (t === 'secondary') return ctx.secondary;
  return t;
}

/** Per-pick rare chance of `table` in this context (0 at difficulty 1, never above the table cap or RARE_CAP). */
export function rareChanceOf(table: LootTable, ctx: LootContext): number {
  if (ctx.difficulty <= 1 || table.rare.length === 0) return 0;
  const rich = (ctx.primary !== null && isRare(ctx.primary)) || (ctx.secondary !== null && isRare(ctx.secondary));
  const base = table.rareBase + table.rarePerLevel * (ctx.difficulty - 1);
  return Math.min(table.rareCap, RARE_CAP, base * (rich ? RARE_RICH_MUL : 1));
}

function weighted<T>(rng: Rng, items: readonly (readonly [T, number])[]): T | null {
  let total = 0;
  for (const [, w] of items) total += w;
  if (total <= 0) return null;
  let r = rng.next() * total;
  for (const [x, w] of items) {
    r -= w;
    if (r < 0) return x;
  }
  return items[items.length - 1]![0];
}

/** The weighted common picks of a table in a context (rare and missing tokens removed, bias applied). */
export function commonPicks(table: LootTable, ctx: LootContext, bias?: Partial<Record<ResourceId, number>>): (readonly [{ readonly id: ResourceId; readonly amount: readonly [number, number] }, number])[] {
  const out: (readonly [{ readonly id: ResourceId; readonly amount: readonly [number, number] }, number])[] = [];
  for (const p of table.picks) {
    const id = resolve(p.item, ctx);
    if (!id || isRare(id)) continue;
    const local = table.localBoost !== 1 && (id === ctx.primary || id === ctx.secondary) ? table.localBoost : 1;
    out.push([{ id, amount: p.amount }, p.weight * local + (bias?.[id] ?? 0)]);
  }
  if (bias) {
    for (const id of RESOURCE_IDS) {
      const w = bias[id];
      if (!w || isRare(id) || out.some(([x]) => x.id === id)) continue;
      out.push([{ id, amount: [1, 1] }, w]);
    }
  }
  return out;
}

/** The rare pool of a table in a context (difficulty gates; the sector's own rare is likelier and opens at 2). */
export function rarePool(table: LootTable, ctx: LootContext): (readonly [ResourceId, number])[] {
  const local = (id: ResourceId): boolean => id === ctx.primary || id === ctx.secondary;
  return table.rare.filter((r) => ctx.difficulty >= (local(r.item) ? Math.min(2, r.minDifficulty) : r.minDifficulty)).map((r) => [r.item, r.weight * (local(r.item) ? RARE_LOCAL_WEIGHT : 1)] as const);
}

export interface RollOptions {
  /** Extra picks (bigger enemy ships). */
  readonly extraRolls?: number | undefined;
  /** Extra weights per resource (faction and family flavour of enemy pods). */
  readonly bias?: Partial<Record<ResourceId, number>> | undefined;
}

const clampAmount = (n: number): number => Math.max(1, Math.min(99, Math.round(n)));

/**
 * Roll one reward from a table. Pure and deterministic for a given Rng state:
 * every pick draws the rare check first (always, so the stream stays aligned),
 * then the resource and its amount.
 */
export function rollLoot(id: LootTableId, rng: Rng, ctx: LootContext, o: RollOptions = {}): LootEntry[] {
  const table = LOOT_TABLES[id];
  const picks = Math.max(0, rng.int(table.rolls[0], table.rolls[1]) + Math.max(0, Math.floor(o.extraRolls ?? 0)));
  const chance = rareChanceOf(table, ctx);
  const common = commonPicks(table, ctx, o.bias);
  const rares = rarePool(table, ctx);
  const rich = Math.max(1, Math.min(3, Math.floor(ctx.richness)));
  const out = new Map<ResourceId, number>();
  for (let i = 0; i < picks; i++) {
    const rareRoll = rng.next();
    if (rareRoll < chance && rares.length > 0) {
      const r = weighted(rng, rares);
      if (r) out.set(r, (out.get(r) ?? 0) + 1);
      continue;
    }
    const c = weighted(rng, common);
    if (!c) continue;
    const n = rng.int(c.amount[0], c.amount[1] + table.richBonus * (rich - 1)) * table.mult;
    out.set(c.id, clampAmount((out.get(c.id) ?? 0) + n));
  }
  return RESOURCE_IDS.filter((r) => out.has(r)).map((r) => ({ resource: r, amount: out.get(r)! }));
}

/** Enemy salvage pod contents for a destroyed ship (faction and family flavour applied). */
export function rollKillDrop(rng: Rng, ctx: LootContext, family: FamilyId, faction: FactionId): LootEntry[] {
  const bias: Partial<Record<ResourceId, number>> = { ...FACTION_LOOT_BIAS[faction] };
  for (const [k, w] of Object.entries(FAMILY_LOOT_BIAS[family] ?? {}) as [ResourceId, number][]) bias[k] = (bias[k] ?? 0) + w;
  return rollLoot('enemy', rng, ctx, { extraRolls: KILL_DROPS.extraRolls[family], bias });
}

/** Pods a sector visit can drop. */
export const dropBudget = (difficulty: number): number => KILL_DROPS.budgetBase + Math.max(1, Math.min(5, Math.floor(difficulty)));

/** Mission reward (deterministic from the mission's own Rng). Ready for the mission system; unused by flight yet. */
export function missionReward(rng: Rng, ctx: LootContext): LootEntry[] {
  return rollLoot('mission', rng, ctx);
}
