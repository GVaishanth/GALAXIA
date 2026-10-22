/**
 * Exploration record (Free Roam Prompt 11).
 *
 * Counts what the pilot has done (systems visited, galaxies reached,
 * anomalies investigated, wrecks explored, resources acquired, factions
 * encountered, routes unlocked, missions completed, unique discoveries) and
 * keeps a discovery log with two clearly separated kinds of entry:
 *
 *  - ASTRONOMY: real, cited information from the catalogue. Recorded when the
 *    pilot reaches a galaxy (its cited facts) or a system whose provenance is
 *    `verified-object` (its `fact` line and sources). Never invented here.
 *  - GALAXIA FICTION: in-game finds (investigated anomalies). Their names and
 *    texts are generated from an original table, and the UI labels them as
 *    fiction, never as science.
 *
 * Consumes GameEvents only. Pure.
 */
import type { NavGraph } from '../galaxy/graph.ts';
import { hashId } from './contracts.ts';
import type { GameEvent } from './events.ts';

export interface ExplorationLog {
  /** `system#poi` of investigated anomalies (each also a fictional find). */
  readonly anomalies: readonly string[];
  /** `system#poi` of inspected derelicts. */
  readonly wrecks: readonly string[];
  readonly factions: readonly string[];
  /** Verified records seen: galaxy ids and verified-object system ids. */
  readonly facts: readonly string[];
  readonly kills: number;
  /** Resource units acquired from the world, per resource. */
  readonly acquired: Readonly<Record<string, number>>;
}

export const EMPTY_LOG: ExplorationLog = Object.freeze({ anomalies: Object.freeze([]), wrecks: Object.freeze([]), factions: Object.freeze([]), facts: Object.freeze([]), kills: 0, acquired: Object.freeze({}) });

export const LOG_LIMIT = 512;
const add = (xs: readonly string[], x: string): readonly string[] => (xs.includes(x) || xs.length >= LOG_LIMIT ? xs : [...xs, x]);

/** Is this system a verified real object (its fact may go into the ASTRONOMY log)? */
export const verifiedSystem = (graph: NavGraph, id: string): boolean => {
  const s = graph.system(id);
  return !!s && s.provenance.status === 'verified-object' && !!s.fact;
};

/** Fold one event into the record. Returns the same object when nothing changed. */
export function recordEvent(log: ExplorationLog, e: GameEvent, graph: NavGraph): ExplorationLog {
  switch (e.type) {
    case 'system-visited': {
      if (!verifiedSystem(graph, e.systemId)) return log;
      const facts = add(log.facts, e.systemId);
      return facts === log.facts ? log : { ...log, facts };
    }
    case 'galaxy-reached': {
      if (!graph.node(e.galaxyId)) return log;
      const facts = add(log.facts, e.galaxyId);
      return facts === log.facts ? log : { ...log, facts };
    }
    case 'poi-completed': {
      const key = `${e.systemId}#${e.poiId}`;
      if (e.kind === 'anomaly') {
        const anomalies = add(log.anomalies, key);
        return anomalies === log.anomalies ? log : { ...log, anomalies };
      }
      if (e.kind === 'derelict') {
        const wrecks = add(log.wrecks, key);
        return wrecks === log.wrecks ? log : { ...log, wrecks };
      }
      return log;
    }
    case 'faction-encountered': {
      const factions = add(log.factions, e.faction);
      return factions === log.factions ? log : { ...log, factions };
    }
    case 'hostile-destroyed':
      return { ...log, kills: Math.min(1_000_000_000, log.kills + 1) };
    case 'resource-acquired':
      if (!(e.amount > 0)) return log;
      return { ...log, acquired: { ...log.acquired, [e.resource]: Math.min(999_999_999, (log.acquired[e.resource] ?? 0) + Math.floor(e.amount)) } };
    default:
      return log;
  }
}

/* ------------------------------------------------------------------- stats */

export interface StatsContext {
  readonly visitedSystems: number;
  readonly visitedGalaxies: number;
  readonly routesOpen: number;
  readonly missionsCompleted: number;
  readonly charted: number;
}

