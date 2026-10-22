import { describe, expect, it } from 'vitest';
import { defineGameMode } from '../src/config/gameModes.ts';
import { createScoringConfig } from '../src/config/scoring.ts';
import { RewardManager } from '../src/core/rewards/rewardManager.ts';
import { trackStats } from '../src/core/rewards/stats.ts';
import type { EnemyDestroyedFact, GameplayFact, RewardEvent } from '../src/core/rewards/types.ts';

let seq = 0;
const uid = (p = 'e'): string => `${p}${++seq}`;

function game(options: ConstructorParameters<typeof RewardManager>[0] = {}, stage = 1): RewardManager {
  const m = new RewardManager(options);
  m.startGame();
  if (stage > 0) {
    // Walk stages so ordering rules hold.
    for (let s = 1; s <= stage; s++) expect(m.handle({ type: 'stageStarted', stage: s }).accepted).toBe(true);
  }
  return m;
}

type KillInput = EnemyDestroyedFact extends infer F ? (F extends unknown ? Omit<F, 'type' | 'enemyId'> & { enemyId?: string } : never) : never;
function kill(m: RewardManager, f: KillInput) {
  return m.handle({ type: 'enemyDestroyed', enemyId: f.enemyId ?? uid(), ...f } as GameplayFact);
}

const points = (events: readonly RewardEvent[]): number =>
  events.reduce((sum, e) => (e.type === 'pointsAwarded' ? sum + e.amount : sum), 0);
const ofType = <T extends RewardEvent['type']>(events: readonly RewardEvent[], type: T) =>
  events.filter((e): e is Extract<RewardEvent, { type: T }> => e.type === type);

/** Push the score up with formation-commander kills (150 each) on normal stages. */
function addScore(m: RewardManager, target: number): void {
  while (m.snapshot().score + 150 <= target) kill(m, { kind: 'commander', phase: 'formation' });
}

describe('kill values', () => {
  it.each([
    ['scout', 'formation', 50],
    ['scout', 'attacking', 100],
    ['scout', 'entering', 100],
    ['interceptor', 'formation', 80],
    ['interceptor', 'attacking', 160],
    ['interceptor', 'entering', 160],
  ] as const)('%s while %s = %i', (kind, phase, expected) => {
    const m = game();
    expect(points(kill(m, { kind, phase }).events)).toBe(expected);
  });

  it('entry flight pays formation values when the rule is switched off (config only)', () => {
    const mode = defineGameMode({ id: 'entry-off', label: 't', scoring: { rules: { enteringCountsAsAttack: false } } });
    const m = game({ mode });
    expect(points(kill(m, { kind: 'scout', phase: 'entering' }).events)).toBe(50);
  });

  it('commander: 150 in formation, 400 / 800 / 1600 attacking with 0 / 1 / 2 escorts', () => {
    const m = game();
    expect(points(kill(m, { kind: 'commander', phase: 'formation' }).events)).toBe(150);
    expect(points(kill(m, { kind: 'commander', phase: 'attacking' }).events)).toBe(400);
    expect(points(kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 0 }).events)).toBe(400);
    expect(points(kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 1 }).events)).toBe(800);
    expect(points(kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 2 }).events)).toBe(1600);
  });

  it('escort bonus is locked at dive start: shooting escorts first keeps 1600', () => {
    const m = game();
    expect(points(kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 2, escortsAlive: 0 }).events)).toBe(1600);
  });

  it("'alive-at-kill' rule (alternative, config only) counts surviving escorts", () => {
    const mode = defineGameMode({ id: 'alive', label: 't', scoring: { rules: { escortCountRule: 'alive-at-kill' } } });
    const m = game({ mode });
    expect(points(kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 2, escortsAlive: 1 }).events)).toBe(800);
  });

  it('no escort bonus during the entry flight (classic)', () => {
    const m = game();
    expect(points(kill(m, { kind: 'commander', phase: 'entering', escortsAtDiveStart: 2 }).events)).toBe(400);
  });

  it('transforms are always attacking: 160 each regardless of phase', () => {
    const m = game();
    expect(points(kill(m, { kind: 'transform', transformKind: 'phantom', phase: 'formation' }).events)).toBe(160);
  });

  it('reports kill metadata for UI/audio/stats', () => {
    const m = game();
    const [award] = ofType(kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 1, position: { x: 10, y: 20 } }).events, 'pointsAwarded');
    expect(award).toMatchObject({ source: 'enemy', enemyKind: 'commander', phase: 'attacking', escorts: 1, position: { x: 10, y: 20 }, amount: 800 });
  });
});

