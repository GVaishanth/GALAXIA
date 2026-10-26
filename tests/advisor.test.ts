/**
 * P05.2: Ship Mind, Navigator and Surveyor advice (crew/advisor.ts,
 * crew/traits.ts, advisor/observe.ts, advisor/forecast.ts).
 *
 * Two layers are tested:
 *  - the advisor itself on hand-built observations (priority, dedup,
 *    suppression, attributes, roles, boundaries), and
 *  - the observation and drift forecast on real sector runs (the game's own
 *    flight step and collision rule; sensor range, interference, hidden POIs),
 *    including that a forecast collision really happens when the pilot does
 *    nothing and that a verified escape burn really avoids it.
 * Simulated only (fixed 60 Hz step): no device or human playtest is implied.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createForecaster, FORECAST } from '../src/modes/freeroam/advisor/forecast.ts';
import { observe, type ObserveOptions } from '../src/modes/freeroam/advisor/observe.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import {
  ADVICE_LEVELS,
  ADVICE_SOURCES,
  ADVISOR,
  advisorCrew,
  advisorView,
  arrowOf,
  bearingWords,
  EMPTY_ADVISOR,
  evaluateAdvice,
  NO_CREW,
  parkAdvisor,
  quietAdvisor,
  relBearing,
  RULE_IDS,
  RULES,
  type AdviceMode,
  type AdvisorCrew,
  type AdvisorState,
} from '../src/modes/freeroam/crew/advisor.ts';
import { CREW_BY_ID } from '../src/modes/freeroam/crew/data.ts';
import type { Observation, ObservedPoi } from '../src/modes/freeroam/crew/observation.ts';
import { crewFromSaved, crewToSaved } from '../src/modes/freeroam/crew/persistence.ts';
import { cleanCrew, EMPTY_CREW, setDoctrine } from '../src/modes/freeroam/crew/state.ts';
import { attr, holdTicksFor, navigatorTraits, SHIP_MIND, surveyorBearingSpreadDeg, surveyorTraits, traitLines } from '../src/modes/freeroam/crew/traits.ts';
import type { CrewAttributes, CrewState } from '../src/modes/freeroam/crew/types.ts';
import { shipCrewView } from '../src/modes/freeroam/crew/view.ts';
import { bridgeModel, type BridgeContext } from '../src/modes/freeroam/crew/bridgeView.ts';
import { DEFAULT_CONTROLS, sanitizeControls, EMPTY_PROFILE, FREEROAM_SPEC, FREEROAM_VERSION, withCrew } from '../src/modes/freeroam/profile.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type Poi, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { realisticInput } from '../src/modes/freeroam/sector/realisticFlight.ts';
import { createSectorRun, RUN, stepSector, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { arena } from './helpers/combatProbe.ts';

const root = join(import.meta.dirname, '..');

/* ================================================================ fixtures */

const SOL = 'milky-way/sol#1';
const body = { id: 'p1', label: 'Ceres Test', kind: 'body' as const };

/** A calm, flying observation with nothing going on; override what a test needs. */
function O(over: Partial<Observation> = {}): Observation {
  return {
    sector: SOL,
    tick: 200,
    flying: true,
    combat: 'calm',
    flightMode: 'normal',
    stop: 'off',
    heading: 0,
    hull: 1,
    shield: 1,
    jammed: false,
    sensorRange: 900,
    contacts: { count: 0, nearest: null },
    gravity: { share: 0, dx: 0, dy: 0, body: null, closing: false, engineBeats: true },
    inCorona: null,
    forecast: null,
    pois: [],
    survey: { remaining: 0, onSensors: 0, seen: 0, nearest: null, complete: true },
    exit: null,
    route: null,
    emptyMagazines: [],
    offer: false,
    ...over,
  };
}

const poi = (id: string, kind: ObservedPoi['kind'], over: Partial<ObservedPoi> = {}): ObservedPoi => ({
  id,
  kind,
  label: kind === 'anomaly' ? 'Phase shimmer' : kind === 'derelict' ? 'Derelict hauler' : kind === 'cache' ? 'Supply cache' : kind === 'salvage' ? 'Salvage' : kind === 'installation' ? 'Watch post' : 'Survey mark',
  dx: 0,
  dy: -400,
  distance: 400,
  reach: 60,
  verb: kind === 'anomaly' ? 'Investigate' : kind === 'cache' ? 'Open' : 'Inspect',
  auto: kind === 'salvage' || kind === 'survey' || kind === 'installation',
  required: false,
  hazard: null,
  resource: null,
  ...over,
});

const impact = (inS: number, kind: 'surface' | 'corona' = 'surface', escape: NonNullable<Observation['forecast']>['escape'] = null): Observation['forecast'] => ({
  horizonS: 5,
  impact: { body, inS, kind, damaging: true },
  escape,
});

const A = (competence: number, caution: number, focus: number): CrewAttributes => ({ competence, caution, focus });

/** A crew on duty with hand-picked attributes (as advisorCrew builds it). */
function crewWith(o: { nav?: CrewAttributes; sur?: CrewAttributes; doctrine?: 'balanced' | 'safety' }): AdvisorCrew {
  return {
    key: `t|${JSON.stringify(o)}`,
    navigator: o.nav ? { name: 'Maren Sato', traits: navigatorTraits(o.nav, o.doctrine ?? 'balanced') } : null,
    surveyor: o.sur ? { name: 'Odile Marchetti', traits: surveyorTraits(o.sur) } : null,
  };
}

/** Run the advisor over a list of observations (one pass each); returns every state. */
function play(obs: readonly Observation[], crew: AdvisorCrew = NO_CREW, mode: AdviceMode = 'all', start: AdvisorState = EMPTY_ADVISOR): AdvisorState[] {
  const out: AdvisorState[] = [];
  let s = start;
  for (const o of obs) {
    s = evaluateAdvice(s, o, crew, mode);
    out.push(s);
  }
  return out;
}

/** The same observation at ticks t0, t0 + 12, ... (n passes). */
const over = (n: number, f: (tick: number, i: number) => Observation, t0 = 200): Observation[] => Array.from({ length: n }, (_, i) => f(t0 + i * ADVISOR.everyTicks, i));
const shownIds = (states: readonly AdvisorState[]): string[] => {
  const ids: string[] = [];
  let serial = -1;
  for (const s of states) if (s.current && s.serial !== serial) ((serial = s.serial), ids.push(`${s.current.advice.id}|${s.current.advice.key}`));
  return ids;
};

const deepFreeze = <T>(x: T): T => {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x as object)) deepFreeze(v);
  }
  return x;
};

/* ================================================================== traits */

