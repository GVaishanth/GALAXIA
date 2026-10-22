/**
 * Stage 4 transitions: state-driven, short, and never covering live play.
 */
import { describe, expect, it } from 'vitest';
import { TRANSITIONS } from '../src/config/presentation.ts';
import type { GamePhase, PhaseClock } from '../src/core/game/stateMachine.ts';
import { TransitionDirector, type TransitionFrame } from '../src/render/transitions.ts';

const clock = (phase: GamePhase, elapsedMs = 0, durationMs: number | null = null, paused = false): PhaseClock => ({ phase, elapsedMs, durationMs, paused });
const FULL = { reducedMotion: false, stageIntro: true };

function started(): TransitionDirector {
  const t = new TransitionDirector();
  t.onPhaseChanged('boot', 'title', 0);
  t.boot(0);
  return t;
}

const covered = (f: TransitionFrame): boolean => f.fade > 0 || f.dim > 0 || f.banner > 0 || f.ready !== null || f.titleAlpha > 0;

describe('TransitionDirector', () => {
  it('never covers the field during live attack, whatever came before', () => {
    const t = started();
    // a game starts, then immediately goes live while every fade would still be running
    t.onPhaseChanged('title', 'ready', 1000);
    t.onPhaseChanged('ready', 'playing', 1001);
    for (const phase of ['playing', 'challenge'] as const) {
      for (const ms of [0, 1, 50, 100, 300, 1000, 5000]) {
        for (const reducedMotion of [false, true]) {
          const f = t.frame(1001 + ms, clock(phase, ms), { reducedMotion, stageIntro: true });
          expect(f.live).toBe(true);
          expect(covered(f)).toBe(false);
          expect(f.warp).toBe(0);
          expect(f.playerVisible).toBe(true);
        }
      }
    }
  });

  it('boot fades in from black within bootFadeMs', () => {
    const t = started();
    expect(t.frame(0, clock('title'), FULL).fade).toBe(1);
    expect(t.frame(TRANSITIONS.bootFadeMs / 2, clock('title'), FULL).fade).toBeCloseTo(0.5, 5);
    expect(t.frame(TRANSITIONS.bootFadeMs, clock('title'), FULL).fade).toBe(0);
    expect(t.frame(0, clock('title'), FULL).titleAlpha).toBe(1);
  });

  it('title -> start: field fades in, title art fades out, stars decelerate from warp', () => {
    const t = started();
    t.onPhaseChanged('title', 'ready', 5000);
    const f0 = t.frame(5000, clock('ready', 0, 1800), FULL);
    expect(f0.fade).toBe(1);
    expect(f0.titleAlpha).toBe(1);
    expect(f0.warp).toBe(1);
    const f1 = t.frame(5000 + TRANSITIONS.gameInFadeMs, clock('ready', TRANSITIONS.gameInFadeMs, 1800), FULL);
    expect(f1.fade).toBe(0);
    expect(f1.titleAlpha).toBe(0);
    const f2 = t.frame(5000 + TRANSITIONS.warpInMs, clock('ready', TRANSITIONS.warpInMs, 1800), FULL);
    expect(f2.warp).toBe(0);
    // every intro fade finishes before READY ends (play is never delayed)
    expect(Math.max(TRANSITIONS.gameInFadeMs, TRANSITIONS.titleOutMs, TRANSITIONS.warpInMs)).toBeLessThan(1800);
  });

  it('READY shows a countdown that runs out exactly when the engine starts play', () => {
    const t = started();
    t.onPhaseChanged('stageCleared', 'ready', 0);
    expect(t.frame(0, clock('ready', 0, 1800), FULL).ready!.remaining).toBe(1);
    expect(t.frame(900, clock('ready', 900, 1800), FULL).ready!.remaining).toBeCloseTo(0.5, 5);
    expect(t.frame(1800, clock('ready', 1800, 1800), FULL).ready!.remaining).toBe(0);
    expect(t.frame(400, clock('ready', 400, 1800), FULL).banner).toBe(1);
  });

  it('respawn READY blinks the new fighter but shows no stage banner or warp', () => {
    const t = started();
    t.onPhaseChanged('playerHit', 'ready', 0);
    const flags = { reducedMotion: false, stageIntro: false };
    const vis = [0, 80, 160, 240].map((ms) => t.frame(ms, clock('ready', ms, 1500), flags).playerVisible);
    expect(vis).toEqual([true, false, true, false]);
    expect(t.frame(1400, clock('ready', 1400, 1500), flags).playerVisible).toBe(true);
    expect(t.frame(100, clock('ready', 100, 1500), flags).banner).toBe(0);
    expect(t.frame(100, clock('ready', 100, 1500), flags).warp).toBe(0);
  });

  it('stage clear: warp ramps up only in the last part of the clear delay', () => {
    const t = started();
    t.onPhaseChanged('playing', 'stageCleared', 0);
    expect(t.frame(0, clock('stageCleared', 0, 1600), FULL).warp).toBe(0);
    expect(t.frame(0, clock('stageCleared', 1600 * (1 - TRANSITIONS.warpOutShare), 1600), FULL).warp).toBe(0);
    expect(t.frame(0, clock('stageCleared', 1600, 1600), FULL).warp).toBe(1);
  });

  it('pause dims quickly; resume is instant', () => {
    const t = started();
    t.onPhaseChanged('playing', 'paused', 1000);
    expect(t.frame(1000, clock('playing', 500, null, true), FULL).dim).toBe(0);
    expect(t.frame(1000 + TRANSITIONS.pauseDimMs, clock('playing', 500, null, true), FULL).dim).toBeCloseTo(TRANSITIONS.pauseDim, 5);
    expect(t.animating(1000 + 10, clock('playing', 500, null, true), false)).toBe(true);
    expect(t.animating(1000 + 1000, clock('playing', 500, null, true), false)).toBe(false);
    t.onPhaseChanged('paused', 'playing', 2000);
    const f = t.frame(2000, clock('playing', 500), FULL);
    expect(f.dim).toBe(0);
    expect(covered(f)).toBe(false);
  });

  it('pausing during READY keeps the countdown frozen (engine clock), not reset', () => {
    const t = started();
    t.onPhaseChanged('stageCleared', 'ready', 0);
    t.onPhaseChanged('ready', 'paused', 600);
    const f = t.frame(5000, clock('ready', 600, 1800, true), FULL);
    expect(f.ready!.remaining).toBeCloseTo(1 - 600 / 1800, 5);
    expect(f.dim).toBeCloseTo(TRANSITIONS.pauseDim, 5);
  });

  it('game over dims gradually; restart fades in from black', () => {
    const t = started();
    t.onPhaseChanged('playerHit', 'gameOver', 0);
    expect(t.frame(0, clock('gameOver', 0, 4000), FULL).dim).toBe(0);
    expect(t.frame(0, clock('gameOver', TRANSITIONS.gameOverDimMs, 4000), FULL).dim).toBeCloseTo(TRANSITIONS.gameOverDim, 5);
    t.onPhaseChanged('gameOver', 'restarting', 3000);
    t.onPhaseChanged('restarting', 'ready', 3000);
    expect(t.frame(3000, clock('ready', 0, 1800), FULL).fade).toBe(1);
    expect(t.frame(3000 + TRANSITIONS.restartFadeMs, clock('ready', TRANSITIONS.restartFadeMs, 1800), FULL).fade).toBe(0);
    expect(t.frame(3000, clock('ready', 0, 1800), FULL).titleAlpha).toBe(0);
  });

  it('reduced motion: no warp, instant dims, no blinking', () => {
    const t = started();
    const rm = { reducedMotion: true, stageIntro: true };
    t.onPhaseChanged('title', 'ready', 0);
    expect(t.frame(0, clock('ready', 0, 1800), rm).warp).toBe(0);
    t.onPhaseChanged('playing', 'paused', 100);
    expect(t.frame(100, clock('playing', 0, null, true), rm).dim).toBe(TRANSITIONS.pauseDim);
    t.onPhaseChanged('playerHit', 'ready', 200);
    expect(t.frame(280, clock('ready', 80, 1500), { reducedMotion: true, stageIntro: false }).playerVisible).toBe(true);
  });

  it('every transition is short (under 1 s)', () => {
    for (const k of ['bootFadeMs', 'titleOutMs', 'gameInFadeMs', 'restartFadeMs', 'warpInMs', 'pauseDimMs', 'gameOverDimMs', 'readyPopMs', 'bannerInMs', 'bannerOutMs'] as const) {
      expect(TRANSITIONS[k], k).toBeLessThan(1000);
    }
  });
});
