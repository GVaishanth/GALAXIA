import { PLAYER_DUAL, PLAYER_FIGHTER } from './player.ts';
import { ENEMY_COMMANDER, ENEMY_INTERCEPTOR, ENEMY_SCOUT } from './enemies.ts';
import { SPECIAL_PHANTOM, SPECIAL_SOVEREIGN, SPECIAL_STINGER } from './specials.ts';
import { BEAM_TRACTOR, EXPLOSION_ENEMY, EXPLOSION_PLAYER, FX_HIT, SHOT_ENEMY, SHOT_PLAYER } from './effects.ts';
import { FX_SHIELD_IMPACT, SHIP_ALBATROSS, SHIP_CONDOR, SHIP_MAGPIE, SHIP_PETREL, SHIP_SHRIKE, SHIP_SWIFT } from './fleet.ts';
import { FOE_CAPITAL, FOE_ELITE, FOE_HAULER, FOE_HEAVY, FOE_LANCER, FOE_PICKET, FOE_RAIDER, FOE_RECON } from './foes.ts';
import type { VariantId } from './variants.ts';

export { VARIANTS, type VariantId } from './variants.ts';

/** Every sprite in the game, keyed by registry id. */
export const SPRITES = {
  [PLAYER_FIGHTER.id]: PLAYER_FIGHTER,
  [PLAYER_DUAL.id]: PLAYER_DUAL,
  [ENEMY_SCOUT.id]: ENEMY_SCOUT,
  [ENEMY_INTERCEPTOR.id]: ENEMY_INTERCEPTOR,
  [ENEMY_COMMANDER.id]: ENEMY_COMMANDER,
  [SPECIAL_STINGER.id]: SPECIAL_STINGER,
  [SPECIAL_PHANTOM.id]: SPECIAL_PHANTOM,
  [SPECIAL_SOVEREIGN.id]: SPECIAL_SOVEREIGN,
  [SHOT_PLAYER.id]: SHOT_PLAYER,
  [SHOT_ENEMY.id]: SHOT_ENEMY,
  [BEAM_TRACTOR.id]: BEAM_TRACTOR,
  [EXPLOSION_ENEMY.id]: EXPLOSION_ENEMY,
  [EXPLOSION_PLAYER.id]: EXPLOSION_PLAYER,
  [FX_HIT.id]: FX_HIT,
  // Free Roam fleet (Prompt 8)
  [SHIP_PETREL.id]: SHIP_PETREL,
  [SHIP_SWIFT.id]: SHIP_SWIFT,
  [SHIP_SHRIKE.id]: SHIP_SHRIKE,
  [SHIP_CONDOR.id]: SHIP_CONDOR,
  [SHIP_MAGPIE.id]: SHIP_MAGPIE,
  [SHIP_ALBATROSS.id]: SHIP_ALBATROSS,
  [FX_SHIELD_IMPACT.id]: FX_SHIELD_IMPACT,
  // Free Roam enemies (Prompt 9)
  [FOE_RAIDER.id]: FOE_RAIDER,
  [FOE_PICKET.id]: FOE_PICKET,
  [FOE_LANCER.id]: FOE_LANCER,
  [FOE_HEAVY.id]: FOE_HEAVY,
  [FOE_RECON.id]: FOE_RECON,
  [FOE_HAULER.id]: FOE_HAULER,
  [FOE_ELITE.id]: FOE_ELITE,
  [FOE_CAPITAL.id]: FOE_CAPITAL,
} as const;

export type SpriteRegistry = typeof SPRITES;
export type SpriteId = keyof SpriteRegistry;

export type SpriteCategory = 'player' | 'enemy' | 'special' | 'effect' | 'fleet' | 'foe';

/**
 * A "look": one presentable appearance (sprite + state + optional variant).
 * Gameplay code will ask for looks; the hangar and sheet export enumerate them.
 */
export interface Look {
  readonly label: string;
  readonly category: SpriteCategory;
  readonly sprite: SpriteId;
  readonly state: string;
  readonly variant?: VariantId;
  /** Alternate with the base look at this interval (rescue blink, hit flash demo). */
  readonly blinkMs?: number;
}

