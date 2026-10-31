/**
 * TOWING (P10.1, docs/freeroam/SHIP_EXPANSION.md): one disabled hull per run
 * on a deterministic spring tether. Pure and tick-based (fixed 60 Hz steps, no
 * clock, no randomness, no DOM); nothing here is saved.
 *
 * The hull (`run.hulk`) exists only while its ship is still unrecovered
 * (RunOptions.salvage) and its Raid Box is open. It rests at the authored
 * point from ShipDef.salvage; a hull moved during a visit stays where it was
 * left until the sector is entered again.
 *
 * Tether: a rope-like spring between the two centres. Below `rest` it is
 * slack; beyond it pulls the hull toward the ship with stiffness x stretch
 * plus damping x closing speed (the force never pushes, so the hull cannot be
 * shoved). Stiffness 20 / s^2 and damping 9 / s are critically damped
 * (9 ~= 2 * sqrt(20)), so the hull settles behind the ship without
 * oscillating; semi-implicit Euler at 1/60 s is far inside its stability
 * limit. The ship feels the load as a flat penalty on its thrust and top speed
 * (no reaction force: the result never depends on frame rate or input timing).
 *
 * The tether snaps beyond `maxLength` (the hull caught on a body while the
 * ship pulls on) and is released after `blockTicks` with a celestial body on
 * the line (the same occlusion test as Gravity Shadow). The hull collides with
 * stars, planets, rocks and solid POIs like an enemy hull; it is not solid to
 * the ship and shots pass through it.
 */
import { live } from '../combat/shipAbilities.ts';
import { bodyBetween } from '../combat/stealth.ts';
import { pushOutOfSolids } from '../combat/world.ts';
import { TICK_SECONDS } from '../sim.ts';
import { SHIP_BY_ID } from '../ships/roster.ts';
import type { ShipDef, ShipId } from '../ships/types.ts';
import type { SectorEvent, SectorRun } from './run.ts';

/** Tuning (art px, seconds, 60 Hz ticks). Documented in SHIP_EXPANSION.md "Towing". */
export const TOW = Object.freeze({
  /** Attach: centre distance at most reach + both radii. */
  reach: 90,
  /** Attach: the ship's speed relative to the hull at most this (px/s). */
  attachSpeed: 140,
  /** Tether slack length, centre to centre. */
  rest: 120,
  /** The tether snaps beyond this length (Winch Lock: x its tetherMul). */
  maxLength: 260,
  stiffness: 20,
  damping: 9,
  /** Hull drag (1/s), towed or drifting. */
  drag: 0.8,
  /** A celestial body on the line this long releases the tow. */
  blockTicks: 30,
  /** Penalty on thrust and top speed while towing (a tow rig cancels its share; Winch Lock all of it). */
  accelMul: 0.55,
  speedMul: 0.7,
  /** The hull turns its nose toward the ship at this rate while towed (rad/s). */
  turnRate: 1.5,
  /** P10.2: the line is strained beyond this share of the snap length (one warning)... */
  strainAt: 0.8,
  /** ...and the warning re-arms only once the line is back under this share (no flicker on the boundary). */
  strainClear: 0.65,
});

/** The resting heading of a disabled hull (rad): fixed, so its pose is the same on every visit. */
const REST_HEADING = 2.4;

export interface Hulk {
  readonly ship: ShipId;
  readonly r: number;
  /** The ship's sprite id (the renderer draws it dimmed and scorched). */
  readonly sprite: ShipDef['sprite'];
  x: number;
  y: number;
  /** Previous-tick position, for render interpolation. */
  px: number;
  py: number;
  vx: number;
  vy: number;
  heading: number;
  towed: boolean;
  /** Ticks the tether has been blocked by a celestial body (0 = clear). */
  blocked: number;
  /** P10.2: the strain warning was given for this stretch (cleared under TOW.strainClear); a notice latch, not tow state. */
  strained: boolean;
  /** P10.2: towRefusal at the end of the last flight tick while resting (the prompt reads it; it never runs the check itself). */
  attach: TowRefusal | null;
}

