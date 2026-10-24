/**
 * Combat P03B armory: the weapon catalogue (config/weapons.ts), ship mounts and
 * the start weapon / switching cycle rules (ships/armory.ts), the view model
 * (ships/armoryView.ts), persistence of the setup and of the ammunition, and the
 * module boundaries of the armory page.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanOrdnance, initialOrdnance, isWeaponId, PRIMARY_WEAPON, restockOrdnance, STOCKED_WEAPONS, WEAPON_BY_ID, WEAPON_IDS, WEAPONS, weaponIssues, type OrdnanceWeapon, type WeaponId } from '../src/config/weapons.ts';
import { MISSILE } from '../src/modes/freeroam/combat/playerMissile.ts';
import { EMPTY_PROFILE, loadProfile, saveProfile, withFleet, withOrdnance } from '../src/modes/freeroam/profile.ts';
import { armedLoadout, canMount, canStartWith, cleanSetup, compatibleWeapons, defaultSetup, defaultStart, mountReason, refusalText, setInRotation, setStart, setupOf, shipsFor } from '../src/modes/freeroam/ships/armory.ts';
import { ammoLine, availability, blastCatch, blastDamageAt, compatibility, flightDistance, ordnanceComparison, ordnanceRows, weaponState } from '../src/modes/freeroam/ships/armoryView.ts';
import { fleetFromSaved, fleetToSaved, selectShip, STARTER_FLEET, type FleetState } from '../src/modes/freeroam/ships/hangar.ts';
import { SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { SHIP_IDS } from '../src/modes/freeroam/ships/types.ts';
import { backFrom, STATION_TABS, stationOverview } from '../src/modes/freeroam/ui/stationModel.ts';
import { MemoryStore } from '../src/persistence/storage.ts';

const ord = (id: WeaponId): OrdnanceWeapon => {
  const w = WEAPON_BY_ID.get(id)!;
  if (w.fire !== 'ordnance') throw new Error(`${id} is not ordnance`);
  return w;
};
const fleetOf = (owned: FleetState['owned'], active: FleetState['active'] = owned[0]!): FleetState => ({ active, owned, loadouts: {} });
const okFleet = (r: ReturnType<typeof setStart>): FleetState => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.fleet;
};

describe('weapon catalogue', () => {
  it('has exactly the four weapons with unique ids, each passing validation', () => {
    expect(WEAPONS.map((w) => w.id)).toEqual([...WEAPON_IDS]);
    expect(new Set(WEAPONS.map((w) => w.id)).size).toBe(4);
    expect(new Set(WEAPONS.map((w) => w.name)).size).toBe(4);
    expect(new Set(WEAPONS.map((w) => w.icon)).size).toBe(4); // a distinct silhouette each
    for (const w of WEAPONS) expect(weaponIssues(w), w.id).toEqual([]);
    expect(isWeaponId('plasma')).toBe(true);
    expect(isWeaponId('laser')).toBe(false);
    expect(WEAPON_BY_ID.size).toBe(4);
  });

  it('validation catches broken entries (it is not a rubber stamp)', () => {
    const heavy = ord('heavy-missile');
    expect(weaponIssues({ ...heavy, cooldownTicks: 0 })).not.toEqual([]);
    expect(weaponIssues({ ...heavy, ammo: { kind: 'stock', capacity: 4, initial: 9, restock: 'dock' } })).not.toEqual([]);
    const nuke = ord('nuke');
    expect(weaponIssues({ ...nuke, dilation: { ...nuke.dilation!, scale: 1.5 } })).not.toEqual([]);
    const plasma = WEAPON_BY_ID.get('plasma')!;
    expect(weaponIssues({ ...plasma, ammo: { kind: 'energy', cost: 5 } } as typeof plasma)).not.toEqual([]);
  });

  it('describes the four roles with their real trade-offs', () => {
    const plasma = WEAPON_BY_ID.get('plasma')!;
    expect(plasma.fire).toBe('fitted-gun');
    expect(plasma.ammo.kind).toBe('unlimited');
    expect(plasma.category).toBe('beam');
    expect(PRIMARY_WEAPON).toBe('plasma');

    const heavy = ord('heavy-missile');
    const lock = ord('lock-missile');
    const nuke = ord('nuke');
    expect(heavy.guidance.kind).toBe('none'); // direct fire, no lock
    expect(lock.guidance.kind).toBe('lock');
    expect(heavy.blast!.radius).toBeGreaterThan(lock.blast!.radius); // guidance traded against blast
    expect(nuke.blast!.radius).toBeGreaterThan(heavy.blast!.radius);
    expect(heavy.ammo).toMatchObject({ kind: 'stock', capacity: 4 });
    expect(nuke.ammo).toMatchObject({ kind: 'stock', capacity: 1 });
    expect(lock.ammo).toMatchObject({ kind: 'energy', cost: 30 });
    expect(nuke.dilation).toMatchObject({ scale: 0.5, durationTicks: 120 }); // 0.5x for 2 s
    expect(heavy.dilation).toBeNull();
    expect(nuke.initialSelectable).toBe(false);
    expect(heavy.initialSelectable).toBe(true);
  });

  it('is the source of the lock-on missile the flight fires today (no second set of numbers)', () => {
    const lock = ord('lock-missile');
    if (lock.guidance.kind !== 'lock') throw new Error('lock guidance expected');
    const q = lock.guidance.acquire;
    expect(MISSILE).toMatchObject({
      range: q.range, cone: q.cone, keepRange: q.keepRange, keepCone: q.keepCone, jammedRangeMul: q.jammedRangeMul, lockTicks: q.lockTicks,
      launchSpeed: lock.projectile.launchSpeed, speed: lock.projectile.speed, accel: lock.projectile.accel, turn: lock.guidance.turn,
      lifeTicks: lock.projectile.lifeTicks, lostLife: lock.guidance.lostLife, damage: lock.impactDamage, cooldownTicks: lock.cooldownTicks, energy: 30,
    });
    // the shipped P03 values (lock 0.3 s, 18 dmg, 12 s cooldown) are unchanged by the move
    expect([MISSILE.lockTicks, MISSILE.damage, MISSILE.cooldownTicks, MISSILE.energy]).toEqual([18, 18, 720, 30]);
    // Combat P03C: every catalogue weapon is flown by the runtime
    expect(lock.runtime.status).toBe('live');
    expect(ord('heavy-missile').runtime.status).toBe('live');
    expect(ord('nuke').runtime.status).toBe('live');
  });
});

describe('ship compatibility (data-defined mounts)', () => {
  it('every ship carries plasma and the lock-on missile; all start with plasma', () => {
    for (const s of SHIPS) {
      expect(canMount(s.id, 'plasma')).toBe(true);
      expect(canMount(s.id, 'lock-missile')).toBe(true);
      expect(s.defaultWeapon).toBe('plasma');
      expect(defaultStart(s.id)).toBe('plasma');
      expect(s.mounts).toContain('primary');
    }
  });

  it('heavy missiles need a medium hardpoint ship; the nuke only Condor and Albatross', () => {
    expect(shipsFor('heavy-missile')).toEqual(['petrel', 'shrike', 'condor', 'albatross']);
    expect(shipsFor('nuke')).toEqual(['condor', 'albatross']);
    expect(shipsFor('nuke').length).toBeLessThan(SHIP_IDS.length);
    for (const s of SHIPS) expect(canMount(s.id, 'heavy-missile')).toBe(s.weaponClasses.includes('medium'));
    expect(compatibleWeapons('swift')).toEqual(['plasma', 'lock-missile']);
    expect(compatibleWeapons('condor')).toEqual(['plasma', 'heavy-missile', 'lock-missile', 'nuke']);
  });

  it('a weapon a ship cannot carry stays inspectable with the reason', () => {
    expect(mountReason('petrel', 'plasma')).toBeNull();
    const why = mountReason('swift', 'nuke')!;
    expect(why).toMatch(/Condor/);
    expect(why).toMatch(/Albatross/);
    expect(mountReason('magpie', 'heavy-missile')).toMatch(/Petrel/);
    const view = availability(STARTER_FLEET, 'petrel', 'nuke');
    expect(view.ok).toBe(false);
    expect(view.text).toBe(mountReason('petrel', 'nuke'));
    expect(compatibility('nuke').filter((c) => c.fits).map((c) => c.ship)).toEqual(['condor', 'albatross']);
  });
});

describe('start weapon and switching cycle', () => {
  const late = fleetOf(['petrel', 'swift', 'condor'], 'condor');

  it('defaults: every compatible weapon in the cycle, plasma first and the start', () => {
    expect(setupOf(STARTER_FLEET, 'petrel')).toEqual({ start: 'plasma', rotation: ['plasma', 'heavy-missile', 'lock-missile'] });
    expect(defaultSetup('condor').rotation).toEqual(['plasma', 'heavy-missile', 'lock-missile', 'nuke']);
    expect(armedLoadout(STARTER_FLEET)).toEqual({ ship: 'petrel', compatible: ['plasma', 'heavy-missile', 'lock-missile'], rotation: ['plasma', 'heavy-missile', 'lock-missile'], start: 'plasma' });
  });

  it('the start weapon can be any carried weapon except the nuke', () => {
    const f = okFleet(setStart(late, 'condor', 'heavy-missile'));
    expect(setupOf(f, 'condor').start).toBe('heavy-missile');
    expect(weaponState(f, 'condor', 'heavy-missile')).toBe('start');
    expect(canStartWith('condor', 'nuke')).toBe(false);
    const n = setStart(late, 'condor', 'nuke');
    expect(n).toMatchObject({ ok: false, reason: 'not-initial' });
    expect(refusalText('not-initial', 'condor', 'nuke')).toMatch(/start/i);
    // a weapon the ship cannot carry, an unknown id, a ship not owned: all refused, fleet untouched
    expect(setStart(late, 'swift', 'heavy-missile')).toMatchObject({ ok: false, reason: 'incompatible' });
    expect(setStart(late, 'condor', 'laser')).toMatchObject({ ok: false, reason: 'unknown-weapon' });
    expect(setStart(late, 'albatross', 'plasma')).toMatchObject({ ok: false, reason: 'not-owned' });
    expect(late.weapons).toBeUndefined();
  });

  it('plasma can never leave the cycle; removing the start weapon falls back to the default', () => {
    expect(setInRotation(late, 'condor', 'plasma', false)).toMatchObject({ ok: false, reason: 'primary-required' });
    const a = okFleet(setStart(late, 'condor', 'heavy-missile'));
    const r = setInRotation(a, 'condor', 'heavy-missile', false);
    expect(r.ok && r.startReset).toBe(true);
    const b = okFleet(r);
    expect(setupOf(b, 'condor')).toEqual({ start: 'plasma', rotation: ['plasma', 'lock-missile', 'nuke'] });
    expect(weaponState(b, 'condor', 'heavy-missile')).toBe('off');
    const back = okFleet(setInRotation(b, 'condor', 'heavy-missile', true));
    expect(setupOf(back, 'condor').rotation).toEqual(['plasma', 'heavy-missile', 'lock-missile', 'nuke']); // catalogue order
    expect(setInRotation(late, 'swift', 'nuke', true)).toMatchObject({ ok: false, reason: 'incompatible' });
    const same = setInRotation(late, 'condor', 'nuke', true);
    expect(same.ok && same.changed).toBe(false);
  });

  it('invalid saved selections are cleaned: unknown and unmountable weapons drop out, plasma returns, the start falls back', () => {
    expect(cleanSetup('petrel', { start: 'nuke', rotation: ['nuke', 'laser', 'heavy-missile'] })).toEqual({ start: 'plasma', rotation: ['plasma', 'heavy-missile'] });
    expect(cleanSetup('swift', { start: 'heavy-missile', rotation: ['heavy-missile', 'lock-missile'] })).toEqual({ start: 'plasma', rotation: ['plasma', 'lock-missile'] });
    expect(cleanSetup('condor', { start: 'nuke', rotation: ['nuke'] })).toEqual({ start: 'plasma', rotation: ['plasma', 'nuke'] });
    // a start weapon missing from the saved cycle is not trusted
    expect(cleanSetup('petrel', { start: 'heavy-missile', rotation: ['plasma'] })).toEqual({ start: 'plasma', rotation: ['plasma'] });
    expect(cleanSetup('petrel', { start: 42, rotation: 'x' })).toEqual(defaultSetup('petrel'));
  });

  it('each ship keeps its own setup; changing ships never carries a weapon the new ship cannot mount', () => {
    let f = okFleet(setStart(late, 'condor', 'heavy-missile'));
    f = okFleet(setStart({ ...f, active: 'petrel' }, 'petrel', 'heavy-missile'));
    f = { ...f, active: 'condor' };
    const sw = selectShip(f, 'swift', true);
    if (!sw.ok) throw new Error('select refused');
    const onSwift = armedLoadout(sw.fleet);
    expect(onSwift).toEqual({ ship: 'swift', compatible: ['plasma', 'lock-missile'], rotation: ['plasma', 'lock-missile'], start: 'plasma' });
    expect(onSwift.rotation).not.toContain('nuke');
    expect(setupOf(sw.fleet, 'condor').start).toBe('heavy-missile'); // kept for when the pilot flies it again
    expect(setupOf(sw.fleet, 'petrel').start).toBe('heavy-missile');
    // a hand-edited fleet claiming a nuke on the Swift is still clean where combat reads it
    const forged: FleetState = { ...sw.fleet, weapons: { swift: { start: 'nuke', rotation: ['plasma', 'nuke', 'heavy-missile'] } } };
    expect(armedLoadout(forged)).toEqual({ ship: 'swift', compatible: ['plasma', 'lock-missile'], rotation: ['plasma'], start: 'plasma' });
  });
});

describe('persistence', () => {
  it('an untouched fleet writes no weapons field (old saves stay the same shape); a configured ship writes its cleaned setup', () => {
    expect(fleetToSaved(STARTER_FLEET)).toEqual({ active: 'petrel', owned: ['petrel'], loadouts: {} });
    const f = okFleet(setStart(STARTER_FLEET, 'petrel', 'heavy-missile'));
    expect(fleetToSaved(f).weapons).toEqual({ petrel: { start: 'heavy-missile', rotation: ['plasma', 'heavy-missile', 'lock-missile'] } });
  });

  it('the start weapon and cycle survive save and reload', () => {
    const store = new MemoryStore();
    let f = okFleet(setStart(STARTER_FLEET, 'petrel', 'heavy-missile'));
    f = okFleet(setInRotation(f, 'petrel', 'lock-missile', false));
    saveProfile(store, withFleet(EMPTY_PROFILE, fleetToSaved(f)));
    const loaded = loadProfile(store);
    expect(loaded.status).toBe('ok');
    const again = fleetFromSaved(loaded.data.fleet);
    expect(setupOf(again, 'petrel')).toEqual({ start: 'heavy-missile', rotation: ['plasma', 'heavy-missile'] });
    expect(armedLoadout(again).start).toBe('heavy-missile');
  });

  it('a tampered save cannot grant a weapon: it loads cleaned, never broken', () => {
    const store = new MemoryStore();
    saveProfile(store, withFleet(EMPTY_PROFILE, fleetToSaved(okFleet(setStart(STARTER_FLEET, 'petrel', 'heavy-missile')))));
    const key = 'galaxia:freeroam';
    const raw = JSON.parse(store.read(key)!) as { fleet: { weapons: Record<string, unknown> } };
    raw.fleet.weapons = { petrel: { start: 'nuke', rotation: ['plasma', 'nuke', 'heavy-missile'] }, condor: { start: 'heavy-missile', rotation: ['plasma'] } };
    store.write(key, JSON.stringify(raw));
    const loaded = loadProfile(store);
    const f = fleetFromSaved(loaded.data.fleet);
    const s = setupOf(f, 'petrel');
    expect(s.rotation).not.toContain('nuke');
    expect(s.rotation[0]).toBe('plasma');
    expect(s.start).not.toBe('nuke');
    expect(f.weapons?.condor).toBeUndefined(); // a ship not owned keeps no setup
    expect(armedLoadout(f).compatible).toEqual(['plasma', 'heavy-missile', 'lock-missile']);
  });

  it('ammunition is one saved store: reloading never refills it, preferences never touch it, docking restocks it', () => {
    expect(initialOrdnance()).toEqual({ 'heavy-missile': 4, nuke: 1 });
    expect(STOCKED_WEAPONS).toEqual(['heavy-missile', 'nuke']);
    expect(EMPTY_PROFILE.ordnance).toEqual({ 'heavy-missile': 4, nuke: 1 });
    const store = new MemoryStore();
    const spent = withOrdnance(EMPTY_PROFILE, { 'heavy-missile': 1, nuke: 0 });
    saveProfile(store, spent);
    expect(loadProfile(store).data.ordnance).toEqual({ 'heavy-missile': 1, nuke: 0 });
    // weapon preferences are fleet data only: they leave the counts alone
    const prefs = withFleet(spent, fleetToSaved(okFleet(setStart(STARTER_FLEET, 'petrel', 'heavy-missile'))));
    expect(prefs.ordnance).toEqual({ 'heavy-missile': 1, nuke: 0 });
    expect(restockOrdnance(prefs.ordnance)).toEqual({ 'heavy-missile': 4, nuke: 1 });
    // damaged counts are clamped, never inflated past the capacity
    expect(cleanOrdnance({ 'heavy-missile': 99, nuke: -3, junk: 5 })).toEqual({ counts: { 'heavy-missile': 4, nuke: 0 }, repaired: true });
    expect(cleanOrdnance(undefined)).toEqual({ counts: { 'heavy-missile': 4, nuke: 1 }, repaired: false });
  });

  it('a profile saved before P03B (no ordnance field) loads with the initial stock', () => {
    const store = new MemoryStore();
    saveProfile(store, EMPTY_PROFILE);
    const raw = JSON.parse(store.read('galaxia:freeroam')!) as Record<string, unknown>;
    delete raw['ordnance'];
    store.write('galaxia:freeroam', JSON.stringify(raw));
    const loaded = loadProfile(store);
    expect(loaded.status).toBe('ok');
    expect(loaded.data.ordnance).toEqual({ 'heavy-missile': 4, nuke: 1 });
  });
});

describe('armory view model', () => {
  it('shows the saved ammunition, never more', () => {
    expect(ammoLine(WEAPON_BY_ID.get('plasma')!, {}, 100).badge).toBe('∞');
    expect(ammoLine(ord('lock-missile'), {}, 100)).toMatchObject({ badge: '30 EN', count: null });
    expect(ammoLine(ord('heavy-missile'), { 'heavy-missile': 2 }, 100)).toMatchObject({ badge: '2 / 4', count: 2, capacity: 4 });
    expect(ammoLine(ord('nuke'), { nuke: 0 }, 100).badge).toBe('0 / 1');
  });

  it('displays the gameplay values themselves', () => {
    for (const id of ['heavy-missile', 'lock-missile', 'nuke'] as const) {
      const w = ord(id);
      const rows = ordnanceRows(w);
      expect(rows.find((r) => r.label === 'BLAST')!.value).toBe(`${w.blast!.radius} px radius`);
      expect(rows.find((r) => r.label === 'DIRECT HIT')!.value).toBe(`${w.impactDamage} dmg`);
      expect(rows.find((r) => r.label === 'COOLDOWN')!.value).toBe(`${(w.cooldownTicks / 60).toFixed(w.cooldownTicks % 60 === 0 ? 0 : 1)} s`);
    }
    expect(ordnanceRows(ord('nuke')).find((r) => r.label === 'TIME DILATION')!.value).toBe('0.5× speed for 2 s');
    expect(ordnanceRows(ord('lock-missile')).find((r) => r.label === 'TARGETING')!.value).toBe('Lock-on · 0.3 s lock');
    expect(ordnanceRows(ord('heavy-missile')).find((r) => r.label === 'TARGETING')!.value).toMatch(/^None/);
  });

  it('flight distance and blast falloff follow the parameters', () => {
    // lock: 0.3 s from 200 to 470 px/s, then 2.2 s at 470
    expect(flightDistance(ord('lock-missile'))).toBeCloseTo(0.3 * 335 + 2.2 * 470, 5);
    const h = ord('heavy-missile');
    expect(blastDamageAt(h, 0)).toBe(h.blast!.damage);
    expect(blastDamageAt(h, h.blast!.radius)).toBeCloseTo(h.blast!.damage * h.blast!.edgeMul, 6);
    expect(blastDamageAt(h, h.blast!.radius + 1)).toBe(0);
    expect(blastCatch(h, 60, 5).caught).toBe(5);
    expect(blastCatch(ord('lock-missile'), 60, 5).caught).toBe(1);
    expect(blastCatch(WEAPON_BY_ID.get('plasma')!, 60, 5).caught).toBe(1);
  });

  it('compares the missiles and the nuke on shared units, with no combined score', () => {
    const cols = ordnanceComparison();
    expect(cols.map((c) => c.id)).toEqual(['heavy-missile', 'lock-missile', 'nuke']);
    expect(cols.find((c) => c.id === 'nuke')!.blastFill).toBe(1);
    for (const c of cols) expect(Object.keys(c).some((k) => /score|power|rating/i.test(k))).toBe(false);
  });
});

describe('navigation and module boundaries', () => {
  it('the armory is a station tab after the hangar, and Back returns to the hangar', () => {
    expect(STATION_TABS.indexOf('armory')).toBe(STATION_TABS.indexOf('hangar') + 1);
    expect(backFrom('armory')).toBe('hangar');
    const o = stationOverview({ name: 'X', first: false, ship: 'Petrel', cells: 1, emergency: 0, marks: 0, ready: 0, active: 0, offers: 0, stored: 0 });
    expect(o.services.some((s) => s.tab === 'armory')).toBe(true);
  });

  const read = (p: string): string => readFileSync(new URL(`../src/modes/freeroam/${p}`, import.meta.url), 'utf8');

  it('the armory page has no timers or listeners of its own and saves only through the shell', () => {
    const src = read('ships/armoryPanel.ts');
    for (const banned of ['requestAnimationFrame', 'setTimeout', 'setInterval', 'ResizeObserver', 'window.addEventListener', 'document.addEventListener', 'saveProfile', 'withFleet', 'localStorage', 'innerHTML']) {
      expect(src.includes(banned), banned).toBe(false);
    }
    // every change goes through the rules (which re-check the mounts)
    expect(src).toMatch(/setStart\(d\.fleet\(\)/);
    expect(src).toMatch(/setInRotation\(f, f\.active/);
  });

  it('the shell restocks on docking, opens the armory from the hangar and exposes the combat interface', () => {
    const src = read('freeRoamMode.ts');
    expect(src).toMatch(/restockOrdnance\(profile\.ordnance\)/);
    expect(src).toMatch(/armory: \(\) => openStation\('armory'\)/);
    expect(src).toMatch(/back: \(\) => openStation\('hangar'\)/);
    expect(src).toMatch(/loadout: \(\) => armedLoadout\(fleet\)/);
    // restocking is the only place the counts rise; the only other write is a spent round (P03C), which
    // stores the run's count after the launch (it only ever goes down: see weaponRuntime.test.ts)
    expect(src.match(/withOrdnance\(/g)?.length).toBe(2);
    expect(src).toMatch(/if \(topped\) profile = withOrdnance\(profile, restocked\);/);
    expect(src).toMatch(/e\.type === 'ordnanceSpent'\) \{\s*\/\/[^\n]*\n\s*profile = withOrdnance\(profile, \{ \.\.\.profile\.ordnance, \[e\.weapon\]: e\.left \}\);/);
  });

  it('the catalogue and rules stay free of the DOM (reusable by Free Roam and Classic)', () => {
    const cfg = readFileSync(new URL('../src/config/weapons.ts', import.meta.url), 'utf8');
    expect(cfg).not.toMatch(/from '\.\.\/(modes|render|shared)/);
    for (const p of ['ships/armory.ts', 'ships/armoryView.ts']) expect(read(p)).not.toMatch(/document\.|window\.|localStorage/);
  });
});
