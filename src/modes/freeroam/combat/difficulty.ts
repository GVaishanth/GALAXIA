/**
 * Regional difficulty and combat limits (Free Roam Prompt 9). Pure config.
 *
 * The sector's catalogue difficulty (1-5) selects a row of COMBAT_DIFFICULTY;
 * the patrol / installation tier and the encounter kind select which enemy
 * families appear (compositionFor). Every limit that keeps combat bounded
 * lives in COMBAT: entity caps, projectile lifetimes, the arrival grace.
 */
import { createRng } from '../../../core/rng.ts';
import type { FactionId } from '../catalogue/types.ts';
import { FACTIONS } from './factions.ts';
import { FAMILIES, type FamilyId } from './families.ts';

export const COMBAT = Object.freeze({
  /** Active enemy ships (all sources together); spawns beyond it are refused, never queued forever. */
  maxAgents: 24,
  /** Warp-ins waiting to materialise. */
  maxPending: 12,
  /** Enemy projectiles alive at once (new shots are refused at the cap). */
  maxShots: 80,
  /** Mines alive at once (field mines + dropped mines). */
  maxMines: 32,
  /** Hard life caps (ticks): bolts / shells / missiles, and mines. */
  maxShotLife: 300,
  maxMineLife: 1200,
  /** Warp-in telegraph: a marker shows this long before the ship appears. */
  warpTicks: 54,
  /** Ships fire no earlier than this after they appear. */
  spawnFireDelay: 40,
  /** NPC-on-NPC fire does this share of its damage (infighting is real but capped). */
  npcDamageMul: 0.5,
  /** At most this many ships fight other factions at once; the rest keep to the pilot or their posts. */
  maxInfighters: 6,
  infightRange: 520,
  /** Pilot: invulnerability after a hull hit from fire (shield hits give none), after ramming and after a recall. */
  hitInvulnTicks: 20,
  contactInvulnTicks: 60,
  recallInvulnTicks: 120,
  /** A ship this close that targets the pilot (or any live encounter) counts as combat: no docking, no ship switch. */
  combatRadius: 1000,
  /** Patrols / sites wake within these distances and sleep beyond the larger one. */
  wakeRadius: 1400,
  sleepRadius: 1900,
  /** A pursuing patrol ship gives up this far from its post. */
  leash: 1100,
  /** Leaving a live encounter beyond this distance breaks it off (no reward; it resets). */
  encounterLeash: 1300,
  /** Recon: ticks of continuous sight before it calls allies, and the call radius. */
  reconCallTicks: 90,
  reconCallRadius: 1400,
  /** Investigate: ticks spent searching a last-seen point before giving up. */
  searchTicks: 150,
  /** Ambush: telegraph before the wave arrives, and its ring radius around the pilot. */
  ambushWarnTicks: 75,
  ambushRing: 260, // warp-ins land inside the engaged (framed) view, so their rings are seen
  /** Wreck defence: wreck integrity, strip rate per hauler per second in reach. */
  wreckIntegrity: 100,
  stripRate: 9,
  stripReach: 70,
  /** Defence waves arrive every this many ticks while the hold timer runs. */
  defenceWaveGap: 480,
  /** Disputes: Gleaners warn at this distance from their claim and turn hostile if salvage is taken there. */
  claimWarn: 420,
  /** Eruption fields: telegraph length and blast radius / damage. */
  eruptWarn: 66,
  eruptRadius: 80,
  eruptDamage: 18,
  /** Mines: a mine this close to the arrival zone edge is never armed (sanctuary margin). */
  sanctuaryMargin: 120,
  /** Player defeat: share of each common cargo stack left in the wreck. */
  wreckShare: 0.5,
  /** Fly-through radius of the dropped cargo wreck. */
  wreckPickup: 44,
});

export interface DifficultyRow {
  /** Enemy damage multiplier. */
  readonly damage: number;
  /** Fraction of target velocity enemies lead their shots by (0 = aim at the current position). */
  readonly lead: number;
  /** Seeded aim error (radians, +-). */
  readonly jitter: number;
  /** Ticks between noticing a target and the first shot. */
  readonly reaction: number;
  /** Multiplier on weapon cooldowns (higher = slower fire). */
  readonly cooldown: number;
  /** Active ships this sector may hold at once (<= COMBAT.maxAgents). */
  readonly maxActive: number;
  /** After arriving (or a recall) no enemy fires and no ambush triggers for this long. */
  readonly grace: number;
  /** Families that may appear at this difficulty (elite / capital also need their site). */
  readonly families: readonly FamilyId[];
}

