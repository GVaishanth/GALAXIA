/**
 * Pure presentation models for the HUD: reward state and events in, short
 * labels and timing out. No DOM here, so it is unit-tested and reusable by any
 * renderer (DOM HUD today; attract screens and game-over later).
 */
import { HUD_LABELS, HUD_LAYOUT, HUD_TIMING, STAGE_BADGE_VALUES } from '../config/hud.ts';
import type { RewardSnapshot } from '../core/rewards/rewardManager.ts';
import type { Point, RewardEvent } from '../core/rewards/types.ts';

export function formatScore(score: number): string {
  if (!Number.isFinite(score) || score <= 0) return '00';
  return String(Math.floor(score));
}

export interface StageBadge {
  readonly value: number;
  readonly count: number;
}

/** Greedy decomposition of a stage number into insignia (e.g. 37 -> 30 + 5 + 1 + 1). */
export function stageBadges(stage: number, values: readonly number[] = STAGE_BADGE_VALUES): StageBadge[] {
  const out: StageBadge[] = [];
  let rest = Number.isInteger(stage) && stage > 0 ? stage : 0;
  for (const value of values) {
    const count = Math.floor(rest / value);
    if (count > 0) out.push({ value, count });
    rest -= count * value;
  }
  return out;
}

export interface HudModel {
  readonly score: { readonly label: string; readonly text: string; readonly value: number };
  readonly highScore: { readonly label: string; readonly text: string; readonly value: number; readonly isPlayers: boolean };
  readonly reserves: { readonly count: number; readonly icons: number; readonly overflowText: string | null };
  readonly stage: { readonly label: string; readonly text: string; readonly number: number; readonly kind: 'normal' | 'challenge' | null; readonly badges: readonly StageBadge[] };
  readonly dualFighter: boolean;
  readonly nextExtraLife: number | null;
}

export function hudModel(s: RewardSnapshot): HudModel {
  const icons = Math.min(s.reserves, HUD_LAYOUT.maxReserveIcons);
  return {
    score: { label: HUD_LABELS.player, text: formatScore(s.score), value: s.score },
    highScore: { label: HUD_LABELS.highScore, text: formatScore(s.highScore), value: s.highScore, isPlayers: s.newHighScore },
    reserves: { count: s.reserves, icons, overflowText: s.reserves > icons ? `+${s.reserves - icons}` : null },
    stage: {
      label: s.stageKind === 'challenge' ? HUD_LABELS.challenge : HUD_LABELS.stage,
      text: s.stage > 0 ? String(s.stage) : '',
      number: s.stage,
      kind: s.stageKind,
      badges: stageBadges(s.stage),
    },
    dualFighter: s.dualFighterActive,
    nextExtraLife: s.nextExtraLife,
  };
}

/* ------------------------------ notifications ----------------------------- */

/** ticker: small line in the top band; center: interstitial text (only when play is calm); popup: at a playfield point. */
export type Placement = 'ticker' | 'center' | 'popup';
export type Tone = 'text' | 'accent' | 'highlight';
export type NotificationKind =
  | 'extraLife'
  | 'newHighScore'
  | 'points'
  | 'setBonus'
  | 'waveBonus'
  | 'challengeResult'
  | 'stageIntro'
  | 'captured'
  | 'freed'
  | 'rescued'
  | 'captiveLost'
  | 'gameOver';

export interface NotificationSpec {
  readonly kind: NotificationKind;
  readonly placement: Placement;
  readonly lines: readonly string[];
  readonly tone: Tone;
  readonly durationMs: number;
  /** Half-period of blinking, 0 = steady. */
  readonly blinkMs: number;
  /** Delay between successive lines appearing, 0 = all at once. */
  readonly lineDelayMs: number;
  readonly position?: Point;
  /** Text for the screen-reader live region; omitted for frequent, low-value events. */
  readonly announce?: string;
  /**
   * true: must be shown in full; later messages in the same slot wait for it.
   * false: a newer message in the same slot replaces it immediately (no stale backlog).
   */
  readonly hold: boolean;
}

const spec = (s: Omit<NotificationSpec, 'blinkMs' | 'lineDelayMs' | 'hold'> & Partial<NotificationSpec>): NotificationSpec => ({
  blinkMs: 0,
  lineDelayMs: 0,
  hold: false,
  ...s,
});

