/**
 * Collection at run time (Free Roam Prompt 10). Pure; mutates only the run.
 *
 * Collectibles and their ids (FR-TD-57):
 *  - POIs: salvage (fly through), derelicts / caches / anomalies (INTERACT).
 *    Persistent: the id joins `done` once everything is taken; a partly taken
 *    container keeps the rest under `left[id]` (saved), never more.
 *  - Ore fragments `vein-N.k`: chipped from a marked vein by bolt hits; chip
 *    k is spawned at most once per visit and joins `done` when collected, so a
 *    vein depletes once and stays depleted (rocks never break).
 *  - Reward caches `<encounter id>.1`: an encounter or outpost reward that did
 *    not fit floats at the site and is saved under `left` until taken.
 *  - Salvage pods `drop-N` (destroyed enemies, capped per visit, expire after
 *    40 s with a blinking warning) and jettison pods `jet-N` (cargo thrown
 *    out, 60 s): temporary, never saved.
 *  - The cargo wreck (Prompt 9) is collected the same way.
 *
 * Rules: an id is awarded at most once (`claimed` plus `done`); an award
 * never exceeds the free hold space; when the find does not fit, nothing is
 * taken automatically: a `holdFull` event (once per approach) opens the
 * offer and the pilot decides (TAKE WHAT FITS = takeOffer, SWAP = jettison
 * then takeOffer, LEAVE IT = fly on). What is not taken stays where it is.
 */
import { createRng, type Rng } from '../../../core/rng.ts';
import type { FamilyId } from '../combat/families.ts';
import type { AgentRole } from '../combat/state.ts';
import type { FactionId } from '../catalogue/types.ts';
import { lootUnits, normalizeLoot, planTake } from '../inventory/inventory.ts';
import { dropBudget, JETTISON_LIFE_TICKS, KILL_DROPS, MINING, PICKUP_RADIUS, rollKillDrop, type LootContext } from '../inventory/lootTables.ts';
import { dist } from './grid.ts';
import type { LootEntry, OreVein, Poi, SectorLayout, SectorSave } from './model.ts';
import type { SectorEvent, SectorRun } from './run.ts';

export type PickupKind = 'pod' | 'ore' | 'cache' | 'jettison';

export interface Pickup {
  readonly id: string;
  readonly kind: PickupKind;
  readonly label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  loot: LootEntry[];
  /** Ticks left (Infinity = persistent: ore fragments and reward caches). */
  life: number;
  readonly persistent: boolean;
  /** False until the ship has been out of reach once (a jettison pod is not scooped straight back up). */
  armed: boolean;
}

export interface LootOffer {
  readonly id: string;
  readonly kind: 'poi' | 'pickup' | 'wreck';
  readonly label: string;
  readonly loot: readonly LootEntry[];
  readonly need: number;
  readonly space: number;
  readonly x: number;
  readonly y: number;
  /** The ship must stay within this distance for the offer to stay open. */
  readonly reach: number;
}

/** Bounded so a long fight or repeated jettisons can never flood the sector. */
export const MAX_PICKUPS = 24;
const POD_LABEL: Readonly<Record<PickupKind, string>> = { pod: 'Salvage pod', ore: 'Ore fragment', cache: 'Reward cache', jettison: 'Jettisoned cargo' };
const CONTAINER_KINDS: readonly string[] = ['salvage', 'derelict', 'cache', 'anomaly'];

/** Mixes the run seed into the dedicated loot stream (separate from the harmless-variation stream). */
export const lootStream = (seed: number): Rng => createRng((Math.imul(seed >>> 0, 0x2c1b3c6d) ^ 0x10075a1d) >>> 0);

export const chipId = (v: OreVein, k: number): string => `${v.id}.${k}`;
export const cacheId = (encounterId: string): string => `${encounterId}.1`;

export const lootContextOf = (L: SectorLayout): LootContext => ({ difficulty: L.difficulty, richness: L.resources.richness, primary: L.resources.primary, secondary: L.resources.secondary });

/** Every id a save may hold for this layout: POIs, sites, ore chips and reward caches. */
export function persistentIds(L: SectorLayout): Set<string> {
  const ids = new Set<string>([...L.pois.map((p) => p.id), ...L.sites.map((s) => s.id)]);
  for (const v of L.veins) v.chips.forEach((_, i) => ids.add(chipId(v, i + 1)));
  for (const s of L.sites) ids.add(cacheId(s.id));
  for (const p of L.pois) if (p.kind === 'installation') ids.add(cacheId(p.id));
  return ids;
}

