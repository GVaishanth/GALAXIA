/**
 * Crew traits (P05.2): the one documented mapping from a crew member's
 * attributes (1..5, ATTRIBUTE_SCALE) to how they advise in flight. Pure
 * numbers: no DOM, no clock, no randomness.
 *
 * Each attribute changes one kind of behaviour, so none is a copy of
 * another (and rank changes none of them):
 *
 *   Competence = quality of the specialist's own work.
 *     Navigator: how many escape burns are checked against the drift
 *       forecast before one is named (2 / 3 / 4).
 *     Surveyor: how much a sensor contact is interpreted (1: kind and
 *       bearing; 2: + interaction reach and survey value; 3: + the main
 *       resource in the sensor return).
 *   Caution = how early and how readily a risk is raised.
 *     Navigator: forecast horizon (2.5 s .. 4.5 s ahead, always beyond the
 *       Ship Mind's 2 s) and the pull worth explaining (from the Ship Mind's
 *       20% down to 10% of the engine's thrust; safety-first: earlier still).
 *     Surveyor: from 3 up, targets lying in a minefield, eruption field or
 *       interference zone are flagged.
 *   Focus = sticking to the assigned work.
 *     Both: a non-urgent new topic waits until the specialist has held the
 *       last one for 1.5 s .. 3.5 s (urgent warnings never wait).
 *     From 4 up: core work first. A Navigator gives no route notes while a
 *       gravity hazard is live; a Surveyor skips salvage and caches while
 *       survey marks remain.
 *
 * Bounded: every value is clamped to the scale first (an out-of-range or
 * non-number attribute reads as the typical 3). A 1-1-1 crew member still
 * warns earlier than the Ship Mind and still names an escape burn, so modest
 * crew stay useful. Nothing here touches physics, damage, weapons, the
 * wallet or progression: these numbers only shape advisory text and timing.
 */
import { ATTRIBUTE_SCALE, type CrewAttributes, type NavDoctrine } from './types.ts';

/** An attribute on the 1..5 scale (rounded; anything invalid reads as the typical value). */
export function attr(v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ATTRIBUTE_SCALE.typical;
  return Math.min(ATTRIBUTE_SCALE.max, Math.max(ATTRIBUTE_SCALE.min, Math.round(v)));
}

/** The Ship Mind's fixed thresholds (it has no attributes): basic, late, never a recommendation. */
export const SHIP_MIND = Object.freeze({
  /** A damaging collision is announced this far ahead (s). */
  impactHorizonS: 2,
  /** A pull is called strong at this share of the engine's own acceleration (the field is capped at 30%). */
  strongShare: 0.2,
  /** Hull fractions: low (the HUD's critical line) and severe (announced again). */
  hullLow: 0.3,
  hullSevere: 0.15,
  /** Shield counts as down at or below this fraction. */
  shieldDown: 0.02,
});

/** Ticks per second (the fixed simulation step). */
const TPS = 60;

/** Focus -> ticks a non-urgent new topic waits after this specialist last spoke (1.5 s .. 3.5 s). */
export const holdTicksFor = (focus: number): number => Math.round((1 + 0.5 * attr(focus)) * TPS);

export interface NavigatorTraits {
  /** Drift forecast horizon (s): a damaging contact or corona entry within it is warned of. */
  readonly horizonS: number;
  /** A pull at or above this share of engine acceleration is explained. */
  readonly pullShare: number;
  /** Escape burns checked against the forecast before one is named. */
  readonly escapeCandidates: number;
  readonly holdTicks: number;
  /** Optional route notes on arrival (the cells-short warning is always given). */
  readonly routeNotes: boolean;
  /** Focus 4+: core work first (no route note while a gravity hazard is live). */
  readonly coreFirst: boolean;
  readonly doctrine: NavDoctrine;
}