describe('transform set bonus', () => {
  it('pays the set bonus once when every member of a group is destroyed', () => {
    const m = game();
    const g = uid('g');
    const r1 = kill(m, { kind: 'transform', transformKind: 'sovereign', groupId: g, phase: 'attacking' });
    const r2 = kill(m, { kind: 'transform', transformKind: 'sovereign', groupId: g, phase: 'attacking' });
    const r3 = kill(m, { kind: 'transform', transformKind: 'sovereign', groupId: g, phase: 'attacking' });
    expect(points(r1.events) + points(r2.events)).toBe(320);
    expect(points(r3.events)).toBe(160 + 3000);
    expect(ofType(r3.events, 'transformGroupCleared')).toHaveLength(1);
    expect(m.snapshot().score).toBe(480 + 3000);
  });

  it('no set bonus if the group ended early', () => {
    const m = game();
    const g = uid('g');
    kill(m, { kind: 'transform', transformKind: 'stinger', groupId: g, phase: 'attacking' });
    kill(m, { kind: 'transform', transformKind: 'stinger', groupId: g, phase: 'attacking' });
    expect(m.handle({ type: 'transformGroupEnded', groupId: g }).accepted).toBe(true);
    const r = kill(m, { kind: 'transform', transformKind: 'stinger', groupId: g, phase: 'attacking' });
    expect(points(r.events)).toBe(160);
    expect(ofType(r.events, 'transformGroupCleared')).toHaveLength(0);
  });

  it('rejects a kind that does not match its open group', () => {
    const m = game();
    const g = uid('g');
    kill(m, { kind: 'transform', transformKind: 'stinger', groupId: g, phase: 'attacking' });
    expect(kill(m, { kind: 'transform', transformKind: 'phantom', groupId: g, phase: 'attacking' }).reason).toBe('invalid-fact');
  });
});

