/**
 * Ship Mind and crew advisory (P05.2): one advisory system for the ship's
 * own Ship Mind and the assigned Navigator and Surveyor. Pure and
 * deterministic: no DOM, no clock (time is the observation's tick), no
 * randomness, no storage. Input: a frozen Observation (crew/observation.ts),
 * the crew on duty (from the frozen ShipCrewView) and the pilot's advice
 * preference. Output: a new AdvisorState holding at most one message to show.
 * Nothing here can steer, thrust, brake, fire, switch weapons, lock, pay or
 * save: the only product is text with a level and a source.
 *
 * Rules (RULES below). Each message kind has a stable id, a condition read
 * from the observation, a level, a suppression policy, a template and its
 * parameters:
 *  - 'transition': said when the condition starts (or its key escalates:
 *    more contacts, a lower hull band, an imminent contact); never repeated
 *    while it holds; after it clears it re-arms only after `rearmTicks`
 *    (a flicker at the threshold does not repeat it);
 *  - 'visit': said once per key per sector visit (a target, a magazine).
 *
 * Levels: critical > warning > info > optional. The highest new message is
 * shown; a higher one interrupts a lower one at once; equal or lower ones
 * wait in a short queue (ADVISOR.queueMax) and are dropped if their
 * condition has ended by their turn. A shown message is withdrawn as soon as
 * its condition ends (hull repaired, the drift no longer meets the planet).
 *
 * One topic, one voice: a specialist on duty supersedes the Ship Mind on the
 * same topic (the Navigator's impact warning replaces the Ship Mind's, the
 * Surveyor's reading of a target replaces the Ship Mind's sensor note), and
 * the two specialists never share a topic, so nobody repeats anyone.
 *
 * Quiet by design: nothing non-urgent in the first seconds of a visit, while
 * a fight is engaged (info and optional wait for calm) or while a decision
 * prompt is open; a specialist holds a topic for their Focus time before
 * raising another non-urgent one. "Critical only" consumes everything below
 * critical silently (it is not saved up for later).
 */
import { holdTicksFor, navigatorTraits, SHIP_MIND, surveyorTraits, type NavigatorTraits, type SurveyorTraits } from './traits.ts';
import type { NavDoctrine } from './types.ts';
import type { Observation, ObservedPoi, Offset } from './observation.ts';
import { memberWithRole, type ShipCrewView } from './view.ts';

/* -------------------------------------------------------------- vocabulary */

export const ADVICE_LEVELS = ['optional', 'info', 'warning', 'critical'] as const;
export type AdviceLevel = (typeof ADVICE_LEVELS)[number];
const RANK: Readonly<Record<AdviceLevel, number>> = { optional: 0, info: 1, warning: 2, critical: 3 };

export const ADVICE_SOURCES = ['mind', 'navigator', 'surveyor'] as const;
export type AdviceSource = (typeof ADVICE_SOURCES)[number];

export type AdviceMode = 'all' | 'critical';

/** One message: text plus where it came from and how urgent it is. Nothing executable. */
export interface Advice {
  /** Rule id (stable). */
  readonly id: string;
  /** Condition identity (a body id, a target id, a count band). */
  readonly key: string;
  readonly topic: string;
  readonly level: AdviceLevel;
  readonly source: AdviceSource;
  /** "SHIP MIND" or "NAVIGATOR · MAREN SATO". */
  readonly speaker: string;
  readonly text: string;
}

export const ADVISOR = Object.freeze({
  /** Evaluate this often (ticks) in flight; events can ask for an earlier pass. */
  everyTicks: 12,
  /** Nothing below warning in the first ticks of a visit (arrival notices have the stage). */
  settleTicks: 90,
  queueMax: 3,
  /** Visit-policy keys remembered per visit (bounded). */
  saidMax: 64,
  /** Display time by level (ticks). */
  showTicks: Object.freeze({ critical: 330, warning: 300, info: 270, optional: 220 } satisfies Record<AdviceLevel, number>),
});

/* ------------------------------------------------------------- crew on duty */

export interface OnDuty<T> {
  readonly name: string;
  readonly traits: T;
}

/** The specialists the advisor may speak for: the first Navigator and Surveyor seated on the flown ship. */
export interface AdvisorCrew {
  /** Identity (ship, members on duty, doctrine): a change drops their pending messages. */
  readonly key: string;
  readonly navigator: OnDuty<NavigatorTraits> | null;
  readonly surveyor: OnDuty<SurveyorTraits> | null;
}

export const NO_CREW: AdvisorCrew = Object.freeze({ key: 'solo', navigator: null, surveyor: null });

