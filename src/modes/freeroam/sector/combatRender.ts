/**
 * Combat rendering (Free Roam Prompt 9), called by render.ts inside its
 * layers. Draws a read-only SectorRun; owns no state.
 *
 * Readability rules (small mobile screens included):
 *  - factions are told apart by emblem shape (triangle / cross / chevron /
 *    diamond) and engine trail as well as hull colour;
 *  - every dangerous attack is telegraphed in world space before it lands,
 *    with lines at least 2 device px wide in the enemy-fire colours
 *    (vermilion / yellow), which no faction hull and no player element uses:
 *      aimed shots (cannon, flak, broadside)  a dashed aim line that thickens
 *      missile lock                           brackets closing on the pilot
 *      beam                                   a wedge that brightens, then the beam
 *      launch bay                             a growing glow at the bay
 *      mines                                  a ring that blinks faster to the blast
 *      eruptions                              a ring that fills to the blast
 *      warp-ins / ambush                      contracting rings with the emblem
 *  - with reduced motion, blinking becomes a steady fill that grows.
 *  - the pilot's missile (Combat P03) uses only player colours (ivory body,
 *    cyan trail; a thin cyan ring that tightens on the target while locking)
 *    and is drawn under ships and enemy fire, so it never hides a threat.
 * Threats off screen get edge markers; the DOM HUD repeats the urgent ones
 * as text (MISSILE LOCK, AMBUSH, encounter objectives).
 */
import { COLORS, type ColorRole } from '../../../config/palette.ts';
import { drawFrame } from '../../../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../../../render/sprite/spriteCache.ts';
import type { Viewport } from '../../../render/viewport.ts';
import { COMBAT } from '../combat/difficulty.ts';
import { siteOf } from '../combat/encounters.ts';
import { FACTIONS, type Emblem } from '../combat/factions.ts';
import { FAMILIES } from '../combat/families.ts';
import { eruptionAt, inInterference } from '../combat/hazards.ts';
import { MISSILE } from '../combat/playerMissile.ts';
import type { Agent } from '../combat/state.ts';
import { WEAPONS } from '../combat/weapons.ts';
import type { FactionId } from '../catalogue/types.ts';
import type { SectorRun } from './run.ts';

export interface CombatView {
  readonly toX: (x: number) => number;
  readonly toY: (y: number) => number;
  readonly zoom: number;
  readonly ratio: number;
  readonly W: number;
  readonly H: number;
  readonly v: Viewport;
  readonly visible: (x: number, y: number, r: number) => boolean;
  readonly alpha: number;
  readonly timeMs: number;
  readonly glow: boolean;
  readonly reducedMotion: boolean;
}

const FIRE = COLORS['shot.enemy.edge'];
const FIRE_CORE = COLORS['shot.enemy.core'];
const factionColor = (f: FactionId): string => COLORS[FACTIONS[f].color as ColorRole];

/** A faction emblem centred on (x, y), `s` device px across, filled with an outline. */
export function drawEmblem(ctx: CanvasRenderingContext2D, e: Emblem, x: number, y: number, s: number, fill: string, outline = '#05060c'): void {
  const h = s / 2;
  ctx.beginPath();
  switch (e) {
    case 'triangle':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y + h * 0.8);
      ctx.lineTo(x - h, y + h * 0.8);
      break;
    case 'cross': {
      const t = h * 0.42;
      ctx.moveTo(x - h, y - h + t);
      ctx.lineTo(x - h + t, y - h);
      ctx.lineTo(x, y - t);
      ctx.lineTo(x + h - t, y - h);
      ctx.lineTo(x + h, y - h + t);
      ctx.lineTo(x + t, y);
      ctx.lineTo(x + h, y + h - t);
      ctx.lineTo(x + h - t, y + h);
      ctx.lineTo(x, y + t);
      ctx.lineTo(x - h + t, y + h);
      ctx.lineTo(x - h, y + h - t);
      ctx.lineTo(x - t, y);
      break;
    }
    case 'chevron':
      ctx.moveTo(x - h, y - h * 0.2);
      ctx.lineTo(x, y - h);
      ctx.lineTo(x + h, y - h * 0.2);
      ctx.lineTo(x + h, y + h * 0.5);
      ctx.lineTo(x, y - h * 0.25);
      ctx.lineTo(x - h, y + h * 0.5);
      break;
    case 'diamond':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h * 0.75, y);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x - h * 0.75, y);
      break;
    case 'ring':
      ctx.arc(x, y, h, 0, Math.PI * 2);
      break;
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(1, s / 7);
  ctx.fill();
  ctx.stroke();
}

