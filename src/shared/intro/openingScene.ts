/**
 * Finale P3: the opening cinematic's space battle (pure; lazy chunk).
 *
 * A seeded script (buildScript) fixes every actor's path and every event time
 * once; sceneAt(script, t, view) then answers "what is on screen at time t" as
 * a pure function, with no simulation state carried between frames. So the
 * battle is deterministic, frame-rate independent, cannot accumulate actors or
 * particles, and skipping or disposing has nothing to tear down.
 *
 * It is a presentation world only: temporary enemies with Classic's sprites,
 * the hero in its current hull, scripted bolts that land when each enemy is
 * scripted to die. No game rules, no combat loop, no rewards, no saves.
 *
 * Coordinates are art pixels around the scene centre (y down); `view` gives
 * the visible art size, so the formation narrows on portrait screens.
 */
import { createRng } from '../../core/rng.ts';

/** Hard caps (the tests sample the whole sequence against them). */
export const SCENE_LIMITS = Object.freeze({ enemies: 7, bolts: 12, shots: 4, explosions: 7, sparks: 160, stars: 110 });

/** Global times (ms) of the space part; they match FULL_SCHEDULE (the tests check). */
export const SCENE_TIMES = Object.freeze({ arrivalEnd: 900, battleEnd: 3300, victoryEnd: 3900, trackEnd: 4700, approachEnd: 5700 });

export type EnemyKind = 'enemy.scout' | 'enemy.interceptor' | 'enemy.commander';

export interface EnemyScript {
  readonly kind: EnemyKind;
  readonly slotX: number; // -1..1 of the formation span
  readonly slotY: number; // fraction of the (clamped) visible height, negative = up
  readonly side: -1 | 1;
  readonly enterAt: number;
  readonly killAt: number;
  readonly diveAt: number | null;
  readonly sway: number;
}

export interface BoltScript {
  readonly spawnAt: number;
  readonly travel: number;
  /** Enemy index it destroys, or null for a miss that flies off screen. */
  readonly target: number | null;
  readonly dx: number;
}

export interface ShotScript {
  readonly from: number;
  readonly fireAt: number;
  readonly travel: number;
  readonly aim: number; // offset from the hero, -1..1 of the span (always a miss)
}

export interface SparkScript {
  readonly angle: number;
  readonly speed: number;
  readonly life: number;
  readonly color: string;
  readonly size: number;
}

export interface StarScript {
  readonly x: number;
  readonly y: number;
  readonly layer: 0 | 1 | 2;
}

export interface OpeningScript {
  readonly seed: number;
  readonly enemies: readonly EnemyScript[];
  readonly bolts: readonly BoltScript[];
  readonly shots: readonly ShotScript[];
  readonly sparks: readonly (readonly SparkScript[])[];
  readonly stars: readonly StarScript[];
}

export interface SceneView {
  readonly visW: number;
  readonly visH: number;
  /** Hero sprite height (art px): the camera aims at its canopy. */
  readonly heroH: number;
  /** Frames in the small and the big explosion animation. */
  readonly burstSmall: number;
  readonly burstBig: number;
}

export interface SceneFrame {
  readonly camera: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly hero: { readonly x: number; readonly y: number; readonly frame: number; readonly thrust: boolean };
  readonly enemies: readonly { readonly kind: EnemyKind; readonly x: number; readonly y: number; readonly attack: boolean; readonly frame: number }[];
  readonly bolts: readonly { readonly x: number; readonly y: number; readonly angle: number }[];
  readonly shots: readonly { readonly x: number; readonly y: number; readonly angle: number }[];
  readonly explosions: readonly { readonly x: number; readonly y: number; readonly frame: number; readonly big: boolean }[];
  readonly rings: readonly { readonly x: number; readonly y: number; readonly r: number; readonly alpha: number }[];
  readonly sparks: readonly { readonly x: number; readonly y: number; readonly alpha: number; readonly color: string; readonly size: number }[];
  readonly stars: readonly { readonly x: number; readonly y: number; readonly len: number; readonly layer: 0 | 1 | 2 }[];
  /** 0..1: the cockpit fading in over the zoomed canopy (approach). */
  readonly cabin: number;
  /** 0..~0.2: the canopy glass glint while the camera passes through it. */
  readonly flare: number;
}

