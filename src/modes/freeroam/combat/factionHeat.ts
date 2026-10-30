/**
 * P09.1 Faction Heat: how much attention the pilot's own hostile acts have
 * drawn from one faction. One bounded integer per faction (0..100), kept apart
 * from marks, kills, Silent Running and mission progress.
 *
 * Attribution (only events the simulation can attribute exactly, all from
 * combat/world.ts damageAgent, the one place a player hit lands):
 *  - a player hit on a ship of a faction that fields ships: +hit, at most once
 *    per ship per hitGap ticks (rapid fire and beams cannot escalate it);
 *  - that ship destroyed by the player: +kill, once (destruction is terminal).
 * NPC fire, hazards, missed or refused shots and the Haven Guild (no ships)
 * never change it. Installations are not damageable entities (their garrison
 * ships are), so no installation event exists. Mission consequences are
 * authored on the mission (MissionDef.heat) and applied once, at turn-in.
 *
 * Decay: one point per decayTicks of simulated flight in which no ship of that
 * faction holds the pilot as its target (contact, including contact memory,
 * restarts the count). Paused, docked or on a map nothing steps, so nothing
 * decays. Integer values only, so a save holds exactly what the game used.
 *
 * Consequences (two, bounded, only for that faction's ships; tier = value band):
 *  - they acquire the pilot at rangeMul[tier] x their detect range (still
 *    scaled by Silent Running's signature and still blocked by Gravity Shadow:
 *    combat/ai.ts applies it before both, so a planet still hides the pilot);
 *  - they hold a lost contact memory[tier] ticks longer, flying to the frozen
 *    last-seen position (never to the pilot's live position).
 * Allegiances never change (a wary faction is still provoked only by a shot or
 * a contested claim); no spawn, stat, damage, loot or price changes anywhere.
 */
import type { FactionId } from '../catalogue/types.ts';
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { FACTIONS } from './factions.ts';
import type { Agent } from './state.ts';

export const HEAT = Object.freeze({
  max: 100,
  hit: 3,
  kill: 10,
  /** Ticks between two hit increments from one ship (60 = 1 s). */
  hitGap: 60,
  /** Calm simulated ticks per point of decay (720 = 12 s). */
  decayTicks: 720,
  /** Tier lower bounds: Quiet 0, Wary 20, Alert 40, Pursuit 60, Hunt 80. */
  tiers: [20, 40, 60, 80] as readonly number[],
  rangeMul: [1, 1.05, 1.1, 1.15, 1.2] as readonly number[],
  memory: [0, 0, 30, 45, 60] as readonly number[],
});

export const HEAT_TIER_NAMES = ['Quiet', 'Wary', 'Alert', 'Pursuit', 'Hunt'] as const;

/** Factions that field ships (the only ones a player act can be attributed to). */
export const HEAT_FACTIONS: readonly FactionId[] = ['tessellate', 'red-tally', 'cordon', 'gleaners'];

/** The live heat of one save: values (persisted) and per-faction calm counters (transient). One object per slot. */
export interface HeatBook {
  readonly v: Partial<Record<FactionId, number>>;
  readonly calm: Partial<Record<FactionId, number>>;
}

const known = (f: unknown): f is FactionId => HEAT_FACTIONS.includes(f as FactionId);

/** A book from stored values (profile.ts already checked the shape: integers 0..100): unknown factions are dropped. */
export const heatBook = (saved: Readonly<Record<string, number>> = {}): HeatBook => ({ v: Object.fromEntries(HEAT_FACTIONS.filter((f) => saved[f]! > 0).map((f) => [f, Math.min(HEAT.max, saved[f]!)])), calm: {} });

/** The stored form (non-zero values only; undefined when every faction is quiet). */
export function heatToSaved(b: HeatBook): Record<string, number> | undefined {
  const out = Object.fromEntries(Object.entries(b.v).filter(([, n]) => n! > 0));
  return Object.keys(out).length ? out : undefined;
}

export const heatOf = (b: HeatBook | undefined, f: string): number => (b && known(f) ? (b.v[f] ?? 0) : 0);

/** Tier 0..4 of a value. */
export const heatTier = (n: number): number => HEAT.tiers.filter((t) => n >= t).length;

/**
 * Change one faction's heat by a whole number of points, clamped to 0..max.
 * Unknown factions and non-finite deltas change nothing. A tier crossing
 * reports one event (only when an event list is given).
 */
export function addHeat(b: HeatBook, f: string, delta: number, events?: SectorEvent[]): number {
  if (!known(f) || !Number.isFinite(delta)) return 0;
  const was = b.v[f] ?? 0;
  const now = Math.min(HEAT.max, Math.max(0, was + Math.trunc(delta)));
  b.v[f] = now;
  const from = heatTier(was);
  const tier = heatTier(now);
  if (events && tier !== from) events.push({ type: 'heat', faction: f, tier, from });
  return now - was;
}

/** A player hit landed on this ship (damageAgent): the hit increment, rate-limited per ship. */
export function heatHit(run: SectorRun, a: Agent, destroyed: boolean, events: SectorEvent[]): void {
  if ((a.heatAt ?? -Infinity) + HEAT.hitGap <= run.tick) {
    a.heatAt = run.tick;
    addHeat(run.factionHeat, a.faction, HEAT.hit, events);
  }
  if (destroyed) addHeat(run.factionHeat, a.faction, HEAT.kill, events);
}

/** Read-only snapshot row for presentation (P09.2): never changes the book. */
export interface HeatView {
  readonly faction: FactionId;
  readonly label: string;
  readonly value: number;
  readonly tier: number;
  readonly tierName: (typeof HEAT_TIER_NAMES)[number];
  /** P09.2: what the tier does to that faction's ships (heatEffect). */
  readonly effect: string;
}

/** P09.2: a tier's two effects in player words, from rangeMul and memory (never a second copy of the numbers). */
export function heatEffect(tier: number): string {
  const r = Math.round((HEAT.rangeMul[tier]! - 1) * 100);
  const m = HEAT.memory[tier]! / 60;
  return r ? `its ships spot you ${r}% farther${m ? `, search your last position ${m} s longer` : ''}` : 'no extra attention';
}

export const heatView = (b: HeatBook | undefined): HeatView[] =>
  HEAT_FACTIONS.map((faction) => {
    const value = heatOf(b, faction);
    const tier = heatTier(value);
    return { faction, label: FACTIONS[faction].short, value, tier, tierName: HEAT_TIER_NAMES[tier]!, effect: heatEffect(tier) };
  });

/** P09.2: the FACTION STANDING help line (values from HEAT). */
export const HEAT_HELP = `Heat (0-100) is per faction. Hits on its ships raise it, some chain stages change it, and it cools 1 point per ${HEAT.decayTicks / 60} s in flight while none of its ships hunts you. Silent Running and planets still hide you. It is not a difficulty level.`;

/** One flight tick of decay (stepSector, after the AI chose its targets). */
export function stepHeat(run: SectorRun, events: SectorEvent[]): void {
  const b = run.factionHeat;
  for (const f of HEAT_FACTIONS) {
    if (!b.v[f] || run.hostiles.some((a) => a.faction === f && a.target === 'player' && a.state !== 'destroyed')) {
      b.calm[f] = 0;
      continue;
    }
    b.calm[f] = (b.calm[f] ?? 0) + 1;
    if (b.calm[f]! >= HEAT.decayTicks) {
      b.calm[f] = 0;
      addHeat(b, f, -1, events);
    }
  }
}
