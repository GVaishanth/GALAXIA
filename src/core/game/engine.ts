/**
 * GameEngine: owns the world, the phase machine and the per-tick system
 * order. Pure simulation (no DOM, no wall clock, only the seeded RNG): the
 * platform layer feeds one InputFrame per fixed tick and renders the world.
 *
 * Scoring never happens here: the engine reports GameplayFacts to the
 * RewardManager, which decides points, lives and bonuses.
 */
import { ENGINE, type EngineConfig } from '../../config/engine.ts';
import type { AttackPatternId } from '../../config/difficulty.ts';
import { createRng } from '../rng.ts';
import type { RewardManager } from '../rewards/rewardManager.ts';
import type { FactResult, GameplayFact } from '../rewards/types.ts';
import { attackersInFlight, launchPattern, updateAttackScheduler, updateTransforms } from '../systems/attacks.ts';
import { tryRebound, updateBeams, updateCaptives, updateTractor } from '../systems/capture.ts';
import { updateChallenge } from '../systems/challenge.ts';
import { resolveCollisions } from '../systems/collisions.ts';
import { PathCache, type SimContext } from '../systems/context.ts';
import { destroyEnemy, updateEffects } from '../systems/damage.ts';
import { sweepEnemies, updateEnemies } from '../systems/enemies.ts';
import { updateEntry } from '../systems/entry.ts';
import { buildSlots, newFormationState, updateFormation } from '../systems/formation.ts';
import { createClassicOrdnance, refillOrdnance, updateOrdnance, type ClassicLoadout } from '../systems/ordnance.ts';
import { newPlayer, spawnPlayer, updatePlayer } from '../systems/player.ts';
import { isStageCleared, setupStage } from '../systems/progression.ts';
import { updateProjectiles } from '../systems/projectiles.ts';
import { tuningForStage } from '../../config/difficulty.ts';
import type { GameEvent } from './events.ts';
import type { InputFrame } from './input.ts';
import { CONTROLLABLE, PhaseMachine, SIMULATING, type GamePhase, type PhaseClock } from './stateMachine.ts';
import type { World } from './types.ts';

export interface GameEngineOptions {
  readonly rewards: RewardManager;
  readonly seed?: number;
  readonly config?: EngineConfig;
  /** Skip entry flights and place the formation at once (tests, debug). */
  readonly instantFormation?: boolean;
  /** First stage of a new game (debug / tests). */
  readonly startStage?: number;
  /** Called at each new game for that game's RNG seed (default: always `seed`). */
  readonly seedProvider?: () => number;
  /**
   * Combat P03C: the ship flown after the Wave 20 milestone (its weapons, from
   * the shared catalogue). null / absent = the legacy fighter, unchanged.
   */
  readonly loadout?: ClassicLoadout | null;
}

export interface RejectedFact {
  readonly tick: number;
  readonly fact: GameplayFact;
  readonly reason: string;
  readonly detail?: string | undefined;
}

export class GameEngine {
  readonly cfg: EngineConfig;
  readonly rewards: RewardManager;
  readonly machine: PhaseMachine;
  readonly stepMs: number;
  readonly paths: PathCache;
  /** Facts the reward manager refused (should stay empty; asserted by tests). */
  readonly rejectedFacts: RejectedFact[] = [];
  world: World;
  readonly context: SimContext;

  private seed: number;
  private readonly seedProvider: (() => number) | null;
  private readonly instantFormation: boolean;
  private readonly startStage: number;
  private events: GameEvent[] = [];
  private readyMs = 0;
  private stageIntro = false;
  private clearDelayMs = 0;
  private playerLost = false;
  private loadout: ClassicLoadout | null;