const blink = (v: CombatView, period: number): number => (v.reducedMotion ? 1 : Math.floor(v.timeMs / period) % 2 ? 0.35 : 1);

/* ---------------------------------------------------------- world layer */

/** Hazard zones, mines, warp-in markers, encounter markers and the cargo wreck (under the ships). */
export function drawCombatWorld(ctx: CanvasRenderingContext2D, run: SectorRun, V: CombatView): void {
  const { toX, toY, zoom, ratio } = V;
  const L = run.layout;
  const lw = (n: number): number => Math.max(1, Math.round(n * ratio));
  ctx.font = `${Math.round(10 * ratio)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const z of L.hazards) {
    if (!V.visible(z.x, z.y, z.r)) continue;
    const x = toX(z.x);
    const y = toY(z.y);
    const near = Math.hypot(run.ship.x - z.x, run.ship.y - z.y) < z.r + 700;
    if (z.kind === 'interference') {
      // jammed space: a grey-violet boundary and static pixels
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = '#a49ac8';
      ctx.lineWidth = lw(1.5);
      ctx.setLineDash([lw(2), lw(6)]);
      ctx.beginPath();
      ctx.arc(x, y, z.r * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const slot = V.reducedMotion ? 0 : Math.floor(V.timeMs / 140);
      ctx.fillStyle = '#c9c2e6';
      const s = Math.max(1, Math.round(2 * zoom));
      for (let i = 0; i < 26; i++) {
        const h = Math.sin((i + 1) * 91.7 + slot * 13.1) * 43758.5453;
        const f = h - Math.floor(h);
        const g = Math.sin((i + 1) * 17.3 + slot * 7.9) * 24634.6345;
        const r = Math.sqrt(g - Math.floor(g)) * z.r;
        ctx.fillRect(Math.round(x + Math.cos(f * 6.283) * r * zoom), Math.round(y + Math.sin(f * 6.283) * r * zoom), s, s);
      }
    } else {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = z.kind === 'minefield' ? FIRE : COLORS['fx.orange'];
      ctx.lineWidth = lw(1.5);
      ctx.setLineDash([lw(6), lw(6)]);
      ctx.beginPath();
      ctx.arc(x, y, z.r * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (near) {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = z.kind === 'interference' ? '#c9c2e6' : z.kind === 'minefield' ? FIRE : COLORS['fx.orange'];
      ctx.fillText(z.label.toUpperCase(), Math.round(x), Math.round(y - z.r * zoom - 14 * ratio));
    }
    ctx.globalAlpha = 1;
    if (z.kind === 'eruption') {
      const e = eruptionAt(z, run.tick);
      if (e.warn !== null) {
        // the blast point: an outline of the blast, filling until it goes off
        const ex = toX(e.x);
        const ey = toY(e.y);
        const r = COMBAT.eruptRadius * zoom;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = FIRE;
        ctx.lineWidth = lw(2);
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.25 + 0.35 * e.warn;
        ctx.fillStyle = FIRE_CORE;
        ctx.beginPath();
        ctx.arc(ex, ey, r * e.warn, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  /* mines: armed mines show their trigger ring; a triggered mine blinks faster to the blast */
  const W = WEAPONS.mine;
  for (const m of run.mines) {
    if (!V.visible(m.x, m.y, W.blast)) continue;
    const x = toX(m.x);
    const y = toY(m.y);
    const col = factionColor(m.faction);
    const s = Math.max(3, 5 * zoom);
    if (m.fuse >= 0) {
      const k = 1 - m.fuse / W.fuse;
      const on = V.reducedMotion ? 1 : Math.floor(V.timeMs / Math.max(40, 160 - 120 * k)) % 2;
      ctx.globalAlpha = on ? 0.95 : 0.4;
      ctx.strokeStyle = FIRE;
      ctx.lineWidth = lw(2);
      ctx.beginPath();
      ctx.arc(x, y, W.blast * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.2 + 0.3 * k;
      ctx.fillStyle = FIRE_CORE;
      ctx.beginPath();
      ctx.arc(x, y, W.blast * zoom * k, 0, Math.PI * 2);
      ctx.fill();
    } else if (m.arm === 0) {
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = col;
      ctx.lineWidth = lw(1);
      ctx.beginPath();
      ctx.arc(x, y, W.trigger * zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // the mine: a dark spiked disc with the layer's marking
    ctx.fillStyle = '#1a1b24';
    ctx.strokeStyle = col;
    ctx.lineWidth = lw(1.5);
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 ? s : s * 1.5;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = m.fuse >= 0 ? FIRE_CORE : m.arm > 0 ? '#555a6a' : col;
    ctx.fillRect(Math.round(x - s * 0.35), Math.round(y - s * 0.35), Math.max(1, Math.round(s * 0.7)), Math.max(1, Math.round(s * 0.7)));
  }

  /* warp-ins: contracting rings with the faction emblem */
  for (const p of run.pending) {
    if (!V.visible(p.x, p.y, 60)) continue;
    const k = Math.max(0, Math.min(1, 1 - (p.at - run.tick) / COMBAT.warpTicks));
    const x = toX(p.x);
    const y = toY(p.y);
    const col = factionColor(p.faction);
    ctx.strokeStyle = col;
    ctx.lineWidth = lw(2);
    for (let i = 0; i < 2; i++) {
      ctx.globalAlpha = 0.4 + 0.5 * k;
      ctx.beginPath();
      ctx.arc(x, y, (FAMILIES[p.family].radius + (1 - k) * (30 + i * 18)) * zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    drawEmblem(ctx, FACTIONS[p.faction].emblem, x, y, 9 * ratio, col);
  }

  /* encounter markers: wreck defence (hold ring + integrity), claims */
  for (const e of run.encounters) {
    const s = siteOf(L, e.id);
    if (!s || !V.visible(s.x, s.y, s.r * 2.4)) continue;
    const x = toX(s.x);
    const y = toY(s.y);
    if (s.kind === 'defence' && (e.state === 'dormant' || e.state === 'active')) {
      // distress beacon: pulsing rings; while active the hold zone and the time left as an arc
      const pulse = V.reducedMotion ? 0.5 : (V.timeMs % 1400) / 1400;
      ctx.strokeStyle = COLORS['fx.yellow'];
      ctx.lineWidth = lw(1.5);
      ctx.globalAlpha = 0.7 * (1 - pulse);
      ctx.beginPath();
      ctx.arc(x, y, (30 + pulse * 70) * zoom, 0, Math.PI * 2);
      ctx.stroke();
      if (e.state === 'active') {
        ctx.globalAlpha = 0.3;
        ctx.setLineDash([lw(4), lw(6)]);
        ctx.beginPath();
        ctx.arc(x, y, s.r * 2.4 * zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = lw(3);
        ctx.beginPath();
        ctx.arc(x, y, 40 * zoom, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - e.holdLeft / Math.max(1, s.holdTicks)));
        ctx.stroke();
        ctx.strokeStyle = e.integrity > 40 ? COLORS['player.trim'] : FIRE;
        ctx.beginPath();
        ctx.arc(x, y, 48 * zoom, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * e.integrity) / COMBAT.wreckIntegrity);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (s.kind === 'dispute' && e.awake && e.state !== 'done') {
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = factionColor('gleaners');
      ctx.lineWidth = lw(1.5);
      ctx.setLineDash([lw(3), lw(8)]);
      ctx.beginPath();
      ctx.arc(x, y, s.r * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  /* the cargo wreck: the pilot's own colours, pulsing, labelled */
  const w = run.cargoWreck;
  if (w && V.visible(w.x, w.y, 80)) {
    const x = toX(w.x);
    const y = toY(w.y);
    const s = 7 * zoom;
    const pulse = V.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(V.timeMs / 300);
    ctx.globalAlpha = 0.35 + 0.4 * pulse;
    ctx.strokeStyle = COLORS['player.trim'];
    ctx.lineWidth = lw(2);
    ctx.beginPath();
    ctx.arc(x, y, (COMBAT.wreckPickup + 4) * zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(0.4);
    ctx.fillStyle = COLORS['player.hull.shade'];
    ctx.fillRect(-s, -s * 0.8, s * 2, s * 1.6);
    ctx.fillStyle = COLORS['player.trim'];
    ctx.fillRect(-s, -s * 0.15, s * 2, s * 0.3);
    ctx.restore();
    ctx.fillStyle = COLORS['player.light'];
    ctx.fillText('YOUR CARGO', Math.round(x), Math.round(y + (COMBAT.wreckPickup + 8) * zoom));
  }
}

/* ---------------------------------------------------------- ships layer */

function trail(ctx: CanvasRenderingContext2D, a: Agent, x: number, y: number, V: CombatView): void {
  const sp = Math.hypot(a.vx, a.vy);
  if (sp < 30 || a.state === 'disabled') return;
  const style = FACTIONS[a.faction].trail;
  const ux = -a.vx / sp;
  const uy = -a.vy / sp;
  const r = FAMILIES[a.family].radius;
  const len = Math.min(1, sp / FAMILIES[a.family].speed) * (14 + r);
  const { toX, toY, zoom } = V;
  const bx = x + ux * r * 0.9;
  const by = y + uy * r * 0.9;
  const col = COLORS[(a.faction === 'gleaners' ? 'gleaner' : a.faction === 'red-tally' ? 'tally' : a.faction === 'cordon' ? 'cordon' : 'tess') + '.engine' as ColorRole];
  ctx.globalAlpha = 0.55;
  if (style === 'streak') {
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, 2.5 * zoom);
    ctx.beginPath();
    ctx.moveTo(toX(bx), toY(by));
    ctx.lineTo(toX(bx + ux * len * 1.4), toY(by + uy * len * 1.4));
    ctx.stroke();
  } else if (style === 'twin') {
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, 1.5 * zoom);
    for (const o of [-0.35, 0.35]) {
      const ox = -uy * r * o;
      const oy = ux * r * o;
      ctx.beginPath();
      ctx.moveTo(toX(bx + ox), toY(by + oy));
      ctx.lineTo(toX(bx + ox + ux * len), toY(by + oy + uy * len));
      ctx.stroke();
    }
  } else if (style === 'motes') {
    ctx.fillStyle = col;
    const s = Math.max(1, Math.round(2.5 * zoom));
    const ph = V.reducedMotion ? 0 : (V.timeMs / 90) % 1;
    for (let i = 0; i < 3; i++) {
      const d = (i + ph) * len * 0.4;
      ctx.fillRect(Math.round(toX(bx + ux * d) - s / 2), Math.round(toY(by + uy * d) - s / 2), s, s);
    }
  } else if (style === 'sputter') {
    const slot = V.reducedMotion ? 0 : Math.floor(V.timeMs / 120);
    for (let i = 0; i < 3; i++) {
      const h = Math.sin((a.id * 7 + i * 3.1 + slot) * 12.9898) * 43758.5453;
      if (h - Math.floor(h) > 0.6) continue;
      const d = (i + 0.5) * len * 0.45;
      ctx.fillStyle = i === 0 ? col : '#8a8578';
      const s = Math.max(1, (2 + i) * zoom);
      ctx.beginPath();
      ctx.arc(toX(bx + ux * d), toY(by + uy * d), s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** Enemy ships (faction look, damage states, emblems, bars), their telegraphs, beams and projectiles. */
export function drawCombatShips(ctx: CanvasRenderingContext2D, sprites: SpriteCache, run: SectorRun, V: CombatView): void {
  const { toX, toY, zoom, ratio } = V;
  const k = V.alpha;
  const lw = (n: number): number => Math.max(1, Math.round(n * ratio));

  /* telegraphs first, under the ships */
  for (const a of run.hostiles) {
    const x = a.px + (a.x - a.px) * k;
    const y = a.py + (a.y - a.py) * k;
    const wd = a.windup;
    if (wd && V.visible(x, y, WEAPONS[wd.weapon].range)) {
      const w = WEAPONS[wd.weapon];
      const p = 1 - wd.ticks / wd.total;
      if (w.telegraph === 'aim') {
        const lines = w.pellets > 1 ? [-w.spread / 2, 0, w.spread / 2] : [0];
        ctx.strokeStyle = FIRE;
        ctx.globalAlpha = 0.45 + 0.5 * p;
        ctx.lineWidth = lw(2 + 2 * p);
        ctx.setLineDash([lw(8), lw(6)]);
        for (const o of lines) {
          ctx.beginPath();
          ctx.moveTo(toX(x), toY(y));
          ctx.lineTo(toX(x + Math.cos(wd.angle + o) * w.range), toY(y + Math.sin(wd.angle + o) * w.range));
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      } else if (w.telegraph === 'band') {
        ctx.fillStyle = FIRE;
        ctx.globalAlpha = 0.1 + 0.3 * p * blink(V, 120);
        ctx.beginPath();
        ctx.moveTo(toX(x), toY(y));
        ctx.arc(toX(x), toY(y), w.length * zoom, wd.angle - w.sweep / 2 - 0.05, wd.angle + w.sweep / 2 + 0.05);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = FIRE;
        ctx.lineWidth = lw(2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (w.telegraph === 'bay') {
        const bx = x - Math.sin(a.heading) * 30;
        const by = y + Math.cos(a.heading) * 30;
        ctx.globalAlpha = 0.5 + 0.4 * p;
        ctx.fillStyle = factionColor(a.faction);
        ctx.beginPath();
        ctx.arc(toX(bx), toY(by), (4 + 10 * p) * zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (w.telegraph === 'lock' && a.target === 'player') {
        // brackets closing on the pilot
        const sx = run.ship.px + (run.ship.x - run.ship.px) * k;
        const sy = run.ship.py + (run.ship.y - run.ship.py) * k;
        const r = (run.tune.radius + 22 - 12 * p) * zoom;
        const c = r * 0.45;
        ctx.strokeStyle = blink(V, 90) > 0.5 ? FIRE_CORE : FIRE;
        ctx.lineWidth = lw(2.5);
        const X = toX(sx);
        const Y = toY(sy);
        ctx.beginPath();
        for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          ctx.moveTo(X + dx * r, Y + dy * (r - c));
          ctx.lineTo(X + dx * r, Y + dy * r);
          ctx.lineTo(X + dx * (r - c), Y + dy * r);
        }
        ctx.stroke();
        // and a thin line back to the shooter
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = lw(1);
        ctx.setLineDash([lw(3), lw(5)]);
        ctx.beginPath();
        ctx.moveTo(toX(x), toY(y));
        ctx.lineTo(X, Y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }
    if (a.beam) {
      const b = a.beam;
      const ex = x + Math.cos(b.angle) * WEAPONS.beam.length;
      const ey = y + Math.sin(b.angle) * WEAPONS.beam.length;
      ctx.lineCap = 'round';
      ctx.strokeStyle = FIRE;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = Math.max(lw(3), WEAPONS.beam.width * 2 * zoom);
      ctx.beginPath();
      ctx.moveTo(toX(x), toY(y));
      ctx.lineTo(toX(ex), toY(ey));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = FIRE_CORE;
      ctx.lineWidth = Math.max(lw(1.5), WEAPONS.beam.width * 0.8 * zoom);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }

  /* ships */
  for (const a of run.hostiles) {
    const F = FAMILIES[a.family];
    const x = a.px + (a.x - a.px) * k;
    const y = a.py + (a.y - a.py) * k;
    if (!V.visible(x, y, F.radius * 3 + 30)) continue;
    const fac = FACTIONS[a.faction];
    const worn = a.hull < a.maxHull * F.wornAt;
    trail(ctx, a, x, y, V);
    const state = a.state === 'disabled' ? 'drift' : 'fly';
    const fi = state === 'drift' || V.reducedMotion ? 0 : Math.floor(V.timeMs / 90 + a.id) % 2;
    const heading = a.pheading + Math.atan2(Math.sin(a.heading - a.pheading), Math.cos(a.heading - a.pheading)) * k;
    drawFrame(ctx, sprites, sprites.frame(F.sprite, state, fi, worn ? fac.worn : (fac.variant ?? undefined)), V.v, x, y, { rotation: heading, glow: V.glow });
    ctx.globalAlpha = 1;
    const X = toX(x);
    const Y = toY(y);
    if (a.flash > 0) {
      // struck: shield flare (faction mark colour) or hull hit (white ring)
      ctx.globalAlpha = Math.min(1, a.flash / 6);
      ctx.strokeStyle = a.shield > 0 ? factionColor(a.faction) : COLORS['fx.white'];
      ctx.lineWidth = lw(2);
      ctx.beginPath();
      ctx.arc(X, Y, (F.radius + 4) * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if ((worn || a.state === 'disabled') && !V.reducedMotion) {
      const slot = Math.floor(V.timeMs / 110);
      for (let i = 0; i < 2; i++) {
        const h = Math.sin((slot + i * 7.3 + a.id * 3.7) * 12.9898) * 43758.5453;
        const f = h - Math.floor(h);
        if (f > 0.6) continue;
        const ang = f * 11.4;
        const d = F.radius * (0.2 + 0.6 * ((f * 7) % 1));
        const s = Math.max(1, Math.round(1.5 * zoom));
        ctx.fillStyle = i ? COLORS['fx.yellow'] : COLORS['fx.white'];
        ctx.fillRect(Math.round(toX(x + Math.cos(ang) * d) - s / 2), Math.round(toY(y + Math.sin(ang) * d) - s / 2), s, s);
      }
    }
    // emblem + bars (screen-sized so they stay legible when zoomed out)
    const top = Y - (F.radius + 6) * zoom;
    drawEmblem(ctx, fac.emblem, X, top - 5 * ratio, 8 * ratio, factionColor(a.faction));
    const boss = a.role === 'boss';
    if (boss || a.hull < a.maxHull || a.shield < a.maxShield) {
      const bw = Math.max(18 * ratio, F.radius * 2 * zoom);
      const bh = Math.max(2, Math.round(2.5 * ratio));
      const bx = Math.round(X - bw / 2);
      const by = Math.round(Y + (F.radius + 6) * zoom);
      ctx.fillStyle = '#05060c';
      ctx.fillRect(bx - 1, by - 1, Math.round(bw) + 2, bh * (a.maxShield > 0 ? 2 : 1) + 3);
      ctx.fillStyle = factionColor(a.faction);
      ctx.fillRect(bx, by, Math.round((bw * a.hull) / a.maxHull), bh);
      if (a.maxShield > 0) {
        ctx.fillStyle = '#e8ecff';
        ctx.fillRect(bx, by + bh + 1, Math.round((bw * a.shield) / a.maxShield), bh);
      }
    }
    if (a.state === 'disabled') {
      ctx.font = `${Math.round(9 * ratio)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = COLORS['ui.text.dim'];
      ctx.fillText('DISABLED', Math.round(X), Math.round(Y + (F.radius + 14) * zoom));
    }
  }

  /* enemy projectiles */
  ctx.lineCap = 'round';
  for (const s of run.enemyShots) {
    const x = s.px + (s.x - s.px) * k;
    const y = s.py + (s.y - s.py) * k;
    if (!V.visible(x, y, 24)) continue;
    const sp = Math.hypot(s.vx, s.vy) || 1;
    const X = toX(x);
    const Y = toY(y);
    if (s.kind === 'bolt') {
      ctx.strokeStyle = FIRE;
      ctx.lineWidth = Math.max(lw(2), 4 * zoom);
      ctx.beginPath();
      ctx.moveTo(toX(x - (s.vx / sp) * 9), toY(y - (s.vy / sp) * 9));
      ctx.lineTo(X, Y);
      ctx.stroke();
      ctx.strokeStyle = FIRE_CORE;
      ctx.lineWidth = Math.max(1, 1.8 * zoom);
      ctx.stroke();
    } else if (s.kind === 'shell') {
      ctx.fillStyle = COLORS['shot.enemy.dark'];
      ctx.beginPath();
      ctx.arc(X, Y, (s.radius + 1.5) * zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = FIRE;
      ctx.beginPath();
      ctx.arc(X, Y, s.radius * zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = FIRE_CORE;
      ctx.beginPath();
      ctx.arc(X, Y, s.radius * 0.45 * zoom, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // missile: a body with an exhaust trail (shootable)
      const ux = s.vx / sp;
      const uy = s.vy / sp;
      ctx.strokeStyle = '#8a8578';
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = Math.max(1, 3 * zoom);
      ctx.beginPath();
      ctx.moveTo(X, Y);
      ctx.lineTo(toX(x - ux * 22), toY(y - uy * 22));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = COLORS['shot.enemy.dark'];
      ctx.lineWidth = Math.max(lw(2), 5 * zoom);
      ctx.beginPath();
      ctx.moveTo(toX(x - ux * 6), toY(y - uy * 6));
      ctx.lineTo(toX(x + ux * 4), toY(y + uy * 4));
      ctx.stroke();
      ctx.fillStyle = FIRE_CORE;
      ctx.beginPath();
      ctx.arc(toX(x + ux * 4), toY(y + uy * 4), Math.max(1.5, 2 * zoom), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.lineCap = 'butt';
}

/* ------------------------------------------------------- pilot missile */

/** The lock ring on the target being acquired, then every missile in flight (Combat P03). Drawn before the ships. */
export function drawPlayerMissiles(ctx: CanvasRenderingContext2D, run: SectorRun, V: CombatView): void {
  const { toX, toY, zoom, ratio, visible, alpha: k } = V;
  const lw = (n: number): number => Math.max(1, Math.round(n * ratio));
  const sk = run.missile;
  if (sk.state === 'acquiring' && sk.target !== null) {
    const a = run.hostiles.find((h) => h.id === sk.target && h.state !== 'destroyed');
    if (a) {
      const x = a.px + (a.x - a.px) * k;
      const y = a.py + (a.y - a.py) * k;
      if (visible(x, y, 60)) {
        const p = Math.min(1, sk.lock / MISSILE.lockTicks);
        const r = (FAMILIES[a.family].radius + 18 - 8 * p) * zoom;
        const X = toX(x);
        const Y = toY(y);
        ctx.strokeStyle = COLORS['player.trim'];
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = lw(1.5);
        // a ring broken at the four quarters, closing as the lock completes
        const gap = 0.35 - 0.25 * p;
        ctx.beginPath();
        for (let q = 0; q < 4; q++) {
          const a0 = (q * Math.PI) / 2 + gap;
          const a1 = ((q + 1) * Math.PI) / 2 - gap;
          ctx.moveTo(X + Math.cos(a0) * r, Y + Math.sin(a0) * r);
          ctx.arc(X, Y, r, a0, a1);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }
  if (run.missiles.length === 0) return;
  ctx.lineCap = 'round';
  for (const m of run.missiles) {
    const x = m.px + (m.x - m.px) * k;
    const y = m.py + (m.y - m.py) * k;
    if (!visible(x, y, 30)) continue;
    const sp = Math.hypot(m.vx, m.vy) || 1;
    const ux = m.vx / sp;
    const uy = m.vy / sp;
    // trail (cyan, faint), body (ivory), seeker tip (cyan-white)
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = COLORS['shot.player.edge'];
    ctx.lineWidth = Math.max(lw(1.5), 2.5 * zoom);
    ctx.beginPath();
    ctx.moveTo(toX(x - ux * 6), toY(y - uy * 6));
    ctx.lineTo(toX(x - ux * 24), toY(y - uy * 24));
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS['player.hull.light'];
    ctx.lineWidth = Math.max(lw(2), 4 * zoom);
    ctx.beginPath();
    ctx.moveTo(toX(x - ux * 6), toY(y - uy * 6));
    ctx.lineTo(toX(x + ux * 4), toY(y + uy * 4));
    ctx.stroke();
    ctx.fillStyle = COLORS['shot.player.core'];
    ctx.beginPath();
    ctx.arc(toX(x + ux * 5), toY(y + uy * 5), Math.max(1.5, 1.8 * zoom), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'butt';
}

/* ------------------------------------------------------------- UI layer */

/** Edge markers for off-screen ships hunting the pilot (brighter when they are winding up an attack) and incoming warp-ins. */
export function drawThreatMarkers(ctx: CanvasRenderingContext2D, run: SectorRun, V: CombatView): void {
  const { toX, toY, W, H, ratio } = V;
  if (inInterference(run.layout, run.ship)) return; // jammed: no contacts
  const inset = 18 * ratio;
  const mark = (wx: number, wy: number, faction: FactionId, urgent: boolean): void => {
    const x = toX(wx);
    const y = toY(wy);
    if (x >= 0 && y >= 0 && x <= W && y <= H) return;
    const ang = Math.atan2(y - H / 2, x - W / 2);
    const ex = Math.max(inset, Math.min(W - inset, W / 2 + Math.cos(ang) * W));
    const ey = Math.max(inset, Math.min(H - inset, H / 2 + Math.sin(ang) * H));
    const s = (urgent ? 9 : 7) * ratio;
    ctx.save();
    ctx.translate(Math.round(ex), Math.round(ey));
    ctx.rotate(ang);
    ctx.globalAlpha = urgent ? blink(V, 140) : 0.85;
    ctx.fillStyle = urgent ? FIRE : factionColor(faction);
    ctx.strokeStyle = '#05060c';
    ctx.lineWidth = Math.max(1, ratio);
    ctx.beginPath();
    ctx.moveTo(s, 0);
    ctx.lineTo(-s * 0.6, -s * 0.7);
    ctx.lineTo(-s * 0.6, s * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
    drawEmblem(ctx, FACTIONS[faction].emblem, Math.round(ex - Math.cos(ang) * s * 1.8), Math.round(ey - Math.sin(ang) * s * 1.8), 7 * ratio, factionColor(faction));
  };
  for (const a of run.hostiles) {
    if (a.target !== 'player' || a.state === 'destroyed') continue;
    if (Math.hypot(a.x - run.ship.x, a.y - run.ship.y) > COMBAT.wakeRadius) continue;
    mark(a.x, a.y, a.faction, a.windup !== null || a.beam !== null);
  }
  for (const p of run.pending) mark(p.x, p.y, p.faction, true);
}

/** Sector map additions: hazards, active encounters, contacts by emblem (not inside interference), the cargo wreck. */
export function drawCombatMap(ctx: CanvasRenderingContext2D, run: SectorRun, X: (x: number) => number, Y: (y: number) => number, scale: number, ratio: number): void {
  const L = run.layout;
  ctx.lineWidth = Math.max(1, Math.round(ratio));
  for (const z of L.hazards) {
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = z.kind === 'interference' ? '#a49ac8' : z.kind === 'minefield' ? FIRE : COLORS['fx.orange'];
    ctx.setLineDash([3 * ratio, 3 * ratio]);
    ctx.beginPath();
    ctx.arc(X(z.x), Y(z.y), Math.max(4 * ratio, z.r * scale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
  for (const e of run.encounters) {
    if (e.state !== 'active' && e.state !== 'warning') continue;
    const s = siteOf(L, e.id);
    const p = s ?? L.pois.find((q) => q.id === e.id);
    if (!p) continue;
    ctx.strokeStyle = FIRE;
    ctx.lineWidth = Math.max(1, Math.round(1.5 * ratio));
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), 7 * ratio, 0, Math.PI * 2);
    ctx.stroke();
  }
  const sh = run.ship;
  const jammed = inInterference(L, sh);
  for (const a of run.hostiles) {
    if (jammed || inInterference(L, a) || Math.hypot(a.x - sh.x, a.y - sh.y) > run.craft.stats.sensor) continue;
    drawEmblem(ctx, FACTIONS[a.faction].emblem, X(a.x), Y(a.y), (a.role === 'boss' ? 9 : 6) * ratio, factionColor(a.faction));
  }
  const w = run.cargoWreck;
  if (w) {
    ctx.fillStyle = COLORS['player.trim'];
    ctx.fillRect(Math.round(X(w.x) - 3 * ratio), Math.round(Y(w.y) - 3 * ratio), Math.round(6 * ratio), Math.round(6 * ratio));
    ctx.font = `${Math.round(9 * ratio)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('CARGO', X(w.x), Y(w.y) + 5 * ratio);
  }
}
