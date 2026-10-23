/**
 * Gravity Flight prototype P01: world-space overlay drawn after drawSector in
 * the experimental sector only (presentation; it reads the run and the lab and
 * writes nothing).
 *
 *  - Collision boundary: a thin ring on the planet surface (the radius the
 *    physics tests), red while the prediction says the ship will hit it.
 *  - Gravity indicator: an arrow from the ship toward the planet whose length
 *    and label give the pull as a share of engine thrust; danger is shown by
 *    text and length as well as colour. Hidden below the display threshold.
 *  - Predicted trajectory (PATH or ASSIST on): dotted, labelled
 *    "ESTIMATE · ENGINES OFF"; an X marks a predicted impact.
 *  - Collision warning (always): "IMPACT IN 1.8 s" from the same prediction.
 *  - Gravity Flight Assist on: the suggested escape heading (a chevron on a
 *    ring round the ship labelled ESCAPE <time> or CLIMB, advice only; or
 *    NO SAFE ESCAPE IN <n> s when every heading examined hits the planet) and a short cyan jet where the assist
 *    thrusts, so its correction is visibly separate from the main engine.
 *  - Field edge: a faint dotted ring at the instrumentation radius (only with
 *    PATH or ASSIST on), never a solid giant ring.
 */
import type { CameraView } from '../camera.ts';
import type { SectorRun } from '../sector/run.ts';
import type { GravityLab } from './lab.ts';

export interface OverlayOptions {
  readonly alpha: number;
  /** Device px per CSS px (labels keep a readable size). */
  readonly ratio: number;
  readonly reducedMotion: boolean;
}

const CYAN = '#5cefff';
const AMBER = '#ffc04d';
const RED = '#ff3b4e';
const GREEN = '#7dff9a';
const TEXT = '#f3efe4';

/** Pull as a share of engine thrust -> danger level (text, colour). */
export function pullLevel(share: number): { readonly label: string; readonly color: string } {
  if (share >= 0.6) return { label: 'DANGER', color: RED };
  if (share >= 0.25) return { label: 'STRONG', color: AMBER };
  return { label: 'PULL', color: CYAN };
}

