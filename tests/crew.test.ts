/**
 * P05.1 Crew System Foundations: the model, ship capacity, assignment,
 * recruitment and its payment, persistence and migration, the read-only
 * view and the Bridge view model. Pure / in-memory: no browser.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import type { UnlockRequirement } from '../src/modes/freeroam/catalogue/types.ts';
import { ACTIVE_NOTE, bridgeModel, SOLO_NOTE, type BridgeContext } from '../src/modes/freeroam/crew/bridgeView.ts';
import { CREW, CREW_BY_ID, CREW_FEES, feeFor, MAX_HIRED, ROLE_DEFS } from '../src/modes/freeroam/crew/data.ts';
import { crewFromSaved, crewToSaved } from '../src/modes/freeroam/crew/persistence.ts';
import { distressBeaconsCleared, feeDue, hireTxId, recruitList, recruitState, signOn } from '../src/modes/freeroam/crew/recruit.ts';
import { assign, cleanCrew, crewAboard, dismiss, EMPTY_CREW, reconcileCrew, seatCount, shipOf, unassign, unassigned } from '../src/modes/freeroam/crew/state.ts';
import { ATTRIBUTE_SCALE, CREW_ATTRIBUTES, CREW_RANKS, CREW_ROLES, type CrewState, type CrewWorld } from '../src/modes/freeroam/crew/types.ts';
import { hasRole, memberWithRole, shipCrewView } from '../src/modes/freeroam/crew/view.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { EMPTY_PROFILE, FREEROAM_SPEC, FREEROAM_VERSION, withCrew, type FreeRoamProfile } from '../src/modes/freeroam/profile.ts';
import { ENTRY_KINDS, type Ledger } from '../src/modes/freeroam/progression/ledger.ts';
import { STORY_BY_ID } from '../src/modes/freeroam/progression/missionData.ts';
import { auditProfile } from '../src/modes/freeroam/saveAudit.ts';
import { loadSlot, saveSlot, slotKey } from '../src/modes/freeroam/saveSlots.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import type { ShipId } from '../src/modes/freeroam/ships/types.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const SOL = 'milky-way/sol';
const ledger = (balance: number): Ledger => ({ balance, seq: 0, history: [], recent: [] });
const world = (o: Partial<CrewWorld> = {}): CrewWorld => ({
  docked: SOL,
  safe: true,
  owned: ['petrel', 'swift', 'condor'],
  requirementMet: () => true,
  missionDone: () => true,
  rescues: 1,
  ...o,
});
const hiredState = (...ids: string[]): CrewState => ({ hired: ids, paid: [], seats: {} });
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};
const ctx = (o: Partial<BridgeContext> = {}): BridgeContext => ({
  ship: 'petrel',
  flown: 'petrel',
  crew: EMPTY_CREW,
  world: world(),
  balance: 500,
  free: false,
  describe: (req: UnlockRequirement) => ({ detail: `requirement ${req.kind}`, met: false, progress: req.kind === 'surveys' ? `0/${req.count}` : null }),
  stationName: (id) => getCatalogue().systems.find((s) => s.id === id)?.name ?? id,
  ...o,
});

/* ------------------------------------------------------------------ model */