describe('crew traits: one documented attribute mapping (P05.2)', () => {
  it('clamps and validates attributes to 1..5 (invalid reads as the typical 3)', () => {
    expect([attr(0), attr(1), attr(3.4), attr(5), attr(9), attr(Number.NaN), attr(Infinity), attr('4' as unknown as number)]).toEqual([1, 1, 3, 5, 5, 3, 3, 3]);
    expect(navigatorTraits(A(99, -4, Number.NaN))).toEqual(navigatorTraits(A(5, 1, 3)));
  });

  it('Competence = quality, Caution = timing and thresholds, Focus = staying on task (each changes one thing)', () => {
    const base = navigatorTraits(A(3, 3, 3));
    const c = navigatorTraits(A(5, 3, 3));
    const ca = navigatorTraits(A(3, 5, 3));
    const f = navigatorTraits(A(3, 3, 5));
    expect(c.escapeCandidates).toBeGreaterThan(base.escapeCandidates);
    expect([c.horizonS, c.pullShare, c.holdTicks]).toEqual([base.horizonS, base.pullShare, base.holdTicks]);
    expect(ca.horizonS).toBeGreaterThan(base.horizonS);
    expect(ca.pullShare).toBeLessThan(base.pullShare);
    expect([ca.escapeCandidates, ca.holdTicks]).toEqual([base.escapeCandidates, base.holdTicks]);
    expect(f.holdTicks).toBeGreaterThan(base.holdTicks);
    expect(f.coreFirst).toBe(true);
    expect([f.horizonS, f.escapeCandidates]).toEqual([base.horizonS, base.escapeCandidates]);
    expect([surveyorTraits(A(1, 3, 3)).detail, surveyorTraits(A(3, 3, 3)).detail, surveyorTraits(A(5, 3, 3)).detail]).toEqual([1, 2, 3]);
    expect([surveyorTraits(A(3, 2, 3)).hazardNotes, surveyorTraits(A(3, 3, 3)).hazardNotes]).toEqual([false, true]);
    expect(holdTicksFor(1)).toBeLessThan(holdTicksFor(5));
  });

  it('keeps modest crew useful: a 1-1-1 Navigator still warns before the Ship Mind and checks escape burns', () => {
    const low = navigatorTraits(A(1, 1, 1));
    expect(low.horizonS).toBeGreaterThan(SHIP_MIND.impactHorizonS);
    expect(low.pullShare).toBeLessThanOrEqual(SHIP_MIND.strongShare);
    expect(low.escapeCandidates).toBeGreaterThanOrEqual(2);
    expect(surveyorTraits(A(1, 1, 1)).detail).toBe(1);
  });

  it('is advice-only data: no field that could act as a physics, damage, economy or progression bonus', () => {
    expect(Object.keys(navigatorTraits(A(3, 3, 3))).sort()).toEqual(['coreFirst', 'doctrine', 'escapeCandidates', 'holdTicks', 'horizonS', 'pullShare', 'routeNotes']);
    expect(Object.keys(surveyorTraits(A(3, 3, 3))).sort()).toEqual(['coreFirst', 'detail', 'hazardNotes', 'holdTicks']);
    const code = readFileSync(join(root, 'src/modes/freeroam/crew/traits.ts'), 'utf8');
    expect(code).not.toMatch(/\b(accel|maxSpeed|damage|hull|marks|price|reward|xp|level)\s*:/);
  });

  it('safety-first doctrine warns earlier and drops optional route notes (advice only)', () => {
    const b = navigatorTraits(A(3, 3, 3), 'balanced');
    const s = navigatorTraits(A(3, 3, 3), 'safety');
    expect(s.horizonS).toBe(b.horizonS + 1);
    expect(s.pullShare).toBeLessThan(b.pullShare);
    expect([b.routeNotes, s.routeNotes]).toEqual([true, false]);
  });

  it('describes the mapping in plain words on the Bridge (roles without flight duties get none)', () => {
    expect(traitLines('navigator', A(4, 2, 4))).toEqual([
      'COMPETENCE 4 · checks 3 escape burns against the drift forecast',
      'CAUTION 2 · warns 3.0 s ahead; explains pulls from 18% of engine thrust',
      'FOCUS 4 · holds a topic 3.0 s; no route notes during a gravity hazard',
    ]);
    expect(traitLines('surveyor', A(5, 3, 3))[0]).toMatch(/main resource/);
    expect(traitLines('engineer', A(4, 3, 2))).toEqual([]);
  });

  it('offers only a typed P06 extension point for triangulation (nothing in P05.2 uses it)', () => {
    expect([surveyorBearingSpreadDeg(A(1, 3, 3)), surveyorBearingSpreadDeg(A(5, 3, 3))]).toEqual([12, 4]);
    const adv = readFileSync(join(root, 'src/modes/freeroam/crew/advisor.ts'), 'utf8');
    expect(adv).not.toMatch(/surveyorBearingSpreadDeg|triangulat/i);
    for (const f of ['src/modes/freeroam/advisor/observe.ts', 'src/modes/freeroam/advisor/forecast.ts', 'src/modes/freeroam/freeRoamMode.ts']) expect(readFileSync(join(root, f), 'utf8'), f).not.toMatch(/surveyorBearingSpreadDeg/);
  });
});

/* ========================================================== the Ship Mind */

