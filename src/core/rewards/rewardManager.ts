/**
 * RewardManager: the single authority for score, extra fighters, bonuses and
 * the rescue reward. Pure and deterministic (no DOM, no clock, no randomness).
 *
 * Guarantees (each covered by tests/rewards.test.ts):
 *  - a fact is fully validated before any state changes (rejections are side-effect free);
 *  - every award has an idempotency key, so one kill / wave / group / challenge / rescue
 *    can never pay twice, and each fact pays at most its kill value plus one bonus;
 *  - extra-life thresholds are counted monotonically: each threshold pays exactly once,
 *    even when one award jumps over several thresholds;
 *  - nothing is awarded before startGame() or after gameOver;
 *  - amounts are non-negative integers and the score saturates at config.score.max;
 *  - the Dual Fighter only activates on `captiveDocked` for a fighter that was captured
 *    and then freed by an attacking-captor kill; a commander death alone never grants it;
 *  - listeners run after state is final; a throwing listener cannot affect state or peers.
 */
import { CLASSIC_MODE, type GameModeConfig } from '../../config/gameModes.ts';
import { TRANSFORM_KINDS, type ScoringConfig, type TransformKind } from '../../config/scoring.ts';
import { challengeNumber, isValidStage, stageKind, type StageKind } from '../../config/stages.ts';
import { TypedEventBus } from './eventBus.ts';
import { extraLifeThreshold, extraLivesEarnedAt } from './extraLives.ts';
import type { EnemyDestroyedFact, EnemyPhase, FactResult, GameplayFact, RejectReason, RewardEvent, ScoreSource } from './types.ts';

export type GameStatus = 'idle' | 'running' | 'over';
export type CaptiveStatus = 'held' | 'released' | 'hostile' | 'destroyed' | 'rescued' | 'lost';

export interface CaptiveRecord {
  readonly fighterId: string;
  readonly captorId: string | null;
  readonly status: CaptiveStatus;
  readonly captureSeq: number;
}

export interface RewardSnapshot {
  readonly modeId: string;
  readonly status: GameStatus;
  readonly score: number;
  readonly highScore: number;
  readonly newHighScore: boolean;
  readonly reserves: number;
  readonly stage: number;
  readonly stageKind: StageKind | null;
  readonly challengeNumber: number | null;
  readonly dualFighterActive: boolean;
  readonly extraLivesAwarded: number;
  readonly nextExtraLife: number | null;
  readonly captives: readonly CaptiveRecord[];
}

export interface RewardManagerOptions {
  readonly mode?: GameModeConfig;
  /** Stored high score to beat (from persistence). */
  readonly highScore?: number;
  readonly onListenerError?: (error: unknown, event: RewardEvent) => void;
}

interface GroupRecord {
  readonly kind: TransformKind;
  readonly kills: Set<string>;
  status: 'open' | 'cleared' | 'ended';
}

const PHASES: readonly EnemyPhase[] = ['formation', 'entering', 'attacking'];
const LIVE_CAPTIVE: readonly CaptiveStatus[] = ['held', 'released', 'hostile'];

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const isPoints = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isEscorts = (v: unknown): v is 0 | 1 | 2 => v === 0 || v === 1 || v === 2;

class Rejection {
  readonly reason: RejectReason;
  readonly detail: string;
  constructor(reason: RejectReason, detail: string) {
    this.reason = reason;
    this.detail = detail;
  }
}

export class RewardManager {
  readonly mode: GameModeConfig;
  readonly events: TypedEventBus<RewardEvent>;
  private readonly scoring: ScoringConfig;

  private status: GameStatus = 'idle';
  private score = 0;
  private highScore: number;
  private highScoreAtStart: number;
  private highScoreBeatenEmitted = false;
  private reserves = 0;
  private stage = 0;
  private kind: StageKind | null = null;
  private challengeNo: number | null = null;
  private dualActive = false;
  private extraLivesAwarded = 0;
  private captureSeq = 0;

  private readonly awardedKeys = new Set<string>();
  private readonly killedThisStage = new Set<string>();
  private readonly waveKills = new Map<number, number>();
  private challengeHits = 0;
  private challengeEnded = false;
  private readonly groups = new Map<string, GroupRecord>();
  private readonly captives = new Map<string, CaptiveRecord>();

