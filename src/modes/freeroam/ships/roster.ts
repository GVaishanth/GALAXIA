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
 *
 * P10.1 expansion (SHIP_EXPANSION.md): four hulls fill the roster's gaps
 * without beating a specialist at its own stat (tests/fleet.test.ts):
 *  - Harrier (pursuit): quick to turn and accelerate, but a thin hull, a
 *    small hold and short sensors; licence after 3 survey runs, cargo price.
 *  - Crane (recovery tug): a tow rig (towRig) halves the towing penalty and a
 *    tough hull carries the load, but it is slow and heavy on the stick;
 *    licence after 2 survey runs, cargo price. Any ship can tow a hull.
 *  - Heron (survey) and Raven (covert): never sold; each is recovered once
 *    from its Raid Box (`salvage`), so licence and cost are empty.
 * All four are light-hardpoint hulls: the heavy rack stays on the medium-class
 * hulls and the nuke bay on the Condor and the Albatross.
 *
 * Crew seats (P05.1): bridge seats besides the pilot's, by hull size and
 * role. The light Swift and the gunship Shrike carry one specialist; the
 * explorer Petrel and the hauler Magpie two; the heavy Condor and the
 * long-range Albatross three. Seats are a capacity only: crew grant no
 * bonus in this stage, and every ship flies with no crew at all.
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
    crewSeats: 2,
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
    crewSeats: 1,
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
    crewSeats: 1,
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
    crewSeats: 3,
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
    crewSeats: 2,
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
    crewSeats: 3,
    mounts: ['primary', 'missile-rack', 'heavy-rack', 'nuke-bay'],
    defaultWeapon: 'plasma',
    licence: [{ kind: 'galaxy', galaxyId: 'lmc' }],
    cost: [
      { resource: 'fuel', amount: 10 },
      { resource: 'crystal', amount: 6 },
    ],
  },
  {
    id: 'harrier',
    name: 'Harrier',
    archetype: 'interceptor',
    role: 'Pursuit interceptor',
    description: 'Narrow forward-swept wings with lit tips over two compact engines. Changes direction faster than anything but the Swift and recharges boost energy fastest; the hull is thin and the hold small.',
    sprite: 'ship.harrier',
    radius: 9,
    base: { hull: 70, shield: 80, shieldRegen: 7, accel: 1380, maxSpeed: 385, turnRate: 11.8, energy: 85, energyRegen: 27, cargo: 25, sensor: 800, travel: 1.05 },
    slots: { weapon: 1, shield: 1, engine: 1, sensor: 1, cargo: 0 },
    weaponClasses: ['light'],
    stock: { weapon: ['needle-repeater'], shield: ['deflector'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: [] },
    crewSeats: 1,
    mounts: ['primary', 'missile-rack'],
    defaultWeapon: 'plasma',
    licence: [{ kind: 'surveys', count: 3 }],
    cost: [
      { resource: 'alloy', amount: 10 },
      { resource: 'fuel', amount: 8 },
    ],
  },
  {
    id: 'crane',
    name: 'Crane',
    archetype: 'salvager',
    role: 'Recovery tug',
    description: 'A broad industrial frame on outrigger stabilizers, with a tow hook in the reinforced tail. Its rig halves the drag of a towed hull; slow and heavy on the stick.',
    sprite: 'ship.crane',
    radius: 14,
    base: { hull: 140, shield: 95, shieldRegen: 5, accel: 1000, maxSpeed: 300, turnRate: 6.8, energy: 90, energyRegen: 18, cargo: 70, sensor: 800, travel: 1.2 },
    slots: { weapon: 1, shield: 1, engine: 1, sensor: 1, cargo: 2 },
    weaponClasses: ['light'],
    stock: { weapon: ['pulse-cannon'], shield: ['deflector'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: ['cargo-pod'] },
    crewSeats: 2,
    mounts: ['primary', 'missile-rack'],
    defaultWeapon: 'plasma',
    licence: [{ kind: 'surveys', count: 2 }],
    cost: [
      { resource: 'scrap', amount: 14 },
      { resource: 'alloy', amount: 8 },
    ],
    towRig: 0.5,
  },
  {
    id: 'heron',
    name: 'Heron',
    archetype: 'explorer',
    role: 'Survey ship',
    description: 'An elongated survey hull with offset sensor fins and a long starboard antenna. Long sensors and an efficient drive, but a light hull. Recovered, never sold.',
    sprite: 'ship.heron',
    radius: 11,
    base: { hull: 75, shield: 90, shieldRegen: 6, accel: 1100, maxSpeed: 360, turnRate: 8.5, energy: 105, energyRegen: 24, cargo: 40, sensor: 1150, travel: 0.85 },
    slots: { weapon: 1, shield: 1, engine: 1, sensor: 2, cargo: 1 },
    weaponClasses: ['light'],
    stock: { weapon: ['pulse-cannon'], shield: ['deflector'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: ['cargo-pod'] },
    crewSeats: 2,
    mounts: ['primary', 'missile-rack'],
    defaultWeapon: 'plasma',
    licence: [],
    cost: [],
    salvage: { system: 'milky-way/kestrel-verge', box: [600, 2400], hull: [600, 2550] },
  },
  {
    id: 'raven',
    name: 'Raven',
    archetype: 'scout',
    role: 'Covert runner',
    description: 'A low, compact delta with split rear fins and one small, dim engine. Quick and hard to pin down, with a thin hull and a small hold. Recovered, never sold.',
    sprite: 'ship.raven',
    radius: 8,
    base: { hull: 65, shield: 85, shieldRegen: 6, accel: 1300, maxSpeed: 375, turnRate: 10.5, energy: 95, energyRegen: 22, cargo: 35, sensor: 850, travel: 0.95 },
    slots: { weapon: 1, shield: 1, engine: 1, sensor: 1, cargo: 0 },
    weaponClasses: ['light'],
    stock: { weapon: ['needle-repeater'], shield: ['deflector'], engine: ['ion-drive'], sensor: ['survey-scanner'], cargo: [] },
    crewSeats: 1,
    mounts: ['primary', 'missile-rack'],
    defaultWeapon: 'plasma',
    licence: [],
    cost: [],
    salvage: { system: 'milky-way/lantern-gate', box: [600, 900], hull: [600, 1050] },
  },
];

export const SHIP_BY_ID: ReadonlyMap<ShipId, ShipDef> = new Map(SHIPS.map((s) => [s.id, s]));
