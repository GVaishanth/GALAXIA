/**
 * Floating virtual stick (pure model, no DOM): the first pointer down sets the
 * origin, dragging gives an analog vector of length <= 1. Used by Free Roam
 * for touch flight; any future mode needing 2-D touch input can reuse it.
 */
export interface StickVector {
  readonly x: number;
  readonly y: number;
}

export interface StickState {
  readonly active: boolean;
  readonly originX: number;
  readonly originY: number;
  readonly vector: StickVector;
}

export class PointerStick {
  private pointer: number | null = null;
  private ox = 0;
  private oy = 0;
  private vx = 0;
  private vy = 0;
  /** Drag distance (CSS px) for full deflection. */
  readonly radius: number;
  /** Fraction of the radius ignored around the origin. */
  readonly deadZone: number;

  constructor(radius = 56, deadZone = 0.12) {
    this.radius = radius;
    this.deadZone = deadZone;
  }

  /** Returns true when this pointer now controls the stick. */
  down(id: number, x: number, y: number): boolean {
    if (this.pointer !== null) return false;
    this.pointer = id;
    this.ox = x;
    this.oy = y;
    this.vx = 0;
    this.vy = 0;
    return true;
  }

  move(id: number, x: number, y: number): void {
    if (id !== this.pointer) return;
    let dx = (x - this.ox) / this.radius;
    let dy = (y - this.oy) / this.radius;
    const len = Math.hypot(dx, dy);
    if (len < this.deadZone) {
      this.vx = 0;
      this.vy = 0;
      return;
    }
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    // rescale so deflection starts at 0 just outside the dead zone
    const k = Math.min(1, (Math.min(len, 1) - this.deadZone) / (1 - this.deadZone)) / Math.min(len, 1);
    this.vx = dx * k;
    this.vy = dy * k;
  }

  up(id: number): void {
    if (id === this.pointer) this.reset();
  }

  owns(id: number): boolean {
    return id === this.pointer;
  }

  reset(): void {
    this.pointer = null;
    this.vx = 0;
    this.vy = 0;
  }

  state(): StickState {
    return { active: this.pointer !== null, originX: this.ox, originY: this.oy, vector: { x: this.vx, y: this.vy } };
  }
}