  constructor(options: RewardManagerOptions = {}) {
    this.mode = options.mode ?? CLASSIC_MODE;
    this.scoring = this.mode.scoring;
    const stored = options.highScore ?? 0;
    this.highScore = isPoints(stored) ? Math.min(stored, this.scoring.score.max) : 0;
    this.highScoreAtStart = this.highScore;
    this.events = new TypedEventBus<RewardEvent>(options.onListenerError);
  }

  /** Reset per-game state and begin a new game. Keeps the high score. */
  startGame(): FactResult {
    this.status = 'running';
    this.score = 0;
    this.highScoreAtStart = this.highScore;
    this.highScoreBeatenEmitted = false;
    this.reserves = this.scoring.fighters.starting - 1;
    this.stage = 0;
    this.kind = null;
    this.challengeNo = null;
    this.dualActive = false;
    this.extraLivesAwarded = 0;
    this.captureSeq = 0;
    this.awardedKeys.clear();
    this.resetStageState();
    this.captives.clear();
    return this.flush([{ type: 'gameStarted', modeId: this.mode.id, reserves: this.reserves, highScore: this.highScore }]);
  }

  /** Process one gameplay fact. Never throws for bad input; returns a rejection instead. */
  handle(fact: GameplayFact): FactResult {
    if (this.status !== 'running') return this.reject('game-not-running', `status is ${this.status}`);
    if (fact === null || typeof fact !== 'object' || typeof (fact as { type?: unknown }).type !== 'string') {
      return this.reject('invalid-fact', 'fact must be an object with a type');
    }
    const out: RewardEvent[] = [];
    try {
      if (fact.type !== 'stageStarted' && fact.type !== 'gameOver' && this.stage === 0) {
        throw new Rejection('no-stage', 'stageStarted must precede gameplay facts');
      }
      switch (fact.type) {
        case 'stageStarted':
          this.onStageStarted(fact.stage, out);
          break;
        case 'enemyDestroyed':
          this.onEnemyDestroyed(fact, out);
          break;
        case 'transformGroupEnded': {
          if (!isId(fact.groupId)) throw new Rejection('invalid-fact', 'groupId required');
          const g = this.groups.get(fact.groupId);
          if (g?.status === 'cleared' || g?.status === 'ended') throw new Rejection('duplicate', 'group already closed');
          if (g) g.status = 'ended';
          else this.groups.set(fact.groupId, { kind: 'stinger', kills: new Set(), status: 'ended' });
          break;
        }
        case 'challengeStageEnded':
          this.onChallengeEnded(out);
          break;
        case 'fighterCaptured':
          this.onCaptured(fact.fighterId, fact.captorId, out);
          break;
        case 'captiveFreed':
          this.onFreed(fact.fighterId, fact.captorId, out);
          break;
        case 'captiveDocked':
          this.onDocked(fact.fighterId, out);
          break;
        case 'captiveTurnedHostile': {
          const c = this.requireCaptive(fact.fighterId, ['held']);
          if (c.captorId !== fact.captorId) throw new Rejection('invalid-rescue-state', 'captor mismatch');
          this.setCaptive({ ...c, status: 'hostile', captorId: null });
          out.push(this.rescueEvent(c.fighterId, c.captorId, { status: 'failed', reason: 'captor-destroyed-in-formation' }, 0));
          break;
        }
        case 'captiveRebound': {
          if (!isId(fact.captorId)) throw new Rejection('invalid-fact', 'captorId required');
          const c = this.requireCaptive(fact.fighterId, ['hostile']);
          this.setCaptive({ ...c, status: 'held', captorId: fact.captorId });
          break;
        }
        case 'captiveLost': {
          if (fact.reason !== 'player-lost-before-docking' && fact.reason !== 'game-over') throw new Rejection('invalid-fact', 'unknown loss reason');
          const c = this.requireCaptive(fact.fighterId, LIVE_CAPTIVE);
          this.setCaptive({ ...c, status: 'lost' });
          out.push(this.rescueEvent(c.fighterId, c.captorId, { status: 'failed', reason: fact.reason }, 0));
          break;
        }
        case 'playerFighterDestroyed':
          this.onPlayerDestroyed(fact.dualHalf, out);
          break;
        case 'powerUpCollected':
          if (!this.mode.powerUps?.enabled) throw new Rejection('power-ups-disabled', `mode ${this.mode.id} has no power-ups`);
          if (!isId(fact.powerUpId) || !isId(fact.kind) || !this.mode.powerUps.kinds.includes(fact.kind)) {
            throw new Rejection('invalid-fact', 'unknown power-up');
          }
          if (this.awardedKeys.has(`powerup:${fact.powerUpId}`)) throw new Rejection('duplicate', 'power-up already collected');
          this.awardedKeys.add(`powerup:${fact.powerUpId}`);
          out.push({ type: 'powerUpCollected', powerUpId: fact.powerUpId, kind: fact.kind });
          break;
        case 'gameOver':
          this.onGameOver(out);
          break;
        default:
          throw new Rejection('invalid-fact', `unknown fact type ${(fact as { type: string }).type}`);
      }
    } catch (e) {
      if (e instanceof Rejection) return this.reject(e.reason, e.detail);
      throw e;
    }
    return this.flush(out);
  }