export function navigatorTraits(a: CrewAttributes, doctrine: NavDoctrine = 'balanced'): NavigatorTraits {
  const c = attr(a.competence);
  const ca = attr(a.caution);
  const f = attr(a.focus);
  const safety = doctrine === 'safety';
  return Object.freeze({
    horizonS: 2.5 + 0.5 * (ca - 1) + (safety ? 1 : 0),
    pullShare: Math.max(0.06, SHIP_MIND.strongShare - 0.025 * (ca - 1) - (safety ? 0.04 : 0)),
    escapeCandidates: c <= 2 ? 2 : c <= 4 ? 3 : 4,
    holdTicks: holdTicksFor(f),
    routeNotes: !safety,
    coreFirst: f >= 4,
    doctrine: safety ? 'safety' : 'balanced',
  });
}

export interface SurveyorTraits {
  /** Interpretation depth: 1 kind + bearing, 2 + reach and survey value, 3 + main resource in the return. */
  readonly detail: 1 | 2 | 3;
  /** Caution 3+: flags targets inside minefields, eruption fields or interference. */
  readonly hazardNotes: boolean;
  readonly holdTicks: number;
  /** Focus 4+: no salvage or cache callouts while survey marks remain. */
  readonly coreFirst: boolean;
}

export function surveyorTraits(a: CrewAttributes): SurveyorTraits {
  const c = attr(a.competence);
  const ca = attr(a.caution);
  const f = attr(a.focus);
  return Object.freeze({ detail: c <= 2 ? 1 : c <= 4 ? 2 : 3, hazardNotes: ca >= 3, holdTicks: holdTicksFor(f), coreFirst: f >= 4 });
}

/**
 * P06.1 signal triangulation: a Surveyor on duty narrows the error of every
 * signal bearing the pilot takes, by this factor (competence 1: 0.9, i.e. 10%
 * tighter, down to 5: 0.6, 40% tighter). The investigation reads it through
 * the shell (sector/signal.ts bearingSpread); the pilot still takes every
 * bearing. It replaces P05.2's unused placeholder (an absolute spread of
 * 12..4 degrees), which could not combine with the ship's own sensors: a
 * competence-1 Surveyor would have been worse than flying solo.
 */
export const surveyorSpreadFactor = (a: CrewAttributes): number => (18 - 1.5 * (attr(a.competence) - 1)) / 20;

/** Plain-language lines for the Bridge: what each attribute does for this role (the mapping above, never a bonus). */
export function traitLines(role: string, a: CrewAttributes, doctrine: NavDoctrine = 'balanced'): readonly string[] {
  const hold = (t: number): string => `${(t / TPS).toFixed(1)} s`;
  if (role === 'navigator') {
    const t = navigatorTraits(a, doctrine);
    return [
      `COMPETENCE ${attr(a.competence)} · checks ${t.escapeCandidates} escape burns against the drift forecast`,
      `CAUTION ${attr(a.caution)} · warns ${t.horizonS.toFixed(1)} s ahead; explains pulls from ${Math.round(t.pullShare * 100)}% of engine thrust`,
      `FOCUS ${attr(a.focus)} · holds a topic ${hold(t.holdTicks)}${t.coreFirst ? '; no route notes during a gravity hazard' : ''}`,
    ];
  }
  if (role === 'surveyor') {
    const t = surveyorTraits(a);
    const depth = t.detail === 1 ? 'kind and bearing' : t.detail === 2 ? 'kind, bearing, reach and survey value' : 'kind, bearing, reach, survey value and main resource';
    return [
      `COMPETENCE ${attr(a.competence)} · reports ${depth}; signal bearings ${Math.round((1 - surveyorSpreadFactor(a)) * 100)}% tighter`,
      `CAUTION ${attr(a.caution)} · ${t.hazardNotes ? 'flags targets inside minefields, eruption fields or interference' : 'does not flag hazards around targets'}`,
      `FOCUS ${attr(a.focus)} · holds a topic ${hold(t.holdTicks)}${t.coreFirst ? '; skips salvage and caches while survey marks remain' : ''}`,
    ];
  }
  return [];
}
