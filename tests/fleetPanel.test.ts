/**
 * P11.2 Fleet Command UI (docs/freeroam/FLEET_COMMAND.md "Fleet panel"): the panel's view model
 * against the real kit (prices, refusals, captain moves, orders and the Attack target), the flight
 * HUD line, the station tab, and the balance review: escort pricing against the Hangar, and a
 * deterministic skirmish comparison on the real sector simulation (no fleet, 1 and 3 escorts, each
 * order, a disabled escort, high heat, Gravity Shadow and Silent Running).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import * as Kit from '../src/modes/freeroam/fleet/fleetKit.ts';
import { FLEET_COMMAND, NO_VESSELS, vesselNo, wingSummary, type FleetUnit, type Vessels, type VesselSpec } from '../src/modes/freeroam/fleet/vessels.ts';
import type { RequirementInfo } from '../src/modes/freeroam/galaxy/progress.ts';
import { formatMarks } from '../src/modes/freeroam/progression/ledger.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { forceCritical } from '../src/modes/freeroam/combat/critical.ts';
import { createSectorRun, RUN, shipTuning, stepSector, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import { acquireShip, missingFor, selectShip, STARTER_FLEET } from '../src/modes/freeroam/ships/hangar.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import type { ResourceCost, ShipId } from '../src/modes/freeroam/ships/types.ts';
import { upgradedShip } from '../src/modes/freeroam/ships/upgrades.ts';
import { crewRows, fleetHead, hullRows, hullsNotBuilt, orderChoices, vesselName, vesselRows, type FleetContext, type FleetFlight } from '../src/modes/freeroam/ui/fleetView.ts';
import { backFrom, STATION_TABS, stationOverview, TAB_LABEL } from '../src/modes/freeroam/ui/stationModel.ts';
import { arena } from './helpers/combatProbe.ts';

const MAREN = 'maren-sato';
const TOBIAH = 'tobiah-renn';
const ODILE = 'odile-marchetti';
const ILAN = 'ilan-sefton';
const NAMES: Record<string, string> = { [MAREN]: 'Maren Sato', [TOBIAH]: 'Tobiah Renn', [ODILE]: 'Odile Marchetti', [ILAN]: 'Ilan Sefton' };
const RICH: Record<string, number> = { scrap: 99, fuel: 99, alloy: 99, ice: 99, crystal: 99 };

const world = (o: Partial<Kit.PurchaseWorld> & { cargo?: Record<string, number>; seats?: Record<string, string[]> } = {}): Kit.PurchaseWorld => {
  const cargo = o.cargo ?? RICH;
  return {
    docked: 'milky-way/sol',
    safe: true,
    admin: false,
    crew: { hired: [MAREN, TOBIAH, ODILE, ILAN], seats: o.seats ?? {} },
    knownCrew: (id) => id in NAMES,
    marks: 5000,
    short: (c: readonly ResourceCost[]) => missingFor(c, cargo),
    licenceMet: () => true,
    ...o,
  };
};
const describeReq = (met: boolean) => (): RequirementInfo => ({ title: 'Test licence', detail: '', met, progress: null, parts: [] });
const ctx = (vessels: Vessels = NO_VESSELS, o: Partial<FleetContext> = {}): FleetContext => ({
  kit: Kit,
  vessels,
  world: world(),
  flight: null,
  crewName: (id) => NAMES[id] ?? id,
  crewRole: () => 'Pilot',
  describe: describeReq(true),
  ...o,
});
const buy = (v: Vessels, ship: string, captain: string, w = world()): Vessels => {
  const r = Kit.purchase(v, ship, captain, w);
  if (!r.ok) throw new Error(`purchase refused: ${r.reason}`);
  return r.vessels;
};
const spec = (vessel: string, ship: ShipId, captain: string): VesselSpec => {
  const d = upgradedShip(ship, undefined, {});
  return { vessel, ship, captain, stats: d.stats, weapon: d.weapon, radius: d.radius, sprite: d.sprite, tune: shipTuning(d) };
};
const body = (x: number, y: number, r: number): Landmark => ({ id: 'body-t', kind: 'body', style: 'gas', x, y, r, hazardR: 0, label: 'Test body' });
function arenaAt(bodies: readonly Landmark[] = []): { L: SectorLayout; cx: number; cy: number } {
  const base = arena(3);
  const cx = base.arrival.x < base.width / 2 ? base.width - 1500 : 1500;
  const cy = base.arrival.y < base.height / 2 ? base.height - 1500 : 1500;
  return { L: { ...base, landmarks: bodies.map((b) => ({ ...b, x: b.x + cx, y: b.y + cy })) }, cx, cy };
}
const foe = (r: SectorRun, x: number, y: number, faction: 'red-tally' | 'gleaners' = 'red-tally', family: 'raider' | 'hauler' = 'raider'): Agent => {
  const a = spawnAgent(r, family, faction, 'test', 'guard', x, y);
  if (!a) throw new Error('spawn refused');
  return a;
};
const flightOf = (r: SectorRun): FleetFlight => {
  const t = r.shipLock.target;
  return { units: r.wing?.units ?? [], target: t, targetName: t === null ? null : 'RED TALLY RAIDER', attack: Kit.attackRefusal(r, t) };
};

/* ------------------------------------------------------------ purchase rows */