  snapshot(): RewardSnapshot {
    return {
      modeId: this.mode.id,
      status: this.status,
      score: this.score,
      highScore: this.highScore,
      newHighScore: this.score > 0 && this.score > this.highScoreAtStart,
      reserves: this.reserves,
      stage: this.stage,
      stageKind: this.kind,
      challengeNumber: this.challengeNo,
      dualFighterActive: this.dualActive,
      extraLivesAwarded: this.extraLivesAwarded,
      nextExtraLife: extraLifeThreshold(this.scoring.extraLives, this.extraLivesAwarded),
      captives: [...this.captives.values()],
    };
  }

  /* ------------------------------------------------------------------------ */

  private onStageStarted(stage: number, out: RewardEvent[]): void {
    if (!isValidStage(stage)) throw new Rejection('invalid-fact', `invalid stage ${String(stage)}`);
    if (stage <= this.stage) throw new Rejection('invalid-fact', `stage must increase (current ${this.stage})`);
    this.stage = stage;
    this.kind = stageKind(stage, this.mode.schedule);
    this.challengeNo = challengeNumber(stage, this.mode.schedule);
    this.resetStageState();
    out.push({ type: 'stageChanged', stage, kind: this.kind, challengeNumber: this.challengeNo });
  }

  private resetStageState(): void {
    this.killedThisStage.clear();
    this.waveKills.clear();
    this.challengeHits = 0;
    this.challengeEnded = false;
    this.groups.clear();
  }

