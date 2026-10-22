/**
 * Encounters (Free Roam Prompt 9): who appears where, when an encounter
 * starts, completes, fails or breaks off, and what it pays.
 *
 *  patrol interception  patrol routes (layout.patrols) wake near the pilot and
 *                       sleep when it is far away; their ships pay nothing.
 *  hostile outpost      installation POIs: entering the alert zone launches the
 *                       garrison; destroy it or survive the hold time nearby.
 *  ambush               near a bait (wreck, cache, anomaly) warp markers ring
 *                       the pilot for COMBAT.ambushWarnTicks, then the wave
 *                       arrives; destroy it.
 *  wreck defence        a distress beacon on a derelict: hold near it while
 *                       waves of raiders try to strip it; cargo raiders at the
 *                       wreck wear its integrity down (zero = failed).
 *  salvage dispute      Gleaners work a salvage field; taking its salvage or
 *                       shooting them turns them hostile; a rival (often the
 *                       Red Tally) may already be fighting them. Pays when the
 *                       pilot has fought and every ship hostile to it is gone.
 *  elite / capital      a named ace with escorts, or a capital ship that
 *                       launches raiders; destroy it.
 *
 * Rewards: an encounter pays its fixed loot once, on completion (as far as the
 * hold allows; the rest floats at the site as a reward cache), and its id
 * is persisted in the sector's `done` list in the same save; done encounters
 * are never re-created, so elites and capital ships stay defeated. Ordinary
 * kills pay nothing. A death or retreat resets live encounters without pay.
 */
import type { FactionId } from '../catalogue/types.ts';
import { HOSTILE_FACTIONS } from '../catalogue/types.ts';
import type { SectorEvent, SectorRun } from '../sector/run.ts';
import { dist, segmentDistance } from '../sector/grid.ts';
import { lootUnits, planTake } from '../inventory/inventory.ts';
import { spillReward } from '../sector/collect.ts';
import { maxTierFor, type EncounterSite, type LootEntry, type Poi, type SectorLayout } from '../sector/model.ts';
import { spawnAgent } from './ai.ts';
import { COMBAT, compositionFor } from './difficulty.ts';
import { FAMILIES, type FamilyId } from './families.ts';
import type { Agent, AgentRole, CombatLevel, EncounterRuntime, Pending } from './state.ts';
import { hostileTo, inSanctuary, setState } from './world.ts';

/** The faction holding the sector's installation (the generator labels it the same way). */
export function outpostFaction(L: SectorLayout): FactionId {
  return L.factions.find((f) => HOSTILE_FACTIONS.includes(f)) ?? 'tessellate';
}

export const siteOf = (L: SectorLayout, id: string): EncounterSite | undefined => L.sites.find((s) => s.id === id);
const poiOf = (L: SectorLayout, id: string): Poi | undefined => L.pois.find((p) => p.id === id);

/** Encounter runtimes for every outpost and site not yet completed. */
export function createEncounters(L: SectorLayout, done: ReadonlySet<string>): EncounterRuntime[] {
  const out: EncounterRuntime[] = [];
  const fresh = (id: string, kind: EncounterRuntime['kind']): EncounterRuntime => ({ id, kind, state: 'dormant', ticks: 0, waves: 0, spawned: 0, holdLeft: 0, integrity: COMBAT.wreckIntegrity, engaged: false, awake: false });
  for (const p of L.pois) if (p.kind === 'installation' && !done.has(p.id)) out.push(fresh(p.id, 'outpost'));
  for (const s of L.sites) if (!done.has(s.id)) out.push(fresh(s.id, s.kind));
  return out;
}

/** Encounter location (site centre / installation). */
export function encounterPos(L: SectorLayout, e: EncounterRuntime): { x: number; y: number } {
  return siteOf(L, e.id) ?? poiOf(L, e.id) ?? L.arrival;
}

export function encounterLabel(L: SectorLayout, e: EncounterRuntime): string {
  return siteOf(L, e.id)?.label ?? poiOf(L, e.id)?.label ?? 'Encounter';
}

export function encounterLoot(L: SectorLayout, e: EncounterRuntime): readonly LootEntry[] {
  return siteOf(L, e.id)?.loot ?? poiOf(L, e.id)?.loot ?? [];
}