/** Saved leftovers that still apply to this layout (unknown or completed ids are ignored). */
export function leftFromSave(L: SectorLayout, save: SectorSave, done: ReadonlySet<string>): Map<string, LootEntry[]> {
  const out = new Map<string, LootEntry[]>();
  const ids = persistentIds(L);
  for (const [id, counts] of Object.entries(save.left ?? {})) {
    if (!ids.has(id) || done.has(id)) continue;
    const poi = L.pois.find((p) => p.id === id);
    if (poi && !CONTAINER_KINDS.includes(poi.kind)) continue;
    const loot = normalizeLoot(Object.entries(counts).map(([resource, amount]) => ({ resource, amount })));
    if (loot.length) out.set(id, loot);
  }
  return out;
}

/** Where a reward cache floats: just outside the site's anchor (or the outpost hull). */
function cachePoint(L: SectorLayout, encounterId: string): { x: number; y: number } {
  const site = L.sites.find((s) => s.id === encounterId);
  const poi = L.pois.find((p) => p.id === (site ? site.anchor : encounterId));
  const c = site ?? poi ?? L.arrival;
  const solid = poi ? Math.max(poi.solidR, 12) : 12;
  return { x: Math.min(L.width - 20, Math.max(20, c.x)), y: Math.min(L.height - 20, Math.max(20, c.y - solid - 44)) };
}

/** Saved reward caches become floating pickups on entry. */
export function spawnSavedCaches(run: SectorRun): void {
  for (const [id, loot] of run.left) {
    if (!id.endsWith('.1')) continue;
    const base = id.slice(0, -2);
    if (!run.layout.sites.some((s) => s.id === base) && !run.layout.pois.some((p) => p.id === base && p.kind === 'installation')) continue;
    const at = cachePoint(run.layout, base);
    addPickup(run, { id, kind: 'cache', x: at.x, y: at.y, vx: 0, vy: 0, loot, life: Infinity, persistent: true, armed: true });
  }
}

function addPickup(run: SectorRun, p: Omit<Pickup, 'label'>): Pickup | null {
  if (run.pickups.some((q) => q.id === p.id)) return null;
  // bounded: nothing already floating is ever removed to make room (no find vanishes); the caller handles the refusal
  if (run.pickups.length >= MAX_PICKUPS) return null;
  const pk: Pickup = { ...p, label: POD_LABEL[p.kind] };
  run.pickups.push(pk);
  return pk;
}

/** What a POI still holds (its saved leftovers, else its generated loot). */
export const lootOf = (run: SectorRun, p: Poi): readonly LootEntry[] => run.left.get(p.id) ?? p.loot;

/* ---------------------------------------------------------------- awards */

type Target =
  | { readonly kind: 'poi'; readonly poi: Poi }
  | { readonly kind: 'pickup'; readonly pickup: Pickup }
  | { readonly kind: 'wreck' };

function targetId(t: Target): string {
  return t.kind === 'poi' ? t.poi.id : t.kind === 'pickup' ? t.pickup.id : 'wreck';
}

function targetLoot(run: SectorRun, t: Target): readonly LootEntry[] {
  if (t.kind === 'poi') return lootOf(run, t.poi);
  if (t.kind === 'pickup') return t.pickup.loot;
  const w = run.cargoWreck;
  return w?.loot ?? (w ? [{ resource: 'scrap', amount: w.units }] : []);
}

function targetUnits(run: SectorRun, t: Target): number {
  if (t.kind === 'wreck') return run.cargoWreck?.units ?? 0;
  return lootUnits(targetLoot(run, t));
}

/**
 * Award `take` from a target (the whole find, or the part that fits); the
 * rest stays (POI leftovers, a lighter pickup, a lighter wreck). Emits the
 * collection event. Returns false when the id was already awarded.
 */