describe('idempotency and invalid input', () => {
  it('the same kill id never pays twice in a stage', () => {
    const m = game();
    expect(kill(m, { enemyId: 'x1', kind: 'scout', phase: 'attacking' }).accepted).toBe(true);
    const again = kill(m, { enemyId: 'x1', kind: 'scout', phase: 'attacking' });
    expect(again).toMatchObject({ accepted: false, reason: 'duplicate', events: [] });
    expect(m.snapshot().score).toBe(100);
  });

  it('kill ids are scoped per stage', () => {
    const m = game();
    kill(m, { enemyId: 'slot-1', kind: 'scout', phase: 'formation' });
    m.handle({ type: 'stageStarted', stage: 2 });
    expect(kill(m, { enemyId: 'slot-1', kind: 'scout', phase: 'formation' }).accepted).toBe(true);
    expect(m.snapshot().score).toBe(100);
  });

  it.each([
    ['empty id', { type: 'enemyDestroyed', enemyId: '', kind: 'scout', phase: 'formation' }],
    ['unknown kind', { type: 'enemyDestroyed', enemyId: 'z', kind: 'mothership', phase: 'formation' }],
    ['unknown phase', { type: 'enemyDestroyed', enemyId: 'z', kind: 'scout', phase: 'sleeping' }],
    ['3 escorts', { type: 'enemyDestroyed', enemyId: 'z', kind: 'commander', phase: 'attacking', escortsAtDiveStart: 3 }],
    ['NaN escorts', { type: 'enemyDestroyed', enemyId: 'z', kind: 'commander', phase: 'attacking', escortsAtDiveStart: Number.NaN }],
    ['negative escorts', { type: 'enemyDestroyed', enemyId: 'z', kind: 'commander', phase: 'attacking', escortsAtDiveStart: -1 }],
    ['alive > launched', { type: 'enemyDestroyed', enemyId: 'z', kind: 'commander', phase: 'attacking', escortsAtDiveStart: 1, escortsAlive: 2 }],
    ['unknown transform', { type: 'enemyDestroyed', enemyId: 'z', kind: 'transform', transformKind: 'dragon', phase: 'attacking' }],
    ['unknown fact', { type: 'addPoints', amount: 5000 }],
    ['negative stage', { type: 'stageStarted', stage: -3 }],
    ['fractional stage', { type: 'stageStarted', stage: 2.5 }],
  ])('rejects %s without side effects', (_label, fact) => {
    const m = game();
    const before = m.snapshot();
    const r = m.handle(fact as unknown as GameplayFact);
    expect(r.accepted).toBe(false);
    expect(r.events).toEqual([]);
    expect(m.snapshot()).toEqual(before);
  });

  it('there is no API to add arbitrary or negative points', () => {
    const m = game();
    expect('addPoints' in m).toBe(false);
    expect(m.handle({ type: 'addPoints', amount: -500 } as unknown as GameplayFact).accepted).toBe(false);
    expect(m.snapshot().score).toBe(0);
  });

  it('nothing is awarded before startGame or after gameOver', () => {
    const m = new RewardManager();
    expect(m.handle({ type: 'stageStarted', stage: 1 }).reason).toBe('game-not-running');
    m.startGame();
    m.handle({ type: 'stageStarted', stage: 1 });
    kill(m, { kind: 'scout', phase: 'attacking' });
    expect(m.handle({ type: 'gameOver' }).accepted).toBe(true);
    expect(kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 2 }).reason).toBe('game-not-running');
    expect(m.handle({ type: 'gameOver' }).reason).toBe('game-not-running');
    expect(m.snapshot()).toMatchObject({ status: 'over', score: 100 });
  });

  it('gameplay facts need a started stage; stages must increase', () => {
    const m = game({}, 0);
    expect(kill(m, { kind: 'scout', phase: 'formation' }).reason).toBe('no-stage');
    m.handle({ type: 'stageStarted', stage: 1 });
    expect(m.handle({ type: 'stageStarted', stage: 1 }).reason).toBe('invalid-fact');
  });

  it('score saturates at the configured maximum instead of going wrong', () => {
    const mode = defineGameMode({ id: 'cap', label: 't', scoring: { score: { max: 1000 }, extraLives: { first: null, second: null, every: null } } });
    const m = game({ mode });
    kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 1 }); // 800
    const r = kill(m, { kind: 'commander', phase: 'attacking' }); // 400 requested, 200 applied
    expect(ofType(r.events, 'pointsAwarded')[0]).toMatchObject({ requested: 400, amount: 200, scoreAfter: 1000 });
    const r2 = kill(m, { kind: 'scout', phase: 'attacking' });
    expect(ofType(r2.events, 'pointsAwarded')[0]).toMatchObject({ amount: 0 });
    expect(ofType(r2.events, 'scoreChanged')).toHaveLength(0);
  });
});