  private onEnemyDestroyed(fact: EnemyDestroyedFact, out: RewardEvent[]): void {
    // ---- validate everything first (no mutation until the plan is final) ----
    if (!isId(fact.enemyId)) throw new Rejection('invalid-fact', 'enemyId required');
    if (!PHASES.includes(fact.phase)) throw new Rejection('invalid-fact', `invalid phase ${String(fact.phase)}`);
    if (this.killedThisStage.has(fact.enemyId)) throw new Rejection('duplicate', `enemy ${fact.enemyId} already scored this stage`);
    const s = this.scoring;
    const inChallenge = this.kind === 'challenge';
    let value: number;
    let escorts: number | undefined;
    let wave: number | null = null;
    let group: { id: string; kind: TransformKind } | null = null;
    let captive: CaptiveRecord | null = null;
    const attacking = fact.phase === 'attacking' || (fact.phase === 'entering' && s.rules.enteringCountsAsAttack);

    if (inChallenge) {
      if (this.challengeEnded) throw new Rejection('invalid-fact', 'challenge stage already ended');
      if (!Number.isInteger(fact.wave) || (fact.wave as number) < 0 || (fact.wave as number) >= s.challenge.waves) {
        throw new Rejection('invalid-fact', `wave must be 0..${s.challenge.waves - 1} in a Challenging Stage`);
      }
      wave = fact.wave as number;
    }

    switch (fact.kind) {
      case 'scout':
      case 'interceptor': {
        const v = s.enemies[fact.kind];
        value = inChallenge || attacking ? v.attack : v.formation;
        break;
      }
      case 'challengeSpecial':
        if (!inChallenge) throw new Rejection('wrong-stage-kind', 'challengeSpecial only exists in Challenging Stages');
        value = s.enemies.challengeSpecial;
        break;
      case 'commander': {
        for (const n of [fact.escortsAtDiveStart, fact.escortsAlive]) {
          if (n !== undefined && !isEscorts(n)) throw new Rejection('invalid-fact', 'escort counts must be 0, 1 or 2');
        }
        if (fact.escortsAtDiveStart !== undefined && fact.escortsAlive !== undefined && fact.escortsAlive > fact.escortsAtDiveStart) {
          throw new Rejection('invalid-fact', 'escortsAlive cannot exceed escortsAtDiveStart');
        }
        if (fact.holdingFighterId !== undefined && !isId(fact.holdingFighterId)) throw new Rejection('invalid-fact', 'holdingFighterId invalid');
        if (!inChallenge && !attacking) {
          value = s.enemies.commander.formation;
        } else {
          const eligible = !inChallenge && (fact.phase === 'attacking' || s.rules.escortBonusWhileEntering);
          const counted = s.rules.escortCountRule === 'at-dive-start' ? fact.escortsAtDiveStart : fact.escortsAlive;
          escorts = eligible ? (counted ?? 0) : 0;
          value = s.enemies.commander.attackByEscorts[escorts]!;
        }
        // Note: holdingFighterId never grants a rescue. The engine must follow up with
        // captiveFreed (attacking captor) or captiveTurnedHostile (captor in formation).
        break;
      }
      case 'capturedFighter': {
        if (inChallenge) throw new Rejection('wrong-stage-kind', 'captured fighters do not appear in Challenging Stages');
        captive = this.requireCaptive(fact.fighterId, ['held', 'hostile']);
        value = attacking ? s.enemies.capturedFighter.attack : s.enemies.capturedFighter.formation;
        break;
      }
      case 'transform': {
        if (!TRANSFORM_KINDS.includes(fact.transformKind)) throw new Rejection('invalid-fact', 'unknown transformKind');
        value = s.transforms.kinds[fact.transformKind].each; // transforms are always attacking
        if (!inChallenge && fact.groupId !== undefined) {
          if (!isId(fact.groupId)) throw new Rejection('invalid-fact', 'groupId invalid');
          const existing = this.groups.get(fact.groupId);
          if (existing && existing.kind !== fact.transformKind && existing.status === 'open') {
            throw new Rejection('invalid-fact', 'transformKind does not match its group');
          }
          group = { id: fact.groupId, kind: fact.transformKind };
        }
        break;
      }
      default:
        throw new Rejection('invalid-fact', `unknown enemy kind ${String((fact as { kind?: unknown }).kind)}`);
    }

    // ---- apply ----
    this.killedThisStage.add(fact.enemyId);
    const source: ScoreSource = fact.kind === 'capturedFighter' ? 'capturedFighter' : 'enemy';
    this.award(source, value, `kill:${this.stage}:${fact.enemyId}`, out, {
      enemyKind: fact.kind === 'transform' ? `transform.${fact.transformKind}` : fact.kind,
      phase: inChallenge ? 'challenge' : fact.phase,
      ...(escorts !== undefined ? { escorts } : {}),
      ...(fact.position ? { position: fact.position } : {}),
    });

    if (captive) {
      this.setCaptive({ ...captive, status: 'destroyed' });
      out.push(this.rescueEvent(captive.fighterId, captive.captorId, { status: 'failed', reason: 'captive-destroyed' }, 0));
    }

    // At most one bonus per kill: wave bonus (challenge) XOR group bonus (normal).
    if (wave !== null) {
      this.challengeHits += 1;
      const n = (this.waveKills.get(wave) ?? 0) + 1;
      this.waveKills.set(wave, n);
      if (n === s.challenge.waveSize) {
        const bonus = this.waveBonus();
        out.push({ type: 'challengeWaveCleared', stage: this.stage, wave, bonus });
        this.award('challengeWave', bonus, `wave:${this.stage}:${wave}`, out, {});
      }
    } else if (group) {
      let g = this.groups.get(group.id);
      if (!g) {
        g = { kind: group.kind, kills: new Set(), status: 'open' };
        this.groups.set(group.id, g);
      }
      if (g.status === 'open') {
        g.kills.add(fact.enemyId);
        if (g.kills.size >= s.transforms.groupSize) {
          g.status = 'cleared';
          const bonus = s.transforms.kinds[g.kind].groupBonus;
          out.push({ type: 'transformGroupCleared', groupId: group.id, transformKind: g.kind, bonus });
          this.award('transformGroup', bonus, `group:${this.stage}:${group.id}`, out, {});
        }
      }
    }
  }