const live = (run: SectorRun, source: string): Agent[] => run.hostiles.filter((a) => a.source === source && a.state !== 'destroyed');
const pendingFor = (run: SectorRun, source: string): number => run.pending.filter((p) => p.source === source).length;

function despawn(run: SectorRun, source: string): void {
  for (let i = run.hostiles.length - 1; i >= 0; i--) if (run.hostiles[i]!.source === source) run.hostiles.splice(i, 1);
  for (let i = run.pending.length - 1; i >= 0; i--) if (run.pending[i]!.source === source) run.pending.splice(i, 1);
}

/** Queue a warp-in (the marker telegraphs it). Refused when the queue is full. */
function queue(run: SectorRun, p: Omit<Pending, 'at'>, delay: number): boolean {
  if (run.pending.length >= COMBAT.maxPending) return false;
  run.pending.push({ ...p, at: run.tick + delay });
  return true;
}

/** Is `p` at least `pad` clear of every rock and landmark body (warp-ins never materialise inside a solid)? */
function clearOfSolids(L: SectorLayout, p: { x: number; y: number }, pad: number): boolean {
  for (const k of L.rocks) if (Math.abs(k.x - p.x) < k.r + pad && Math.abs(k.y - p.y) < k.r + pad && dist(k, p) < k.r + pad) return false;
  for (const l of L.landmarks) if (dist(l, p) < l.r + pad) return false;
  return true;
}

/** A point on the ring of radius `r` around `c`, starting at angle `a`, inside the sector, clear of sanctuaries and solids. */
function ringPoint(L: SectorLayout, c: { x: number; y: number }, r: number, a: number): { x: number; y: number } {
  for (let k = 0; k < 12; k++) {
    const ang = a + k * 0.5;
    const p = { x: Math.min(L.width - 40, Math.max(40, c.x + Math.cos(ang) * r)), y: Math.min(L.height - 40, Math.max(40, c.y + Math.sin(ang) * r)) };
    if (!inSanctuary(L, p, 260) && clearOfSolids(L, p, 26)) return p;
  }
  for (let k = 0; k < 12; k++) {
    // relaxed: any point clear of sanctuaries (a rock-choked ring still spawns somewhere fair)
    const ang = a + k * 0.5;
    const p = { x: Math.min(L.width - 40, Math.max(40, c.x + Math.cos(ang) * r)), y: Math.min(L.height - 40, Math.max(40, c.y + Math.sin(ang) * r)) };
    if (!inSanctuary(L, p, 260)) return p;
  }
  return { x: c.x, y: c.y };
}

function spawnGroup(run: SectorRun, fams: readonly FamilyId[], faction: FactionId, source: string, role: AgentRole, c: { x: number; y: number }, r: number, home?: { x: number; y: number }): number {
  let n = 0;
  fams.forEach((f, i) => {
    const a = (i / Math.max(1, fams.length)) * Math.PI * 2 + run.rng.next() * 0.4;
    const p = ringPoint(run.layout, c, r, a);
    const s = spawnAgent(run, f, faction, source, role, p.x, p.y, 0, f === 'hauler' ? home : undefined);
    if (s) n += 1;
  });
  return n;
}

/* ----------------------------------------------------------------- patrols */

function routeDistance(points: readonly { x: number; y: number }[], p: { x: number; y: number }): number {
  let d = Infinity;
  for (let i = 0; i < points.length; i++) d = Math.min(d, segmentDistance(p, points[i]!, points[(i + 1) % points.length]!));
  return d;
}

/** Patrol ships exist only near the pilot: wake within COMBAT.wakeRadius, sleep beyond sleepRadius when idle. */
export function stepPatrols(run: SectorRun): void {
  const L = run.layout;
  for (const pr of L.patrols) {
    const st = run.patrols.get(pr.id);
    if (!st) continue;
    if (st.cooldown > 0) st.cooldown -= 1;
    const d = routeDistance(pr.points, run.ship);
    if (!st.awake && st.cooldown === 0 && d < COMBAT.wakeRadius) {
      st.awake = true;
      const fams = compositionFor('patrol', pr.tier, pr.ships, pr.faction, L.difficulty, pr.id);
      fams.forEach((f, i) => {
        const pt = pr.points[i % pr.points.length]!;
        const a = spawnAgent(run, f, pr.faction, pr.id, 'patrol', pt.x + run.rng.range(-18, 18), pt.y + run.rng.range(-18, 18));
        if (a) a.waypoint = (i + 1) % pr.points.length;
      });
    } else if (st.awake && d > COMBAT.sleepRadius && run.hostiles.every((h) => h.source !== pr.id || h.state === 'patrol' || h.state === 'idle')) {
      st.awake = false;
      despawn(run, pr.id);
    }
  }
}