describe('P11.2 Fleet panel view model: hulls and prices (the kit\'s own numbers)', () => {
  it('lists every sold archetype with the kit\'s price, materials and licence; recovered unique hulls are named, never priced', () => {
    const rows = hullRows(ctx());
    expect(rows.map((h) => h.ship)).toEqual(SHIPS.filter((s) => Kit.hullPrice(s.id)).map((s) => s.id));
    expect(rows).toHaveLength(8);
    for (const h of rows) {
      const p = Kit.hullPrice(h.ship)!;
      expect(h.marks).toBe(p.marks);
      expect(h.cost).toContain(formatMarks(p.marks)); // the shown commission is the computed one, never text
      for (const m of p.cargo) expect(h.cost).toContain(String(m.amount));
      expect(h.name).toBe(SHIP_BY_ID.get(h.ship)!.name.toUpperCase());
      expect(h.description).toBe(SHIP_BY_ID.get(h.ship)!.description);
      expect(h.refusal).toBeNull();
    }
    expect(hullsNotBuilt(ctx()).sort()).toEqual(['Heron', 'Raven']);
  });

  it('every hull refusal is the kit\'s (hullRefusal + refusalText): station, safety, Admin, licence, materials, marks, cap', () => {
    const cases: [Partial<Kit.PurchaseWorld> & { cargo?: Record<string, number> }, Kit.CommandRefusal][] = [
      [{ docked: null }, 'not-docked'],
      [{ safe: false }, 'unsafe'],
      [{ admin: true }, 'admin'],
      [{ licenceMet: () => false }, 'locked'],
      [{ cargo: {} }, 'materials'],
      [{ marks: 0 }, 'marks'],
    ];
    for (const [o, want] of cases) {
      const h = hullRows(ctx(NO_VESSELS, { world: world(o) })).find((x) => x.ship === 'condor')!;
      expect(h.refusal, want).toBe(want);
      expect(h.why).toBe(Kit.refusalText(want));
      expect(h.refusal).toBe(Kit.purchaseRefusal(NO_VESSELS, 'condor', ODILE, world(o)));
    }
    // the Petrel has no catalogue cost: its fleet hull is the commission alone, never free
    expect(hullRows(ctx(NO_VESSELS, { world: world({ cargo: {} }) })).find((x) => x.ship === 'petrel')!.refusal).toBeNull();
    let v = buy(NO_VESSELS, 'swift', MAREN);
    v = buy(v, 'crane', TOBIAH);
    v = buy(v, 'harrier', ODILE);
    expect(hullRows(ctx(v)).every((h) => h.refusal === 'full' && h.why === Kit.refusalText('full'))).toBe(true);
    expect(fleetHead(ctx(v), FLEET_COMMAND.maxVessels)).toBe(`FLEET 3 / 3 · 3 CAPTAINS · ${formatMarks(5000)}`);
  });

  it('licence wording comes from the shell\'s describeRequirement (met or not yet)', () => {
    const shrike = SHIP_BY_ID.get('shrike')!;
    expect(shrike.licence.length).toBeGreaterThan(0);
    expect(hullRows(ctx()).find((h) => h.ship === 'shrike')!.licence).toBe('LICENCE: Test licence ✓');
    expect(hullRows(ctx(NO_VESSELS, { describe: describeReq(false) })).find((h) => h.ship === 'shrike')!.licence).toBe('LICENCE: Test licence (NOT YET)');
    expect(hullRows(ctx()).find((h) => h.ship === 'petrel')!.licence).toBe('NO LICENCE NEEDED');
  });
});