function award(run: SectorRun, t: Target, take: readonly LootEntry[], left: readonly LootEntry[], events: SectorEvent[]): boolean {
  const id = targetId(t);
  if (t.kind !== 'wreck' && (run.claimed.has(id) || run.done.has(id))) return false;
  const units = t.kind === 'wreck' && !run.cargoWreck?.loot ? run.cargoWreck?.units ?? 0 : lootUnits(take);
  run.cargoSpace -= units;
  if (run.offer?.id === id) run.offer = null;
  if (t.kind === 'poi') {
    const p = t.poi;
    if (left.length === 0) {
      run.done.add(p.id);
      run.claimed.add(p.id);
      run.left.delete(p.id);
    } else run.left.set(p.id, [...left]);
    if (p.kind === 'salvage') events.push({ type: 'collected', id: p.id, loot: take, left });
    else events.push({ type: 'looted', id: p.id, kind: p.kind, label: p.label, loot: take, left });
    return true;
  }
  if (t.kind === 'pickup') {
    const pk = t.pickup;
    if (left.length === 0) {
      run.claimed.add(pk.id);
      if (pk.persistent) {
        run.done.add(pk.id);
        run.left.delete(pk.id);
      }
      const i = run.pickups.indexOf(pk);
      if (i >= 0) run.pickups.splice(i, 1);
    } else {
      pk.loot = [...left];
      if (pk.persistent) run.left.set(pk.id, [...left]);
    }
    events.push({ type: 'picked', id: pk.id, kind: pk.kind, label: pk.label, loot: take, left, persistent: pk.persistent });
    return true;
  }
  const w = run.cargoWreck!;
  if (left.length === 0 || !w.loot) run.cargoWreck = null;
  else run.cargoWreck = { x: w.x, y: w.y, units: lootUnits(left), loot: [...left] };
  events.push({ type: 'recovered', units, loot: take, left });
  return true;
}

/** Touching a collectible: take everything if it fits, else open the offer (one notice per approach). */
function touch(run: SectorRun, t: Target, x: number, y: number, reach: number, events: SectorEvent[]): void {
  const id = targetId(t);
  if (t.kind !== 'wreck' && (run.claimed.has(id) || run.done.has(id))) return;
  const need = targetUnits(run, t);
  if (need <= 0) return;
  if (run.snooze?.id === id && need > run.cargoSpace) return; // already decided; room made since then takes it
  if (need <= run.cargoSpace) {
    award(run, t, targetLoot(run, t), [], events);
    return;
  }
  if (run.offer?.id === id) return;
  const space = Math.max(0, run.cargoSpace);
  run.offer = { id, kind: t.kind, label: t.kind === 'poi' ? t.poi.label : t.kind === 'pickup' ? t.pickup.label : 'Cargo wreck', loot: [...targetLoot(run, t)], need, space, x, y, reach };
  events.push({ type: 'holdFull', id, need, space });
}

/** Fly-through salvage node. */
export function touchPoi(run: SectorRun, p: Poi, events: SectorEvent[]): void {
  touch(run, { kind: 'poi', poi: p }, p.x, p.y, p.r + run.tune.radius + 30, events);
}

/** INTERACT on a container: take it, or open the offer; a second press while the offer is open takes what fits. */
export function interactContainer(run: SectorRun, p: Poi, at: { readonly x: number; readonly y: number } = p): SectorEvent[] {
  const events: SectorEvent[] = [];
  if (run.done.has(p.id)) return events;
  if (run.offer?.id === p.id) return takeOffer(run);
  if (run.snooze?.id === p.id) run.snooze = null; // pressing INTERACT again asks again
  // `at`: where the find is (a resolved anomaly signal is investigated at its fix, P06.1)
  touch(run, { kind: 'poi', poi: p }, at.x, at.y, p.r + run.tune.radius + 30, events);
  return events;
}

export function touchWreck(run: SectorRun, events: SectorEvent[], reach: number): void {
  const w = run.cargoWreck;
  if (w) touch(run, { kind: 'wreck' }, w.x, w.y, reach + 30, events);
}

