/**
 * Free Roam factions (Free Roam Prompt 9): identities, visual rules and the
 * relationship matrix. Pure data; docs/freeroam/FACTIONS.md is the readable
 * version (lore, markings, visual rules) and must match this file.
 *
 * All names, lore and markings are original to GALAXIA. Factions are told
 * apart by four independent cues, never by colour alone:
 *   1. hull palette    (sprite palette variant)
 *   2. emblem shape    (map contacts, edge markers, the target bar)
 *   3. engine trail    (sputter / streak / twin jets / motes)
 *   4. ship roster     (which families a faction fields and what it calls them)
 */
import type { VariantId } from '../../../assets/sprites/variants.ts';
import type { ColorRole } from '../../../config/palette.ts';
import type { FactionId } from '../catalogue/types.ts';
import type { FamilyId } from './families.ts';

/** A combatant side: a faction, or the pilot. */
export type Side = FactionId | 'player';

/**
 * hostile  attacks on sight
 * wary     ignores the other side until provoked (the Gleaners toward the pilot)
 * neutral  never attacks
 */
export type Stance = 'hostile' | 'wary' | 'neutral';

export type Emblem = 'triangle' | 'cross' | 'chevron' | 'diamond' | 'ring';
export type TrailStyle = 'motes' | 'streak' | 'twin' | 'sputter' | 'none';

export interface FactionDef {
  readonly id: FactionId;
  readonly name: string;
  /** Short form for tight UI (edge labels, the target bar). */
  readonly short: string;
  /** The role the prompt asked for. */
  readonly role: string;
  readonly lore: string;
  readonly markings: string;
  /** Palette variant of the enemy sprites (null = the sprites' base palette). */
  readonly variant: VariantId | null;
  /** Variant for a badly damaged hull of this faction. */
  readonly worn: VariantId;
  readonly emblem: Emblem;
  readonly trail: TrailStyle;
  /** UI colour role (emblems, contacts). */
  readonly color: ColorRole;
  /** Families this faction fields; everything else is replaced by its nearest fielded role. */
  readonly fields: readonly FamilyId[];
  /** What the faction calls each family (original names, no numbers). */
  readonly names: Readonly<Partial<Record<FamilyId, string>>>;
}