/** Read the crew on duty from the frozen view of the flown ship (crew on other ships never count). */
export function advisorCrew(v: ShipCrewView, doctrine: NavDoctrine = 'balanced'): AdvisorCrew {
  const nav = memberWithRole(v, 'navigator');
  const sur = memberWithRole(v, 'surveyor');
  if (!nav && !sur) return NO_CREW;
  return Object.freeze({
    key: `${v.ship}|${nav?.id ?? '-'}|${sur?.id ?? '-'}|${doctrine}`,
    navigator: nav ? Object.freeze({ name: nav.name, traits: navigatorTraits(nav.attributes, doctrine) }) : null,
    surveyor: sur ? Object.freeze({ name: sur.name, traits: surveyorTraits(sur.attributes) }) : null,
  });
}

/* ------------------------------------------------------------------- words */

const TAU = Math.PI * 2;
const wrap = (a: number): number => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

/** Bearing of a world offset relative to the nose (radians, + = starboard / clockwise). */
export const relBearing = (heading: number, dx: number, dy: number): number => wrap(Math.atan2(dx, -dy) - heading);

/** Nose-relative words for a bearing. */
export function bearingWords(rel: number): string {
  const a = Math.abs(wrap(rel)) * (180 / Math.PI);
  const side = rel >= 0 ? 'starboard' : 'port';
  if (a <= 25) return 'dead ahead';
  if (a <= 70) return `off the ${side} bow`;
  if (a <= 110) return `to ${side}`;
  if (a <= 155) return `off the ${side} quarter`;
  return 'astern';
}

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'] as const;
/** Eight-way screen arrow for a world direction (y down), as on the HUD's nearby chip. */
export function arrowOf(dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return '·';
  const i = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  return ARROWS[i]!;
}

/** Distance in words, against the ship's own sensor range. */
export function rangeWords(d: number, sensor: number): string {
  if (sensor <= 0) return 'nearby';
  if (d < sensor * 0.4) return 'close';
  if (d < sensor * 0.75) return 'at mid range';
  return 'near the edge of sensor range';
}

const where = (o: Offset, obs: Observation): string => `${bearingWords(relBearing(obs.heading, o.dx, o.dy))} (${arrowOf(o.dx, o.dy)})`;
const secs = (s: number): string => (s < 10 ? s.toFixed(1) : String(Math.round(s)));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const pct = (f: number): number => Math.max(0, Math.min(100, Math.floor(f * 100)));

/* ------------------------------------------------------------------- rules */

interface Ctx {
  readonly obs: Observation;
  readonly crew: AdvisorCrew;
}

/** A condition that holds now: its key, optional level override, the template's parameters and an optional topic override. */
interface Hit<P> {
  readonly key: string;
  readonly params: P;
  readonly level?: AdviceLevel | undefined;
  readonly topic?: string | undefined;
}

interface Rule<P> {
  readonly id: string;
  readonly source: AdviceSource;
  readonly topic: string;
  readonly level: AdviceLevel;
  readonly policy: 'transition' | 'visit';
  /** Transition rules: ticks after the condition clears before it can be said again. */
  readonly rearmTicks: number;
  /** Transition rules: does a key change deserve a new message? (default: yes) */
  readonly escalates?: ((prev: string, next: string, c: Ctx) => boolean) | undefined;
  readonly when: (c: Ctx) => Hit<P> | readonly Hit<P>[] | null;
  readonly template: (p: P, c: Ctx) => string;
}

type AnyRule = Rule<any>;
const rule = <P>(r: Rule<P>): AnyRule => r;

const nav = (c: Ctx): NavigatorTraits | null => c.crew.navigator?.traits ?? null;
const sur = (c: Ctx): SurveyorTraits | null => c.crew.surveyor?.traits ?? null;

/** Escape advice in words (honest about whether the forecast confirmed it). */
function escapeText(c: Ctx): string {
  const e = c.obs.forecast?.escape;
  if (!e) return 'Steer clear.';
  if (e.kind === 'stop') return e.verified ? 'Press STOP to brake: the forecast clears it.' : 'STOP brakes hardest, but the forecast cannot confirm we stop in time.';
  const how = c.obs.flightMode === 'realistic' ? `Turn to ${arrowOf(e.dx, e.dy)} and burn` : `Steer ${arrowOf(e.dx, e.dy)} at full thrust`;
  return e.verified ? `${how}: the forecast clears it.` : `${how}: guidance only, the forecast cannot confirm a clear line.`;
}

const HAZARD_WORDS: Readonly<Record<NonNullable<ObservedPoi['hazard']>, string>> = { minefield: 'a minefield', eruption: 'an eruption field', interference: 'sensor interference' };

