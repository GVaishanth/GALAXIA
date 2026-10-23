/**
 * Free Roam pointer roles for flight (pure model, no DOM), FR-TD-44.
 *
 * Each pointer id has exactly one role. The first finger on the open canvas
 * owns the floating stick; fingers on the FIRE button fire while held; with
 * mouse aim on, the mouse cursor aims and its left button fires; fingers on
 * BOOST boost while held (Prompt 8); a finger on MSL presses the missile
 * skill once (Combat P03: the press is latched until the simulation takes it,
 * holding never repeats). Releasing or
 * cancelling one pointer releases only that pointer's role, so moving and
 * firing work simultaneously, and reset() (blur, hidden tab, rotation,
 * panels) releases everything so nothing can stay stuck.
 */
import { PointerStick, type StickVector } from '../../shared/input/pointerStick.ts';

export interface PointerSnapshot {
  readonly stickActive: boolean;
  readonly stick: StickVector;
  readonly fireTouches: number;
  /** Fingers holding the BOOST button (Prompt 8). */
  readonly boostTouches: number;
  /** Fingers holding the MSL button (Combat P03). */
  readonly missileTouches: number;
  readonly mouseFire: boolean;
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

/**
 * Pointer roles for flight. Coordinates are client (CSS) px; the shell turns
 * the cursor into a world aim with camera.screenToWorld.
 */
export class FlightPointers {
  readonly stick: PointerStick;
  private readonly fireIds = new Set<number>();
  private readonly boostIds = new Set<number>();
  private readonly missileIds = new Set<number>();
  private missilePress = false;
  private mouseDown = false;
  private cursorPos: { x: number; y: number } | null = null;

  constructor(stickRadius = 56) {
    this.stick = new PointerStick(stickRadius);
  }

  /** A pointer went down on the open canvas: it takes the stick if the stick is free. */
  stickDown(id: number, x: number, y: number): boolean {
    if (this.fireIds.has(id) || this.boostIds.has(id) || this.missileIds.has(id)) return false;
    return this.stick.down(id, x, y);
  }

  /** A pointer went down on the FIRE button. */
  fireDown(id: number): void {
    if (!this.stick.owns(id) && !this.boostIds.has(id) && !this.missileIds.has(id)) this.fireIds.add(id);
  }

  /** A pointer went down on the BOOST button. */
  boostDown(id: number): void {
    if (!this.stick.owns(id) && !this.fireIds.has(id) && !this.missileIds.has(id)) this.boostIds.add(id);
  }

  get boosting(): boolean {
    return this.boostIds.size > 0;
  }

  /** A pointer went down on the MSL button: one press (a second finger while one holds it is ignored). */
  missileDown(id: number): void {
    if (this.stick.owns(id) || this.fireIds.has(id) || this.boostIds.has(id)) return;
    if (this.missileIds.size === 0) this.missilePress = true;
    this.missileIds.add(id);
  }

  /** MSL held by any finger. */
  get missileHeld(): boolean {
    return this.missileIds.size > 0;
  }

  /** The latched press, cleared by reading it (the shell reads it once per simulated tick). */
  takeMissilePress(): boolean {
    const p = this.missilePress;
    this.missilePress = false;
    return p;
  }

  move(id: number, x: number, y: number): void {
    this.stick.move(id, x, y);
  }

  /** pointerup / pointercancel / lostpointercapture: release only this pointer's role. */
  release(id: number): void {
    this.stick.up(id);
    this.fireIds.delete(id);
    this.boostIds.delete(id);
    this.missileIds.delete(id);
  }

  /** Mouse aim: cursor position (client px) over the canvas, or null when it left. */
  setCursor(x: number, y: number): void {
    this.cursorPos = { x, y };
  }

  clearCursor(): void {
    this.cursorPos = null;
    this.mouseDown = false;
  }

  setMouseFire(down: boolean): void {
    this.mouseDown = down;
  }

  get firing(): boolean {
    return this.fireIds.size > 0 || this.mouseDown;
  }

  /** Release every role (blur, hidden tab, rotation, panel, screen change). The cursor is kept unless `all`. */
  reset(all = false): void {
    this.stick.reset();
    this.fireIds.clear();
    this.boostIds.clear();
    this.missileIds.clear();
    this.missilePress = false;
    this.mouseDown = false;
    if (all) this.cursorPos = null;
  }

  snapshot(): PointerSnapshot {
    const st = this.stick.state();
    return { stickActive: st.active, stick: st.vector, fireTouches: this.fireIds.size, boostTouches: this.boostIds.size, missileTouches: this.missileIds.size, mouseFire: this.mouseDown, cursor: this.cursorPos };
  }
}
