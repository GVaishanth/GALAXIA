/**
 * Formation layout and the stage entry sequence (40 enemies: 4 commanders,
 * 16 interceptors, 20 scouts). Slots are logical; the viewport scales the
 * playfield, never the arrangement.
 */
import { deepFreeze } from './freeze.ts';
import type { EntryPathId } from './paths.ts';

export type FormationKind = 'scout' | 'interceptor' | 'commander';

export interface FormationRow {
  readonly y: number;
  readonly kind: FormationKind;
  readonly columns: readonly number[];
  /** Group name used for attack selection and tests. */
  readonly group: string;
}

export interface EntryWave {
  /** Start time after the stage begins playing. */
  readonly atMs: number;
  /** Each string flies one path; strings of one wave start together. */
  readonly strings: readonly {
    readonly path: EntryPathId;
    readonly mirror: boolean;
    /** Slot ids "row:col" in flight order. */
    readonly slots: readonly string[];
  }[];
}

const s = (row: number, cols: readonly number[]): string[] => cols.map((c) => `${row}:${c}`);

export const FORMATION = deepFreeze({
  centerX: 224,
  pitchX: 32,
  /** Column 0..9 -> x = centerX + (col - 4.5) * pitchX. */
  columns: 10,
  rows: [
    { y: 84, kind: 'commander', columns: [3, 4, 5, 6], group: 'commanders' },
    { y: 116, kind: 'interceptor', columns: [1, 2, 3, 4, 5, 6, 7, 8], group: 'interceptors' },
    { y: 144, kind: 'interceptor', columns: [1, 2, 3, 4, 5, 6, 7, 8], group: 'interceptors' },
    { y: 174, kind: 'scout', columns: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], group: 'scouts' },
    { y: 200, kind: 'scout', columns: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], group: 'scouts' },
  ] as readonly FormationRow[],
  /** Side-to-side sway while enemies are arriving. */
  sway: { amplitude: 16, periodMs: 3200 },
  /** Expand/contract after everyone has arrived (fraction of distance from the anchor). */
  breathe: { amount: 0.1, periodMs: 2600, anchorY: 60 },
  /** Gap between members of one entry string. */
  stringSpacingMs: 150,
  entryWaves: [
    {
      atMs: 0,
      strings: [
        { path: 'topDrop', mirror: false, slots: [...s(1, [4, 5]), ...s(2, [4, 5])] },
        { path: 'topDrop', mirror: true, slots: [...s(3, [4, 5]), ...s(4, [4, 5])] },
      ],
    },
    {
      atMs: 3000,
      strings: [{ path: 'sideLoop', mirror: false, slots: ['0:3', '1:3', '0:4', '1:2', '0:5', '1:6', '0:6', '1:7'] }],
    },
    {
      atMs: 5600,
      strings: [{ path: 'sideLoop', mirror: true, slots: ['1:8', '2:8', '1:1', '2:1', ...s(2, [7, 2, 6, 3])] }],
    },
    {
      atMs: 8200,
      strings: [{ path: 'topArc', mirror: false, slots: [...s(3, [6, 7, 8, 9]), ...s(4, [6, 7, 8, 9])] }],
    },
    {
      atMs: 10600,
      strings: [{ path: 'topArc', mirror: true, slots: [...s(3, [3, 2, 1, 0]), ...s(4, [3, 2, 1, 0])] }],
    },
  ] as readonly EntryWave[],
});