export const RULES: readonly AnyRule[] = Object.freeze([
  /* ---------------------------------------------------------- Ship Mind */
  rule<{ pct: number; calm: boolean }>({
    id: 'mind.hull',
    source: 'mind',
    topic: 'hull',
    level: 'critical',
    policy: 'transition',
    rearmTicks: 600,
    escalates: (prev, next) => prev === 'low' && next === 'severe',
    when: ({ obs }) => (obs.hull < SHIP_MIND.hullLow ? { key: obs.hull < SHIP_MIND.hullSevere ? 'severe' : 'low', params: { pct: pct(obs.hull), calm: obs.combat === 'calm' } } : null),
    template: (p) => `Hull at ${p.pct}%. ${p.calm ? 'Dock at a station to repair it.' : 'Break off if you can: docking repairs the hull.'}`,
  }),
  rule<null>({
    id: 'mind.shield',
    source: 'mind',
    topic: 'shield',
    level: 'warning',
    policy: 'transition',
    rearmTicks: 900,
    when: ({ obs }) => (obs.shield <= SHIP_MIND.shieldDown && obs.combat !== 'calm' ? { key: 'down', params: null } : null),
    template: () => 'Shield down: hits now strike the hull.',
  }),
  rule<{ label: string; s: number }>({
    id: 'mind.impact',
    source: 'mind',
    topic: 'impact',
    level: 'critical',
    policy: 'transition',
    rearmTicks: 300,
    when: ({ obs }) => {
      const i = obs.forecast?.impact;
      return i && i.kind === 'surface' && i.damaging && i.inS <= SHIP_MIND.impactHorizonS ? { key: i.body.id, params: { label: i.body.label, s: i.inS } } : null;
    },
    template: (p) => `Collision course: ${p.label} in ${secs(p.s)} s. Steer away.`,
  }),
  rule<{ label: string; s: number | null }>({
    id: 'mind.corona',
    source: 'mind',
    topic: 'corona',
    level: 'warning',
    policy: 'transition',
    rearmTicks: 600,
    when: ({ obs }) => {
      if (obs.inCorona) return { key: `in:${obs.inCorona.id}`, params: { label: obs.inCorona.label, s: null } };
      const i = obs.forecast?.impact;
      return i && i.kind === 'corona' && i.inS <= SHIP_MIND.impactHorizonS ? { key: `ahead:${i.body.id}`, params: { label: i.body.label, s: i.inS } } : null;
    },
    template: (p) => (p.s === null ? `Inside ${p.label}'s corona: the shield is burning. Pull clear.` : `${p.label}'s corona in ${secs(p.s)} s: it burns the shield.`),
  }),
  rule<{ label: string; arrow: string }>({
    id: 'mind.gravity',
    source: 'mind',
    topic: 'gravity',
    level: 'info',
    policy: 'transition',
    rearmTicks: 1200,
    when: ({ obs }) => {
      const g = obs.gravity;
      return g.body && g.share >= SHIP_MIND.strongShare && g.closing ? { key: g.body.id, params: { label: g.body.label, arrow: arrowOf(g.dx, g.dy) } } : null;
    },
    template: (p) => `Strong pull from ${p.label}: it draws us ${p.arrow}.`,
  }),
  rule<{ n: number; where: string }>({
    id: 'mind.contacts',
    source: 'mind',
    topic: 'contacts',
    level: 'warning',
    policy: 'transition',
    rearmTicks: 600,
    // more contacts is news; fewer is not, and nor is anything while a fight is already engaged (the combat banner has it)
    escalates: (prev, next, c) => c.obs.combat !== 'engaged' && Number(next) > Number(prev),
    when: ({ obs }) => (obs.contacts.count > 0 && obs.contacts.nearest ? { key: String(obs.contacts.count), params: { n: obs.contacts.count, where: where(obs.contacts.nearest, obs) } } : null),
    template: (p) => `${plural(p.n, 'hostile contact')} on sensors, nearest ${p.where}.`,
  }),
  rule<{ poi: ObservedPoi; where: string }>({
    id: 'mind.poi',
    source: 'mind',
    topic: 'poi',
    level: 'info',
    policy: 'visit',
    rearmTicks: 0,
    when: ({ obs }) =>
      obs.pois
        .filter((p) => p.kind === 'anomaly' || p.kind === 'derelict' || p.kind === 'cache' || p.kind === 'installation')
        .map((p) => ({ key: p.id, topic: `poi:${p.id}`, level: p.kind === 'installation' ? ('warning' as const) : undefined, params: { poi: p, where: where(p, obs) } })),
    template: (p) => `Sensors: ${p.poi.label} ${p.where}.${p.poi.kind === 'installation' ? ' Installations raise the alarm when approached.' : ''}`,
  }),
  rule<{ name: string }>({
    id: 'mind.magazine',
    source: 'mind',
    topic: 'magazine',
    level: 'info',
    policy: 'visit',
    rearmTicks: 0,
    when: ({ obs }) => obs.emptyMagazines.map((name) => ({ key: name, params: { name } })),
    template: (p) => `${p.name} magazine empty. Docking at a station restocks it.`,
  }),

  /* ---------------------------------------------------------- Navigator */
  rule<{ label: string; s: number }>({
    id: 'nav.impact',
    source: 'navigator',
    topic: 'impact',
    level: 'warning',
    policy: 'transition',
    rearmTicks: 300,
    escalates: (prev, next) => prev.split(':')[0] !== next.split(':')[0] || (prev.endsWith(':w') && next.endsWith(':c')),
    when: (c) => {
      const t = nav(c);
      const i = c.obs.forecast?.impact;
      if (!t || !i || i.kind !== 'surface' || !i.damaging || i.inS > t.horizonS) return null;
      const critical = i.inS <= 1.5;
      return { key: `${i.body.id}:${critical ? 'c' : 'w'}`, level: critical ? 'critical' : 'warning', params: { label: i.body.label, s: i.inS } };
    },
    template: (p, c) => `Drift puts us into ${p.label} in ${secs(p.s)} s with engines idle. ${escapeText(c)}`,
  }),
  rule<{ label: string; s: number | null; out: string }>({
    id: 'nav.corona',
    source: 'navigator',
    topic: 'corona',
    level: 'warning',
    policy: 'transition',
    rearmTicks: 600,
    when: (c) => {
      const t = nav(c);
      if (!t) return null;
      const k = c.obs.inCorona;
      if (k) return { key: `in:${k.id}`, params: { label: k.label, s: null, out: arrowOf(k.outX, k.outY) } };
      const i = c.obs.forecast?.impact;
      return i && i.kind === 'corona' && i.inS <= t.horizonS ? { key: `ahead:${i.body.id}`, params: { label: i.body.label, s: i.inS, out: '' } } : null;
    },
    // straight out along the radius is the shortest way out of a circle (geometry, not a forecast)
    template: (p, c) => (p.s === null ? `Inside ${p.label}'s corona: the shield is burning. Head ${p.out}, straight out, to clear it.` : `Drift carries us into ${p.label}'s corona in ${secs(p.s)} s. ${escapeText(c)}`),
  }),
  rule<{ label: string; arrow: string; share: number; closing: boolean; realistic: boolean; beats: boolean }>({
    id: 'nav.gravity',
    source: 'navigator',
    topic: 'gravity',
    level: 'info',
    policy: 'transition',
    rearmTicks: 1200,
    when: (c) => {
      const t = nav(c);
      const g = c.obs.gravity;
      if (!t || !g.body || g.share < t.pullShare) return null;
      return { key: g.body.id, params: { label: g.body.label, arrow: arrowOf(g.dx, g.dy), share: g.share, closing: g.closing, realistic: c.obs.flightMode === 'realistic', beats: g.engineBeats } };
    },
    template: (p) =>
      `${p.label}'s gravity pulls us ${p.arrow} at ${pct(p.share)}% of engine thrust${p.closing ? ', and we are sinking toward it' : ''}. ${
        p.realistic ? (p.beats ? 'The main engine out-pulls it.' : 'It is stronger than the main engine: burn early.') : 'Full thrust always out-pulls it.'
      }`,
  }),
  rule<{ arrow: string }>({
    id: 'nav.stop',
    source: 'navigator',
    topic: 'stop',
    level: 'warning',
    policy: 'transition',
    rearmTicks: 600,
    when: (c) => {
      const g = c.obs.gravity;
      return nav(c) && c.obs.flightMode === 'realistic' && c.obs.stop === 'cannot' ? { key: 'cannot', params: { arrow: arrowOf(-g.dx, -g.dy) } } : null;
    },
    template: (p) => `STOP can't hold against this pull. Burn ${p.arrow}, away from it, to climb out.`,
  }),
  rule<{ short: boolean; cells: number; cheapest: number; dearest: number; exit: string }>({
    id: 'nav.route',
    source: 'navigator',
    topic: 'route',
    level: 'optional',
    policy: 'visit',
    rearmTicks: 0,
    when: (c) => {
      const t = nav(c);
      const r = c.obs.route;
      if (!t || !r || r.dearest <= 0 || c.obs.combat !== 'calm') return null;
      const short = r.cells < r.cheapest;
      if (!short && !t.routeNotes) return null;
      if (!short && t.coreFirst && (c.obs.forecast?.impact || c.obs.gravity.share >= t.pullShare)) return null; // focus: the hazard first
      const exit = c.obs.exit ? `Exit beacon ${where(c.obs.exit, c.obs)}, ${rangeWords(c.obs.exit.distance, c.obs.sensorRange)}. ` : '';
      return { key: short ? 'short' : 'note', level: short ? 'info' : 'optional', params: { short, cells: r.cells, cheapest: r.cheapest, dearest: r.dearest, exit } };
    },
    template: (p) => {
      const need = p.cheapest === p.dearest ? `${p.cheapest}` : `${p.cheapest} to ${p.dearest}`;
      return p.short ? `Reactor cells: ${p.cells} aboard, but the cheapest lane out of here needs ${p.cheapest}.` : `${p.exit}Reactor cells ${p.cells} aboard; lanes out of here need ${need}.`;
    },
  }),

  /* ----------------------------------------------------------- Surveyor */
  rule<{ poi: ObservedPoi; where: string; t: SurveyorTraits }>({
    id: 'sur.poi',
    source: 'surveyor',
    topic: 'poi',
    level: 'info',
    policy: 'visit',
    rearmTicks: 0,
    when: (c) => {
      const t = sur(c);
      if (!t) return null;
      const busy = t.coreFirst && c.obs.survey.remaining > 0;
      return c.obs.pois
        .filter((p) => p.kind !== 'survey' && !(busy && (p.kind === 'salvage' || p.kind === 'cache')))
        .map((p) => ({ key: p.id, topic: `poi:${p.id}`, level: p.kind === 'installation' ? ('warning' as const) : undefined, params: { poi: p, where: where(p, c.obs), t } }));
    },
    template: (p) => {
      const q = p.poi;
      const verb = q.verb.toLowerCase();
      let s = `${q.label} on sensors ${p.where}.`;
      if (p.t.detail >= 2) {
        s += q.distance <= q.reach ? (q.auto ? ` In reach: fly through to ${verb} it.` : ` In reach: ${verb} it now.`) : ` Beyond interaction range; close in to ${verb} it.`;
        if (q.required) s += ' It counts toward the survey.';
      }
      if (p.t.detail >= 3 && q.resource) s += ` The return reads as ${q.resource}.`;
      if (q.kind === 'installation') s += ' It raises the alarm when approached.';
      if (p.t.hazardNotes && q.hazard) s += ` Careful: it lies in ${HAZARD_WORDS[q.hazard]}.`;
      return s;
    },
  }),
  rule<{ n: number; beyond: number; where: string }>({
    id: 'sur.marks',
    source: 'surveyor',
    topic: 'marks',
    level: 'info',
    policy: 'transition',
    rearmTicks: 0,
    escalates: (prev, next) => Number(next) > Number(prev),
    when: (c) => {
      const s = c.obs.survey;
      return sur(c) && s.onSensors > 0 && s.nearest ? { key: String(s.seen), params: { n: s.onSensors, beyond: Math.max(0, s.remaining - s.onSensors), where: where(s.nearest, c.obs) } } : null;
    },
    template: (p) => `${plural(p.n, 'survey mark')} on sensors, nearest ${p.where}.${p.beyond > 0 ? ` ${p.beyond} more beyond sensor range.` : ''}`,
  }),
  rule<null>({
    id: 'sur.jammed',
    source: 'surveyor',
    topic: 'jammed',
    level: 'info',
    policy: 'transition',
    rearmTicks: 1200,
    when: (c) => (sur(c) && c.obs.jammed ? { key: 'jammed', params: null } : null),
    template: () => 'Interference is blinding the sensors: nothing new will show until we clear it.',
  }),
  rule<{ remaining: number }>({
    id: 'sur.none',
    source: 'surveyor',
    topic: 'marks',
    level: 'optional',
    policy: 'transition',
    rearmTicks: 1800,
    when: (c) => {
      const s = c.obs.survey;
      return sur(c) && !s.complete && s.remaining > 0 && s.onSensors === 0 && !c.obs.jammed ? { key: String(s.remaining), params: { remaining: s.remaining } } : null;
    },
    template: (p) => `No survey mark on sensors. ${plural(p.remaining, 'mark')} ${p.remaining === 1 ? 'remains' : 'remain'} beyond sensor range.`,
  }),
  rule<null>({
    id: 'sur.complete',
    source: 'surveyor',
    topic: 'marks',
    level: 'optional',
    policy: 'visit',
    rearmTicks: 0,
    when: (c) => (sur(c) && c.obs.survey.complete && c.obs.pois.length === 0 ? { key: 'complete', params: null } : null),
    template: () => 'Survey complete. No new survey targets detected.',
  }),
] satisfies AnyRule[]);