  constructor(options: GameEngineOptions) {
    this.cfg = options.config ?? ENGINE;
    this.rewards = options.rewards;
    this.seed = options.seed ?? 1;
    this.seedProvider = options.seedProvider ?? null;
    this.instantFormation = options.instantFormation ?? false;
    this.startStage = options.startStage ?? 1;
    this.loadout = options.loadout ?? null;
    this.stepMs = 1000 / this.cfg.tickHz;
    this.paths = new PathCache(this.cfg.world.width);
    this.machine = new PhaseMachine((from, to) => this.events.push({ type: 'phaseChanged', from, to }));
    this.world = this.freshWorld();
    const engine = this;
    this.context = {
      cfg: this.cfg,
      get world() {
        return engine.world;
      },
      paths: this.paths,
      get phase() {
        return engine.machine.activePhase;
      },
      emit: (e) => this.events.push(e),
      fact: (f) => this.fact(f),
      reserves: () => this.rewards.snapshot().reserves,
      onPlayerLost: () => {
        this.playerLost = true;
      },
    };
    this.machine.transition('title');
  }

  get phase(): GamePhase {
    return this.machine.phase;
  }

  /** Combat P03C: the ship for the next game (title screen selector); the game in progress keeps its own. */
  setLoadout(loadout: ClassicLoadout | null): void {
    this.loadout = loadout;
  }

  get currentLoadout(): ClassicLoadout | null {
    return this.loadout;
  }

  /** Seed of the current (or last) game. */
  get currentSeed(): number {
    return this.seed;
  }

  /**
   * Read-only phase clock for presentation (READY countdown, stage-clear and
   * game-over timers). `durationMs` is null for phases without a fixed length.
   */
  phaseClock(): PhaseClock {
    // while paused, report the phase that will resume (its timer is frozen, not reset)
    const phase = this.machine.activePhase;
    const durationMs = phase === 'ready' ? this.readyMs : phase === 'stageCleared' ? this.clearDelayMs : phase === 'gameOver' ? this.cfg.stage.gameOverMs : null;
    return { phase, paused: this.machine.phase === 'paused', elapsedMs: this.machine.timeInPhaseMs, durationMs };
  }

  /** True while the READY phase is a stage intro (not a respawn). */
  get isStageIntro(): boolean {
    return this.stageIntro;
  }

  /** Engine events since the last drain (presentation / audio). */
  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /* ---------------------------------- control --------------------------------- */

  /** Start from the title, or restart after game over. */
  startGame(): boolean {
    const ph = this.machine.phase;
    if (ph === 'gameOver') {
      if (!this.machine.transition('restarting')) return false;
    } else if (ph !== 'title') return false;
    this.rewards.startGame();
    if (this.seedProvider) this.seed = this.seedProvider() >>> 0;
    this.world = this.freshWorld();
    spawnPlayer(this.context);
    this.beginStage(this.startStage);
    return this.machine.transition('ready');
  }

  pause(): boolean {
    return this.machine.pause();
  }

  resume(): boolean {
    return this.machine.resume();
  }

  /** Leave a paused game for the title screen (ends the run; reported as game over). */
  quitToTitle(): boolean {
    if (this.machine.phase !== 'paused') return false;
    if (this.rewards.snapshot().status === 'running') this.fact({ type: 'gameOver' });
    return this.machine.transition('title');
  }

  /** Leave the game-over screen for the title before its timer runs out (menu). */
  returnToTitle(): boolean {
    if (this.machine.phase !== 'gameOver') return false;
    return this.machine.transition('title');
  }