/** TAKE WHAT FITS for the open offer: the most valuable units first; the rest stays. */
export function takeOffer(run: SectorRun): SectorEvent[] {
  const o = run.offer;
  if (!o || run.phase === 'briefing' || run.disposed) return [];
  const t: Target | null =
    o.kind === 'poi' ? ((p) => (p ? { kind: 'poi' as const, poi: p } : null))(run.layout.pois.find((p) => p.id === o.id)) : o.kind === 'pickup' ? ((pk) => (pk ? { kind: 'pickup' as const, pickup: pk } : null))(run.pickups.find((q) => q.id === o.id)) : run.cargoWreck ? { kind: 'wreck' as const } : null;
  if (!t) {
    run.offer = null;
    return [];
  }
  const loot = targetLoot(run, t);
  if (t.kind === 'wreck' && !run.cargoWreck?.loot) {
    // a wreck without a known manifest is taken whole only
    if ((run.cargoWreck?.units ?? 0) > run.cargoSpace) return [{ type: 'holdFull', id: o.id, need: o.need, space: Math.max(0, run.cargoSpace) }];
  }
  const plan = planTake(loot, run.cargoSpace);
  if (plan.take.length === 0) return [{ type: 'holdFull', id: o.id, need: targetUnits(run, t), space: Math.max(0, run.cargoSpace) }];
  const events: SectorEvent[] = [];
  award(run, t, plan.take, plan.left, events);
  run.offer = null;
  if (plan.left.length > 0) run.snooze = { id: o.id, x: o.x, y: o.y, reach: o.reach };
  return events;
}

/** LEAVE IT: close the offer; the find stays where it is (and is marked on the sector map). */
export function leaveOffer(run: SectorRun): void {
  const o = run.offer;
  if (o) run.snooze = { id: o.id, x: o.x, y: o.y, reach: o.reach };
  run.offer = null;
}

/** Close the offer once the ship is out of reach of it. */
export function stepOffer(run: SectorRun): void {
  const o = run.offer;
  if (o && dist(run.ship, o) > o.reach) run.offer = null;
  const z = run.snooze;
  if (z && dist(run.ship, z) > z.reach) run.snooze = null;
}

/* --------------------------------------------------------------- pickups */

/** Move floating pickups, expire temporary ones, and collect on contact. */
export function stepPickups(run: SectorRun, events: SectorEvent[]): void {
  const reach = PICKUP_RADIUS + run.tune.radius;
  for (let i = run.pickups.length - 1; i >= 0; i--) {
    const p = run.pickups[i]!;
    p.x = Math.min(run.layout.width - 8, Math.max(8, p.x + p.vx / 60));
    p.y = Math.min(run.layout.height - 8, Math.max(8, p.y + p.vy / 60));
    p.vx *= 0.97;
    p.vy *= 0.97;
    if (Math.abs(p.vx) < 0.5) p.vx = 0;
    if (Math.abs(p.vy) < 0.5) p.vy = 0;
    if (Number.isFinite(p.life)) {
      p.life -= 1;
      if (p.life <= 0) {
        if (run.offer?.id === p.id) run.offer = null;
        run.pickups.splice(i, 1);
        events.push({ type: 'expired', id: p.id, kind: p.kind });
        continue;
      }
    }
    const d = dist(run.ship, p);
    if (!p.armed) {
      if (d > reach + 24) p.armed = true;
      continue;
    }
    if (d <= reach && !run.docked) touch(run, { kind: 'pickup', pickup: p }, p.x, p.y, reach + 40, events);
  }
}

/** Throw cargo out of the hold: it floats behind the ship as a jettison pod. Returns no event when refused (pickups at their bound): the shell removes the cargo from the profile only on a `jettisoned` event. */
export function jettison(run: SectorRun, loot: readonly LootEntry[]): SectorEvent[] {
  const clean = normalizeLoot(loot);
  const units = lootUnits(clean);
  if (units === 0 || run.disposed || run.pickups.length >= MAX_PICKUPS) return []; // refused: the shell keeps the cargo
  const sh = run.ship;
  const nx = Math.sin(sh.heading);
  const ny = -Math.cos(sh.heading);
  const back = run.tune.radius + 14;
  const id = `jet-${run.nextPickup++}`;
  if (!addPickup(run, { id, kind: 'jettison', x: sh.x - nx * back, y: sh.y - ny * back, vx: sh.vx * 0.3 - nx * 24, vy: sh.vy * 0.3 - ny * 24, loot: clean, life: JETTISON_LIFE_TICKS, persistent: false, armed: false })) return [];
  run.cargoSpace += units;
  return [{ type: 'jettisoned', id, units }];
}

/* ------------------------------------------------------------ kill drops */

