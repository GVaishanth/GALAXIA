/**
 * Independent safety checks for a generated sector (pure). The generator
 * retries until its own reachability test passes; this validator re-checks
 * every rule from scratch, and the tests run it on all catalogue systems.
 */
import { RESOURCE_IDS, type SystemRecord } from '../catalogue/types.ts';
import { buildGrid, canReach, dist, reachable, segmentDistance, solidsOf } from './grid.ts';
import { FACTION_IDS } from '../catalogue/types.ts';
import { maxTierFor, PATROL_ARRIVAL_CLEARANCE, POI_ID, SITE_KINDS, HAZARD_KINDS, RARE_RESOURCES, SECTOR_GEN, type SectorContext, type SectorLayout } from './model.ts';

export type SectorIssueCode =
  | 'out-of-bounds'
  | 'arrival-blocked'
  | 'spawn-in-obstacle'
  | 'unreachable'
  | 'poi-in-obstacle'
  | 'too-close'
  | 'difficulty'
  | 'loot'
  | 'duplicate-id'
  | 'bad-id'
  | 'config-mismatch'
  | 'combat';

export interface SectorIssue {
  readonly code: SectorIssueCode;
  readonly detail: string;
}

const G = SECTOR_GEN;

export function validateSector(L: SectorLayout, system: SystemRecord, ctx: SectorContext): SectorIssue[] {
  const out: SectorIssue[] = [];
  const bad = (code: SectorIssueCode, detail: string): void => {
    out.push({ code, detail: `${L.systemId}: ${detail}` });
  };
  const within = (x: number, y: number, r: number): boolean => x - r >= 0 && y - r >= 0 && x + r <= L.width && y + r <= L.height;
  const A = L.arrival;

  /* bounds: every object inside the sector */
  for (const l of L.landmarks) if (!within(l.x, l.y, l.r)) bad('out-of-bounds', l.id);
  for (const r of L.rocks) if (!within(r.x, r.y, r.r)) bad('out-of-bounds', `rock in ${r.field}`);
  for (const p of L.pois) if (!within(p.x, p.y, Math.max(p.solidR, 1))) bad('out-of-bounds', p.id);
  for (const g of L.regions) if (!within(g.x, g.y, 1)) bad('out-of-bounds', g.id);
  for (const pr of L.patrols) for (const pt of pr.points) if (!within(pt.x, pt.y, 1)) bad('out-of-bounds', pr.id);

  /* clear arrival zone: no solid, hazard cloud, hostile alert zone or patrol path inside */
  for (const l of L.landmarks) if (dist(l, A) < A.r + Math.max(l.r, l.hazardR)) bad('arrival-blocked', l.id);
  for (const r of L.rocks) if (dist(r, A) < A.r + r.r) bad('arrival-blocked', `rock in ${r.field}`);
  for (const g of L.regions) if (g.kind === 'nebula' && g.effect !== 'none' && dist(g, A) < A.r + g.r) bad('arrival-blocked', g.id);
  for (const p of L.pois) {
    if (p.kind === 'installation' && dist(p, A) < A.r + p.alertR) bad('arrival-blocked', p.id);
    if (p.solidR > 0 && dist(p, A) < A.r + p.solidR) bad('arrival-blocked', p.id);
  }
  for (const pr of L.patrols) pr.points.forEach((pt, k) => {
    if (segmentDistance(A, pt, pr.points[(k + 1) % pr.points.length]!) < A.r + PATROL_ARRIVAL_CLEARANCE[pr.tier]) bad('arrival-blocked', pr.id);
  });

  /* spawns: never inside an obstacle (ship radius 12 + margin) */
  const solids = solidsOf(L);
  for (const sp of L.spawns) {
    for (const s of solids) if (dist(sp, s) < s.r + 20) bad('spawn-in-obstacle', sp.id);
    for (const l of L.landmarks) if (l.hazardR > 0 && dist(sp, l) < l.hazardR) bad('spawn-in-obstacle', `${sp.id} in ${l.id} glow`);
  }
  if (L.spawns[0]?.id !== 'arrival') bad('spawn-in-obstacle', 'first spawn must be the arrival');

  /* reachability: every spawn and POI, with a ship-wide corridor, from the arrival */
  const grid = buildGrid(L.width, L.height, solids);
  const seen = reachable(grid, L.spawns[0] ?? A);
  for (const sp of L.spawns) if (!canReach(grid, seen, sp, 8)) bad('unreachable', sp.id);
  for (const p of L.pois) if (!canReach(grid, seen, p, Math.max(p.r, p.solidR + G.shipClearance + 8))) bad('unreachable', p.id);

  /* objectives never inside terrain: fly-through and button POIs are clear of every other solid */
  for (const p of L.pois) {
    for (const r of L.rocks) if (dist(p, r) < r.r + Math.max(p.solidR, 8)) bad('poi-in-obstacle', `${p.id} in a rock`);
    for (const l of L.landmarks) if (dist(p, l) < l.r + Math.max(p.solidR, 8)) bad('poi-in-obstacle', `${p.id} in ${l.id}`);
    if (p.required) for (const l of L.landmarks) if (l.hazardR > 0 && dist(p, l) < l.hazardR) bad('poi-in-obstacle', `${p.id} in ${l.id} glow`);
  }

  /* separation of major objects (edge to edge) */
  const major = [...L.landmarks.map((l) => ({ id: l.id, x: l.x, y: l.y, r: Math.max(l.r, l.hazardR) })), ...L.pois.filter((p) => p.solidR > 0).map((p) => ({ id: p.id, x: p.x, y: p.y, r: p.solidR }))];
  for (let i = 0; i < major.length; i++) {
    for (let j = i + 1; j < major.length; j++) {
      const a = major[i]!;
      const b = major[j]!;
      if (dist(a, b) < a.r + b.r + G.separation * 0.25) bad('too-close', `${a.id} / ${b.id}`);
    }
  }
  const marks = L.pois.filter((p) => p.kind === 'survey');
  for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) if (dist(marks[i]!, marks[j]!) < 200) bad('too-close', `${marks[i]!.id} / ${marks[j]!.id}`);

  /* enemy difficulty follows the catalogue region config */
  const cap = maxTierFor(system.difficulty);
  const threat = system.encounters.threat;
  const ships = L.patrols.reduce((n, p) => n + p.ships, 0) + L.pois.filter((p) => p.kind === 'installation').reduce((n, p) => n + p.wave, 0);
  if (threat === 0 && ships > 0) bad('difficulty', 'hostiles in a threat-0 system');
  if (ships > (threat > 0 ? system.sector.encounterSlots : 0)) bad('difficulty', `${ships} ships for ${system.sector.encounterSlots} encounter slots`);
  for (const p of L.patrols) if (p.tier > cap || p.ships < 1 || p.ships > 4) bad('difficulty', `${p.id} tier ${p.tier} x${p.ships}`);
  for (const p of L.pois) if (p.kind === 'installation' && (p.tier > cap || threat < 2)) bad('difficulty', `${p.id} tier ${p.tier}`);

  /* loot: valid, positive, and rare rewards never guaranteed */
  const containers = L.pois.filter((p) => p.kind !== 'salvage' && p.loot.length > 0);
  let rareContainers = 0;
  for (const p of L.pois) {
    for (const e of p.loot) {
      if (!RESOURCE_IDS.includes(e.resource) || !Number.isInteger(e.amount) || e.amount < 1 || e.amount > 99) bad('loot', `${p.id}: ${e.resource} x${e.amount}`);
      if (RARE_RESOURCES.includes(e.resource) && system.difficulty <= 1) bad('loot', `${p.id}: rare reward at difficulty 1`);
    }
    if (p.kind === 'survey' || p.kind === 'gate' || p.kind === 'exit' || p.kind === 'station') if (p.loot.length) bad('loot', `${p.id} carries loot`);
  }
  for (const p of containers) if (p.loot.some((e) => RARE_RESOURCES.includes(e.resource))) rareContainers += 1;
  if (containers.length >= 2 && rareContainers === containers.length) bad('loot', 'every container holds a rare reward');

  /* ids: unique and in the documented grammar */
  const ids = new Set<string>();
  for (const p of L.pois) {
    if (ids.has(p.id)) bad('duplicate-id', p.id);
    ids.add(p.id);
    if (!POI_ID.test(p.id)) bad('bad-id', p.id);
  }

  /* ore veins (Prompt 10): on an existing rock, stable ids, valid chips, never rare */
  for (const v of L.veins ?? []) {
    if (ids.has(v.id)) bad('duplicate-id', v.id);
    ids.add(v.id);
    if (!/^vein-[0-9]+$/.test(v.id)) bad('bad-id', v.id);
    const k = L.rocks[v.rock];
    if (!k || k.x !== v.x || k.y !== v.y || k.r !== v.r) bad('loot', `${v.id}: no rock ${v.rock}`);
    if (v.chips.length < 1 || v.chips.length > 8) bad('loot', `${v.id}: ${v.chips.length} chips`);
    v.chips.forEach((c, i) => {
      if (!POI_ID.test(`${v.id}.${i + 1}`)) bad('bad-id', `${v.id}.${i + 1}`);
      for (const e of c) if (!RESOURCE_IDS.includes(e.resource) || !Number.isInteger(e.amount) || e.amount < 1 || e.amount > 99 || RARE_RESOURCES.includes(e.resource)) bad('loot', `${v.id}.${i + 1}: ${e.resource} x${e.amount}`);
    });
  }

  /* combat content (Prompt 9): sites and hazards */
  const required = [...L.pois.filter((p) => p.required || p.kind === 'survey' || p.kind === 'gate' || p.kind === 'exit' || p.kind === 'station'), ...L.spawns.map((sp) => ({ ...sp, r: 40 }))];
  const sitesOf = (k: string): number => L.sites.filter((x) => x.kind === k).length;
  for (const st of L.sites) {
    if (ids.has(st.id)) bad('duplicate-id', st.id);
    ids.add(st.id);
    if (!POI_ID.test(st.id)) bad('bad-id', st.id);
    if (!SITE_KINDS.includes(st.kind)) bad('combat', `${st.id}: kind ${st.kind}`);
    if (st.factions.length < 1 || st.factions.some((f) => !FACTION_IDS.includes(f) || f === 'haven-guild')) bad('combat', `${st.id}: factions`);
    if (st.size < 1 || st.size > 6 || st.waves < 1 || st.waves > 3) bad('combat', `${st.id}: size ${st.size} x${st.waves}`);
    if (!within(st.x, st.y, 1)) bad('out-of-bounds', st.id);
    const gap = st.kind === 'ambush' ? 700 : st.kind === 'elite' ? 1400 : st.kind === 'capital' ? 1800 : 900;
    if (dist(st, A) < A.r + gap - 1) bad('arrival-blocked', st.id);
    if (st.kind === 'ambush' || st.kind === 'defence') {
      const a = L.pois.find((p) => p.id === st.anchor);
      if (!a || (st.kind === 'defence' && a.kind !== 'derelict')) bad('combat', `${st.id}: anchor ${st.anchor}`);
    }
    if (st.kind === 'dispute' && !L.pois.some((p) => p.kind === 'salvage' && p.group === st.anchor)) bad('combat', `${st.id}: no salvage field ${st.anchor}`);
    if (st.kind === 'dispute' && st.factions[0] !== 'gleaners') bad('combat', `${st.id}: disputes are Gleaner claims`);
    if (st.kind !== 'dispute' && threat === 0) bad('difficulty', `${st.id} in a threat-0 system`);
    if (st.kind === 'defence' && system.difficulty < 2) bad('difficulty', `${st.id} below difficulty 2`);
    if (st.kind === 'elite' && (system.difficulty < 3 || threat < 2)) bad('difficulty', `${st.id} below difficulty 3 / threat 2`);
    if (st.kind === 'capital' && system.difficulty < 4) bad('difficulty', `${st.id} below difficulty 4`);
    if (st.loot.length === 0) bad('loot', `${st.id} pays nothing`);
    for (const e of st.loot) {
      if (!RESOURCE_IDS.includes(e.resource) || !Number.isInteger(e.amount) || e.amount < 1 || e.amount > 99) bad('loot', `${st.id}: ${e.resource} x${e.amount}`);
      if (RARE_RESOURCES.includes(e.resource) && system.difficulty <= 1) bad('loot', `${st.id}: rare reward at difficulty 1`);
    }
  }
  L.sites.forEach((a, i) => L.sites.slice(i + 1).forEach((b) => dist(a, b) < 700 - 1 && bad('combat', `${a.id} and ${b.id} overlap`)));
  if (sitesOf('elite') > 1 || sitesOf('capital') > 1 || sitesOf('ambush') > 2 || sitesOf('dispute') > 2 || sitesOf('defence') > 1) bad('combat', 'too many sites of one kind');
  let mines = 0;
  for (const z of L.hazards) {
    if (ids.has(z.id)) bad('duplicate-id', z.id);
    ids.add(z.id);
    if (!POI_ID.test(z.id)) bad('bad-id', z.id);
    if (!HAZARD_KINDS.includes(z.kind)) bad('combat', `${z.id}: kind ${z.kind}`);
    if (!within(z.x, z.y, 1)) bad('out-of-bounds', z.id);
    mines += z.mines.length;
    for (const m of z.mines) if (dist(m, z) > z.r) bad('combat', `${z.id}: mine outside its field`);
    if (z.kind === 'minefield' && (!z.faction || z.mines.length === 0)) bad('combat', `${z.id}: empty or unowned minefield`);
    if (z.kind === 'eruption' && z.period < 96) bad('combat', `${z.id}: period ${z.period}`);
    if (z.kind === 'interference') continue; // sensors only: may overlap anything
    if (dist(z, A) < A.r + z.r) bad('arrival-blocked', z.id);
    for (const p of required) if (dist(z, p) < z.r + p.r) bad('combat', `${z.id} covers ${p.id}`);
  }
  if (mines > 24) bad('combat', `${mines} field mines`);
  if (threat === 0 && L.hazards.some((z) => z.kind === 'minefield')) bad('difficulty', 'minefield in a threat-0 system');

  /* the catalogue config is honoured */
  if (L.width !== system.sector.width || L.height !== system.sector.height) bad('config-mismatch', 'size');
  if (L.pois.some((p) => p.kind === 'station') !== system.sector.station) bad('config-mismatch', 'station');
  const gates = L.pois.filter((p) => p.kind === 'gate');
  if (gates.length !== ctx.gates.length || !ctx.gates.every((g) => gates.some((p) => p.target === g.to))) bad('config-mismatch', 'gates do not match the lanes');
  if (marks.length < 3) bad('config-mismatch', `${marks.length} survey marks`);
  if (L.pois.filter((p) => p.kind === 'exit').length !== 1) bad('config-mismatch', 'exactly one exit beacon');
  const salvage = L.pois.filter((p) => p.kind === 'salvage').length;
  if (salvage > system.sector.salvageNodes) bad('config-mismatch', `${salvage} salvage nodes > ${system.sector.salvageNodes}`);
  return out;
}
