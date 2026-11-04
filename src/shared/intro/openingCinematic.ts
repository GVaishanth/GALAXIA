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
 */
import { SPRITES, type SpriteId } from '../../assets/sprites/index.ts';
import { drawFrame } from '../../render/sprite/drawSprite.ts';
import type { Viewport } from '../../render/viewport.ts';
import { DisposableScope } from '../lifecycle/scope.ts';
import type { CinematicDebug, CinematicHandle, CinematicOptions } from './introPolicy.ts';
import { OpeningDirector, type PhaseSample } from './openingDirector.ts';
import { buildScript, SCENE_LIMITS, sceneAt, type SceneFrame, type SceneView } from './openingScene.ts';
import { COCKPIT_DEPTH, cockpitCamera, displayAtFill, displayQuad, layerRatio, matrix3dCss, rectToQuadMatrix, restDisplay, type CockpitCamera, type Quad } from './openingCockpit.ts';

/** Marker for the chunk inventory (scripts/lib/distCheck.ts): only this chunk carries it. */
const LAYER_TAG = 'galaxia-opening:cockpit';

const INK = Object.freeze({
  void: '#06070f',
  deep: '#030409',
  hull: '#161c31',
  hullDark: '#05060c',
  panel: '#0b0f1d',
  edge: '#2b3766',
  cyan: '#5cefff',
  trim: '#2ec4e6',
  amber: '#ffb347',
  green: '#7dffa8',
  text: '#c9d3f2',
});

const STAR_TONES = ['#353b57', '#555e80', '#8d96b8'] as const;

