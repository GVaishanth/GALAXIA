/**
 * Mission manager (Free Roam Prompt 11). Pure functions over MissionState.
 *
 *  accept  -> checks prerequisites, resolves every objective's target against
 *             the world (missionWorld.ts) and starts tracking it;
 *  consume -> one GameEvent: advances matching objectives, completes
 *             missions whose objectives are all met, fails missions past a
 *             jump deadline or whose defended encounter was lost;
 *  abandon -> fails an active mission (a story mission can be accepted again,
 *             a contract slot stays used);
 *  claim   -> marks a completed mission's reward as paid (rewards.ts applies
 *             it). A mission id is completed and claimed at most once, so a
 *             reward can never be paid twice.
 *
 * No UI code lives here: panels call these functions and the shell publishes
 * the events.
 */
import { contractDef, patrolShips } from './contracts.ts';
import type { GameEvent } from './events.ts';
import { STORY_BY_ID } from './missionData.ts';
import { TARGET_DONE, type ActiveMission, type ContractSpec, type MissionDef, type MissionState, type ObjectiveDef, type Prerequisite } from './missionTypes.ts';

export const MAX_ACTIVE = 6;

/** What missions need to know about the world (missionWorld.ts builds it from the catalogue and the save). */
export interface WorldSite {
  /** Sector-local id (`derelict-2`, `installation-1`, `defence-1`, a patrol id). */
  readonly id: string;
  readonly kind: string;
  readonly done: boolean;
  /** Patrol routes: ships flying it (a destroyed patrol returns when the pilot comes back). */
  readonly ships?: number | undefined;
}

export interface MissionWorld {
  readonly galaxy: string;
  readonly system: string;
  systemsIn(galaxy: string): readonly string[];
  /** Lane hops between two systems of one galaxy (Infinity when not connected). */
  hops(from: string, to: string): number;
  enterable(id: string): boolean;
  visited(id: string): boolean;
  charted(id: string): boolean;
  station(id: string): boolean;
  difficulty(id: string): number;
  /** POIs (by kind), encounter sites (`site:<kind>`) and patrol routes (`patrol`). */
  sites(id: string): readonly WorldSite[];
  name(id: string): string;
}

export interface PrereqContext {
  readonly visitedGalaxies: readonly string[];
  readonly charted: number;
}

export const galaxyOf = (systemId: string): string => systemId.split('/')[0] ?? '';
export const targetSystem = (target: string): string => (target === TARGET_DONE ? '' : (target.split('#')[0] ?? ''));
export const targetLocal = (target: string): string => target.split('#')[1] ?? '';

/* ------------------------------------------------------------- definitions */

/** The definition of a mission id: story missions from the table, contracts from their saved spec. */
export function missionDef(state: MissionState, id: string): MissionDef | undefined {
  const story = STORY_BY_ID.get(id);
  if (story) return story;
  const spec = state.active.find((m) => m.id === id)?.contract ?? state.ready[id];
  return spec ? contractDef(id, spec) : undefined;
}

export function prereqMet(p: Prerequisite, state: MissionState, ctx: PrereqContext): boolean {
  if (p.kind === 'mission') return state.completed.includes(p.id);
  if (p.kind === 'galaxy') return ctx.visitedGalaxies.includes(p.id);
  return ctx.charted >= p.count;
}

export type MissionStatus = 'locked' | 'available' | 'active' | 'ready' | 'claimed' | 'failed';

export function missionStatus(state: MissionState, def: MissionDef, ctx: PrereqContext): MissionStatus {
  if (state.claimed.includes(def.id)) return 'claimed';
  if (state.completed.includes(def.id)) return 'ready';
  if (state.active.some((m) => m.id === def.id)) return 'active';
  if (state.failed.includes(def.id) && def.source === 'contract') return 'failed';
  return def.prerequisites.every((p) => prereqMet(p, state, ctx)) ? 'available' : 'locked';
}

/** Story missions the pilot can accept now (a failed story mission can be accepted again). */
export function availableStory(state: MissionState, ctx: PrereqContext, all: Iterable<MissionDef> = STORY_BY_ID.values()): MissionDef[] {
  return [...all].filter((d) => missionStatus(state, d, ctx) === 'available');
}

/* -------------------------------------------------------- target resolution */

const nearestFirst = (world: MissionWorld, ids: readonly string[]): string[] =>
  [...ids].sort((a, b) => {
    const ha = world.hops(world.system, a);
    const hb = world.hops(world.system, b);
    return ha - hb || ids.indexOf(a) - ids.indexOf(b);
  });

/** Targets other active missions already point at (two missions never share one POI). */
function claimedTargets(state: MissionState): Set<string> {
  const out = new Set<string>();
  for (const m of state.active) for (const t of m.targets) if (t.includes('#')) out.add(t);
  return out;
}

function siteFor(o: ObjectiveDef): (s: WorldSite) => boolean {
  if (o.kind === 'poi') return (s) => s.kind === o.poiKind;
  if (o.kind === 'clear') return o.encounter === 'outpost' ? (s) => s.kind === 'installation' : (s) => s.kind === `site:${o.encounter}`;
  return () => false;
}