export type TowChange = 'attached' | 'released' | 'snapped' | 'blocked' | 'lost' | 'refused' | 'strained';
/** Why TOW HULL did nothing (no state changed). */
export type TowRefusal = 'range' | 'speed' | 'blocked' | 'state';
/** P10.2: what took a running tow away with 'lost' (the message names it; the hull stays where it was). */
export type TowLoss = 'wreck' | 'restart';

/** The disabled hull of `ship` at its authored rest point; null for a ship that is not a recovery hull. */
export function spawnHulk(ship: ShipId): Hulk | null {
  const d = SHIP_BY_ID.get(ship);
  if (!d?.salvage) return null;
  const [x, y] = d.salvage.hull;
  return { ship, r: d.radius, sprite: d.sprite, x, y, px: x, py: y, vx: 0, vy: 0, heading: REST_HEADING, towed: false, blocked: 0, strained: false, attach: 'range' };
}

const gap = (run: SectorRun, h: Hulk): number => Math.hypot(run.ship.x - h.x, run.ship.y - h.y);

/** The tether length at which the tow snaps now (Winch Lock lengthens it). */
export const towMax = (run: SectorRun): number => TOW.maxLength * (live(run, 'winch-lock')?.tetherMul ?? 1);

/** Thrust and top-speed multipliers from the tow (1 / 1 when nothing is towed). */
export function towPenalty(run: SectorRun): { readonly accel: number; readonly speed: number } {
  if (!run.hulk?.towed || live(run, 'winch-lock')) return { accel: 1, speed: 1 };
  const keep = 1 - Math.min(1, Math.max(0, SHIP_BY_ID.get(run.craft.ship)?.towRig ?? 0));
  return { accel: 1 - (1 - TOW.accelMul) * keep, speed: 1 - (1 - TOW.speedMul) * keep };
}

/** Is the resting hull within reach for TOW HULL (the prompt), or is a tow running (RELEASE TOW)? */
export function hulkFocus(run: SectorRun): boolean {
  const h = run.hulk;
  return !!h && (h.towed || gap(run, h) <= TOW.reach + h.r + run.tune.radius);
}

/** End a running tow (the hull stays where it is). Winch Lock ends with it; its cooldown is kept. */
export function endTow(run: SectorRun, change: Exclude<TowChange, 'attached' | 'refused' | 'strained'>, events: SectorEvent[] | null, cause?: TowLoss): void {
  const h = run.hulk;
  if (!h?.towed) return;
  h.towed = false;
  h.blocked = 0;
  h.strained = false;
  if (live(run, 'winch-lock')) {
    run.ability.active = 0;
    events?.push({ type: 'ability', id: 'winch-lock', change: 'end' });
  }
  events?.push(cause ? { type: 'tow', change, ship: h.ship, cause } : { type: 'tow', change, ship: h.ship });
}

/**
 * P10.2: why TOW HULL would be refused right now (null: it would attach). The one attach check:
 * toggleTow acts on it and the HUD prompt only reads it, so the prompt can never promise more than the press does.
 */
export function towRefusal(run: SectorRun): TowRefusal | null {
  const h = run.hulk;
  if (!h || h.towed || run.phase !== 'flight' || run.disposed || run.docked) return 'state';
  const sh = run.ship;
  return gap(run, h) > TOW.reach + h.r + run.tune.radius ? 'range'
    : Math.hypot(sh.vx - h.vx, sh.vy - h.vy) > TOW.attachSpeed ? 'speed'
    : bodyBetween(run.layout.landmarks, sh.x, sh.y, h.x, h.y) ? 'blocked'
    : null;
}

