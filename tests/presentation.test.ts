import { describe, expect, it } from 'vitest';
import { HUD_LAYOUT, HUD_TIMING } from '../src/config/hud.ts';
import { RewardManager } from '../src/core/rewards/rewardManager.ts';
import type { RewardEvent } from '../src/core/rewards/types.ts';
import { NotificationQueue, formatScore, hudModel, notificationsFor, stageBadges } from '../src/ui/presentation.ts';

describe('formatting', () => {
  it('formats scores arcade-style', () => {
    expect(formatScore(0)).toBe('00');
    expect(formatScore(-5)).toBe('00');
    expect(formatScore(Number.NaN)).toBe('00');
    expect(formatScore(20050)).toBe('20050');
  });

  it('decomposes stage numbers into insignia', () => {
    expect(stageBadges(1)).toEqual([{ value: 1, count: 1 }]);
    expect(stageBadges(37)).toEqual([
      { value: 30, count: 1 },
      { value: 5, count: 1 },
      { value: 1, count: 2 },
    ]);
    expect(stageBadges(0)).toEqual([]);
  });
});

describe('hudModel', () => {
  it('maps a reward snapshot to short labels', () => {
    const m = new RewardManager({ highScore: 30000 });
    m.startGame();
    m.handle({ type: 'stageStarted', stage: 1 });
    m.handle({ type: 'stageStarted', stage: 2 });
    m.handle({ type: 'stageStarted', stage: 3 });
    const h = hudModel(m.snapshot());
    expect(h.score).toEqual({ label: 'GALAXIA', text: '00', value: 0 });
    expect(h.highScore).toMatchObject({ label: 'HIGH SCORE', text: '30000', isPlayers: false });
    expect(h.stage).toMatchObject({ label: 'CHALLENGE', text: '3', kind: 'challenge' });
    expect(h.reserves).toEqual({ count: 2, icons: 2, overflowText: null });
    expect(h.nextExtraLife).toBe(20000);
  });

  it('caps reserve icons with an overflow label', () => {
    const h = hudModel({ ...new RewardManager().snapshot(), reserves: HUD_LAYOUT.maxReserveIcons + 3 });
    expect(h.reserves).toEqual({ count: HUD_LAYOUT.maxReserveIcons + 3, icons: HUD_LAYOUT.maxReserveIcons, overflowText: '+3' });
  });
});

describe('notificationsFor', () => {
  it('extra life: ticker, blinking, announced', () => {
    const [n] = notificationsFor({ type: 'extraLifeAwarded', index: 0, threshold: 20000, reserves: 3, nextThreshold: 70000 });
    expect(n).toMatchObject({ kind: 'extraLife', placement: 'ticker', lines: ['EXTRA FIGHTER'], durationMs: HUD_TIMING.extraLife.durationMs, blinkMs: HUD_TIMING.extraLife.blinkMs });
    expect(n!.announce).toContain('Extra fighter');
  });

  it('challenge results: staged centre lines; perfect variant', () => {
    const base = { type: 'challengeStageResult', stage: 3, challengeNumber: 1, total: 40 } as const;
    const [partial] = notificationsFor({ ...base, hits: 38, perfect: false, perHitBonus: 3800, perfectBonus: 0, bonus: 3800 });
    expect(partial).toMatchObject({ placement: 'center', lines: ['HITS 38/40', 'BONUS 3800'], lineDelayMs: HUD_TIMING.challengeResult.lineDelayMs });
    const [perfect] = notificationsFor({ ...base, hits: 40, perfect: true, perHitBonus: 0, perfectBonus: 10000, bonus: 10000 });
    expect(perfect!.lines).toEqual(['HITS 40/40', 'PERFECT', 'BONUS 10000']);
  });

  it('rescue steps map to short ticker labels; bonus shown only when non-zero', () => {
    const rescued: RewardEvent = { type: 'rescue', fighterId: 'f', captorId: 'w', outcome: { status: 'rescued' }, secondFighterAvailable: true, dualFighterActive: true, bonus: 0 };
    expect(notificationsFor(rescued)[0]!.lines).toEqual(['TWIN FIGHTER']);
    expect(notificationsFor({ ...rescued, bonus: 500 })[0]!.lines).toEqual(['TWIN FIGHTER', '+500']);
    expect(notificationsFor({ ...rescued, outcome: { status: 'failed', reason: 'captive-destroyed' }, secondFighterAvailable: false, dualFighterActive: false })[0]!.lines).toEqual(['CAPTIVE LOST']);
  });

  it('score pop-ups only for big awards with a position', () => {
    const award = { type: 'pointsAwarded', source: 'enemy', requested: 1600, amount: 1600, scoreAfter: 1600, key: 'k', position: { x: 1, y: 2 } } as const;
    expect(notificationsFor(award)[0]).toMatchObject({ placement: 'popup', lines: ['1600'], position: { x: 1, y: 2 } });
    expect(notificationsFor({ ...award, amount: 100 })).toEqual([]);
    const { position: _p, ...noPos } = award;
    expect(notificationsFor(noPos)).toEqual([]);
  });

  it('silent for bookkeeping events', () => {
    expect(notificationsFor({ type: 'scoreChanged', score: 1, delta: 1, highScore: 1 })).toEqual([]);
    expect(notificationsFor({ type: 'reservesChanged', reserves: 1, delta: -1 })).toEqual([]);
  });
});

