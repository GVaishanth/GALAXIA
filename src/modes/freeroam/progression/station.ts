/**
 * Station transactions that combine progression with the inventory and the
 * fleet (Free Roam Prompt 11): turning missions in, handing over deliveries,
 * upgrade and ship quotes, and the free emergency reactor cells.
 *
 * Same two-step rule as economy.ts: quote (cost and the resulting change,
 * shown before confirming), then commit (re-validated). Pure.
 */
import type { NavGraph } from '../galaxy/graph.ts';
import { deriveView, type ExplorationProgress } from '../galaxy/progress.ts';
import { deriveSystemView } from '../galaxy/systems.ts';
import { addLoot, removeLoot, storeModule, storedTotal, MAX_STORED_MODULES } from '../inventory/inventory.ts';
import { resourceName } from '../inventory/resources.ts';
import { EQUIPMENT_BY_ID } from '../ships/equipment.ts';
import { acquireShip, compareStats, formatStat, STAT_INFO, COMPARE_KEYS, type FleetState, type LicenceCheck } from '../ships/hangar.ts';
import { SHIP_BY_ID } from '../ships/roster.ts';
import type { Loadout, ShipId } from '../ships/types.ts';
import { checkUpgrade, LEVEL_NAME, UPGRADE_BY_TRACK, upgradedShip, type UpgradeLevels } from '../ships/upgrades.ts';
import { addMarks, rewardFits, type Quote, type QuoteLine, type Wallet } from './economy.ts';
import type { GameEvent } from './events.ts';
import { deliveryNeed, markClaimed, missionDef } from './missions.ts';
import type { MissionReward } from './missionTypes.ts';
import type { ProgressionState } from './persistence.ts';
import { FUEL } from './fuel.ts';

/* ------------------------------------------------------------------ charts */

/** Systems a navigation-data reward charts: unlocked, uncharted, known ones first (survey order). */
export function rewardChartTargets(graph: NavGraph, progress: ExplorationProgress, galaxy: string, n: number): string[] {
  if (n <= 0 || !graph.node(galaxy)) return [];
  const view = deriveView(graph, progress);
  const sv = deriveSystemView(view, galaxy as never);
  const pool = graph.surveyOrder(galaxy as never).filter((s) => !view.charted.has(s.id) && sv.unlocked(s.id));
  const known = pool.filter((s) => sv.knowledge(s.id) !== 'hidden');
  const rest = pool.filter((s) => sv.knowledge(s.id) === 'hidden');
  return [...known, ...rest].slice(0, n).map((s) => s.id);
}

/* ------------------------------------------------------------------ claims */

export type ClaimResult =
  | { readonly ok: true; readonly progression: ProgressionState; readonly wallet: Wallet; readonly charted: readonly string[]; readonly reward: MissionReward; readonly lines: readonly string[] }
  | { readonly ok: false; readonly reason: 'not-ready' | 'hold' | 'storage'; readonly text: string };

/** What a reward pays, as display lines. */
export function rewardLines(r: MissionReward): string[] {
  const out: string[] = [];
  if (r.marks > 0) out.push(`${r.marks} marks`);
  for (const e of r.resources) out.push(`${e.amount} ${resourceName(e.resource)}`);
  for (const m of r.modules) out.push(`${EQUIPMENT_BY_ID.get(m)?.name ?? m} (to storage)`);
  if (r.charts > 0) out.push(`Navigation data: charts ${r.charts} system${r.charts === 1 ? '' : 's'}`);
  for (const l of r.licences) out.push(`Upgrade licence ${l === 'mk2' ? 'Mk II' : 'Mk III'}`);
  return out;
}

/**
 * Turn a completed mission in: pays marks, resources (only if they all fit:
 * otherwise nothing is paid and the pilot is told how much room to make),
 * modules to storage, licences and navigation data (`charted` = systems the
 * caller adds to the navigation progress). Paid once: the id becomes claimed.
 */
