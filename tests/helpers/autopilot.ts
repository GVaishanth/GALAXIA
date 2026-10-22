/**
 * Deterministic autopilot for soak and integration tests (Stage 6).
 *
 * The bot plays the real game only through InputFrame (move / fire / start),
 * exactly like a player: it reads the public world state, dodges shots and
 * divers, and aims at the nearest reachable enemy. It never mutates the world.
 * Its choices depend only on the world state and the tick, so a seeded engine
 * plus the bot is fully reproducible.
 *
 * `checkInvariants` collects rule violations on every tick (scoring
 * rejections, out-of-bounds objects, unbounded arrays, stuck phases).
 */
import { ENGINE } from '../../src/config/engine.ts';
import type { GameEngine } from '../../src/core/game/engine.ts';
import { NO_INPUT, type InputFrame } from '../../src/core/game/input.ts';
import type { GamePhase } from '../../src/core/game/stateMachine.ts';

export interface BotOptions {
  /** Look-ahead for incoming enemy shots (s). */
  readonly dodgeHorizonS?: number;
  /** Skill: 1 = dodges and aims; 0 = random walk + mash fire (makes mistakes). */
  readonly skill?: number;
}

/** Tiny LCG so "unskilled" behaviour is reproducible and independent of the engine RNG. */
function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export function botInput(engine: GameEngine, opts: BotOptions = {}): InputFrame {
  const w = engine.world;
  const phase = engine.phase;
  if (phase === 'title') return { ...NO_INPUT, start: true };
  const p = w.player;
  if (p.state !== 'alive') return NO_INPUT;
  const fireTick = w.tick % 2 === 0; // fire is a press: alternate ticks = repeated taps
  const skill = opts.skill ?? 1;
  if (hash(w.tick * 7 + 3) > skill) {
    const dir = hash(Math.floor(w.tick / 20)) < 0.5 ? -1 : 1;
    return { ...NO_INPUT, moveX: dir, fire: fireTick };
  }
  const horizon = opts.dodgeHorizonS ?? 0.75;
  const half = p.dual ? ENGINE.player.dualHalfOffset + 12 : 14;
  // threats: shots that will cross the player row near the ship, and low divers
  let threat: number | null = null;
  let threatT = Number.POSITIVE_INFINITY;
  for (const s of w.enemyShots) {
    if (s.vy <= 0) continue;
    const t = (p.y - s.y) / s.vy;
    if (t < -0.02 || t > horizon) continue;
    const xAt = s.x + (s.vx * t);
    if (Math.abs(xAt - p.x) < half + 6 && t < threatT) {
      threat = xAt;
      threatT = t;
    }
  }
  for (const e of w.enemies) {
    if (e.state === 'destroyed' || e.state === 'inFormation') continue;
    if (e.kind === 'capturedFighter' && e.captiveMode === 'freed') continue;
    if (e.y > p.y - 110 && e.y < p.y + 20 && Math.abs(e.x - p.x) < half + 26) {
      threat = e.x;
      threatT = 0;
    }
  }
  if (threat !== null) {
    let dir: -1 | 1 = threat <= p.x ? 1 : -1;
    if (p.x > ENGINE.player.maxX - 30 && dir === 1) dir = -1;
    if (p.x < ENGINE.player.minX + 30 && dir === -1) dir = 1;
    return { ...NO_INPUT, moveX: dir, fire: fireTick };
  }
  // target: the reachable enemy closest horizontally, preferring divers
  let best: { x: number; score: number } | null = null;
  for (const e of w.enemies) {
    if (e.state === 'destroyed' || e.y < 8 || e.y > p.y - 60) continue;
    if (e.kind === 'capturedFighter' && e.captiveMode !== 'hostile') continue; // never shoot our own captive
    if (e.beam) continue; // stay out from under a beam
    const scoreV = Math.abs(e.x - p.x) - (e.state === 'attacking' ? 60 : 0);
    if (!best || scoreV < best.score) best = { x: e.x, score: scoreV };
  }
  if (!best) return NO_INPUT;
  const dx = best.x - p.x;
  return { ...NO_INPUT, moveX: Math.abs(dx) < 3 ? 0 : dx < 0 ? -1 : 1, fire: fireTick && Math.abs(dx) < 10 };
}

/* -------------------------------- invariants -------------------------------- */

/** Longest legitimate stay per phase (ms) before we call it a deadlock. */
export const PHASE_LIMIT_MS: Partial<Record<GamePhase, number>> = {
  ready: ENGINE.stage.introMs + 200,
  playerHit: ENGINE.player.maxRespawnWaitMs + 200,
  stageCleared: ENGINE.stage.challengeResultMs + 200,
  gameOver: ENGINE.stage.gameOverMs + 200,
  // a stage with an active player and a shooting bot must end eventually
  playing: 6 * 60_000,
  challenge: 90_000,
};