describe('Ship Mind (no crew, no seat): priority, dedup and suppression (P05.2)', () => {
  it('is quiet when nothing is going on (no spam, no filler)', () => {
    const st = play(over(60, (t) => O({ tick: t })));
    expect(st.every((s) => s.current === null)).toBe(true);
    expect(st.at(-1)!.shownCount).toBe(0);
  });

  it('says a low hull once, escalates once to severe, never repeats while it holds, and withdraws it when repaired', () => {
    const seq = [...over(10, (t) => O({ tick: t, hull: 0.25 })), ...over(10, (t) => O({ tick: t, hull: 0.12 }), 320), ...over(4, (t) => O({ tick: t, hull: 0.9 }), 440)];
    const st = play(seq);
    expect(shownIds(st)).toEqual(['mind.hull|low', 'mind.hull|severe']);
    expect(st[0]!.current!.advice).toMatchObject({ level: 'critical', source: 'mind', speaker: 'SHIP MIND' });
    expect(st[0]!.current!.advice.text).toBe('Hull at 25%. Dock at a station to repair it.');
    expect(st.at(-1)!.current).toBeNull(); // repaired: withdrawn at once
  });

  it('absorbs a flicker around a threshold (re-arm window) instead of repeating it', () => {
    const seq = over(30, (t, i) => O({ tick: t, hull: i % 2 ? 0.31 : 0.29 }));
    expect(shownIds(play(seq))).toEqual(['mind.hull|low']);
  });

  it('shows the most urgent message first; a lower one waits in the queue and follows if still true', () => {
    const both = (t: number): Observation => O({ tick: t, hull: 0.2, pois: [poi('anomaly-1', 'anomaly')] });
    const st = play(over(40, both));
    expect(st[0]!.current!.advice.id).toBe('mind.hull');
    expect(st[0]!.queue.map((a) => a.id)).toEqual(['mind.poi']);
    expect(shownIds(st)).toEqual(['mind.hull|low', 'mind.poi|anomaly-1']);
  });

  it('lets a higher level interrupt a lower one at once; equal or lower never interrupt', () => {
    const st = play([O({ tick: 200, pois: [poi('anomaly-1', 'anomaly')] }), O({ tick: 212, pois: [poi('anomaly-1', 'anomaly')], hull: 0.2 })]);
    expect(st[0]!.current!.advice.id).toBe('mind.poi');
    expect(st[1]!.current!.advice.id).toBe('mind.hull');
    const eq = play([O({ tick: 200, pois: [poi('anomaly-1', 'anomaly')] }), O({ tick: 212, pois: [poi('anomaly-1', 'anomaly'), poi('derelict-2', 'derelict')] })]);
    expect(eq[1]!.current!.advice.key).toBe('anomaly-1');
    expect(eq[1]!.queue.map((a) => a.key)).toEqual(['derelict-2']);
  });

  it('drops a queued message whose condition ended before its turn, and keeps the queue bounded', () => {
    const many = Array.from({ length: 7 }, (_, i) => poi(`cache-${i}`, 'cache', { distance: 300 + i }));
    const st = play([O({ tick: 200, hull: 0.2, pois: many })]);
    expect(st[0]!.queue.length).toBeLessThanOrEqual(ADVISOR.queueMax);
    const gone = play([O({ tick: 200, hull: 0.2, pois: [poi('cache-1', 'cache')] }), O({ tick: 212, hull: 0.2, pois: [] })]);
    expect(gone[1]!.queue).toEqual([]);
  });

  it('names each target once per visit; a new visit (or a restart) starts over', () => {
    const p = [poi('anomaly-1', 'anomaly')];
    const st = play([...over(30, (t) => O({ tick: t, pois: p })), ...over(30, (t) => O({ tick: t, pois: p, sector: 'milky-way/sol#2' }), 100)]);
    expect(shownIds(st)).toEqual(['mind.poi|anomaly-1', 'mind.poi|anomaly-1']);
    const restart = play([O({ tick: 900, pois: p }), O({ tick: 300, pois: p })]);
    expect(restart[1]!.serial).toBeGreaterThan(restart[0]!.serial);
    expect(restart[1]!.current!.advice.key).toBe('anomaly-1');
  });

  it('calls more hostile contacts, not fewer; and adds nothing while a fight is engaged (the combat banner has it)', () => {
    const c = (n: number, combat: Observation['combat'] = 'alert') => (t: number) => O({ tick: t, combat, contacts: { count: n, nearest: { dx: 300, dy: 0, distance: 300 } } });
    const st = play([...over(3, c(1)), ...over(3, c(3), 236), ...over(3, c(2), 272), ...over(3, c(5, 'engaged'), 308)]);
    expect(shownIds(st)).toEqual(['mind.contacts|1', 'mind.contacts|3']);
    expect(st[0]!.current!.advice.text).toBe('1 hostile contact on sensors, nearest to starboard (→).');
  });

  it('holds non-urgent advice in the first seconds of a visit, during an engaged fight and while a decision prompt is open', () => {
    const p = [poi('anomaly-1', 'anomaly')];
    expect(play([O({ tick: 30, pois: p })])[0]!.current).toBeNull();
    expect(play([O({ tick: 30, hull: 0.2 })])[0]!.current!.advice.id).toBe('mind.hull'); // urgent never waits
    expect(play([O({ tick: 200, combat: 'engaged', pois: p })])[0]!.current).toBeNull();
    expect(play([O({ tick: 200, offer: true, pois: p })])[0]!.current).toBeNull();
    const later = play([O({ tick: 200, offer: true, pois: p }), O({ tick: 212, pois: p })]);
    expect(later[1]!.current!.advice.key).toBe('anomaly-1'); // deferred, not lost
  });

  it('critical only: everything below critical is consumed silently (and not saved up for later)', () => {
    const p = [poi('anomaly-1', 'anomaly')];
    const st = play([O({ tick: 200, pois: p, emptyMagazines: ['Nuke'] }), O({ tick: 212, pois: p, hull: 0.2 })], NO_CREW, 'critical');
    expect(st[0]!.current).toBeNull();
    expect(st[1]!.current!.advice.id).toBe('mind.hull');
    const back = evaluateAdvice(st[1]!, O({ tick: 224, pois: p, hull: 0.2 }), NO_CREW, 'all');
    expect(back.queue).toEqual([]);
    expect(back.current!.advice.id).toBe('mind.hull');
  });

  it('shows nothing while not flying (docked, paused, a panel up) and does not repeat on return', () => {
    const st = play([O({ tick: 200, hull: 0.2 }), O({ tick: 212, hull: 0.2, flying: false }), O({ tick: 224, hull: 0.2 })]);
    expect(st[1]!.current).toBeNull();
    expect(st[2]!.current).toBeNull();
    expect(quietAdvisor(st[0]!).current).toBeNull();
    expect(evaluateAdvice(st[0]!, null, NO_CREW, 'all').current).toBeNull();
  });

  it('expires a message after its display time without repeating it', () => {
    const st = play(over(40, (t) => O({ tick: t, hull: 0.2 })));
    expect(st.some((s) => s.current === null)).toBe(true);
    expect(st.at(-1)!.shownCount).toBe(1);
  });

  it('covers the Ship Mind topics: impact, corona, strong pull, empty magazine, shield, installations', () => {
    const t = (o: Partial<Observation>) => play([O({ tick: 200, ...o })])[0]!.current?.advice;
    expect(t({ forecast: impact(1.5) })?.text).toBe('Collision course: Ceres Test in 1.5 s. Steer away.');
    expect(t({ forecast: impact(3) })).toBeUndefined(); // beyond the Ship Mind's 2 s
    expect(t({ inCorona: { id: 's', label: 'Sol', kind: 'star', outX: 0, outY: -1 } })?.text).toBe("Inside Sol's corona: the shield is burning. Pull clear.");
    expect(t({ gravity: { share: 0.25, dx: 1, dy: 0, body, closing: true, engineBeats: true } })?.text).toBe('Strong pull from Ceres Test: it draws us →.');
    expect(t({ gravity: { share: 0.25, dx: 1, dy: 0, body, closing: false, engineBeats: true } })).toBeUndefined(); // not closing: nothing to say
    expect(t({ emptyMagazines: ['Nuke'] })?.text).toBe('Nuke magazine empty. Docking at a station restocks it.');
    expect(t({ shield: 0, combat: 'alert' })?.text).toBe('Shield down: hits now strike the hull.');
    expect(t({ shield: 0, combat: 'calm' })).toBeUndefined();
    expect(t({ pois: [poi('installation-1', 'installation')] })?.level).toBe('warning');
  });

  it('survives invalid data without throwing and without inventing a message', () => {
    const bad = O({ tick: 200, hull: Number.NaN, shield: Number.NaN, heading: Number.NaN, gravity: { share: Number.NaN, dx: Number.NaN, dy: 0, body: null, closing: false, engineBeats: true }, contacts: { count: Number.NaN, nearest: null } });
    expect(() => play(over(5, (tt) => ({ ...bad, tick: tt })))).not.toThrow();
    expect(play([bad])[0]!.current).toBeNull();
    expect(() => evaluateAdvice(EMPTY_ADVISOR, O({ tick: Number.NaN }), NO_CREW, 'all')).not.toThrow();
  });
});

/* ======================================================= one system, output */

describe('pause / resume and CRITICAL ONLY refinements (P05.3)', () => {
  const sun = { id: 's', label: 'Test sun', kind: 'star' as const, outX: 1, outY: 0 };
  const pull = { share: 0.25, dx: 1, dy: 0, body, closing: true, engineBeats: true };

  it('after a pause, re-evaluates the one parked message once: shown again (fresh words) while it still holds, then never repeated', () => {
    const before = play([O({ tick: 200, hull: 0.25 })]);
    const parked = parkAdvisor(before[0]!);
    expect(parked.current).toBeNull();
    expect(parked.parked).toEqual({ id: 'mind.hull', key: 'low' });
    const after = play(over(30, (t) => O({ tick: t, hull: 0.22 }), 212), NO_CREW, 'all', parked);
    expect(after[0]!.current!.advice).toMatchObject({ id: 'mind.hull', key: 'low', text: 'Hull at 22%. Dock at a station to repair it.' });
    expect(after[0]!.parked).toBeNull(); // consumed by that pass
    expect(after.at(-1)!.shownCount).toBe(before[0]!.shownCount + 1); // once, not again
  });

  it('park and quiet are no-ops (the same state object) when nothing is shown, queued or parked', () => {
    expect(parkAdvisor(EMPTY_ADVISOR)).toBe(EMPTY_ADVISOR);
    expect(quietAdvisor(EMPTY_ADVISOR)).toBe(EMPTY_ADVISOR);
  });

  it('forgets a parked message whose condition ended during the pause', () => {
    const parked = parkAdvisor(play([O({ tick: 200, inCorona: sun })])[0]!);
    expect(parked.parked).toEqual({ id: 'mind.corona', key: 'in:s' });
    const after = play(over(5, (t) => O({ tick: t }), 212), NO_CREW, 'all', parked);
    expect(after.every((x) => x.current === null)).toBe(true);
  });

  it('brings back only the message that was on screen: queued messages are dropped, no backlog after a pause', () => {
    const st = play([O({ tick: 200, hull: 0.2, pois: [poi('anomaly-1', 'anomaly'), poi('derelict-2', 'derelict')] })]);
    expect(st[0]!.queue.length).toBeGreaterThan(0);
    const parked = parkAdvisor(st[0]!);
    expect(parked.queue).toEqual([]);
    const after = play(over(40, (t) => O({ tick: t, hull: 0.2, pois: [poi('anomaly-1', 'anomaly'), poi('derelict-2', 'derelict')] }), 212), NO_CREW, 'all', parked);
    expect(shownIds(after)).toEqual(['mind.hull|low']);
  });

  it('keeps a parked warning quiet if CRITICAL ONLY was chosen in the pause menu; a parked critical still returns', () => {
    const warn = parkAdvisor(play([O({ tick: 200, inCorona: sun })])[0]!);
    expect(play([O({ tick: 212, inCorona: sun })], NO_CREW, 'critical', warn)[0]!.current).toBeNull();
    const crit = parkAdvisor(play([O({ tick: 200, hull: 0.2 })], NO_CREW, 'critical')[0]!);
    expect(play([O({ tick: 212, hull: 0.2 })], NO_CREW, 'critical', crit)[0]!.current!.advice.id).toBe('mind.hull');
  });

  it('docking, a wreck or leaving flight clears what was parked (quietAdvisor): nothing comes back', () => {
    const parked = parkAdvisor(play([O({ tick: 200, hull: 0.2 })])[0]!);
    const q = quietAdvisor(parked);
    expect(q.parked).toBeNull();
    expect(play([O({ tick: 212, hull: 0.2 })], NO_CREW, 'all', q)[0]!.current).toBeNull();
  });

  it('drops a parked crew message when that crew member is no longer on duty (changed ship, unassigned)', () => {
    const nav = crewWith({ nav: A(3, 4, 3) });
    const st = play([O({ tick: 200, gravity: { ...pull, share: 0.16 } })], nav);
    expect(st[0]!.current!.advice.source).toBe('navigator');
    const after = play([O({ tick: 212, gravity: { ...pull, share: 0.16 } })], NO_CREW, 'all', parkAdvisor(st[0]!));
    expect(after[0]!.parked).toBeNull();
    expect(after[0]!.current?.advice.source ?? 'mind').toBe('mind');
  });

  it('CRITICAL ONLY then ALL ADVICE: the single most urgent hazard still live is announced once; the rest stay quiet', () => {
    const live = (t: number): Observation => O({ tick: t, inCorona: sun, gravity: pull, pois: [poi('anomaly-1', 'anomaly')] });
    const muted = play(over(5, live), NO_CREW, 'critical');
    expect(muted.every((x) => x.current === null)).toBe(true);
    expect([...muted.at(-1)!.muted].sort()).toEqual(['mind.corona', 'mind.gravity']);
    const back = play(over(60, live, 260), NO_CREW, 'all', muted.at(-1)!);
    expect(shownIds(back)).toEqual(['mind.corona|in:s']); // the warning, not the info pull, not the anomaly callout
    expect(back.at(-1)!.muted).toEqual([]);
  });

  it('CRITICAL ONLY then ALL ADVICE: a muted condition that ended meanwhile is not announced', () => {
    const muted = play(over(3, (t) => O({ tick: t, inCorona: sun })), NO_CREW, 'critical');
    const ended = play(over(2, (t) => O({ tick: t }), 236), NO_CREW, 'critical', muted.at(-1)!);
    expect(ended.at(-1)!.muted).toEqual([]);
    const back = play(over(10, (t) => O({ tick: t }), 260), NO_CREW, 'all', ended.at(-1)!);
    expect(back.every((x) => x.current === null)).toBe(true);
  });

  it('keeps every critical message working under CRITICAL ONLY (hull, collision course)', () => {
    expect(play([O({ tick: 200, hull: 0.2 })], NO_CREW, 'critical')[0]!.current!.advice.id).toBe('mind.hull');
    expect(play([O({ tick: 200, forecast: impact(1.2) })], NO_CREW, 'critical')[0]!.current!.advice.id).toBe('mind.impact');
  });
});

