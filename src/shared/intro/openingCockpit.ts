/**
 * Finale P3: cockpit geometry for the opening cinematic (pure; lazy chunk).
 *
 * Layered 2.5D, not 3D: the cockpit is a few flat layers at fixed depths
 * (near controls, the console and its display, the canopy frame, space). A
 * pinhole camera moves along its axis (and pans a little); each layer is
 * scaled about the screen centre by depth / (depth - camZ), so nearer layers
 * grow and slide away faster than farther ones (parallax).
 *
 * The display is the anchor. At rest (camZ = 0) it is a rectangle with the
 * viewport's own aspect ratio, centred a little below the middle. The live
 * home page is placed on it with a CSS matrix3d (rect -> quad homography),
 * keystoned while the camera is still back in the cabin. During the push the
 * camera advances until the display rectangle is exactly the viewport: at
 * that point everything else in the cockpit is outside the screen and the
 * home page's transform is the identity, so removing the overlay changes no
 * pixel (no flash, no jump).
 */
import type { OpeningPhase } from './openingDirector.ts';
import { clamp01, easeInOut, easeOutCubic, smoothstep } from './openingScene.ts';

export interface Pt {
  readonly x: number;
  readonly y: number;
}
/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Pt, Pt, Pt, Pt];
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const COCKPIT_DEPTH = Object.freeze({ near: 0.55, display: 1, canopy: 1.4, space: 8 });

/** Display scale at rest (fraction of the viewport): it sits a bit inset, larger on small screens so the home page stays legible. */
export function displayScale(W: number, H: number): number {
  return Math.min(W, H) < 560 ? 0.72 : 0.66;
}

/** The display rectangle at rest (camZ = 0), in CSS px of the viewport. */
export function restDisplay(W: number, H: number): Rect {
  const s = displayScale(W, H);
  const w = W * s;
  const h = H * s;
  return { x: (W - w) / 2, y: H * 0.53 - h / 2, w, h };
}

export interface CockpitCamera {
  /** Camera position along its axis (0 = rest; negative = further back). */
  readonly z: number;
  /** Camera pan in rest coordinates (CSS px). */
  readonly panX: number;
  readonly panY: number;
  /** 0..~0.14: how much narrower the display's top edge is (the screen seen from behind the seat). */
  readonly keystone: number;
  /** 0..1: the display powering on (0 = dark screen, 1 = the home page at full brightness). */
  readonly power: number;
  /** 0..1: strength of the glass glare over the display. */
  readonly glare: number;
  /** 0..1: a full-screen void layer over everything (reduced-motion fades). */
  readonly veil: number;
  /** False once the cockpit is entirely outside the viewport (handoff): the canvas draws nothing. */
  readonly visible: boolean;
}

/** camZ at which the display is `ratio` times its rest size. */
const zForRatio = (ratio: number): number => 1 - 1 / ratio;
export const CABIN_START_RATIO = 0.55;
/** The display share of the viewport that counts as "filled" (float slack; the handoff needs the eq test below). */
const FILL_SLOP = 0.02;
const CABIN_END_RATIO = 0.86;

export function cockpitCamera(phase: OpeningPhase, p: number, reduced: boolean, W: number, H: number): CockpitCamera {
  const sD = displayScale(W, H);
  const zEnd = 1 - sD; // exactly the fill point: the display rectangle projects onto the viewport (displayAtFill's slack only absorbs float noise)
  const pan = { x: 0, y: H * 0.53 - H / 2 }; // rest display centre -> screen centre
  const u = clamp01(p);
  if (reduced) {
    // opacity only: a still cockpit fades in, holds, fades to the void; the page appears full size
    if (phase === 'cabin') return { z: 0, panX: 0, panY: 0, keystone: 0, power: 1, glare: 1, veil: 1 - u, visible: true };
    if (phase === 'display') return { z: 0, panX: 0, panY: 0, keystone: 0, power: 1, glare: 1, veil: 0, visible: true };
    if (phase === 'push') return { z: 0, panX: 0, panY: 0, keystone: 0, power: 1, glare: 1, veil: u, visible: true };
    if (phase === 'handoff' || phase === 'complete') return { z: zEnd, panX: pan.x, panY: pan.y, keystone: 0, power: 1, glare: 0, veil: phase === 'handoff' ? 1 - u : 0, visible: false };
    return { z: 0, panX: 0, panY: 0, keystone: 0, power: 0, glare: 1, veil: 1, visible: true };
  }
  const z0 = zForRatio(CABIN_START_RATIO);
  const z1 = zForRatio(CABIN_END_RATIO);
  const drift = { x: -0.035 * W, y: -0.03 * H };
  switch (phase) {
    case 'cabin': {
      const k = easeOutCubic(u);
      return { z: z0 + (z1 - z0) * k, panX: drift.x * (1 - k * 0.7), panY: drift.y * (1 - k * 0.7), keystone: 0.14 - 0.06 * k, power: smoothstep(0.15, 0.75, u), glare: 1, veil: 0, visible: true };
    }
    case 'display': {
      const k = easeInOut(u);
      return { z: z1 * (1 - k), panX: drift.x * 0.3 * (1 - k), panY: drift.y * 0.3 * (1 - k), keystone: 0.08 * (1 - k), power: 1, glare: 1, veil: 0, visible: true };
    }
    case 'push': {
      const k = easeInOut(u);
      return { z: zEnd * k, panX: pan.x * k, panY: pan.y * k, keystone: 0, power: 1, glare: 1 - u, veil: 0, visible: true };
    }
    case 'handoff':
    case 'complete':
      return { z: zEnd, panX: pan.x, panY: pan.y, keystone: 0, power: 1, glare: 0, veil: reduced && phase === 'handoff' ? 1 - u : 0, visible: false };
    default:
      // space phases: the cabin is drawn (faded in by the scene) as it is at the start of the cabin phase
      return { z: z0, panX: drift.x, panY: drift.y, keystone: 0.14, power: 0, glare: 1, veil: 0, visible: true };
  }
}