export const RULE_IDS: readonly string[] = Object.freeze(RULES.map((r) => r.id));
const RULE_BY_ID: ReadonlyMap<string, AnyRule> = new Map(RULES.map((r) => [r.id, r]));
const RULE_INDEX: ReadonlyMap<string, number> = new Map(RULES.map((r, i) => [r.id, i]));

/* ------------------------------------------------------------------- state */

export interface Shown {
  readonly advice: Advice;
  readonly at: number;
  readonly until: number;
}

export interface AdvisorState {
  readonly sector: string;
  readonly lastTick: number;
  readonly crewKey: string;
  /** Transition rules: the key said (or silently taken) while the condition holds. */
  readonly held: Readonly<Record<string, string>>;
  /** Transition rules: tick the condition last ended. */
  readonly clearedAt: Readonly<Record<string, number>>;
  /** Visit rules: `${topic}|${key}` already said this visit (bounded). */
  readonly said: readonly string[];
  readonly current: Shown | null;
  readonly queue: readonly Advice[];
  /** Per specialist: the topic and tick they last spoke (Focus hold). */
  readonly lastSpoke: Readonly<Partial<Record<AdviceSource, { readonly topic: string; readonly tick: number }>>>;
  /** Changes whenever the shown message changes (the view keys on it). */
  readonly serial: number;
  /** Messages shown since the mode opened (QA). */
  readonly shownCount: number;
  /**
   * P05.3: the message on screen when a panel (pause, map) opened. On the next
   * pass in flight it is re-evaluated once: shown again (fresh words) if its
   * condition still holds, otherwise forgotten. One message only; never a queue.
   */
  readonly parked: { readonly id: string; readonly key: string } | null;
  /**
   * P05.3: transition rules consumed silently under CRITICAL ONLY while their
   * condition still holds. Back on ALL ADVICE, the single most urgent of them is
   * announced once; the rest stay quiet (no backlog). Bounded by the rule count.
   */
  readonly muted: readonly string[];
}

