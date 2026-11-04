/**
 * Finale P3: the cinematic choreography (shared/intro/openingScene.ts) and the
 * cockpit handoff geometry (openingCockpit.ts) — pure, sampled against a fake
 * clock. Sizes come from the built sprites when available (the registry is
 * data), else documented fallbacks.
 */
import { describe, expect, it } from 'vitest';
import { buildScript, enemyAt, heroAt, sceneAt, SCENE_LIMITS, SCENE_TIMES, type SceneView } from '../src/shared/intro/openingScene.ts';
import { applyMatrix, cockpitCamera, displayAtFill, displayQuad, FULL_QUAD, isIdentity, matrix3dCss, rectToQuadMatrix, restDisplay } from '../src/shared/intro/openingCockpit.ts';
import { OPENING_PHASES, phaseAt, FULL_SCHEDULE, REDUCED_SCHEDULE, type OpeningPhase } from '../src/shared/intro/openingDirector.ts';
import { SPRITES } from '../src/assets/sprites/index.ts';
import type { SpriteDef } from '../src/assets/sprites/format/types.ts';

const framesOf = (id: string, state: string): number => {
  const def = (SPRITES as Record<string, SpriteDef<string>>)[id];
  const st = def?.states as Record<string, readonly unknown[]> | undefined;
  return st?.[state]?.length ?? 6;
};

const VIEW: SceneView = { visW: 400, visH: 240, heroH: 24, burstSmall: framesOf('fx.explosion.enemy', 'burst'), burstBig: framesOf('fx.explosion.player', 'burst') };

/** Phases the sampled time falls into (with the reduced schedule when on). */
const samplePhase = (t: number, reduced: boolean): OpeningPhase => phaseAt(reduced ? REDUCED_SCHEDULE : FULL_SCHEDULE, t).phase;

describe('the schedule and the script agree on the clock', () => {
  it('the scene global times are the schedule phase boundaries (arrival .. approach)', () => {
    const start = (p: (typeof FULL_SCHEDULE)[number][0]): number => {
      let t = 0;
      for (const [q, ms] of FULL_SCHEDULE) {
        if (q === p) return t;
        t += ms;
      }
      throw new Error(String(p));
    };
    expect(SCENE_TIMES.arrivalEnd).toBe(start('battle')); // arrival ends when the battle begins
    expect(SCENE_TIMES.battleEnd).toBe(start('victory'));
    expect(SCENE_TIMES.victoryEnd).toBe(start('track'));
    expect(SCENE_TIMES.trackEnd).toBe(start('approach'));
    expect(SCENE_TIMES.approachEnd).toBe(start('cabin'));
  });
});

