/**
 * Finale P3: the opening cinematic (lazy chunk 'openingCinematic', loaded by
 * the home page only on the first showing per page load; never by a mode).
 *
 * Canvas 2D, layered 2.5D (see openingCockpit.ts): no WebGL, no new library.
 * One canvas in the intro overlay, one requestAnimationFrame loop (owned by a
 * DisposableScope), one ResizeObserver, one visibilitychange listener.
 *
 *   space (arrival, battle, victory, track, approach): the seeded battle from
 *     openingScene.ts with the game's own sprites, drawn opaque;
 *   cockpit (approach cross-fade, cabin, display, push): the cockpit layers with
 *     the display cut out of the canvas; the live home page (TitleScreen's DOM,
 *     inert until the handoff) sits under the canvas, transformed onto the
 *     display with a matrix3d; at the end the display is the viewport, the
 *     transform is the identity and the canvas is transparent.
 *
 * Hidden tab: requestAnimationFrame stops, so the sequence holds; on return
 * the first frame's delta is 0 (and every delta is clamped), so it resumes
 * where it was. Resize: the layout is recomputed from the new size on the next
 * frame; every position is a function of time and size, so nothing drifts.
 * Any exception while drawing ends the cinematic through onError (the shell
 * then opens the home page); nothing is retried.
 *
 * Post-release cockpit upgrade: the cabin's palette, geometry and painting
 * live in openingCabin.ts (paintCabin, with a per-resize cabinGeom cache);
 * this file keeps the loop, the space battle and the display punch/handoff
 * contract.
 */
import { SPRITES, type SpriteId } from '../../assets/sprites/index.ts';
import { drawFrame } from '../../render/sprite/drawSprite.ts';
import type { Viewport } from '../../render/viewport.ts';
import { DisposableScope } from '../lifecycle/scope.ts';
import type { CinematicDebug, CinematicHandle, CinematicOptions } from './introPolicy.ts';
import { OpeningDirector, type PhaseSample } from './openingDirector.ts';
import { buildScript, clamp01, SCENE_LIMITS, sceneAt, type SceneFrame, type SceneView } from './openingScene.ts';
import { cockpitCamera, displayAtFill, displayQuad, matrix3dCss, rectToQuadMatrix, type Quad } from './openingCockpit.ts';
import { cabinGeom, INK, paintCabin, STAR_TONES, type CabinGeom } from './openingCabin.ts';

/** Marker for the chunk inventory (scripts/lib/distCheck.ts): only this chunk carries it. */
const LAYER_TAG = 'galaxia-opening:cockpit';

function spriteFrames(id: string, state: string): number {
  const def = (SPRITES as Record<string, { states: Record<string, readonly unknown[]> }>)[id];
  return def?.states[state]?.length ?? 0;
}