/** A ship destroyed by the pilot may leave a salvage pod (seeded, once per ship, within the visit budget). */
export function killDrop(run: SectorRun, e: { readonly hostile: number; readonly family: FamilyId; readonly faction: FactionId; readonly by: 'player' | 'npc'; readonly role: AgentRole; readonly x: number; readonly y: number }, events: SectorEvent[]): void {
  if (e.by !== 'player' || e.role === 'launched' || run.dropRolled.has(e.hostile)) return;
  run.dropRolled.add(e.hostile); // one roll per ship, whatever happens next
  if (run.dropBudget <= 0) return;
  const r = run.lootRng;
  if (r.next() >= KILL_DROPS.chance[e.family]) return;
  const loot = rollKillDrop(r, lootContextOf(run.layout), e.family, e.faction);
  if (loot.length === 0) return;
  const a = r.range(-Math.PI, Math.PI);
  const id = `drop-${run.nextPickup++}`;
  if (!addPickup(run, { id, kind: 'pod', x: e.x, y: e.y, vx: Math.cos(a) * 30, vy: Math.sin(a) * 30, loot, life: KILL_DROPS.lifeTicks, persistent: false, armed: true })) return;
  run.dropBudget -= 1;
  events.push({ type: 'dropped', id, x: e.x, y: e.y });
}

export const initialDropBudget = (L: SectorLayout): number => (L.threat > 0 ? dropBudget(L.difficulty) : 0);

/* ---------------------------------------------------------------- mining */

/** Chips of a vein not collected yet (saved or this visit). */
export const chipsLeft = (run: SectorRun, v: OreVein): number => v.chips.filter((_, i) => !run.done.has(chipId(v, i + 1))).length;

/** A bolt hit a rock: if it carries a vein with chips left, count the hit and chip a fragment loose every few hits. */
export function mineShot(run: SectorRun, ax: number, ay: number, bx: number, by: number, r: number, events: SectorEvent[]): void {
  for (const v of run.layout.veins) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((v.x - ax) * dx + (v.y - ay) * dy) / len2)) : 0;
    if (Math.hypot(ax + dx * t - v.x, ay + dy * t - v.y) > v.r + r) continue;
    // next chip: not collected, not floating already
    const k = v.chips.findIndex((_, i) => !run.done.has(chipId(v, i + 1)) && !run.claimed.has(chipId(v, i + 1)) && !run.pickups.some((p) => p.id === chipId(v, i + 1)));
    if (k < 0) return;
    const hits = (run.veinHits.get(v.id) ?? 0) + 1;
    if (hits < MINING.hitsPerChip) {
      run.veinHits.set(v.id, hits);
      events.push({ type: 'veinHit', id: v.id, x: ax + dx * t, y: ay + dy * t });
      return;
    }
    run.veinHits.set(v.id, 0);
    const id = chipId(v, k + 1);
    // the fragment flies out toward the shooter
    const ang = Math.atan2(ay - v.y, ax - v.x);
    const x = v.x + Math.cos(ang) * (v.r + 10);
    const y = v.y + Math.sin(ang) * (v.r + 10);
    const loot = run.left.get(id) ?? [...v.chips[k]!];
    if (!addPickup(run, { id, kind: 'ore', x, y, vx: Math.cos(ang) * MINING.chipSpeed, vy: Math.sin(ang) * MINING.chipSpeed, loot, life: Infinity, persistent: true, armed: true })) return; // the chip stays in the rock
    events.push({ type: 'chipped', id, vein: v.id, x, y, remaining: chipsLeft(run, v) - run.pickups.filter((p) => p.kind === 'ore' && p.id.startsWith(`${v.id}.`)).length });
    return;
  }
}

/* --------------------------------------------------------- reward caches */

/**
 * An encounter or outpost reward that did not fit: the rest floats at the
 * site as a reward cache (`<encounter id>.1`), saved under `left` by the
 * shell from the encounter event, until it is taken.
 */
export function spillReward(run: SectorRun, encounterId: string, left: readonly LootEntry[]): void {
  const loot = normalizeLoot(left);
  if (loot.length === 0) return;
  const id = cacheId(encounterId);
  if (run.done.has(id) || run.claimed.has(id)) return;
  run.left.set(id, loot);
  const at = cachePoint(run.layout, encounterId);
  addPickup(run, { id, kind: 'cache', x: at.x, y: at.y, vx: 0, vy: 0, loot, life: Infinity, persistent: true, armed: true });
}
