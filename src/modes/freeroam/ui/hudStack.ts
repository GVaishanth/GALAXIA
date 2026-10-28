/**
 * Flight HUD stacking (FR Prompt 16, FR-TD-80).
 *
 * The top-left HUD pieces used fixed pixel offsets that assumed each other's
 * heights. They broke when the ship card gained its HEAT row (FR-TD-79) and
 * differ with each browser's font metrics: on phones the cargo chip covered the
 * card and the collection log covered the location line. This module measures
 * the real edges instead and publishes them as custom properties on the flight
 * root, which styles.css uses:
 *
 *   --fr-card-bottom  the ship card's bottom edge (the location block on
 *                     phones and the cargo chip hang under it);
 *   --fr-card-right   the ship card's right edge (P04.1: the LOCK touch button
 *                     sits beside the card in short landscape);
 *   --fr-feed-top     below every visible top-HUD element in the log's column
 *                     (small screens place the collection log there);
 *   [data-tight]      on the log, when two lines would reach the ship drawn at
 *                     the centre, or (P07.2) when the flight control column
 *                     (SILENT, STOP) starts in the log's column less than two
 *                     wrapped entries below its top: only the newest line shows.
 *
 * A ResizeObserver reruns it when any of these elements resizes, appears or
 * hides, and when the flight view resizes; never per frame. It is HUD layout,
 * not a viewport system: the canvas and the shell stay with AppShell and
 * CanvasSurface (TD-72).
 */
import type { DisposableScope } from '../../../shared/lifecycle/scope.ts';

/** Elements the collection log must stay below on small screens. */
export const FEED_OBSTACLES = '.fr-shipcard, .fr-top, .fr-cargochip, .fr-notice, .fr-alert, .fr-combat';
/** One log line (18 px) plus the 3 px gap, small-screen styles. */
export const FEED_LINE_PX = 21;
/** Half the ship sprite's box (56 px) plus a 6 px margin. */
const SHIP_CLEAR_PX = 34;
const GAP_PX = 6;

export interface StackInput {
  readonly root: DOMRect;
  readonly card: DOMRect;
  /** The log's column: left edge and right edge at its resolved max-width (null while hidden). */
  readonly column: { readonly left: number; readonly right: number } | null;
  readonly obstacles: readonly DOMRect[];
  /** P07.2: a control box the log must end above (the flight control column), when it starts below the log's top. */
  readonly floor?: DOMRect;
}
export interface StackResult {
  readonly cardBottom: number | null;
  readonly feedTop: number | null;
  readonly tight: boolean;
}

/** Pure placement rule (unit-tested): coordinates are client pixels; results are relative to the root. */
export function computeStack(i: StackInput): StackResult {
  const cardBottom = i.card.height > 0 ? Math.ceil(i.card.bottom - i.root.top) : null;
  const left = i.column?.left ?? i.root.left;
  const right = i.column?.right ?? i.root.right;
  let bottom = 0;
  for (const r of i.obstacles) if (r.width > 0 && r.height > 0 && r.left < right && r.right > left) bottom = Math.max(bottom, r.bottom - i.root.top);
  if (bottom <= 0) return { cardBottom, feedTop: null, tight: false };
  const feedTop = Math.ceil(bottom) + GAP_PX;
  const cx = i.root.left + i.root.width / 2;
  const crosses = left < cx + SHIP_CLEAR_PX && right > cx - SHIP_CLEAR_PX;
  const room = i.root.height / 2 - SHIP_CLEAR_PX - feedTop;
  const f = i.floor;
  const above = f && f.height > 0 && f.left < right && f.right > left ? f.top - i.root.top - feedTop : -1;
  return { cardBottom, feedTop, tight: (crosses && room < 2 * FEED_LINE_PX) || (above >= 0 && above < 4 * FEED_LINE_PX) };
}

/** Keep the HUD stacked under the measured ship card, for the life of `scope`. */
export function stackFlightHud(scope: DisposableScope, root: HTMLElement, card: HTMLElement, feed: HTMLElement, floor: HTMLElement): void {
  const obstacles = [...root.querySelectorAll<HTMLElement>(FEED_OBSTACLES)];
  const place = (): void => {
    const box = root.getBoundingClientRect();
    if (box.width === 0) return;
    // the card first: what hangs under it moves before the obstacles are measured
    const cardBox = card.getBoundingClientRect();
    if (cardBox.height > 0) {
      root.style.setProperty('--fr-card-bottom', `${Math.ceil(cardBox.bottom - box.top)}px`);
      root.style.setProperty('--fr-card-right', `${Math.ceil(cardBox.right - box.left)}px`);
    }
    // the log's column: an oversized width is clamped by max-width (set and restored in the
    // same task, so it is never painted); measuring the text width instead could oscillate
    const f = feed.getBoundingClientRect();
    let column: StackInput['column'] = null;
    if (f.width > 0) {
      const w = feed.style.width;
      feed.style.width = '100000px';
      column = { left: f.left, right: feed.getBoundingClientRect().right };
      feed.style.width = w;
    }
    const r = computeStack({ root: box, card: card.getBoundingClientRect(), column, obstacles: obstacles.map((o) => o.getBoundingClientRect()), floor: floor.getBoundingClientRect() });
    if (r.feedTop === null) return;
    root.style.setProperty('--fr-feed-top', `${r.feedTop}px`);
    feed.toggleAttribute('data-tight', r.tight);
  };
  const observer = scope.observer(new ResizeObserver(place));
  for (const el of [root, feed, floor, ...obstacles]) observer.observe(el);
}