describe('extra fighters', () => {
  it('awards at 20,000 exactly once, then at 70,000 and every 70,000', () => {
    const m = game();
    expect(m.snapshot().reserves).toBe(2);
    addScore(m, 19950);
    expect(m.snapshot().extraLivesAwarded).toBe(0);
    const r = kill(m, { kind: 'scout', phase: 'attacking' }); // 20,050
    expect(ofType(r.events, 'extraLifeAwarded')).toEqual([expect.objectContaining({ index: 0, threshold: 20000, reserves: 3, nextThreshold: 70000 })]);
    // Further points under 70K never re-award the 20K threshold.
    for (let i = 0; i < 20; i++) expect(ofType(kill(m, { kind: 'scout', phase: 'formation' }).events, 'extraLifeAwarded')).toHaveLength(0);
    addScore(m, 140100);
    expect(m.snapshot()).toMatchObject({ extraLivesAwarded: 3, reserves: 5, nextExtraLife: 210000 });
  });

  it('one award that jumps over several thresholds pays each threshold once', () => {
    const mode = defineGameMode({ id: 'jump', label: 't', scoring: { extraLives: { first: 100, second: 200, every: 100 } } });
    const m = game({ mode });
    const r = kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 2 }); // 1600
    const lives = ofType(r.events, 'extraLifeAwarded');
    expect(lives.map((l) => l.threshold)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600]);
    expect(new Set(lives.map((l) => l.index)).size).toBe(lives.length);
  });

  it('respects "first and second only" and "none" settings', () => {
    const only = game({ mode: defineGameMode({ id: 'o', label: 't', scoring: { extraLives: { first: 150, second: 300, every: null } } }) });
    addScore(only, 3000);
    expect(only.snapshot().extraLivesAwarded).toBe(2);
    const none = game({ mode: defineGameMode({ id: 'n', label: 't', scoring: { extraLives: { first: null, second: null, every: null } } }) });
    addScore(none, 3000);
    expect(none.snapshot()).toMatchObject({ extraLivesAwarded: 0, nextExtraLife: null });
  });

  it('event order: points, score, then extra life', () => {
    const m = game();
    addScore(m, 19950);
    const types = kill(m, { kind: 'scout', phase: 'attacking' }).events.map((e) => e.type);
    expect(types).toEqual(['pointsAwarded', 'scoreChanged', 'extraLifeAwarded', 'reservesChanged']);
  });
});