describe('one advisory system: stable ids, whitelisted output, frozen input (P05.2)', () => {
  it('has unique, stable rule ids, each with a valid level, source and suppression policy', () => {
    expect(RULE_IDS).toEqual(['mind.hull', 'mind.shield', 'mind.impact', 'mind.corona', 'mind.gravity', 'mind.contacts', 'mind.poi', 'mind.magazine', 'nav.impact', 'nav.corona', 'nav.gravity', 'nav.stop', 'nav.route', 'sur.poi', 'sur.marks', 'sur.jammed', 'sur.none', 'sur.complete']);
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    for (const r of RULES) {
      expect(ADVICE_LEVELS).toContain(r.level);
      expect(ADVICE_SOURCES).toContain(r.source);
      expect(['transition', 'visit']).toContain(r.policy);
      expect(r.id.startsWith(r.source === 'mind' ? 'mind.' : r.source === 'navigator' ? 'nav.' : 'sur.')).toBe(true);
    }
  });

  it('returns text only: every message has exactly the whitelisted fields, plain strings, bounded length', () => {
    const crew = crewWith({ nav: A(5, 5, 3), sur: A(5, 5, 3) });
    const rich = (t: number): Observation =>
      O({
        tick: t,
        hull: 0.1,
        shield: 0,
        combat: 'alert',
        flightMode: 'realistic',
        stop: 'cannot',
        contacts: { count: 2, nearest: { dx: 0, dy: -300, distance: 300 } },
        gravity: { share: 0.28, dx: 0, dy: 1, body, closing: true, engineBeats: false },
        forecast: impact(1.2, 'surface', { kind: 'radial', dx: 0, dy: -1, verified: true }),
        pois: [poi('anomaly-1', 'anomaly', { hazard: 'minefield', resource: 'Iridium', required: true }), poi('salvage-1', 'salvage')],
        survey: { remaining: 3, onSensors: 1, seen: 1, nearest: { dx: 100, dy: 0, distance: 100 }, complete: false },
        route: { cells: 1, cheapest: 2, dearest: 4 },
        jammed: false,
        emptyMagazines: ['Nuke'],
      });
    const seen: string[] = [];
    let s = EMPTY_ADVISOR;
    for (let i = 0; i < 120; i++) {
      s = evaluateAdvice(s, rich(200 + i * 12), crew, 'all');
      for (const a of [s.current?.advice, ...s.queue].filter((x) => x !== undefined)) {
        expect(Object.keys(a).sort()).toEqual(['id', 'key', 'level', 'source', 'speaker', 'text', 'topic']);
        for (const v of Object.values(a)) expect(typeof v).toBe('string');
        expect(a.text.length).toBeGreaterThan(10);
        expect(a.text.length).toBeLessThanOrEqual(240);
        if (!seen.includes(a.id)) seen.push(a.id);
      }
      const v = advisorView(s);
      if (v) expect(Object.keys(v).sort()).toEqual(['id', 'level', 'serial', 'source', 'speaker', 'text']);
    }
    // and every rule, one scenario each, produces a well-formed message
    const navC = crewWith({ nav: A(3, 4, 3) });
    const surC = crewWith({ sur: A(3, 3, 3) });
    const corona = { id: 's', label: 'Sol', kind: 'star' as const, outX: 0, outY: -1 };
    const scenarios: [Partial<Observation>, AdvisorCrew][] = [
      [{ hull: 0.2 }, NO_CREW],
      [{ shield: 0, combat: 'alert' }, NO_CREW],
      [{ forecast: impact(1.5) }, NO_CREW],
      [{ inCorona: corona }, NO_CREW],
      [{ gravity: { share: 0.25, dx: 1, dy: 0, body, closing: true, engineBeats: true } }, NO_CREW],
      [{ contacts: { count: 1, nearest: { dx: 1, dy: 0, distance: 1 } } }, NO_CREW],
      [{ pois: [poi('anomaly-1', 'anomaly')] }, NO_CREW],
      [{ emptyMagazines: ['Nuke'] }, NO_CREW],
      [{ forecast: impact(3) }, navC],
      [{ inCorona: corona }, navC],
      [{ gravity: { share: 0.15, dx: 1, dy: 0, body, closing: false, engineBeats: true } }, navC],
      [{ flightMode: 'realistic', stop: 'cannot' }, navC],
      [{ route: { cells: 4, cheapest: 1, dearest: 2 } }, navC],
      [{ pois: [poi('anomaly-1', 'anomaly')] }, surC],
      [{ survey: { remaining: 2, onSensors: 1, seen: 1, nearest: { dx: 1, dy: 0, distance: 1 }, complete: false } }, surC],
      [{ jammed: true }, surC],
      [{ survey: { remaining: 2, onSensors: 0, seen: 0, nearest: null, complete: false } }, surC],
      [{ survey: { remaining: 0, onSensors: 0, seen: 3, nearest: null, complete: true } }, surC],
    ];
    const all = new Set<string>();
    for (const [o, c] of scenarios) {
      const st = evaluateAdvice(EMPTY_ADVISOR, O({ tick: 200, ...o }), c, 'all');
      for (const a of [st.current?.advice, ...st.queue].filter((x) => x !== undefined)) {
        expect(Object.keys(a).sort()).toEqual(['id', 'key', 'level', 'source', 'speaker', 'text', 'topic']);
        expect(a.text.length).toBeLessThanOrEqual(240);
        all.add(a.id);
      }
    }
    expect([...all].sort()).toEqual([...RULE_IDS].sort());
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });

  it('never writes its input: a deeply frozen observation and crew work, and are unchanged', () => {
    const crew = deepFreeze(crewWith({ nav: A(3, 3, 3), sur: A(3, 3, 3) }));
    const o = deepFreeze(O({ tick: 200, hull: 0.2, forecast: impact(2), pois: [poi('anomaly-1', 'anomaly')], gravity: { share: 0.25, dx: 1, dy: 0, body, closing: true, engineBeats: true } }));
    const before = JSON.stringify([o, crew]);
    const s0 = deepFreeze(play([O({ tick: 100 })])[0]!);
    expect(() => evaluateAdvice(s0, o, crew, 'all')).not.toThrow();
    expect(JSON.stringify([o, crew])).toBe(before);
  });

  it('is deterministic: the same observations give the same messages, byte for byte', () => {
    const seq = over(80, (t, i) => O({ tick: t, hull: i > 40 ? 0.2 : 1, pois: i > 10 ? [poi('anomaly-1', 'anomaly'), poi('derelict-1', 'derelict')] : [], forecast: i % 17 === 0 ? impact(1.8) : null }));
    const crew = crewWith({ nav: A(3, 4, 3), sur: A(4, 3, 3) });
    expect(JSON.stringify(play(seq, crew))).toBe(JSON.stringify(play(seq, crew)));
  });
});