/** TOW HULL / RELEASE TOW (the INTERACT press on the hull). A refusal changes nothing. */
export function toggleTow(run: SectorRun): SectorEvent[] {
  const h = run.hulk;
  if (!h || run.phase !== 'flight' || run.disposed || run.docked) return [];
  const events: SectorEvent[] = [];
  if (h.towed) {
    endTow(run, 'released', events);
    return events;
  }
  const why = towRefusal(run);
  if (why) return [{ type: 'tow', change: 'refused', ship: h.ship, why }];
  h.towed = true;
  h.blocked = 0;
  h.strained = false;
  return [{ type: 'tow', change: 'attached', ship: h.ship }];
}

/** One tick of the hull, after the ship moved: tether force, drag, collisions, then the snap and block checks. */
export function stepTow(run: SectorRun, events: SectorEvent[]): void {
  const h = run.hulk;
  if (!h) return;
  const dt = TICK_SECONDS;
  const sh = run.ship;
  h.px = h.x;
  h.py = h.y;
  if (h.towed) {
    const dx = sh.x - h.x;
    const dy = sh.y - h.y;
    const d = Math.hypot(dx, dy);
    if (d > TOW.rest && d > 0) {
      const nx = dx / d;
      const ny = dy / d;
      const closing = (sh.vx - h.vx) * nx + (sh.vy - h.vy) * ny;
      const a = Math.max(0, TOW.stiffness * (d - TOW.rest) + TOW.damping * closing);
      h.vx += a * nx * dt;
      h.vy += a * ny * dt;
    }
    if (d > 1) {
      const want = Math.atan2(dx, -dy);
      const diff = Math.atan2(Math.sin(want - h.heading), Math.cos(want - h.heading));
      const step = TOW.turnRate * dt;
      h.heading += Math.max(-step, Math.min(step, diff));
    }
  }
  const drag = Math.exp(-TOW.drag * dt);
  h.vx *= drag;
  h.vy *= drag;
  h.x += h.vx * dt;
  h.y += h.vy * dt;
  pushOutOfSolids(run.layout, h, h.r);
  if (!h.towed) {
    h.attach = towRefusal(run); // P10.2: the same verdict a press would get now
    return;
  }
  const len = gap(run, h);
  const max = towMax(run);
  if (len > max) {
    endTow(run, 'snapped', events);
    return;
  }
  // P10.2: one warning per stretch toward the snap length (re-armed only well inside it)
  if (!h.strained && len > max * TOW.strainAt) {
    h.strained = true;
    events.push({ type: 'tow', change: 'strained', ship: h.ship });
  } else if (h.strained && len < max * TOW.strainClear) h.strained = false;
  h.blocked = bodyBetween(run.layout.landmarks, sh.x, sh.y, h.x, h.y) ? h.blocked + 1 : 0;
  if (h.blocked >= TOW.blockTicks) endTow(run, 'blocked', events);
}

/** The log line of a tow event and its tone (the shell shows it; refusals name the real reason). */
export function towLine(e: { readonly change: TowChange; readonly why?: TowRefusal | undefined; readonly cause?: TowLoss | undefined }): readonly [string, 'gain' | 'warn' | 'info'] {
  const c = e.change;
  return c === 'refused' ? [`TOW · ${e.why === 'speed' ? 'TOO FAST' : e.why === 'blocked' ? 'LINE BLOCKED' : 'OUT OF REACH'}`, 'warn']
    : c === 'attached' ? ['TOW LINE ON · DOCK AT A STATION TO DELIVER', 'gain']
    : c === 'released' ? ['TOW RELEASED · HULL LEFT HERE', 'info']
    : c === 'strained' ? ['TOW LINE STRAINED · EASE OFF OR IT SNAPS', 'warn']
    : c === 'lost' && e.cause ? [`TOW LOST · HULL LEFT BEHIND · ${e.cause === 'wreck' ? 'SHIP WRECKED' : 'FLIGHT RESTARTED'}`, 'warn']
    : [`TOW ${c === 'snapped' ? 'LINE SNAPPED' : c === 'blocked' ? 'LINE CUT BY A BODY' : 'LOST'} · HULL LEFT BEHIND`, 'warn'];
}