describe('Challenging Stages', () => {
  const challengeGame = (stage = 3): RewardManager => game({}, stage);
  const clearWave = (m: RewardManager, wave: number, count = 8) => {
    const results = [];
    for (let i = 0; i < count; i++) results.push(kill(m, { kind: 'scout', phase: 'formation', wave }));
    return results;
  };

  it('pays attack values for every target and challengeSpecial = 160', () => {
    const m = challengeGame();
    expect(points(kill(m, { kind: 'scout', phase: 'formation', wave: 0 }).events)).toBe(100);
    expect(points(kill(m, { kind: 'challengeSpecial', phase: 'attacking', wave: 0 }).events)).toBe(160);
    expect(points(kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 2, wave: 0 }).events)).toBe(400);
  });

  it.each([
    [3, 1000],
    [7, 1000],
    [11, 1500],
    [15, 1500],
    [19, 2000],
    [23, 2000],
    [27, 3000],
    [31, 3000],
    [35, 3000],
  ])('wave-clear bonus on stage %i = %i', (stage, bonus) => {
    const m = challengeGame(stage);
    const results = clearWave(m, 0);
    const cleared = results.flatMap((r) => ofType(r.events, 'challengeWaveCleared'));
    expect(cleared).toEqual([expect.objectContaining({ wave: 0, bonus })]);
    expect(ofType(results[7]!.events, 'pointsAwarded').map((p) => p.amount)).toEqual([100, bonus]);
  });

  it("'cycle' policy restarts the table after challenge 8 (config only)", () => {
    const mode = defineGameMode({ id: 'cyc', label: 't', scoring: { challenge: { afterTable: 'cycle' } } });
    const m = game({ mode }, 35);
    const cleared = clearWave(m, 0).flatMap((r) => ofType(r.events, 'challengeWaveCleared'));
    expect(cleared[0]!.bonus).toBe(1000);
  });

  it('perfect: 10,000 instead of 40 × 100', () => {
    const m = challengeGame();
    for (let w = 0; w < 5; w++) clearWave(m, w);
    const r = m.handle({ type: 'challengeStageEnded' });
    const [result] = ofType(r.events, 'challengeStageResult');
    expect(result).toMatchObject({ hits: 40, total: 40, perfect: true, perHitBonus: 0, perfectBonus: 10000, bonus: 10000 });
    expect(points(r.events)).toBe(10000);
    // 40 × 100 kill points + 5 × 1000 wave bonus + 10,000
    expect(m.snapshot().score).toBe(4000 + 5000 + 10000);
  });

  it('partial: 100 per hit, no perfect bonus', () => {
    const m = challengeGame();
    clearWave(m, 0);
    clearWave(m, 1, 3);
    const [result] = ofType(m.handle({ type: 'challengeStageEnded' }).events, 'challengeStageResult');
    expect(result).toMatchObject({ hits: 11, perfect: false, bonus: 1100 });
  });

  it('result pays once; kills after the end and challenge facts on normal stages are rejected', () => {
    const m = challengeGame();
    expect(m.handle({ type: 'challengeStageEnded' }).accepted).toBe(true);
    expect(m.handle({ type: 'challengeStageEnded' }).reason).toBe('duplicate');
    expect(kill(m, { kind: 'scout', phase: 'attacking', wave: 0 }).accepted).toBe(false);
    m.handle({ type: 'stageStarted', stage: 4 });
    expect(m.handle({ type: 'challengeStageEnded' }).reason).toBe('wrong-stage-kind');
    expect(kill(m, { kind: 'challengeSpecial', phase: 'attacking' }).reason).toBe('wrong-stage-kind');
  });

  it('requires a valid wave index', () => {
    const m = challengeGame();
    expect(kill(m, { kind: 'scout', phase: 'attacking' }).reason).toBe('invalid-fact');
    expect(kill(m, { kind: 'scout', phase: 'attacking', wave: 5 }).reason).toBe('invalid-fact');
  });

  it('transforms in a Challenging Stage never pay a set bonus (even if tagged with a group)', () => {
    const m = challengeGame(15);
    const all: RewardEvent[] = [];
    for (let i = 0; i < 8; i++) all.push(...kill(m, { kind: 'transform', transformKind: 'stinger', groupId: 'g-challenge', phase: 'attacking', wave: 0 }).events);
    expect(ofType(all, 'transformGroupCleared')).toHaveLength(0);
    expect(ofType(all, 'challengeWaveCleared')).toHaveLength(1);
  });

  it('one kill that would complete both a wave and a set pays exactly one bonus', () => {
    // groupSize == waveSize so the 8th kill completes both at once.
    const mode = defineGameMode({ id: 'both', label: 't', scoring: { transforms: { groupSize: 8 } } });
    const m = game({ mode }, 3);
    const results = [];
    for (let i = 0; i < 8; i++) results.push(kill(m, { kind: 'transform', transformKind: 'stinger', groupId: 'g', phase: 'attacking', wave: 0 }));
    for (const r of results) {
      const bonusAwards = ofType(r.events, 'pointsAwarded').filter((p) => p.source !== 'enemy');
      expect(bonusAwards.length).toBeLessThanOrEqual(1);
    }
    const last = results.at(-1)!;
    expect(last.events.filter((e) => e.type === 'challengeWaveCleared' || e.type === 'transformGroupCleared').map((e) => e.type)).toEqual(['challengeWaveCleared']);
  });
});

