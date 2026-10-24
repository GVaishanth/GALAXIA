/**
 * Combat P03C: Classic ordnance on the playfield (presentation only).
 *
 * Only drawn when a game is flown with a post-Wave-20 roster ship
 * (world.ordnance !== null); the legacy fighter's frames are untouched.
 *
 * - time zones: a faint blue disc with a broken rim, fading as the zone runs
 *   out (under the enemies, never over them);
 * - missiles: a short pixel body along the velocity with a flickering flame
 *   (heavy orange, lock-on cyan, nuke larger and white-hot);
 * - lock-on: corner brackets on the target that close in as the lock builds,
 *   with a progress bar under them (shape + motion, not colour alone);
 * - blasts: an expanding ring (and, for the nuke, a second shockwave ring and
 *   a soft core); no full-screen flash.
 *
 * Reduced motion: no flame flicker, rings are drawn without the second wave.
 */
import { COLORS } from '../config/palette.ts';
import { WEAPON_BY_ID } from '../config/weapons.ts';
import type { ClassicOrdnance, World } from '../core/game/types.ts';
import type { Viewport } from './viewport.ts';

const MISSILE_COLOR: Readonly<Record<string, string>> = { 'heavy-missile': COLORS['fx.orange'], 'lock-missile': COLORS['fx.cyan'], nuke: COLORS['fx.white'] };
const BLAST_COLOR: Readonly<Record<string, string>> = { 'heavy-missile': COLORS['fx.orange'], 'lock-missile': COLORS['fx.cyan'], nuke: COLORS['fx.yellow'] };

/** Lock-on acquisition time in Classic ms (catalogue ticks at 60 Hz). */
const LOCK_MS = (() => {
  const w = WEAPON_BY_ID.get('lock-missile');
  return w && w.fire === 'ordnance' && w.guidance.kind === 'lock' ? (w.guidance.acquire.lockTicks * 1000) / 60 : 300;
})();

const sx = (v: Viewport, x: number): number => v.offsetX + x * v.scale;
const sy = (v: Viewport, y: number): number => v.offsetY + y * v.scale;

