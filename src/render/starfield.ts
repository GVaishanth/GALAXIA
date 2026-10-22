import { COLORS, type ColorRole } from '../config/palette.ts';
import { PLAYFIELD_ART, STARFIELD } from '../config/visual.ts';
import { createRng } from '../core/rng.ts';
import type { Viewport } from './viewport.ts';

interface Star {
  readonly x: number;
  readonly y: number;
  readonly speed: number;
  readonly color: string;
  readonly phase: number;
  readonly twinkles: boolean;
}

const STAR_ROLES: readonly ColorRole[] = ['star.dim', 'star.dim', 'star.mid', 'star.cool', 'star.warm', 'star.bright'];

/** Seeded, deliberately dim starfield: it must never compete with sprites. */
export class Starfield {
  private readonly stars: Star[];

  constructor(seed = 1981, count: number = STARFIELD.starCount) {
    const rng = createRng(seed);
    this.stars = Array.from({ length: count }, () => {
      const role = STAR_ROLES[rng.int(0, STAR_ROLES.length - 1)]!;
      return {
        x: rng.range(0, PLAYFIELD_ART.width),
        y: rng.range(0, PLAYFIELD_ART.height),
        speed: rng.range(STARFIELD.minSpeed, STARFIELD.maxSpeed),
        color: COLORS[role],
        phase: rng.next(),
        twinkles: rng.next() < STARFIELD.twinkleShare,
      };
    });
  }

  draw(ctx: CanvasRenderingContext2D, v: Viewport, timeMs: number, motion = 1): void {
    const size = Math.max(1, Math.round(v.scale));
    for (const s of this.stars) {
      if (s.twinkles) {
        const t = (timeMs / STARFIELD.twinklePeriodMs + s.phase) % 1;
        if (t < 0.35) continue;
      }
      const y = (s.y + (s.speed * motion * timeMs) / 1000) % v.artHeight;
      ctx.fillStyle = s.color;
      ctx.fillRect(Math.round(v.offsetX + s.x * v.scale), Math.round(v.offsetY + y * v.scale), size, size);
    }
  }
}