/* ----------------------------------------------------------------- pending */

/** Materialise warp-ins whose marker has run out. A ship refused at the cap is dropped (never retried forever). */
export function stepPending(run: SectorRun): void {
  for (let i = run.pending.length - 1; i >= 0; i--) {
    const p = run.pending[i]!;
    if (run.tick < p.at) continue;
    run.pending.splice(i, 1);
    const enc = run.encounters.find((e) => e.id === p.source);
    const a = spawnAgent(run, p.family, p.faction, p.source, p.role, p.x, p.y, p.heading, p.home);
    if (a) {
      a.lastSeen = { x: run.ship.x, y: run.ship.y };
      if (enc) enc.spawned += 1;
    }
  }
}

/* -------------------------------------------------------------- encounters */

function start(run: SectorRun, e: EncounterRuntime, state: 'warning' | 'active', events: SectorEvent[]): void {
  e.state = state;
  e.ticks = 0;
  events.push({ type: 'encounter', id: e.id, kind: e.kind, label: encounterLabel(run.layout, e), state: state === 'warning' ? 'warning' : 'start', loot: [], left: [] });
}

function reset(run: SectorRun, e: EncounterRuntime, despawnShips: boolean): void {
  if (despawnShips) {
    despawn(run, e.id);
    e.awake = false;
  }
  e.state = 'dormant';
  e.ticks = 0;
  e.waves = 0;
  e.spawned = 0;
  e.holdLeft = 0;
  e.integrity = COMBAT.wreckIntegrity;
  e.engaged = false;
}

function complete(run: SectorRun, e: EncounterRuntime, events: SectorEvent[]): void {
  if (e.state === 'done' || run.done.has(e.id)) return; // pays once
  // the reward goes into the hold as far as it fits (most valuable first); the rest floats at the site
  const plan = planTake(encounterLoot(run.layout, e), run.cargoSpace);
  e.state = 'done';
  run.done.add(e.id);
  run.cargoSpace -= lootUnits(plan.take);
  spillReward(run, e.id, plan.left);
  // survivors break off
  for (const a of live(run, e.id)) {
    a.windup = null;
    setState(a, 'retreat');
  }
  run.pending = run.pending.filter((p) => p.source !== e.id);
  events.push({ type: 'encounter', id: e.id, kind: e.kind, label: encounterLabel(run.layout, e), state: 'cleared', loot: plan.take, left: plan.left });
}

function fail(run: SectorRun, e: EncounterRuntime, events: SectorEvent[]): void {
  e.state = 'failed';
  for (const a of live(run, e.id)) setState(a, 'retreat');
  run.pending = run.pending.filter((p) => p.source !== e.id);
  events.push({ type: 'encounter', id: e.id, kind: e.kind, label: encounterLabel(run.layout, e), state: 'failed', loot: [], left: [] });
}

function broken(run: SectorRun, e: EncounterRuntime, events: SectorEvent[], despawnShips: boolean): void {
  reset(run, e, despawnShips);
  events.push({ type: 'encounter', id: e.id, kind: e.kind, label: encounterLabel(run.layout, e), state: 'broken', loot: [], left: [] });
}

const tierOf = (L: SectorLayout): 1 | 2 | 3 => maxTierFor(L.difficulty);