export const COMBAT_DIFFICULTY: Readonly<Record<1 | 2 | 3 | 4 | 5, DifficultyRow>> = Object.freeze({
  1: { damage: 0.6, lead: 0, jitter: 0.12, reaction: 60, cooldown: 1.4, maxActive: 8, grace: 240, families: ['raider', 'picket', 'recon', 'hauler'] },
  2: { damage: 0.75, lead: 0.3, jitter: 0.09, reaction: 50, cooldown: 1.25, maxActive: 12, grace: 210, families: ['raider', 'picket', 'recon', 'hauler', 'lancer'] },
  3: { damage: 0.9, lead: 0.5, jitter: 0.07, reaction: 40, cooldown: 1.1, maxActive: 16, grace: 180, families: ['raider', 'picket', 'recon', 'hauler', 'lancer', 'heavy', 'elite'] },
  4: { damage: 1, lead: 0.7, jitter: 0.05, reaction: 32, cooldown: 1, maxActive: 20, grace: 180, families: ['raider', 'picket', 'recon', 'hauler', 'lancer', 'heavy', 'elite', 'capital'] },
  5: { damage: 1.15, lead: 0.85, jitter: 0.04, reaction: 26, cooldown: 0.9, maxActive: 24, grace: 180, families: ['raider', 'picket', 'recon', 'hauler', 'lancer', 'heavy', 'elite', 'capital'] },
});

export const difficultyRow = (d: number): DifficultyRow => COMBAT_DIFFICULTY[Math.min(5, Math.max(1, Math.round(d))) as 1 | 2 | 3 | 4 | 5];

/** Group templates by context; each entry lists families in order of preference. */
const TEMPLATES: Readonly<Record<'patrol' | 'outpost' | 'ambush' | 'defence' | 'dispute' | 'escort', Readonly<Record<1 | 2 | 3, readonly FamilyId[]>>>> = Object.freeze({
  patrol: { 1: ['picket', 'raider', 'raider', 'recon'], 2: ['picket', 'lancer', 'recon', 'raider'], 3: ['heavy', 'picket', 'lancer', 'recon'] },
  outpost: { 1: ['raider', 'raider', 'picket', 'picket'], 2: ['picket', 'lancer', 'raider', 'heavy'], 3: ['heavy', 'lancer', 'picket', 'heavy'] },
  ambush: { 1: ['raider', 'raider', 'raider', 'picket'], 2: ['lancer', 'raider', 'raider', 'lancer'], 3: ['lancer', 'heavy', 'lancer', 'raider'] },
  defence: { 1: ['hauler', 'raider', 'raider', 'hauler'], 2: ['hauler', 'raider', 'lancer', 'hauler'], 3: ['hauler', 'heavy', 'lancer', 'hauler'] },
  dispute: { 1: ['hauler', 'raider', 'raider', 'picket'], 2: ['hauler', 'picket', 'raider', 'lancer'], 3: ['hauler', 'heavy', 'picket', 'lancer'] },
  escort: { 1: ['picket', 'picket'], 2: ['lancer', 'picket'], 3: ['lancer', 'heavy'] },
});

/** Replace a family the region or faction does not allow by the nearest allowed light role. */
function allowed(f: FamilyId, faction: FactionId, row: DifficultyRow): FamilyId {
  const ok = (x: FamilyId): boolean => row.families.includes(x) && FACTIONS[faction].fields.includes(x);
  if (ok(f)) return f;
  for (const alt of f === 'heavy' ? (['picket', 'raider'] as const) : f === 'lancer' ? (['raider', 'picket'] as const) : (['picket', 'raider'] as const)) if (ok(alt)) return alt;
  return 'raider';
}

/**
 * The families of one group, deterministic from its id: the same patrol in
 * the same sector always fields the same ships. Never elite or capital (those
 * come only from their encounter sites), never more than `size`.
 */
export function compositionFor(context: keyof typeof TEMPLATES, tier: 1 | 2 | 3, size: number, faction: FactionId, difficulty: number, key: string): FamilyId[] {
  const row = difficultyRow(difficulty);
  const t = TEMPLATES[context][tier];
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  const rng = createRng(h >>> 0);
  const start = rng.int(0, Math.max(0, t.length - 1));
  const out: FamilyId[] = [];
  for (let i = 0; i < Math.max(0, Math.min(size, 6)); i++) {
    // the first ship is the template's lead; the rest rotate from a seeded start
    const f = i === 0 ? t[0]! : t[(start + i) % t.length]!;
    out.push(allowed(f, faction, row));
  }
  return out;
}

/** A group's total threat weight (used by tests to check regional scaling). */
export const groupThreat = (families: readonly FamilyId[]): number => families.reduce((n, f) => n + FAMILIES[f].threat, 0);