/* ------------------------------------------------------------ captains */

describe('P11.2 Fleet panel view model: captain candidates (the kit\'s captain rules)', () => {
  it('for a new hull: free crew are eligible; a seated advisor and a sitting captain are marked with the kit\'s reason and where', () => {
    const v = buy(NO_VESSELS, 'swift', MAREN);
    const rows = crewRows(ctx(v, { world: world({ seats: { petrel: [TOBIAH] } }) }), null);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[ODILE]!.refusal).toBeNull();
    expect(by[ILAN]!.refusal).toBeNull();
    expect(by[TOBIAH]!.refusal).toBe('seated');
    expect(by[TOBIAH]!.why).toContain(Kit.refusalText('seated'));
    expect(by[TOBIAH]!.why).toContain('Petrel');
    expect(by[MAREN]!.refusal).toBe('captain');
    expect(by[MAREN]!.why).toContain('SWIFT · ESCORT 1');
    for (const r of rows) expect(r.refusal).toBe(Kit.captainRefusal(v, r.id, world({ seats: { petrel: [TOBIAH] } })));
  });

  it('only recruited crew are candidates (an unrecruited crew member is never offered)', () => {
    const rows = crewRows(ctx(NO_VESSELS, { world: world({ crew: { hired: [MAREN], seats: {} } }) }), null);
    expect(rows.map((r) => r.id)).toEqual([MAREN]);
    expect(Kit.purchaseRefusal(NO_VESSELS, 'swift', ODILE, world({ crew: { hired: [MAREN], seats: {} } }))).toBe('not-hired');
  });

  it('for an owned vessel: a move from another vessel and a replaced captain are known before anything changes (dry run)', () => {
    let v = buy(NO_VESSELS, 'swift', MAREN);
    v = buy(v, 'crane', TOBIAH);
    const before = JSON.stringify(v);
    const rows = Object.fromEntries(crewRows(ctx(v), 'fv-1').map((r) => [r.id, r]));
    expect(rows[MAREN]).toMatchObject({ refusal: 'same', why: 'Already captains this vessel.' });
    expect(rows[TOBIAH]).toMatchObject({ refusal: null, moveFrom: 'CRANE · ESCORT 2', replaces: 'Maren Sato' });
    expect(rows[ODILE]).toMatchObject({ refusal: null, moveFrom: null, replaces: 'Maren Sato' });
    expect(JSON.stringify(v)).toBe(before); // nothing changed: the panel only reads
    // an uncrewed vessel: no replacement, so a free crew member is unambiguous
    const r = Kit.releaseCaptain(v, 'fv-1', world());
    expect(r.ok).toBe(true);
    const free = crewRows(ctx(r.ok ? r.vessels : v), 'fv-1').find((x) => x.id === ODILE)!;
    expect(free).toMatchObject({ refusal: null, moveFrom: null, replaces: null });
  });

  it('docked-only changes are refused in flight with the kit\'s reason', () => {
    const v = buy(NO_VESSELS, 'swift', MAREN);
    const rows = crewRows(ctx(v, { world: world({ docked: null }) }), 'fv-1');
    expect(rows.every((x) => x.refusal === 'not-docked' || x.refusal === 'same')).toBe(true);
  });
});

/* ------------------------------------------------------------ vessels + orders */