describe('crew model (P05.1)', () => {
  it('defines the five roles, each with capability metadata only', () => {
    expect(ROLE_DEFS.map((r) => r.id)).toEqual([...CREW_ROLES]);
    expect(CREW_ROLES).toEqual(['navigator', 'surveyor', 'engineer', 'defence', 'quartermaster']);
    for (const r of ROLE_DEFS) {
      expect(r.label).toMatch(/^[A-Z ]+$/);
      expect(r.capabilities.length).toBeGreaterThan(0);
      // metadata: names, text and a stage; no numbers that could act as a bonus
      for (const c of r.capabilities) {
        expect(Object.keys(c).sort()).toEqual(['id', 'name', 'stage', 'text']);
        expect(['active', 'later']).toContain(c.stage);
        // P05.2: only the Navigator and the Surveyor have working duties; everything else stays planned and says so
        if (r.id !== 'navigator' && r.id !== 'surveyor') expect(c.stage).toBe('later');
        if (c.stage === 'later') expect(c.text).toMatch(/^Planned: /);
      }
      if (r.id === 'navigator' || r.id === 'surveyor') expect(r.capabilities.some((c) => c.stage === 'active')).toBe(true);
    }
  });

  it('keeps a small curated roster with stable, unique ids and original names', () => {
    expect(CREW.length).toBeGreaterThanOrEqual(5);
    expect(CREW.length).toBeLessThanOrEqual(MAX_HIRED);
    const ids = CREW.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(CREW.map((c) => c.name)).size).toBe(CREW.length);
    for (const c of CREW) {
      expect(c.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(c.bio.length).toBeGreaterThan(40);
      expect(CREW_RANKS).toContain(c.rank);
    }
    // every role is represented; Navigator and Surveyor (the next stage's roles) have two each
    for (const role of CREW_ROLES) expect(CREW.some((c) => c.role === role), role).toBe(true);
    expect(CREW.filter((c) => c.role === 'navigator').length).toBeGreaterThanOrEqual(2);
    expect(CREW.filter((c) => c.role === 'surveyor').length).toBeGreaterThanOrEqual(2);
    // names the project avoids (existing IP and the project's own list)
    for (const c of CREW) expect(c.name).not.toMatch(/viper|cobra|sidewinder|arwing|x-wing|ashen|syndicate|loom|shepard|garrus|kassad/i);
  });

  it('bounds every attribute to the documented 1..5 scale (whole numbers)', () => {
    expect(ATTRIBUTE_SCALE).toEqual({ min: 1, max: 5, typical: 3 });
    for (const c of CREW) {
      expect(Object.keys(c.attributes).sort()).toEqual([...CREW_ATTRIBUTES].sort());
      for (const k of CREW_ATTRIBUTES) {
        const v = c.attributes[k];
        expect(Number.isInteger(v), `${c.id}.${k}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(ATTRIBUTE_SCALE.min);
        expect(v).toBeLessThanOrEqual(ATTRIBUTE_SCALE.max);
      }
    }
  });

  it('places station recruits at real catalogue stations and story recruits after real story missions', () => {
    const systems = new Map(getCatalogue().systems.map((s) => [s.id, s]));
    for (const c of CREW) {
      if (c.source.kind === 'station') {
        const sys = systems.get(c.source.systemId);
        expect(sys, c.id).toBeDefined();
        expect(['gate-hub', 'relay-outpost'], `${c.id} waits at a system with a station`).toContain(sys!.sector.archetype);
        expect(sys!.encounters.factions, `${c.id}: a Haven Guild station`).toContain('haven-guild');
      }
      if (c.source.kind === 'mission') {
        expect(STORY_BY_ID.has(c.source.missionId), c.id).toBe(true);
        // the story mission that introduces them is also their requirement
        expect(c.requirements).toContainEqual({ kind: 'mission', missionId: c.source.missionId });
      }
      for (const r of c.requirements) if (r.kind === 'mission') expect(STORY_BY_ID.has(r.missionId), `${c.id} requires ${r.missionId}`).toBe(true);
    }
  });

  it('prices hires centrally: rank fees at stations, free for story and rescue recruits, inside the existing economy', () => {
    expect(CREW_FEES).toEqual({ cadet: 80, rated: 130, veteran: 220 });
    for (const c of CREW) {
      expect(c.fee, c.id).toBe(feeFor(c.source, c.rank));
      expect(c.fee).toBe(c.source.kind === 'station' ? CREW_FEES[c.rank] : 0);
      expect(Number.isSafeInteger(c.fee) && c.fee >= 0).toBe(true);
    }
    // below the Mk III upgrade tier (320+): crew are a choice, never a grind
    expect(Math.max(...CREW.map((c) => c.fee))).toBeLessThan(320);
    // at least one early recruit with no requirement (the pilot can find crew from the home port)
    expect(CREW.some((c) => c.requirements.length === 0 && c.source.kind === 'station' && c.source.systemId === SOL)).toBe(true);
  });

  it('adds a crew ledger kind for the berth fee (and no wage or upkeep kind)', () => {
    expect(ENTRY_KINDS).toContain('crew');
    expect(ENTRY_KINDS.join(' ')).not.toMatch(/wage|upkeep|salary/);
  });
});

/* --------------------------------------------------------------- capacity */

describe('ship crew capacity (P05.1)', () => {
  it('stores the seats in the ship roster with the agreed mapping', () => {
    const want: Record<ShipId, number> = { swift: 1, shrike: 1, petrel: 2, magpie: 2, condor: 3, albatross: 3 };
    for (const s of SHIPS) {
      expect(s.crewSeats, s.id).toBe(want[s.id]);
      expect(seatCount(s.id)).toBe(want[s.id]);
    }
  });
});

/* ------------------------------------------------------------- assignment */

describe('crew assignment (P05.1)', () => {
  const s0 = hiredState('maren-sato', 'odile-marchetti', 'brask-ottley', 'hesper-quaye');

  it('seats crew up to capacity and refuses the next one inside the operation itself', () => {
    let s = s0;
    for (const id of ['maren-sato', 'odile-marchetti']) {
      const r = assign(s, id, 'petrel', world());
      expect(r.ok).toBe(true);
      if (r.ok) s = r.state;
    }
    expect(crewAboard(s, 'petrel')).toEqual(['maren-sato', 'odile-marchetti']);
    const full = assign(s, 'brask-ottley', 'petrel', world());
    expect(full).toEqual({ ok: false, reason: 'full' });
    // a forged over-capacity seat list never survives the invariant check either
    const forged = cleanCrew({ ...s, seats: { petrel: ['maren-sato', 'odile-marchetti', 'brask-ottley'] } }, ['petrel']);
    expect(crewAboard(forged.state, 'petrel')).toHaveLength(2);
    expect(forged.unseated).toEqual(['brask-ottley']);
    expect(forged.state.hired).toContain('brask-ottley'); // never deleted
  });

  it('never seats one person twice: re-assigning is refused, assigning elsewhere moves them', () => {
    const a = assign(s0, 'maren-sato', 'petrel', world());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(assign(a.state, 'maren-sato', 'petrel', world())).toEqual({ ok: false, reason: 'already' });
    const moved = assign(a.state, 'maren-sato', 'condor', world());
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.moved).toBe('petrel');
    expect(crewAboard(moved.state, 'petrel')).toEqual([]);
    expect(crewAboard(moved.state, 'condor')).toEqual(['maren-sato']);
    expect(shipOf(moved.state, 'maren-sato')).toBe('condor');
  });

  it('refuses unowned ships, unhired crew, unknown ids and unsafe moments, with a reason', () => {
    expect(assign(s0, 'maren-sato', 'albatross', world())).toEqual({ ok: false, reason: 'not-owned' });
    expect(assign(s0, 'tobiah-renn', 'petrel', world())).toEqual({ ok: false, reason: 'not-hired' });
    expect(assign(s0, 'nobody', 'petrel', world())).toEqual({ ok: false, reason: 'unknown' });
    expect(assign(s0, 'maren-sato', 'petrel', world({ safe: false }))).toEqual({ ok: false, reason: 'unsafe' });
    expect(unassign(s0, 'maren-sato', world())).toEqual({ ok: false, reason: 'not-seated' });
  });

  it('unassigning returns the member to the roster; dismissing ends the contract and keeps the paid fee', () => {
    const a = assign({ ...s0, paid: ['maren-sato'] }, 'maren-sato', 'swift', world());
    if (!a.ok) throw new Error('assign');
    const u = unassign(a.state, 'maren-sato', world());
    expect(u.ok && u.state.hired.includes('maren-sato') && unassigned(u.state).includes('maren-sato')).toBe(true);
    expect(unassign(a.state, 'maren-sato', world({ safe: false }))).toEqual({ ok: false, reason: 'unsafe' });
    const d = dismiss(a.state, 'maren-sato', world());
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.state.hired).not.toContain('maren-sato');
    expect(shipOf(d.state, 'maren-sato')).toBeNull();
    expect(d.state.paid).toContain('maren-sato');
    expect(dismiss(d.state, 'maren-sato', world())).toEqual({ ok: false, reason: 'not-hired' });
  });

  it('keeps each ship’s crew aboard that ship: switching to a smaller ship deletes no one', () => {
    let s = s0;
    for (const id of ['maren-sato', 'odile-marchetti', 'brask-ottley']) {
      const r = assign(s, id, 'condor', world());
      if (r.ok) s = r.state;
    }
    // flying the one-seat Swift now: its own bridge is empty, the Condor crew stay hired and seated there
    expect(shipCrewView(s, 'swift').members).toEqual([]);
    expect(shipCrewView(s, 'condor').members.map((m) => m.id)).toEqual(['maren-sato', 'odile-marchetti', 'brask-ottley']);
    // moving one across respects the Swift's single seat
    const m1 = assign(s, 'maren-sato', 'swift', world());
    if (!m1.ok) throw new Error('move');
    expect(assign(m1.state, 'odile-marchetti', 'swift', world())).toEqual({ ok: false, reason: 'full' });
    // a ship no longer in the fleet releases its crew to the roster (never deleted)
    const lost = reconcileCrew(m1.state, ['petrel', 'swift']);
    expect(lost.state.hired).toEqual(s0.hired);
    expect(crewAboard(lost.state, 'condor')).toEqual([]);
    expect(unassigned(lost.state).sort()).toEqual(['brask-ottley', 'hesper-quaye', 'odile-marchetti']);
    // a clean state reconciles to the same object (no churn)
    expect(reconcileCrew(m1.state, ['petrel', 'swift', 'condor']).state).toBe(m1.state);
  });

  it('cleanCrew is safe on hostile input and idempotent', () => {
    const r = cleanCrew(
      {
        hired: ['maren-sato', 'maren-sato', 'ghost', 'odile-marchetti', ...CREW.map((c) => c.id)],
        paid: ['ghost', 'maren-sato', 'maren-sato'],
        seats: { petrel: ['odile-marchetti', 'ghost', 'odile-marchetti'], swift: ['odile-marchetti', 'maren-sato'], unknown: ['maren-sato'], albatross: ['brask-ottley'] },
      },
      ['petrel', 'swift'],
    );
    expect(new Set(r.state.hired).size).toBe(r.state.hired.length);
    expect(r.state.hired.length).toBeLessThanOrEqual(MAX_HIRED);
    expect(r.state.hired).not.toContain('ghost');
    expect(r.state.paid).toEqual(['maren-sato']);
    expect(r.state.seats).toEqual({ petrel: ['odile-marchetti'], swift: ['maren-sato'] });
    expect(r.changes).toBeGreaterThan(0);
    const again = cleanCrew(r.state, ['petrel', 'swift']);
    expect(again.changes).toBe(0);
    expect(again.state).toEqual(r.state);
  });
});

/* ------------------------------------------------------------ recruitment */

describe('crew recruitment (P05.1)', () => {
  it('derives each recruit’s state from the world: here, elsewhere, undocked, locked, hired', () => {
    const maren = CREW_BY_ID.get('maren-sato')!;
    const odile = CREW_BY_ID.get('odile-marchetti')!;
    expect(recruitState(maren, EMPTY_CREW, world())).toBe('here');
    expect(recruitState(odile, EMPTY_CREW, world())).toBe('elsewhere');
    expect(recruitState(maren, EMPTY_CREW, world({ docked: null }))).toBe('undocked');
    expect(recruitState(odile, EMPTY_CREW, world({ requirementMet: () => false }))).toBe('locked');
    expect(recruitState(maren, hiredState('maren-sato'), world())).toBe('hired');
    // story and rescue recruits sign on at any station once earned
    const tobiah = CREW_BY_ID.get('tobiah-renn')!;
    expect(recruitState(tobiah, EMPTY_CREW, world({ docked: 'milky-way/kestrel-verge' }))).toBe('here');
    expect(recruitState(tobiah, EMPTY_CREW, world({ missionDone: () => false }))).toBe('locked');
    expect(recruitState(CREW_BY_ID.get('brask-ottley')!, EMPTY_CREW, world({ rescues: 0 }))).toBe('locked');
  });

  it('lists recruits in a stable order (here first, then roster order): never shuffled', () => {
    const a = recruitList(EMPTY_CREW, world()).map((r) => r.def.id);
    const b = recruitList(EMPTY_CREW, world()).map((r) => r.def.id);
    expect(a).toEqual(b);
    expect(a[0]).toBe('maren-sato');
    expect(recruitList(hiredState(...CREW.map((c) => c.id)), world())).toEqual([]);
  });

  it('charges the berth fee once through the ledger (kind crew, fresh id) and adds the member unassigned', () => {
    const r = signOn(EMPTY_CREW, ledger(500), 'maren-sato', world());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.charged).toBe(130);
    expect(r.ledger.balance).toBe(370);
    const e = r.ledger.history.at(-1)!;
    expect(e).toMatchObject({ kind: 'crew', delta: -130, balance: 370 });
    expect(e.label).toContain('Maren Sato');
    expect(r.ledger.recent.at(-1)).toBe('crew:hire:maren-sato:1');
    // the transaction id fits the save's ledger id pattern (profile.ts LEDGER_ID)
    expect(hireTxId('maren-sato', ledger(0))).toMatch(/^[a-z]+:[a-z0-9:#/.-]{1,90}$/);
    expect(r.state.hired).toEqual(['maren-sato']);
    expect(r.state.paid).toEqual(['maren-sato']);
    expect(r.state.seats).toEqual({});
    // a second hire of the same person is refused and charges nothing
    const again = signOn(r.state, r.ledger, 'maren-sato', world());
    expect(again).toMatchObject({ ok: false, reason: 'hired' });
    expect(again.ledger).toBe(r.ledger);
  });

  it('never lets the balance go negative: an unaffordable hire changes nothing', () => {
    const l = ledger(129);
    const r = signOn(EMPTY_CREW, l, 'maren-sato', world());
    expect(r).toMatchObject({ ok: false, reason: 'insufficient', refunded: false });
    expect(r.ledger).toBe(l);
  });

  it('refuses locked, elsewhere and undocked hires before any marks are touched', () => {
    const l = ledger(1000);
    expect(signOn(EMPTY_CREW, l, 'odile-marchetti', world({ requirementMet: () => false }))).toMatchObject({ ok: false, reason: 'locked' });
    expect(signOn(EMPTY_CREW, l, 'odile-marchetti', world())).toMatchObject({ ok: false, reason: 'elsewhere' });
    expect(signOn(EMPTY_CREW, l, 'maren-sato', world({ docked: null }))).toMatchObject({ ok: false, reason: 'undocked' });
    expect(signOn(EMPTY_CREW, l, 'nobody', world())).toMatchObject({ ok: false, reason: 'unknown' });
    // the roster bound is a save-size guard larger than the curated roster: it never blocks a real hire
    expect(MAX_HIRED).toBeGreaterThanOrEqual(CREW.length);
  });

  it('story and rescue recruits sign on free and only once (idempotent)', () => {
    const l = ledger(0);
    const t = signOn(EMPTY_CREW, l, 'tobiah-renn', world());
    expect(t).toMatchObject({ ok: true, charged: 0 });
    if (!t.ok) return;
    expect(t.ledger).toBe(l); // no ledger entry for a free hire
    expect(t.state.paid).toEqual([]);
    expect(signOn(t.state, t.ledger, 'tobiah-renn', world())).toMatchObject({ ok: false, reason: 'hired' });
    const b = signOn(t.state, t.ledger, 'brask-ottley', world({ rescues: 2 }));
    expect(b.ok && b.state.hired).toEqual(['tobiah-renn', 'brask-ottley']);
  });

  it('a dismissed member returns to their station and signs on again without a second fee', () => {
    const first = signOn(EMPTY_CREW, ledger(300), 'maren-sato', world());
    if (!first.ok) throw new Error('hire');
    const d = dismiss(first.state, 'maren-sato', world());
    if (!d.ok) throw new Error('dismiss');
    expect(recruitState(CREW_BY_ID.get('maren-sato')!, d.state, world())).toBe('here');
    expect(feeDue(CREW_BY_ID.get('maren-sato')!, d.state, false)).toBe(0);
    const again = signOn(d.state, first.ledger, 'maren-sato', world());
    expect(again).toMatchObject({ ok: true, charged: 0 });
    if (again.ok) expect(again.ledger.balance).toBe(170);
  });

  it('Admin Access hires are free and record nothing in the ledger', () => {
    const l = ledger(0);
    const r = signOn(EMPTY_CREW, l, 'corin-vasht', world({ docked: 'milky-way/lantern-gate' }), true);
    expect(r).toMatchObject({ ok: true, charged: 0 });
    if (r.ok) {
      expect(r.ledger).toBe(l);
      expect(r.state.paid).toEqual([]); // the sandbox never marks a fee as paid
    }
  });

  it('counts distress beacons cleared from the saved sectors only', () => {
    expect(distressBeaconsCleared({})).toBe(0);
    expect(distressBeaconsCleared({ a: { done: ['salvage-1', 'defence-1'] }, b: { done: ['ambush-1'] }, c: { done: ['defence-1'] } })).toBe(2);
    expect(distressBeaconsCleared({ a: { done: ['defence-x', 'xdefence-1'] } })).toBe(0);
  });
});

/* ------------------------------------------------------------ persistence */

describe('crew persistence and migration (P05.1)', () => {
  const sanitize = (doc: Record<string, unknown>) => FREEROAM_SPEC.sanitize({ ...JSON.parse(JSON.stringify(EMPTY_PROFILE)), version: FREEROAM_VERSION, ...doc });

  it('an old save (no crew field) loads with an empty crew, still v10, and nothing is granted', () => {
    expect(FREEROAM_VERSION).toBe(10);
    const r = sanitize({});
    expect('crew' in r.data).toBe(false);
    expect(r.repaired).toBe(false);
    const c = crewFromSaved(r.data.crew, ['petrel']);
    expect(c.state).toEqual(EMPTY_CREW);
    expect(c.changes).toBe(0);
    expect(crewToSaved(c.state)).toBeUndefined();
  });

  it('round-trips a crew through the save shape', () => {
    const s: CrewState = { hired: ['maren-sato', 'tobiah-renn'], paid: ['maren-sato'], seats: { petrel: ['tobiah-renn'] } };
    const saved = crewToSaved(s)!;
    const r = sanitize({ crew: saved });
    expect(r.repaired).toBe(false);
    expect(r.data.crew).toEqual(saved);
    expect(crewFromSaved(r.data.crew, ['petrel']).state).toEqual(s);
  });

  it('repairs malformed crew shapes safely and within bounds', () => {
    for (const bad of [null, 7, 'x', [], { hired: 'maren-sato' }, { hired: [1, 2] }, { seats: [] }, { seats: { 'BAD SHIP': ['maren-sato'] } }, { hired: [], paid: [], seats: {} }]) {
      const r = sanitize({ crew: bad });
      expect(r.repaired, JSON.stringify(bad)).toBe(true);
      if (r.data.crew) {
        expect(Array.isArray(r.data.crew.hired)).toBe(true);
        expect(Object.keys(r.data.crew.seats).every((k) => /^[a-z]+(?:-[a-z]+)*$/.test(k))).toBe(true);
      }
    }
    const huge = sanitize({ crew: { hired: Array.from({ length: 500 }, (_, i) => `crew-${'abcdefghij'[i % 10]}${'abcdefghij'[Math.floor(i / 10) % 10]}`), paid: [], seats: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`ship-${'abcdefghijklmnopqrstuvwxyzabcdefghijklmnop'[i]}${i > 25 ? 'x' : ''}`, ['maren-sato']])) } });
    expect(huge.repaired).toBe(true);
    expect(huge.data.crew!.hired.length).toBeLessThanOrEqual(32);
    expect(Object.keys(huge.data.crew!.seats).length).toBeLessThanOrEqual(16);
  });

  it('drops unknown and duplicate ids against the roster and releases seats on ships the save does not own', () => {
    const c = crewFromSaved({ hired: ['maren-sato', 'retired-pilot', 'maren-sato'], paid: ['retired-pilot'], seats: { condor: ['maren-sato'] } }, ['petrel']);
    expect(c.state).toEqual({ hired: ['maren-sato'], paid: [], seats: {} });
    expect(c.unseated).toEqual(['maren-sato']);
    expect(c.changes).toBeGreaterThan(0);
  });

  it('the save audit reports crew fixes (so the raw slot is backed up first) and never adds crew', () => {
    const graph = buildNavGraph();
    const p: FreeRoamProfile = { ...EMPTY_PROFILE, crew: { hired: ['maren-sato', 'ghost'], paid: [], seats: { swift: ['maren-sato'] } } };
    const a = auditProfile(graph, p);
    expect(a.issues.find((i) => i.area === 'crew')?.count).toBe(2);
    expect(a.profile.crew).toEqual({ hired: ['maren-sato'], paid: [], seats: {} });
    const clean = auditProfile(graph, EMPTY_PROFILE);
    expect(clean.issues.some((i) => i.area === 'crew')).toBe(false);
    expect('crew' in clean.profile).toBe(false);
  });

  it('withCrew(undefined) removes the field, so an empty crew is byte-identical to an old save', () => {
    const p = withCrew({ ...EMPTY_PROFILE, crew: { hired: ['maren-sato'], paid: [], seats: {} } }, undefined);
    expect('crew' in p).toBe(false);
    expect(JSON.stringify(withCrew(EMPTY_PROFILE, crewToSaved(EMPTY_CREW)))).toBe(JSON.stringify(EMPTY_PROFILE));
  });

  it('keeps slots independent: crew saved in one slot never appears in another', () => {
    const store = new MemoryStore();
    const withMaren = withCrew(EMPTY_PROFILE, { hired: ['maren-sato'], paid: ['maren-sato'], seats: { petrel: ['maren-sato'] } });
    expect(saveSlot(store, 1, withMaren)).toBe(true);
    expect(saveSlot(store, 2, EMPTY_PROFILE)).toBe(true);
    expect(loadSlot(store, 1).data.crew).toEqual({ hired: ['maren-sato'], paid: ['maren-sato'], seats: { petrel: ['maren-sato'] } });
    expect('crew' in loadSlot(store, 2).data).toBe(false);
    expect('crew' in loadSlot(store, 3).data).toBe(false);
    // loading writes nothing back by itself (reading is not saving)
    const before = store.read(slotKey(1));
    loadSlot(store, 1);
    expect(store.read(slotKey(1))).toBe(before);
  });
});

/* ---------------------------------------------------------- read-only view */

describe('read-only crew view (P05.1)', () => {
  const s: CrewState = { hired: ['maren-sato', 'odile-marchetti'], paid: [], seats: { petrel: ['odile-marchetti', 'maren-sato'] } };

  it('describes the seated crew of one ship in seat order, deeply frozen', () => {
    const v = shipCrewView(s, 'petrel');
    expect(v.ship).toBe('petrel');
    expect(v.seats).toBe(2);
    expect(v.members.map((m) => [m.id, m.seat])).toEqual([
      ['odile-marchetti', 0],
      ['maren-sato', 1],
    ]);
    expect(v.roles).toEqual(['surveyor', 'navigator']);
    expect(hasRole(v, 'navigator')).toBe(true);
    expect(hasRole(v, 'engineer')).toBe(false);
    expect(memberWithRole(v, 'surveyor')?.name).toBe('Odile Marchetti');
    expect(Object.isFrozen(v) && Object.isFrozen(v.members) && Object.isFrozen(v.members[0]) && Object.isFrozen(v.members[0]!.attributes) && Object.isFrozen(v.roles)).toBe(true);
    expect(() => {
      (v.members[0]!.attributes as { competence: number }).competence = 5;
    }).toThrow();
  });

  it('exposes information only: no handle on input, position, weapons, lock, wallet or progression', () => {
    const v = shipCrewView(s, 'petrel');
    expect(Object.keys(v).sort()).toEqual(['members', 'roles', 'seats', 'ship']);
    expect(Object.keys(v.members[0]!).sort()).toEqual(['attributes', 'id', 'name', 'rank', 'role', 'seat']);
    expect(shipCrewView(EMPTY_CREW, 'swift').members).toEqual([]);
  });
});

/* ------------------------------------------------------------ Bridge model */

describe('Bridge view model (P05.1)', () => {
  it('summarises ship, capacity, occupied seats and unassigned crew; solo play is stated as valid', () => {
    const crew: CrewState = { hired: ['maren-sato', 'tobiah-renn'], paid: [], seats: { petrel: ['maren-sato'] } };
    const m = bridgeModel(ctx({ crew }));
    expect(m.summary).toBe('PETREL\u00a0· 2 CREW SEATS\u00a0· 1 OCCUPIED\u00a0· 1 UNASSIGNED');
    expect(m.seatCards.map((c) => c.member?.id ?? null)).toEqual(['maren-sato', null]);
    expect(m.notes).toContain(SOLO_NOTE);
    expect(m.notes).toContain(ACTIVE_NOTE);
    // P05.2 honesty: advice only, the pilot decides; the unbuilt roles are named as planned
    expect(ACTIVE_NOTE).toMatch(/never steer, brake, fire, lock, pay or travel/);
    expect(ACTIVE_NOTE).toMatch(/Engineer, Defence and Quartermaster duties are planned/);
    expect(m.roster.map((r) => [r.card.id, r.where, r.assign.label, r.assign.enabled])).toEqual([['tobiah-renn', 'UNASSIGNED', 'ASSIGN TO PETREL', true]]);
    const solo = bridgeModel(ctx());
    expect(solo.occupied).toBe(0);
    expect(solo.notes[0]).toBe(SOLO_NOTE);
  });

  it('shows member cards with role, rank, attributes and duties worded as active only where they work', () => {
    const m = bridgeModel(ctx({ crew: { hired: ['odile-marchetti'], paid: [], seats: { petrel: ['odile-marchetti'] } } }));
    const c = m.seatCards[0]!.member!;
    expect(c).toMatchObject({ name: 'Odile Marchetti', roleLabel: 'SURVEYOR', rankLabel: 'RATED' });
    expect(c.attributes.map((a) => [a.label, a.value, a.max])).toEqual([
      ['COMPETENCE', 4, 5],
      ['CAUTION', 3, 5],
      ['FOCUS', 3, 5],
    ]);
    // Surveyor: all three duties work since P06.1 (signal triangulation: tighter bearings and advice, never auto-collection)
    expect(c.contribution.map((l) => l.includes('(planned)'))).toEqual([false, false, false]);
    expect(c.contribution[2]).toMatch(/^Signal triangulation: Tightens the bearings/);
    const eng = bridgeModel(ctx({ crew: { hired: ['brask-ottley'], paid: [], seats: { petrel: ['brask-ottley'] } } })).seatCards[0]!;
    for (const line of eng.member!.contribution) expect(line).toContain('(planned)');
    expect(eng.onDuty).toBe(false);
    expect(eng.member!.traits).toEqual([]);
    expect(m.seatCards[0]!.unassign).toMatchObject({ enabled: true, label: 'UNASSIGN' });
  });

  it('says why an assignment is refused (full, not owned, not docked safely)', () => {
    const full: CrewState = { hired: ['maren-sato', 'odile-marchetti', 'tobiah-renn'], paid: [], seats: { swift: ['maren-sato'] } };
    const m = bridgeModel(ctx({ ship: 'swift', crew: full }));
    const r = m.roster.find((x) => x.card.id === 'odile-marchetti')!;
    expect(r.assign.enabled).toBe(false);
    expect(r.assign.reason).toBe('All 1 seat on the Swift are taken. Unassign someone first.');
    const unowned = bridgeModel(ctx({ ship: 'albatross', crew: full }));
    expect(unowned.owned).toBe(false);
    expect(unowned.notes[0]).toContain('would carry 3 crew once acquired');
    expect(unowned.roster[0]!.assign.reason).toContain('Acquire the Albatross first');
    const unsafe = bridgeModel(ctx({ crew: full, world: world({ safe: false }) }));
    expect(unsafe.roster.every((x) => !x.assign.enabled && /docked with no hostiles/.test(x.assign.reason))).toBe(true);
    // the move label for crew aboard another ship
    expect(bridgeModel(ctx({ crew: full })).roster.find((x) => x.card.id === 'maren-sato')).toMatchObject({ where: 'ABOARD THE SWIFT', assign: { label: 'MOVE TO PETREL', enabled: true } });
  });

  it('lists recruits with cost, balance before and after, location and their real requirements', () => {
    const m = bridgeModel(ctx({ balance: 200 }));
    const maren = m.recruits.find((r) => r.card.id === 'maren-sato')!;
    expect(maren).toMatchObject({ state: 'here', fee: 130, location: 'WAITS AT SOL STATION', feeText: '◈ 130 MARKS · ONE-TIME BERTH FEE', balanceText: 'BALANCE ◈ 200 MARKS → ◈ 70 MARKS' });
    expect(maren.hire).toEqual({ enabled: true, label: 'SIGN ON · ◈ 130 MARKS', reason: '' });
    expect(maren.requirements).toEqual([]);
    const poor = bridgeModel(ctx({ balance: 100 })).recruits.find((r) => r.card.id === 'maren-sato')!;
    expect(poor.hire.enabled).toBe(false);
    expect(poor.hire.reason).toMatch(/30/); // the shortfall in marks
    expect(poor.balanceText).toBe('BALANCE ◈ 100 MARKS → NOT ENOUGH');
    // locked: the real unmet requirement, with progress
    const locked = bridgeModel(ctx({ world: world({ requirementMet: () => false, missionDone: () => false, rescues: 0 }) }));
    const odile = locked.recruits.find((r) => r.card.id === 'odile-marchetti')!;
    expect(odile.state).toBe('locked');
    expect(odile.requirements).toEqual([{ text: 'requirement surveys (0/1)', met: false }]);
    expect(odile.hire.reason).toBe('Locked · requirement surveys (0/1).');
    const tobiah = locked.recruits.find((r) => r.card.id === 'tobiah-renn')!;
    expect(tobiah.requirements[0]!.text).toBe('Complete the story mission “Silent Hull”');
    expect(tobiah.location).toBe('SIGNS ON AT ANY STATION');
    expect(tobiah.feeText).toBe('NO FEE');
    const brask = locked.recruits.find((r) => r.card.id === 'brask-ottley')!;
    expect(brask.requirements[0]!.text).toMatch(/distress beacon.*\(0\/1\)/);
    // elsewhere: where they wait
    const corin = m.recruits.find((r) => r.card.id === 'corin-vasht')!;
    expect(corin.hire.reason).toBe('Signs on only at Lantern Gate station.');
    // locked recruits come after the ones that can sign on here
    expect(locked.recruits.map((r) => r.state).indexOf('locked')).toBeGreaterThan(locked.recruits.map((r) => r.state).lastIndexOf('here'));
  });

  it('shows the empty state once everyone has signed on, and Admin Access hires as free', () => {
    const all = hiredState(...CREW.map((c) => c.id));
    const m = bridgeModel(ctx({ crew: all }));
    expect(m.recruits).toEqual([]);
    expect(m.recruitEmpty).toMatch(/Every recruit has signed on/);
    const admin = bridgeModel(ctx({ free: true, balance: 0 })).recruits.find((r) => r.card.id === 'maren-sato')!;
    expect(admin).toMatchObject({ fee: 0, feeText: 'FREE · ADMIN ACCESS' });
    expect(admin.hire.enabled).toBe(true);
  });

  it('building the Bridge never changes state (opening the UI is read-only)', () => {
    const crew = deepFreeze<CrewState>({ hired: ['maren-sato'], paid: ['maren-sato'], seats: { petrel: ['maren-sato'] } });
    const w = deepFreeze(world());
    const before = JSON.stringify(crew);
    for (const ship of ['petrel', 'swift', 'albatross'] as const) bridgeModel(ctx({ ship, crew, world: w }));
    expect(JSON.stringify(crew)).toBe(before);
  });

  it('never mentions a ship or capacity the roster does not have', () => {
    for (const s of SHIPS) {
      const m = bridgeModel(ctx({ ship: s.id, world: world({ owned: [s.id] }) }));
      expect(m.seats).toBe(SHIP_BY_ID.get(s.id)!.crewSeats);
      expect(m.seatCards).toHaveLength(m.seats);
    }
  });
});

/* ------------------------------------------------------------ architecture */

describe('crew module boundaries (P05.1)', () => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const dir = join(src, 'modes/freeroam/crew');
  const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8');
  const specs = (rel: string): string[] => [...read(rel).matchAll(/from\s+'(\.[^']+)'|import\s*\(\s*'(\.[^']+)'\s*\)/g)].map((m) => resolve(dirname(join(dir, rel)), (m[1] ?? m[2])!).slice(src.length + 1).replace(/\\/g, '/'));

  it('has exactly these files: pure rules, one persistence adapter and one DOM section', () => {
    // P05.2: + advisor (rules), observation (types), traits (attribute mapping), ui/advisorStrip (DOM)
    expect(readdirSync(dir).sort()).toEqual(['advisor.ts', 'bridgeView.ts', 'data.ts', 'observation.ts', 'persistence.ts', 'recruit.ts', 'state.ts', 'traits.ts', 'types.ts', 'ui', 'view.ts']);
    expect(readdirSync(join(dir, 'ui')).sort()).toEqual(['advisorStrip.ts', 'bridgeSection.ts']);
  });

  it('keeps the rules pure and deterministic, and away from input, flight, weapons, lock and storage', () => {
    for (const f of ['advisor.ts', 'bridgeView.ts', 'data.ts', 'observation.ts', 'persistence.ts', 'recruit.ts', 'state.ts', 'traits.ts', 'types.ts', 'view.ts']) {
      const code = read(f);
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|sessionStorage|fetch|XMLHttpRequest|WebSocket|requestAnimationFrame|setTimeout|setInterval)\b/);
      for (const s of specs(f)) {
        expect(s, `${f} imports ${s}`).not.toMatch(/^(input|game|classic|render|audio|persistence|shared\/persistence)\//);
        expect(s, `${f} imports ${s}`).not.toMatch(/^modes\/freeroam\/(input|sim|camera|freeRoamMode|saveSlots|combatHud)\.ts$/);
        expect(s, `${f} imports ${s}`).not.toMatch(/^modes\/freeroam\/(sector|combat|gravity|admin|galaxy)\//);
        expect(s, `${f} imports ${s}`).not.toMatch(/^config\/weapons\.ts$|^modes\/freeroam\/ships\/(armory|armoryView|hangarPanel|equipment|upgrades)\.ts$/);
        // only the persistence adapter knows the save shape
        if (f !== 'persistence.ts') expect(s, `${f} imports ${s}`).not.toBe('modes/freeroam/profile.ts');
      }
    }
    // only recruitment moves marks, and only through transact
    for (const f of ['advisor.ts', 'bridgeView.ts', 'data.ts', 'observation.ts', 'persistence.ts', 'state.ts', 'traits.ts', 'types.ts', 'view.ts']) expect(read(f), f).not.toMatch(/\b(transact|spend|award|record|refund)\(/);
    expect(read('recruit.ts')).toMatch(/\btransact\(/);
    expect(read('recruit.ts')).not.toMatch(/\b(spend|award|record|refund)\(/);
  });

  it('keeps the Bridge section DOM-only: no rules, payments, storage or timers', () => {
    const code = read('ui/bridgeSection.ts');
    expect(code).not.toMatch(/\b(signOn|transact|assign\(|unassign\(|dismiss\(|cleanCrew|localStorage|fetch|setTimeout|setInterval|requestAnimationFrame|withCrew)\b/);
    // P05.2: + crew/types.ts for the NavDoctrine type of the doctrine action
    for (const s of specs('ui/bridgeSection.ts')) expect(s).toMatch(/^modes\/freeroam\/(progression\/ui\/common|ships\/types|crew\/bridgeView|crew\/types)\.ts$/);
    const strip = read('ui/advisorStrip.ts');
    expect(strip).not.toMatch(/\b(localStorage|fetch|setTimeout|setInterval|requestAnimationFrame|addEventListener|evaluateAdvice|play\()\b/);
    // P05.3: its look is the stylesheet's (corner-log line, level tones): no inline styles or colour literals in code
    expect(strip).not.toMatch(/\.style\b|cssText|setProperty|#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('ships in the lazy Free Roam chunk only: nothing outside Free Roam (or profile.ts) imports crew/', () => {
    const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
    for (const f of all(src)) {
      const rel = f.slice(src.length + 1).replace(/\\/g, '/');
      const code = readFileSync(f, 'utf8');
      const hit = /from\s+'[^']*crew\/[^']*'/.test(code);
      if (!rel.startsWith('modes/freeroam/') || rel === 'modes/freeroam/profile.ts') expect(hit, rel).toBe(false);
    }
  });
});