describe('capture and rescue', () => {
  const capture = (m: RewardManager, f = 'f1', w = 'w1') => m.handle({ type: 'fighterCaptured', fighterId: f, captorId: w });

  it('a commander death alone never grants the Dual Fighter', () => {
    const m = game();
    capture(m);
    const r = kill(m, { enemyId: 'w1', kind: 'commander', phase: 'attacking', holdingFighterId: 'f1' });
    expect(r.accepted).toBe(true);
    expect(points(r.events)).toBe(400);
    expect(r.events.some((e) => e.type === 'dualFighterChanged' || e.type === 'rescue')).toBe(false);
    expect(m.snapshot().dualFighterActive).toBe(false);
  });

  it('dock without a prior capture + release is rejected', () => {
    const m = game();
    expect(m.handle({ type: 'captiveDocked', fighterId: 'ghost' }).reason).toBe('invalid-rescue-state');
    capture(m);
    expect(m.handle({ type: 'captiveDocked', fighterId: 'f1' }).reason).toBe('invalid-rescue-state'); // still held
    expect(m.snapshot().dualFighterActive).toBe(false);
  });

  it('full rescue: capture -> captor destroyed attacking -> freed -> docked = Dual Fighter', () => {
    const m = game();
    const c = capture(m);
    expect(ofType(c.events, 'fighterCaptured')[0]).toMatchObject({ fighterId: 'f1', captorId: 'w1', reserves: 1 });
    kill(m, { enemyId: 'w1', kind: 'commander', phase: 'attacking', holdingFighterId: 'f1' });
    const freed = m.handle({ type: 'captiveFreed', fighterId: 'f1', captorId: 'w1' });
    expect(ofType(freed.events, 'rescue')[0]).toMatchObject({ outcome: { status: 'freed' }, secondFighterAvailable: false, dualFighterActive: false });
    const docked = m.handle({ type: 'captiveDocked', fighterId: 'f1' });
    expect(ofType(docked.events, 'rescue')[0]).toEqual({
      type: 'rescue',
      fighterId: 'f1',
      captorId: 'w1',
      outcome: { status: 'rescued' },
      secondFighterAvailable: true,
      dualFighterActive: true,
      bonus: 0,
    });
    expect(ofType(docked.events, 'dualFighterChanged')).toEqual([{ type: 'dualFighterChanged', active: true }]);
    expect(points(docked.events)).toBe(0); // classic: the reward is the Dual Fighter
    expect(m.snapshot().dualFighterActive).toBe(true);
    expect(m.handle({ type: 'captiveDocked', fighterId: 'f1' }).accepted).toBe(false); // no double rescue
  });

  it('rescue bonus is configurable and pays exactly once', () => {
    const m = game({ mode: defineGameMode({ id: 'rb', label: 't', scoring: { rescue: { bonus: 1000 } } }) });
    capture(m);
    m.handle({ type: 'captiveFreed', fighterId: 'f1', captorId: 'w1' });
    const docked = m.handle({ type: 'captiveDocked', fighterId: 'f1' });
    expect(ofType(docked.events, 'rescue')[0]!.bonus).toBe(1000);
    expect(ofType(docked.events, 'pointsAwarded')).toEqual([expect.objectContaining({ source: 'rescue', amount: 1000 })]);
  });

  it('freed requires the matching captor', () => {
    const m = game();
    capture(m);
    expect(m.handle({ type: 'captiveFreed', fighterId: 'f1', captorId: 'w9' }).reason).toBe('invalid-rescue-state');
  });

  it('shooting the captive: 1000 attacking (500 in formation) and a failed rescue', () => {
    const m = game();
    capture(m);
    const r = kill(m, { kind: 'capturedFighter', fighterId: 'f1', phase: 'attacking' });
    expect(points(r.events)).toBe(1000);
    expect(ofType(r.events, 'rescue')[0]).toMatchObject({ fighterId: 'f1', outcome: { status: 'failed', reason: 'captive-destroyed' }, secondFighterAvailable: false, dualFighterActive: false });
    expect(kill(m, { kind: 'capturedFighter', fighterId: 'f1', phase: 'attacking' }).accepted).toBe(false);

    const m2 = game();
    capture(m2);
    expect(points(kill(m2, { kind: 'capturedFighter', fighterId: 'f1', phase: 'formation' }).events)).toBe(500);
  });

  it('captor destroyed in formation: captive turns hostile (failed), can return held by a new captor, and be rescued later', () => {
    const m = game();
    capture(m);
    kill(m, { enemyId: 'w1', kind: 'commander', phase: 'formation', holdingFighterId: 'f1' });
    const hostile = m.handle({ type: 'captiveTurnedHostile', fighterId: 'f1', captorId: 'w1' });
    expect(ofType(hostile.events, 'rescue')[0]!.outcome).toEqual({ status: 'failed', reason: 'captor-destroyed-in-formation' });
    expect(m.handle({ type: 'captiveFreed', fighterId: 'f1', captorId: 'w1' }).accepted).toBe(false);
    m.handle({ type: 'stageStarted', stage: 2 });
    expect(m.handle({ type: 'captiveRebound', fighterId: 'f1', captorId: 'w2' }).accepted).toBe(true);
    m.handle({ type: 'captiveFreed', fighterId: 'f1', captorId: 'w2' });
    expect(m.handle({ type: 'captiveDocked', fighterId: 'f1' }).accepted).toBe(true);
    expect(m.snapshot().dualFighterActive).toBe(true);
  });

  it('player lost before docking: failed with reason', () => {
    const m = game();
    capture(m);
    m.handle({ type: 'captiveFreed', fighterId: 'f1', captorId: 'w1' });
    const r = m.handle({ type: 'captiveLost', fighterId: 'f1', reason: 'player-lost-before-docking' });
    expect(ofType(r.events, 'rescue')[0]!.outcome).toEqual({ status: 'failed', reason: 'player-lost-before-docking' });
    expect(m.handle({ type: 'captiveDocked', fighterId: 'f1' }).accepted).toBe(false);
  });

  it('dual fighter: half lost keeps reserves; a dual fighter cannot be captured', () => {
    const m = game();
    capture(m);
    m.handle({ type: 'captiveFreed', fighterId: 'f1', captorId: 'w1' });
    m.handle({ type: 'captiveDocked', fighterId: 'f1' });
    expect(capture(m, 'f2', 'w2').reason).toBe('invalid-rescue-state');
    const reserves = m.snapshot().reserves;
    const r = m.handle({ type: 'playerFighterDestroyed', dualHalf: true });
    expect(r.events).toEqual([{ type: 'dualFighterChanged', active: false }]);
    expect(m.snapshot()).toMatchObject({ dualFighterActive: false, reserves });
    expect(m.handle({ type: 'playerFighterDestroyed', dualHalf: true }).reason).toBe('invalid-rescue-state');
  });

  it('game over marks live captives as lost', () => {
    const m = game();
    capture(m);
    const r = m.handle({ type: 'gameOver' });
    expect(ofType(r.events, 'rescue')[0]!.outcome).toEqual({ status: 'failed', reason: 'game-over' });
    expect(r.events.at(-1)!.type).toBe('gameOver');
  });

  it('no captures in Challenging Stages; one captive per captor', () => {
    const m = game({}, 3);
    expect(capture(m).reason).toBe('wrong-stage-kind');
    m.handle({ type: 'stageStarted', stage: 4 });
    capture(m, 'f1', 'w1');
    expect(capture(m, 'f2', 'w1').reason).toBe('invalid-rescue-state');
  });
});

