/**
 * Responsive layout choice (pure; applied by game/app.ts as data attributes
 * and CSS variables). The playfield always keeps its authored 448x576 aspect
 * and is letterboxed; only the furniture around it moves.
 *
 * - desktop:          no touch pad. Side panels (controls / scoring) when the
 *                     letterbox is wide enough: both sides, then one compact
 *                     panel. Without room beside the playfield (portrait
 *                     monitors, tall windows) the playfield moves to the top
 *                     and the panels go underneath when the free height
 *                     allows it (Stage 8): both side by side, then the
 *                     controls panel only, then none. Phone-sized windows
 *                     (narrower than stackedPanels.minWidth) get none: the
 *                     panels would be clipped there, so the II / ⓘ corner
 *                     buttons and the info box take their place (TD-75).
 * - touch-portrait:   control strip under the playfield; the playfield sits
 *                     at the bottom of its area, next to the thumbs.
 * - touch-landscape:  move pad in the left column, FIRE + pause in the right
 *                     column, inside the pillarbox; the playfield uses the
 *                     full height.
 */
import { LAYOUT } from '../config/devices.ts';
import { PLAYFIELD_ART } from '../config/visual.ts';

export type LayoutMode = 'desktop' | 'touch-portrait' | 'touch-landscape';
export type SidePanels = 'sides' | 'compact' | 'below' | 'below-compact' | 'none';

export interface LayoutInput {
  /** Safe game area in CSS px (the shell box minus the safe-area insets, AppShell.safe). */
  readonly width: number;
  readonly height: number;
  /** Show touch controls (coarse primary pointer, or the last input was touch). */
  readonly touch: boolean;
}

export interface Layout {
  readonly mode: LayoutMode;
  /** Touch landscape: width of each control column (CSS px), else 0. */
  readonly sideColumn: number;
  /** Touch portrait: height of the control strip (CSS px, without the safe-area inset), else 0. */
  readonly padHeight: number;
  readonly sidePanels: SidePanels;
  /** Vertical placement of the playfield inside its area. */
  readonly align: 'center' | 'bottom' | 'top';
}

const ASPECT = PLAYFIELD_ART.width / PLAYFIELD_ART.height;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** CSS width the playfield would get in a w x h box. */
export function fittedWidth(w: number, h: number): number {
  return Math.max(0, Math.min(w, h * ASPECT));
}

export function chooseLayout(i: LayoutInput): Layout {
  const w = Math.max(0, i.width);
  const h = Math.max(0, i.height);
  if (i.touch && w >= h * LAYOUT.landscapeAspect) {
    const spare = (w - h * ASPECT) / 2;
    return { mode: 'touch-landscape', sideColumn: Math.floor(clamp(spare, LAYOUT.sideColumn.min, LAYOUT.sideColumn.max)), padHeight: 0, sidePanels: 'none', align: 'center' };
  }
  if (i.touch) {
    const spare = h - w / ASPECT; // height the playfield does not need
    return { mode: 'touch-portrait', sideColumn: 0, padHeight: Math.round(clamp(spare, LAYOUT.pad.min, LAYOUT.pad.max)), sidePanels: 'none', align: 'bottom' };
  }
  const fw = fittedWidth(w, h);
  const free = (w - fw) / 2;
  if (free >= LAYOUT.sidePanels.wide) return { mode: 'desktop', sideColumn: 0, padHeight: 0, sidePanels: 'sides', align: 'center' };
  if (free >= LAYOUT.sidePanels.compact) return { mode: 'desktop', sideColumn: 0, padHeight: 0, sidePanels: 'compact', align: 'center' };
  const band = h - fw / ASPECT; // free height under a width-fitted playfield
  const { full, compact, minWidth } = LAYOUT.stackedPanels;
  if (w < minWidth) return { mode: 'desktop', sideColumn: 0, padHeight: 0, sidePanels: 'none', align: 'center' };
  if (band >= full) return { mode: 'desktop', sideColumn: 0, padHeight: 0, sidePanels: 'below', align: 'top' };
  if (band >= compact) return { mode: 'desktop', sideColumn: 0, padHeight: 0, sidePanels: 'below-compact', align: 'top' };
  return { mode: 'desktop', sideColumn: 0, padHeight: 0, sidePanels: 'none', align: 'center' };
}

/** A box in CSS px, relative to the game stage's top-left corner. */
export interface StageBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the playfield is fitted (pure, TD-72): the safe game area minus the
 * space the touch controls reserve. The canvas itself is full-bleed (the
 * shared AppShell / CanvasSurface policy, same as Free Roam); this box only
 * decides where Classic's fixed arena is letterboxed inside it, so the
 * controls, the notch and the home indicator never cover the playfield.
 * `safe` is in stage (= shell) coordinates.
 *  - desktop:         the whole safe area (side panels use the letterbox);
 *  - touch-portrait:  above the control strip;
 *  - touch-landscape: between the two control columns.
 */
export function playArea(layout: Layout, safe: StageBox): StageBox {
  if (layout.mode === 'touch-landscape') {
    const col = Math.min(layout.sideColumn, safe.width / 2);
    return { left: safe.left + col, top: safe.top, width: Math.max(0, safe.width - col * 2), height: safe.height };
  }
  if (layout.mode === 'touch-portrait') return { left: safe.left, top: safe.top, width: safe.width, height: Math.max(0, safe.height - layout.padHeight) };
  return safe;
}

/**
 * Whole safe game area in stage coordinates on touch layouts (Stage 9), used
 * by the page screens (HOW TO PLAY, SETTINGS) so they are not squeezed into
 * the playfield column of a landscape phone or above the portrait control
 * strip (the gameplay controls are hidden on those screens). It never reaches
 * under a notch or the home indicator. Desktop layouts return null: menus
 * keep the playfield band.
 */
export function pageArea(layout: Layout, safe: StageBox): StageBox | null {
  return layout.mode === 'desktop' ? null : safe;
}