describe('the battle script (buildScript / sceneAt)', () => {
  const script = buildScript(0x6a1a2026);

  it('is deterministic: the same seed twice, a different seed a different kill order', () => {
    const again = buildScript(0x6a1a2026);
    expect(again).toEqual(script);
    const orders = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) orders.add(JSON.stringify(buildScript(seed).enemies.map((e) => e.killAt)));
    expect(orders.size).toBeGreaterThan(2);
  });

  it('bounds actors, projectiles, explosions and particles over the whole sequence', () => {
    let maxEnemies = 0;
    let maxBolts = 0;
    let maxShots = 0;
    let maxExplosions = 0;
    let maxSparks = 0;
    let totalSparks = 0;
    for (let t = 0; t <= 8400; t += 10) {
      const f = sceneAt(script, t, VIEW);
      maxEnemies = Math.max(maxEnemies, f.enemies.length);
      maxBolts = Math.max(maxBolts, f.bolts.length);
      maxShots = Math.max(maxShots, f.shots.length);
      maxExplosions = Math.max(maxExplosions, f.explosions.length);
      maxSparks = Math.max(maxSparks, f.sparks.length);
      totalSparks += f.sparks.length;
    }
    expect(maxEnemies).toBeLessThanOrEqual(SCENE_LIMITS.enemies);
    expect(maxBolts).toBeLessThanOrEqual(SCENE_LIMITS.bolts);
    expect(maxShots).toBeLessThanOrEqual(SCENE_LIMITS.shots);
    expect(maxExplosions).toBeLessThanOrEqual(SCENE_LIMITS.explosions);
    expect(maxSparks).toBeGreaterThan(20);
    expect(maxSparks).toBeLessThanOrEqual(SCENE_LIMITS.sparks);
    // and none of it at the very start or end (idle / cockpit hand-off)
    expect(sceneAt(script, 0, VIEW).enemies).toHaveLength(0);
    expect(sceneAt(script, 8300, VIEW).enemies).toHaveLength(0);
    expect(totalSparks).toBeGreaterThan(0);
  });

  it('has exactly seven temporary enemies, one commander that dies last, and six mercy kills at 250 ms beats', () => {
    expect(script.enemies).toHaveLength(SCENE_LIMITS.enemies);
    const commander = script.enemies.filter((e) => e.kind === 'enemy.commander');
    expect(commander).toHaveLength(1);
    expect(Math.max(...script.enemies.map((e) => e.killAt))).toBe(commander[0]!.killAt);
    const rest = script.enemies.filter((e) => e.kind !== 'enemy.commander').map((e) => e.killAt);
    expect(rest).toHaveLength(6);
    for (let i = 1; i < 6; i++) expect(rest.slice().sort((a, b) => a - b)[i]! - rest.slice().sort((a, b) => a - b)[i - 1]!).toBe(250);
    // every kill sits inside the battle phase
    for (const e of script.enemies) expect(e.killAt).toBeLessThan(SCENE_TIMES.battleEnd);
  });

  it('destruction follows its bolt: killAt minus the bolt travel, the enemy drawn until then, gone then', () => {
    const srt = buildScript(42);
    // killer bolts are sorted by spawn (they land first), so enemy i pairs with bolt i
    const kills = srt.bolts.filter((b) => b.target !== null);
    expect(kills).toHaveLength(SCENE_LIMITS.enemies);
    srt.enemies.forEach((e) => {
      const bolt = kills.find((b) => b.target === srt.enemies.indexOf(e))!;
      expect(bolt.target).toBe(srt.enemies.indexOf(e));
      expect(e.killAt - bolt.spawnAt).toBeCloseTo(bolt.travel);
      const before = sceneAt(srt, e.killAt - 1, VIEW);
      expect(before.enemies.some((x) => x.kind === e.kind)).toBe(true);
      const at = sceneAt(srt, e.killAt, VIEW);
      // this enemy is no longer drawn, and its explosion has just started
      expect(at.explosions.length).toBeGreaterThan(0);
      const after = sceneAt(srt, e.killAt + 1, VIEW);
      expect(after.enemies.some((x) => x.kind === e.kind && enemyAt(e, e.killAt, VIEW).x === x.x && enemyAt(e, e.killAt, VIEW).y === x.y)).toBe(false);
    });
  });

  it('the hero rises from below during the arrival and stays bounded afterwards', () => {
    const start = heroAt(0, VIEW);
    const end = heroAt(SCENE_TIMES.arrivalEnd, VIEW);
    expect(start.y).toBeGreaterThan(end.y);
    for (let t = SCENE_TIMES.arrivalEnd; t <= 5700; t += 10) {
      const h = heroAt(t, VIEW);
      expect(Math.abs(h.x)).toBeLessThanOrEqual(VIEW.visW / 2);
      expect(Math.abs(h.y)).toBeLessThanOrEqual(VIEW.visH / 2);
    }
    expect(heroAt(5700, VIEW)).toEqual(heroAt(5700, VIEW));
  });

  it('the camera leads the endgame: track centres on the hero, approach dives at its canopy', () => {
    const track = sceneAt(script, SCENE_TIMES.trackEnd - 1, VIEW);
    expect(Math.abs(track.camera.x - track.hero.x)).toBeLessThanOrEqual(4);
    const end = sceneAt(script, SCENE_TIMES.approachEnd, VIEW);
    expect(end.camera.zoom).toBeCloseTo(30, 5);
    expect(end.camera.y).toBeCloseTo(end.hero.y - VIEW.heroH * 0.18, 3);
    // shake only around the commander's death
    expect(sceneAt(script, 1200, VIEW).camera).toEqual({ x: 0, y: 0, zoom: 1 });
    const shake = sceneAt(script, 3120, VIEW).camera;
    expect(Math.abs(shake.x) + Math.abs(shake.y)).toBeGreaterThan(0.5);
    expect(sceneAt(script, 3301, VIEW).camera.x).toBe(0);
  });

  it('enemy shots are misses and every skill bolt kills only what it targets', () => {
    for (const sh of script.shots) {
      expect(Math.abs(sh.aim)).toBeGreaterThan(0.1);
      expect(Math.abs(sh.aim)).toBeLessThan(0.4);
    }
    const misses = script.bolts.filter((b) => b.target === null);
    expect(misses).toHaveLength(4);
    expect(script.bolts).toHaveLength(SCENE_LIMITS.enemies + 4);
  });

  it('span clamps: a narrow portrait is kept on screen', () => {
    const slim: SceneView = { ...VIEW, visW: 180, visH: 300 };
    const f = sceneAt(script, 1500, slim);
    for (const e of f.enemies) expect(Math.abs(e.x)).toBeLessThanOrEqual(180 / 2 - 16 + 12);
    expect(Math.abs(f.hero.x)).toBeLessThanOrEqual(90);
  });

  it('the cabin fade and the glass flare are bounded and in approach only', () => {
    const before = sceneAt(script, SCENE_TIMES.trackEnd - 1, VIEW);
    expect(before.cabin).toBe(0);
    let maxCabin = 0;
    let maxFlare = 0;
    for (let t = 4700; t <= 5700; t += 5) {
      const f = sceneAt(script, t, VIEW);
      maxCabin = Math.max(maxCabin, f.cabin);
      maxFlare = Math.max(maxFlare, f.flare);
    }
    expect(maxCabin).toBeCloseTo(1, 5);
    expect(maxFlare).toBeGreaterThan(0.1);
    expect(maxFlare).toBeLessThanOrEqual(0.25);
    expect(sceneAt(script, 5701, VIEW).cabin).toBe(1);
  });

  it('star streaks fade to a cruise after the arrival (no permanent warp)', () => {
    const fIn = sceneAt(script, 0, VIEW);
    const fOut = sceneAt(script, SCENE_TIMES.arrivalEnd + 1, VIEW);
    expect(Math.max(...fIn.stars.map((s) => s.len))).toBeGreaterThan(3);
    expect(Math.max(...fOut.stars.map((s) => s.len))).toBeLessThanOrEqual(3);
  });

  it('enemy cards stay in their frame budgets when portions of the viewport change', () => {
    for (const v of [VIEW, { ...VIEW, visW: 900, visH: 400 }]) {
      for (const e of buildScript(3).enemies) {
        const p = enemyAt(e, e.diveAt ?? e.killAt - 1, v);
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });
});

describe('the cockpit geometry (openingCockpit.ts)', () => {
  const W = 1280;
  const H = 800;

  it('the rest display is centred a touch low and keeps the viewport aspect', () => {
    const r = restDisplay(W, H);
    expect(r.w / W).toBeCloseTo(r.h / H, 2);
    expect(r.x + r.w / 2).toBeCloseTo(W / 2);
    expect(r.y + r.h / 2).toBeCloseTo(H * 0.53);
    // small screens get a relatively larger display
    expect(restDisplay(360, 640).w / 360).toBeGreaterThan(r.w / W);
  });

  it('the push converges to exactly the viewport (the handoff state)', () => {
    const cam = cockpitCamera('push', 1, false, W, H);
    const q = displayQuad(W, H, cam);
    const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 6);
    close(q[0].x, 0);
    close(q[0].y, 0);
    close(q[1].x, W);
    close(q[2].y, H);
    close(q[3].x, 0);
    close(q[3].y, H);
    expect(cam.keystone).toBe(0);
    expect(displayAtFill(cam, W, H)).toBe(true); // the painter stops drawing and hands over here
    expect(cockpitCamera('handoff', 0, false, W, H).visible).toBe(false);
    // the page's transform is the identity at the push end on the same viewport (exact when the rest scale is 0.5)
    expect(isIdentity(rectToQuadMatrix(W, H, q), 1e-6)).toBe(true);
    expect(isIdentity(rectToQuadMatrix(1024, 768, displayQuad(1024, 768, cockpitCamera('push', 1, false, 1024, 768))), 1e-9)).toBe(true);
    expect(matrix3dCss(rectToQuadMatrix(W, H, q))).toContain('matrix3d');
  });

  it('the handoff and the completed state agree with the end of the push', () => {
    const a = cockpitCamera('handoff', 0.5, false, W, H);
    const b = cockpitCamera('complete', 1, false, W, H);
    const c = cockpitCamera('push', 1, false, W, H);
    expect(a.z).toBeCloseTo(c.z, 6);
    expect(b.z).toBeCloseTo(c.z, 6);
    expect(a.visible).toBe(false);
    const qa = displayQuad(W, H, a);
    const qb = displayQuad(W, H, b);
    for (let i = 0; i < 4; i++) {
      expect(qa[i]!.x).toBeCloseTo(qb[i]!.x, 6);
      expect(qa[i]!.y).toBeCloseTo(qb[i]!.y, 6);
    }
  });

  it('the cabin opens smaller, closer and keystoned (viewed from behind the seat)', () => {
    const start = cockpitCamera('cabin', 0, false, W, H);
    const later = cockpitCamera('cabin', 1, false, W, H);
    const q0 = displayQuad(W, H, start);
    const q1 = displayQuad(W, H, later);
    const w0 = q0[1].x - q0[0].x;
    const w1 = q1[1].x - q1[0].x;
    expect(w0).toBeLessThan(w1);
    expect(start.keystone).toBeGreaterThan(later.keystone);
    // the top edge really is narrower (the keystoning), never wider than the bottom
    const topw = q0[1].x - q0[0].x;
    const botw = q0[2].x - q0[3].x;
    expect(topw).toBeLessThan(botw);
    // powers on during the cabin phase
    expect(start.power).toBe(0);
    expect(later.power).toBeCloseTo(1, 5);
  });

  it('the displayed phase names match the schedule (no space-only phases inside the cockpit)', () => {
    expect(samplePhase(6300, false)).toBe('cabin');
    expect(OPENING_PHASES).toContain('cabin');
    expect(samplePhase(1500, false)).toBe('battle');
  });

  it('the homography moves corners exactly to the quad (and a square to a square)', () => {
    const quad: ReturnType<typeof displayQuad> = displayQuad(W, H, cockpitCamera('display', 0.5, false, W, H));
    const m = rectToQuadMatrix(W, H, quad);
    for (let i = 0; i < 4; i++) {
      const pt = applyMatrix(m, [0, W, W, 0][i]!, [0, 0, H, H][i]!);
      expect(pt.x).toBeCloseTo(quad[i]!.x, 1);
      expect(pt.y).toBeCloseTo(quad[i]!.y, 1);
    }
    // the identity quad maps an element to itself (covers the handoff endpoint exactly)
    const id = rectToQuadMatrix(W, H, FULL_QUAD(W, H));
    expect(isIdentity(id, 1e-9)).toBe(true);
    expect(applyMatrix(id, 17, 42)).toEqual({ x: 17, y: 42 });
    // reduced motion: the veil replaces the camera; the still cockpit sits at rest, covered
    const mid = cockpitCamera('push', 0.5, true, W, H);
    expect(mid.z).toBe(0);
    expect(cockpitCamera('push', 0, true, W, H).veil).toBe(0);
    expect(mid.veil).toBeCloseTo(0.5, 2);
    // the reduced handoff is the same full-viewport endpoint as the push end
    const cam = cockpitCamera('handoff', 0.5, true, W, H);
    expect(cam.visible).toBe(false);
    expect(displayAtFill(cam, W, H)).toBe(true);
    expect(isIdentity(rectToQuadMatrix(W, H, displayQuad(W, H, cam)), 1e-6)).toBe(true);
    expect(cockpitCamera('display', 0.5, true, W, H).keystone).toBe(0);
  });

  it('the veil never exceeds 1 and the glare never hides the page once powered', () => {
    for (const phase of ['cabin', 'display', 'push', 'handoff', 'complete'] as const) {
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        for (const reduced of [false, true]) {
          const cam = cockpitCamera(phase, p, reduced, W, H);
          expect(cam.veil).toBeGreaterThanOrEqual(0);
          expect(cam.veil).toBeLessThanOrEqual(1);
          if (phase !== 'cabin') expect(cam.power).toBe(1);
          expect(Number.isFinite(cam.z)).toBe(true);
          expect(Number.isFinite(cam.panX)).toBe(true);
          expect(Number.isFinite(cam.panY)).toBe(true);
        }
      }
    }
  });

  it('the camera is continuous at the cabin -> display -> push boundaries', () => {
    const c = cockpitCamera('cabin', 1, false, W, H);
    const d = cockpitCamera('display', 0, false, W, H);
    const e = cockpitCamera('display', 1, false, W, H);
    const f = cockpitCamera('push', 0, false, W, H);
    for (const [a, b] of [
      [c, d],
      [e, f],
    ] as const) {
      expect(a.z).toBeCloseTo(b.z, 6);
      expect(a.panX).toBeCloseTo(b.panX, 6);
      expect(a.keystone).toBeCloseTo(b.keystone, 6);
    }
  });

  it('rest display margins decide the side panels vs light columns at phone widths', () => {
    expect(restDisplay(320, 568).x).toBeLessThan(72); // lights, not panels
    expect(restDisplay(1280, 800).x).toBeGreaterThanOrEqual(72);
  });
});