export const FACTIONS: Readonly<Record<FactionId, FactionDef>> = Object.freeze({
  tessellate: {
    id: 'tessellate',
    name: 'The Tessellate',
    short: 'Tessellate',
    role: 'Autonomous machine fleet',
    lore: 'Survey engines launched to map the lanes kept building copies of themselves long after their makers stopped answering. They now tile every sector they reach with relays and foundries, and treat any ship that is not part of the pattern as raw material.',
    markings: 'Acid-green triangle lattices on violet plating; no cockpits, only sensor facets. Engines leave square motes instead of flame.',
    variant: 'tessellate',
    worn: 'tessellateWorn',
    emblem: 'triangle',
    trail: 'motes',
    color: 'tess.mark',
    fields: ['raider', 'picket', 'lancer', 'heavy', 'recon', 'hauler', 'elite', 'capital'],
    names: { raider: 'Mote', picket: 'Tessera', lancer: 'Shard', heavy: 'Monolith', recon: 'Facet Eye', hauler: 'Harvester', elite: 'Prime Facet', capital: 'Foundry Mother' },
  },
  'red-tally': {
    id: 'red-tally',
    name: 'The Red Tally',
    short: 'Red Tally',
    role: 'Organised raiders',
    lore: 'A raiding company that runs like a counting-house: every crew owes a share, every haul is written in the red ledger, and every ship they take is cut as a notch into their hulls. They raid scavengers and convoys alike and pay the Cordon in blood, not tolls.',
    markings: 'Graphite hulls scored with crimson tally notches; a crossed-out square brand on the wings. Long red engine streaks.',
    variant: null,
    worn: 'tallyWorn',
    emblem: 'cross',
    trail: 'streak',
    color: 'tally.mark',
    fields: ['raider', 'picket', 'lancer', 'heavy', 'recon', 'hauler', 'elite', 'capital'],
    names: { raider: 'Cutter', picket: 'Picket', lancer: 'Gaff', heavy: 'Brute', recon: 'Spotter', hauler: 'Grabber', elite: 'Tallymaster', capital: 'Ledger Barge' },
  },
  cordon: {
    id: 'cordon',
    name: 'The Cordon',
    short: 'Cordon',
    role: 'Hostile security force',
    lore: 'The armed wardens of an interdiction order nobody remembers voting for. The Cordon seals sectors it declares restricted, impounds unlicensed ships and fires on anything that will not stop. Raiders and machines are its old enemies; scavengers it tolerates.',
    markings: 'Steel-blue and white plating with amber beacon lights and paired chevron stripes. Twin steady blue engine jets.',
    variant: 'cordon',
    worn: 'cordonWorn',
    emblem: 'chevron',
    trail: 'twin',
    color: 'cordon.eye',
    fields: ['raider', 'picket', 'lancer', 'heavy', 'recon', 'hauler', 'elite', 'capital'],
    names: { raider: 'Pursuer', picket: 'Sentry', lancer: 'Interdictor', heavy: 'Rampart', recon: 'Watcher', hauler: 'Impounder', elite: 'Marshal', capital: 'Citadel' },
  },
  gleaners: {
    id: 'gleaners',
    name: 'The Gleaners',
    short: 'Gleaners',
    role: 'Independent scavengers',
    lore: 'Families of salvage crews who live off what battles leave behind. They stake claims on wreck fields and defend them fiercely, but a pilot who leaves their claim alone is left alone. The Red Tally preys on them; the machines strip their camps.',
    markings: 'Patched khaki hulls with orange hazard diamonds and mismatched panels. Engines sputter and smoke.',
    variant: 'gleaners',
    worn: 'gleanersWorn',
    emblem: 'diamond',
    trail: 'sputter',
    color: 'gleaner.mark',
    fields: ['raider', 'picket', 'lancer', 'heavy', 'recon', 'hauler', 'elite'],
    names: { raider: 'Skiff', picket: 'Claim Guard', lancer: 'Darter', heavy: 'Hulk', recon: 'Lookout', hauler: 'Scow', elite: 'Old Salt' },
  },
  'haven-guild': {
    id: 'haven-guild',
    name: 'Haven Guild',
    short: 'Guild',
    role: 'Station owners (no warships)',
    lore: 'The guild that keeps the stations lit and the hangars open. It fields no warships and asks only that pilots keep their fights outside the docking rings.',
    markings: 'Ivory and teal station art.',
    variant: null,
    worn: 'tallyWorn',
    emblem: 'ring',
    trail: 'none',
    color: 'player.trim',
    fields: [],
    names: {},
  },
});

/**
 * Relationship matrix: RELATIONS[a][b] is how `a` treats `b`. Symmetric by
 * design (tested). The Gleaners are wary of the pilot: neutral until the pilot
 * shoots one or takes salvage from a field they claim (SectorRun.provoked).
 */
const H: Stance = 'hostile';
const W: Stance = 'wary';
const N: Stance = 'neutral';
export const RELATIONS: Readonly<Record<Side, Readonly<Record<Side, Stance>>>> = Object.freeze({
  player: { player: N, tessellate: H, 'red-tally': H, cordon: H, gleaners: W, 'haven-guild': N },
  tessellate: { player: H, tessellate: N, 'red-tally': H, cordon: H, gleaners: H, 'haven-guild': N },
  'red-tally': { player: H, tessellate: H, 'red-tally': N, cordon: H, gleaners: H, 'haven-guild': N },
  cordon: { player: H, tessellate: H, 'red-tally': H, cordon: N, gleaners: N, 'haven-guild': N },
  gleaners: { player: W, tessellate: H, 'red-tally': H, cordon: N, gleaners: N, 'haven-guild': N },
  'haven-guild': { player: N, tessellate: N, 'red-tally': N, cordon: N, gleaners: N, 'haven-guild': N },
});

/** How `a` treats `b` right now: wary turns hostile once the wary faction has been provoked by the pilot. */
export function stance(a: Side, b: Side, provoked: ReadonlySet<FactionId>): Stance {
  const s = RELATIONS[a][b];
  if (s !== 'wary') return s;
  const wary = a === 'player' ? b : a;
  return wary !== 'player' && provoked.has(wary) ? 'hostile' : 'wary';
}

export const isHostile = (a: Side, b: Side, provoked: ReadonlySet<FactionId>): boolean => stance(a, b, provoked) === 'hostile';

/** Display name of one ship, e.g. "Red Tally Cutter". */
export function shipName(faction: FactionId, family: FamilyId, familyLabel: string): string {
  return `${FACTIONS[faction].short} ${FACTIONS[faction].names[family] ?? familyLabel}`;
}
