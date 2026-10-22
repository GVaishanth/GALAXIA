/**
 * Free Roam follow camera (pure). Uniform scale only, never stretched:
 * the base zoom shows about `shortSideArt` world px across the shorter side of
 * the canvas and never more than `longSideMaxArt` across the longer side, so
 * phones, desktops and ultra-wide screens see a comparable amount of space
 * (docs/freeroam/TECHNICAL_DECISIONS.md FR-TD-05). A bounded player zoom
 * multiplies it (FR-TD-42). While the pilot is engaged the view eases out to
 * `combatFraming` (FR-TD-51) so attackers holding their stand-off range stay
 * on screen; it eases back once the fight is over.
 *
 * Three coordinate spaces, never mixed:
 *  - world: logical art px of the sector (the simulation's only space);
 *  - device: backing-store px of the canvas (what is drawn);
 *  - client: CSS px of pointer events (converted with the canvas rect and the
 *    backing ratio).
 * `worldToScreen` / `screenToWorld` are exact inverses and are the only
 * conversion used by the renderer and by pointer aiming. The camera is
 * presentation only: it reads the ship, it never writes simulation state.
 */
export const CAMERA = Object.freeze({
  shortSideArt: 360,
  longSideMaxArt: 640,
  /** Seconds of velocity lead (less with reduced motion). */
  lookAhead: 0.35,
  lookAheadReduced: 0.12,
  /** Follow stiffness (1/s): higher = tighter. */
  stiffness: 5,
  stiffnessReduced: 12,
  /** Player zoom multiplier bounds and step (1 = default view). */
  zoomMin: 0.75,
  zoomMax: 1.5,
  zoomStep: 1.15,
  /** Zoom multiplier while engaged (presentation only) and its easing rate (1/s). */
  combatFraming: 0.72,
  framingRate: 2.5,
  framingRateReduced: 12,
  /** Farther than this from its target (art px), the camera jumps instead of panning (recall, gate, entry). */
  snapDistance: 900,
  /** How far the view may show beyond the sector edge (art px). */
  edgeMargin: 160,
});

export interface CameraState {
  x: number;
  y: number;
}

/** A frozen camera for one frame: centre (world), zoom (device px per world px) and canvas size (device px). */
export interface CameraView {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
}

/** Clamp a player zoom multiplier to its bounds (non-finite = 1). */
export function clampZoom(z: number): number {
  return Number.isFinite(z) ? Math.min(CAMERA.zoomMax, Math.max(CAMERA.zoomMin, z)) : 1;
}

/** Step the player zoom in (+1) or out (-1), bounded. */
export function stepZoom(z: number, dir: number): number {
  const next = clampZoom(z) * (dir > 0 ? CAMERA.zoomStep : 1 / CAMERA.zoomStep);
  // snap back to exactly 1 when passing it, so the default is always reachable
  return Math.abs(next - 1) < 0.02 ? 1 : clampZoom(next);
}

/** Device px per world (art) px for a canvas of w x h device px, times the bounded player zoom. */
export function cameraZoom(w: number, h: number, playerZoom = 1): number {
  const W = Math.max(1, w);
  const H = Math.max(1, h);
  return Math.max(Math.min(W, H) / CAMERA.shortSideArt, Math.max(W, H) / CAMERA.longSideMaxArt) * clampZoom(playerZoom);
}

export function cameraView(cam: CameraState, zoom: number, width: number, height: number): CameraView {
  return { x: cam.x, y: cam.y, zoom, width, height };
}

/** World point -> device px on the canvas. */
export function worldToScreen(v: CameraView, x: number, y: number): { x: number; y: number } {
  return { x: v.width / 2 + (x - v.x) * v.zoom, y: v.height / 2 + (y - v.y) * v.zoom };
}

/** Device px on the canvas -> world point (exact inverse of worldToScreen). */
export function screenToWorld(v: CameraView, sx: number, sy: number): { x: number; y: number } {
  return { x: v.x + (sx - v.width / 2) / v.zoom, y: v.y + (sy - v.height / 2) / v.zoom };
}

/** Pointer client (CSS) px -> device px of a canvas whose box is `rect` and whose backing ratio is `ratio`. */
export function clientToDevice(clientX: number, clientY: number, rect: { readonly left: number; readonly top: number }, ratio: number): { x: number; y: number } {
  return { x: (clientX - rect.left) * ratio, y: (clientY - rect.top) * ratio };
}

/** Exponential follow toward the ship plus a velocity lead. Frame-rate independent. */
export function stepCamera(cam: CameraState, x: number, y: number, vx: number, vy: number, dtSeconds: number, reducedMotion: boolean): void {
  const lead = reducedMotion ? CAMERA.lookAheadReduced : CAMERA.lookAhead;
  const tx = x + vx * lead;
  const ty = y + vy * lead;
  if (Math.hypot(tx - cam.x, ty - cam.y) > CAMERA.snapDistance) {
    snapCamera(cam, x, y);
    return;
  }
  const k = 1 - Math.exp(-(reducedMotion ? CAMERA.stiffnessReduced : CAMERA.stiffness) * Math.max(0, dtSeconds));
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
}

/** Ease the combat framing multiplier toward `combatFraming` (engaged) or 1 (calm). */
export function stepFraming(f: number, engaged: boolean, dtSeconds: number, reducedMotion: boolean): number {
  const target = engaged ? CAMERA.combatFraming : 1;
  const k = 1 - Math.exp(-(reducedMotion ? CAMERA.framingRateReduced : CAMERA.framingRate) * Math.max(0, dtSeconds));
  const cur = Number.isFinite(f) ? f : 1;
  const next = cur + (target - cur) * k;
  return Math.abs(next - target) < 0.002 ? target : next;
}

/** Jump straight to a point (sector entry, gate arrival, recall, restart). */
export function snapCamera(cam: CameraState, x: number, y: number): void {
  cam.x = x;
  cam.y = y;
}

/** Keep the view centred inside the world plus a margin (art px). */
export function clampCamera(cam: CameraState, viewW: number, viewH: number, worldW: number, worldH: number, margin: number = CAMERA.edgeMargin): void {
  const clampAxis = (c: number, view: number, world: number): number => {
    const lo = view / 2 - margin;
    const hi = world - view / 2 + margin;
    return lo > hi ? world / 2 : Math.min(hi, Math.max(lo, c));
  };
  cam.x = clampAxis(cam.x, viewW, worldW);
  cam.y = clampAxis(cam.y, viewH, worldH);
}
