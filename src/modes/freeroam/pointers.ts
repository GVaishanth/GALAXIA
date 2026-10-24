/**
 * Free Roam pointer roles for flight (pure model, no DOM), FR-TD-44.
 *
 * Each pointer id has exactly one role. The first finger on the open canvas
 * owns the floating stick; fingers on the FIRE button fire while held; with
 * mouse aim on, the mouse cursor aims and its left button fires; fingers on
 * BOOST boost while held (Prompt 8); a finger on WPN switches to the next weapon (Combat P03C; was MSL)
 * skill once (Combat P03: the press is latched until the simulation takes it,
 * holding never repeats); a finger on LOCK toggles the ship target lock once
 * (P04.1, the same latched press; it never takes the stick); a finger on the
 * target-cycle button (P04.1 polish) selects the next target once, the same
 * way. Releasing or
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
  /** Fingers holding the WPN button (Combat P03C; the MSL button of P03). */
  readonly weaponTouches: number;
  /** Fingers holding the LOCK button (P04.1). */
  readonly lockTouches: number;
  /** Fingers holding the NEXT TARGET button (P04.1 polish). */
  readonly targetTouches: number;
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
  private readonly weaponIds = new Set<number>();
  private weaponPress = false;
  private readonly lockIds = new Set<number>();
  private lockPress = false;
  private readonly targetIds = new Set<number>();
  private targetPress = false;
  private mouseDown = false;
  private cursorPos: { x: number; y: number } | null = null;

  constructor(stickRadius = 56) {
    this.stick = new PointerStick(stickRadius);
  }

  /** The pointer already has a button role (FIRE, BOOST, WPN, LOCK, NEXT TARGET): one role per pointer id. */
  private onButton(id: number): boolean {
    return this.fireIds.has(id) || this.boostIds.has(id) || this.weaponIds.has(id) || this.lockIds.has(id) || this.targetIds.has(id);
  }

  /** A pointer went down on the open canvas: it takes the stick if the stick is free. */
  stickDown(id: number, x: number, y: number): boolean {
    if (this.onButton(id)) return false;
    return this.stick.down(id, x, y);
  }

  /** A pointer went down on the FIRE button. */
  fireDown(id: number): void {
    if (!this.stick.owns(id) && !this.onButton(id)) this.fireIds.add(id);
  }

  /** A pointer went down on the BOOST button. */
  boostDown(id: number): void {
    if (!this.stick.owns(id) && !this.onButton(id)) this.boostIds.add(id);
  }

  get boosting(): boolean {
    return this.boostIds.size > 0;
  }

  /** A pointer went down on the WPN button: one press (a second finger while one holds it is ignored). */
  weaponDown(id: number): void {
    if (this.stick.owns(id) || (this.onButton(id) && !this.weaponIds.has(id))) return;
    if (this.weaponIds.size === 0) this.weaponPress = true;
    this.weaponIds.add(id);
  }

  /** WPN held by any finger. */
  get weaponHeld(): boolean {
    return this.weaponIds.size > 0;
  }

  /** The latched press, cleared by reading it (the shell reads it once per simulated tick). */
  takeWeaponPress(): boolean {
    const p = this.weaponPress;
    this.weaponPress = false;
    return p;
  }

  /** A pointer went down on the LOCK button (P04.1): one toggle per press (a second finger while one holds it is ignored). */
  lockDown(id: number): void {
    if (this.stick.owns(id) || (this.onButton(id) && !this.lockIds.has(id))) return;
    if (this.lockIds.size === 0) this.lockPress = true;
    this.lockIds.add(id);
  }

  /** The latched LOCK press, cleared by reading it. */
  takeLockPress(): boolean {
    const p = this.lockPress;
    this.lockPress = false;
    return p;
  }

  /** A pointer went down on the NEXT TARGET button: one step per press (a second finger while one holds it is ignored). */
  targetDown(id: number): void {
    if (this.stick.owns(id) || (this.onButton(id) && !this.targetIds.has(id))) return;
    if (this.targetIds.size === 0) this.targetPress = true;
    this.targetIds.add(id);
  }

  /** The latched NEXT TARGET press, cleared by reading it. */
  takeTargetPress(): boolean {
    const p = this.targetPress;
    this.targetPress = false;
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
    this.weaponIds.delete(id);
    this.lockIds.delete(id);
    this.targetIds.delete(id);
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
    this.weaponIds.clear();
    this.weaponPress = false;
    this.lockIds.clear();
    this.lockPress = false;
    this.targetIds.clear();
    this.targetPress = false;
    this.mouseDown = false;
    if (all) this.cursorPos = null;
  }

  snapshot(): PointerSnapshot {
    const st = this.stick.state();
    return { stickActive: st.active, stick: st.vector, fireTouches: this.fireIds.size, boostTouches: this.boostIds.size, weaponTouches: this.weaponIds.size, lockTouches: this.lockIds.size, targetTouches: this.targetIds.size, mouseFire: this.mouseDown, cursor: this.cursorPos };
  }
}