describe('reserves, high score and game over', () => {
  it('losing a fighter consumes a reserve; never goes negative', () => {
    const m = game();
    m.handle({ type: 'playerFighterDestroyed', dualHalf: false });
    m.handle({ type: 'playerFighterDestroyed', dualHalf: false });
    const r = m.handle({ type: 'playerFighterDestroyed', dualHalf: false });
    expect(r.events).toEqual([]);
    expect(m.snapshot().reserves).toBe(0);
  });

  it('beating the stored high score is reported once and reflected in gameOver', () => {
    const m = game({ highScore: 250 });
    expect(ofType(kill(m, { kind: 'commander', phase: 'formation' }).events, 'highScoreBeaten')).toHaveLength(0);
    const r = kill(m, { kind: 'interceptor', phase: 'attacking' }); // 310 > 250
    expect(ofType(r.events, 'highScoreBeaten')).toEqual([{ type: 'highScoreBeaten', score: 310, previous: 250 }]);
    expect(ofType(kill(m, { kind: 'scout', phase: 'attacking' }).events, 'highScoreBeaten')).toHaveLength(0);
    const over = ofType(m.handle({ type: 'gameOver' }).events, 'gameOver')[0]!;
    expect(over).toMatchObject({ finalScore: 410, highScore: 410, newHighScore: true, stage: 1 });
  });

  it('startGame resets per-game state but keeps the session high score', () => {
    const m = game();
    addScore(m, 30000);
    m.handle({ type: 'gameOver' });
    m.startGame();
    expect(m.snapshot()).toMatchObject({ status: 'running', score: 0, highScore: 30000, reserves: 2, extraLivesAwarded: 0, stage: 0 });
  });

  it('sanitises a bad stored high score', () => {
    expect(new RewardManager({ highScore: -5 }).snapshot().highScore).toBe(0);
    expect(new RewardManager({ highScore: Number.NaN }).snapshot().highScore).toBe(0);
  });
});