export function createOpeningCinematic(opts: CinematicOptions): CinematicHandle {
  const scope = new DisposableScope();
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset['layer'] = LAYER_TAG;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas 2D is unavailable for the opening cinematic');
  opts.host.prepend(canvas);
  const ctx = g;

  const heroState = spriteFrames(opts.hero, 'thrust') > 0 ? 'thrust' : 'idle';
  const heroFrame0 = opts.sprites.frame(opts.hero as SpriteId, heroState, 0);
  const script = buildScript(opts.seed);
  const burstSmall = Math.max(1, spriteFrames('fx.explosion.enemy', 'burst'));
  const burstBig = Math.max(1, spriteFrames('fx.explosion.player', 'burst'));

  let frames = 0;
  let actors = 0;
  let particles = 0;
  let maxParticles = 0;
  let ended = false;
  const director = new OpeningDirector({
    reduced: opts.reduced,
    onPhase: (p) => opts.onPhase?.(p),
    onComplete: (o) => {
      if (o === 'played' || o === 'reduced') opts.onComplete();
    },
  });

  /* ---- layout (recomputed when the overlay's size changes) ---- */
  let W = 0;
  let H = 0;
  let dpr = 1;
  let k = 1; // device px per art px (space scene)
  let view: SceneView = { visW: 1, visH: 1, heroH: heroFrame0.raster.sprite.height, burstSmall, burstBig };
  let geom: CabinGeom = cabinGeom(1, 1); // static cockpit geometry for the current size
  let dirty = true;
  const measure = (): void => {
    dirty = false;
    W = Math.max(1, opts.host.clientWidth);
    H = Math.max(1, opts.host.clientHeight);
    dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    k = Math.max(1, Math.min(ch / 200, cw / 130));
    view = { visW: cw / k, visH: ch / k, heroH: heroFrame0.raster.sprite.height, burstSmall, burstBig };
    geom = cabinGeom(W, H);
  };
  scope.observer(new ResizeObserver(() => (dirty = true))).observe(opts.host);

  /* ---- the live home page on the display ---- */
  const target = opts.target;
  target.style.transformOrigin = '0 0';
  target.style.willChange = 'transform';
  let lastTransform = '';
  const place = (quad: Quad | null): void => {
    let css = '';
    if (quad) {
      const tw = target.offsetWidth || W;
      const th = target.offsetHeight || H;
      css = matrix3dCss(rectToQuadMatrix(tw, th, quad));
    }
    if (css !== lastTransform) {
      lastTransform = css;
      target.style.transform = css;
    }
  };

  /* ---- space ---- */
  const V: Viewport = { scale: 1, offsetX: 0, offsetY: 0, deviceWidth: 1, deviceHeight: 1, artWidth: 1, artHeight: 1 };
  const sprite = (id: string, state: string, index: number, x: number, y: number, zoom: number, rotation = 0, alpha = 1): void => {
    drawFrame(ctx, opts.sprites, opts.sprites.frame(id as SpriteId, state, index), V, x, y, { zoom, rotation, alpha });
  };

  function drawSpace(s: SceneFrame): void {
    const cw = canvas.width;
    const ch = canvas.height;
    const z = s.camera.zoom;
    const sx = (x: number): number => cw / 2 + (x - s.camera.x) * k * z;
    const sy = (y: number): number => ch / 2 + (y - s.camera.y) * k * z;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = INK.void;
    ctx.fillRect(0, 0, cw, ch);
    // two faint nebula washes (far away: they barely follow the camera)
    for (const [nx, ny, r, col] of [
      [-0.32, -0.28, 0.75, 'rgba(46,196,230,0.10)'],
      [0.36, 0.18, 0.6, 'rgba(236,79,208,0.07)'],
    ] as const) {
      const cx = cw / 2 + (nx * view.visW - s.camera.x * 0.1) * k;
      const cy = ch / 2 + (ny * view.visH - s.camera.y * 0.1) * k;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * Math.max(cw, ch));
      grad.addColorStop(0, col);
      grad.addColorStop(1, 'rgba(6,7,15,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch);
    }
    for (const st of s.stars) {
      const f = 0.25 + st.layer * 0.3;
      const zz = 1 + (z - 1) * 0.06 * (st.layer + 1);
      const x = cw / 2 + (st.x - s.camera.x * f) * k * zz;
      const y = ch / 2 + (st.y - s.camera.y * f) * k * zz;
      const w = Math.max(1, k * 0.5 * (st.layer === 2 ? 1.5 : 1));
      ctx.fillStyle = STAR_TONES[st.layer];
      ctx.fillRect(Math.round(x), Math.round(y), w, Math.max(w, st.len * k * 0.5));
    }
    const zoom = k * z;
    for (const sh of s.shots) sprite('fx.shot.enemy', 'fly', Math.floor(frames / 4), sx(sh.x), sy(sh.y), zoom, sh.angle);
    for (const b of s.bolts) sprite('fx.shot.player', 'fly', Math.floor(frames / 4), sx(b.x), sy(b.y), zoom, b.angle);
    for (const e of s.enemies) sprite(e.kind, e.attack ? 'attack' : 'formation', e.frame, sx(e.x), sy(e.y), zoom);
    sprite(opts.hero, s.hero.thrust ? heroState : 'idle', s.hero.frame, sx(s.hero.x), sy(s.hero.y), zoom);
    for (const ex of s.explosions) sprite(ex.big ? 'fx.explosion.player' : 'fx.explosion.enemy', 'burst', ex.frame, sx(ex.x), sy(ex.y), zoom);
    for (const r of s.rings) {
      ctx.globalAlpha = r.alpha;
      ctx.strokeStyle = INK.cyan;
      ctx.lineWidth = Math.max(1, k * 0.6);
      ctx.beginPath();
      ctx.arc(sx(r.x), sy(r.y), r.r * zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of s.sparks) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      const size = p.size * zoom * 0.6;
      ctx.fillRect(sx(p.x) - size / 2, sy(p.y) - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
    if (s.flare > 0) {
      const grad = ctx.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
      grad.addColorStop(0, `rgba(166,251,255,${s.flare})`);
      grad.addColorStop(1, 'rgba(92,239,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch);
    }
    actors = s.enemies.length + 1 + s.bolts.length + s.shots.length + s.explosions.length;
    particles = s.sparks.length;
    maxParticles = Math.max(maxParticles, particles);
  }


  function draw(s: PhaseSample): void {
    if (dirty) measure();
    frames += 1;
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const space = ['arrival', 'battle', 'victory', 'track', 'approach'].includes(s.phase);
    const cam = cockpitCamera(s.phase, s.p, opts.reduced, W, H);
    const quad = displayQuad(W, H, cam);
    if (space) {
      const scene = sceneAt(script, s.t, view);
      drawSpace(scene);
      if (scene.cabin > 0) paintCabin(ctx, dpr, geom, { cam, quad, t: s.t, alpha: scene.cabin, still: opts.reduced, ember: 0 });
      place(quad);
    } else if (s.phase === 'idle') {

      ctx.fillStyle = INK.deep;
      ctx.fillRect(0, 0, cw, ch);
      place(quad);
    } else {
      ctx.clearRect(0, 0, cw, ch);
      const drawn = cam.visible && !displayAtFill(cam, W, H); // past the fill threshold the canvas is visually out
      // the battle's afterglow: a brief warm wash over the canopy as the cabin phase opens (timeline-only, purely visual)
      const ember = !opts.reduced && s.phase === 'cabin' ? 1 - clamp01(s.p / 0.45) : 0;
      if (drawn) paintCabin(ctx, dpr, geom, { cam, quad, t: s.t, alpha: 1, still: opts.reduced, ember });
      actors = 0;
      particles = 0;
      place(drawn ? quad : null);
    }
    if (cam.veil > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = cam.veil;
      ctx.fillStyle = INK.deep;
      ctx.fillRect(0, 0, cw, ch);
      ctx.globalAlpha = 1;
    }
  }

  let last: number | null = null;
  let gone = false;
  const fail = (err: unknown): void => {
    if (ended) return;
    ended = true;
    director.fail();
    opts.onError(err);
  };
  const loop = scope.frameLoop((ts) => {
    if (ended) return false;
    try {
      const dt = last === null ? 0 : ts - last;
      last = ts;
      const s = director.advance(dt);
      if (gone) return false; // completion handed over and the shell disposed us inside advance()
      if (director.done) {
        ended = true;
        draw({ phase: 'complete', t: s.t, local: 0, p: 1 });
        return false;
      }
      draw(s);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  });
  scope.on(document, 'visibilitychange', () => {
    last = null; // the first frame back has no delta: the sequence resumes where it held
  });
  try {
    measure();
    draw(director.start());
  } catch (err) {
    scope.dispose();
    canvas.remove();
    throw err;
  }

  return {
    dispose() {
      if (gone) return;
      gone = true;
      ended = true;
      loop.stop();
      director.dispose();
      scope.dispose();
      canvas.remove();
      target.style.transform = '';
      target.style.transformOrigin = '';
      target.style.willChange = '';
    },
    debug(): CinematicDebug {
      return {
        phase: director.phase,
        time: Math.round(director.time),
        frames,
        loops: scope.activeLoops,
        listeners: scope.activeListeners,
        actors,
        particles,
        maxParticles,
        hero: opts.hero,
        reduced: opts.reduced,
        disposed: gone,
      };
    },
  };
}

export { SCENE_LIMITS };