  /** Advance exactly one fixed tick. */
  step(input: InputFrame): void {
    if (input.pause) {
      if (this.machine.phase === 'paused') this.resume();
      else this.pause();
    } else if (input.start) {
      const ph = this.machine.phase;
      if (ph === 'title') this.startGame();
      else if (ph === 'gameOver' && this.machine.timeInPhaseMs >= 1000) this.startGame();
      // start/fire never leave pause: only the pause toggle resumes (no firing input while paused)
    }
    const phase = this.machine.phase;
    if (!SIMULATING.has(phase)) return; // paused / title / boot: frozen, input ignored
    const dt = this.stepMs;
    const w = this.world;
    w.tick += 1;
    w.timeMs += dt;
    this.machine.tick(dt);
    const ctx = this.context;
    updatePlayer(ctx, input, CONTROLLABLE.has(phase), dt);
    // Combat P03C: the post-Wave-20 ship's missiles (absent for the legacy fighter); hits count while the field is live
    if (w.ordnance) updateOrdnance(ctx, input, CONTROLLABLE.has(phase), dt, phase === 'playing' || phase === 'challenge' || phase === 'playerHit');

    switch (phase) {
      case 'ready':
        this.updateField(dt, { entries: !this.stageIntro, attacks: false, collisions: false });
        if (this.machine.timeInPhaseMs >= this.readyMs) {
          this.stageIntro = false;
          this.machine.transition(w.stageKind === 'challenge' ? 'challenge' : 'playing');
        }
        break;
      case 'playing':
      case 'challenge':
        this.updateField(dt, { entries: true, attacks: true, collisions: true });
        if (this.playerLost) {
          this.playerLost = false;
          this.machine.transition('playerHit');
        } else if (isStageCleared(ctx) && w.player.state === 'alive') this.clearStage();
        break;
      case 'playerHit':
        this.updateField(dt, { entries: true, attacks: false, collisions: true });
        this.updateRespawn();
        break;
      case 'stageCleared':
        this.updateField(dt, { entries: false, attacks: false, collisions: false });
        if (this.machine.timeInPhaseMs >= this.clearDelayMs) {
          this.beginStage(w.stage + 1);
          this.machine.transition('ready');
        }
        break;
      case 'gameOver':
        // the field keeps animating, but nothing can score or collide
        updateFormation(w, dt);
        updateEnemies(ctx, dt);
        updateProjectiles(ctx, dt);
        updateEffects(ctx, dt);
        sweepEnemies(ctx);
        if (this.machine.timeInPhaseMs >= this.cfg.stage.gameOverMs) this.machine.transition('title');
        break;
      default:
        break;
    }
  }

  /* --------------------------------- internals -------------------------------- */

  private fact(f: GameplayFact): FactResult {
    const r = this.rewards.handle(f);
    if (!r.accepted) this.rejectedFacts.push({ tick: this.world.tick, fact: f, reason: r.reason ?? 'unknown', detail: r.detail });
    return r;
  }

  private freshWorld(): World {
    return {
      tick: 0,
      timeMs: 0,
      stage: 0,
      stageKind: 'normal',
      tuning: tuningForStage(1),
      player: newPlayer(this.cfg),
      enemies: [],
      playerShots: [],
      enemyShots: [],
      effects: [],
      slots: buildSlots(),
      formation: newFormationState(),
      challenge: null,
      attackTimerMs: 0,
      transformsLaunched: 0,
      fireHoldUntilMs: 0,
      heat: { level: 0, overheated: false, heldMs: 0, autoMs: 0 },
      pendingRebound: null,
      ordnance: this.loadout ? createClassicOrdnance(this.loadout) : null,
      nextId: 0,
      rng: createRng(this.seed),
    };
  }

  private beginStage(stage: number): void {
    setupStage(this.context, stage, this.rewards.mode.schedule, this.instantFormation);
    if (this.world.ordnance) refillOrdnance(this.world.ordnance);
    if (this.world.player.state !== 'alive') spawnPlayer(this.context);
    this.world.player.y = this.cfg.player.y;
    this.fact({ type: 'stageStarted', stage });
    this.events.push({ type: 'stageStarted', stage, challenge: this.world.stageKind === 'challenge' });
    this.readyMs = this.cfg.stage.introMs;
    this.stageIntro = true;
    this.playerLost = false;
  }

  private updateField(dt: number, o: { entries: boolean; attacks: boolean; collisions: boolean }): void {
    const ctx = this.context;
    const w = this.world;
    if (w.stageKind === 'normal') {
      if (o.entries) updateEntry(ctx, dt);
      updateFormation(w, dt);
      tryRebound(ctx);
      if (o.attacks) updateAttackScheduler(ctx, dt);
    } else if (o.entries) {
      updateChallenge(ctx, dt);
    }
    updateEnemies(ctx, dt);
    updateTransforms(ctx);
    updateBeams(ctx, dt);
    updateTractor(ctx, dt);
    updateCaptives(ctx, dt);
    updateProjectiles(ctx, dt);
    if (o.collisions) resolveCollisions(ctx);
    updateEffects(ctx, dt);
    this.handleLeavers();
    if (w.challenge && !w.challenge.ended && w.challenge.queue.length === 0 && w.challenge.resolved >= w.challenge.total) w.challenge.ended = true;
  }

