/**
 * P06.2: the notice-feed line for one signal event (sector/signal.ts
 * SignalResult). Pure text: it never sees the hidden source. A refused or
 * interrupted bearing names the most actionable reason in the run's own check
 * order (decision prompt, range, speed, a body in the line, the same spot);
 * an inconclusive bearing says why there is no fix yet (angle under 35°).
 * `jammed`: the ship is inside sensor interference (wider bearing error).
 */
import type { SignalRefusal, SignalResult } from '../sector/signal.ts';

export type SignalTone = 'gain' | 'warn' | 'info';

/** The same refusal line is not repeated within this many sim ticks (1.5 s): repeated presses do not stack the feed. */
export const SIGNAL_REPEAT_TICKS = 90;

const WHY: Readonly<Record<SignalRefusal, string>> = {
  range: 'OUT OF SENSOR RANGE · CLOSE IN',
  speed: 'TOO FAST · SLOW BELOW 60',
  occluded: 'LINE BLOCKED',
  samePlace: 'SAME SPOT · MOVE TO A NEW POSITION',
  offer: 'DECIDE ON THE HOLD FIRST',
};

export function signalNotice(label: string, r: SignalResult, jammed: boolean, minSeparation: number): { text: string; tone: SignalTone } {
  const jam = jammed ? ' · INTERFERENCE: WIDER ERROR' : '';
  if (r.kind === 'observing') return { text: `${r.ticks > 0 ? 'BEARING IN PROGRESS' : `FAINT SIGNAL · ${label.toUpperCase()}`} · HOLD STEADY${jam}`, tone: 'info' };
  if (r.kind !== 'bearing') return { text: `BEARING ${r.kind === 'refused' ? 'REFUSED' : 'LOST'} · ${r.reason === 'occluded' && r.by ? `${r.by.toUpperCase()} IN THE WAY · MOVE AROUND IT` : WHY[r.reason]}`, tone: 'warn' };
  const head = `BEARING ${r.count} RECORDED · ±${r.bearing.spread.toFixed(1)}°${jam}`;
  if (r.resolved) return { text: `${head} · SOURCE RESOLVED · INVESTIGATE THERE`, tone: 'gain' };
  if (r.count === 1) return { text: `${head} · NEXT FROM A NEW ANGLE`, tone: 'gain' };
  if (r.separation !== null && r.separation < minSeparation) return { text: `${head} · ONLY ${Math.floor(r.separation)}° APART, NEED ${minSeparation}°`, tone: 'info' };
  return { text: `${head} · NO FIX YET · AT MOST ${r.toFallback} MORE`, tone: 'gain' };
}

/** The last signal line shown and its sim tick. */
export interface SignalNoticeMemo {
  text: string;
  tick: number;
}

/** True when `text` repeats the last line within SIGNAL_REPEAT_TICKS (skip it); otherwise records it. A restart (tick back to 0) never suppresses. */
export function repeatsLast(m: SignalNoticeMemo, text: string, tick: number): boolean {
  if (text === m.text && tick >= m.tick && tick - m.tick < SIGNAL_REPEAT_TICKS) return true;
  m.text = text;
  m.tick = tick;
  return false;
}
