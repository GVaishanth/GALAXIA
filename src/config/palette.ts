/**
 * GALAXIA colour roles.
 *
 * Every colour used by sprites, effects and in-canvas UI is a named role here.
 * Sprite definitions reference roles (never hex values) so related sprites stay
 * consistent and palette swaps (hit flash, captive, damaged) are data, not code.
 *
 * Hue families (see docs/design/VISUAL_DESIGN_SYSTEM.md):
 *   player        ivory hull + cyan instruments + ember engine
 *   scout         amber body + ultramarine wings
 *   interceptor   crimson wings + pale body + blue accents
 *   commander     emerald + gold (damaged: indigo)
 *   stinger       chartreuse + orange tail
 *   phantom       magenta + silver
 *   sovereign     gold + crimson + royal blue
 *   player shots  cyan-white      enemy shots  vermilion/yellow
 *   tractor beam  periwinkle blue
 */
export const COLORS = {
  // Space
  'space.void': '#06070f',
  'space.letterbox': '#030409',
  /** The thin rule around the arena where the screen has margins (the edge enemies never cross). */
  'space.edge': '#2b3766',
  'star.dim': '#353b57',
  'star.mid': '#555e80',
  'star.warm': '#6b5650',
  'star.cool': '#3d5b6e',
  'star.bright': '#8d96b8',

  // Player fighter
  'player.hull.light': '#fbf8ee',
  'player.hull': '#d9d5c9',
  'player.hull.shade': '#9aa2b3',
  'player.hull.dark': '#5a6378',
  'player.trim': '#2ec4e6',
  'player.trim.deep': '#156e98',
  'player.cockpit': '#5cefff',
  'player.cockpit.glint': '#eaffff',
  'player.light': '#a6fbff',
  'player.engine': '#ff9440',
  'player.engine.core': '#fff1a6',
  'player.nozzle': '#363d56',
  'player.outline': '#161d31',

  // Captured fighter (player ship held by the enemy)
  'captive.hull.light': '#ffdfe2',
  'captive.hull': '#f2707c',
  'captive.hull.shade': '#b5304a',
  'captive.hull.dark': '#6b1729',
  'captive.trim': '#ffb0b8',
  'captive.trim.deep': '#8f1f3a',
  'captive.cockpit': '#ff5f7a',
  'captive.cockpit.glint': '#ffe3e8',
  'captive.light': '#ff8a98',
  'captive.engine': '#c42a4e',
  'captive.engine.core': '#ff9aa8',
  'captive.nozzle': '#3e1020',
  'captive.outline': '#24060f',

  // Scout
  'scout.body.light': '#fff3ad',
  'scout.body': '#ffd23f',
  'scout.body.shade': '#d4871f',
  'scout.stripe': '#6e3412',
  'scout.wing.light': '#a8b8ff',
  'scout.wing': '#5165ff',
  'scout.wing.shade': '#2b33b5',
  'scout.eye': '#ff3b4e',
  'scout.outline': '#18113a',

  // Interceptor
  'interceptor.wing.light': '#ff8f99',
  'interceptor.wing': '#e8304a',
  'interceptor.wing.shade': '#9a1932',
  'interceptor.body.light': '#ffffff',
  'interceptor.body': '#e6dfea',
  'interceptor.body.shade': '#9f96b0',
  'interceptor.accent': '#5a6cff',
  'interceptor.eye': '#ffd23f',
  'interceptor.outline': '#280a17',

  // Commander (tractor ship)
  'commander.hull.light': '#b8ffd2',
  'commander.hull': '#36d27c',
  'commander.hull.shade': '#178a55',
  'commander.hull.dark': '#0c5136',
  'commander.gold': '#ffcf4a',
  'commander.gold.shade': '#bf7a1c',
  'commander.visor': '#ff4f7b',
  'commander.emitter.idle': '#2a3772',
  'commander.emitter': '#86a6ff',
  'commander.emitter.core': '#e6edff',
  'commander.outline': '#06261a',

  // Commander after its first hit
  'commanderHit.hull.light': '#d9d0ff',
  'commanderHit.hull': '#8f7dff',
  'commanderHit.hull.shade': '#5943c7',
  'commanderHit.hull.dark': '#322279',
  'commanderHit.outline': '#130c35',

  // Stinger (scorpion-like transform)
  'stinger.light': '#eaffad',
  'stinger.body': '#a8e83c',
  'stinger.shade': '#5f9a1d',
  'stinger.dark': '#325b14',
  'stinger.tail': '#ff8a2a',
  'stinger.tail.tip': '#ffd166',
  'stinger.eye': '#ff3b4e',
  'stinger.outline': '#112209',

  // Phantom (spy-ship-like transform)
  'phantom.light': '#ffc7f3',
  'phantom.body': '#ec4fd0',
  'phantom.shade': '#9a2392',
  'phantom.dark': '#541558',
  'phantom.silver': '#dadde9',
  'phantom.silver.shade': '#8b90a7',
  'phantom.core': '#fff38a',
  'phantom.outline': '#240727',

  // Sovereign (flagship-like transform)
  'sovereign.gold.light': '#fff4b3',
  'sovereign.gold': '#ffc93a',
  'sovereign.gold.shade': '#c27816',
  'sovereign.red': '#e8304a',
  'sovereign.red.shade': '#8d1730',
  'sovereign.blue': '#4d5fff',
  'sovereign.blue.shade': '#262f8c',
  'sovereign.gem': '#fff0f4',
  'sovereign.outline': '#271304',

  // Free Roam factions (Prompt 9). Hues avoid the player's ivory/cyan;
  // factions are also told apart by emblem, trail and silhouette, never colour alone.
  // Gleaners (scavengers): patched khaki, hazard orange
  'gleaner.hull.light': '#e6d3a3',
  'gleaner.hull': '#b39a62',
  'gleaner.hull.shade': '#7a6a45',
  'gleaner.hull.dark': '#4a402b',
  'gleaner.mark': '#ff9a2e',
  'gleaner.mark.deep': '#a3521a',
  'gleaner.eye': '#ffe066',
  'gleaner.engine': '#ffb347',
  'gleaner.engine.core': '#fff0b0',
  'gleaner.outline': '#1d170c',
  // Red Tally (raiders): graphite, crimson notches
  'tally.hull.light': '#a7a2a8',
  'tally.hull': '#6e6a74',
  'tally.hull.shade': '#4a4650',
  'tally.hull.dark': '#2b2830',
  'tally.mark': '#e2343f',
  'tally.mark.deep': '#7d1422',
  'tally.eye': '#ff5a5a',
  'tally.engine': '#ff4a2e',
  'tally.engine.core': '#ffd0a0',
  'tally.outline': '#120c10',
  // Cordon (security): steel blue and white, amber beacons
  'cordon.hull.light': '#e8eef6',
  'cordon.hull': '#9fb3cc',
  'cordon.hull.shade': '#5f7896',
  'cordon.hull.dark': '#34465e',
  'cordon.mark': '#3d6dff',
  'cordon.mark.deep': '#1d348f',
  'cordon.eye': '#ffc23a',
  'cordon.engine': '#8fa8ff',
  'cordon.engine.core': '#e6f4ff',
  'cordon.outline': '#0b1220',
  // Tessellate (machines): violet plating, acid green lattice
  'tess.hull.light': '#c9b8ff',
  'tess.hull': '#7a5fd1',
  'tess.hull.shade': '#4a3696',
  'tess.hull.dark': '#2a1d5c',
  'tess.mark': '#9dff3a',
  'tess.mark.deep': '#4c8f12',
  'tess.eye': '#c6ff5a',
  'tess.engine': '#9dff3a',
  'tess.engine.core': '#efffd0',
  'tess.outline': '#0e0824',

  // Projectiles
  'shot.player.core': '#f2feff',
  'shot.player.edge': '#63eaff',
  'shot.enemy.core': '#fff27a',
  'shot.enemy.edge': '#ff5a2e',
  'shot.enemy.dark': '#a3201a',

  // Tractor beam
  'beam.light': '#dce6ff',
  'beam.mid': '#7290ff',
  'beam.deep': '#3a4fd4',

  // Effects
  'fx.flash': '#ffffff',
  'fx.rescue': '#ffe45c',
  'fx.white': '#ffffff',
  'fx.yellow': '#ffe45c',
  'fx.orange': '#ff8a2a',
  'fx.red': '#e8304a',
  'fx.smoke': '#5e2645',
  'fx.cyan': '#63eaff',
  'fx.blue': '#4f63ff',

  // In-canvas UI text
  'ui.text': '#f3efe4',
  'ui.text.dim': '#7d84a3',
  'ui.accent': '#ff3b4e',
  'ui.highlight': '#5cefff',
} as const satisfies Record<string, `#${string}`>;

