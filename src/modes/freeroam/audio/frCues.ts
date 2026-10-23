/**
 * Free Roam sound cues (Prompt 12): which sound, if any, each presentation
 * moment plays. Pure (no Web Audio, no DOM, no clock), so it is unit-tested;
 * the shell feeds it events and plays the answer. Sounds never feed back into
 * gameplay: a muted or locked SoundSystem changes nothing but the speakers.
 */
import type { SectorEvent } from '../sector/run.ts';
import type { FrSoundId } from './frSounds.ts';

/** Shield state around one batch of sector events (to tell a shield hit from a hull hit). */
export interface HitContext {
  /** Shield before the batch, and after it. */
  readonly shieldBefore: number;
  readonly shieldAfter: number;
}

/** Heavy weapons whose telegraph is worth an alert (rate-limited by the caller). */
const HEAVY = new Set(['missile', 'beam', 'broadside', 'launch']);

/** The sound for one sector event, or null for silence. */
export function sectorCue(e: SectorEvent, ctx: HitContext): FrSoundId | null {
  switch (e.type) {
    case 'recorded':
      return 'fr.discover';
    case 'collected':
    case 'picked':
      return 'fr.collect';
    case 'looted':
      return e.loot.length ? 'fr.loot' : 'fr.discover';
    case 'recovered':
      return 'fr.loot';
    case 'chipped':
      return 'fr.chip';
    case 'docked':
      return 'fr.dock';
    case 'dockRefused':
    case 'holdFull':
      return 'fr.deny';
    case 'encounter':
      if (e.state === 'cleared') return 'fr.clear';
      if (e.state === 'start' || e.state === 'warning') return 'fr.alert';
      if (e.state === 'failed') return 'fr.deny';
      return null;
    case 'telegraph':
      return HEAVY.has(e.weapon) ? 'fr.alert' : null;
    case 'bossPhase':
      return 'fr.alert';
    case 'blast':
      return 'fr.boom';
    case 'hit':
      if (ctx.shieldBefore > 0 && ctx.shieldAfter <= 0) return 'fr.shieldDown';
      return ctx.shieldAfter > 0 ? 'fr.shieldHit' : 'fr.hullHit';
    case 'fired':
      return 'fr.shot';
    case 'overheated':
      return 'fr.overheat';
    case 'weaponCooled':
      return 'fr.cooled';
    case 'struck':
      return 'fr.impact';
    case 'destroyed':
      return e.size >= 3 ? 'fr.bigBoom' : 'fr.boom';
    case 'recalled':
      return 'fr.playerBoom';
    case 'surveyComplete':
      return 'fr.complete';
    case 'gate':
      return e.gate.state === 'open' ? null : 'fr.deny';
    /* pilot missile (Combat P03) */
    case 'missileLock':
      return 'fr.lock';
    case 'missileLaunched':
      return 'fr.missile';
    case 'missileHit':
      return e.killed ? null : 'fr.impact'; // a kill plays the destroyed boom instead
    case 'missileRefused':
    case 'missileLockLost':
      return 'fr.deny';
    case 'missileReady':
      return 'fr.armed';
    default:
      return null;
  }
}

/** Presentation moments outside the sector simulation. */
export type MomentCue = 'jump' | 'arrive' | 'missionComplete' | 'missionFailed' | 'upgrade' | 'refused' | 'launch';

const MOMENTS: Readonly<Record<MomentCue, FrSoundId>> = Object.freeze({
  jump: 'fr.jump',
  arrive: 'fr.arrive',
  missionComplete: 'fr.mission',
  missionFailed: 'fr.deny',
  upgrade: 'fr.upgrade',
  refused: 'fr.deny',
  launch: 'fr.arrive',
});

export function momentCue(m: MomentCue): FrSoundId {
  return MOMENTS[m];
}

/** Engine hum level (0..1): idle murmur, rising with thrust and boost; silent when not flying. */
export interface EngineInput {
  /** Flying, unpaused, no panel over the flight, page visible. */
  readonly live: boolean;
  /** Stick / key thrust magnitude, 0..1. */
  readonly thrust: number;
  /** Eased boost amount, 0..1. */
  readonly boost: number;
}

export const ENGINE_LEVEL = Object.freeze({ idle: 0.22, thrust: 0.5, boost: 0.28 });

export function engineLevel(i: EngineInput): number {
  if (!i.live) return 0;
  const t = Number.isFinite(i.thrust) ? Math.min(1, Math.max(0, i.thrust)) : 0;
  const b = Number.isFinite(i.boost) ? Math.min(1, Math.max(0, i.boost)) : 0;
  return Math.min(1, ENGINE_LEVEL.idle + ENGINE_LEVEL.thrust * t + ENGINE_LEVEL.boost * b);
}