describe('NotificationQueue', () => {
  const ticker = (text: string, durationMs = 1000, hold = false) => ({ kind: 'extraLife' as const, placement: 'ticker' as const, lines: [text], tone: 'text' as const, durationMs, blinkMs: 0, lineDelayMs: 0, hold });
  const shown = (q: NotificationQueue, t: number) => q.active(t).map((n) => n.lines[0]);

  it('latest replaceable message wins (no stale backlog) and messages expire', () => {
    const q = new NotificationQueue();
    q.push([ticker('A')], 0);
    q.push([ticker('B')], 300);
    expect(shown(q, 310)).toEqual(['B']);
    expect(shown(q, 1299)).toEqual(['B']);
    expect(shown(q, 1300)).toEqual([]);
    expect(q.size).toBe(0);
  });

  it('held messages finish; later ones wait, and only the newest waiting one survives', () => {
    const q = new NotificationQueue();
    q.push([ticker('EXTRA', 1000, true)], 0);
    q.push([ticker('X')], 100);
    q.push([ticker('Y')], 200);
    expect(shown(q, 500)).toEqual(['EXTRA']);
    expect(shown(q, 1000)).toEqual(['Y']);
    q.push([ticker('H1', 500, true), ticker('H2', 500, true)], 5000);
    expect(shown(q, 5100)).toEqual(['H1']);
    expect(shown(q, 5600)).toEqual(['H2']);
  });

  it('slots are independent: a centre message does not affect the ticker', () => {
    const q = new NotificationQueue();
    q.push([ticker('T')], 0);
    q.push([{ ...ticker('C'), placement: 'center' }], 10);
    expect(shown(q, 20).sort()).toEqual(['C', 'T']);
  });

  it('every event-derived notification declares timing and hold policy', () => {
    const events: RewardEvent[] = [
      { type: 'extraLifeAwarded', index: 0, threshold: 20000, reserves: 3, nextThreshold: 70000 },
      { type: 'gameOver', finalScore: 1, highScore: 1, newHighScore: false, stage: 1 },
      { type: 'stageChanged', stage: 2, kind: 'normal', challengeNumber: null },
    ];
    for (const e of events) {
      for (const n of notificationsFor(e)) {
        expect(n.durationMs).toBeGreaterThan(0);
        expect(typeof n.hold).toBe('boolean');
      }
    }
    expect(notificationsFor(events[0]!)[0]!.hold).toBe(true);
    expect(notificationsFor(events[2]!)[0]!.hold).toBe(false);
  });

  it('staggers lines and blinks', () => {
    const q = new NotificationQueue();
    q.push([{ ...ticker('x', 3000), placement: 'center' as const, lines: ['ONE', 'TWO', 'THREE'], lineDelayMs: 500, blinkMs: 250 }], 0);
    expect(q.active(0)[0]).toMatchObject({ visibleLines: ['ONE'], blinkOn: true });
    expect(q.active(300)[0]).toMatchObject({ visibleLines: ['ONE'], blinkOn: false });
    expect(q.active(1100)[0]!.visibleLines).toEqual(['ONE', 'TWO', 'THREE']);
  });

  it('keeps at most maxPopups pop-ups (oldest dropped)', () => {
    const q = new NotificationQueue();
    const popup = (i: number) => ({ ...ticker(String(i)), placement: 'popup' as const });
    q.push(Array.from({ length: HUD_LAYOUT.maxPopups + 2 }, (_, i) => popup(i)), 0);
    const shown = q.active(1).map((n) => n.lines[0]);
    expect(shown).toHaveLength(HUD_LAYOUT.maxPopups);
    expect(shown[0]).toBe('2');
  });
});