export type ColorRole = keyof typeof COLORS;

/**
 * Roles that emit light. Pixels painted with these roles contribute to the
 * pre-rendered glow layer. Keep this list short: glow is reserved for things
 * that matter (cockpits, engines, shots, beams, explosions).
 */
export const EMISSIVE_ROLES: ReadonlySet<ColorRole> = new Set<ColorRole>([
  'player.cockpit',
  'player.light',
  'player.engine',
  'player.engine.core',
  'captive.cockpit',
  'captive.light',
  'captive.engine.core',
  'commander.visor',
  'commander.emitter',
  'commander.emitter.core',
  'stinger.tail.tip',
  'phantom.core',
  'sovereign.gem',
  'shot.player.core',
  'shot.player.edge',
  'shot.enemy.core',
  'shot.enemy.edge',
  'beam.light',
  'beam.mid',
  'fx.white',
  'fx.yellow',
  'fx.orange',
  'fx.cyan',
  'gleaner.eye',
  'gleaner.engine',
  'gleaner.engine.core',
  'tally.eye',
  'tally.engine',
  'tally.engine.core',
  'cordon.eye',
  'cordon.engine',
  'cordon.engine.core',
  'tess.eye',
  'tess.engine',
  'tess.engine.core',
]);

export function hexToRgb(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