/* ============================================================== Navigator */

describe('Navigator advice (P05.2)', () => {
  const nav = crewWith({ nav: A(3, 4, 3) });

  it('warns of a forecast collision earlier than the Ship Mind, names the escape, and replaces the Ship Mind on that topic', () => {
    const esc = { kind: 'tangent' as const, dx: 1, dy: 0, verified: true };
    const st = play([O({ tick: 200, forecast: impact(3.5, 'surface', esc) }), O({ tick: 212, forecast: impact(1.4, 'surface', esc) })], nav);
    expect(st[0]!.current!.advice).toMatchObject({ id: 'nav.impact', level: 'warning', source: 'navigator', speaker: 'NAVIGATOR · MAREN SATO' });
    expect(st[0]!.current!.advice.text).toBe('Drift puts us into Ceres Test in 3.5 s with engines idle. Steer → at full thrust: the forecast clears it.');
    expect(st[1]!.current!.advice.level).toBe('critical'); // the same contact, now imminent: escalated, said once more
    expect([st[0]!, st[1]!].flatMap((s) => [s.current?.advice.id, ...s.queue.map((q) => q.id)])).not.toContain('mind.impact');
  });

  it('labels an escape it could not confirm as guidance only, and offers STOP honestly in REALISTIC', () => {
    const t = (e: NonNullable<Observation['forecast']>['escape'], mode: Observation['flightMode'] = 'normal') => play([O({ tick: 200, flightMode: mode, forecast: impact(3, 'surface', e) })], nav)[0]!.current!.advice.text;
    expect(t({ kind: 'radial', dx: 0, dy: -1, verified: false })).toMatch(/Steer ↑ at full thrust: guidance only, the forecast cannot confirm a clear line\.$/);
    expect(t({ kind: 'stop', dx: 0, dy: 0, verified: true }, 'realistic')).toMatch(/Press STOP to brake: the forecast clears it\.$/);
    expect(t({ kind: 'retro', dx: -1, dy: 0, verified: true }, 'realistic')).toMatch(/Turn to ← and burn: the forecast clears it\.$/);
  });

  it('Caution sets how early: a contact 3.2 s out is silent for Caution 1 (2.5 s) and warned by Caution 4 (4.0 s)', () => {
    const o = O({ tick: 200, forecast: impact(3.2) });
    expect(play([o], crewWith({ nav: A(3, 1, 3) }))[0]!.current).toBeNull();
    expect(play([o], crewWith({ nav: A(3, 4, 3) }))[0]!.current!.advice.id).toBe('nav.impact');
  });

  it('explains a pull the Ship Mind would not mention, with the engine comparison from the real flight model', () => {
    const g = (engineBeats: boolean, mode: Observation['flightMode']) => O({ tick: 200, flightMode: mode, gravity: { share: 0.15, dx: 0, dy: 1, body, closing: true, engineBeats } });
    expect(play([g(true, 'normal')])[0]!.current).toBeNull(); // the Ship Mind needs 20%
    expect(play([g(true, 'normal')], nav)[0]!.current!.advice.text).toBe("Ceres Test's gravity pulls us ↓ at 15% of engine thrust, and we are sinking toward it. Full thrust always out-pulls it.");
    expect(play([g(false, 'realistic')], nav)[0]!.current!.advice.text).toMatch(/It is stronger than the main engine: burn early\.$/);
  });

  it("points away from the pull when STOP can't hold (it never presses STOP itself)", () => {
    const st = play([O({ tick: 200, flightMode: 'realistic', stop: 'cannot', gravity: { share: 0.3, dx: 0, dy: 1, body, closing: false, engineBeats: false } })], nav);
    expect([st[0]!.current, ...st[0]!.queue.map((a) => ({ advice: a }))].map((x) => x!.advice.text)).toContain("STOP can't hold against this pull. Burn ↑, away from it, to climb out.");
  });

  it('gives route notes from real numbers only; safety-first skips the optional note but never the cells warning', () => {
    const r = (cells: number) => O({ tick: 200, route: { cells, cheapest: 2, dearest: 3 }, exit: { dx: 0, dy: -800, distance: 800 } });
    expect(play([r(5)], nav)[0]!.current!.advice.text).toBe('Exit beacon dead ahead (↑), near the edge of sensor range. Reactor cells 5 aboard; lanes out of here need 2 to 3.');
    expect(play([r(5)], crewWith({ nav: A(3, 4, 3), doctrine: 'safety' }))[0]!.current).toBeNull();
    expect(play([r(1)], crewWith({ nav: A(3, 4, 3), doctrine: 'safety' }))[0]!.current!.advice.text).toBe('Reactor cells: 1 aboard, but the cheapest lane out of here needs 2.');
    expect(play([O({ tick: 200, route: null })], nav)[0]!.current).toBeNull(); // no data (Admin Access): no note
  });

  it('raises no false alarm: no forecast contact, weak pull, nothing said', () => {
    const st = play(over(40, (t) => O({ tick: t, forecast: { horizonS: 4, impact: null, escape: null }, gravity: { share: 0.05, dx: 0, dy: 1, body, closing: true, engineBeats: true } })), nav);
    expect(st.every((s) => s.current === null)).toBe(true);
  });

  it('contributes only while assigned to the flown ship (unassigned, other ship and dismissed crew say nothing)', () => {
    const seated: CrewState = { hired: ['maren-sato'], paid: [], seats: { petrel: ['maren-sato'] } };
    expect(advisorCrew(shipCrewView(seated, 'petrel')).navigator?.name).toBe('Maren Sato');
    expect(advisorCrew(shipCrewView(seated, 'condor'))).toBe(NO_CREW); // aboard another ship
    expect(advisorCrew(shipCrewView({ ...seated, seats: {} }, 'petrel'))).toBe(NO_CREW); // unassigned
    expect(advisorCrew(shipCrewView(EMPTY_CREW, 'petrel'))).toBe(NO_CREW);
    // a crew change drops their pending messages at once
    const st = play([O({ tick: 200, forecast: impact(3) })], nav);
    expect(st[0]!.current!.advice.source).toBe('navigator');
    expect(evaluateAdvice(st[0]!, O({ tick: 212, forecast: impact(3) }), NO_CREW, 'all').current).toBeNull();
  });

  it('uses the first seated Navigator only (a second one is on standby, never a second voice)', () => {
    const two: CrewState = { hired: ['maren-sato', 'tobiah-renn'], paid: [], seats: { condor: ['tobiah-renn', 'maren-sato'] } };
    expect(advisorCrew(shipCrewView(two, 'condor')).navigator?.name).toBe('Tobiah Renn');
  });

  it('never touches flight: the advisor modules have no path to input, thrust, STOP, lock or weapons', () => {
    for (const f of ['crew/advisor.ts', 'crew/traits.ts', 'crew/observation.ts', 'advisor/observe.ts', 'advisor/forecast.ts']) {
      const code = readFileSync(join(root, 'src/modes/freeroam', f), 'utf8');
      expect(code, f).not.toMatch(/\b(stepSector|setRunFlightMode|updateStationKeeping|clearStationKeeping|toggleLock|switchWeapon|cycleTarget|stopToggle|lockToggle|fireMissile|interact\(|transact|withCargo|withCrew)\b/);
    }
  });
});

/* =============================================================== Surveyor */

describe('Surveyor advice (P05.2)', () => {
  it('reads a target to its Competence: kind and bearing; + reach and survey value; + main resource', () => {
    const p = [poi('anomaly-1', 'anomaly', { required: true, resource: 'Iridium' })];
    const text = (c: number) => play([O({ tick: 200, pois: p })], crewWith({ sur: A(c, 2, 3) }))[0]!.current!.advice.text;
    expect(text(1)).toBe('Phase shimmer on sensors dead ahead (↑).');
    expect(text(3)).toBe('Phase shimmer on sensors dead ahead (↑). Beyond interaction range; close in to investigate it. It counts toward the survey.');
    expect(text(5)).toBe('Phase shimmer on sensors dead ahead (↑). Beyond interaction range; close in to investigate it. It counts toward the survey. The return reads as Iridium.');
  });

  it('flags a hazard around a target only from Caution 3', () => {
    const p = [poi('cache-1', 'cache', { hazard: 'minefield', distance: 40 })];
    expect(play([O({ tick: 200, pois: p })], crewWith({ sur: A(3, 2, 3) }))[0]!.current!.advice.text).not.toMatch(/minefield/);
    expect(play([O({ tick: 200, pois: p })], crewWith({ sur: A(3, 3, 3) }))[0]!.current!.advice.text).toBe('Supply cache on sensors dead ahead (↑). In reach: open it now. Careful: it lies in a minefield.');
  });

  it('replaces the Ship Mind on a target and never repeats it (one voice per topic, once per visit)', () => {
    const sur = crewWith({ sur: A(4, 3, 3) });
    const st = play(over(40, (t) => O({ tick: t, pois: [poi('anomaly-1', 'anomaly')] })), sur);
    expect(shownIds(st)).toEqual(['sur.poi|anomaly-1']);
    // a Surveyor who joins after the Ship Mind named it does not read it again
    const first = play([O({ tick: 200, pois: [poi('anomaly-1', 'anomaly')] })]);
    const joined = play(over(20, (t) => O({ tick: t, pois: [poi('anomaly-1', 'anomaly')] }), 212), sur, 'all', first[0]!);
    expect(shownIds(joined).filter((x) => x.startsWith('sur.poi'))).toEqual([]);
  });

  it('tracks survey marks on sensors (more marks is news), says how many lie beyond range, and when none are on sensors', () => {
    const sur = crewWith({ sur: A(3, 3, 3) });
    const m = (onSensors: number, seen: number) => (t: number) => O({ tick: t, survey: { remaining: 3, onSensors, seen, nearest: onSensors ? { dx: -200, dy: 0, distance: 200 } : null, complete: false } });
    const st = play([...over(20, m(1, 1)), ...over(20, m(2, 2), 440)], sur);
    expect(shownIds(st)).toEqual(['sur.marks|1', 'sur.marks|2']);
    expect(st[0]!.current!.advice.text).toBe('1 survey mark on sensors, nearest to port (←). 2 more beyond sensor range.');
    expect(play([O({ tick: 200, survey: { remaining: 2, onSensors: 0, seen: 1, nearest: null, complete: false } })], sur)[0]!.current!.advice.text).toBe('No survey mark on sensors. 2 marks remain beyond sensor range.');
  });

  it('Focus 4+ keeps to the survey: no salvage or cache callouts while marks remain (the Ship Mind still names a cache)', () => {
    const o = (t: number) => O({ tick: t, pois: [poi('salvage-1', 'salvage'), poi('cache-1', 'cache', { distance: 500 })], survey: { remaining: 2, onSensors: 0, seen: 0, nearest: null, complete: false } });
    const focused = shownIds(play(over(60, o), crewWith({ sur: A(3, 3, 5) })));
    expect(focused.some((x) => x.startsWith('sur.poi'))).toBe(false);
    expect(focused).toContain('mind.poi|cache-1');
    expect(shownIds(play(over(60, o), crewWith({ sur: A(3, 3, 3) })))).toEqual(expect.arrayContaining(['sur.poi|salvage-1', 'sur.poi|cache-1']));
  });

  it('says when interference blinds the sensors', () => {
    expect(play([O({ tick: 200, jammed: true })], crewWith({ sur: A(3, 3, 3) }))[0]!.current!.advice.text).toBe('Interference is blinding the sensors: nothing new will show until we clear it.');
  });

  it('contributes only while assigned to the flown ship', () => {
    expect(advisorCrew(shipCrewView({ hired: ['odile-marchetti'], paid: [], seats: { magpie: ['odile-marchetti'] } }, 'petrel'))).toBe(NO_CREW);
    expect(play([O({ tick: 200, jammed: true })])[0]!.current).toBeNull(); // the Ship Mind has no jamming line of its own
  });
});

/* ============================================================== words */

describe('advisor words: bearings relative to the nose, screen arrows (P05.2)', () => {
  it('turns world offsets into nose-relative words and 8-way screen arrows (y down, headings clockwise)', () => {
    expect(bearingWords(relBearing(0, 0, -100))).toBe('dead ahead');
    expect(bearingWords(relBearing(0, 100, 0))).toBe('to starboard');
    expect(bearingWords(relBearing(0, -100, 0))).toBe('to port');
    expect(bearingWords(relBearing(0, 0, 100))).toBe('astern');
    expect(bearingWords(relBearing(Math.PI / 2, 100, 0))).toBe('dead ahead');
    expect(bearingWords(relBearing(0, 70, -70))).toBe('off the starboard bow');
    expect([arrowOf(1, 0), arrowOf(0, 1), arrowOf(-1, 0), arrowOf(0, -1), arrowOf(1, -1), arrowOf(0, 0)]).toEqual(['→', '↓', '←', '↑', '↗', '·']);
  });
});

/* ========================================== real runs: observe + forecast */

const planet = (x: number, y: number, r = 90): Landmark => ({ id: 'p', kind: 'body', style: 'rocky', x, y, r, hazardR: 0, label: 'Test world' });

function runWith(o: { landmarks?: Landmark[]; pois?: Poi[]; hazards?: SectorLayout['hazards']; mode?: 'normal' | 'realistic' } = {}): SectorRun {
  const base = arena(1);
  const L: SectorLayout = { ...base, landmarks: o.landmarks ?? [], pois: [...base.pois, ...(o.pois ?? [])], hazards: o.hazards ?? [] };
  // surveyed (as the flight tests do): an arena with no marks left would otherwise complete its survey on the first tick
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 5, ...(o.mode ? { flightMode: o.mode } : {}) });
  r.phase = 'flight';
  r.grace = 1e9;
  const cx = L.width / 2;
  const cy = L.height / 2;
  Object.assign(r.ship, { x: cx, y: cy, px: cx, py: cy, vx: 0, vy: 0, heading: 0, pheading: 0 });
  return r;
}
const opts = (o: Partial<ObserveOptions> = {}): ObserveOptions => ({ visit: 'test#1', horizonS: 5, escape: { candidates: 4, doctrine: 'balanced' }, route: null, ...o });
const IDLE_R: SectorInput = { ...realisticInput({ x: 0, y: 0 }, { x: 0, y: 0 }, null) };
const IDLE_N: SectorInput = { moveX: 0, moveY: 0 };
/** Ticks until the ship touches the body (sector/run.ts contact rule), or -1. */
function ticksToContact(r: SectorRun, input: (t: number) => SectorInput, max: number): number {
  const l = r.layout.landmarks[0]!;
  for (let t = 1; t <= max; t++) {
    stepSector(r, input(t));
    if (Math.hypot(r.ship.x - l.x, r.ship.y - l.y) <= l.r + r.tune.radius + 0.5) return t;
  }
  return -1;
}
const snapshot = (r: SectorRun): string => JSON.stringify([r.ship, r.stop, r.gravity, r.tick, r.hull, r.shield, r.arsenal, r.ammo, [...r.revealed], r.hostiles.map((a) => [a.x, a.y, a.state]), r.focus, r.flightMode, r.combat]);