const ENTER_MS = 800;
const DIVE_MS = 500;
const BOLT_MS = 230;
const BURST_FRAME_MS = 70;
const KILL_SLOTS = [1450, 1700, 1950, 2200, 2450, 2700] as const;
const COMMANDER_KILL = 3000;
const STAR_SPEED = [14, 30, 60] as const;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutCubic = (u: number): number => 1 - (1 - clamp01(u)) ** 3;
export const easeInOut = (u: number): number => {
  const x = clamp01(u);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
export const smoothstep = (a: number, b: number, v: number): number => {
  const x = clamp01((v - a) / (b - a));
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

export function buildScript(seed: number): OpeningScript {
  const rng = createRng(seed);
  const slots: readonly [EnemyKind, number, number][] = [
    ['enemy.commander', 0, -0.3],
    ['enemy.interceptor', -0.42, -0.2],
    ['enemy.interceptor', 0.42, -0.2],
    ['enemy.scout', -0.78, -0.1],
    ['enemy.scout', -0.26, -0.1],
    ['enemy.scout', 0.26, -0.1],
    ['enemy.scout', 0.78, -0.1],
  ];
  // seeded kill order for everything but the commander (always last)
  const order = [1, 2, 3, 4, 5, 6];
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const killAt = new Map<number, number>(order.map((e, k) => [e, KILL_SLOTS[k]!]));
  killAt.set(0, COMMANDER_KILL);
  const enemies: EnemyScript[] = slots.map(([kind, slotX, slotY], i) => {
    const enterAt = 620 + i * 55 + rng.int(0, 30);
    const k = killAt.get(i)!;
    const outer = Math.abs(slotX) > 0.6;
    const diveAt = outer && k - DIVE_MS >= enterAt + ENTER_MS ? k - DIVE_MS : null;
    return { kind, slotX, slotY, side: slotX < 0 ? -1 : 1, enterAt, killAt: k, diveAt, sway: rng.range(0, Math.PI * 2) };
  });
  const bolts: BoltScript[] = enemies.map((e, i) => ({ spawnAt: e.killAt - BOLT_MS, travel: BOLT_MS, target: i, dx: 0 }));
  bolts.sort((a, b) => a.spawnAt - b.spawnAt); // the easiest land first: misses always come after
  for (let i = 0; i < 4; i++) bolts.push({ spawnAt: 1150 + i * 520 + rng.int(0, 120), travel: 380, target: null, dx: rng.range(-0.04, 0.04) });
  const shots: ShotScript[] = [1600, 2100, 2600].map((fireAt) => {
    const alive = enemies.map((e, i) => [e, i] as const).filter(([e]) => e.killAt > fireAt + 60 && e.enterAt + ENTER_MS < fireAt);
    const from = alive.length > 0 ? alive[rng.int(0, alive.length - 1)]![1] : 0;
    return { from, fireAt, travel: 800, aim: (rng.next() < 0.5 ? -1 : 1) * rng.range(0.22, 0.32) };
  });
  const palette = ['#fff1a6', '#ff9440', '#ffd23f', '#ffffff'];
  const sparks = enemies.map((e) => {
    const big = e.kind === 'enemy.commander';
    const n = big ? 28 : 12;
    return Array.from({ length: n }, (): SparkScript => ({
      angle: rng.range(0, Math.PI * 2),
      speed: big ? rng.range(50, 160) : rng.range(40, 120),
      life: rng.range(450, 800),
      color: big && rng.next() < 0.3 ? '#5cefff' : palette[rng.int(0, palette.length - 1)]!,
      size: rng.next() < 0.25 ? 2 : 1,
    }));
  });
  const stars: StarScript[] = [];
  for (let i = 0; i < SCENE_LIMITS.stars; i++) stars.push({ x: rng.next(), y: rng.next(), layer: i < 60 ? 0 : i < 95 ? 1 : 2 });
  return { seed, enemies, bolts, shots, sparks, stars };
}

/** Formation span (art px) and the clamped height the formation uses. */
function spans(view: SceneView): { sx: number; hy: number; heroY: number } {
  const sx = Math.max(24, Math.min(view.visW / 2 - 16, 80));
  const hy = Math.min(view.visH, 230);
  return { sx, hy, heroY: Math.min(view.visH * 0.28, 70) };
}

/** Hero position at time t. */
export function heroAt(t: number, view: SceneView): { x: number; y: number } {
  const { sx, heroY } = spans(view);
  if (t < SCENE_TIMES.arrivalEnd) return { x: 0, y: lerp(view.visH / 2 + 30, heroY, easeOutCubic(t / SCENE_TIMES.arrivalEnd)) };
  const weave = (tt: number): number => 0.42 * Math.sin(((tt - SCENE_TIMES.arrivalEnd) / 1000) * 2.2);
  if (t < SCENE_TIMES.battleEnd) return { x: weave(t) * sx, y: heroY };
  const end = weave(SCENE_TIMES.battleEnd) * sx;
  if (t < SCENE_TIMES.victoryEnd) return { x: end * (1 - easeInOut((t - SCENE_TIMES.battleEnd) / 600)), y: heroY };
  return { x: 0, y: heroY - 6 * easeInOut((t - SCENE_TIMES.victoryEnd) / 800) };
}

/** Enemy position at time t (valid while it is alive; frozen at its kill time afterwards). */
export function enemyAt(e: EnemyScript, t: number, view: SceneView): { x: number; y: number; attack: boolean } {
  const { sx, hy, heroY } = spans(view);
  const tt = Math.min(t, e.killAt);
  const fx = (e.slotX + 0.05 * Math.sin(tt / 430 + e.sway)) * sx;
  const fy = e.slotY * hy + 2.5 * Math.sin(tt / 310 + e.sway);
  const u = (tt - e.enterAt) / ENTER_MS;
  if (u < 1) {
    const k = clamp01(u);
    const x0 = (e.slotX * 1.4 + e.side * 0.5) * sx;
    return { x: lerp(x0, fx, easeInOut(k)) + e.side * 0.25 * sx * Math.sin(Math.PI * k), y: lerp(-view.visH / 2 - 24, fy, easeOutCubic(k)), attack: true };
  }
  if (e.diveAt !== null && tt >= e.diveAt) {
    const d = clamp01((tt - e.diveAt) / DIVE_MS);
    const hx = heroAt(e.diveAt + DIVE_MS, view).x * 0.6;
    const k = d * d;
    return { x: lerp(fx, hx, k) - e.side * 0.15 * sx * Math.sin(Math.PI * d), y: lerp(fy, Math.min(fy + 0.35 * hy, heroY - 40), k), attack: true };
  }
  return { x: fx, y: fy, attack: false };
}

export function sceneAt(script: OpeningScript, t: number, view: SceneView): SceneFrame {
  const { sx } = spans(view);
  const hero = heroAt(t, view);
  const enemies: SceneFrame['enemies'][number][] = [];
  const explosions: SceneFrame['explosions'][number][] = [];
  const rings: SceneFrame['rings'][number][] = [];
  const sparks: SceneFrame['sparks'][number][] = [];
  script.enemies.forEach((e, i) => {
    if (t >= e.enterAt && t < e.killAt) {
      const p = enemyAt(e, t, view);
      enemies.push({ kind: e.kind, x: p.x, y: p.y, attack: p.attack, frame: Math.floor(t / 400) % 2 });
    }
    const age = t - e.killAt;
    if (age < 0) return;
    const big = e.kind === 'enemy.commander';
    const at = enemyAt(e, e.killAt, view);
    const frames = big ? view.burstBig : view.burstSmall;
    if (age < frames * BURST_FRAME_MS) explosions.push({ x: at.x, y: at.y, frame: Math.floor(age / BURST_FRAME_MS), big });
    if (big && age < 450) rings.push({ x: at.x, y: at.y, r: 6 + 40 * easeOutCubic(age / 450), alpha: 0.5 * (1 - age / 450) });
    for (const s of script.sparks[i] ?? []) {
      if (age >= s.life || sparks.length >= SCENE_LIMITS.sparks) continue;
      const tau = age / 1000;
      const reach = (s.speed * (1 - Math.exp(-3 * tau))) / 3;
      sparks.push({ x: at.x + Math.cos(s.angle) * reach, y: at.y + Math.sin(s.angle) * reach, alpha: 1 - age / s.life, color: s.color, size: s.size });
    }
  });
  const bolts: SceneFrame['bolts'][number][] = [];
  for (const b of script.bolts) {
    const u = (t - b.spawnAt) / b.travel;
    if (u < 0 || u >= 1) continue;
    const from = heroAt(b.spawnAt, view);
    const fy = from.y - 9;
    const to = b.target !== null ? enemyAt(script.enemies[b.target]!, b.spawnAt + b.travel, view) : { x: from.x + b.dx * sx, y: -view.visH / 2 - 12 };
    bolts.push({ x: lerp(from.x, to.x, u), y: lerp(fy, to.y, u), angle: Math.atan2(to.x - from.x, fy - to.y) });
  }
  const shots: SceneFrame['shots'][number][] = [];
  for (const s of script.shots) {
    const u = (t - s.fireAt) / s.travel;
    if (u < 0 || u >= 1) continue;
    const from = enemyAt(script.enemies[s.from]!, s.fireAt, view);
    const tx = heroAt(s.fireAt + s.travel, view).x + s.aim * sx;
    const ty = view.visH / 2 + 16;
    shots.push({ x: lerp(from.x, tx, u), y: lerp(from.y + 6, ty, u), angle: Math.atan2(tx - from.x, -(ty - from.y)) });
  }
  // warp-in: the stars stream past fast and settle as the squadron drops out of the jump
  const ta = SCENE_TIMES.arrivalEnd;
  const warp = t < ta ? 1 + 24 * (1 - t / ta) ** 3 : 1;
  // integral of the speed factor: continuous at the end of the arrival (both sides give 7 * ta)
  const travelled = t < ta ? t + ((24 * ta) / 4) * (1 - (1 - t / ta) ** 4) : t + 6 * ta;
  const stars = script.stars.map((s) => {
    const sp = STAR_SPEED[s.layer];
    const y = (((s.y * view.visH + (sp * travelled) / 1000) % view.visH) + view.visH) % view.visH;
    return { x: (s.x - 0.5) * view.visW, y: y - view.visH / 2, len: Math.max(1, sp * warp * 0.05), layer: s.layer };
  });
  // camera: battle framing, then it tracks the hero and dives at its canopy
  let camera = { x: 0, y: 0, zoom: 1 };
  const commanderAge = t - COMMANDER_KILL;
  if (commanderAge >= 0 && commanderAge < 300) {
    const a = 1.6 * (1 - commanderAge / 300);
    camera = { x: a * Math.sin(commanderAge / 17), y: a * Math.cos(commanderAge / 23), zoom: 1 };
  }
  let cabin = 0;
  let flare = 0;
  if (t >= SCENE_TIMES.victoryEnd && t < SCENE_TIMES.trackEnd) {
    const u = easeInOut((t - SCENE_TIMES.victoryEnd) / (SCENE_TIMES.trackEnd - SCENE_TIMES.victoryEnd));
    camera = { x: lerp(0, hero.x, u), y: lerp(0, hero.y, u), zoom: lerp(1, 2.4, u) };
  } else if (t >= SCENE_TIMES.trackEnd) {
    const p = clamp01((t - SCENE_TIMES.trackEnd) / (SCENE_TIMES.approachEnd - SCENE_TIMES.trackEnd));
    const canopy = hero.y - view.heroH * 0.18;
    camera = { x: hero.x, y: lerp(hero.y, canopy, easeInOut(p)), zoom: 2.4 * (30 / 2.4) ** (p * p) };
    cabin = smoothstep(0.5, 1, p);
    flare = 0.2 * Math.max(0, 1 - Math.abs(p - 0.78) / 0.18);
  }
  return {
    camera,
    hero: { x: hero.x, y: hero.y, frame: Math.floor(t / 120) % 2, thrust: t >= SCENE_TIMES.arrivalEnd * 0.3 },
    enemies,
    bolts,
    shots,
    explosions,
    rings,
    sparks,
    stars,
    cabin,
    flare,
  };
}