export const LOOKS: readonly Look[] = [
  { label: 'Aster: flight', category: 'player', sprite: 'player.fighter', state: 'idle' },
  { label: 'Aster: hit flash', category: 'player', sprite: 'player.fighter', state: 'idle', variant: 'flash' },
  { label: 'Aster: captured', category: 'player', sprite: 'player.fighter', state: 'captured', variant: 'captive' },
  { label: 'Aster: rescued', category: 'player', sprite: 'player.fighter', state: 'rescued', variant: 'rescued', blinkMs: 160 },
  { label: 'Aster: destroyed', category: 'player', sprite: 'fx.explosion.player', state: 'burst' },
  { label: 'Aster Twin', category: 'player', sprite: 'player.dual', state: 'idle' },
  { label: 'Warden: formation', category: 'enemy', sprite: 'enemy.commander', state: 'formation' },
  { label: 'Warden: attack', category: 'enemy', sprite: 'enemy.commander', state: 'attack' },
  { label: 'Warden: capture', category: 'enemy', sprite: 'enemy.commander', state: 'capture' },
  { label: 'Warden: damaged', category: 'enemy', sprite: 'enemy.commander', state: 'formation', variant: 'damaged' },
  { label: 'Razorwing: flight', category: 'enemy', sprite: 'enemy.interceptor', state: 'formation' },
  { label: 'Razorwing: hit', category: 'enemy', sprite: 'enemy.interceptor', state: 'attack', variant: 'flash' },
  { label: 'Razorwing: destroyed', category: 'enemy', sprite: 'fx.explosion.enemy', state: 'burst' },
  { label: 'Mite: formation', category: 'enemy', sprite: 'enemy.scout', state: 'formation' },
  { label: 'Mite: attack', category: 'enemy', sprite: 'enemy.scout', state: 'attack' },
  { label: 'Barbtail', category: 'special', sprite: 'special.stinger', state: 'flight' },
  { label: 'Wisp', category: 'special', sprite: 'special.phantom', state: 'flight' },
  { label: 'Regent', category: 'special', sprite: 'special.sovereign', state: 'flight' },
  { label: 'Aster bolt', category: 'effect', sprite: 'fx.shot.player', state: 'fly' },
  { label: 'Hostile spark', category: 'effect', sprite: 'fx.shot.enemy', state: 'fly' },
  { label: 'Impact spark', category: 'effect', sprite: 'fx.hit', state: 'spark' },
  { label: 'Tractor beam', category: 'effect', sprite: 'fx.beam.tractor', state: 'active' },
  { label: 'Petrel: idle', category: 'fleet', sprite: 'ship.petrel', state: 'idle' },
  { label: 'Petrel: engine', category: 'fleet', sprite: 'ship.petrel', state: 'thrust' },
  { label: 'Petrel: boost', category: 'fleet', sprite: 'ship.petrel', state: 'boost' },
  { label: 'Petrel: damaged', category: 'fleet', sprite: 'ship.petrel', state: 'thrust', variant: 'scorched' },
  { label: 'Swift: idle', category: 'fleet', sprite: 'ship.swift', state: 'idle' },
  { label: 'Swift: engine', category: 'fleet', sprite: 'ship.swift', state: 'thrust' },
  { label: 'Swift: boost', category: 'fleet', sprite: 'ship.swift', state: 'boost' },
  { label: 'Swift: damaged', category: 'fleet', sprite: 'ship.swift', state: 'thrust', variant: 'scorched' },
  { label: 'Shrike: idle', category: 'fleet', sprite: 'ship.shrike', state: 'idle' },
  { label: 'Shrike: engine', category: 'fleet', sprite: 'ship.shrike', state: 'thrust' },
  { label: 'Shrike: boost', category: 'fleet', sprite: 'ship.shrike', state: 'boost' },
  { label: 'Shrike: damaged', category: 'fleet', sprite: 'ship.shrike', state: 'thrust', variant: 'scorched' },
  { label: 'Condor: idle', category: 'fleet', sprite: 'ship.condor', state: 'idle' },
  { label: 'Condor: engine', category: 'fleet', sprite: 'ship.condor', state: 'thrust' },
  { label: 'Condor: boost', category: 'fleet', sprite: 'ship.condor', state: 'boost' },
  { label: 'Condor: damaged', category: 'fleet', sprite: 'ship.condor', state: 'thrust', variant: 'scorched' },
  { label: 'Magpie: idle', category: 'fleet', sprite: 'ship.magpie', state: 'idle' },
  { label: 'Magpie: engine', category: 'fleet', sprite: 'ship.magpie', state: 'thrust' },
  { label: 'Magpie: boost', category: 'fleet', sprite: 'ship.magpie', state: 'boost' },
  { label: 'Magpie: damaged', category: 'fleet', sprite: 'ship.magpie', state: 'thrust', variant: 'scorched' },
  { label: 'Albatross: idle', category: 'fleet', sprite: 'ship.albatross', state: 'idle' },
  { label: 'Albatross: engine', category: 'fleet', sprite: 'ship.albatross', state: 'thrust' },
  { label: 'Albatross: boost', category: 'fleet', sprite: 'ship.albatross', state: 'boost' },
  { label: 'Albatross: damaged', category: 'fleet', sprite: 'ship.albatross', state: 'thrust', variant: 'scorched' },
  { label: 'Shield impact', category: 'fleet', sprite: 'fx.shield.impact', state: 'flare' },
  ...foeLooks(),
];

/** Free Roam enemy looks: every family in Red Tally colours, then each faction's flagship-light and worn looks. */
function foeLooks(): Look[] {
  const fam = [
    ['foe.raider', 'Raider'], ['foe.picket', 'Picket'], ['foe.lancer', 'Lancer'], ['foe.heavy', 'Heavy'],
    ['foe.recon', 'Recon'], ['foe.hauler', 'Hauler'], ['foe.elite', 'Elite'], ['foe.capital', 'Capital'],
  ] as const;
  const out: Look[] = fam.map(([sprite, label]) => ({ label: `${label} (Red Tally)`, category: 'foe' as const, sprite, state: 'fly' }));
  out.push({ label: 'Picket: worn (Red Tally)', category: 'foe', sprite: 'foe.picket', state: 'fly', variant: 'tallyWorn' });
  out.push({ label: 'Hauler: disabled (Red Tally)', category: 'foe', sprite: 'foe.hauler', state: 'drift', variant: 'tallyWorn' });
  for (const [variant, worn, name] of [['gleaners', 'gleanersWorn', 'Gleaners'], ['cordon', 'cordonWorn', 'Cordon'], ['tessellate', 'tessellateWorn', 'Tessellate']] as const) {
    for (const [sprite, label] of fam) out.push({ label: `${label} (${name})`, category: 'foe', sprite, state: 'fly', variant });
    out.push({ label: `Picket: worn (${name})`, category: 'foe', sprite: 'foe.picket', state: 'fly', variant: worn });
  }
  return out;
}
