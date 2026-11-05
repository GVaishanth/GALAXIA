/**
 * Post-release cockpit upgrade: the fighter cabin of the opening cinematic
 * (part of the lazy openingCinematic chunk; drawn only by openingCinematic.ts).
 *
 * Same renderer as the accepted Final Edition: layered Canvas 2D, a 2.5D
 * pinhole camera (openingCockpit.ts) — NOT a modelled 3D interior. Four
 * layers at fixed depths (foreground station, dashboard, canopy, space) are
 * scaled about the screen centre by layer/(layer - camZ); nearer layers grow
 * and slide away faster, which is all the depth there is. What changed is
 * what each layer paints: an engineered cockpit instead of a console blob.
 *
 * Geometry is a pure function of the viewport (cabinGeom, rebuilt on resize
 * by the painter): bolt and vent positions, console rects, the nav trace —
 * nothing per frame. Deterministic throughout: no random source, no wall
 * clock, no state carried between frames; the only inputs are the camera and
 * the timeline. The home-page display contract is untouched: the bezel and
 * collar are drawn in screen space around the live display quad, the screen
 * interior is still punched out of the canvas so the real TitleScreen shows
 * through, and the transform/handoff maths lives in openingCockpit.ts.
 *
 * Materials (one vocabulary): matte composite cabin, painted gunmetal
 * structure, brighter bevel catches on upper-left edges (the exterior light),
 * dark glass bays, emissive cyan instruments, restrained amber. All
 * instrumentation is decorative: fixed labels and levels, never live game
 * values; the canvas neither reads state nor takes input (pointer-events
 * none, aria-hidden — set by the painter).
 */
import { COCKPIT_DEPTH, layerRatio, restDisplay, type CockpitCamera, type Pt, type Quad, type Rect } from './openingCockpit.ts';

type Ctx = CanvasRenderingContext2D;

/** The cabin palette: structure first, instruments last. */
export const INK = Object.freeze({
  void: '#06070f',
  deep: '#030409',
  frame: '#161b2a', // canopy slab
  frameHi: '#46538a', // frame edge catching the exterior light
  hull: '#141a2a', // dashboard face
  hullTop: '#232b42', // deck band (top surface)
  hullDark: '#070a12',
  panel: '#1b2134', // console face
  panelHi: '#4c5c94',
  // recessed bays use 'glass'; wells use '#090d18'/'#0a0e1a' directly
  glass: '#04070c', // inactive screen glass
  edge: '#2b3766',
  trim: '#2ec4e6',
  cyan: '#5cefff',
  amber: '#ffb347',
  green: '#7dffa8',
  text: '#c9d3f2',
  seat: '#131722',
  seatDark: '#090b11',
});

export const STAR_TONES = ['#353b57', '#555e80', '#8d96b8'] as const;

/** Deterministic hash -> 0..1 (fixed decor jitter only; there is no random source anywhere). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export interface WingGeom {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The recessed instrument screen inside the console. */
  readonly bay: Rect;
  readonly toggles: readonly Pt[]; // toggle cap centres (2 rows x 3, left console only)
  readonly leds: readonly Pt[]; // status lamp centres (3)
}

/** Static cockpit geometry for one viewport size (pure; rebuilt on resize). */
export interface CabinGeom {
  readonly W: number;
  readonly H: number;
  readonly R: Rect; // the rest display: everything is anchored to it
  readonly conTop: number; // deck line y (rest space)
  readonly lip: number; // deck band height (its top surface)
  readonly fs: number; // label font size
  readonly streak: Quad; // the canopy's long reflection band
  readonly rimBolts: readonly Pt[]; // canopy frame fasteners
  readonly deckBolts: readonly Pt[]; // deck band fasteners
  readonly seams: readonly (readonly [number, number, number, number])[]; // dashboard face seams
  readonly vents: readonly { readonly x: number; readonly y: number; readonly w: number }[]; // grille slots
  readonly keys: readonly Rect[]; // the seven keys under the display
  readonly wings: readonly WingGeom[]; // side consoles (empty on narrow screens)
  readonly lightCols: readonly { readonly x: number; readonly strip: Rect; readonly leds: readonly Pt[] }[]; // narrow-screen lamp columns
  readonly trace: readonly Pt[]; // nav scope polyline, unit coords scaled into the right bay
  /** The pilot station: the seatback top edge never rises above the display's bottom (tested). */
  readonly seatTop: number;
  readonly headTop: number; // headrest top edge
}