export function claimReward(p: ProgressionState, id: string, w: Wallet, chartPick: (galaxy: string, n: number) => string[]): ClaimResult {
  const missions = markClaimed(p.missions, id);
  const def = missionDef(p.missions, id);
  if (!missions || !def) return { ok: false, reason: 'not-ready', text: 'Nothing to turn in.' };
  const r = def.rewards;
  const fit = rewardFits(w, r.resources);
  if (!fit.fits) return { ok: false, reason: 'hold', text: `MAKE ROOM: the reward needs ${fit.need} cargo units and the hold has ${fit.space} free. Sell or jettison cargo, then turn it in.` };
  let modules = w.modules;
  for (const m of r.modules) {
    const next = storeModule(modules, m);
    if (!next) return { ok: false, reason: 'storage', text: storedTotal(modules) >= MAX_STORED_MODULES ? 'MAKE ROOM: module storage is full. Fit or scrap a stored module first.' : 'MAKE ROOM: storage holds no more of that module.' };
    modules = next;
  }
  const hold = r.resources.length ? addLoot(w.hold, r.resources, w.holdCap).hold : w.hold;
  const charted = chartPick(def.galaxy || '', r.charts);
  const licences = [...p.licences, ...r.licences.filter((l) => !p.licences.includes(l))];
  return {
    ok: true,
    progression: { ...p, missions, marks: addMarks(p.marks, r.marks), licences },
    wallet: { ...w, marks: addMarks(w.marks, r.marks), hold, modules },
    charted,
    reward: r,
    lines: rewardLines(r),
  };
}

/* -------------------------------------------------------------- deliveries */

export type DeliveryResult =
  | { readonly ok: true; readonly hold: Readonly<Record<string, number>>; readonly event: GameEvent; readonly amount: number }
  | { readonly ok: false; readonly text: string };

/** Hand over as much of a delivery as the hold carries (docked at the target station). */
export function deliver(p: ProgressionState, id: string, station: string, hold: Readonly<Record<string, number>>): DeliveryResult {
  const need = deliveryNeed(p.missions, id);
  if (!need || need.left <= 0) return { ok: false, text: 'Nothing to deliver.' };
  if (need.station !== station) return { ok: false, text: 'Deliver it at the station the mission names.' };
  const amount = Math.min(need.left, hold[need.resource] ?? 0);
  if (amount <= 0) return { ok: false, text: `No ${resourceName(need.resource)} in the hold.` };
  const next = removeLoot(hold, [{ resource: need.resource, amount }]);
  if (!next) return { ok: false, text: 'Nothing to deliver.' };
  return { ok: true, hold: next, amount, event: { type: 'delivered', missionId: id, systemId: station, resource: need.resource, amount } };
}

/* ---------------------------------------------------------------- upgrades */

export interface UpgradeQuote {
  readonly quote: Quote;
  readonly levels: UpgradeLevels | null;
}

