/**
 * Collection rendering (Free Roam Prompt 10): marked ore veins, floating
 * pickups (salvage pods, ore fragments, reward caches, jettisoned cargo), the
 * full-hold marker, and their sector-map markers. Presentation only: reads
 * the run, never writes it.
 *
 * Readability: every pickup shows its item icon (the most valuable resource
 * inside) on a dark plate with a coloured ring by kind, so it is told apart by
 * shape and ring style, not colour alone (pods: solid ring, ore: dotted,
 * caches: double, jettisoned cargo: dashed). Salvage pods blink in their last
 * seconds (steady and dimmed with reduced motion). Markers stay small so
 * they never hide incoming fire.
 */
import { COLORS } from '../../../config/palette.ts';
import { lootIconKey, iconCanvas } from '../inventory/ui/iconImages.ts';
import { KILL_DROPS } from '../inventory/lootTables.ts';
import type { CombatView } from './combatRender.ts';
import { chipsLeft, type Pickup, type PickupKind, type SectorRun } from './run.ts';
import { signalPoint } from './signal.ts';

const RING: Readonly<Record<PickupKind, string>> = { pod: '#ffb347', ore: '#7fe3ff', cache: '#ffd34d', jettison: '#b7c0cc' };
const DASH: Readonly<Record<PickupKind, readonly number[]>> = { pod: [], ore: [1, 3], cache: [], jettison: [4, 3] };
const VEIN = '#7fe3ff';
const VEIN_SPENT = '#4a5068';
const OFFER = COLORS['fx.yellow'];

/** Veins, pickups and the full-hold marker (world layer, under the ships). */
export function drawLootWorld(ctx: CanvasRenderingContext2D, run: SectorRun, V: CombatView): void {
  const { toX, toY, zoom, ratio } = V;
  const px = (n: number): number => Math.max(1, Math.round(n * zoom));
  const L = run.layout;
  const t = V.reducedMotion ? 0 : V.timeMs;

  // marked ore veins: bright seams on the rock while chips remain, dull scars once depleted
  for (const v of L.veins) {
    if (!V.visible(v.x, v.y, v.r + 20)) continue;
    const left = chipsLeft(run, v);
    const col = left > 0 ? VEIN : VEIN_SPENT;
    ctx.strokeStyle = col;
    ctx.lineWidth = px(2);
    ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      const a = v.angle + i * 0.5;
      const r0 = v.r * 0.45;
      const r1 = v.r * (i === 0 ? 0.95 : 0.8);
      ctx.beginPath();
      ctx.moveTo(toX(v.x + Math.cos(a) * r0), toY(v.y + Math.sin(a) * r0));
      ctx.lineTo(toX(v.x + Math.cos(a) * r1), toY(v.y + Math.sin(a) * r1));
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
    if (left > 0) {
      // a dotted survey ring marks a vein worth shooting
      ctx.globalAlpha = 0.35 + (V.reducedMotion ? 0.15 : 0.15 * Math.sin(t / 300));
      ctx.setLineDash([px(2), px(5)]);
      ctx.lineWidth = px(1);
      ctx.beginPath();
      ctx.arc(toX(v.x), toY(v.y), (v.r + 9) * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  // floating pickups
  const scale = Math.max(1, Math.round(zoom * 1.5 * Math.max(1, ratio / 1.5)));
  ctx.imageSmoothingEnabled = false;
  for (const p of run.pickups) {
    if (!V.visible(p.x, p.y, 30)) continue;
    drawPickup(ctx, p, toX(p.x), toY(p.y), scale, zoom, t, V.reducedMotion);
  }

  // the find the full-hold choice is about
  const o = run.offer;
  if (o && V.visible(o.x, o.y, 60)) {
    ctx.strokeStyle = OFFER;
    ctx.lineWidth = px(1.5);
    ctx.setLineDash([px(5), px(4)]);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(toX(o.x), toY(o.y), 30 * zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = `${Math.round(10 * ratio)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = OFFER;
    ctx.fillText('HOLD FULL', toX(o.x), toY(o.y) - 32 * zoom);
  }
}

function drawPickup(ctx: CanvasRenderingContext2D, p: Pickup, x: number, y: number, scale: number, zoom: number, t: number, reduced: boolean): void {
  const blinking = Number.isFinite(p.life) && p.life < KILL_DROPS.blinkTicks;
  let alpha = p.armed ? 1 : 0.55;
  if (blinking) alpha *= reduced ? 0.6 : Math.floor(t / 220) % 2 === 0 ? 1 : 0.35;
  const icon = iconCanvas(lootIconKey(p.loot), scale);
  const size = icon ? icon.width : 12 * scale;
  const r = size * 0.62 + 3;
  ctx.globalAlpha = alpha;
  // dark plate keeps the icon readable over bright nebulae and bodies
  ctx.fillStyle = 'rgba(6, 7, 15, 0.75)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = RING[p.kind];
  ctx.lineWidth = Math.max(1, Math.round(zoom * 1.5));
  ctx.setLineDash(DASH[p.kind].map((d) => d * Math.max(1, zoom * 1.5)));
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  if (p.kind === 'cache') {
    ctx.beginPath();
    ctx.arc(x, y, r + Math.max(2, zoom * 3), 0, Math.PI * 2);
    ctx.stroke();
  }
  if (icon) ctx.drawImage(icon, Math.round(x - size / 2), Math.round(y - size / 2));
  ctx.globalAlpha = 1;
}

/** Sector map markers: pickups and finds partly left behind. */
export function drawLootMap(ctx: CanvasRenderingContext2D, run: SectorRun, X: (x: number) => number, Y: (y: number) => number, ratio: number): void {
  const L = run.layout;
  ctx.lineWidth = Math.max(1, Math.round(ratio));
  // a container or reward with loot left in it: an open square around it
  for (const [id] of run.left) {
    const poi = L.pois.find((p) => p.id === id);
    const at = poi ? signalPoint(run, poi) : run.pickups.find((p) => p.id === id); // P06.1: an anomaly opened at its fix
    if (!at) continue;
    const s = 6 * ratio;
    ctx.strokeStyle = OFFER;
    ctx.strokeRect(Math.round(X(at.x) - s), Math.round(Y(at.y) - s), Math.round(s * 2), Math.round(s * 2));
  }
  for (const p of run.pickups) {
    ctx.fillStyle = RING[p.kind];
    const s = (p.kind === 'cache' ? 3.5 : 2.5) * ratio;
    ctx.beginPath();
    ctx.moveTo(X(p.x), Y(p.y) - s);
    ctx.lineTo(X(p.x) + s, Y(p.y));
    ctx.lineTo(X(p.x), Y(p.y) + s);
    ctx.lineTo(X(p.x) - s, Y(p.y));
    ctx.closePath();
    ctx.fill();
  }
  for (const v of L.veins) {
    // veins show once surveyed, or while within sensor range
    if (chipsLeft(run, v) === 0 || (!run.surveyed && Math.hypot(v.x - run.ship.x, v.y - run.ship.y) > run.craft.stats.sensor)) continue;
    ctx.strokeStyle = VEIN;
    ctx.beginPath();
    ctx.arc(X(v.x), Y(v.y), 3 * ratio, 0, Math.PI * 2);
    ctx.stroke();
  }
}
