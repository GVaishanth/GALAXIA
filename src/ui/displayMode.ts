/**
 * Classic display presentation (TD-73), pure: Responsive Display vs Arcade
 * Display. It sits between `playArea` (where the arena MAY go: the safe area
 * minus the touch controls, ui/layout.ts) and `fitViewport` (render/), and
 * only decides the box the fixed 448x576 arena is fitted into, its vertical
 * alignment and the arcade bezel. Gameplay coordinates, the canvas backing
 * store and the renderer are the same in both presentations.
 *
 * - responsive (default): the arena is as large as it fits in the play area,
 *   with the layout's own alignment (bottom on portrait phones, near the
 *   thumbs): the shared viewport sizing that Free Roam uses (TD-72).
 * - arcade: the arena is centred inside a bezel ring plus a margin scaled
 *   from the play area's short side (ARCADE). The frame gives way first: the
 *   arena never drops below ARCADE.minScale of its responsive size.
 */
import { ARCADE } from '../config/devices.ts';
import { PLAYFIELD_ART } from '../config/visual.ts';
import type { Layout, StageBox } from './layout.ts';

export type DisplayMode = 'responsive' | 'arcade';

export interface Presentation {
  readonly mode: DisplayMode;
  /** Box the arena is fitted into (CSS px, stage coordinates). */
  readonly fit: StageBox;
  readonly align: 'center' | 'bottom' | 'top';
  /** Bezel ring thickness around the arena (CSS px); 0 in responsive. */
  readonly bezel: number;
  /** Free space between the bezel and the play area's edge (CSS px); 0 in responsive. */
  readonly margin: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Arena scale (CSS px per art px) in a box. */
export function arenaScale(box: { readonly width: number; readonly height: number }): number {
  return Math.max(0, Math.min(box.width / PLAYFIELD_ART.width, box.height / PLAYFIELD_ART.height));
}

export function presentation(layout: Layout, area: StageBox, arcade: boolean): Presentation {
  if (!arcade) return { mode: 'responsive', fit: area, align: layout.align, bezel: 0, margin: 0 };
  const short = Math.max(0, Math.min(area.width, area.height));
  let bezel = clamp(Math.round(short * ARCADE.bezel.fraction), ARCADE.bezel.min, ARCADE.bezel.max);
  let margin = clamp(Math.round(short * ARCADE.margin.fraction), ARCADE.margin.min, ARCADE.margin.max);
  // the largest uniform inset that keeps the arena at >= minScale of its responsive size
  const floor = arenaScale(area) * ARCADE.minScale;
  const maxInset = Math.max(0, Math.min((area.width - PLAYFIELD_ART.width * floor) / 2, (area.height - PLAYFIELD_ART.height * floor) / 2));
  if (bezel + margin > maxInset) {
    bezel = Math.min(bezel, Math.floor(maxInset));
    margin = Math.max(0, Math.floor(maxInset) - bezel);
  }
  const inset = bezel + margin;
  const fit = { left: area.left + inset, top: area.top + inset, width: Math.max(0, area.width - inset * 2), height: Math.max(0, area.height - inset * 2) };
  // centred, except when the desktop panels sit under the playfield (they need the space below)
  const align = layout.sidePanels === 'below' || layout.sidePanels === 'below-compact' ? 'top' : 'center';
  return { mode: 'arcade', fit, align, bezel, margin };
}

/** The bezel ring's outer box around an arena rect (CSS px). */
export function bezelBox(rect: StageBox, bezel: number): StageBox {
  return { left: rect.left - bezel, top: rect.top - bezel, width: rect.width + bezel * 2, height: rect.height + bezel * 2 };
}

/** Ease-out for the presentation glide (0..1 -> 0..1). */
export function easeOut(k: number): number {
  const t = clamp(k, 0, 1);
  return 1 - (1 - t) ** 3;
}