export function cabinGeom(W: number, H: number): CabinGeom {
  const R = restDisplay(W, H);
  const conTop = R.y - 0.07 * H;
  const lip = Math.max(12, 0.022 * H);
  const fs = Math.max(8, Math.min(12, H * 0.016));
  const winBot = conTop + 30;
  const cx = W / 2;
  // frame fasteners: fixed positions just off the glass (frame side of the canopy opening)
  const rimBolts: Pt[] = [
    { x: 0.32 * W, y: H * 0.02 },
    { x: 0.5 * W, y: -H * 0.004 },
    { x: 0.68 * W, y: H * 0.02 },
    { x: 0.072 * W, y: 0.55 * winBot },
    { x: 0.118 * W, y: 0.17 * winBot },
    { x: 0.928 * W, y: 0.55 * winBot },
    { x: 0.882 * W, y: 0.17 * winBot },
  ];
  const deckBolts: Pt[] = [0.1, 0.9].map((f) => ({ x: f * W, y: conTop + lip * 0.55 }));
  const seams: [number, number, number, number][] = [
    [R.x - 16, conTop + lip + 3, R.x - 16, H * 1.6],
    [R.x + R.w + 16, conTop + lip + 3, R.x + R.w + 16, H * 1.6],
  ];
  // cooling slots flanking the key row, tucked under the housing
  const ky = R.y + R.h + Math.max(10, H * 0.03);
  const kh = Math.max(6, H * 0.016);
  const vents: { x: number; y: number; w: number }[] = [];
  for (const x0 of [R.x + 18, R.x + R.w - 76]) for (let i = 0; i < 2; i++) vents.push({ x: x0, y: ky + kh + 9 + i * 7, w: 58 });
  const kw = R.w * 0.7;
  const keys: Rect[] = [];
  for (let i = 0; i < 7; i++) keys.push({ x: cx - kw / 2 + (i * kw) / 7 + 3, y: ky, w: kw / 7 - 6, h: kh });
  const wings: WingGeom[] = [];
  const lightCols: CabinGeom['lightCols'][number][] = [];
  if (R.x >= 72) {
    const pw = R.x * 0.72;
    const ph = R.h * 0.6;
    for (const side of [0, 1]) {
      const x = side ? W - R.x * 0.14 - pw : R.x * 0.14;
      const y = R.y + R.h * 0.14;
      const bay = { x: x + 8, y: y + 8, w: pw - 16, h: ph * 0.4 };
      const toggles: Pt[] = [];
      for (let r = 0; r < 2; r++) for (let cix = 0; cix < 3; cix++) toggles.push({ x: x + pw * (0.25 + cix * 0.25), y: y + ph * (0.58 + r * 0.14) });
      const leds: Pt[] = [0.3, 0.5, 0.7].map((f) => ({ x: x + pw * f, y: y + ph * 0.9 }));
      wings.push({ x, y, w: pw, h: ph, bay, toggles, leds });
    }
  } else if (R.x >= 18) {
    const lightPt = (x: number): Pt[] => [0, 1, 2, 3, 4].map((i) => ({ x, y: R.y + R.h * (0.2 + i * 0.13) }));
    for (const x of [R.x * 0.5, W - R.x * 0.5]) lightCols.push({ x, strip: { x: x - 7, y: R.y + R.h * 0.13, w: 14, h: R.h * 0.62 }, leds: lightPt(x) });
  }
  // the nav scope trace (unit; scaled into the right bay at paint)
  const trace: Pt[] = [0, 0.16, 0.33, 0.5, 0.66, 0.83, 1].map((x, i) => ({ x, y: [0.62, 0.54, 0.4, 0.46, 0.3, 0.5, 0.36][i]! }));
  return {
    W,
    H,
    R,
    conTop,
    lip,
    fs,
    streak: [{ x: 0.3 * W, y: -0.05 * H }, { x: 0.385 * W, y: -0.05 * H }, { x: 0.1 * W, y: winBot }, { x: 0.02 * W, y: winBot }],
    rimBolts,
    deckBolts,
    seams,
    vents,
    keys,
    wings,
    lightCols,
    trace,
    seatTop: 1.07 * H,
    headTop: 1.155 * H,
  };
}