export function stepEncounters(run: SectorRun, events: SectorEvent[]): void {
  const L = run.layout;
  const P = run.ship;
  const calm = run.grace > 0 || run.docked !== null;
  for (const e of run.encounters) {
    if (e.state === 'done' || e.state === 'failed') continue;
    e.ticks += 1;
    const c = encounterPos(L, e);
    const d = dist(P, c);
    if (e.kind === 'outpost') {
      const p = poiOf(L, e.id)!;
      const faction = outpostFaction(L);
      if (e.state === 'dormant') {
        if (calm || d > p.alertR) continue;
        start(run, e, 'active', events);
        e.holdLeft = p.holdTicks;
        const fams = compositionFor('outpost', Math.max(1, p.tier) as 1 | 2 | 3, p.wave, faction, L.difficulty, p.id);
        e.spawned = spawnGroup(run, fams, faction, p.id, 'wave', p, p.solidR + 40);
        e.waves = 1;
      } else {
        e.holdLeft -= 1;
        if (d > COMBAT.encounterLeash) broken(run, e, events, true);
        else if (e.holdLeft <= 0 || (e.spawned > 0 && live(run, e.id).length === 0)) complete(run, e, events);
      }
      continue;
    }
    const s = siteOf(L, e.id)!;
    const faction = s.factions[0]!;
    switch (s.kind) {
      case 'ambush': {
        if (e.state === 'dormant') {
          if (calm || d > s.r) continue;
          start(run, e, 'warning', events);
          const fams = compositionFor('ambush', tierOf(L), s.size, faction, L.difficulty, s.id);
          const base = run.rng.next() * Math.PI * 2;
          fams.forEach((f, i) => {
            const p = ringPoint(L, P, COMBAT.ambushRing, base + (i / fams.length) * Math.PI * 2);
            queue(run, { x: p.x, y: p.y, family: f, faction, source: s.id, role: 'wave', heading: 0 }, COMBAT.ambushWarnTicks);
          });
          e.waves = 1;
        } else if (e.state === 'warning') {
          if (e.ticks >= COMBAT.ambushWarnTicks) {
            e.state = 'active';
            e.ticks = 0;
          }
        } else {
          const left = live(run, e.id).length + pendingFor(run, e.id);
          if (d > COMBAT.encounterLeash) broken(run, e, events, true);
          else if (left === 0) {
            if (e.spawned > 0) complete(run, e, events);
            else reset(run, e, true); // every ship was refused at the cap: nothing was fought, nothing is paid
          }
        }
        break;
      }
      case 'defence': {
        const wreckPoi = s.anchor ? poiOf(L, s.anchor) : undefined;
        const wreck = { x: wreckPoi?.x ?? s.x, y: wreckPoi?.y ?? s.y };
        const wreckR = wreckPoi?.r ?? 0;
        if (e.state === 'dormant') {
          if (calm || d > s.r + 200) continue;
          start(run, e, 'active', events);
          e.holdLeft = s.holdTicks;
          e.integrity = COMBAT.wreckIntegrity;
          e.waves = 0;
        }
        if (e.state !== 'active') break;
        if (d > COMBAT.encounterLeash) {
          broken(run, e, events, true);
          break;
        }
        // waves arrive from the side away from the pilot, telegraphed by warp markers
        if (e.waves < s.waves && (e.waves === 0 ? e.ticks >= 30 : e.ticks >= e.waves * COMBAT.defenceWaveGap)) {
          const fams = compositionFor('defence', tierOf(L), s.size, faction, L.difficulty, `${s.id}:${e.waves}`);
          const away = Math.atan2(wreck.y - P.y, wreck.x - P.x);
          fams.forEach((f, i) => {
            const p = ringPoint(L, wreck, 640, away + (i - (fams.length - 1) / 2) * 0.45);
            queue(run, { x: p.x, y: p.y, family: f, faction, source: s.id, role: f === 'hauler' ? 'guard' : 'wave', heading: 0, home: f === 'hauler' ? { x: wreck.x, y: wreck.y } : undefined }, COMBAT.warpTicks);
          });
          e.waves += 1;
        }
        if (d < s.r * 2.4) e.holdLeft = Math.max(0, e.holdLeft - 1);
        for (const a of live(run, e.id)) {
          if (a.family === 'hauler' && a.state !== 'disabled' && dist(a, wreck) < COMBAT.stripReach + FAMILIES.hauler.radius + wreckR) e.integrity -= COMBAT.stripRate / 60;
        }
        const left = live(run, e.id).length + pendingFor(run, e.id);
        if (e.integrity <= 0) fail(run, e, events);
        else if (e.waves >= s.waves && (e.holdLeft <= 0 || (left === 0 && e.spawned > 0))) complete(run, e, events);
        break;
      }
      case 'dispute': {
        const rival = s.factions[1];
        if (!e.awake && d < COMBAT.wakeRadius) {
          e.awake = true;
          const g = compositionFor('dispute', tierOf(L), s.size, 'gleaners', L.difficulty, s.id);
          spawnGroup(run, g, 'gleaners', s.id, 'guard', s, 110);
          if (rival) {
            const fams = compositionFor('patrol', tierOf(L), Math.max(2, s.size - 1), rival, L.difficulty, `${s.id}:rival`);
            const away = Math.atan2(s.y - P.y, s.x - P.x);
            spawnGroup(run, fams, rival, s.id, 'wave', ringPoint(L, s, 420, away), 60);
          }
        } else if (e.awake && e.state === 'dormant' && d > COMBAT.sleepRadius) {
          despawn(run, s.id);
          e.awake = false;
        }
        if (e.state === 'dormant') {
          if (calm || !e.awake || d > s.r) continue;
          start(run, e, 'active', events);
        } else {
          const ships = live(run, e.id);
          if (d > COMBAT.encounterLeash + s.r) broken(run, e, events, false);
          else if (e.engaged && !ships.some((a) => hostileTo(run, a.faction, 'player'))) complete(run, e, events);
        }
        break;
      }
      case 'elite':
      case 'capital': {
        if (!e.awake && d < COMBAT.wakeRadius) {
          e.awake = true;
          const boss = spawnAgent(run, s.kind, faction, s.id, 'boss', s.x, s.y);
          e.spawned = boss ? 1 : 0;
          if (s.kind === 'elite' && s.size > 1) e.spawned += spawnGroup(run, compositionFor('escort', tierOf(L), s.size - 1, faction, L.difficulty, s.id), faction, s.id, 'guard', s, 90);
        } else if (e.awake && e.state === 'dormant' && d > COMBAT.sleepRadius) {
          despawn(run, s.id);
          e.awake = false;
        }
        const boss = run.hostiles.find((a) => a.source === s.id && a.role === 'boss');
        if (e.state === 'dormant') {
          if (calm || !boss) continue;
          if (boss.target === 'player' || d < s.r * 0.5) start(run, e, 'active', events);
        } else {
          if (!boss || boss.state === 'destroyed') complete(run, e, events);
          else if (d > COMBAT.encounterLeash + s.r) broken(run, e, events, false);
        }
        break;
      }
    }
  }
}

