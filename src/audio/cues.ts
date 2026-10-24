/**
 * Event -> sound cue mapping (pure). The audio engine executes cues; this
 * module only decides which sound an event deserves, so it is unit-tested
 * without any audio device. Sounds are reactions to facts that already
 * happened; nothing here can influence the simulation.
 */
import type { SoundId } from '../config/audio.ts';
import type { GameEvent } from '../core/game/events.ts';
import type { RewardEvent } from '../core/rewards/types.ts';

export type Cue =
  | { readonly kind: 'play'; readonly sound: SoundId }
  | { readonly kind: 'loopStart'; readonly key: string; readonly sound: SoundId }
  | { readonly kind: 'loopStop'; readonly key: string }
  | { readonly kind: 'stopLoops' };

const play = (sound: SoundId): Cue => ({ kind: 'play', sound });

export function cuesForGameEvent(e: GameEvent): Cue[] {
  switch (e.type) {
    case 'playerShot':
      return [play('shot')];
    case 'enemyHit':
      return [play('enemyHit')];
    case 'enemyDestroyed':
      return [play(e.kind === 'commander' ? 'bossBoom' : 'enemyBoom')];
    case 'playerDestroyed':
      return [play('playerBoom')];
    case 'attackLaunched':
      return [play('dive')];
    case 'beamStarted':
      return [{ kind: 'loopStart', key: `beam:${e.captorId}`, sound: 'beam' }];
    case 'beamEnded':
      return [{ kind: 'loopStop', key: `beam:${e.captorId}` }];
    case 'fighterCaptured':
      return [play('captured')];
    case 'captiveFreed':
      return [play('rescueFree')];
    case 'dualFighterFormed':
      return [play('dual')];
    case 'stageStarted':
      return [play(e.challenge ? 'challengeStart' : 'stageStart')];
    case 'stageCleared':
      return [play('stageClear')];
    case 'gameOver':
      return [{ kind: 'stopLoops' }, play('gameOver')];
    case 'weaponOverheated':
      return [play('overheat')];
    case 'weaponCooled':
      return [play('cooled')];
    // Combat P03C: Classic ordnance (only a post-Wave-20 roster ship emits these)
    case 'weaponSwitched':
      return [play('weaponSwitch')];
    case 'ordnanceLaunched':
      return [play('missileLaunch')];
    case 'ordnanceRefused':
      return e.reason === 'unavailable' ? [] : [play('refused')];
    case 'lockStarted':
      return [play('lockTone')];
    case 'detonation':
      return [play(e.weapon === 'nuke' ? 'nukeBlast' : 'missileBlast')];
    case 'phaseChanged':
      // leaving play for the title (quit) or restarting silences any hum
      return e.to === 'title' || e.to === 'restarting' ? [{ kind: 'stopLoops' }] : [];
    default:
      return [];
  }
}

export function cuesForRewardEvent(e: RewardEvent): Cue[] {
  switch (e.type) {
    case 'extraLifeAwarded':
      return [play('extraLife')];
    case 'transformGroupCleared':
    case 'challengeWaveCleared':
      return [play('bonus')];
    case 'challengeStageResult':
      return e.perfect ? [play('perfect')] : e.bonus > 0 ? [play('bonus')] : [];
    default:
      return [];
  }
}
