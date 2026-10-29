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
 * way; a finger on STOP (P04.3, REALISTIC flight only) toggles
 * braking / station-keeping once, the same way; a finger on SILENT (P07.2)
 * toggles Silent Running once, the same way; a finger on the ship ability
 * button (P08.2) requests one activation, the same way. Releasing or
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
  /** Fingers holding the STOP button (P04.3, REALISTIC flight). */
  readonly stopTouches: number;
  /** Fingers holding the SILENT button (P07.2). */
  readonly silentTouches: number;
  /** Fingers holding the ship ability button (P08.2). */
  readonly abilityTouches: number;
  readonly mouseFire: boolean;
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

/**
 * Pointer roles for flight. Coordinates are client (CSS) px; the shell turns
 * the cursor into a world aim with camera.screenToWorld.
 */
/** The latched one-press buttons (WPN, LOCK, NEXT TARGET, STOP, SILENT, the ship ability): one rule for all of them. */
type Latch = 'weapon' | 'lock' | 'target' | 'stop' | 'silent' | 'ability';

export class FlightPointers {
  readonly stick: PointerStick;
  private readonly fireIds = new Set<number>();
  private readonly boostIds = new Set<number>();
  /** Fingers on each latched button, and its press waiting for the simulation. */
  private readonly ids: Record<Latch, Set<number>> = { weapon: new Set(), lock: new Set(), target: new Set(), stop: new Set(), silent: new Set(), ability: new Set() };
  private readonly press = new Set<Latch>();
  private mouseDown = false;
  private cursorPos: { x: number; y: number } | null = null;

  constructor(stickRadius = 56) {
    this.stick = new PointerStick(stickRadius);
  }

  /** The pointer already has a button role (FIRE, BOOST or a latched button): one role per pointer id. */
  private onButton(id: number): boolean {
    return this.fireIds.has(id) || this.boostIds.has(id) || Object.values(this.ids).some((s) => s.has(id));
  }

  /** A pointer went down on a latched button: one press (a second finger while one holds it is ignored; never the stick finger). */
  private latch(k: Latch, id: number): void {
    const s = this.ids[k];
    if (this.stick.owns(id) || (this.onButton(id) && !s.has(id))) return;
    if (s.size === 0) this.press.add(k);
    s.add(id);
  }

  /** The latched press, cleared by reading it (the shell reads it once per frame). */
  private take(k: Latch): boolean {
    return this.press.delete(k);
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

  /** WPN (Combat P03C): one weapon step per press. */
  weaponDown(id: number): void {
    this.latch('weapon', id);
  }

  /** WPN held by any finger. */
  get weaponHeld(): boolean {
    return this.ids.weapon.size > 0;
  }

  takeWeaponPress(): boolean {
    return this.take('weapon');
  }

  /** LOCK (P04.1): one toggle per press. */
  lockDown(id: number): void {
    this.latch('lock', id);
  }

  takeLockPress(): boolean {
    return this.take('lock');
  }

  /** NEXT TARGET (P04.1 polish): one step per press. */
  targetDown(id: number): void {
    this.latch('target', id);
  }

  takeTargetPress(): boolean {
    return this.take('target');
  }

  /** STOP (P04.3): one toggle per press. */
  stopDown(id: number): void {
    this.latch('stop', id);
  }

  takeStopPress(): boolean {
    return this.take('stop');
  }

  /** SILENT (P07.2): one toggle per press. */
  silentDown(id: number): void {
    this.latch('silent', id);
  }

  takeSilentPress(): boolean {
    return this.take('silent');
  }

  /** The ship ability button (P08.2): one activation request per press, the same request as the key. */
  abilityDown(id: number): void {
    this.latch('ability', id);
  }

  takeAbilityPress(): boolean {
    return this.take('ability');
  }

  move(id: number, x: number, y: number): void {
    this.stick.move(id, x, y);
  }

  /** pointerup / pointercancel / lostpointercapture: release only this pointer's role (a press already latched stays one press). */
  release(id: number): void {
    this.stick.up(id);
    this.fireIds.delete(id);
    this.boostIds.delete(id);
    for (const s of Object.values(this.ids)) s.delete(id);
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

  /** Release every role and drop every latched press (blur, hidden tab, rotation, panel, screen change). The cursor is kept unless `all`. */
  reset(all = false): void {
    this.stick.reset();
    this.fireIds.clear();
    this.boostIds.clear();
    for (const s of Object.values(this.ids)) s.clear();
    this.press.clear();
    this.mouseDown = false;
    if (all) this.cursorPos = null;
  }

  snapshot(): PointerSnapshot {
    const st = this.stick.state();
    const n = this.ids;
    return { stickActive: st.active, stick: st.vector, fireTouches: this.fireIds.size, boostTouches: this.boostIds.size, weaponTouches: n.weapon.size, lockTouches: n.lock.size, targetTouches: n.target.size, stopTouches: n.stop.size, silentTouches: n.silent.size, abilityTouches: n.ability.size, mouseFire: this.mouseDown, cursor: this.cursorPos };
  }
}