/** Nuke time zones (drawn under the enemies). */
export function drawTimeZones(ctx: CanvasRenderingContext2D, v: Viewport, world: World, timeMs: number, motion: number): void {
  const o = world.ordnance;
  if (!o || o.zones.length === 0) return;
  const prev = ctx.globalAlpha;
  for (const z of o.zones) {
    const life = Math.max(0, Math.min(1, z.msLeft / z.durationMs));
    const fade = Math.min(1, life * 4); // last quarter fades out
    ctx.globalAlpha = prev * 0.14 * fade;
    ctx.fillStyle = COLORS['fx.blue'];
    ctx.beginPath();
    ctx.arc(sx(v, z.x), sy(v, z.y), z.r * v.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = prev * 0.55 * fade;
    ctx.strokeStyle = COLORS['fx.cyan'];
    ctx.lineWidth = Math.max(1, v.scale);
    const dash = Math.max(2, 6 * v.scale);
    ctx.setLineDash([dash, dash]);
    ctx.lineDashOffset = motion < 1 ? 0 : -(timeMs / 40) * v.scale;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }
  ctx.globalAlpha = prev;
}

function drawMissiles(ctx: CanvasRenderingContext2D, v: Viewport, o: ClassicOrdnance, k: number, timeMs: number, motion: number): void {
  const px = Math.max(1, v.scale);
  for (const m of o.missiles) {
    const x = m.prevX + (m.x - m.prevX) * k;
    const y = m.prevY + (m.y - m.prevY) * k;
    const a = Math.atan2(m.vy, m.vx) + Math.PI / 2; // 0 = nose up
    const big = m.weapon === 'nuke';
    const len = big ? 7 : 5;
    const wid = big ? 3 : 2;
    ctx.save();
    ctx.translate(Math.round(sx(v, x)), Math.round(sy(v, y)));
    ctx.rotate(a);
    // flame (behind the body)
    const flick = motion < 1 ? 1 : 1 + (Math.floor(timeMs / 50 + m.id) % 3);
    ctx.fillStyle = COLORS['fx.orange'];
    ctx.fillRect((-wid / 2) * px, (len / 2) * px, wid * px, flick * px);
    ctx.fillStyle = COLORS['fx.yellow'];
    ctx.fillRect((-wid / 2 + 0.5) * px, (len / 2) * px, (wid - 1) * px, px);
    // body + nose
    ctx.fillStyle = MISSILE_COLOR[m.weapon] ?? COLORS['fx.white'];
    ctx.fillRect((-wid / 2) * px, (-len / 2) * px, wid * px, len * px);
    ctx.fillStyle = COLORS['fx.white'];
    ctx.fillRect((-wid / 2) * px, (-len / 2) * px, wid * px, px);
    ctx.restore();
  }
}

function drawLock(ctx: CanvasRenderingContext2D, v: Viewport, world: World, o: ClassicOrdnance, lockMs: number): void {
  if (!o.lock) return;
  const t = world.enemies.find((e) => e.id === o.lock!.target);
  if (!t) return;
  const p = Math.max(0, Math.min(1, o.lock.ms / lockMs));
  const half = 9 + (1 - p) * 9; // brackets close in as the lock builds
  const arm = 4;
  const cx = sx(v, t.x);
  const cy = sy(v, t.y);
  const s = v.scale;
  ctx.strokeStyle = p >= 1 ? COLORS['fx.yellow'] : COLORS['fx.cyan'];
  ctx.lineWidth = Math.max(1, s);
  ctx.beginPath();
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const x0 = cx + dx * half * s;
    const y0 = cy + dy * half * s;
    ctx.moveTo(x0, y0 - dy * arm * s);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 - dx * arm * s, y0);
  }
  ctx.stroke();
  // progress bar under the brackets
  const bw = 18 * s;
  const by = cy + (half + 4) * s;
  ctx.fillStyle = 'rgba(99,234,255,0.25)';
  ctx.fillRect(cx - bw / 2, by, bw, Math.max(1, 2 * s));
  ctx.fillStyle = COLORS['fx.cyan'];
  ctx.fillRect(cx - bw / 2, by, bw * p, Math.max(1, 2 * s));
}

function drawBlasts(ctx: CanvasRenderingContext2D, v: Viewport, o: ClassicOrdnance, motion: number): void {
  const prev = ctx.globalAlpha;
  for (const b of o.blasts) {
    const t = Math.max(0, Math.min(1, b.ageMs / b.durationMs));
    const ease = 1 - (1 - t) * (1 - t);
    const color = BLAST_COLOR[b.weapon] ?? COLORS['fx.white'];
    const cx = sx(v, b.x);
    const cy = sy(v, b.y);
    if (b.weapon === 'nuke') {
      // soft core, bounded to the blast radius (never the whole screen)
      ctx.globalAlpha = prev * 0.22 * (1 - t);
      ctx.fillStyle = COLORS['fx.yellow'];
      ctx.beginPath();
      ctx.arc(cx, cy, b.r * ease * 0.6 * v.scale, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = prev * (1 - t);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, (b.weapon === 'nuke' ? 3 : 2) * v.scale * (1 - t * 0.5));
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, b.r * ease * v.scale), 0, Math.PI * 2);
    ctx.stroke();
    if (b.weapon === 'nuke' && motion >= 1 && t > 0.15) {
      // trailing shockwave
      const t2 = (t - 0.15) / 0.85;
      ctx.globalAlpha = prev * 0.6 * (1 - t2);
      ctx.strokeStyle = COLORS['fx.white'];
      ctx.lineWidth = Math.max(1, v.scale);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, b.r * (1 - (1 - t2) * (1 - t2)) * 0.8 * v.scale), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = prev;
}

/** Missiles, the lock-on brackets and blast rings (over the enemies, under the enemy shots). */
export function drawOrdnance(ctx: CanvasRenderingContext2D, v: Viewport, world: World, k: number, timeMs: number, motion: number): void {
  const o = world.ordnance;
  if (!o) return;
  drawBlasts(ctx, v, o, motion);
  drawMissiles(ctx, v, o, k, timeMs, motion);
  drawLock(ctx, v, world, o, LOCK_MS);
}