/** Map one reward event to zero or more HUD notifications. */
export function notificationsFor(e: RewardEvent): NotificationSpec[] {
  const L = HUD_LABELS;
  const T = HUD_TIMING;
  switch (e.type) {
    case 'extraLifeAwarded':
      return [spec({ kind: 'extraLife', placement: 'ticker', lines: [L.extraLife], tone: 'highlight', ...T.extraLife, hold: true, announce: `Extra fighter. ${e.reserves} in reserve.` })];
    case 'highScoreBeaten':
      return [spec({ kind: 'newHighScore', placement: 'ticker', lines: [L.newHighScore], tone: 'accent', ...T.newHighScore, announce: 'New high score' })];
    case 'pointsAwarded':
      if (e.source !== 'enemy' && e.source !== 'capturedFighter') return [];
      if (e.amount < HUD_LAYOUT.popupMinPoints || !e.position) return [];
      return [spec({ kind: 'points', placement: 'popup', lines: [String(e.amount)], tone: 'highlight', ...T.popup, position: e.position })];
    case 'transformGroupCleared':
      return [spec({ kind: 'setBonus', placement: 'ticker', lines: [`${L.setBonus} ${e.bonus}`], tone: 'highlight', ...T.ticker, announce: `Set bonus ${e.bonus}` })];
    case 'challengeWaveCleared':
      return [spec({ kind: 'waveBonus', placement: 'ticker', lines: [`${L.waveBonus} ${e.bonus}`], tone: 'highlight', ...T.ticker })];
    case 'challengeStageResult':
      return e.perfect
        ? [
            spec({
              kind: 'challengeResult',
              placement: 'center',
              lines: [`${L.hits} ${e.hits}/${e.total}`, L.perfect, `${L.bonus} ${e.bonus}`],
              tone: 'accent',
              ...T.perfect,
              hold: true,
              announce: `Perfect. Bonus ${e.bonus}.`,
            }),
          ]
        : [
            spec({
              kind: 'challengeResult',
              placement: 'center',
              lines: [`${L.hits} ${e.hits}/${e.total}`, `${L.bonus} ${e.bonus}`],
              tone: 'text',
              ...T.challengeResult,
              hold: true,
              announce: `${e.hits} of ${e.total} hit. Bonus ${e.bonus}.`,
            }),
          ];
    case 'stageChanged':
      return [
        spec({
          kind: 'stageIntro',
          placement: 'center',
          lines: [e.kind === 'challenge' ? L.challengingStage : `${L.stage} ${e.stage}`],
          tone: e.kind === 'challenge' ? 'highlight' : 'text',
          ...T.stageIntro,
          announce: e.kind === 'challenge' ? 'Challenging stage' : `Stage ${e.stage}`,
        }),
      ];
    case 'fighterCaptured':
      return [spec({ kind: 'captured', placement: 'center', lines: [L.captured], tone: 'accent', ...T.captured, announce: 'Fighter captured' })];
    case 'rescue': {
      const o = e.outcome;
      if (o.status === 'freed') return [spec({ kind: 'freed', placement: 'ticker', lines: [L.freed], tone: 'highlight', ...T.ticker })];
      if (o.status === 'rescued') {
        const lines = e.bonus > 0 ? [L.rescued, `+${e.bonus}`] : [L.rescued];
        return [spec({ kind: 'rescued', placement: 'ticker', lines, tone: 'highlight', ...T.ticker, announce: e.bonus > 0 ? `Fighter rescued. Bonus ${e.bonus}.` : 'Fighter rescued. Twin fighter.' })];
      }
      if (o.reason === 'game-over') return [];
      return [spec({ kind: 'captiveLost', placement: 'ticker', lines: [L.captiveLost], tone: 'accent', ...T.ticker })];
    }
    case 'gameOver':
      return [spec({ kind: 'gameOver', placement: 'center', lines: [L.gameOver], tone: 'accent', ...T.gameOver, hold: true, announce: `Game over. Score ${e.finalScore}.` })];
    default:
      return [];
  }
}

export interface ActiveNotification extends NotificationSpec {
  readonly id: number;
  readonly startMs: number;
  /** Lines visible at the queried time (respects lineDelayMs). */
  readonly visibleLines: readonly string[];
  /** False during the "off" half of a blink. */
  readonly blinkOn: boolean;
  /** 0..1 progress through its lifetime. */
  readonly progress: number;
}

/**
 * Schedules notifications. Ticker and center slots show one message at a time:
 * a newer message replaces the current one ("latest wins"), except `hold`
 * messages, which run to completion while later ones wait behind them.
 * Pop-ups overlap up to HUD_LAYOUT.maxPopups. Time is supplied by the caller
 * (render clock), so this stays deterministic.
 */
export class NotificationQueue {
  private items: (NotificationSpec & { id: number; startMs: number })[] = [];
  private nextId = 1;

  push(specs: readonly NotificationSpec[], nowMs: number): number[] {
    const ids: number[] = [];
    for (const s of specs) {
      let start = nowMs;
      if (s.placement !== 'popup') {
        const slot = this.items.filter((i) => i.placement === s.placement && nowMs < i.startMs + i.durationMs);
        // Held messages must finish; the new one starts after the last of them.
        const held = slot.filter((i) => i.hold);
        const holdEnd = held.reduce((t, i) => Math.max(t, i.startMs + i.durationMs), nowMs);
        // Drop or cut short replaceable messages: pending ones are removed, a showing one ends now.
        const replaceable = new Set(slot.filter((i) => !i.hold).map((i) => i.id));
        this.items = this.items.flatMap((i) => {
          if (!replaceable.has(i.id)) return [i];
          if (i.startMs > nowMs) return []; // pending
          return [{ ...i, durationMs: Math.max(0, nowMs - i.startMs) }]; // showing: end now
        });
        start = holdEnd;
      }
      const id = this.nextId++;
      this.items.push({ ...s, id, startMs: start });
      ids.push(id);
    }
    const popups = this.items.filter((i) => i.placement === 'popup');
    if (popups.length > HUD_LAYOUT.maxPopups) {
      const drop = new Set(popups.slice(0, popups.length - HUD_LAYOUT.maxPopups).map((p) => p.id));
      this.items = this.items.filter((i) => !drop.has(i.id));
    }
    return ids;
  }

  active(nowMs: number): ActiveNotification[] {
    this.items = this.items.filter((i) => nowMs < i.startMs + i.durationMs);
    return this.items
      .filter((i) => nowMs >= i.startMs)
      .map((i) => {
        const age = nowMs - i.startMs;
        const shown = i.lineDelayMs > 0 ? Math.min(i.lines.length, Math.floor(age / i.lineDelayMs) + 1) : i.lines.length;
        return {
          ...i,
          visibleLines: i.lines.slice(0, shown),
          blinkOn: i.blinkMs <= 0 || Math.floor(age / i.blinkMs) % 2 === 0,
          progress: Math.min(1, age / i.durationMs),
        };
      });
  }

  /** Drop everything (new game). */
  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }
}