/** Resolve one objective's target rule. TARGET_DONE = nothing left anywhere (the objective counts as met). */
export function resolveTarget(o: ObjectiveDef, galaxy: string, world: MissionWorld, taken: ReadonlySet<string>): string {
  if (o.target === 'any') return '';
  if (o.target !== 'nearest') return o.target;
  const g = galaxy || world.galaxy;
  const pool = nearestFirst(world, world.systemsIn(g).filter((id) => world.enterable(id) && Number.isFinite(world.hops(world.system, id))));
  switch (o.kind) {
    case 'visit':
      return pool.find((id) => id !== world.system && !world.visited(id)) ?? TARGET_DONE;
    case 'chart':
      return pool.find((id) => !world.charted(id)) ?? TARGET_DONE;
    case 'deliver':
      return pool.find((id) => id !== world.system && world.station(id)) ?? pool.find((id) => world.station(id)) ?? TARGET_DONE;
    case 'destroy':
      // prefer a system whose patrols can supply the whole count in one visit (no re-entry grind); else any patrol
      return pool.find((id) => patrolShips(world, id) >= o.count) ?? pool.find((id) => patrolShips(world, id) > 0) ?? TARGET_DONE;
    case 'poi':
    case 'clear': {
      const match = siteFor(o);
      for (const id of pool) {
        const s = world.sites(id).find((x) => match(x) && !x.done && !taken.has(`${id}#${x.id}`));
        if (s) return `${id}#${s.id}`;
      }
      return TARGET_DONE;
    }
    default:
      return '';
  }
}

/* ---------------------------------------------------------------- accepting */

export type AcceptBlock = 'unknown' | 'active' | 'completed' | 'failed' | 'prerequisites' | 'limit';
export type AcceptResult = { readonly ok: true; readonly state: MissionState; readonly mission: ActiveMission } | { readonly ok: false; readonly reason: AcceptBlock };

export function acceptMission(state: MissionState, def: MissionDef | undefined, world: MissionWorld, ctx: PrereqContext, contract?: ContractSpec): AcceptResult {
  if (!def) return { ok: false, reason: 'unknown' };
  if (state.active.some((m) => m.id === def.id)) return { ok: false, reason: 'active' };
  if (state.completed.includes(def.id)) return { ok: false, reason: 'completed' };
  if (def.source === 'contract' && state.failed.includes(def.id)) return { ok: false, reason: 'failed' };
  if (!def.prerequisites.every((p) => prereqMet(p, state, ctx))) return { ok: false, reason: 'prerequisites' };
  if (state.active.length >= MAX_ACTIVE) return { ok: false, reason: 'limit' };
  const taken = claimedTargets(state);
  const targets = def.objectives.map((o) => {
    const t = contract ? contract.target : resolveTarget(o, def.galaxy, world, taken);
    if (t.includes('#')) taken.add(t);
    return t;
  });
  const mission: ActiveMission = {
    id: def.id,
    at: state.jumps,
    progress: def.objectives.map((o, i) => (targets[i] === TARGET_DONE ? o.count : 0)),
    targets,
    ...(contract ? { contract } : {}),
  };
  let next: MissionState = { ...state, active: [...state.active, mission], failed: state.failed.filter((id) => id !== def.id) };
  next = settle(next, def.id).state;
  return { ok: true, state: next, mission };
}

/* ---------------------------------------------------------------- progress */

/** Units an event adds to an objective (0 = no match). */
export function objectiveGain(o: ObjectiveDef, target: string, missionId: string, galaxy: string, e: GameEvent): number {
  if (target === TARGET_DONE) return 0;
  const sys = targetSystem(target);
  const local = targetLocal(target);
  const inScope = (systemId: string): boolean => (sys ? systemId === sys : !galaxy || galaxyOf(systemId) === galaxy);
  switch (o.kind) {
    case 'visit':
      return e.type === 'system-visited' && (sys ? e.systemId === sys : e.first && inScope(e.systemId)) ? 1 : 0;
    case 'reach-galaxy':
      return e.type === 'galaxy-reached' && e.galaxyId === o.galaxy ? 1 : 0;
    case 'chart':
      return e.type === 'system-charted' && inScope(e.systemId) ? 1 : 0;
    case 'poi':
      return e.type === 'poi-completed' && e.kind === o.poiKind && inScope(e.systemId) && (!local || e.poiId === local) ? 1 : 0;
    case 'clear':
      return e.type === 'encounter-cleared' && e.kind === o.encounter && inScope(e.systemId) && (!local || e.encounterId === local) ? 1 : 0;
    case 'destroy':
      return e.type === 'hostile-destroyed' && inScope(e.systemId) && (!o.patrol || e.role === 'patrol') ? 1 : 0;
    case 'acquire':
      return e.type === 'resource-acquired' && (o.resources ?? []).includes(e.resource) ? e.amount : 0;
    case 'deliver':
      return e.type === 'delivered' && e.missionId === missionId && e.resource === (o.resources ?? [])[0] ? e.amount : 0;
    default:
      return 0;
  }
}

