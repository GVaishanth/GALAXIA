/**
 * P04.3 NORMAL-flight regression script: a fixed 1500-tick flight through a
 * sector with a planet, a star, a gravity-shear cloud and a dust cloud, using
 * keys, aim, boost and the ship lock against a real hostile. Only APIs that
 * existed before P04.3 are used, so the same script run on the pre-P04.3 tree
 * (bf459d0) gives the golden numbers tests/flightModes.test.ts compares against.
 */
import { EMPTY_SECTOR_SAVE, type Landmark, type Region, type SectorLayout } from '../../src/modes/freeroam/sector/model.ts';
import { createSectorRun, stepSector, type SectorInput, type SectorRun } from '../../src/modes/freeroam/sector/run.ts';
import { arena } from './combatProbe.ts';

const body = (id: string, x: number, y: number, r: number): Landmark => ({ id, kind: 'body', style: 'rocky', x, y, r, hazardR: 0, label: 'Test body' });
const star = (id: string, x: number, y: number, r: number, hazardR: number): Landmark => ({ id, kind: 'star', style: 'yellow', x, y, r, hazardR, label: 'Test star' });
const cloud = (id: string, x: number, y: number, r: number, effect: Region['effect'], strength: number): Region => ({ id, kind: 'nebula', x, y, r, effect, strength, label: 'Test cloud' });

export function scriptLayout(): SectorLayout {
  const base = arena(1);
  const cx = base.width / 2;
  const cy = base.height / 2;
  return {
    ...base,
    landmarks: [body('p', cx + 260, cy - 120, 90), star('s', cx - 420, cy - 380, 80, 200)],
    regions: [cloud('shear', cx - 250, cy + 150, 220, 'gravity-shear', 0.8), cloud('dust', cx + 150, cy + 300, 200, 'dust', 1)],
  };
}

/** The per-tick input of the script (deterministic). */
export function scriptInput(t: number): SectorInput {
  // a loop around the centre: short legs, so the ship keeps crossing the planet's and the star's fields and both clouds
  const phase = Math.floor(t / 70) % 8;
  const mx = [0, 1, 0.6, -1, 0, -0.5, 0.2, 0][phase]!;
  const my = [-1, 0, 0.8, 0.3, 1, -0.6, 0, 0][phase]!;
  const aim = t % 400 > 250 ? { aimX: Math.sin(t / 37), aimY: -Math.cos(t / 37) } : {};
  return { moveX: mx, moveY: my, ...aim, boost: t % 300 < 60, fire: false, lockToggle: t === 500 || t === 900 };
}

export function runScript(ticks = 1500): { run: SectorRun; trace: number[] } {
  const run = createSectorRun(scriptLayout(), { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 11 });
  run.phase = 'flight';
  run.grace = 1e9;
  run.invuln = 1e9;
  const L = run.layout;
  Object.assign(run.ship, { x: L.width / 2, y: L.height / 2 + 60, px: L.width / 2, py: L.height / 2 + 60 });
  const trace: number[] = [];
  for (let t = 0; t < ticks; t++) {
    stepSector(run, scriptInput(t));
    run.hull = Math.max(run.hull, 1); // the script measures movement, not survival
    if (t % 50 === 49) trace.push(run.ship.x, run.ship.y, run.ship.vx, run.ship.vy, run.ship.heading, run.gravity.g);
  }
  return { run, trace };
}
