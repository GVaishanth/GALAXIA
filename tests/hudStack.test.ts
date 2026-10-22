/**
 * FR Prompt 16 (FR-TD-80): flight HUD stacking rule (src/modes/freeroam/ui/hudStack.ts).
 * Rectangles are the ones measured in Chromium on the release build (2026-10-21).
 */
import { describe, expect, it } from 'vitest';
import { computeStack, FEED_LINE_PX } from '../src/modes/freeroam/ui/hudStack.ts';

const rect = (l: number, t: number, r: number, b: number): DOMRect => ({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON: () => ({}) }) as DOMRect;
const HIDDEN = rect(0, 0, 0, 0);

describe('computeStack', () => {
  it('phone portrait 390x844: the log goes under the location block, not over it (the old fixed offset overlapped)', () => {
    const r = computeStack({
      root: rect(0, 0, 390, 844),
      card: rect(10, 8, 194, 109),
      column: { left: 10, right: 376 },
      obstacles: [rect(10, 8, 194, 109), rect(81, 113, 309, 158), rect(202, 60, 380, 97), HIDDEN, HIDDEN, HIDDEN],
    });
    expect(r).toEqual({ cardBottom: 109, feedTop: 164, tight: false });
  });

  it('a notice pushes the log below it; at 320x568 that leaves room for one line only', () => {
    const tall = computeStack({ root: rect(0, 0, 390, 844), card: rect(10, 8, 194, 109), column: { left: 10, right: 376 }, obstacles: [rect(10, 8, 194, 109), rect(81, 113, 309, 158), rect(113, 158, 277, 223)] });
    expect(tall.feedTop).toBe(229);
    expect(tall.tight).toBe(false);
    const small = computeStack({ root: rect(0, 0, 320, 568), card: rect(10, 8, 134, 109), column: { left: 10, right: 306 }, obstacles: [rect(10, 8, 134, 109), rect(46, 113, 274, 158), rect(78, 158, 242, 223)] });
    expect(small.feedTop).toBe(229);
    expect(small.tight).toBe(true);
    // one line still fits above the ship (centre 284, ship top 256)
    expect(small.feedTop! + FEED_LINE_PX).toBeLessThanOrEqual(284 - 28);
  });

  it('phone landscape: the log column is left of the ship, so it is never tight; elements outside the column are ignored', () => {
    const r = computeStack({
      root: rect(0, 0, 844, 390),
      card: rect(10, 8, 194, 101),
      column: { left: 10, right: 310 },
      obstacles: [rect(10, 8, 194, 101), rect(308, 8, 536, 50), rect(10, 105, 283, 126), rect(344, 58, 500, 119)],
    });
    expect(r).toEqual({ cardBottom: 101, feedTop: 132, tight: false });
  });

  it('a hidden log uses the full width (conservative) and a hidden card publishes nothing', () => {
    const r = computeStack({ root: rect(0, 0, 390, 844), card: HIDDEN, column: null, obstacles: [rect(300, 10, 380, 50)] });
    expect(r.cardBottom).toBeNull();
    expect(r.feedTop).toBe(56);
    expect(computeStack({ root: rect(0, 0, 390, 844), card: HIDDEN, column: null, obstacles: [HIDDEN] })).toEqual({ cardBottom: null, feedTop: null, tight: false });
  });

  it('is relative to the flight root, not the page', () => {
    const r = computeStack({ root: rect(0, 100, 390, 944), card: rect(10, 108, 194, 209), column: { left: 10, right: 376 }, obstacles: [rect(10, 108, 194, 209)] });
    expect(r.cardBottom).toBe(109);
    expect(r.feedTop).toBe(115);
  });
});
