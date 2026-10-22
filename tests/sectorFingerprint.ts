/**
 * Layout fingerprint shared by the stability test and its fixture writer.
 * Covers every persistent layout element a save can refer to (ids and
 * positions of POIs, rocks, patrols, encounter sites, hazard zones and mines)
 * and deliberately excludes loot amounts, which Prompt 10 moved to the central
 * loot tables. Pure helper; not a test file.
 */
import type { SectorLayout } from '../src/modes/freeroam/sector/model.ts';

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const r1 = (n: number): number => Math.round(n * 10) / 10;

export function layoutFingerprint(L: SectorLayout): string {
  const parts = [
    L.width, L.height, L.difficulty, L.threat, L.encounterSlots, r1(L.arrival.x), r1(L.arrival.y),
    ...L.spawns.map((s) => `${s.id}@${r1(s.x)},${r1(s.y)}`),
    ...L.landmarks.map((l) => `${l.id}:${l.style}@${r1(l.x)},${r1(l.y)},${r1(l.r)},${r1(l.hazardR)}`),
    ...L.regions.map((g) => `${g.id}:${g.effect}@${r1(g.x)},${r1(g.y)},${r1(g.r)}`),
    ...L.rocks.map((k) => `${r1(k.x)},${r1(k.y)},${r1(k.r)}`),
    ...L.pois.map((p) => `${p.id}:${p.kind}@${r1(p.x)},${r1(p.y)},${r1(p.r)},${r1(p.solidR)}|${p.alertR},${p.wave},${p.tier},${p.holdTicks}`),
    ...L.patrols.map((p) => `${p.id}:${p.ships}x${p.tier}@${p.points.map((q) => `${r1(q.x)},${r1(q.y)}`).join(';')}`),
    ...L.sites.map((s) => `${s.id}:${s.kind}@${r1(s.x)},${r1(s.y)},${s.r}|${s.anchor}|${s.size}x${s.waves}`),
    ...L.hazards.map((z) => `${z.id}:${z.kind}@${r1(z.x)},${r1(z.y)},${r1(z.r)}|${z.mines.map((m) => `${r1(m.x)},${r1(m.y)}`).join(';')}`),
  ];
  return fnv(parts.join('/'));
}
