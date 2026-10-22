/**
 * Stage insignia (Stage 4): original pixel badges shown beside the stage
 * number, one per denomination in STAGE_BADGE_VALUES (stage 17 = 10 + 5 + 1 + 1).
 * Designs are GALAXIA's own (pennants, chevron, diamond, star, crown).
 *
 * Legend: W white  R red  Y gold  B blue  C cyan  P violet  . transparent
 */
import type { ColorRole } from '../config/palette.ts';

export const INSIGNIA_PALETTE: Readonly<Record<string, ColorRole>> = Object.freeze({
  W: 'fx.white',
  R: 'interceptor.wing',
  Y: 'scout.body',
  B: 'scout.wing',
  C: 'player.trim',
  P: 'phantom.body',
});

/** Badge grids keyed by denomination. Bottom-aligned in a 7 x 12 cell. */
export const INSIGNIA: Readonly<Record<number, readonly string[]>> = Object.freeze({
  1: ['W......', 'WRRRR..', 'WRRRRRR', 'WRRWRR.', 'WRRRR..', 'W......', 'W......', 'W......', 'W......', 'W......', 'WW.....', 'WW.....'],
  5: ['W......', 'WBBBBBB', 'WBCCCBB', 'WBBBBB.', 'WBCCCBB', 'WBBBBBB', 'W......', 'W......', 'W......', 'W......', 'WW.....', 'WW.....'],
  10: ['YYYYYYY', 'YRRRRRY', 'YRYYYRY', 'YYRRRYY', 'YRYYYRY', '.YRRRY.', '..YRY..', '...Y...'],
  20: ['...W...', '..WCW..', '.WCCCW.', 'WCCBCCW', '.WCCCW.', '..WCW..', '...W...'],
  30: ['...Y...', '..YYY..', 'YYYYYYY', '.YYWYY.', '..YYY..', '.YY.YY.', 'YY...YY'],
  50: ['Y..Y..Y', 'YY.Y.YY', 'YYYYYYY', 'YRYWYRY', 'YYYYYYY', '.PPPPP.'],
});

export const INSIGNIA_CELL = { width: 7, height: 12 } as const;