/** Quote the next level of an upgrade track: cost, licence and the stat changes it makes. */
export function quoteUpgrade(w: Wallet, ship: ShipId, loadout: Loadout | undefined, levels: UpgradeLevels, track: string, licences: readonly string[]): UpgradeQuote {
  const check = checkUpgrade(ship, levels, track, { marks: w.marks, hold: w.hold }, licences);
  const def = check.track ? UPGRADE_BY_TRACK.get(check.track) : undefined;
  if (!def || check.to === 0) {
    const why = check.reason === 'incompatible' ? `${SHIP_BY_ID.get(ship)?.name ?? 'This ship'} cannot take ${def?.name.toLowerCase() ?? 'it'}.` : check.reason === 'max' ? 'Fully upgraded for this ship.' : 'Unknown upgrade.';
    return { quote: { ok: false, lines: [], reason: why }, levels: null };
  }
  const next: UpgradeLevels = { ...levels, [def.id]: check.to };
  const a = upgradedShip(ship, loadout, levels);
  const b = upgradedShip(ship, loadout, next);
  const lines: QuoteLine[] = [{ label: 'Marks', before: String(w.marks), after: String(w.marks - check.cost!.marks) }];
  for (const m of check.cost!.materials) lines.push({ label: resourceName(m.resource), before: String(w.hold[m.resource] ?? 0), after: String((w.hold[m.resource] ?? 0) - m.amount) });
  for (const k of COMPARE_KEYS) if (Math.abs(a.stats[k] - b.stats[k]) > 1e-9) lines.push({ label: STAT_INFO[k].label, before: formatStat(k, a.stats[k]), after: formatStat(k, b.stats[k]) });
  if (a.weapon.cooldownTicks !== b.weapon.cooldownTicks) lines.push({ label: 'Fire interval', before: `${(a.weapon.cooldownTicks / 60).toFixed(2)} s`, after: `${(b.weapon.cooldownTicks / 60).toFixed(2)} s` });
  if (a.weapon.shotSpeed !== b.weapon.shotSpeed) lines.push({ label: 'Bolt speed', before: String(a.weapon.shotSpeed), after: String(b.weapon.shotSpeed) });
  const title = `${def.name} ${LEVEL_NAME(check.to)}`;
  if (!check.ok) {
    const reason =
      check.reason === 'licence'
        ? `Needs the ${check.licence === 'mk2' ? 'Mk II' : 'Mk III'} upgrade licence (story missions).`
        : check.reason === 'marks'
          ? `Needs ${check.cost!.marks} marks; you have ${w.marks}.`
          : `Missing ${check.missing.map((m) => `${m.amount} ${resourceName(m.resource)}`).join(', ')}.`;
    return { quote: { ok: false, lines, reason }, levels: null };
  }
  const hold = removeLoot(w.hold, check.cost!.materials);
  if (!hold) return { quote: { ok: false, lines, reason: 'Missing materials.' }, levels: null };
  return { quote: { ok: true, lines, result: { ...w, marks: w.marks - check.cost!.marks, hold }, summary: `Install ${title} on the ${SHIP_BY_ID.get(ship)!.name}.` }, levels: next };
}

/* ------------------------------------------------------------------- ships */

/** Quote acquiring a ship (licence + cargo price, ships/hangar.ts); lines show the price and how it compares with the flown ship. */
export function quoteShip(w: Wallet, fleet: FleetState, id: ShipId, licenceMet: LicenceCheck): { readonly quote: Quote; readonly fleet: FleetState | null } {
  const ship = SHIP_BY_ID.get(id);
  if (!ship) return { quote: { ok: false, lines: [], reason: 'Unknown ship.' }, fleet: null };
  const lines: QuoteLine[] = ship.cost.map((c) => ({ label: resourceName(c.resource), before: String(w.hold[c.resource] ?? 0), after: String((w.hold[c.resource] ?? 0) - c.amount) }));
  for (const row of compareStats(fleet, id).filter((r) => r.delta !== 0).slice(0, 4)) lines.push({ label: row.label, before: formatStat(row.key, row.current), after: formatStat(row.key, row.value) });
  const res = acquireShip(fleet, w.hold, id, licenceMet);
  if (!res.ok) {
    const reason = res.reason === 'owned' ? 'Already in your fleet.' : res.reason === 'locked' ? 'Licence not earned yet (see the hangar).' : res.reason === 'unaffordable' ? 'Not enough cargo to pay for it.' : 'Unknown ship.';
    return { quote: { ok: false, lines, reason }, fleet: null };
  }
  return { quote: { ok: true, lines, result: { ...w, hold: res.cargo }, summary: `Acquire the ${ship.name}; switch to it from the hangar.` }, fleet: res.fleet };
}

/* ------------------------------------------------------------- free cells */

/** R1 as a hold change: free cells added (bounded by the free hold space). */
export function grantCells(hold: Readonly<Record<string, number>>, holdCap: number, n: number): { readonly hold: Readonly<Record<string, number>>; readonly added: number } {
  if (n <= 0) return { hold, added: 0 };
  const r = addLoot(hold, [{ resource: FUEL.resource, amount: n }], holdCap);
  return { hold: r.hold, added: r.taken.reduce((a, e) => a + e.amount, 0) };
}
