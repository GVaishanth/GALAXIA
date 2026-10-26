/**
 * Advisor observation (P05.2): the only picture of the flight the Ship Mind
 * and the crew advisors ever see. Plain, frozen data; types only.
 *
 * It is built in one place (advisor/observe.ts) from what the pilot's own
 * instruments already know, so an advisor cannot reach anything hidden:
 *  - points of interest: only those the sensors have revealed (the same set
 *    the sector map shows), never the hidden rest; survey marks beyond
 *    sensor range appear only as the count the HUD already shows;
 *  - hostile contacts: the sector map's rule (alive, hostile, inside sensor
 *    range, and nobody inside sensor interference);
 *  - gravity: the pull the ship feels this tick (the HUD arrow's numbers) and
 *    a short forecast made with the game's own flight step;
 *  - offsets are world vectors (y down); the advisor turns them into words
 *    relative to the nose (`heading`, 0 = up, clockwise) or screen arrows.
 * It carries no handle on the run: no input, no ship object, no weapon, lock,
 * wallet or progression. An advisor reads numbers and returns text.
 */

export interface Offset {
  /** World offset from the ship (px, y down). */
  readonly dx: number;
  readonly dy: number;
  /** Distance (px). */
  readonly distance: number;
}

export type ObservedPoiKind = 'survey' | 'salvage' | 'derelict' | 'cache' | 'anomaly' | 'installation';

export interface ObservedPoi extends Offset {
  readonly id: string;
  readonly kind: ObservedPoiKind;
  readonly label: string;
  /** Interaction radius (px). */
  readonly reach: number;
  /** The interaction's verb ("Inspect") and whether flying through it is the interaction. */
  readonly verb: string;
  readonly auto: boolean;
  /** Needed for the survey or to leave the sector. */
  readonly required: boolean;
  /** A hazard zone the target lies in, if any. */
  readonly hazard: 'minefield' | 'eruption' | 'interference' | null;
  /** Main resource of its sensor return (display name), or null. */
  readonly resource: string | null;
}

export interface ObservedBody {
  readonly id: string;
  readonly label: string;
  readonly kind: 'star' | 'body';
}

export type EscapeKind = 'stop' | 'radial' | 'retro' | 'tangent';

export interface Forecast {
  /** How far ahead it looked (s). */
  readonly horizonS: number;
  /** The first contact with a body (or entry into a star's corona) with engines idle, if any. */
  readonly impact: {
    readonly body: ObservedBody;
    readonly inS: number;
    readonly kind: 'surface' | 'corona';
    /** A surface contact fast enough to damage the hull (sector/run.ts RUN.impactSpeed); a corona always burns. */
    readonly damaging: boolean;
  } | null;
  /** An escape burn (computed only with a Navigator aboard, and only when an impact is forecast). */
  readonly escape: {
    readonly kind: EscapeKind;
    /** World direction of the burn (unit vector; zero for STOP, which needs no heading). */
    readonly dx: number;
    readonly dy: number;
    /** The same forecast saw the burn clear every body and corona; false = guidance only. */
    readonly verified: boolean;
  } | null;
}

export interface Observation {
  /** Identity of the sector visit (a new visit resets the advisor). */
  readonly sector: string;
  /** Ticks flown in this visit. */
  readonly tick: number;
  /** In flight (not docked, not paused, not briefed). */
  readonly flying: boolean;
  readonly combat: 'calm' | 'alert' | 'engaged';
  readonly flightMode: 'normal' | 'realistic';
  readonly stop: 'off' | 'braking' | 'holding' | 'cannot';
  /** Ship nose (radians, 0 = up, clockwise). */
  readonly heading: number;
  /** Fractions 0..1 of the flown ship's own maximum. */
  readonly hull: number;
  readonly shield: number;
  readonly jammed: boolean;
  readonly sensorRange: number;
  readonly contacts: { readonly count: number; readonly nearest: Offset | null };
  readonly gravity: {
    /** Pull felt as a share of the engine's own acceleration (0 .. 0.3 by the field cap). */
    readonly share: number;
    /** Direction of the pull (world unit vector, zero when none). */
    readonly dx: number;
    readonly dy: number;
    readonly body: ObservedBody | null;
    /** The ship is moving toward the body pulling hardest. */
    readonly closing: boolean;
    /** The main engine out-pulls it (always in NORMAL; REALISTIC: its thrust vs the pull). */
    readonly engineBeats: boolean;
  };
  /** The star whose corona the ship is inside (it burns the shield), with the way straight out. */
  readonly inCorona: (ObservedBody & { readonly outX: number; readonly outY: number }) | null;
  readonly forecast: Forecast | null;
  /** Revealed, not yet done targets (no beacons), nearest first, at most OBSERVATION_LIMITS.pois. */
  readonly pois: readonly ObservedPoi[];
  readonly survey: {
    /** Marks still to record (the HUD's count). */
    readonly remaining: number;
    /** Of those, revealed by the sensors. */
    readonly onSensors: number;
    /** Marks revealed so far in this visit, recorded or not (only grows). */
    readonly seen: number;
    readonly nearest: Offset | null;
    readonly complete: boolean;
  };
  /** The exit beacon (a navigation beacon every pilot knows on arrival). */
  readonly exit: Offset | null;
  /** Reactor cells aboard and the cheapest / dearest lane out (null = not applicable, e.g. Admin Access). */
  readonly route: { readonly cells: number; readonly cheapest: number; readonly dearest: number } | null;
  /** Stocked weapons of the flown ship with an empty magazine (display names). */
  readonly emptyMagazines: readonly string[];
  /** A decision prompt (the full-hold choice) is open: non-urgent advice waits. */
  readonly offer: boolean;
}

export const OBSERVATION_LIMITS = Object.freeze({ pois: 8, magazines: 4 });
