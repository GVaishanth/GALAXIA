/**
 * Adaptive render resolution (TD-79): the controller driven with synthetic
 * frames, the scaled backing size, and the guarantees that make it safe:
 * pointer/touch mapping and the arena's on-screen box do not depend on the
 * ratio, gameplay never sees it, and the per-frame path allocates nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDER } from '../src/config/devices.ts';
import { cameraView, cameraZoom, clientToDevice, screenToWorld } from '../src/modes/freeroam/camera.ts';
import { backingInto, backingSize, cssBoxToDevice, fitViewport } from '../src/render/viewport.ts';
import { RenderScaleController, type RenderScaleConfig } from '../src/shared/rendering/renderScale.ts';

const root = join(import.meta.dirname, '..');
const CFG: RenderScaleConfig = RENDER.adaptive;
const W = CFG.windowFrames;
const OPTS = { maxPixelRatio: RENDER.maxPixelRatio, maxPixels: RENDER.maxBackingPixels, minRatio: RENDER.adaptive.minRatio };

/** Drive n frames at a fixed interval/work; returns the clock and how many level changes happened. */
function run(c: RenderScaleController, t0: number, n: number, intervalMs: number, workMs = 2, active = true, canLower = true): { t: number; changes: number } {
  let t = t0;
  let changes = 0;
  for (let i = 0; i < n; i += 1) {
    t += intervalMs;
    if (c.sample(t, intervalMs, workMs, active, canLower)) changes += 1;
  }
  return { t, changes };
}
/** Frames to fill k windows after the settle period. */
const frames = (k: number): number => CFG.settleFrames + k * W;