/** What the painter hands over each frame (all timeline-derived). */
export interface CabinPaintState {
  readonly cam: CockpitCamera;
  readonly quad: Quad; // the live display on screen (screen space, keystoned)
  readonly t: number; // sequence ms
  readonly alpha: number; // cabin fade-in during the approach
  readonly still: boolean; // reduced motion: a still cabin, frozen instruments
  readonly ember: number; // 0..1: the battle's afterglow washing the canopy (cabin phase start, then out)
}

export function paintCabin(ctx: Ctx, dpr: number, G: CabinGeom, s: CabinPaintState): void {
  const { cam, quad } = s;
  const { W, H, R } = G;
  const { deep, frame, frameHi, hull, hullTop, hullDark, panel, panelHi, glass, edge, trim, cyan, amber, green, text, seat, seatDark } = INK;
  const cx = W / 2;
  const alpha = s.alpha;
  const t = s.still ? 0 : s.t;
  const winBot = G.conTop + 30;
  type Style = string | CanvasGradient;
  const F = (v: Style): void => {
    ctx.fillStyle = v;
  };
  const S = (v: Style, w: number): void => {
    ctx.strokeStyle = v;
    ctx.lineWidth = w;
  };
  /** Evenly stopped linear/radial gradients (every cabin gradient uses them). */
  const LG = (x0: number, y0: number, x1: number, y1: number, stops: readonly string[]): CanvasGradient => {
    const g2 = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach((st, i) => g2.addColorStop(i / (stops.length - 1), st));
    return g2;
  };
  const RG = (x: number, y: number, r: number, stops: readonly string[]): CanvasGradient => {
    const g2 = ctx.createRadialGradient(x, y, 0, x, y, r);
    stops.forEach((st, i) => g2.addColorStop(i / (stops.length - 1), st));
    return g2;
  };
  const growQ = (q: Quad, by: number): Quad => {
    const mx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const my = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    return q.map((p2) => ({ x: p2.x + Math.sign(p2.x - mx) * by, y: p2.y + Math.sign(p2.y - my) * by })) as unknown as Quad;
  };
  const M = (x: number, y: number): void => ctx.moveTo(x, y);
  const L = (x: number, y: number): void => ctx.lineTo(x, y);
  const at = (depth: number): void => {
    const r = layerRatio(depth, cam.z);
    ctx.setTransform(dpr * r, 0, 0, dpr * r, dpr * (cx - (cx + cam.panX) * r), dpr * (H / 2 - (H / 2 + cam.panY) * r));
  };
  const rr = (x: number, y: number, w: number, h: number, r: number): void => {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
    else ctx.rect(x, y, w, h);
  };
  const qp = (q: Quad): void => {
    ctx.beginPath();
    M(q[0].x, q[0].y);
    for (let i = 1; i < 4; i++) L(q[i]!.x, q[i]!.y);
    ctx.closePath();
  };
  const winPath = (): void => {
    M(W * 0.03, winBot);
    L(W * 0.15, H * 0.07);
    ctx.quadraticCurveTo(cx, -H * 0.07, W * 0.85, H * 0.07);
    L(W * 0.97, winBot);
    ctx.closePath();
  };
  const bolt = (p: Pt, r: number): void => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    F('rgba(140,160,215,0.55)');
    ctx.beginPath();
    ctx.arc(p.x - r * 0.3, p.y - r * 0.3, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
  };

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = alpha;

  /* ---- space through the canopy (far layer: slight drift = forward flight) ---- */
  at(COCKPIT_DEPTH.space);
  F(deep);
  ctx.fillRect(-W, -H, W * 3, H * 3);
  F(RG(W * 0.3, H * 0.05, W * 0.6, ['rgba(46,196,230,0.12)', 'rgba(3,4,9,0)']));
  ctx.fillRect(-W, -H, W * 3, H * 3);
  const span = Math.hypot(W, H) * 0.6;
  for (let i = 0; i < 70; i++) {
    const ang = hash01(i, 1) * Math.PI * 2;
    const d = ((hash01(i, 2) * span + t * 0.02 * (0.5 + hash01(i, 3))) % span) + 4;
    const sz = 1 + (d / span) * 1.5;
    F(STAR_TONES[i % 3]!);
    ctx.fillRect(cx + Math.cos(ang) * d, H * 0.3 + Math.sin(ang) * d * 0.6, sz, sz);
  }

  /* ---- canopy: glass first, then the structural frame over it ---- */
  at(COCKPIT_DEPTH.canopy);
  ctx.save();
  ctx.beginPath();
  winPath();
  ctx.clip();
  F(LG(0, -H * 0.06, 0, winBot, ['rgba(120,170,255,0.055)', 'rgba(120,170,255,0.018)']));
  ctx.fillRect(-W * 0.1, -H * 0.1, W * 1.2, winBot + H * 0.15);
  F('rgba(200,225,255,0.038)');
  qp(G.streak);
  ctx.fill();
  if (s.ember > 0) {
    F(RG(W * 0.78, H * 0.3, W * 0.55, [`rgba(255,179,71,${0.1 * s.ember})`, 'rgba(255,179,71,0)']));
    ctx.fillRect(-W, -H, W * 3, H * 3);
  }
  ctx.restore();
  // the slab: everything but the glass opening
  ctx.beginPath();
  ctx.rect(-W * 1.5, -H * 1.5, W * 4, H * 4);
  winPath();
  F(LG(0, -H * 0.2, 0, H, [frame, '#090c14']));
  ctx.fill('evenodd');
  // the metal rim (brighter toward the light); the path persists across the stroke
  // (the stroke also rings the huge outer rect, harmlessly off screen)
  S(LG(0, -H * 0.1, 0, winBot + 20, [frameHi, '#0b0f1a']), 2.5);
  ctx.stroke();
  // structural members: the centre bow strut and the two A-pillars, tapered and bevelled
  // tapered and bevelled: the centre bow strut and the two A-pillars converging to the dash corners
  const ribs: [number, number, number, number, number, number][] = [
    [cx, -H, cx, H * 0.005, 5, 3],
    [W * 0.055, winBot + 24, W * 0.168, H * 0.085, 6, 3.5],
    [W * 0.945, winBot + 24, W * 0.832, H * 0.085, 6, 3.5],
  ];
  ctx.globalAlpha = alpha * 0.6;
  for (const [x0, y0, x1, y1, w0, w1] of ribs) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l = Math.hypot(dx, dy);
    const nx = -dy / l;
    const ny = dx / l;
    ctx.beginPath();
    M(x0 + nx * w0, y0 + ny * w0);
    L(x1 + nx * w1, y1 + ny * w1);
    L(x1 - nx * w1, y1 - ny * w1);
    L(x0 - nx * w0, y0 - ny * w0);
    ctx.closePath();
    F('#141a29');
    ctx.fill();
    S('#3d4a78', 1);
    ctx.beginPath();
    M(x0 + nx * w0, y0 + ny * w0);
    L(x1 + nx * w1, y1 + ny * w1);
    ctx.stroke();
  }
  ctx.globalAlpha = alpha;
  F('#05070c');
  for (const p of G.rimBolts) bolt(p, 1.6);

  /* ---- the dashboard (display layer): shell, consoles, instruments ---- */
  at(COCKPIT_DEPTH.display);
  const deck = (dy: number): void => {
    M(-W * 0.6, G.conTop + 0.1 * H + dy);
    ctx.quadraticCurveTo(cx, G.conTop - 0.1 * H + dy, W * 1.6, G.conTop + 0.1 * H + dy);
  };
  // dashboard shell: front face below, top surface (the "deck band") above
  ctx.beginPath();
  deck(0);
  L(W * 1.6, H * 2.4);
  L(-W * 0.6, H * 2.4);
  ctx.closePath();
  F(LG(0, G.conTop, 0, H * 1.2, [hull, hullDark]));
  ctx.fill();
  ctx.beginPath();
  deck(0);
  L(W * 1.6, G.conTop + 0.1 * H + G.lip);
  ctx.quadraticCurveTo(cx, G.conTop - 0.1 * H + G.lip, -W * 0.6, G.conTop + 0.1 * H + G.lip);
  ctx.closePath();
  F(LG(0, G.conTop - 0.1 * H, 0, G.conTop + 0.1 * H + G.lip, [hullTop, '#1a2136']));
  ctx.fill();
  // the joint: catch light on the deck edge, contact shadow just under it
  ctx.beginPath();
  deck(0);
  S(LG(-W * 0.6, 0, W * 1.6, 0, ['rgba(85,102,168,0.7)', 'rgba(46,196,230,0.5)', 'rgba(60,72,120,0.4)']), 1.5);
  ctx.stroke();
  // face seams, deck fasteners, cooling slots
  S('rgba(5,7,12,0.45)', 1.5);
  for (const [x0, y0, x1, y1] of G.seams) {
    ctx.beginPath();
    M(x0, y0);
    L(x1, y1);
    ctx.stroke();
  }
  F('#05070c');
  for (const p of G.deckBolts) bolt(p, 1.4);
  S('#05070c', 2.2);
  ctx.lineCap = 'round';
  for (const v of G.vents) {
    ctx.beginPath();
    M(v.x, v.y);
    L(v.x + v.w, v.y);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  // the seven keys under the display (fixed blink pattern, decor only)
  G.keys.forEach((kG, i) => {
    const lit = !s.still && hash01(i, Math.floor(t / 900)) > 0.7;
    F(lit ? 'rgba(92,239,255,0.55)' : '#121935');
    ctx.fillRect(kG.x, kG.y, kG.w, kG.h);
  });
  // the soft cyan pool the live screen casts on the deck (instrument light)
  if (cam.power > 0) {
    F(RG(cx, R.y + R.h * 0.5, R.w * 0.62, [`rgba(46,196,230,${0.1 * cam.power})`, 'rgba(46,196,230,0)']));
    ctx.fillRect(R.x - R.w * 0.1, R.y - R.h * 0.1, R.w * 1.2, R.h + G.lip + 30);
  }

  ctx.font = `700 ${G.fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const [wi, wg] of G.wings.entries()) {
    // console face with a protective top lip and a contact shadow under it
    rr(wg.x, wg.y, wg.w, wg.h, 8);
    F(panel);
    ctx.fill();
    S(edge, 1.5);
    ctx.stroke();
    F('rgba(120,145,215,0.5)');
    ctx.fillRect(wg.x, wg.y, wg.w, 1);
    // the recessed instrument bay (dark glass, framed, inner shadow on top)
    rr(wg.bay.x, wg.bay.y, wg.bay.w, wg.bay.h, 4);
    F(glass);
    ctx.fill();
    S('#232c46', 2);
    ctx.stroke();
    const bx = wg.bay.x;
    const by = wg.bay.y;
    const bw = wg.bay.w;
    const bh = wg.bay.h;
    ctx.textAlign = 'center';
    if (wi === 0) {
      // RADAR: rings and a lone sweep — the battle is over, no contacts
      const rr0 = Math.min(bw, bh) * 0.34;
      const rcx = bx + bw / 2;
      const rcy = by + bh * 0.52;
      S('rgba(125,255,168,0.35)', 1);
      for (const f of [1, 0.6, 0.25]) {
        ctx.beginPath();
        ctx.arc(rcx, rcy, rr0 * f, 0, Math.PI * 2);
        ctx.stroke();
      }
      const sweep = s.still ? -0.6 : (t / 1000) * Math.PI;
      S('rgba(125,255,168,0.8)', 1);
      ctx.beginPath();
      M(rcx, rcy);
      L(rcx + Math.cos(sweep) * rr0, rcy + Math.sin(sweep) * rr0);
      ctx.stroke();
      F(green);
      ctx.fillText('HOSTILES 0', rcx, by + bh - G.fs * 0.6);
      // BUS toggles: slots and caps, one amber-tipped
      for (const tp of wg.toggles) {
        F('#39436b');
        ctx.fillRect(tp.x - 3, tp.y - 5, 6, 10);
      }
      F(text);
      ctx.globalAlpha = alpha * 0.65;
      ctx.fillText('RADAR', bx + bw / 2, wg.y + wg.h - G.fs * 0.7);
      ctx.globalAlpha = alpha;
    } else {
      // NAV scope: a fixed course trace; SHLD/HULL/PWR bars (the accepted decorative levels)
      S('rgba(92,239,255,0.75)', 1.5);
      ctx.beginPath();
      for (const [i, p] of G.trace.entries()) (i ? L : M)(bx + p.x * bw, by + p.y * bh);
      ctx.stroke();
      ctx.textAlign = 'left';
      ['SHLD', 'HULL', 'PWR'].forEach((label, i) => {
        const byy = wg.y + wg.h * (0.54 + i * 0.13);
        F(text);
        ctx.fillText(label, wg.x + wg.w * 0.08, byy);
        const level = [0.86, 0.94, 0.72][i]! + (s.still ? 0 : 0.02 * Math.sin(t / 700 + i));
        const bw2 = wg.w * 0.5;
        F('rgba(43,55,102,0.35)');
        ctx.fillRect(wg.x + wg.w * 0.42, byy - 3, bw2, 6);
        F(i === 2 ? amber : trim);
        ctx.fillRect(wg.x + wg.w * 0.42, byy - 3, bw2 * Math.min(1, level), 6);
      });
      ctx.textAlign = 'center';
      F(text);
      ctx.globalAlpha = alpha * 0.65;
      ctx.fillText('NAV', bx + bw / 2, wg.y + wg.h - G.fs * 0.7);
      ctx.globalAlpha = alpha;
    }
    // status lamps (one slow decor blink; steady under reduced motion)
    for (const [i, lp] of wg.leds.entries()) {
      const on = s.still || i < 2 || hash01(7 + wi * 3 + i, Math.floor(t / 1400)) > 0.25;
      F(on ? (i === 2 ? amber : green) : '#1b2340');
      ctx.beginPath();
      ctx.arc(lp.x, lp.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const lc of G.lightCols) {
    rr(lc.strip.x, lc.strip.y, lc.strip.w, lc.strip.h, 7);
    F('#0d1220');
    ctx.fill();
    lc.leds.forEach((lp, i) => {
      const on = s.still || hash01(i + (lc.x > cx ? 9 : 0), Math.floor(t / (700 + i * 130))) > 0.35;
      F(on ? (i === 4 ? amber : green) : '#1b2340');
      ctx.fillRect(lp.x - 3, lp.y - 3, 6, 6);
    });
  }
  // the placard over the display (unchanged from the accepted edition)
  ctx.textAlign = 'center';
  F(cyan);
  ctx.globalAlpha = alpha * 0.75;
  ctx.fillText('FLIGHT DECK · HOME LINK', cx, R.y - Math.max(12, R.h * 0.04) - G.fs);
  ctx.globalAlpha = alpha;

  /* ---- the display housing (screen space: it hugs the live, keystoned quad) ---- */
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const qw = quad[1].x - quad[0].x;
  const b = Math.max(5, Math.min(18, qw * 0.025)); // bezel band (as accepted)
  const cwid = Math.max(4, Math.min(14, qw * 0.016)); // mounting collar
  const collar = growQ(quad, b + cwid);
  qp(collar);
  F(LG(collar[0].x, collar[0].y, collar[2].x, collar[2].y, ['#2b3450', '#1a2136', '#10152a']));
  ctx.fill();
  S('rgba(120,145,215,0.4)', 1.5);
  ctx.stroke();
  // corner brackets (one path: an L at each corner)
  const bLen = Math.min(16, qw * 0.03);
  ctx.beginPath();
  for (const p0 of collar) {
    M(p0.x, p0.y);
    L(p0.x + Math.sign(cx - p0.x) * bLen, p0.y);
    M(p0.x, p0.y);
    L(p0.x, p0.y + Math.sign(H / 2 - p0.y) * bLen);
  }
  S(panelHi, 2.5);
  ctx.stroke();
  // bezel, recess line, dark screen — then the live page is punched through
  qp(growQ(quad, b));
  F('#0b0e18');
  ctx.fill();
  S(cyan, 1.5);
  ctx.globalAlpha = alpha * 0.3;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  qp(quad);
  F('#04050a');
  ctx.fill();
  if (cam.power > 0) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = cam.power;
    qp(quad);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    if (cam.glare > 0) {
      F(LG(quad[0].x, quad[0].y, quad[2].x, quad[2].y, [`rgba(234,255,255,${0.08 * cam.glare})`, 'rgba(234,255,255,0.02)', 'rgba(234,255,255,0)']));
      qp(quad);
      ctx.fill();
    }
  }

  /* ---- the pilot station (near layer: slides out of frame first) ---- */
  if (layerRatio(COCKPIT_DEPTH.near, cam.z) < 6) {
    at(COCKPIT_DEPTH.near);
    // arm consoles: identical units mirrored about the centre line
    for (const sd of [-1, 1]) {
      ctx.save();
      ctx.translate(cx, 0);
      ctx.scale(sd, 1);
      ctx.translate(-cx, 0);
      const y0 = H * 0.86;
      rr(-W * 0.03, y0, W * 0.27, H * 0.8, 18);
      F(LG(0, y0, 0, y0 + H * 0.4, ['#161b28', seatDark]));
      ctx.fill();
      S(edge, 2);
      ctx.stroke();
      F('rgba(120,145,215,0.28)'); // the top edge catches the cabin light
      ctx.fillRect(W * 0.01, y0, W * 0.21, 1.2);
      const gx = W * 0.1;
      if (sd > 0) {
        // throttle (left hand): a grip with an amber cap
        F('#20283c');
        rr(gx - 14, H * 0.828, 28, H * 0.034, 5);
        ctx.fill();
        F(amber);
        ctx.beginPath();
        ctx.arc(gx, H * 0.83, 4.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // stick: a tilted shaft with a cyan cap over its boot shadow
        S('#242c40', 6);
        ctx.lineCap = 'round';
        ctx.beginPath();
        M(gx, H * 0.86);
        L(gx + W * 0.012, H * 0.812);
        ctx.stroke();
        ctx.lineCap = 'butt';
        F('#20283c');
        rr(gx + W * 0.012 - 11, H * 0.79, 22, H * 0.032, 6);
        ctx.fill();
        F(cyan);
        ctx.beginPath();
        ctx.arc(gx + W * 0.012, H * 0.791, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
      F('rgba(125,255,168,0.5)'); // one live lamp per console
      ctx.beginPath();
      ctx.arc(gx + 30, H * 0.872, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // the seat: padded back and headrest rising into the lower frame, harness over the shoulders
    const sTop = G.seatTop;
    const sw = W * 0.34;
    ctx.beginPath();
    M(cx - sw / 2 + 8, sTop + H * 0.045);
    ctx.quadraticCurveTo(cx - sw / 2 + 4, sTop + 2, cx - sw / 2 + sw * 0.14, sTop);
    L(cx + sw / 2 - sw * 0.14, sTop);
    ctx.quadraticCurveTo(cx + sw / 2 - 4, sTop + 2, cx + sw / 2 - 8, sTop + H * 0.045);
    L(cx + sw / 2 - 8, H * 1.9);
    L(cx - sw / 2 + 8, H * 1.9);
    ctx.closePath();
    F(LG(0, sTop, 0, sTop + H * 0.5, [seat, seatDark]));
    ctx.fill(); // fill() keeps the path: the rim stroke reuses it
    S(LG(cx - sw / 2, 0, cx + sw / 2, 0, ['rgba(140,170,235,0.5)', 'rgba(140,170,235,0.06)']), 2);
    ctx.stroke();
    // bolsters and their stitched seams
    F('rgba(5,6,10,0.55)');
    ctx.fillRect(cx - sw / 2 + 8, sTop + H * 0.045, sw * 0.05, H);
    ctx.fillRect(cx + sw / 2 - 8 - sw * 0.05, sTop + H * 0.045, sw * 0.05, H);
    // harness straps with their buckles
    for (const sd of [-1, 1]) {
      const sx0 = cx + sd * sw * 0.3;
      ctx.beginPath();
      M(sx0 - sd * 10, sTop + H * 0.16);
      L(sx0 - sd * 2, sTop + H * 0.02);
      L(sx0 + sd * 6, sTop + H * 0.02);
      L(sx0 + sd * 12, sTop + H * 0.16);
      ctx.closePath();
      F('#10131d');
      ctx.fill();
      F('#232b40');
      rr(sx0 - sd * 4 - 6, sTop + H * 0.085, 12, H * 0.02, 2);
      ctx.fill();
    }
    // headrest with a top catch light
    const hw = W * 0.13;
    rr(cx - hw / 2, G.headTop, hw, H * 0.085, 12);
    F(LG(0, G.headTop, 0, G.headTop + H * 0.085, ['#1a1f2e', '#0d1017']));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