describe('drift forecast on real runs: the game\'s own flight step (P05.2)', () => {
  it('REALISTIC: forecasts the contact the idle ship really makes, at the same tick, and reads the run without writing it', () => {
    const r = runWith({ mode: 'realistic' });
    const c = { x: r.ship.x, y: r.ship.y };
    const L2 = runWith({ mode: 'realistic', landmarks: [planet(c.x + 600, c.y)] });
    L2.ship.vx = 240; // drifting at the planet, engines idle
    Object.freeze(L2.ship);
    Object.freeze(L2.stop);
    const before = snapshot(L2);
    const fc = createForecaster();
    const o = observe(L2, fc, opts());
    expect(snapshot(L2)).toBe(before); // nothing written (frozen ship / STOP would have thrown)
    expect(Object.isFrozen(o)).toBe(true);
    expect(o.forecast?.impact).toMatchObject({ kind: 'surface', damaging: true, body: { id: 'p', label: 'Test world' } });
    const forecastTicks = Math.round(o.forecast!.impact!.inS * 60);
    // now let it really happen
    const live = runWith({ mode: 'realistic', landmarks: [planet(c.x + 600, c.y)] });
    live.ship.vx = 240;
    const real = ticksToContact(live, () => IDLE_R, 400);
    expect(real).toBeGreaterThan(0);
    expect(Math.abs(real - forecastTicks)).toBeLessThanOrEqual(1);
  });

  it('REALISTIC: a verified escape burn really clears the planet when the pilot flies it (STOP first)', () => {
    const mk = (): SectorRun => {
      const r = runWith({ mode: 'realistic' });
      const L = runWith({ mode: 'realistic', landmarks: [planet(r.ship.x + 700, r.ship.y)] });
      L.ship.vx = 200;
      return L;
    };
    const o = observe(mk(), createForecaster(), opts());
    expect(o.forecast?.escape).toMatchObject({ kind: 'stop', verified: true });
    const idle = mk();
    const hit = ticksToContact(idle, () => IDLE_R, 400);
    expect(hit).toBeGreaterThan(0); // without the burn it really hits (the test is not vacuous)
    expect(idle.phase).toBe('flight');
    const live = mk();
    const hull0 = live.hull;
    const contact = ticksToContact(live, (t) => (t === 1 ? { ...IDLE_R, stopToggle: true } : IDLE_R), Math.round(o.forecast!.horizonS * 60) + 60);
    expect(contact).toBe(-1);
    expect(live.hull).toBe(hull0);
  });

  it('NORMAL: an idle ship brakes before a planet; the forecast says nothing and the real run takes no damage (they agree)', () => {
    const base = runWith();
    for (const [d, v] of [[260, 340], [400, 340], [200, 250], [500, 200]] as const) {
      const mk = (): SectorRun => {
        const L = runWith({ landmarks: [planet(base.ship.x + d, base.ship.y)] });
        L.ship.vx = v;
        return L;
      };
      expect(observe(mk(), createForecaster(), opts({ horizonS: 3 })).forecast?.impact, `${d}px at ${v}px/s`).toBeNull();
      const live = mk();
      const hull0 = live.hull;
      for (let t = 0; t < 300; t++) stepSector(live, IDLE_N);
      expect(live.phase).toBe('flight');
      expect(live.hull, `${d}px at ${v}px/s`).toBe(hull0);
    }
  });

  it('NORMAL: forecasts entry into a star\'s corona that the drifting ship really makes (shield burns), and the Ship Mind says so', () => {
    const base = runWith();
    const star: Landmark = { id: 'sun', kind: 'star', style: 'yellow', x: base.ship.x + 330, y: base.ship.y, r: 60, hazardR: 200, label: 'Test sun' };
    const mk = (): SectorRun => {
      const L = runWith({ landmarks: [star] });
      L.ship.vx = 340;
      return L;
    };
    const o = observe(mk(), createForecaster(), opts({ horizonS: 2 }));
    expect(o.forecast?.impact).toMatchObject({ kind: 'corona', body: { id: 'sun' } });
    const live = mk();
    const shield0 = live.shield;
    let entered = -1;
    for (let t = 1; t <= 120 && entered < 0; t++) {
      stepSector(live, IDLE_N);
      if (Math.hypot(live.ship.x - star.x, live.ship.y - star.y) < star.hazardR) entered = t;
    }
    expect(entered).toBeGreaterThan(0);
    expect(Math.abs(entered - Math.round(o.forecast!.impact!.inS * 60))).toBeLessThanOrEqual(1);
    for (let t = 0; t < 30; t++) stepSector(live, IDLE_N);
    expect(live.shield).toBeLessThan(shield0); // the corona really burns
    expect(evaluateAdvice(EMPTY_ADVISOR, { ...o, tick: 200 }, NO_CREW, 'all').current?.advice.text).toMatch(/^Test sun's corona in [0-9.]+ s: it burns the shield\.$/);
  });

  it('states that the forecast is an engines-idle forecast (no claim about a pilot who keeps thrusting)', () => {
    // the forecast is an engines-idle forecast by definition; a pilot thrusting into a planet is the pilot's choice
    const code = readFileSync(join(root, 'src/modes/freeroam/advisor/forecast.ts'), 'utf8');
    expect(code).toMatch(/Engines idle/);
    expect(readFileSync(join(root, 'src/modes/freeroam/crew/advisor.ts'), 'utf8')).toMatch(/with engines idle/);
  });

  it('raises no false alarm: at rest far from a planet, or with no landmarks at all', () => {
    const r = runWith({ mode: 'realistic' });
    const far = runWith({ mode: 'realistic', landmarks: [planet(r.ship.x + 1500, r.ship.y)] });
    expect(observe(far, createForecaster(), opts()).forecast?.impact).toBeNull();
    expect(observe(runWith(), createForecaster(), opts()).forecast).toBeNull();
    const parked = runWith({ landmarks: [planet(r.ship.x, r.ship.y + 90 + 12)] }); // resting on the surface: a touch, not a crash
    expect(observe(parked, createForecaster(), opts()).forecast?.impact).toBeNull();
  });

  it('stays bounded: the forecast never runs past its cap, whatever horizon is asked', () => {
    const r = runWith({ mode: 'realistic' });
    const far = runWith({ mode: 'realistic', landmarks: [planet(r.ship.x + 5000, r.ship.y)] });
    far.ship.vx = 300;
    const o = observe(far, createForecaster(), opts({ horizonS: 999 }));
    expect(o.forecast?.impact).toBeNull(); // 300 px/s for at most FORECAST.maxTicks never reaches 5000 px
    expect(FORECAST.maxTicks).toBeLessThanOrEqual(360);
  });

  it('feeds the Navigator from the real pull: same body, direction and share the HUD arrow shows', () => {
    const r = runWith();
    const L = runWith({ landmarks: [planet(r.ship.x + 140, r.ship.y)] });
    stepSector(L, IDLE_N); // the run computes the pull
    const o = observe(L, createForecaster(), opts());
    expect(o.gravity.body?.id).toBe('p');
    expect(o.gravity.share).toBeCloseTo(L.gravity.g / L.tune.accel, 9);
    expect(o.gravity.dx).toBeGreaterThan(0.99);
  });
});

describe('observation: sensor-honest by construction (P05.2)', () => {
  const mark = (id: string, x: number, y: number): Poi => ({ id, kind: 'survey', x, y, r: 40, solidR: 0, label: 'Survey mark', required: true, loot: [], target: null, group: null, alertR: 0, wave: 0, tier: 0, holdTicks: 0 });
  const anomaly = (id: string, x: number, y: number): Poi => ({ ...mark(id, x, y), kind: 'anomaly', label: 'Signal echo', required: false, loot: [{ resource: 'scrap', amount: 2 } as Poi['loot'][number]] });

  it('lists only revealed targets; hidden ones appear only in the survey-marks-left count', () => {
    const r0 = runWith();
    const r = runWith({ pois: [mark('survey-1', r0.ship.x + 3000, r0.ship.y), mark('survey-2', r0.ship.x + 100, r0.ship.y), anomaly('anomaly-1', r0.ship.x + 4000, r0.ship.y)] });
    r.surveyed = false; // a fresh visit: only what the sensors picked up is known
    r.revealed.clear();
    r.revealed.add('survey-2');
    const o = observe(r, createForecaster(), opts());
    expect(o.pois.map((p) => p.id)).toEqual(['survey-2']);
    expect(o.survey).toMatchObject({ remaining: 2, onSensors: 1, seen: 1 });
    expect(JSON.stringify(o)).not.toMatch(/anomaly-1|survey-1/);
  });

  it('counts hostile contacts by the sector map\'s rule: sensor range, interference on either side', () => {
    const r = runWith();
    const sx = r.ship.x;
    const sy = r.ship.y;
    const sensor = r.craft.stats.sensor;
    spawnAgent(r, 'raider', 'red-tally', 'probe', 'guard', sx + sensor * 0.5, sy);
    spawnAgent(r, 'raider', 'red-tally', 'probe', 'guard', sx - sensor * 1.5, sy);
    expect(observe(r, createForecaster(), opts()).contacts.count).toBe(1);
    const jam = (x: number, y: number) => [{ id: 'z', kind: 'interference' as const, x, y, r: 120, faction: null, mines: [], period: 0, label: 'Static' }];
    const inside = runWith({ hazards: jam(sx, sy) });
    spawnAgent(inside, 'raider', 'red-tally', 'probe', 'guard', sx + sensor * 0.5, sy);
    const oi = observe(inside, createForecaster(), opts());
    expect([oi.jammed, oi.contacts.count]).toEqual([true, 0]);
    const theirs = runWith({ hazards: jam(sx + sensor * 0.5, sy) });
    spawnAgent(theirs, 'raider', 'red-tally', 'probe', 'guard', sx + sensor * 0.5, sy);
    expect(observe(theirs, createForecaster(), opts()).contacts.count).toBe(0);
  });

  it('carries no reference into the run: numbers and strings only, frozen', () => {
    const r = runWith({ landmarks: [planet(100, 100)] });
    const o = observe(r, createForecaster(), opts());
    const walk = (x: unknown): void => {
      if (x && typeof x === 'object') {
        expect(Object.isFrozen(x)).toBe(true);
        expect(x).not.toBe(r.ship);
        for (const v of Object.values(x)) walk(v);
      } else expect(['number', 'string', 'boolean'].includes(typeof x) || x === null).toBe(true);
    };
    walk(o);
  });

  it('reads Admin Access ammunition as never empty, and real empty magazines by name', () => {
    const r = runWith();
    r.arsenal = { ...r.arsenal, rotation: ['plasma', 'nuke'] } as typeof r.arsenal;
    r.ammo['nuke'] = 0;
    expect(observe(r, createForecaster(), opts()).emptyMagazines).toEqual(['Nuke']);
    r.unlimitedAmmo = true;
    expect(observe(r, createForecaster(), opts()).emptyMagazines).toEqual([]);
  });

  it('does not change the next simulation step (an observed run and an unobserved run stay identical)', () => {
    const c = runWith();
    const a = runWith({ mode: 'realistic', landmarks: [planet(c.ship.x + 500, c.ship.y + 50)] });
    const b = runWith({ mode: 'realistic', landmarks: [planet(c.ship.x + 500, c.ship.y + 50)] });
    a.ship.vx = b.ship.vx = 150;
    const fc = createForecaster();
    for (let t = 0; t < 240; t++) {
      if (t % 12 === 0) observe(a, fc, opts());
      stepSector(a, IDLE_R);
      stepSector(b, IDLE_R);
    }
    expect(snapshot(a)).toBe(snapshot(b));
    expect(RUN.impactSpeed).toBeGreaterThan(0);
  });
});

/* ======================================================= doctrine + prefs */

describe('Navigator doctrine and the advice preference: saved, optional, backward compatible (P05.2)', () => {
  it('stores the doctrine only when safety-first; P05.1 crews round-trip unchanged', () => {
    const p05: CrewState = { hired: ['maren-sato'], paid: [], seats: { petrel: ['maren-sato'] } };
    expect(crewToSaved(p05)).toEqual({ hired: ['maren-sato'], paid: [], seats: { petrel: ['maren-sato'] } });
    const safe = setDoctrine(p05, 'safety');
    expect(crewToSaved(safe)).toEqual({ hired: ['maren-sato'], paid: [], seats: { petrel: ['maren-sato'] }, doctrine: 'safety' });
    expect(crewFromSaved(crewToSaved(safe), ['petrel']).state.doctrine).toBe('safety');
    expect(setDoctrine(safe, 'balanced')).toEqual(p05);
    expect(setDoctrine(p05, 'balanced')).toBe(p05);
    expect(cleanCrew({ ...p05, doctrine: 'reckless' }, ['petrel'])).toMatchObject({ changes: 1, state: p05 });
    // seats, fees and the roster are untouched by a doctrine change
    expect([safe.hired, safe.paid, safe.seats]).toEqual([p05.hired, p05.paid, p05.seats]);
  });

  it('round-trips through the profile (junk repaired, absent = balanced)', () => {
    const sanitize = (doc: Record<string, unknown>) => FREEROAM_SPEC.sanitize({ ...JSON.parse(JSON.stringify(EMPTY_PROFILE)), version: FREEROAM_VERSION, ...doc });
    const saved = JSON.parse(JSON.stringify(withCrew(EMPTY_PROFILE, { hired: ['maren-sato'], paid: [], seats: { petrel: ['maren-sato'] }, doctrine: 'safety' }))) as Record<string, unknown>;
    expect(sanitize(saved).data.crew?.doctrine).toBe('safety');
    const junk = sanitize({ crew: { hired: ['maren-sato'], paid: [], seats: {}, doctrine: 7 } });
    expect(junk.repaired).toBe(true);
    expect(junk.data.crew && 'doctrine' in junk.data.crew).toBe(false);
    const p05 = sanitize({ crew: { hired: ['maren-sato'], paid: [], seats: {} } });
    expect(p05.repaired).toBe(false);
    expect(p05.data.crew).toEqual({ hired: ['maren-sato'], paid: [], seats: {} });
  });

  it('keeps ALL ADVICE as the default; only CRITICAL ONLY is stored; older control saves read unchanged', () => {
    expect(DEFAULT_CONTROLS.advice).toBeUndefined();
    expect(sanitizeControls({ ...DEFAULT_CONTROLS, advice: 'critical' })).toMatchObject({ controls: { advice: 'critical' }, repaired: false });
    const old = sanitizeControls({ bindings: DEFAULT_CONTROLS.bindings, mouseAim: false, zoom: 1, flightMode: 'normal' });
    expect(old.repaired).toBe(false);
    expect('advice' in old.controls).toBe(false);
    expect(sanitizeControls({ ...DEFAULT_CONTROLS, advice: 'loud' })).toMatchObject({ repaired: true });
  });

  it('shows the doctrine on the Bridge once a Navigator signs on, with duty status per seat', () => {
    const ctx = (crew: CrewState, flown: 'petrel' | 'condor' = 'petrel'): BridgeContext => ({
      ship: 'petrel',
      flown,
      crew,
      world: { docked: 'milky-way/sol', safe: true, owned: ['petrel', 'condor'], requirementMet: () => true, missionDone: () => true, rescues: 1 },
      balance: 0,
      free: false,
      describe: () => ({ detail: '', met: true }),
      stationName: (id) => id,
    });
    expect(bridgeModel(ctx(EMPTY_CREW)).doctrine).toBeNull();
    const c: CrewState = { hired: ['maren-sato', 'brask-ottley'], paid: [], seats: { petrel: ['maren-sato', 'brask-ottley'] } };
    const m = bridgeModel(ctx(c));
    expect(m.doctrine).toMatchObject({ value: 'balanced', next: 'safety', label: 'BALANCED' });
    expect(m.seatCards.map((s) => [s.onDuty, s.status])).toEqual([
      [true, 'ON DUTY · gravity watch, pull reading, route notes'],
      [false, 'NO FLIGHT DUTY YET · planned for a later update'],
    ]);
    expect(bridgeModel(ctx(c, 'condor')).seatCards[0]!.status).toBe('ADVISES WHEN THE PETREL IS FLOWN');
    expect(m.seatCards[0]!.member!.traits.length).toBe(3);
    expect(CREW_BY_ID.get('maren-sato')!.attributes).toEqual({ competence: 3, caution: 4, focus: 3 });
  });
});