describe('RenderScaleController (synthetic frames)', () => {
  it('keeps full resolution while frames are healthy', () => {
    const c = new RenderScaleController();
    run(c, 0, frames(20), 16.7);
    expect(c.level).toBe(0);
    expect(c.multiplier).toBe(1);
    expect(c.stats.windows).toBe(20);
  });

  it('steps down only after sustained slow windows, not one spike', () => {
    const c = new RenderScaleController();
    let r = run(c, 0, CFG.settleFrames, 16.7);
    r = run(c, r.t, W, 30); // one slow window
    r = run(c, r.t, W, 16.7); // healthy again: the slow run resets
    r = run(c, r.t, W, 30);
    expect(c.level).toBe(0);
    r = run(c, r.t, W, 30); // second consecutive slow window
    expect(c.level).toBe(1);
    expect(c.multiplier).toBe(CFG.levels[1]);
    expect(c.stats.stepsDown).toBe(1);
  });

  it('frames while paused, behind a panel or hidden never count, and resuming settles first', () => {
    const c = new RenderScaleController();
    let r = run(c, 0, frames(1), 16.7);
    r = run(c, r.t, 10 * W, 40, 2, false); // paused for ten windows of slow frames
    expect(c.level).toBe(0);
    expect(c.stats.windows).toBe(1);
    // after resume, the first settleFrames are ignored even if slow
    r = run(c, r.t, CFG.settleFrames, 40);
    expect(c.stats.windows).toBe(1);
    expect(c.level).toBe(0);
  });

  it('ignores hitches and tab-switch gaps longer than maxGapMs', () => {
    const c = new RenderScaleController();
    let r = run(c, 0, CFG.settleFrames, 16.7);
    for (let i = 0; i < 4 * W; i += 1) {
      r.t += 16.7;
      c.sample(r.t, i % 3 === 0 ? 900 : 16.7, 2, true, true); // a third of frames are 900 ms stalls
    }
    expect(c.level).toBe(0);
    expect(c.stats.lastMeanMs).toBeCloseTo(16.7, 5);
  });

  it('a descent that did not help is undone as a whole and further descents are locked (doubling)', () => {
    // a 30 Hz display: slow at every level, a lower resolution never helps
    const c = new RenderScaleController();
    let t = 0;
    let deepest = 0;
    const step = (): void => { t += 33.4; c.sample(t, 33.4, 2, true, true); deepest = Math.max(deepest, c.level); };
    while (c.stats.undone < 1 && t < 120000) step();
    expect(c.stats.undone).toBe(1);
    expect(deepest).toBe(CFG.levels.length - 1); // tried every level before concluding
    expect(c.stats.stepsDown).toBe(CFG.levels.length - 1);
    expect(c.level).toBe(0); // back to full resolution
    const firstUndo = t;
    while (t < firstUndo + 0.9 * CFG.lockMs) step();
    expect(c.stats.stepsDown).toBe(CFG.levels.length - 1); // locked
    while (c.stats.undone < 2 && t < firstUndo + 3 * CFG.lockMs) step(); // past the lock: one more descent, undone again
    expect(c.stats.undone).toBe(2);
    expect(c.level).toBe(0);
    const downs = c.stats.stepsDown;
    const secondUndo = t;
    while (t < secondUndo + 1.5 * CFG.lockMs) step();
    expect(c.stats.stepsDown).toBe(downs); // 1.5x the first lock: still locked (it doubled)
    while (t < secondUndo + 2 * CFG.lockMs + 8000) step();
    expect(c.stats.stepsDown).toBeGreaterThan(downs); // past 2x it may try again
  });

  it('judges the descent from where it started: a step with no gain does not stop a step that helps (refresh snapping)', () => {
    // measured shape (TD-79 benchmark): frames snap to 16.7/33.3 ms, so 0.85 barely helps and 0.72 hits 60 Hz
    const c = new RenderScaleController();
    const at = [27.9, 27.4, 16.9, 16.7, 16.7];
    let t = 0;
    for (let i = 0; i < 12 * W; i += 1) { const iv = at[c.level]!; t += iv; c.sample(t, iv, 4, true, true); }
    expect(c.level).toBe(2);
    expect(c.stats.undone).toBe(0);
  });

  it('a descent that stops at the floor (canLower false) and helped enough keeps the floor level', () => {
    const c = new RenderScaleController();
    const at = [40, 36, 32, 32, 32];
    let t = 0;
    for (let i = 0; i < 12 * W; i += 1) { const iv = at[c.level]!; t += iv; c.sample(t, iv, 4, true, c.level < 2); }
    expect(c.level).toBe(2); // 40 -> 32 ms is a 20 % gain: kept, though still slow
    expect(c.stats.undone).toBe(0);
  });

  it('a failed restore probe steps straight back after one window and doubles the wait', () => {
    const c = new RenderScaleController();
    const load = [26, 24, 16.7, 16.7, 16.7]; // level 2 is fine, level 1 is not
    let t = 0;
    const go = (n: number): void => { for (let i = 0; i < n; i += 1) { const iv = load[c.level]!; t += iv; c.sample(t, iv, 4, true, true); } };
    go(frames(2)); // two slow windows: the descent starts
    go(frames(1)); // still slow at level 1: one more step
    expect(c.level).toBe(2);
    go(frames(CFG.restoreWindows) + 5); // healthy long enough: probe level 1
    expect(c.level).toBe(1);
    expect(c.stats.stepsUp).toBe(1);
    go(frames(1)); // one slow window at level 1 is enough to return
    expect(c.level).toBe(2);
    expect(c.stats.restoreWindows).toBe(CFG.restoreWindows * 2);
    expect(c.stats.undone).toBe(0); // a probe return is not an undone descent
  });

  it('keeps a step down that helped, and restores gradually when frames are healthy', () => {
    const c = new RenderScaleController();
    let r = run(c, 0, frames(2), 26);
    expect(c.level).toBe(1);
    r = run(c, r.t, frames(1), 24); // better but still slow: the descent continues
    expect(c.level).toBe(2);
    r = run(c, r.t, frames(1), 16.7, 4); // fast enough: the descent stops and the level is kept
    expect(c.level).toBe(2);
    expect(c.stats.undone).toBe(0);
    r = run(c, r.t, frames(CFG.restoreWindows), 16.7, 4);
    expect(c.level).toBe(1); // one level per restore period, not straight back to full
    r = run(c, r.t, frames(CFG.restoreWindows), 16.7, 4);
    expect(c.level).toBe(0);
    expect(c.stats.stepsUp).toBe(2);
  });

  it('does not restore while main-thread work is heavy, even at full frame rate', () => {
    const c = new RenderScaleController();
    let r = run(c, 0, frames(2), 26);
    expect(c.level).toBe(1);
    r = run(c, r.t, frames(3 * CFG.restoreWindows), 16.7, CFG.healthyWorkMs + 3);
    expect(c.level).toBe(1);
  });

  it('hysteresis: a relapse right after a restore doubles the restore wait', () => {
    const c = new RenderScaleController();
    let r = run(c, 0, frames(2), 26);
    r = run(c, r.t, frames(CFG.restoreWindows), 16.7, 4);
    expect(c.level).toBe(0);
    r = run(c, r.t, frames(2), 26); // slow again within relapseMs
    expect(c.level).toBe(1);
    expect(c.stats.restoreWindows).toBe(CFG.restoreWindows * 2);
    r = run(c, r.t, frames(CFG.restoreWindows), 16.7, 4);
    expect(c.level).toBe(1); // the old wait is no longer enough
    r = run(c, r.t, CFG.restoreWindows * W, 16.7, 4);
    expect(c.level).toBe(0);
  });

  it('respects the floor (canLower = false) and the last level', () => {
    const c = new RenderScaleController();
    run(c, 0, frames(20), 40, 2, true, false);
    expect(c.level).toBe(0);
    const d = new RenderScaleController();
    let r = { t: 0, changes: 0 };
    const slowAt = [40, 36, 32, 28.5, 26]; // each level helps (>= minGain) but frames stay slow
    for (let k = 0; k < 12; k += 1) r = run(d, r.t, W, slowAt[d.level]!);
    expect(d.level).toBe(CFG.levels.length - 1);
  });

  it('reset() returns to full resolution at once (Pixel Perfect)', () => {
    const c = new RenderScaleController();
    run(c, 0, frames(2), 26);
    expect(c.level).toBe(1);
    expect(c.reset()).toBe(true);
    expect(c.level).toBe(0);
    expect(c.reset()).toBe(false);
  });

  it('the per-frame path allocates nothing: running sums, stats mutated in place', () => {
    const c = new RenderScaleController();
    const stats = c.stats;
    run(c, 0, frames(6), 26);
    expect(c.stats).toBe(stats);
    const src = readFileSync(join(root, 'src/shared/rendering/renderScale.ts'), 'utf8');
    const body = src.slice(src.indexOf('  sample(nowMs'), src.indexOf('  private setLevel'));
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toMatch(/\bnew\b|\[\]|=>|\.push\(|\.slice\(|\.map\(|\{\s*\w+:/);
  });
});

describe('scaled backing size (pixel budget, lower bound)', () => {
  it('DPR 1: never below CSS resolution, so nothing changes', () => {
    for (const k of CFG.levels) expect(backingSize(1280, 720, 1, { ...OPTS, scale: k })).toMatchObject({ width: 1280, height: 720, ratio: 1 });
  });

  it('DPR 2: each level lowers the ratio down to 1 (CSS resolution, an exact 2x upscale)', () => {
    const ratios = CFG.levels.map((k) => backingSize(1280, 720, 2, { ...OPTS, scale: k }).ratio);
    expect(ratios[0]).toBe(2);
    for (let i = 1; i < ratios.length; i += 1) expect(ratios[i]!).toBeLessThanOrEqual(ratios[i - 1]!);
    expect(ratios.at(-1)).toBe(1);
    expect(backingSize(1280, 720, 2, { ...OPTS, scale: 0.5 })).toMatchObject({ width: 1280, height: 720, capped: true });
  });

  it('2560x1440 at DPR 2: the pixel budget caps first, then the levels reach the floor', () => {
    const full = backingSize(2560, 1440, 2, OPTS);
    expect(full.width * full.height).toBeLessThanOrEqual(RENDER.maxBackingPixels + 6000);
    expect(full.ratio).toBeGreaterThan(1.2);
    const low = backingSize(2560, 1440, 2, { ...OPTS, scale: CFG.levels.at(-1)! });
    expect(low).toMatchObject({ width: 2560, height: 1440, ratio: 1 });
  });

  it('an exact device box is used only at full scale', () => {
    const exact = { width: 2560, height: 1440 };
    expect(backingSize(1280, 720, 2, { ...OPTS, exact }).width).toBe(2560);
    expect(backingSize(1280, 720, 2, { ...OPTS, exact, scale: 0.85 }).width).toBe(2176);
  });

  it('backingInto writes into the caller object (no allocation on the per-frame path)', () => {
    const out = { width: 0, height: 0, ratio: 0, capped: false };
    backingInto(out, 1280, 720, 2, { ...OPTS, scale: 0.72 });
    expect(out).toEqual(backingSize(1280, 720, 2, { ...OPTS, scale: 0.72 }));
  });
});

describe('the ratio is presentation only', () => {
  it('Free Roam: a pointer or touch at a CSS point maps to the same world point at every level (DPR 1 and 2)', () => {
    for (const dpr of [1, 2]) {
      for (const [cw, ch] of [[1280, 720], [390, 844], [2560, 1440]] as const) {
        const cam = { x: 1234.5, y: -321.25 };
        const at = (k: number): { x: number; y: number } => {
          const b = backingSize(cw, ch, dpr, { ...OPTS, scale: k });
          const v = cameraView(cam, cameraZoom(b.width, b.height), b.width, b.height);
          const rect = { left: 17, top: 9 };
          const d = clientToDevice(17 + cw * 0.3, 9 + ch * 0.8, rect, b.ratio);
          return screenToWorld(v, d.x, d.y);
        };
        const ref = at(1);
        for (const k of CFG.levels) {
          const p = at(k);
          expect(Math.abs(p.x - ref.x)).toBeLessThan(0.75); // under one world unit: rounding of the backing size only
          expect(Math.abs(p.y - ref.y)).toBeLessThan(0.75);
        }
      }
    }
  });

  it('Classic: the arena keeps its CSS box (and so the HUD/pop-up overlay and taps) at every level', () => {
    for (const dpr of [1, 2, 3]) {
      for (const [cw, ch] of [[320, 568], [1366, 768], [2560, 1440]] as const) {
        const css = (k: number): number[] => {
          const b = backingSize(cw, ch, dpr, { ...OPTS, scale: k });
          const v = fitViewport(b.width, b.height, { integerScale: false, align: 'center', area: cssBoxToDevice({ left: 0, top: 0, width: cw, height: ch }, b) });
          return [v.offsetX / b.ratio, v.offsetY / b.ratio, (v.artWidth * v.scale) / b.ratio, (v.artHeight * v.scale) / b.ratio];
        };
        const ref = css(1);
        for (const k of CFG.levels) css(k).forEach((n, i) => expect(Math.abs(n - ref[i]!)).toBeLessThanOrEqual(1.01));
      }
    }
  });

  it('gameplay never reads it: no simulation module imports the render scale or the canvas surface', () => {
    const sim = ['src/core/game/engine.ts', 'src/modes/freeroam/sector/run.ts'];
    for (const f of sim) expect(readFileSync(join(root, f), 'utf8')).not.toMatch(/renderScale|canvasSurface|backingSize|devicePixelRatio/);
  });

  it('only the two game canvases are adaptive; the maps stay at full resolution', () => {
    const src = (f: string): string => readFileSync(join(root, f), 'utf8');
    expect(src('src/game/app.ts')).toMatch(/new CanvasSurface\([^)]*'stage-canvas mode-canvas', \{ adaptive: true \}\)/);
    expect(src('src/modes/freeroam/freeRoamMode.ts')).toMatch(/'fr-canvas mode-canvas', \{ adaptive: true \}\)/);
    expect(src('src/modes/freeroam/galaxy/mapShell.ts')).not.toMatch(/adaptive/);
    expect(src('src/game/app.ts')).toMatch(/if \(pixelPerfect\) surface\.adaptive\?\.reset\(\);/);
  });
});