export function drawGravityOverlay(ctx: CanvasRenderingContext2D, run: SectorRun, lab: GravityLab, view: CameraView, o: OverlayOptions): void {
  const zoom = view.zoom;
  const cx = view.width / 2 - view.x * zoom;
  const cy = view.height / 2 - view.y * zoom;
  const toX = (x: number): number => cx + x * zoom;
  const toY = (y: number): number => cy + y * zoom;
  const px = (n: number): number => Math.max(1, Math.round(n * o.ratio));
  const sh = run.ship;
  const a = o.alpha;
  const sx = toX(sh.px + (sh.x - sh.px) * a);
  const sy = toY(sh.py + (sh.y - sh.py) * a);
  const b = lab.body;
  const bx = toX(b.x);
  const by = toY(b.y);
  const d = lab.diag;
  const pred = lab.prediction;
  const impactSoon = pred.impactIn >= 0;
  const guides = lab.showPath || lab.assist;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineCap = 'round';

  /* collision boundary (the physics radius) */
  ctx.globalAlpha = impactSoon ? 0.9 : 0.45;
  ctx.strokeStyle = impactSoon ? RED : TEXT;
  ctx.lineWidth = px(impactSoon ? 2 : 1);
  ctx.beginPath();
  ctx.arc(bx, by, b.r * zoom, 0, Math.PI * 2);
  ctx.stroke();

  /* planet off screen: a small edge marker toward it with the distance to its surface */
  const R = b.r * zoom;
  if (bx + R < 0 || bx - R > view.width || by + R < 0 || by - R > view.height) {
    const m = px(34);
    const ang = Math.atan2(by - view.height / 2, bx - view.width / 2);
    const hx = view.width / 2 - m;
    const hy = view.height / 2 - m;
    const k = Math.min(hx / Math.max(1e-6, Math.abs(Math.cos(ang))), hy / Math.max(1e-6, Math.abs(Math.sin(ang))));
    const ex = view.width / 2 + Math.cos(ang) * k;
    const ey = view.height / 2 + Math.sin(ang) * k;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = TEXT;
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(ang) * px(9), ey + Math.sin(ang) * px(9));
    ctx.lineTo(ex + Math.cos(ang + 2.5) * px(7), ey + Math.sin(ang + 2.5) * px(7));
    ctx.lineTo(ex + Math.cos(ang - 2.5) * px(7), ey + Math.sin(ang - 2.5) * px(7));
    ctx.closePath();
    ctx.fill();
    const km = Math.max(0, d.altitude);
    ctx.font = `${px(10)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = Math.cos(ang) > 0.3 ? 'right' : Math.cos(ang) < -0.3 ? 'left' : 'center';
    ctx.textBaseline = Math.sin(ang) > 0.3 ? 'bottom' : Math.sin(ang) < -0.3 ? 'top' : 'middle';
    ctx.fillText(`PLANET ${km >= 1000 ? `${(km / 1000).toFixed(1)}k` : Math.round(km)}`, ex - Math.cos(ang) * px(14), ey - Math.sin(ang) * px(14));
  }

  /* field edge: faint dotted, only when the guides are on */
  if (guides) {
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = px(1);
    ctx.setLineDash([px(2), px(10)]);
    ctx.beginPath();
    ctx.arc(bx, by, d.fieldRadius * zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* predicted trajectory (engines off) */
  if (guides && pred.count > 1) {
    ctx.strokeStyle = impactSoon ? RED : CYAN;
    ctx.lineWidth = px(1.5);
    ctx.setLineDash([px(3), px(5)]);
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    for (let i = 1; i < pred.count; i++) ctx.lineTo(toX(lab.path[i * 2]!), toY(lab.path[i * 2 + 1]!));
    ctx.stroke();
    ctx.setLineDash([]);
    const ex = toX(lab.path[(pred.count - 1) * 2]!);
    const ey = toY(lab.path[(pred.count - 1) * 2 + 1]!);
    if (impactSoon) {
      const k = px(6);
      ctx.globalAlpha = 1;
      ctx.lineWidth = px(2);
      ctx.beginPath();
      ctx.moveTo(ex - k, ey - k);
      ctx.lineTo(ex + k, ey + k);
      ctx.moveTo(ex + k, ey - k);
      ctx.lineTo(ex - k, ey + k);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = impactSoon ? RED : CYAN;
    ctx.font = `${px(9)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`ESTIMATE · ENGINES OFF · ${pred.seconds.toFixed(1)} s`, ex + px(8), ey);
  }

  /* gravity indicator: direction, strength (share of thrust), danger in words */
  const share = d.gravity / Math.max(1, lab.params.thrust);
  if (share >= lab.params.displayThreshold) {
    const lvl = pullLevel(share);
    const dx = b.x - sh.x;
    const dy = b.y - sh.y;
    const dl = Math.hypot(dx, dy) || 1;
    const ux = dx / dl;
    const uy = dy / dl;
    const r0 = px(22);
    const len = px(12 + 46 * Math.min(1, Math.sqrt(share)));
    const x0 = sx + ux * r0;
    const y0 = sy + uy * r0;
    const x1 = x0 + ux * len;
    const y1 = y0 + uy * len;
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = lvl.color;
    ctx.fillStyle = lvl.color;
    ctx.lineWidth = px(2);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const hx = px(5);
    ctx.beginPath();
    ctx.moveTo(x1 + ux * hx, y1 + uy * hx);
    ctx.lineTo(x1 - uy * hx * 0.8, y1 + ux * hx * 0.8);
    ctx.lineTo(x1 + uy * hx * 0.8, y1 - ux * hx * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.font = `${px(9)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`G ${lvl.label} ${Math.round(share * 100)}%`, x1 + ux * px(16), y1 + uy * px(16));
  }

  /* collision warning (always on: it is the danger warning of the HUD) */
  if (impactSoon) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = RED;
    ctx.font = `bold ${px(11)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`IMPACT IN ${pred.impactIn.toFixed(1)} s`, sx, sy - px(30));
  }

  /* Gravity Flight Assist: escape suggestion (advice only) and the assist jet */
  if (lab.assist) {
    const h = lab.advice.heading;
    if (Number.isFinite(h)) {
      const nx = Math.sin(h);
      const ny = -Math.cos(h);
      const rr = px(34);
      const col = lab.advice.escapes ? GREEN : AMBER;
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = col;
      ctx.lineWidth = px(2);
      const tx = sx + nx * rr;
      const ty = sy + ny * rr;
      const w = px(6);
      ctx.beginPath();
      ctx.moveTo(tx - nx * w - ny * w, ty - ny * w + nx * w);
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx - nx * w + ny * w, ty - ny * w - nx * w);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.font = `${px(8)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = lab.advice.escapes && Number.isFinite(lab.advice.time) ? `ESCAPE ${lab.advice.time.toFixed(1)}s` : 'CLIMB';
      ctx.fillText(label, tx + nx * px(18), ty + ny * px(18));
    } else if (lab.advice.status === 'none' && lab.advice.horizon > 0) {
      // honest: every heading examined hits the planet within the look-ahead
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = RED;
      ctx.font = `bold ${px(9)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`NO SAFE ESCAPE IN ${Math.round(lab.advice.horizon)} s`, sx, sy + px(30));
    }
    const t = lab.tel;
    if (t.assist > 1) {
      // jet points opposite to the assist acceleration (exhaust), length by strength
      const al = t.assist;
      const jl = px(6 + 14 * Math.min(1, al / Math.max(1, lab.params.thrust * lab.params.assistMaxRatio)));
      ctx.globalAlpha = o.reducedMotion ? 0.7 : 0.55 + 0.35 * ((lab.tick % 4) / 3);
      ctx.strokeStyle = CYAN;
      ctx.lineWidth = px(2);
      ctx.beginPath();
      ctx.moveTo(sx - (t.ax / al) * px(12), sy - (t.ay / al) * px(12));
      ctx.lineTo(sx - (t.ax / al) * (px(12) + jl), sy - (t.ay / al) * (px(12) + jl));
      ctx.stroke();
    }
  }
  ctx.restore();
}