/** Scale of a layer at `depth` for camera position `z` (1 at rest). */
export function layerRatio(depth: number, z: number): number {
  return depth / Math.max(1e-3, depth - z);
}

/** True once the display's projected size matches the viewport to drawing precision (the handoff hides the canvas). */
export function displayAtFill(cam: CockpitCamera, W: number, H: number): boolean {
  if (!cam.visible) return true;
  const q = displayQuad(W, H, cam);
  return Math.abs(q[1].x - q[0].x - W) <= FILL_SLOP * W && Math.abs(q[3].y - q[0].y - H) <= FILL_SLOP * H;
}

/** Project a rest-space point on a layer at `depth` to the screen. */
export function project(pt: Pt, depth: number, cam: CockpitCamera, W: number, H: number): Pt {
  const r = layerRatio(depth, cam.z);
  const cx = W / 2;
  const cy = H / 2;
  return { x: cx + (pt.x - cx - cam.panX) * r, y: cy + (pt.y - cy - cam.panY) * r };
}

/** The display on screen: the projected rest rectangle, keystoned. */
export function displayQuad(W: number, H: number, cam: CockpitCamera): Quad {
  const r = restDisplay(W, H);
  const tl = project({ x: r.x, y: r.y }, COCKPIT_DEPTH.display, cam, W, H);
  const br = project({ x: r.x + r.w, y: r.y + r.h }, COCKPIT_DEPTH.display, cam, W, H);
  const w = br.x - tl.x;
  const h = br.y - tl.y;
  const inset = (cam.keystone * w) / 2;
  const drop = cam.keystone * h * 0.12;
  return [
    { x: tl.x + inset, y: tl.y + drop },
    { x: br.x - inset, y: tl.y + drop },
    { x: br.x, y: br.y },
    { x: tl.x, y: br.y },
  ];
}

export const FULL_QUAD = (W: number, H: number): Quad => [
  { x: 0, y: 0 },
  { x: W, y: 0 },
  { x: W, y: H },
  { x: 0, y: H },
];

/**
 * Homography taking an element of size w x h (transform-origin 0 0) onto `quad`,
 * as the 16 values of a CSS matrix3d (column-major). Heckbert's square-to-quad.
 */
export function rectToQuadMatrix(w: number, h: number, quad: Quad): number[] {
  const [p0, p1, p2, p3] = quad;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0;
  let hh = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    hh = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + hh * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + hh * p3.y;
  const f = p0.y;
  const sw = w > 0 ? 1 / w : 0;
  const sh = h > 0 ? 1 / h : 0;
  // u = x / w, v = y / h; matrix3d(a1, b1, c1, d1, a2, ...): column-major 4x4
  return [a * sw, d * sw, 0, g * sw, b * sh, e * sh, 0, hh * sh, 0, 0, 1, 0, c, f, 0, 1];
}

/** Apply a rectToQuadMatrix result to a point of the element (for tests and hit checks). */
export function applyMatrix(m: readonly number[], x: number, y: number): Pt {
  const X = m[0]! * x + m[4]! * y + m[12]!;
  const Y = m[1]! * x + m[5]! * y + m[13]!;
  const Wd = m[3]! * x + m[7]! * y + m[15]!;
  return { x: X / Wd, y: Y / Wd };
}

/** True when the matrix is the identity within `eps` (the handoff state). */
export function isIdentity(m: readonly number[], eps = 1e-6): boolean {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return m.every((v, i) => Math.abs(v - id[i]!) <= eps);
}

export function matrix3dCss(m: readonly number[]): string {
  return `matrix3d(${m.map((v) => (Math.abs(v) < 1e-12 ? 0 : +v.toFixed(8))).join(',')})`;
}