export const EMPTY_ADVISOR: AdvisorState = Object.freeze({ sector: '', lastTick: -1, crewKey: 'solo', held: Object.freeze({}), clearedAt: Object.freeze({}), said: Object.freeze([]), current: null, queue: Object.freeze([]), lastSpoke: Object.freeze({}), serial: 0, shownCount: 0, parked: null, muted: Object.freeze([]) });

/** What the HUD strip shows (null = nothing). */
export interface AdvisorView {
  readonly serial: number;
  readonly id: string;
  readonly level: AdviceLevel;
  readonly source: AdviceSource;
  readonly speaker: string;
  readonly text: string;
}

export function advisorView(s: AdvisorState): AdvisorView | null {
  const a = s.current?.advice;
  return a ? { serial: s.serial, id: a.id, level: a.level, source: a.source, speaker: a.speaker, text: a.text } : null;
}

const speakerOf = (src: AdviceSource, crew: AdvisorCrew): string => (src === 'navigator' ? `NAVIGATOR · ${(crew.navigator?.name ?? '').toUpperCase()}` : src === 'surveyor' ? `SURVEYOR · ${(crew.surveyor?.name ?? '').toUpperCase()}` : 'SHIP MIND');
const onDuty = (src: AdviceSource, crew: AdvisorCrew): boolean => src === 'mind' || (src === 'navigator' ? crew.navigator !== null : crew.surveyor !== null);
const holdOf = (src: AdviceSource, crew: AdvisorCrew): number => (src === 'navigator' ? crew.navigator?.traits.holdTicks ?? 0 : src === 'surveyor' ? crew.surveyor?.traits.holdTicks ?? 0 : holdTicksFor(1));
const sameMsg = (a: Advice, b: Advice): boolean => a.id === b.id && a.key === b.key;
const order = (a: Advice, b: Advice): number =>
  RANK[b.level] - RANK[a.level] || Number(b.source !== 'mind') - Number(a.source !== 'mind') || (RULE_INDEX.get(a.id) ?? 0) - (RULE_INDEX.get(b.id) ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function fresh(sector: string, tick: number, crewKey: string, prev: AdvisorState): AdvisorState {
  return { ...EMPTY_ADVISOR, sector, lastTick: tick, crewKey, serial: prev.current ? prev.serial + 1 : prev.serial, shownCount: prev.shownCount };
}

/** Clear what is shown (docked, wrecked, outside flight, the run gone): nothing comes back unless its condition changes. */
export function quietAdvisor(s: AdvisorState): AdvisorState {
  return s.current || s.queue.length || s.parked ? { ...s, current: null, queue: [], parked: null, serial: s.current ? s.serial + 1 : s.serial } : s;
}

/**
 * A panel opened over flight (pause, map, controls): hide what is shown and
 * park that one message for re-evaluation when flight resumes (see
 * AdvisorState.parked). Queued messages are dropped: no backlog after a pause.
 */
export function parkAdvisor(s: AdvisorState): AdvisorState {
  if (!s.current && !s.queue.length) return s;
  const a = s.current?.advice;
  return { ...s, current: null, queue: [], parked: a ? { id: a.id, key: a.key } : s.parked, serial: s.current ? s.serial + 1 : s.serial };
}

/**
 * One advisory pass. `obs` null or not flying: nothing is shown. Pure: the
 * same inputs always give the same state.
 */
export function evaluateAdvice(s: AdvisorState, obs: Observation | null, crew: AdvisorCrew, mode: AdviceMode): AdvisorState {
  if (!obs || !obs.flying) return quietAdvisor(s);
  const tick = obs.tick;
  // a new visit (or a restart: time went back) starts over
  let st: AdvisorState = obs.sector !== s.sector || tick < s.lastTick ? fresh(obs.sector, tick, crew.key, s) : s;
  // a crew change (unassigned, dismissed, another ship, doctrine): their messages and memory go with them
  if (st.crewKey !== crew.key) {
    const keep = (a: Advice): boolean => onDuty(a.source, crew);
    const held: Record<string, string> = {};
    for (const [id, k] of Object.entries(st.held)) if (RULE_BY_ID.get(id)?.source === 'mind') held[id] = k;
    const cur = st.current && keep(st.current.advice) ? st.current : null;
    const ruleOnDuty = (id: string): boolean => {
      const src = RULE_BY_ID.get(id)?.source;
      return src !== undefined && onDuty(src, crew);
    };
    const parked = st.parked && ruleOnDuty(st.parked.id) ? st.parked : null;
    st = { ...st, crewKey: crew.key, held, current: cur, queue: st.queue.filter(keep), lastSpoke: {}, serial: cur === st.current ? st.serial : st.serial + 1, parked, muted: st.muted.filter((id) => id in held) };
  }
  const c: Ctx = { obs, crew };

  // 1. every condition that holds now (rules of crew not on duty never run)
  const hits: { rule: AnyRule; hit: Hit<unknown>; topic: string; level: AdviceLevel }[] = [];
  for (const r of RULES) {
    if (!onDuty(r.source, crew)) continue;
    const h = r.when(c);
    if (!h) continue;
    for (const x of Array.isArray(h) ? (h as readonly Hit<unknown>[]) : [h as Hit<unknown>]) hits.push({ rule: r, hit: x, topic: x.topic ?? r.topic, level: x.level ?? r.level });
  }
  // 2. one topic, one voice: a specialist's condition supersedes the Ship Mind's on that topic
  const specialistTopics = new Set(hits.filter((h) => h.rule.source !== 'mind').map((h) => h.topic));
  const live = hits.filter((h) => h.rule.source !== 'mind' || !specialistTopics.has(h.topic));
  const liveKey = new Set(live.map((h) => `${h.rule.id}|${h.hit.key}`));
  const holds = (a: Advice): boolean => liveKey.has(`${a.id}|${a.key}`);

  // 3. ended conditions: forget them (re-arm clock starts), withdraw what was about them
  const held: Record<string, string> = { ...st.held };
  const clearedAt: Record<string, number> = { ...st.clearedAt };
  const liveRules = new Set(live.map((h) => h.rule.id));
  for (const id of Object.keys(held)) {
    if (!liveRules.has(id)) {
      delete held[id];
      clearedAt[id] = tick;
    }
  }
  const muted = st.muted.filter((id) => id in held);
  // P05.3: what may be said once more although already said: the parked message (after a panel), and on
  // ALL ADVICE the most urgent condition muted under CRITICAL ONLY (still the same condition)
  const parked = st.parked;
  let unmute: string | null = null;
  if (mode === 'all' && muted.length) {
    const cand = live.filter((h) => muted.includes(h.rule.id) && held[h.rule.id] === h.hit.key);
    cand.sort((a, b) => RANK[b.level] - RANK[a.level] || RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
    unmute = cand[0]?.rule.id ?? null;
  }
  let current = st.current && holds(st.current.advice) && tick < st.current.until ? st.current : null;
  let queue = st.queue.filter(holds);
  const said = [...st.said];

  // 4. what is new
  const fresh_: { advice: Advice; mark: () => void }[] = [];
  for (const h of live) {
    const r = h.rule;
    const key = h.hit.key;
    let isNew = false;
    let mark: () => void;
    const again = (parked !== null && parked.id === r.id && parked.key === key) || unmute === r.id;
    if (r.policy === 'visit') {
      const sk = `${h.topic}|${key}`; // by topic: a target the Ship Mind called is not read again by a Surveyor who joins later
      isNew = again || !said.includes(sk);
      mark = () => {
        said.push(sk);
        if (said.length > ADVISOR.saidMax) said.splice(0, said.length - ADVISOR.saidMax);
      };
    } else {
      const prev = held[r.id];
      mark = () => {
        held[r.id] = key;
      };
      if (prev === key && !again) continue;
      if (again) isNew = true;
      else if (prev !== undefined) {
        isNew = r.escalates ? r.escalates(prev, key, c) : true;
        if (!isNew) continue; // not news (fewer contacts, back from the brink): keep the higher key, so a flicker cannot repeat it
      } else {
        const ended = clearedAt[r.id];
        if (ended !== undefined && tick - ended < r.rearmTicks) {
          held[r.id] = key; // flickered back too soon: held again without a word
          continue;
        }
        isNew = true;
      }
    }
    if (!isNew) continue;
    // "critical only": everything else is consumed silently (never saved up); a hazard condition is remembered as muted
    if (mode === 'critical' && h.level !== 'critical') {
      mark();
      if (r.policy === 'transition' && !muted.includes(r.id)) muted.push(r.id);
      continue;
    }
    // quiet times: non-urgent advice waits (unmarked, so it comes later if still true)
    if (RANK[h.level] < RANK.warning && (tick < ADVISOR.settleTicks || obs.offer)) continue;
    if (RANK[h.level] <= RANK.info && obs.combat === 'engaged') continue;
    if (r.source !== 'mind' && RANK[h.level] <= RANK.info) {
      const last = st.lastSpoke[r.source];
      if (last && last.topic !== h.topic && tick - last.tick < holdOf(r.source, crew)) continue; // Focus: finish the last topic first
    }
    fresh_.push({ advice: { id: r.id, key, topic: h.topic, level: h.level, source: r.source, speaker: speakerOf(r.source, crew), text: r.template(h.hit.params, c) }, mark });
  }
  fresh_.sort((a, b) => order(a.advice, b.advice));

  // 5. show / interrupt / queue
  let serial = st.serial;
  let shownCount = st.shownCount;
  const lastSpoke = { ...st.lastSpoke };
  const show = (a: Advice): void => {
    current = { advice: a, at: tick, until: tick + ADVISOR.showTicks[a.level] };
    serial += 1;
    shownCount += 1;
    if (a.source !== 'mind') lastSpoke[a.source] = { topic: a.topic, tick };
  };
  const pending = fresh_.slice();
  if (pending.length) {
    const top = pending[0]!;
    // same transition rule, escalated key (an imminent contact, a lower hull band): it replaces its own earlier message
    // (a visit rule's keys are different targets, never an escalation of one another)
    const update = current !== null && current.advice.id === top.advice.id && RULE_BY_ID.get(top.advice.id)?.policy === 'transition';
    if (!current || update || RANK[top.advice.level] > RANK[current.advice.level]) {
      top.mark();
      show(top.advice);
      pending.shift();
    }
  }
  if (pending.length) {
    const merged = [...queue, ...pending.map((p) => p.advice)].sort(order);
    const kept = merged.slice(0, ADVISOR.queueMax);
    for (const p of pending) if (kept.some((k) => sameMsg(k, p.advice))) p.mark(); // the rest wait unmarked for a later pass
    queue = kept;
  }
  if (!current && queue.length) {
    const ready = (a: Advice): boolean => !(RANK[a.level] <= RANK.info && obs.combat === 'engaged') && !(RANK[a.level] < RANK.warning && obs.offer);
    const next = queue.find(ready);
    if (next) {
      queue = queue.filter((a) => a !== next);
      show(next);
    }
  }
  if (current !== st.current && current === null) serial += 1; // withdrawn or expired with nothing to follow
  return { sector: st.sector, lastTick: tick, crewKey: st.crewKey, held, clearedAt, said, current, queue, lastSpoke, serial, shownCount, parked: null, muted: mode === 'all' ? [] : muted };
}