export type MissionUpdate =
  | { readonly kind: 'progress'; readonly id: string; readonly title: string; readonly objective: number; readonly value: number; readonly count: number }
  | { readonly kind: 'completed'; readonly id: string; readonly title: string }
  | { readonly kind: 'failed'; readonly id: string; readonly title: string; readonly why: 'deadline' | 'encounter' | 'abandoned' };

/** Move a mission whose objectives are all met to `completed` (once). */
function settle(state: MissionState, id: string): { state: MissionState; done: boolean } {
  const m = state.active.find((x) => x.id === id);
  const def = m ? missionDef(state, id) : undefined;
  if (!m || !def || state.completed.includes(id)) return { state, done: false };
  if (!def.objectives.every((o, i) => (m.progress[i] ?? 0) >= o.count)) return { state, done: false };
  const ready = m.contract ? { ...state.ready, [id]: m.contract } : state.ready;
  return { state: { ...state, active: state.active.filter((x) => x.id !== id), completed: [...state.completed, id], ready }, done: true };
}

function fail(state: MissionState, id: string): MissionState {
  return { ...state, active: state.active.filter((x) => x.id !== id), failed: state.failed.includes(id) ? state.failed : [...state.failed, id] };
}

/** Feed one gameplay event to every active mission. */
export function consumeEvent(state: MissionState, e: GameEvent): { readonly state: MissionState; readonly updates: readonly MissionUpdate[] } {
  let s = state;
  const updates: MissionUpdate[] = [];
  if (e.type === 'jumped' && e.hops > 0) s = { ...s, jumps: s.jumps + Math.floor(e.hops) };
  for (const m of state.active) {
    const def = missionDef(s, m.id);
    if (!def) continue;
    // failure first: an expired deadline or a lost defence ends the mission
    if (e.type === 'jumped' && def.failure.deadlineJumps && s.jumps - m.at > def.failure.deadlineJumps) {
      s = fail(s, m.id);
      updates.push({ kind: 'failed', id: m.id, title: def.title, why: 'deadline' });
      continue;
    }
    if (e.type === 'encounter-failed' && def.failure.failOnEncounterLoss && m.targets.some((t) => targetSystem(t) === e.systemId && targetLocal(t) === e.encounterId)) {
      s = fail(s, m.id);
      updates.push({ kind: 'failed', id: m.id, title: def.title, why: 'encounter' });
      continue;
    }
    let changed = false;
    const progress = def.objectives.map((o, i) => {
      const cur = m.progress[i] ?? 0;
      if (cur >= o.count) return cur;
      const gain = objectiveGain(o, m.targets[i] ?? '', m.id, def.galaxy, e);
      if (gain <= 0) return cur;
      changed = true;
      const value = Math.min(o.count, cur + gain);
      updates.push({ kind: 'progress', id: m.id, title: def.title, objective: i, value, count: o.count });
      return value;
    });
    if (!changed) continue;
    s = { ...s, active: s.active.map((x) => (x.id === m.id ? { ...x, progress } : x)) };
    const settled = settle(s, m.id);
    s = settled.state;
    if (settled.done) updates.push({ kind: 'completed', id: m.id, title: def.title });
  }
  return { state: s, updates };
}

export function abandonMission(state: MissionState, id: string): { readonly state: MissionState; readonly update: MissionUpdate | null } {
  const m = state.active.find((x) => x.id === id);
  if (!m) return { state, update: null };
  const def = missionDef(state, id);
  return { state: fail(state, id), update: { kind: 'failed', id, title: def?.title ?? id, why: 'abandoned' } };
}

/** Completed missions whose reward has not been paid yet. */
export const readyMissions = (state: MissionState): string[] => state.completed.filter((id) => !state.claimed.includes(id));

/** Mark a reward as paid. Null when the mission is not ready (unknown, unfinished or already claimed). */
export function markClaimed(state: MissionState, id: string): MissionState | null {
  if (!state.completed.includes(id) || state.claimed.includes(id)) return null;
  const ready = { ...state.ready };
  delete ready[id];
  return { ...state, claimed: [...state.claimed, id], ready };
}

/** Units still to deliver for a deliver objective of an active mission (0 = none or not a delivery). */
export function deliveryNeed(state: MissionState, id: string): { readonly resource: string; readonly left: number; readonly station: string } | null {
  const m = state.active.find((x) => x.id === id);
  const def = m ? missionDef(state, id) : undefined;
  if (!m || !def) return null;
  const i = def.objectives.findIndex((o) => o.kind === 'deliver');
  if (i < 0) return null;
  const o = def.objectives[i]!;
  return { resource: (o.resources ?? [])[0] ?? '', left: Math.max(0, o.count - (m.progress[i] ?? 0)), station: targetSystem(m.targets[i] ?? '') };
}
