/**
 * Mode-neutral gamepad access: one merged snapshot per frame (all connected
 * pads, via the Classic-proven mergeSnapshots) plus the pure GamepadModel for
 * edge presses with menu auto-repeat. Each mode interprets the snapshot itself
 * (Classic: left/right only; Free Roam: analog 2-D).
 */
import { GamepadModel, mergeSnapshots, type PadSnapshot, type PadUpdate } from '../../input/gamepad.ts';

interface GamepadLike {
  readonly connected: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

export type PadSource = () => readonly (GamepadLike | null)[];

const browserPads: PadSource = () => {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  return navigator.getGamepads();
};

/**
 * True when a pad is already connected. A mode started from a menu by a pad
 * press resets its pad model only in that case: the launching button may still
 * be held and must not act again, while at page load (no pad known yet) the
 * press that reveals a pad must still count (see GamepadModel.update).
 */
export function anyPadConnected(source: PadSource = browserPads): boolean {
  try {
    return [...source()].some((p) => p?.connected === true);
  } catch {
    return false;
  }
}

export class GamepadReader {
  private readonly source: PadSource;
  readonly model = new GamepadModel();
  connected = 0;

  constructor(source: PadSource = browserPads) {
    this.source = source;
  }

  /** Read all pads once. `snapshot` is null when no pad is connected. */
  poll(nowMs: number): { readonly snapshot: PadSnapshot | null; readonly update: PadUpdate } {
    let pads: readonly (GamepadLike | null)[] = [];
    try {
      pads = this.source();
    } catch {
      pads = [];
    }
    const snaps: PadSnapshot[] = [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      snaps.push({ axes: p.axes, pressed: p.buttons.map((b) => b.pressed || b.value > 0.5) });
    }
    this.connected = snaps.length;
    const snapshot = mergeSnapshots(snaps);
    return { snapshot, update: this.model.update(snapshot, nowMs) };
  }

  reset(): void {
    this.model.reset();
  }
}
