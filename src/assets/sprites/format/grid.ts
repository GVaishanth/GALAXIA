import type { CharPalette, ExpandedFrame, FrameSource, PixelRows } from './types.ts';

export const TRANSPARENT = '.';

function mirrorRow(row: string): string {
  // Left half includes the centre column, so the mirror skips the last char.
  return row + [...row.slice(0, -1)].reverse().join('');
}

/** Expand authored rows according to their symmetry. */
export function expandFrame(source: FrameSource): ExpandedFrame {
  const { rows, symmetry } = source;
  if (rows.length === 0) throw new Error('Frame has no rows');
  const width0 = rows[0]!.length;
  rows.forEach((row, i) => {
    if (row.length !== width0) {
      throw new Error(`Row ${i} has length ${row.length}, expected ${width0}: "${row}"`);
    }
  });

  let full: string[];
  switch (symmetry) {
    case 'none':
      full = [...rows];
      break;
    case 'mirror-x':
      full = rows.map(mirrorRow);
      break;
    case 'mirror-xy': {
      const top = rows.map(mirrorRow);
      full = [...top, ...top.slice(0, -1).reverse()];
      break;
    }
  }
  return { width: full[0]!.length, height: full.length, rows: full };
}

/** Characters used by a frame that are missing from the palette. */
export function unknownChars(frame: ExpandedFrame, palette: CharPalette): string[] {
  const missing = new Set<string>();
  for (const row of frame.rows) {
    for (const ch of row) {
      if (ch !== TRANSPARENT && !(ch in palette)) missing.add(ch);
    }
  }
  return [...missing];
}

export function isHorizontallySymmetric(frame: ExpandedFrame): boolean {
  return frame.rows.every((row) => row === [...row].reverse().join(''));
}

/**
 * Join frames side by side, bottom-aligned, with `gap` transparent columns.
 * Used to build the Dual Fighter from two standard fighters.
 */
export function joinHorizontal(frames: readonly FrameSource[], gap: number): FrameSource {
  const expanded = frames.map(expandFrame);
  const height = Math.max(...expanded.map((f) => f.height));
  const spacer = TRANSPARENT.repeat(gap);
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    const parts = expanded.map((f) => {
      const offset = height - f.height;
      return y < offset ? TRANSPARENT.repeat(f.width) : f.rows[y - offset]!;
    });
    rows.push(parts.join(spacer));
  }
  return { rows, symmetry: 'none' };
}

/** Rotate a frame 180 degrees (e.g. a ship facing down). */
export function flipVertical(source: FrameSource): FrameSource {
  const f = expandFrame(source);
  return { rows: [...f.rows].reverse(), symmetry: 'none' };
}

/** Build frame rows procedurally from a per-pixel function. */
export function generateRows(
  width: number,
  height: number,
  pixel: (x: number, y: number) => string,
): PixelRows {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += pixel(x, y);
    rows.push(row);
  }
  return rows;
}