/** P10.2: the INTERACT prompt's tow lines (pure, read-only). */
export interface TowPrompt {
  /** The hull prompt (TOW HULL / RELEASE TOW); null when another focus owns the main line. */
  readonly main: string | null;
  /** Second line: the tow status, or why TOW HULL would be refused now ('' = none). */
  readonly sub: string;
  /** ready: a press attaches; refused: a press is refused (the press still reports why); towing; '' = nothing to say. */
  readonly state: 'ready' | 'refused' | 'towing' | '';
  readonly risk: 'ok' | 'strain' | 'blocked';
}

/**
 * P10.2: what the INTERACT button says about the tow for the current focus (`focus`: a POI kind,
 * 'hulk' for the hull, or null). Every value is the simulation's own: the cached attach verdict, the
 * line length and snap length (rounded to 10 px so the text changes only every 10 px) and the risk.
 */
export function towPrompt(run: SectorRun, focus: string | null): TowPrompt {
  const h = run.hulk;
  const none = { main: null, sub: '', state: '', risk: 'ok' } as const;
  if (!h) return none;
  const name = SHIP_BY_ID.get(h.ship)!.name.toUpperCase();
  if (!h.towed) {
    if (focus !== 'hulk') return none;
    const why = h.attach;
    const sub = why === 'speed' ? 'TOO FAST · MATCH ITS SPEED' : why === 'blocked' ? 'LINE BLOCKED BY A BODY' : '';
    return { main: `TOW HULL · ${name}`, sub, state: sub ? 'refused' : 'ready', risk: 'ok' };
  }
  const st = towStatus(run);
  const len = `${Math.round(st.distance / 10) * 10}/${Math.round(st.maxLength / 10) * 10}`;
  const warn = st.risk === 'strain' ? ' · STRAINED' : st.risk === 'blocked' ? ' · LINE BLOCKED' : '';
  const sub = focus === 'station' ? `DELIVERS THE ${name} · ${len}${warn}`
    : focus === 'gate' || focus === 'exit' ? `TOWING ${name} · LEAVING DROPS THE TOW`
    : `TOW ATTACHED · ${len}${warn}`;
  return { main: focus === 'hulk' ? `RELEASE TOW · ${name}` : null, sub, state: 'towing', risk: st.risk };
}

/** Read-only tow snapshot (HUD notices and the browser checks; never the owner of anything). */
export interface TowStatus {
  /** The unrecovered hull this run may tow (null: none in this sector). */
  readonly ship: ShipId | null;
  /** none: no hull (box closed or nothing to recover); resting: waiting; towed: on the tether. */
  readonly state: 'none' | 'resting' | 'towed';
  readonly distance: number;
  readonly maxLength: number;
  readonly penalty: { readonly accel: number; readonly speed: number };
  readonly x: number | null;
  readonly y: number | null;
  /** P10.2: the INTERACT prompt's hull focus (in reach, or towing). */
  readonly focus: boolean;
  /** P10.2: why TOW HULL would be refused now (towRefusal); null = it would attach. 'state' while towing or without a hull. */
  readonly attach: TowRefusal | null;
  /** P10.2: tether risk while towing: blocked (a body on the line, released at TOW.blockTicks), strain (past TOW.strainAt), else ok. */
  readonly risk: 'ok' | 'strain' | 'blocked';
}

export function towStatus(run: SectorRun): TowStatus {
  const h = run.hulk;
  return {
    ship: run.salvage,
    state: !h ? 'none' : h.towed ? 'towed' : 'resting',
    distance: h ? Math.round(gap(run, h)) : 0,
    maxLength: Math.round(towMax(run)),
    penalty: towPenalty(run),
    x: h ? Math.round(h.x) : null,
    y: h ? Math.round(h.y) : null,
    focus: hulkFocus(run),
    attach: towRefusal(run),
    risk: !h?.towed ? 'ok' : h.blocked > 0 ? 'blocked' : gap(run, h) > towMax(run) * TOW.strainAt ? 'strain' : 'ok',
  };
}