/** Salvage taken from a claimed field turns its Gleaners hostile (claim contested). */
export function salvageTaken(run: SectorRun, poi: Poi, events: SectorEvent[]): void {
  if (!poi.group) return;
  for (const s of run.layout.sites) {
    if (s.kind !== 'dispute' || s.anchor !== poi.group) continue;
    if (!live(run, s.id).some((a) => a.faction === 'gleaners')) continue;
    if (!run.provoked.has('gleaners')) {
      run.provoked.add('gleaners');
      events.push({ type: 'provoked', faction: 'gleaners', why: 'claim' });
    }
    const e = run.encounters.find((x) => x.id === s.id);
    if (e) e.engaged = true;
  }
}

/** A death (or restart): every live encounter resets without pay; completed ones stay completed. */
export function resetEncounters(run: SectorRun): void {
  for (const e of run.encounters) if (e.state !== 'done') reset(run, e, true);
  run.pending.length = 0;
}

/** The combat situation (HUD, docking and ship-switch rules). */
export function combatLevel(run: SectorRun): CombatLevel {
  const P = run.ship;
  let alert = run.pending.length > 0;
  for (const a of run.hostiles) {
    if (a.state === 'destroyed' || !hostileTo(run, a.faction, 'player')) continue;
    const d = dist(a, P);
    if (a.target === 'player' && d < COMBAT.combatRadius) return 'engaged';
    if (d < COMBAT.wakeRadius) alert = true;
  }
  if (run.encounters.some((e) => (e.state === 'active' || e.state === 'warning') && e.kind !== 'dispute')) return 'engaged';
  return alert ? 'alert' : 'calm';
}