  private handleLeavers(): void {
    const w = this.world;
    const gone = sweepEnemies(this.context);
    const endedGroups = new Set<string>();
    for (const e of gone) {
      if (w.challenge) w.challenge.resolved += 1;
      if (e.kind === 'transform' && e.groupId && w.stageKind === 'normal' && !endedGroups.has(e.groupId)) {
        if (!w.enemies.some((o) => o.groupId === e.groupId)) {
          endedGroups.add(e.groupId);
          this.fact({ type: 'transformGroupEnded', groupId: e.groupId });
        }
      }
      if (e.kind === 'capturedFighter' && e.captiveMode === 'hostile' && e.fighterId) w.pendingRebound = e.fighterId;
    }
  }

  private clearStage(): void {
    const w = this.world;
    if (w.stageKind === 'challenge') {
      this.fact({ type: 'challengeStageEnded' });
      this.clearDelayMs = this.cfg.stage.challengeResultMs;
    } else this.clearDelayMs = this.cfg.stage.clearDelayMs;
    this.machine.transition('stageCleared');
    this.events.push({ type: 'stageCleared', stage: w.stage });
  }

  private updateRespawn(): void {
    const w = this.world;
    const t = this.machine.timeInPhaseMs;
    if (t < this.cfg.player.respawnDelayMs) return;
    const busy =
      w.stageKind === 'normal' &&
      (attackersInFlight(this.context) > 0 || w.enemies.some((e) => e.beam || (e.kind === 'capturedFighter' && e.state !== 'inFormation')));
    if (busy && t < this.cfg.player.maxRespawnWaitMs) return;
    if (w.player.lastShipLost) {
      this.fact({ type: 'gameOver' });
      this.machine.transition('gameOver');
      this.events.push({ type: 'gameOver' });
      return;
    }
    if (isStageCleared(this.context)) {
      this.clearStage();
      return;
    }
    spawnPlayer(this.context);
    this.events.push({ type: 'playerRespawned', x: w.player.x, y: w.player.y });
    this.readyMs = this.cfg.player.readyMs;
    this.stageIntro = false;
    this.machine.transition('ready');
  }

  /* ----------------------------- debug & test hooks ---------------------------- */

  /** Launch an attack pattern now (optionally forcing the enemy). Returns launched ids. */
  debugLaunch(pattern: AttackPatternId, enemyId?: string): string[] {
    const forced = enemyId ? this.world.enemies.find((e) => e.id === enemyId) : undefined;
    return launchPattern(this.context, pattern, forced);
  }

  debugSetPlayerX(x: number): void {
    const p = this.world.player;
    p.x = p.prevX = x;
  }

  /** Destroy every enemy (reported as kills). */
  debugDestroyAll(): void {
    for (const e of [...this.world.enemies]) if (e.kind !== 'capturedFighter' || e.captiveMode === 'hostile') destroyEnemy(this.context, e);
  }

  /** Stable hash of the simulation state (determinism tests). */
  digest(): string {
    const w = this.world;
    const r = (v: number): string => v.toFixed(3);
    const parts: string[] = [String(w.tick), this.machine.phase, String(w.stage), r(w.player.x), r(w.player.y), w.player.state, String(w.player.dual), String(this.rewards.snapshot().score)];
    for (const e of w.enemies) parts.push(e.id, e.state, r(e.x), r(e.y), String(e.hp));
    for (const s of w.playerShots) parts.push('p', r(s.x), r(s.y));
    for (const s of w.enemyShots) parts.push('e', r(s.x), r(s.y));
    // P03C: only a game with a post-Wave-20 loadout adds anything (legacy digests are unchanged)
    if (w.ordnance) {
      parts.push('o', w.ordnance.arsenal.selected, JSON.stringify(w.ordnance.ammo), w.ordnance.lock?.target ?? '-');
      for (const m of w.ordnance.missiles) parts.push('m', m.weapon, r(m.x), r(m.y));
    }
    let h = 0x811c9dc5;
    const str = parts.join('|');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
}