describe('P11.2 Fleet panel view model: vessel states and orders', () => {
  it('docked states are only the model\'s: available, uncrewed, out of service, disabled', () => {
    const v: Vessels = {
      seq: 4,
      list: [
        { id: 'fv-1', ship: 'swift', captain: MAREN, status: 'active' },
        { id: 'fv-2', ship: 'crane', captain: null, status: 'active' },
        { id: 'fv-3', ship: 'condor', captain: TOBIAH, status: 'reserve' },
        { id: 'fv-4', ship: 'shrike', captain: ODILE, status: 'disabled' },
      ],
      holds: {},
    };
    const rows = vesselRows(ctx(v));
    expect(rows.map((r) => r.state)).toEqual(['ready', 'uncrewed', 'reserve', 'disabled']);
    expect(rows.map((r) => r.name)).toEqual(['SWIFT · ESCORT 1', 'CRANE · ESCORT 2', 'CONDOR · ESCORT 3', 'SHRIKE · ESCORT 4']);
    expect(rows[0]!.captainText).toBe('CAPTAIN MAREN SATO');
    expect(rows[1]!.captainText).toBe('NO CAPTAIN');
    expect(rows.every((r) => r.hull === null)).toBe(true); // no unit, no invented hull numbers
  });

  it('in flight: deployed units show hull, shield and order; identity follows the vessel id, not the list position', () => {
    const { L, cx, cy } = arenaAt();
    const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5, ship: deriveShip('petrel') });
    Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy });
    // vessels fv-2 and fv-5 (fv-1, 3, 4 were never issued or were trimmed): slots are 1 and 2, names keep the id's number
    const v: Vessels = { seq: 5, list: [{ id: 'fv-2', ship: 'shrike', captain: MAREN, status: 'active' }, { id: 'fv-5', ship: 'swift', captain: TOBIAH, status: 'active' }], holds: {} };
    Kit.deploy(r, Kit, [spec('fv-2', 'shrike', MAREN), spec('fv-5', 'swift', TOBIAH)], RUN.heat);
    const rows = vesselRows(ctx(v, { flight: flightOf(r), world: world({ docked: null }) }));
    expect(rows.map((x) => [x.name, x.state, x.order])).toEqual([
      ['SHRIKE · ESCORT 2', 'flying', 'FOLLOW'],
      ['SWIFT · ESCORT 5', 'flying', 'FOLLOW'],
    ]);
    expect(rows[0]!.hull).toBe(`HULL ${SHIP_BY_ID.get('shrike')!.base.hull} / ${SHIP_BY_ID.get('shrike')!.base.hull} · SHIELD ${SHIP_BY_ID.get('shrike')!.base.shield} / ${SHIP_BY_ID.get('shrike')!.base.shield}`);
    expect(r.wing!.units.map((u) => vesselNo(u.spec.vessel))).toEqual(['2', '5']);
    // a disabled unit shows disabled, and its orders are refused with the kit's words
    const u = r.wing!.units[0]!;
    Kit.blastHit(r, 'red-tally', u.ship.x, u.ship.y, 1, u.hull + u.shield + 1, []);
    expect(u.state).toBe('disabled');
    const c = ctx(v, { flight: flightOf(r) });
    expect(vesselRows(c)[0]!.state).toBe('disabled');
    expect(orderChoices(c, 'fv-2').every((o) => o.why === Kit.orderRefusalText('disabled'))).toBe(true);
    // 'all' skips the disabled vessel (the kit's issueOrder does the same)
    expect(orderChoices(c, 'all').filter((o) => o.kind !== 'attack').every((o) => o.why === null)).toBe(true);
    expect(Kit.issueOrder(r, 'all', { kind: 'hold' })).toEqual({ ok: true, vessels: ['fv-5'] });
    expect(wingSummary(r.wing!.units)).toBe('ESCORTS · 2 DISABLED · 5 HOLD');
  });

  it('Attack uses the pilot\'s own lock: no lock, a non-hostile and a destroyed target are refused with the kit\'s reason', () => {
    const { L, cx, cy } = arenaAt();
    const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5, ship: deriveShip('petrel') });
    Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy });
    Kit.deploy(r, Kit, [spec('fv-1', 'shrike', MAREN)], RUN.heat);
    const v = buy(NO_VESSELS, 'shrike', MAREN);
    const attack = (): string | null => orderChoices(ctx(v, { flight: flightOf(r) }), 'fv-1').find((o) => o.kind === 'attack')!.why;
    expect(attack()).toBe(Kit.orderRefusalText('invalid-target')); // no lock
    const g = foe(r, cx + 300, cy, 'gleaners', 'hauler');
    r.shipLock.target = g.id;
    expect(attack()).toBe(Kit.orderRefusalText('not-hostile'));
    const a = foe(r, cx - 300, cy);
    r.shipLock.target = a.id;
    expect(attack()).toBeNull();
    const ok = Kit.issueOrder(r, 'fv-1', { kind: 'attack', target: r.shipLock.target });
    expect(ok.ok).toBe(true);
    expect(vesselRows(ctx(v, { flight: flightOf(r) }))[0]!.order).toBe('ATTACK · RED TALLY RAIDER');
    a.state = 'destroyed';
    expect(attack()).toBe(Kit.orderRefusalText('destroyed'));
    // no wing at all
    const r2 = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5, ship: deriveShip('petrel') });
    expect(orderChoices(ctx(v, { flight: flightOf(r2) }), 'all').every((o) => o.why === Kit.orderRefusalText('no-wing'))).toBe(true);
  });

  it('every order refusal code has plain words (never the code itself)', () => {
    const codes: Kit.OrderRefusal[] = ['no-wing', 'unknown-vessel', 'disabled', 'player', 'friendly', 'station', 'invalid-target', 'destroyed', 'not-hostile', 'invalid-order'];
    for (const c of codes) {
      const t = Kit.orderRefusalText(c);
      expect(t.length, c).toBeGreaterThan(10);
      if (c.includes('-')) expect(t, c).not.toContain(c);
      expect(t, c).not.toBe(c);
    }
  });

  it('wingSummary: one word when all agree, else each vessel number with its word; empty without units', () => {
    const u = (vessel: string, state: FleetUnit['state'], kind: 'follow' | 'defend'): Pick<FleetUnit, 'state' | 'order' | 'spec'> => ({ state, order: { kind }, spec: { vessel } as VesselSpec });
    expect(wingSummary([])).toBe('');
    expect(wingSummary([u('fv-1', 'active', 'follow'), u('fv-3', 'active', 'follow')])).toBe('ESCORTS 2 · FOLLOW');
    expect(wingSummary([u('fv-1', 'active', 'defend'), u('fv-3', 'disabled', 'defend')])).toBe('ESCORTS · 1 DEFEND · 3 DISABLED');
    expect(vesselName({ id: 'fv-12', ship: 'crane' })).toBe('CRANE · ESCORT 12');
  });
});

