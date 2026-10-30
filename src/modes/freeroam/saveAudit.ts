/**
 * Save audit (Free Roam Prompt 13, FR-TD-74). Pure; Free Roam chunk only.
 *
 * profile.ts (main bundle) checks shapes: types, id patterns, number ranges,
 * duplicates, active vs completed missions. This module checks the loaded slot
 * against the game data of this build and returns a profile the game can run
 * on, plus a count of what had to change, so the mode can keep a raw backup
 * before the cleaned record is saved and tell the player.
 *
 * Rules (one per kind of reference):
 *  - where the pilot is (current galaxy / system): an unknown or unreachable
 *    place falls back to the galaxy's gateway (galaxy/progress.ts);
 *  - facts about places (visited, charted, surveys, sector changes, the cargo
 *    wreck, the resume point): entries for systems / galaxies this build does
 *    not have are removed;
 *  - the fleet: unknown ships and invalid loadouts fall back to the starter /
 *    stock (ships/hangar.ts);
 *  - progression: unknown missions, licences, upgrade tracks and ships are
 *    removed, upgrade levels capped (progression/persistence.ts);
 *  - claimed milestones the game does not define are removed;
 *  - P05.1 crew: unknown or duplicate crew ids are removed; seats on ships
 *    the slot does not own, or beyond a ship's seats, are released and those
 *    crew stay on the roster (crew/persistence.ts). Nobody is ever added;
 *  - cargo and stored modules with unknown (well-formed) ids are KEPT, inert
 *    and shown as unknown (Prompt 10: nothing in the hold vanishes).
 */
import type { NavGraph } from './galaxy/graph.ts';
import { progressFromSaved } from './galaxy/progress.ts';
import { heatBook } from './combat/factionHeat.ts';
import { MILESTONE_BY_ID } from './inventory/milestones.ts';
import { crewFromSaved, crewToSaved } from './crew/persistence.ts';
import { withCrew, withNavigation, type FreeRoamProfile, type SectorRecord } from './profile.ts';
import { progressionFromSaved, progressionToSaved } from './progression/persistence.ts';
import { fleetFromSaved, fleetToSaved } from './ships/hangar.ts';

export type AuditArea = 'navigation' | 'sectors' | 'fleet' | 'missions' | 'upgrades' | 'milestones' | 'wreck' | 'resume' | 'crew';

export interface AuditIssue {
  readonly area: AuditArea;
  /** Entries removed or replaced. */
  readonly count: number;
}

export interface AuditResult {
  readonly profile: FreeRoamProfile;
  readonly issues: readonly AuditIssue[];
  /** Total entries removed or replaced (0 = the slot matched the game data). */
  readonly changed: number;
}

const missing = <T>(before: readonly T[], after: readonly T[]): number => before.filter((x) => !after.includes(x)).length;

export function auditProfile(graph: NavGraph, p: FreeRoamProfile): AuditResult {
  const issues: AuditIssue[] = [];
  const note = (area: AuditArea, count: number): void => {
    if (count > 0) issues.push({ area, count });
  };
  const knownSystem = (id: string): boolean => graph.system(id) !== undefined;

  /* navigation */
  const nav = progressFromSaved(graph, p);
  note(
    'navigation',
    (p.currentGalaxy !== nav.current ? 1 : 0) +
      (p.currentSystem !== '' && p.currentSystem !== nav.system ? 1 : 0) +
      missing(p.visitedGalaxies, nav.visited) +
      missing(p.chartedSystems, nav.charted) +
      missing(p.visitedSystems, nav.visitedSystems) +
      missing(Object.keys(p.galaxySurveys), Object.keys(nav.surveys)),
  );
  let out = withNavigation(p, nav);

  /* sector changes of systems this build does not have */
  const sectors: Record<string, SectorRecord> = {};
  let droppedSectors = 0;
  for (const [id, rec] of Object.entries(p.sectors)) {
    if (knownSystem(id)) sectors[id] = rec;
    else droppedSectors += 1;
  }
  note('sectors', droppedSectors);
  if (droppedSectors) out = { ...out, sectors };

  /* fleet */
  const fleetState = fleetFromSaved(p.fleet);
  const fleet = fleetToSaved(fleetState);
  note('fleet', missing(p.fleet.owned, fleet.owned) + (p.fleet.active !== fleet.active ? 1 : 0) + missing(Object.keys(p.fleet.loadouts), Object.keys(fleet.loadouts)));
  out = { ...out, fleet };

  /* crew (P05.1): checked against the crew roster and the fleet just audited */
  const crew = crewFromSaved(p.crew, fleetState.owned);
  note('crew', crew.changes);
  if (crew.changes > 0) out = withCrew(out, crewToSaved(crew.state));

  /* progression */
  // P09.1: the faction heat goes through the same book the game uses (unknown factions dropped, values kept)
  const prog = progressionToSaved(progressionFromSaved(p.progression), heatBook(p.progression.heat));
  const m0 = p.progression.missions;
  const m1 = prog.missions;
  note(
    'missions',
    missing(
      m0.active.map((a) => a.id),
      m1.active.map((a) => a.id),
    ) +
      missing(m0.completed, m1.completed) +
      missing(m0.failed, m1.failed) +
      missing(Object.keys(m0.ready), Object.keys(m1.ready)),
  );
  note('upgrades', missing(p.progression.licences, prog.licences) + missing(Object.keys(p.progression.upgrades), Object.keys(prog.upgrades)));
  out = { ...out, progression: prog };

  /* milestones */
  const milestones = p.milestones.filter((id) => MILESTONE_BY_ID.has(id));
  note('milestones', p.milestones.length - milestones.length);
  if (milestones.length !== p.milestones.length) out = { ...out, milestones };

  /* the cargo wreck lies in a system this build does not have: it can never be reached */
  if (p.lostCargo && !knownSystem(p.lostCargo.systemId)) {
    note('wreck', 1);
    out = { ...out, lostCargo: null };
  }

  /* the resume point: unknown system = invalid; another system than the current one = stale */
  if (p.resume && (!knownSystem(p.resume.systemId) || p.resume.systemId !== out.currentSystem)) {
    if (!knownSystem(p.resume.systemId)) note('resume', 1);
    out = { ...out, resume: null };
  }

  return { profile: out, issues, changed: issues.reduce((n, i) => n + i.count, 0) };
}

/** One line for the player ("3 saved entries no longer match the game data…"). */
export function auditText(r: AuditResult): string {
  if (r.changed === 0) return '';
  const areas = [...new Set(r.issues.map((i) => i.area))].join(', ');
  return `${r.changed} saved ${r.changed === 1 ? 'entry' : 'entries'} no longer matched the game data (${areas}) and ${r.changed === 1 ? 'was' : 'were'} reset. A backup copy of the slot was kept.`;
}