  private waveBonus(): number {
    const table = this.scoring.challenge.waveBonusByChallenge;
    const n = this.challengeNo ?? 1;
    const index = this.scoring.challenge.afterTable === 'cycle' ? (n - 1) % table.length : Math.min(n, table.length) - 1;
    return table[index]!;
  }

  private onChallengeEnded(out: RewardEvent[]): void {
    if (this.kind !== 'challenge') throw new Rejection('wrong-stage-kind', 'not a Challenging Stage');
    if (this.challengeEnded) throw new Rejection('duplicate', 'challenge result already awarded');
    this.challengeEnded = true;
    const c = this.scoring.challenge;
    const total = c.waves * c.waveSize;
    const hits = Math.min(this.challengeHits, total);
    const perfect = hits === total;
    const perHit = hits * c.perHitBonus;
    const bonus = perfect ? (c.perfectReplacesPerHit ? c.perfectBonus : perHit + c.perfectBonus) : perHit;
    out.push({
      type: 'challengeStageResult',
      stage: this.stage,
      challengeNumber: this.challengeNo ?? 1,
      hits,
      total,
      perfect,
      perHitBonus: perfect && c.perfectReplacesPerHit ? 0 : perHit,
      perfectBonus: perfect ? c.perfectBonus : 0,
      bonus,
    });
    this.award('challengeResult', bonus, `challenge:${this.stage}`, out, {});
  }

  private onCaptured(fighterId: string, captorId: string, out: RewardEvent[]): void {
    if (!isId(fighterId) || !isId(captorId)) throw new Rejection('invalid-fact', 'fighterId and captorId required');
    if (this.kind === 'challenge') throw new Rejection('wrong-stage-kind', 'no captures in Challenging Stages');
    if (this.dualActive) throw new Rejection('invalid-rescue-state', 'a Dual Fighter cannot be captured');
    const existing = this.captives.get(fighterId);
    if (existing && LIVE_CAPTIVE.includes(existing.status)) throw new Rejection('duplicate', `fighter ${fighterId} is already captive`);
    if ([...this.captives.values()].some((c) => c.captorId === captorId && LIVE_CAPTIVE.includes(c.status))) {
      throw new Rejection('invalid-rescue-state', `captor ${captorId} already holds a fighter`);
    }
    this.captureSeq += 1;
    this.setCaptive({ fighterId, captorId, status: 'held', captureSeq: this.captureSeq });
    // The captured ship was the ship in play: the next reserve ship deploys.
    const delta = this.reserves > 0 ? -1 : 0;
    this.reserves += delta;
    out.push({ type: 'fighterCaptured', fighterId, captorId, reserves: this.reserves });
    if (delta !== 0) out.push({ type: 'reservesChanged', reserves: this.reserves, delta });
  }

  private onFreed(fighterId: string, captorId: string, out: RewardEvent[]): void {
    const c = this.requireCaptive(fighterId, ['held']);
    if (c.captorId !== captorId) throw new Rejection('invalid-rescue-state', 'captor mismatch');
    this.setCaptive({ ...c, status: 'released' });
    out.push(this.rescueEvent(fighterId, captorId, { status: 'freed' }, 0));
  }

  private onDocked(fighterId: string, out: RewardEvent[]): void {
    const c = this.requireCaptive(fighterId, ['released']);
    if (this.dualActive) throw new Rejection('invalid-rescue-state', 'Dual Fighter already active');
    this.setCaptive({ ...c, status: 'rescued' });
    this.dualActive = true;
    const bonus = this.scoring.rescue.bonus;
    out.push(this.rescueEvent(fighterId, c.captorId, { status: 'rescued' }, bonus));
    out.push({ type: 'dualFighterChanged', active: true });
    this.award('rescue', bonus, `rescue:${fighterId}:${c.captureSeq}`, out, {});
  }

  private onPlayerDestroyed(dualHalf: boolean, out: RewardEvent[]): void {
    if (typeof dualHalf !== 'boolean') throw new Rejection('invalid-fact', 'dualHalf must be boolean');
    if (dualHalf && !this.dualActive) throw new Rejection('invalid-rescue-state', 'no Dual Fighter to split');
    if (this.dualActive) {
      this.dualActive = false;
      out.push({ type: 'dualFighterChanged', active: false });
    }
    if (!dualHalf && this.reserves > 0) {
      this.reserves -= 1;
      out.push({ type: 'reservesChanged', reserves: this.reserves, delta: -1 });
    }
  }

