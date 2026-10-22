/**
 * Mission panel view model (Free Roam Prompt 11). Pure: turns mission state,
 * definitions and the world into display rows, so the panel stays DOM only
 * and never decides anything.
 */
import { resourceName } from '../inventory/resources.ts';
import type { Board } from './contracts.ts';
import { deliveryNeed, galaxyOf, missionDef, missionStatus, readyMissions, targetLocal, targetSystem, type MissionWorld, type PrereqContext } from './missions.ts';
import { MISSION_TYPE_LABEL, TARGET_DONE, type MissionDef, type MissionState } from './missionTypes.ts';
import { rewardLines } from './station.ts';

export interface ObjectiveRow {
  readonly label: string;
  readonly value: number;
  readonly count: number;
  /** Where (resolved target), '' = anywhere in scope. */
  readonly where: string;
}

export interface MissionRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly source: 'story' | 'contract';
  readonly description: string;
  readonly objectives: readonly ObjectiveRow[];
  readonly rewards: readonly string[];
  /** Jumps left before it fails (null = no deadline). */
  readonly jumpsLeft: number | null;
  /** Delivery handed over here (docked at the target station) and how much the hold has. */
  readonly delivery: { readonly resource: string; readonly left: number; readonly have: number; readonly here: boolean } | null;
}

const LOCAL_LABEL: Readonly<Record<string, string>> = { derelict: 'derelict', anomaly: 'anomaly', salvage: 'salvage', installation: 'outpost', defence: 'wreck under attack', cache: 'cache' };

/** "Alpha Centauri · derelict" from a resolved target. */
export function whereText(target: string, world: Pick<MissionWorld, 'name'>, scope: string): string {
  if (target === TARGET_DONE) return 'nothing left to find: counts as done';
  const sys = targetSystem(target);
  if (!sys) return scope ? `anywhere in ${scope}` : 'anywhere';
  const local = targetLocal(target);
  const kind = local.split('-')[0] ?? '';
  return local ? `${world.name(sys)} · ${LOCAL_LABEL[kind] ?? kind}` : world.name(sys);
}

export function offerRow(def: MissionDef, world: Pick<MissionWorld, 'name'>, galaxyName: (id: string) => string, targets?: readonly string[]): MissionRow {
  const scope = def.galaxy ? galaxyName(def.galaxy) : '';
  return {
    id: def.id,
    title: def.title,
    type: MISSION_TYPE_LABEL[def.type],
    source: def.source,
    description: def.description,
    objectives: def.objectives.map((o, i) => {
      const t = targets?.[i] ?? (o.target === 'nearest' ? '' : o.target === 'any' ? '' : o.target);
      return { label: o.label, value: 0, count: o.count, where: o.target === 'nearest' && !targets ? 'marked when you accept' : o.kind === 'reach-galaxy' ? galaxyName(o.galaxy ?? '') : whereText(t, world, scope) };
    }),
    rewards: rewardLines(def.rewards),
    jumpsLeft: def.failure.deadlineJumps ?? null,
    delivery: null,
  };
}

export function activeRow(state: MissionState, id: string, world: Pick<MissionWorld, 'name'>, galaxyName: (id: string) => string, hold: Readonly<Record<string, number>>, dockedAt: string | null): MissionRow | null {
  const m = state.active.find((x) => x.id === id);
  const def = missionDef(state, id);
  if (!m || !def) return null;
  const base = offerRow(def, world, galaxyName, m.targets);
  const need = deliveryNeed(state, id);
  return {
    ...base,
    objectives: base.objectives.map((o, i) => ({ ...o, value: Math.min(o.count, m.progress[i] ?? 0) })),
    jumpsLeft: def.failure.deadlineJumps ? Math.max(0, def.failure.deadlineJumps - (state.jumps - m.at)) : null,
    delivery: need && need.left > 0 ? { resource: resourceName(need.resource), left: need.left, have: hold[need.resource] ?? 0, here: dockedAt !== null && dockedAt === need.station } : null,
  };
}

export interface MissionsModel {
  readonly ready: readonly MissionRow[];
  readonly active: readonly MissionRow[];
  readonly dispatch: readonly MissionRow[];
  readonly board: readonly MissionRow[];
  readonly boardNote: string;
  readonly completed: readonly string[];
  /** Systems with an active target -> mission titles (system map markers). */
  readonly targets: ReadonlyMap<string, readonly string[]>;
}

export function missionsModel(
  state: MissionState,
  ctx: PrereqContext,
  world: Pick<MissionWorld, 'name'>,
  galaxyName: (id: string) => string,
  hold: Readonly<Record<string, number>>,
  dockedAt: string | null,
  story: readonly MissionDef[],
  board: Board | null,
): MissionsModel {
  const ready = readyMissions(state)
    .map((id) => missionDef(state, id))
    .filter((d): d is MissionDef => !!d)
    .map((d) => offerRow(d, world, galaxyName));
  const active = state.active.map((m) => activeRow(state, m.id, world, galaxyName, hold, dockedAt)).filter((r): r is MissionRow => !!r);
  const dispatch = dockedAt ? story.filter((d) => missionStatus(state, d, ctx) === 'available').map((d) => offerRow(d, world, galaxyName)) : [];
  const offers = board ? board.offers.map((o) => offerRow(o.def, world, galaxyName, [o.spec.target])) : [];
  const boardNote = !dockedAt ? '' : !board || board.offers.length === 0 ? 'No contracts posted here any more. Other stations still have work.' : `${board.offers.length} open · ${board.remaining} more later at this station`;
  const completed = state.claimed.map((id) => missionDef(state, id)?.title ?? (id.startsWith('c:') ? 'Contract' : id));
  return { ready, active, dispatch, board: offers, boardNote, completed, targets: missionTargets(state) };
}

/** Systems with an active mission target (for the system map). */
export function missionTargets(state: MissionState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of state.active) {
    const def = missionDef(state, m.id);
    if (!def) continue;
    m.targets.forEach((t, i) => {
      if ((m.progress[i] ?? 0) >= (def.objectives[i]?.count ?? 0)) return;
      const sys = targetSystem(t);
      if (!sys) return;
      const list = out.get(sys) ?? [];
      if (!list.includes(def.title)) list.push(def.title);
      out.set(sys, list);
    });
  }
  return out;
}

export { galaxyOf };

/**
 * The objective the HUD tracks: the first unfinished objective targeting the
 * pilot's system, otherwise the first unfinished objective of the oldest
 * active mission (null = no active mission).
 */
export function trackedObjective(state: MissionState, here: string, world: Pick<MissionWorld, 'name'>, galaxyName: (id: string) => string): { readonly id: string; readonly text: string; readonly here: boolean } | null {
  let fallback: { id: string; text: string; here: boolean } | null = null;
  for (const m of state.active) {
    const row = activeRow(state, m.id, world, galaxyName, {}, null);
    if (!row) continue;
    for (let i = 0; i < row.objectives.length; i++) {
      const o = row.objectives[i]!;
      if (o.value >= o.count) continue;
      const atHere = targetSystem(m.targets[i] ?? '') === here;
      const text = `${row.title.toUpperCase()} · ${o.label} ${o.value}/${o.count}${o.where && !atHere ? ` · ${o.where}` : ''}`;
      if (atHere) return { id: m.id, text, here: true };
      fallback ??= { id: m.id, text, here: false };
      break;
    }
  }
  return fallback;
}