describe('power-ups are isolated from classic', () => {
  it('classic rejects power-up facts and the score is unchanged', () => {
    const m = game();
    const r = m.handle({ type: 'powerUpCollected', powerUpId: 'p1', kind: 'shield' });
    expect(r).toMatchObject({ accepted: false, reason: 'power-ups-disabled' });
    expect(m.snapshot().score).toBe(0);
  });

  it('a variant reports pickups without awarding points', () => {
    const mode = defineGameMode({ id: 'plus', label: 'Plus', powerUps: { enabled: true, kinds: ['shield'] } });
    const m = game({ mode });
    const r = m.handle({ type: 'powerUpCollected', powerUpId: 'p1', kind: 'shield' });
    expect(r.events).toEqual([{ type: 'powerUpCollected', powerUpId: 'p1', kind: 'shield' }]);
    expect(m.snapshot().score).toBe(0);
    expect(m.handle({ type: 'powerUpCollected', powerUpId: 'p1', kind: 'shield' }).reason).toBe('duplicate');
    expect(m.handle({ type: 'powerUpCollected', powerUpId: 'p2', kind: 'laser' }).reason).toBe('invalid-fact');
  });
});

describe('event bus', () => {
  it('delivers to typed and catch-all listeners after state is final', () => {
    const m = game();
    const seen: string[] = [];
    m.events.on('scoreChanged', (e) => seen.push(`score:${e.score}:${m.snapshot().score}`));
    m.events.onAny((e) => seen.push(e.type));
    kill(m, { kind: 'scout', phase: 'attacking' });
    expect(seen).toEqual(['pointsAwarded', 'score:100:100', 'scoreChanged']);
  });

  it('a throwing listener does not block other listeners or corrupt state', () => {
    const errors: unknown[] = [];
    const m = game({ onListenerError: (e) => errors.push(e) });
    let delivered = 0;
    m.events.on('pointsAwarded', () => {
      throw new Error('broken HUD');
    });
    m.events.on('pointsAwarded', () => delivered++);
    const r = kill(m, { kind: 'scout', phase: 'attacking' });
    expect(r.accepted).toBe(true);
    expect(delivered).toBe(1);
    expect(errors).toHaveLength(1);
    expect(m.snapshot().score).toBe(100);
  });

  it('unsubscribe works', () => {
    const m = game();
    let n = 0;
    const off = m.events.onAny(() => n++);
    off();
    kill(m, { kind: 'scout', phase: 'attacking' });
    expect(n).toBe(0);
  });

  it('stats subscriber derives counts from events only', () => {
    const m = new RewardManager({ mode: defineGameMode({ id: 's', label: 't', scoring: createScoringConfig() }) });
    const { stats } = trackStats(m.events);
    m.startGame();
    m.handle({ type: 'stageStarted', stage: 1 });
    kill(m, { kind: 'scout', phase: 'formation' });
    kill(m, { kind: 'commander', phase: 'attacking', escortsAtDiveStart: 2 });
    m.handle({ type: 'fighterCaptured', fighterId: 'f', captorId: 'w' });
    m.handle({ type: 'captiveFreed', fighterId: 'f', captorId: 'w' });
    m.handle({ type: 'captiveDocked', fighterId: 'f' });
    expect(stats).toMatchObject({ kills: 2, attackKills: 1, bestSingleAward: 1600, rescues: 1, killsByKind: { scout: 1, commander: 1 } });
  });
});
