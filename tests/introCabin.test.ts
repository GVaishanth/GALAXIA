/**
 * Post-release cockpit upgrade: the cabin geometry (shared/intro/openingCabin.ts),
 * sampled against the unchanged camera math (openingCockpit.ts). The painter
 * itself is exercised by the browser harness; these tests pin the pure
 * geometry's determinism, its bounds and its one safety invariant: the pilot
 * station never rises in front of the home-page display.
 */
import { describe, expect, it } from 'vitest';
import { cabinGeom, hash01 } from '../src/shared/intro/openingCabin.ts';
import { cockpitCamera, displayQuad, displayAtFill, project, restDisplay, COCKPIT_DEPTH } from '../src/shared/intro/openingCockpit.ts';
import { FULL_SCHEDULE, phaseAt } from '../src/shared/intro/openingDirector.ts';

const SIZES: readonly (readonly [number, number])[] = [
  [1280, 800],
  [390, 844],
  [320, 568],
  [844, 390],
  [768, 1024],
];

describe('cabinGeom (static cockpit geometry per viewport)', () => {
  it('is deterministic and a pure function of the viewport size', () => {
    for (const [W, H] of SIZES) {
      expect(cabinGeom(W, H)).toEqual(cabinGeom(W, H));
      if (W !== 1280) expect(cabinGeom(W, H)).not.toEqual(cabinGeom(1280, 800));
    }
  });

  it('anchors everything to the same rest display the painter and homography use', () => {
    for (const [W, H] of SIZES) {
      const g = cabinGeom(W, H);
      expect(g.R).toEqual(restDisplay(W, H));
      expect(g.W).toBe(W);
      expect(g.H).toBe(H);
    }
  });

  it('keeps detail counts bounded and finite', () => {
    for (const [W, H] of SIZES) {
      const g = cabinGeom(W, H);
      expect(g.rimBolts.length).toBeLessThanOrEqual(9);
      expect(g.deckBolts.length).toBeLessThanOrEqual(4);
      expect(g.vents.length).toBeLessThanOrEqual(6);
      expect(g.keys).toHaveLength(7);
      const all: number[] = [
        ...g.rimBolts.flatMap((p) => [p.x, p.y]),
        ...g.deckBolts.flatMap((p) => [p.x, p.y]),
        ...g.vents.flatMap((v) => [v.x, v.y, v.w]),
        ...g.keys.flatMap((k) => [k.x, k.y, k.w, k.h]),
        ...g.streak.flatMap((p) => [p.x, p.y]),
      ];
      for (const v of all) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('chooses wing consoles vs lamp columns by the same margin rule the accepted painter used', () => {
    const wide = cabinGeom(1280, 800);
    expect(restDisplay(1280, 800).x).toBeGreaterThanOrEqual(72);
    expect(wide.wings.length).toBe(2);
    expect(wide.lightCols).toHaveLength(0);
    for (const wing of wide.wings) {
      expect(wing.bay.w).toBeGreaterThan(0);
      expect(wing.toggles).toHaveLength(6);
      expect(wing.leds).toHaveLength(3);
    }
    for (const [W, H] of [[390, 844], [320, 568]] as const) {
      const g = cabinGeom(W, H);
      expect(restDisplay(W, H).x).toBeLessThan(72);
      expect(g.wings).toHaveLength(0);
      expect(g.lightCols).toHaveLength(2);
      for (const lc of g.lightCols) expect(lc.leds).toHaveLength(5);
    }
  });

  it('keeps the glass reflection band and the fasteners inside the canopy area', () => {
    for (const [W, H] of SIZES) {
      const g = cabinGeom(W, H);
      const winBot = g.conTop + 30;
      for (const p of g.streak) {
        expect(p.y).toBeGreaterThanOrEqual(-0.06 * H);
        expect(p.y).toBeLessThanOrEqual(winBot + 1);
      }
      for (const b of g.rimBolts) {
        expect(b.x).toBeGreaterThanOrEqual(-0.02 * W);
        expect(b.x).toBeLessThanOrEqual(1.02 * W);
        expect(b.y).toBeLessThanOrEqual(winBot + 12);
      }
    }
  });
});

describe('the pilot station never covers the home-page display', () => {
  const CABIN_PHASES = ['cabin', 'display', 'push'] as const;
  it('the seatback top edge projects at or below the display bottom, for every phase and viewport', () => {
    for (const [W, H] of SIZES) {
      const g = cabinGeom(W, H);
      for (const phase of CABIN_PHASES) {
        for (let p = 0; p <= 1.0001; p += 0.05) {
          for (const reduced of [false, true]) {
            const cam = cockpitCamera(phase, Math.min(1, p), reduced, W, H);
            if (!cam.visible) continue;
            const quad = displayQuad(W, H, cam);
            const displayBottom = Math.max(quad[2]!.y, quad[3]!.y);
            const seatTop = project({ x: W / 2, y: g.seatTop }, COCKPIT_DEPTH.near, cam, W, H).y;
            expect(seatTop, `${phase} p=${p.toFixed(2)} ${W}x${H} reduced=${reduced}`).toBeGreaterThanOrEqual(displayBottom - 1);
          }
        }
      }
    }
  });

  it('at the handoff the whole pilot station is out of frame (nothing pops when the canvas hides)', () => {
    for (const [W, H] of SIZES) {
      const g = cabinGeom(W, H);
      const cam = cockpitCamera('push', 1, false, W, H);
      expect(displayAtFill(cam, W, H)).toBe(true);
      const seatTop = project({ x: W / 2, y: g.seatTop }, COCKPIT_DEPTH.near, cam, W, H).y;
      expect(seatTop).toBeGreaterThan(H);
    }
  });

  it('every full-schedule cockpit phase honours the clearance property along the real timeline', () => {
    // sample the actual schedule times rather than synthetic p values
    let t0 = 0;
    for (const [phase, ms] of FULL_SCHEDULE) {
      if (!(CABIN_PHASES as readonly string[]).includes(phase)) {
        t0 += ms;
        continue;
      }
      for (let d = 0; d <= ms; d += Math.max(40, ms / 12)) {
        const s = phaseAt(FULL_SCHEDULE, t0 + d);
        const g = cabinGeom(1280, 800);
        const cam = cockpitCamera(s.phase, s.p, false, 1280, 800);
        if (!cam.visible) continue;
        const quad = displayQuad(1280, 800, cam);
        const seatTop = project({ x: 640, y: g.seatTop }, COCKPIT_DEPTH.near, cam, 1280, 800).y;
        expect(seatTop).toBeGreaterThanOrEqual(Math.max(quad[2]!.y, quad[3]!.y) - 1);
      }
      t0 += ms;
    }
  });
});

describe('the deterministic decor hash (unchanged semantics from the accepted painter)', () => {
  it('is stable and bounded', () => {
    for (let i = 0; i < 50; i++) {
      const v = hash01(i, i * 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(hash01(i, i * 7)).toBe(v);
    }
    expect(hash01(1, 2)).not.toBe(hash01(2, 1));
  });
});