export interface SoakStats {
  ticks: number;
  stagesStarted: number;
  maxStage: number;
  challengeStages: number;
  perfectChallenges: number;
  captures: number;
  duals: number;
  deaths: number;
  gameOvers: number;
  maxEnemyShots: number;
  maxPlayerShots: number;
  maxEffects: number;
  maxEnemies: number;
  phaseVisits: Record<string, number>;
  violations: string[];
}

export function newStats(): SoakStats {
  return { ticks: 0, stagesStarted: 0, maxStage: 0, challengeStages: 0, perfectChallenges: 0, captures: 0, duals: 0, deaths: 0, gameOvers: 0, maxEnemyShots: 0, maxPlayerShots: 0, maxEffects: 0, maxEnemies: 0, phaseVisits: {}, violations: [] };
}

/** Returns a per-tick checker bound to one engine. */
export function invariantChecker(engine: GameEngine, stats: SoakStats): () => void {
  let lastPhase = engine.phase;
  let phaseSinceMs = 0;
  let lastScore = engine.rewards.snapshot().score;
  let rejectedSeen = 0;
  const W = ENGINE.world.width;
  const H = ENGINE.world.height;
  const flag = (msg: string): void => {
    if (stats.violations.length < 30) stats.violations.push(`seed ${engine.currentSeed} tick ${engine.world.tick} stage ${engine.world.stage} ${engine.phase}: ${msg}`);
  };
  return () => {
    const w = engine.world;
    stats.ticks += 1;
    const ph = engine.phase;
    if (ph !== lastPhase) {
      stats.phaseVisits[ph] = (stats.phaseVisits[ph] ?? 0) + 1;
      lastPhase = ph;
      phaseSinceMs = 0;
    } else phaseSinceMs += 1000 / ENGINE.tickHz;
    const limit = PHASE_LIMIT_MS[ph];
    if (limit !== undefined && phaseSinceMs > limit) {
      flag(`stuck in ${ph} for ${Math.round(phaseSinceMs)} ms (enemies ${w.enemies.length}, states ${[...new Set(w.enemies.map((e) => e.state))].join('/')})`);
      phaseSinceMs = Number.NEGATIVE_INFINITY; // report once
    }
    if (engine.rejectedFacts.length > rejectedSeen) {
      for (const r of engine.rejectedFacts.slice(rejectedSeen)) flag(`fact rejected: ${r.fact.type} (${r.reason}${r.detail ? ': ' + r.detail : ''})`);
      rejectedSeen = engine.rejectedFacts.length;
    }
    const snap = engine.rewards.snapshot();
    if (snap.score < lastScore && snap.status === 'running') flag(`score went down ${lastScore} -> ${snap.score}`);
    lastScore = snap.score;
    const p = w.player;
    const [minX, maxX] = p.dual ? [ENGINE.player.dualMinX, ENGINE.player.dualMaxX] : [ENGINE.player.minX, ENGINE.player.maxX];
    if (p.state === 'alive' && (p.x < minX - 1e-6 || p.x > maxX + 1e-6)) flag(`player out of bounds x=${p.x}`);
    if (w.playerShots.length > (p.dual ? ENGINE.shots.maxDual : ENGINE.shots.maxSingle) && p.state === 'alive') {
      // shots fired as a dual fighter may outlive a lost half; never more than maxDual
      if (w.playerShots.length > ENGINE.shots.maxDual) flag(`too many player shots ${w.playerShots.length}`);
    }
    for (const s of w.playerShots) if (s.y < -40 || s.y > H + 1) flag(`player shot not removed y=${s.y}`);
    for (const s of w.enemyShots) if (s.y > H + 40 || s.x < -60 || s.x > W + 60) flag(`enemy shot not removed (${s.x},${s.y})`);
    for (const e of w.enemies) {
      if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) flag(`enemy ${e.id} NaN position`);
      else if (e.x < -120 || e.x > W + 120 || e.y < -200 || e.y > H + 200) flag(`enemy ${e.id} ${e.kind} far outside (${Math.round(e.x)},${Math.round(e.y)}) state ${e.state}`);
    }
    stats.maxEnemyShots = Math.max(stats.maxEnemyShots, w.enemyShots.length);
    stats.maxPlayerShots = Math.max(stats.maxPlayerShots, w.playerShots.length);
    stats.maxEffects = Math.max(stats.maxEffects, w.effects.length);
    stats.maxEnemies = Math.max(stats.maxEnemies, w.enemies.length);
    stats.maxStage = Math.max(stats.maxStage, w.stage);
  };
}

/** Counts lifecycle events from the engine's event stream (call drainEvents yourself or pass them here). */
export function tallyEvents(stats: SoakStats, events: readonly { type: string; challenge?: boolean }[]): void {
  for (const e of events) {
    if (e.type === 'stageStarted') {
      stats.stagesStarted += 1;
      if (e.challenge) stats.challengeStages += 1;
    } else if (e.type === 'fighterCaptured') stats.captures += 1;
    else if (e.type === 'dualFighterFormed') stats.duals += 1;
    else if (e.type === 'playerDestroyed') stats.deaths += 1;
    else if (e.type === 'gameOver') stats.gameOvers += 1;
  }
}
