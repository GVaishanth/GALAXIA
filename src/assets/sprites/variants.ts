import type { ColorRole } from '../../config/palette.ts';
import type { PaletteVariant } from './format/types.ts';

/** Map every `${from}.*` role to `${to}.*` for the listed suffixes. */
function familySwap(from: string, to: string, suffixes: readonly string[]): Partial<Record<ColorRole, ColorRole>> {
  const swap: Partial<Record<ColorRole, ColorRole>> = {};
  for (const s of suffixes) swap[`${from}.${s}` as ColorRole] = `${to}.${s}` as ColorRole;
  return swap;
}

const PLAYER_SUFFIXES = [
  'hull.light', 'hull', 'hull.shade', 'hull.dark', 'trim', 'trim.deep', 'cockpit',
  'cockpit.glint', 'light', 'engine', 'engine.core', 'nozzle', 'outline',
] as const;

const FOE_SUFFIXES = ['hull.light', 'hull', 'hull.shade', 'hull.dark', 'mark', 'mark.deep', 'eye', 'engine', 'engine.core'] as const;

/** Free Roam enemy faction look: the base sprites are authored in Red Tally roles (`tally.*`). */
function faction(id: string, to: string): PaletteVariant {
  return { id, swap: familySwap('tally', to, FOE_SUFFIXES), outline: `${to}.outline` as ColorRole };
}

/** Badly damaged enemy hull: plating one step darker, markings and sensor eye dimmed. */
function worn(id: string, to: string): PaletteVariant {
  const r = (x: string) => `${to}.${x}` as ColorRole;
  return {
    id,
    swap: {
      ...familySwap('tally', to, FOE_SUFFIXES),
      'tally.hull.light': r('hull.shade'),
      'tally.hull': r('hull.shade'),
      'tally.hull.shade': r('hull.dark'),
      'tally.mark': r('mark.deep'),
      'tally.eye': r('mark.deep'),
    },
    outline: r('outline'),
  };
}

export const VARIANTS = {
  /** Single-frame white silhouette on hit (outline stays dark so it still reads). */
  flash: { id: 'flash', all: 'fx.flash', noGlow: true },
  /** Player ship captured by a Warden: re-coloured to the enemy's crimson. */
  captive: { id: 'captive', swap: familySwap('player', 'captive', PLAYER_SUFFIXES) },
  /** Player ship being returned: gold outline, blinked against the base look. */
  rescued: { id: 'rescued', outline: 'fx.rescue' },
  /** Warden after its first hit: emerald carapace turns indigo. */
  damaged: {
    id: 'damaged',
    swap: familySwap('commander', 'commanderHit', ['hull.light', 'hull', 'hull.shade', 'hull.dark', 'outline']),
  },
  /**
   * Free Roam ship with a badly damaged hull (Prompt 8): the plating darkens and
   * the trim, lights and canopy dim. Remaps to existing player roles only, so no
   * new colour enters the palette and the player / enemy separation holds.
   */
  scorched: {
    id: 'scorched',
    swap: {
      'player.hull.light': 'player.hull.shade',
      'player.hull': 'player.hull.shade',
      'player.hull.shade': 'player.hull.dark',
      'player.trim': 'player.trim.deep',
      'player.light': 'player.trim.deep',
      'player.cockpit': 'player.trim',
      'player.cockpit.glint': 'player.cockpit',
    },
  },
  /* Free Roam enemy factions (Prompt 9); Red Tally is the sprites' base palette. */
  gleaners: faction('gleaners', 'gleaner'),
  cordon: faction('cordon', 'cordon'),
  tessellate: faction('tessellate', 'tess'),
  tallyWorn: worn('tallyWorn', 'tally'),
  gleanersWorn: worn('gleanersWorn', 'gleaner'),
  cordonWorn: worn('cordonWorn', 'cordon'),
  tessellateWorn: worn('tessellateWorn', 'tess'),
} as const satisfies Record<string, PaletteVariant>;

export type VariantId = keyof typeof VARIANTS;