function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

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

  /* ---- cockpit ---- */
  /** Map rest-space CSS px of a layer at `depth` onto the canvas. */
  const layer = (depth: number, cam: CockpitCamera): void => {
    const r = layerRatio(depth, cam.z);
    const cx = W / 2;
    const cy = H / 2;
    ctx.setTransform(dpr * r, 0, 0, dpr * r, dpr * (cx - (cx + cam.panX) * r), dpr * (cy - (cy + cam.panY) * r));
  };
  const roundRect = (x: number, y: number, w: number, h: number, r: number): void => {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
    else ctx.rect(x, y, w, h);
  };
  const quadPath = (q: Quad): void => {
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(q[i]!.x, q[i]!.y);
    ctx.closePath();
  };
  const grow = (q: Quad, by: number): Quad => {
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    return q.map((p) => ({ x: p.x + Math.sign(p.x - cx) * by, y: p.y + Math.sign(p.y - cy) * by })) as unknown as Quad;
  };

  function drawCockpit(cam: CockpitCamera, quad: Quad, t: number, alpha: number): void {
    const R = restDisplay(W, H);
    const consoleTop = R.y - 0.07 * H;
    const still = opts.reduced;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;

    // space beyond the canopy (far: stars drift outward, forward flight)
    layer(COCKPIT_DEPTH.space, cam);
    ctx.fillStyle = INK.deep;
    ctx.fillRect(-W, -H, W * 3, H * 3);
    const glow = ctx.createRadialGradient(W * 0.3, H * 0.05, 0, W * 0.3, H * 0.05, W * 0.6);
    glow.addColorStop(0, 'rgba(46,196,230,0.12)');
    glow.addColorStop(1, 'rgba(3,4,9,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(-W, -H, W * 3, H * 3);
    const span = Math.hypot(W, H) * 0.6;
    for (let i = 0; i < 70; i++) {
      const ang = hash01(i, 1) * Math.PI * 2;
      const d = ((hash01(i, 2) * span + (still ? 0 : t * 0.02 * (0.5 + hash01(i, 3)))) % span) + 4;
      const x = W / 2 + Math.cos(ang) * d;
      const y = H * 0.3 + Math.sin(ang) * d * 0.6;
      ctx.fillStyle = STAR_TONES[i % 3]!;
      const s = 1 + (d / span) * 1.5;
      ctx.fillRect(x, y, s, s);
    }

    // canopy frame: everything but the window (evenodd), with its edge lit
    layer(COCKPIT_DEPTH.canopy, cam);
    const win = (): void => {
      ctx.moveTo(W * 0.03, consoleTop + 30);
      ctx.lineTo(W * 0.15, H * 0.07);
      ctx.quadraticCurveTo(W / 2, -H * 0.07, W * 0.85, H * 0.07);
      ctx.lineTo(W * 0.97, consoleTop + 30);
      ctx.closePath();
    };
    ctx.beginPath();
    ctx.rect(-W * 1.5, -H * 1.5, W * 4, H * 4);
    win();
    const frameGrad = ctx.createLinearGradient(0, -H * 0.2, 0, H);
    frameGrad.addColorStop(0, '#0d1122');
    frameGrad.addColorStop(1, '#07090f');
    ctx.fillStyle = frameGrad;
    ctx.fill('evenodd');
    ctx.beginPath();
    win();
    ctx.strokeStyle = INK.edge;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.35;
    ctx.strokeStyle = INK.trim;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    // centre bow strut
    ctx.fillStyle = '#0d1122';
    ctx.beginPath();
    ctx.moveTo(W / 2 - 5, -H);
    ctx.lineTo(W / 2 + 5, -H);
    ctx.lineTo(W / 2 + 3, H * 0.0);
    ctx.lineTo(W / 2 - 3, H * 0.0);
    ctx.fill();

    // console with the display, side panels and keys
    layer(COCKPIT_DEPTH.display, cam);
    ctx.beginPath();
    ctx.moveTo(-W * 0.6, consoleTop + 0.1 * H);
    ctx.quadraticCurveTo(W / 2, consoleTop - 0.1 * H, W * 1.6, consoleTop + 0.1 * H);
    ctx.lineTo(W * 1.6, H * 2.4);
    ctx.lineTo(-W * 0.6, H * 2.4);
    ctx.closePath();
    const hull = ctx.createLinearGradient(0, consoleTop, 0, H * 1.2);
    hull.addColorStop(0, INK.hull);
    hull.addColorStop(1, INK.hullDark);
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-W * 0.6, consoleTop + 0.1 * H);
    ctx.quadraticCurveTo(W / 2, consoleTop - 0.1 * H, W * 1.6, consoleTop + 0.1 * H);
    ctx.strokeStyle = INK.trim;
    ctx.globalAlpha = alpha * 0.55;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = alpha;

    const m = R.x; // side margin at rest
    const fs = Math.max(8, Math.min(12, H * 0.016));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    if (m >= 72) {
      const pw = m * 0.72;
      const ph = R.h * 0.6;
      const lx = m * 0.14;
      const rx = W - m * 0.14 - pw;
      const py = R.y + R.h * 0.14;
      for (const x of [lx, rx]) {
        roundRect(x, py, pw, ph, 8);
        ctx.fillStyle = INK.panel;
        ctx.fill();
        ctx.strokeStyle = INK.edge;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // left: radar, sweeping, no contacts left
      const rr = Math.min(pw, ph) * 0.32;
      const rcx = lx + pw / 2;
      const rcy = py + rr + ph * 0.1;
      ctx.strokeStyle = 'rgba(125,255,168,0.35)';
      ctx.lineWidth = 1;
      for (const f of [1, 0.6, 0.25]) {
        ctx.beginPath();
        ctx.arc(rcx, rcy, rr * f, 0, Math.PI * 2);
        ctx.stroke();
      }
      const sweep = still ? -0.6 : (t / 1000) * Math.PI;
      ctx.strokeStyle = 'rgba(125,255,168,0.8)';
      ctx.beginPath();
      ctx.moveTo(rcx, rcy);
      ctx.lineTo(rcx + Math.cos(sweep) * rr, rcy + Math.sin(sweep) * rr);
      ctx.stroke();
      ctx.fillStyle = INK.green;
      ctx.textAlign = 'center';
      ctx.fillText('HOSTILES 0', rcx, py + ph * 0.86);
      // right: ship status bars
      ctx.textAlign = 'left';
      ['SHLD', 'HULL', 'PWR'].forEach((label, i) => {
        const by = py + ph * (0.2 + i * 0.26);
        ctx.fillStyle = INK.text;
        ctx.fillText(label, rx + pw * 0.1, by);
        const bw = pw * 0.8;
        ctx.fillStyle = 'rgba(43,55,102,0.8)';
        ctx.fillRect(rx + pw * 0.1, by + fs * 0.8, bw, fs * 0.6);
        const level = [0.86, 0.94, 0.72][i]! + (still ? 0 : 0.02 * Math.sin(t / 700 + i));
        ctx.fillStyle = i === 2 ? INK.amber : INK.trim;
        ctx.fillRect(rx + pw * 0.1, by + fs * 0.8, bw * level, fs * 0.6);
      });
    } else if (m >= 18) {
      // narrow screens: a column of status lights each side
      for (const x of [m * 0.5, W - m * 0.5]) {
        for (let i = 0; i < 5; i++) {
          const on = still || hash01(i + (x > W / 2 ? 9 : 0), Math.floor(t / (700 + i * 130))) > 0.35;
          ctx.fillStyle = on ? (i === 4 ? INK.amber : INK.green) : '#1b2340';
          ctx.fillRect(x - 3, R.y + R.h * (0.2 + i * 0.13), 6, 6);
        }
      }
    }
    // keys under the display
    const kw = R.w * 0.7;
    const keys = 7;
    const kh = Math.max(6, H * 0.016);
    const ky = R.y + R.h + Math.max(10, H * 0.03);
    for (let i = 0; i < keys; i++) {
      const w = kw / keys - 6;
      const x = W / 2 - kw / 2 + i * (kw / keys) + 3;
      const lit = !still && hash01(i, Math.floor(t / 900)) > 0.7;
      roundRect(x, ky, w, kh, 3);
      ctx.fillStyle = lit ? 'rgba(92,239,255,0.55)' : '#121935';
      ctx.fill();
    }
    // label over the display
    ctx.textAlign = 'center';
    ctx.fillStyle = INK.cyan;
    ctx.globalAlpha = alpha * 0.75;
    ctx.fillText('FLIGHT DECK · HOME LINK', W / 2, R.y - Math.max(12, R.h * 0.04) - fs);
    ctx.globalAlpha = alpha;

    // bezel and the dark screen (screen space: the display may be keystoned)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const qw = quad[1].x - quad[0].x;
    const b = Math.max(5, Math.min(18, qw * 0.025));
    quadPath(grow(quad, b));
    ctx.fillStyle = '#090c17';
    ctx.fill();
    ctx.strokeStyle = INK.cyan;
    ctx.globalAlpha = alpha * 0.45;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    quadPath(quad);
    ctx.fillStyle = '#04050a';
    ctx.fill();
    // the display powers on: cut the screen out so the live home page shows through
    if (cam.power > 0) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.globalAlpha = cam.power;
      quadPath(quad);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
      if (cam.glare > 0) {
        const gl = ctx.createLinearGradient(quad[0].x, quad[0].y, quad[2].x, quad[2].y);
        gl.addColorStop(0, `rgba(234,255,255,${0.08 * cam.glare})`);
        gl.addColorStop(0.4, 'rgba(234,255,255,0)');
        ctx.fillStyle = gl;
        quadPath(quad);
        ctx.fill();
      }
    }

    // near: armrests, throttle and stick (they slide out of frame first)
    if (layerRatio(COCKPIT_DEPTH.near, cam.z) < 6) {
      layer(COCKPIT_DEPTH.near, cam);
      for (const side of [-1, 1] as const) {
        const x0 = side < 0 ? -W * 0.3 : W * 0.9;
        roundRect(x0, H * 0.88, W * 0.4, H * 0.5, 26);
        ctx.fillStyle = '#0c1020';
        ctx.fill();
        ctx.strokeStyle = INK.edge;
        ctx.lineWidth = 2;
        ctx.stroke();
        const gx = side < 0 ? W * 0.05 : W * 0.95;
        ctx.fillStyle = '#1a2142';
        ctx.fillRect(gx - 4, H * 0.8, 8, H * 0.1);
        ctx.fillStyle = side < 0 ? INK.amber : INK.cyan;
        ctx.beginPath();
        ctx.arc(gx, H * 0.8, 9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
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
      if (scene.cabin > 0) drawCockpit(cam, quad, s.t, scene.cabin);
      place(quad);
    } else if (s.phase === 'idle') {

      ctx.fillStyle = INK.deep;
      ctx.fillRect(0, 0, cw, ch);
      place(quad);
    } else {
      ctx.clearRect(0, 0, cw, ch);
      const drawn = cam.visible && !displayAtFill(cam, W, H); // past the fill threshold the canvas is visually out
      if (drawn) drawCockpit(cam, quad, s.t, 1);
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
