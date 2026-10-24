/**
 * The Free Roam ship roster (Free Roam Prompt 8): the only place ship balance
 * lives. UI, combat and flight read these values through equipment.ts
 * deriveShip(); nothing else hard-codes a ship number.
 *
 * Design (FR-TD-46, FR-TD-47):
 *  - The Petrel (explorer) is the starter: owned from the first flight, with
 *    exactly the Prompt 7 flight feel, so basic mobility and the first survey
 *    never need anything else.
 *  - Every other ship has a licence (the same unlock requirements the maps
 *    use: survey runs, a visited galaxy, a milestone) and a price in cargo
 *    resources. The first two licences open after the first survey run, and
 *    the Magpie's price is affordable from the starting sector's (Sol's)
 *    salvage alone (tests/fleet.test.ts checks this against the generator).
 *  - Costs only use resources that Milky Way and LMC sectors yield, and every
 *    price fits the starter's hold, so no ship needs grinding or a bigger
 *    ship first.
 *  - Ships trade strengths: nothing is strictly better than the starter.
 *
 * Weapon mounts (Combat P03B, FR-TD-88; config/weapons.ts):
 *  - every ship: the primary gun and the pilot missile rack (the lock-on
 *    missile every ship already fired in Combat P03);
 *  - heavy missile rack: the hulls whose hardpoints take medium weapons
 *    (Petrel, Shrike, Condor, Albatross); the light-only Swift and Magpie
 *    have no room for it (tests/armory.test.ts keeps the two in step);
 *  - nuke bay: only the Condor and the Albatross, the two advanced ships
 *    behind the late licences (the Lantern Gate milestone, a visit to the
 *    Large Magellanic Cloud). The owner chose this set.
 */
import type { ShipDef, ShipId } from './types.ts';

export const STARTER_SHIP: ShipId = 'petrel';

