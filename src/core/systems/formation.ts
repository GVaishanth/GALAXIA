/**
 * Formation manager: slot table, slot coordinates over time (sway while
 * arriving, breathing once complete), groups and alive tracking.
 */
import { FORMATION } from '../../config/formation.ts';
import type { FormationState, Slot, World } from '../game/types.ts';
import { tri, tri01, type Vec } from './paths.ts';

export function buildSlots(): Slot[] {
  const slots: Slot[] = [];
  FORMATION.rows.forEach((row, r) => {
    for (const col of row.columns) {
      slots.push({
        id: `${r}:${col}`,
        row: r,
        col,
        kind: row.kind,
        group: row.group,
        baseX: FORMATION.centerX + (col - (FORMATION.columns - 1) / 2) * FORMATION.pitchX,
        baseY: row.y,
      });
    }
  });
  return slots;
}

/** A virtual slot above a commander, used by its captive. */
export function captiveSlot(captorSlot: Slot, offsetY: number): Slot {
  return { ...captorSlot, id: `${captorSlot.id}:captive`, baseY: captorSlot.baseY + offsetY };
}

export function newFormationState(): FormationState {
  return { timeMs: 0, mode: 'sway', swayMs: 0, breatheMs: 0, entryClockMs: 0, entryQueue: [], entryComplete: false };
}

export function slotPosition(f: FormationState, slot: Slot, out: Vec): Vec {
  if (f.mode === 'sway') {
    out.x = slot.baseX + FORMATION.sway.amplitude * tri(f.swayMs / FORMATION.sway.periodMs);
    out.y = slot.baseY;
  } else {
    const k = 1 + FORMATION.breathe.amount * tri01(f.breatheMs / FORMATION.breathe.periodMs);
    out.x = FORMATION.centerX + (slot.baseX - FORMATION.centerX) * k;
    out.y = FORMATION.breathe.anchorY + (slot.baseY - FORMATION.breathe.anchorY) * k;
  }
  return out;
}

/** Advance formation motion. Switches from sway to breathe at a sway zero-crossing once everyone has arrived. */
export function updateFormation(world: World, dtMs: number): void {
  const f = world.formation;
  f.timeMs += dtMs;
  if (f.mode === 'sway') {
    const before = tri(f.swayMs / FORMATION.sway.periodMs);
    f.swayMs += dtMs;
    const after = tri(f.swayMs / FORMATION.sway.periodMs);
    const settled = f.entryComplete && !world.enemies.some((e) => e.state === 'entering' || e.state === 'formingUp');
    if (settled && before * after <= 0) {
      f.mode = 'breathe';
      f.breatheMs = 0;
    }
  } else {
    f.breatheMs += dtMs;
  }
}