/* ------------------------------------------------------------ station tab */

describe('P11.2 station tab', () => {
  it('FLEET is a station tab after ARMORY (STATION -> HANGAR -> ARMORY unchanged); its card counts escorts', () => {
    expect(STATION_TABS.slice(0, 4)).toEqual(['station', 'hangar', 'armory', 'fleet']);
    expect(TAB_LABEL.fleet).toBe('FLEET');
    expect(backFrom('fleet')).toBe('station');
    const base = { name: 'X', first: false, ship: 'Petrel', cells: 1, emergency: 0, marks: 0, ready: 0, active: 0, offers: 0, stored: 0 };
    expect(stationOverview(base).services.find((s) => s.tab === 'fleet')!.badge).toBe('');
    expect(stationOverview({ ...base, escorts: 2 }).services.find((s) => s.tab === 'fleet')!.badge).toBe('2 ESCORTS');
    expect(stationOverview({ ...base, escorts: 1 }).services.find((s) => s.tab === 'fleet')!.badge).toBe('1 ESCORT');
  });
});

/* ------------------------------------------------------------ balance review */

describe('P11.2 balance review', () => {
  it('an escort costs materially more than switching ships: the Hangar\'s own hull materials plus a commission of at least 100 marks', () => {
    for (const d of SHIPS) {
      const p = Kit.hullPrice(d.id);
      if (!p) continue;
      // buying the ship itself at the Hangar takes the same catalogue materials and no marks
      expect(p.cargo).toEqual(d.cost);
      const bought = acquireShip(STARTER_FLEET, RICH, d.id, () => true);
      if (d.id !== 'petrel') expect(bought.ok, d.id).toBe(true);
      expect(p.marks, d.id).toBeGreaterThanOrEqual(100);
      // switching to an owned ship is free (and keeps one hull); an escort is a second hull plus the commission
      expect(selectShip({ ...STARTER_FLEET, owned: ['petrel', d.id] }, d.id, true).ok || d.id === 'petrel').toBe(true);
    }
    // the commission scales with the hull: the heaviest material hull costs the most
    const marks = SHIPS.flatMap((d) => (Kit.hullPrice(d.id) ? [Kit.hullPrice(d.id)!.marks] : []));
    expect(Math.min(...marks)).toBe(100);
    expect(Math.max(...marks)).toBe(250);
  });

  interface Outcome {
    kills: number;
    firstKill: number | null;
    pilotHits: number;
    disabled: number;
    escortShots: number;
    /** Lowest escort shield and hull seen (fractions of the archetype's), over all units. */
    minShield: number;
    minHull: number;
  }
  const SPECS = [spec('fv-1', 'shrike', MAREN), spec('fv-2', 'condor', TOBIAH), spec('fv-3', 'swift', ODILE)];
  /**
   * One deterministic skirmish (seed 5, 30 s): the pilot sits still and never fires (so every kill
   * is the wing's), two Red Tally raiders 300 units ahead start out hunting the pilot. The pilot's
   * hull is refilled each tick and every hit on it counted.
   */
  function skirmish(n: number, o: { order?: 'follow' | 'defend' | 'hold' | 'attack'; disabled?: boolean; heat?: number; shadow?: boolean; silent?: boolean; family?: 'raider' | 'lancer'; count?: number; specs?: VesselSpec[] } = {}): Outcome {
    const { L, cx, cy } = arenaAt(o.shadow ? [body(0, -150, 90)] : []);
    const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5, ship: deriveShip('petrel'), heat: o.heat ? { v: { 'red-tally': o.heat }, calm: {} } : undefined });
    r.grace = 0;
    forceCritical(r, 'normal'); // Finale P1: the P11.2 review measures the ordinary damage model; criticals are measured in criticalHits.test.ts
    r.invuln = 0;
    Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0 });
    if (n) Kit.deploy(r, Kit, (o.specs ?? SPECS).slice(0, n), RUN.heat);
    if (o.silent) stepSector(r, { moveX: 0, moveY: 0, silentToggle: true });
    const count = o.count ?? 2;
    const foes = Array.from({ length: count }, (_, i) => {
      const a = spawnAgent(r, o.family ?? 'raider', 'red-tally', 'test', 'guard', cx + (i - (count - 1) / 2) * (count > 2 ? 130 : 280), cy - 300)!;
      a.target = 'player';
      return a;
    });
    if (o.disabled && r.wing) {
      const u = r.wing.units[0]!;
      Kit.blastHit(r, 'red-tally', u.ship.x, u.ship.y, 1, u.hull + u.shield + 1, []);
    }
    if (n && o.order) Kit.issueOrder(r, 'all', o.order === 'attack' ? { kind: 'attack', target: foes[0]!.id } : { kind: o.order });
    const out: Outcome = { kills: 0, firstKill: null, pilotHits: 0, disabled: 0, escortShots: 0, minShield: 1, minHull: 1 };
    const maxH = r.craft.stats.hull;
    const maxS = r.craft.stats.shield;
    let bolts = 0;
    for (let t = 0; t < 1800; t++) {
      r.hull = maxH;
      r.shield = maxS;
      stepSector(r, { moveX: 0, moveY: 0 });
      if (r.hull < maxH || r.shield < maxS) out.pilotHits += 1;
      const nb = r.wing?.bolts.length ?? 0;
      if (nb > bolts) out.escortShots += nb - bolts;
      bolts = nb;
      const k = foes.filter((a) => a.state === 'destroyed').length;
      if (k > out.kills && out.firstKill === null) out.firstKill = t;
      out.kills = k;
      for (const u of r.wing?.units ?? []) {
        out.minShield = Math.min(out.minShield, u.shield / u.spec.stats.shield);
        out.minHull = Math.min(out.minHull, u.hull / u.spec.stats.hull);
      }
    }
    out.disabled = r.wing?.units.filter((u) => u.state === 'disabled').length ?? 0;
    return out;
  }

  it('deterministic skirmish comparison: no fleet, 1 and 3 escorts, each order, disabled, high heat, Gravity Shadow, Silent Running', () => {
    const table: Record<string, Outcome> = {
      'no fleet': skirmish(0),
      '1 escort · follow': skirmish(1),
      '3 escorts · follow': skirmish(3),
      '3 escorts · defend': skirmish(3, { order: 'defend' }),
      '3 escorts · hold': skirmish(3, { order: 'hold' }),
      '3 escorts · attack': skirmish(3, { order: 'attack' }),
      '3 escorts · 1 disabled': skirmish(3, { disabled: true }),
      '3 escorts · high heat': skirmish(3, { heat: 90 }),
      '3 escorts · gravity shadow': skirmish(3, { shadow: true }),
      '3 escorts · silent running': skirmish(3, { silent: true }),
      'no fleet · silent running': skirmish(0, { silent: true }),
    };
    console.log(Object.entries(table).map(([k, v]) => `${k.padEnd(28)} kills ${v.kills} first ${v.firstKill ?? '—'} pilotHits ${v.pilotHits} escortShots ${v.escortShots} disabled ${v.disabled}`).join('\n'));
    const T = table;
    // determinism: the same skirmish twice is identical
    expect(skirmish(3, { order: 'defend' })).toEqual(T['3 escorts · defend']);
    // alone and passive the pilot destroys nothing and is hit; one escort clears the pair and takes the pressure off
    expect(T['no fleet']).toMatchObject({ kills: 0, escortShots: 0 });
    expect(T['no fleet']!.pilotHits).toBeGreaterThan(10);
    expect(T['1 escort · follow']!.kills).toBe(2);
    expect(T['1 escort · follow']!.pilotHits).toBeLessThan(T['no fleet']!.pilotHits);
    // three escorts kill sooner than one; a disabled escort is out of the fight (fewer shots, slower first kill)
    expect(T['3 escorts · follow']!.firstKill!).toBeLessThan(T['1 escort · follow']!.firstKill!);
    expect(T['3 escorts · 1 disabled']!.disabled).toBe(1);
    expect(T['3 escorts · 1 disabled']!.escortShots).toBeLessThan(T['3 escorts · follow']!.escortShots);
    expect(T['3 escorts · 1 disabled']!.firstKill!).toBeGreaterThan(T['3 escorts · follow']!.firstKill!);
    // every order fights hostiles that hunt the pilot; Attack destroys its target
    for (const k of ['3 escorts · defend', '3 escorts · hold', '3 escorts · attack']) expect(T[k]!.kills, k).toBeGreaterThan(0);
    // Silent Running is not weakened: escorts hold fire in Follow, nothing is destroyed, the pilot stays unseen
    expect(T['3 escorts · silent running']).toMatchObject({ kills: 0, escortShots: 0 });
    expect(T['3 escorts · silent running']!.pilotHits).toBe(T['no fleet · silent running']!.pilotHits);
    // Gravity Shadow still hides the pilot with escorts flying (escorts fight only with their own line of sight)
    expect(T['3 escorts · gravity shadow']!.pilotHits).toBeLessThan(T['no fleet']!.pilotHits);
    // heat changes how far hostiles see and how long they search, not escort damage: the same fight here
    expect(T['3 escorts · high heat']!.kills).toBe(T['3 escorts · follow']!.kills);
  });

  it('escorts are not invulnerable: sustained fire drains shields and hull (no crew bonus, no free protection)', () => {
    const swift = skirmish(1, { family: 'lancer', count: 6, specs: [spec('fv-1', 'swift', MAREN)] });
    expect(swift.minShield).toBe(0);
    expect(swift.minHull).toBeLessThan(1);
    for (const ship of ['swift', 'shrike', 'condor'] as const) expect(skirmish(1, { family: 'lancer', count: 4, specs: [spec('fv-1', ship, MAREN)] }).minShield, ship).toBeLessThan(0.5);
  });
});

describe('P11.2 escort marker (sector/render.ts)', () => {
  it('the number label leaves the canvas at full opacity, so later drawing (waves, shots) is never faded by an escort', () => {
    const src = readFileSync(new URL('../src/modes/freeroam/sector/render.ts', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('for (const u of run.wing?.units ?? [])'), src.indexOf('for (const w of o.waves ?? [])'));
    expect(block).toMatch(/u\.spec\.vessel\.slice\(3\)/); // identity from the vessel id, not the list index
    expect(block).toMatch(/ctx\.restore\(\);\s*ctx\.globalAlpha = 1;\s*\}\s*$/);
  });
});