export interface StatRow {
  readonly id: string;
  readonly label: string;
  readonly value: number;
}

export function explorationStats(log: ExplorationLog, ctx: StatsContext): StatRow[] {
  const resources = Object.values(log.acquired).reduce((a, b) => a + b, 0);
  return [
    { id: 'systems', label: 'Systems visited', value: ctx.visitedSystems },
    { id: 'charted', label: 'Systems charted', value: ctx.charted },
    { id: 'galaxies', label: 'Galaxies reached', value: ctx.visitedGalaxies },
    { id: 'anomalies', label: 'Anomalies investigated', value: log.anomalies.length },
    { id: 'wrecks', label: 'Wrecks explored', value: log.wrecks.length },
    { id: 'resources', label: 'Resources acquired', value: resources },
    { id: 'factions', label: 'Factions encountered', value: log.factions.length },
    { id: 'routes', label: 'Galaxy routes unlocked', value: ctx.routesOpen },
    { id: 'missions', label: 'Missions completed', value: ctx.missionsCompleted },
    { id: 'discoveries', label: 'Unique discoveries', value: log.facts.length + log.anomalies.length },
  ];
}

/* --------------------------------------------------------------- discovery log */

export interface DiscoveryEntry {
  readonly id: string;
  /** 'fact' = real astronomy (cited); 'fiction' = GALAXIA invention. */
  readonly kind: 'fact' | 'fiction';
  readonly title: string;
  readonly text: string;
  /** Facts: source titles; fiction: empty. */
  readonly sources: readonly string[];
}

const FIND_ADJ = ['Resonant', 'Folded', 'Hollow', 'Singing', 'Braided', 'Quiet', 'Lensed', 'Drifting', 'Mirrored', 'Banded'] as const;
const FIND_NOUN = ['lattice', 'echo', 'filament', 'shell', 'knot', 'wake', 'veil', 'spindle', 'bloom', 'cradle'] as const;
const FIND_TEXT = [
  'A pocket of space that returns the scanner pulse a fraction late.',
  'Thin threads of charged dust that hold their shape against the solar wind.',
  'A slow ring of interference that repeats every few minutes.',
  'A cold region where the sensor noise drops to nothing.',
  'Faint structured emission no Guild catalogue lists.',
] as const;

/** Original name and text of a fictional find (deterministic per site). */
export function findName(key: string): { readonly title: string; readonly text: string } {
  const h = hashId(`find:${key}`);
  return { title: `${FIND_ADJ[h % FIND_ADJ.length]} ${FIND_NOUN[(h >>> 4) % FIND_NOUN.length]}`, text: FIND_TEXT[(h >>> 9) % FIND_TEXT.length]! };
}

export function discoveryEntries(log: ExplorationLog, graph: NavGraph): DiscoveryEntry[] {
  const src = new Map(graph.catalogue.sources.map((s) => [s.id, s.title]));
  const titles = (ids: readonly string[]): string[] => ids.map((id) => src.get(id)).filter((t): t is string => !!t);
  const out: DiscoveryEntry[] = [];
  for (const id of log.facts) {
    const node = graph.node(id);
    if (node) {
      const f = node.galaxy.facts[0];
      if (f) out.push({ id: `fact:${id}`, kind: 'fact', title: node.galaxy.name, text: f.text, sources: titles(f.sourceIds) });
      continue;
    }
    const s = graph.system(id);
    if (s && s.provenance.status === 'verified-object' && s.fact) out.push({ id: `fact:${id}`, kind: 'fact', title: s.name, text: s.fact, sources: titles(s.provenance.sourceIds) });
  }
  for (const key of log.anomalies) {
    const n = findName(key);
    const sys = graph.system(key.split('#')[0] ?? '');
    out.push({ id: `find:${key}`, kind: 'fiction', title: n.title, text: `${n.text}${sys ? ` Logged in ${sys.name}.` : ''}`, sources: [] });
  }
  return out;
}