  private onGameOver(out: RewardEvent[]): void {
    for (const c of this.captives.values()) {
      if (LIVE_CAPTIVE.includes(c.status)) {
        this.setCaptive({ ...c, status: 'lost' });
        out.push(this.rescueEvent(c.fighterId, c.captorId, { status: 'failed', reason: 'game-over' }, 0));
      }
    }
    this.status = 'over';
    out.push({
      type: 'gameOver',
      finalScore: this.score,
      highScore: this.highScore,
      newHighScore: this.score > 0 && this.score > this.highScoreAtStart,
      stage: this.stage,
    });
  }

  /* ------------------------------------------------------------------------ */

  private award(
    source: ScoreSource,
    requested: number,
    key: string,
    out: RewardEvent[],
    meta: Partial<Extract<RewardEvent, { type: 'pointsAwarded' }>>,
  ): void {
    if (!isPoints(requested)) throw new Error(`Invariant: invalid award ${String(requested)} for ${key}`); // config is validated
    if (this.awardedKeys.has(key)) return;
    this.awardedKeys.add(key);
    if (requested === 0) return;
    const before = this.score;
    this.score = Math.min(this.scoring.score.max, before + requested);
    const amount = this.score - before;
    out.push({ ...meta, type: 'pointsAwarded', source, amount, requested, scoreAfter: this.score, key });
    if (amount === 0) return;
    if (this.score > this.highScore) this.highScore = this.score;
    out.push({ type: 'scoreChanged', score: this.score, delta: amount, highScore: this.highScore });
    if (!this.highScoreBeatenEmitted && this.highScoreAtStart > 0 && this.score > this.highScoreAtStart) {
      this.highScoreBeatenEmitted = true;
      out.push({ type: 'highScoreBeaten', score: this.score, previous: this.highScoreAtStart });
    }
    const earned = extraLivesEarnedAt(this.scoring.extraLives, this.score);
    while (this.extraLivesAwarded < earned) {
      const index = this.extraLivesAwarded;
      const threshold = extraLifeThreshold(this.scoring.extraLives, index)!;
      if (this.awardedKeys.has(`extraLife:${index}`)) break; // belt and braces
      this.awardedKeys.add(`extraLife:${index}`);
      this.extraLivesAwarded += 1;
      this.reserves += 1;
      out.push({
        type: 'extraLifeAwarded',
        index,
        threshold,
        reserves: this.reserves,
        nextThreshold: extraLifeThreshold(this.scoring.extraLives, this.extraLivesAwarded),
      });
      out.push({ type: 'reservesChanged', reserves: this.reserves, delta: 1 });
    }
  }

  private requireCaptive(fighterId: string, allowed: readonly CaptiveStatus[]): CaptiveRecord {
    if (!isId(fighterId)) throw new Rejection('invalid-fact', 'fighterId required');
    const c = this.captives.get(fighterId);
    if (!c) throw new Rejection('invalid-rescue-state', `fighter ${fighterId} was never captured`);
    if (!allowed.includes(c.status)) throw new Rejection('invalid-rescue-state', `fighter ${fighterId} is ${c.status}, expected ${allowed.join('|')}`);
    return c;
  }

  private setCaptive(record: CaptiveRecord): void {
    this.captives.set(record.fighterId, record);
  }

  private rescueEvent(
    fighterId: string,
    captorId: string | null,
    outcome: Extract<RewardEvent, { type: 'rescue' }>['outcome'],
    bonus: number,
  ): RewardEvent {
    const rescued = outcome.status === 'rescued';
    return {
      type: 'rescue',
      fighterId,
      captorId,
      outcome,
      secondFighterAvailable: rescued,
      dualFighterActive: rescued ? true : this.dualActive,
      bonus,
    };
  }

  private reject(reason: RejectReason, detail: string): FactResult {
    return { accepted: false, reason, detail, events: [] };
  }

  private flush(out: RewardEvent[]): FactResult {
    for (const e of out) this.events.emit(e);
    return { accepted: true, events: out };
  }
}
