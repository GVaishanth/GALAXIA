/**
 * Combat P03C: what the Classic HUD readout and the touch weapon button show
 * for the selected weapon (pure; reads the world's ordnance state only).
 *
 * null = the legacy fighter (no readout, no button: the original HUD).
 * Text, never colour alone: ammo count / ∞ / seconds of cooldown / LOCK % /
 * EMPTY, plus a short notice (NO TARGET, LOCK LOST, IN FLIGHT, COOLING, EMPTY).
 */
import { WEAPON_BY_ID } from '../config/weapons.ts';
import type { ClassicOrdnance } from '../core/game/types.ts';

export interface OrdnanceView {
  /** Short weapon name (catalogue `short`). */
  readonly name: string;
  /** Ammo, ∞, a cooldown in seconds, LOCK nn% or EMPTY. */
  readonly state: string;
  /** False while it cannot fire (empty / cooling). */
  readonly ready: boolean;
  /** The gun is selected (the heat meter applies). */
  readonly gun: boolean;
  /** Feedback for the last refused press ('' = none). */
  readonly notice: string;
  /** Spoken / aria text. */
  readonly label: string;
  /** Weapons in the rotation (1 = nothing to switch to). */
  readonly count: number;
}

const NOTICE: Readonly<Record<NonNullable<ClassicOrdnance['notice']>, string>> = {
  noTarget: 'NO TARGET',
  empty: 'EMPTY',
  cooling: 'COOLING',
  busy: 'IN FLIGHT',
  lockLost: 'LOCK LOST',
};

export function ordnanceView(o: ClassicOrdnance | null | undefined, lockMs = 300): OrdnanceView | null {
  if (!o) return null;
  const id = o.arsenal.selected;
  const w = WEAPON_BY_ID.get(id);
  const name = w?.short ?? id.toUpperCase();
  const notice = o.notice ? NOTICE[o.notice] : '';
  const count = o.arsenal.rotation.length;
  if (!w || w.fire === 'fitted-gun') return { name, state: '∞', ready: true, gun: true, notice, label: `${name}, unlimited`, count };
  const coolTicks = o.arsenal.cooldown[id] ?? 0;
  const secs = Math.ceil(coolTicks / 60);
  const stock = w.ammo.kind === 'stock' ? (o.ammo[id] ?? 0) : null;
  let state: string;
  let ready = true;
  if (o.lock) state = `LOCK ${Math.min(99, Math.floor((o.lock.ms / lockMs) * 100))}%`;
  else if (stock === 0) {
    state = 'EMPTY';
    ready = false;
  } else if (coolTicks > 0) {
    state = stock === null ? `${secs}s` : `${stock} · ${secs}s`;
    ready = false;
  } else state = stock === null ? 'READY' : `${stock} READY`;
  const label = `${w.name}, ${stock === null ? '' : `${stock} left, `}${ready ? 'ready' : stock === 0 ? 'empty' : `cooling ${secs} seconds`}`;
  return { name, state, ready, gun: false, notice, label, count };
}