export const SHIPS: readonly ShipDef[] = [
  {
    id: 'petrel',
    name: 'Petrel',
    archetype: 'explorer',
    role: 'Explorer',
    description: 'Balanced survey craft with straight wings and winglet pods. Good at everything, best at nothing: the Haven Guild issues one to every new pilot.',
    sprite: 'ship.petrel',
    radius: 12,
    base: { hull: 100, shield: 100, shieldRegen: 6, accel: 1150, maxSpeed: 340, turnRate: 9, energy: 100, energyRegen: 20, cargo: 60, sensor: 900, travel: 1 },
    slots: { weapon: 1, shield: 1, engine: 1, sensor: 1, cargo: 1 },
    weaponClasses: ['light', 'medium'],
    stock: { weapon: ['pulse-cannon'], shield: ['deflector'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: ['cargo-pod'] },
    mounts: ['primary', 'missile-rack', 'heavy-rack'],
    defaultWeapon: 'plasma',
    licence: [],
    cost: [],
  },
  {
    id: 'swift',
    name: 'Swift',
    archetype: 'scout',
    role: 'Scout',
    description: 'A small needle with a swept delta and one engine. The fastest, most agile hull in the yard, with a thin hull and a tiny hold.',
    sprite: 'ship.swift',
    radius: 9,
    base: { hull: 60, shield: 70, shieldRegen: 6, accel: 1400, maxSpeed: 400, turnRate: 12, energy: 90, energyRegen: 22, cargo: 30, sensor: 1000, travel: 0.9 },
    slots: { weapon: 1, shield: 1, engine: 2, sensor: 1, cargo: 0 },
    weaponClasses: ['light'],
    stock: { weapon: ['needle-repeater'], shield: ['deflector'], engine: ['sprint-thrusters'], sensor: ['survey-scanner'], cargo: [] },
    mounts: ['primary', 'missile-rack'],
    defaultWeapon: 'plasma',
    licence: [{ kind: 'surveys', count: 1 }],
    cost: [
      { resource: 'scrap', amount: 10 },
      { resource: 'fuel', amount: 4 },
    ],
  },
  {
    id: 'shrike',
    name: 'Shrike',
    archetype: 'interceptor',
    role: 'Interceptor',
    description: 'Forward-swept wings end in cannon prongs. A twin battery and quick handling make it the strongest gunship for its size; its sensors are short.',
    sprite: 'ship.shrike',
    radius: 11,
    base: { hull: 85, shield: 90, shieldRegen: 7, accel: 1350, maxSpeed: 380, turnRate: 11.5, energy: 80, energyRegen: 20, cargo: 35, sensor: 750, travel: 1.1 },
    slots: { weapon: 2, shield: 1, engine: 1, sensor: 1, cargo: 0 },
    weaponClasses: ['light', 'medium'],
    stock: { weapon: ['twin-pulse'], shield: ['deflector'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: [] },
    mounts: ['primary', 'missile-rack', 'heavy-rack'],
    defaultWeapon: 'plasma',
    licence: [{ kind: 'surveys', count: 2 }],
    cost: [
      { resource: 'alloy', amount: 10 },
      { resource: 'scrap', amount: 14 },
    ],
  },
  {
    id: 'condor',
    name: 'Condor',
    archetype: 'defender',
    role: 'Defender',
    description: 'A broad armoured hull between two shield-emitter pylons, pushed by four engines. Takes punishment and hits hard, but turns slowly.',
    sprite: 'ship.condor',
    radius: 15,
    base: { hull: 170, shield: 130, shieldRegen: 6, accel: 900, maxSpeed: 285, turnRate: 6.5, energy: 70, energyRegen: 16, cargo: 60, sensor: 700, travel: 1.25 },
    slots: { weapon: 2, shield: 2, engine: 1, sensor: 1, cargo: 1 },
    weaponClasses: ['light', 'medium', 'heavy'],
    stock: { weapon: ['lance-driver'], shield: ['bastion-array'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: ['cargo-pod'] },
    mounts: ['primary', 'missile-rack', 'heavy-rack', 'nuke-bay'],
    defaultWeapon: 'plasma',
    licence: [{ kind: 'milestone', milestoneId: 'lantern-gate' }],
    cost: [
      { resource: 'alloy', amount: 18 },
      { resource: 'scrap', amount: 20 },
    ],
  },
  {
    id: 'magpie',
    name: 'Magpie',
    archetype: 'salvager',
    role: 'Salvager',
    description: 'Two grab arms frame a tractor lens; the side pods are cargo bays with their own engines. The biggest hold in the yard, but heavy on the stick.',
    sprite: 'ship.magpie',
    radius: 14,
    base: { hull: 120, shield: 80, shieldRegen: 5, accel: 950, maxSpeed: 300, turnRate: 7, energy: 80, energyRegen: 18, cargo: 90, sensor: 850, travel: 1.15 },
    slots: { weapon: 1, shield: 1, engine: 1, sensor: 1, cargo: 3 },
    weaponClasses: ['light'],
    stock: { weapon: ['pulse-cannon'], shield: ['deflector'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: ['salvage-rig', 'cargo-pod'] },
    mounts: ['primary', 'missile-rack'],
    defaultWeapon: 'plasma',
    licence: [{ kind: 'surveys', count: 1 }],
    cost: [
      { resource: 'scrap', amount: 12 },
      { resource: 'ice', amount: 10 },
    ],
  },
  {
    id: 'albatross',
    name: 'Albatross',
    archetype: 'long-range',
    role: 'Long-range vessel',
    description: 'A long fuselage on very long, thin wings, with a sensor mast at the nose and a cruise drive. Sees furthest and travels cheapest; slow to turn.',
    sprite: 'ship.albatross',
    radius: 13,
    base: { hull: 90, shield: 100, shieldRegen: 6, accel: 1000, maxSpeed: 370, turnRate: 7.5, energy: 110, energyRegen: 20, cargo: 60, sensor: 1200, travel: 0.75 },
    slots: { weapon: 1, shield: 1, engine: 1, sensor: 2, cargo: 1 },
    weaponClasses: ['light', 'medium'],
    stock: { weapon: ['pulse-cannon'], shield: ['deflector'], engine: ['cruise-drive'], sensor: ['deep-array'], cargo: ['cargo-pod'] },
    mounts: ['primary', 'missile-rack', 'heavy-rack', 'nuke-bay'],
    defaultWeapon: 'plasma',
    licence: [{ kind: 'galaxy', galaxyId: 'lmc' }],
    cost: [
      { resource: 'fuel', amount: 10 },
      { resource: 'crystal', amount: 6 },
    ],
  },
];

export const SHIP_BY_ID: ReadonlyMap<ShipId, ShipDef> = new Map(SHIPS.map((s) => [s.id, s]));
