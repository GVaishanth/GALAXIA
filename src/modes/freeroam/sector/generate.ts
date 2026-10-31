/**
 * Deterministic local-sector generator (pure). Input: one catalogue
 * SystemRecord (its `seed` and `sector` config) plus the gate directions from
 * the System Map. Output: a SectorLayout — the same for the same input, on
 * every load and in every engine (integer-seeded streams only; no clock and
 * no ambient randomness).
 *
 * Each placement stage draws from its own named seed stream, so changing one
 * stage never moves the objects of another. A layout that fails the safety
 * rules (sector/validate.ts) is regenerated with the next attempt number; the
 * last attempt is repaired by clearing rocks out of blocked corridors.
 *
 * Order (most important first): arrival zone, gates, stars, station, bodies,
 * asteroid fields, clouds, installations, derelicts, anomalies, caches,
 * salvage, survey marks, rocks, patrols; then combat content (Prompt 9) and,
 * after any repair, ore veins (Prompt 10), each from its own streams.
 */
import { createRng, type Rng } from '../../../core/rng.ts';
import { fnv1a32 } from '../catalogue/build.ts';
import { FACTIONS } from '../combat/factions.ts';
import { HOSTILE_FACTIONS, WARY_FACTIONS, RESOURCE_IDS, type FactionId, type HazardId, type ResourceId, type SystemRecord } from '../catalogue/types.ts';
import { SHIPS } from '../ships/roster.ts';
import { LOOT_TABLES, lootContextOf, MINING, rareChanceOf, rollLoot, type LootTableId } from '../inventory/lootTables.ts';
import { CATEGORY_STARS, SECTOR_FEATURES, STAR_SIZE, type Range } from './features.ts';
import { buildGrid, canReach, dist, reachable, segmentDistance, solidsOf, type Circle } from './grid.ts';
import {
  maxTierFor,
  RARE_RESOURCES,
  SECTOR_GEN,
  SECTOR_GEN_VERSION,
  type BodyStyle,
  type EncounterSite,
  type HazardZone,
  type HostileTier,
  type Landmark,
  type LootEntry,
  type OreVein,
  type PatrolRoute,
  type Point,
  type Poi,
  type PoiKind,
  type Region,
  type Rock,
  type SectorContext,
  type SectorLayout,
  type SpawnPoint,
  type StarStyle,
} from './model.ts';

const G = SECTOR_GEN;

/** A named, attempt-specific seed stream derived from the system seed. */
function stream(seed: number, name: string, attempt: number): Rng {
  return createRng((Math.imul((seed ^ fnv1a32(name)) >>> 0, 0x9e3779b1) + Math.imul(attempt, 0x85ebca6b)) >>> 0);
}
const roll = (rng: Rng, [a, b]: Range): number => rng.int(a, b);
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(rng.next() * list.length))]!;
const r1 = (n: number): number => Math.round(n);

/* ------------------------------------------------------------- placement */

interface PlaceOptions {
  /** Ring around a point: distance from its centre in [min, max]. */
  readonly near?: { readonly x: number; readonly y: number; readonly min: number; readonly max: number } | undefined;
  /** Extra distance from the arrival zone edge. */
  readonly arrivalGap?: number | undefined;
  /** Do not land inside these circles (e.g. asteroid fields for solid hulls). */
  readonly avoid?: readonly Circle[] | undefined;
  readonly tries?: number | undefined;
}

class Placer {
  readonly taken: Circle[] = [];
  readonly w: number;
  readonly h: number;
  readonly arrival: Circle;
  constructor(w: number, h: number, arrival: Circle) {
    this.w = w;
    this.h = h;
    this.arrival = arrival;
  }

  fits(x: number, y: number, r: number, sep: number, o: PlaceOptions): boolean {
    const m = G.edgeMargin;
    if (x - r < m || y - r < m || x + r > this.w - m || y + r > this.h - m) return false;
    if (dist({ x, y }, this.arrival) < this.arrival.r + r + (o.arrivalGap ?? 0)) return false;
    for (const t of this.taken) if (dist({ x, y }, t) < t.r + r + sep) return false;
    for (const a of o.avoid ?? []) if (dist({ x, y }, a) < a.r + r) return false;
    return true;
  }

  /** Seeded rejection sampling; relaxes the separation twice before giving up. */
  sample(rng: Rng, r: number, sep: number, o: PlaceOptions = {}): Point | null {
    const tries = o.tries ?? 160;
    for (const k of [1, 0.6, 0.3]) {
      for (let i = 0; i < tries; i++) {
        let x: number;
        let y: number;
        if (o.near) {
          const a = rng.next() * Math.PI * 2;
          const d = o.near.min + rng.next() * Math.max(0, o.near.max - o.near.min);
          x = o.near.x + Math.cos(a) * d;
          y = o.near.y + Math.sin(a) * d;
        } else {
          x = rng.range(0, this.w);
          y = rng.range(0, this.h);
        }
        if (this.fits(x, y, r, sep * k, o)) return { x: r1(x), y: r1(y) };
      }
    }
    return null;
  }

  take(c: Circle): void {
    this.taken.push(c);
  }
}

/* ------------------------------------------------------------------ loot */

/** POI kind -> central loot table (inventory/lootTables.ts). */
const POI_TABLE: Readonly<Partial<Record<PoiKind, LootTableId>>> = { salvage: 'salvage', cache: 'container', derelict: 'wreck', anomaly: 'anomaly', installation: 'outpost' };

const lootContext = lootContextOf;

/** Chance that one loot pick is a rare resource (central tables). 0 at difficulty 1; never certain. */
export function rareChance(kind: PoiKind, difficulty: number, rareRich: boolean): number {
  const t = POI_TABLE[kind];
  if (!t) return 0;
  return rareChanceOf(LOOT_TABLES[t], { difficulty, richness: 1, primary: rareRich ? 'core-shard' : 'scrap', secondary: null });
}

function lootRoll(rng: Rng, kind: PoiKind, s: SystemRecord): LootEntry[] {
  const t = POI_TABLE[kind];
  return t ? rollLoot(t, rng, lootContext(s)) : [];
}

/* ----------------------------------------------------------------- labels */

const BODY_LABEL: Readonly<Record<BodyStyle, string>> = { rocky: 'Rocky body', ice: 'Ice body', gas: 'Gas body', molten: 'Molten body' };
const CLOUD_LABEL: Readonly<Record<HazardId, string>> = { none: 'Nebula', dust: 'Dust cloud', 'ion-storm': 'Ion storm', radiation: 'Radiation cloud', flare: 'Flare zone', 'gravity-shear': 'Gravity shear' };
const WRECKS = ['Derelict freighter', 'Gutted corvette', 'Silent tanker', 'Broken survey sloop', 'Drifting ore hauler', 'Burnt-out tug'];
const ANOMALIES = ['Gravitic ripple', 'Signal echo', 'Cold spot', 'Light knot', 'Phase shimmer'];
const CACHES = ['Supply cache', 'Sealed crate', 'Smuggler’s stash', 'Emergency locker'];
const INSTALLATION_LABEL: Readonly<Record<FactionId, string>> = { tessellate: 'Tessellate foundry', 'red-tally': 'Red Tally outpost', cordon: 'Cordon checkpoint', gleaners: 'Gleaner camp', 'haven-guild': 'Guild depot' };
const STAR_LABEL: Partial<Record<StarStyle, string>> = { dim: 'Faint star', 'black-hole': 'Event horizon', 'anomaly-core': 'Anomaly core', protostar: 'Protostar' };

function poi(p: Partial<Poi> & Pick<Poi, 'id' | 'kind' | 'x' | 'y' | 'r' | 'label'>): Poi {
  return { solidR: 0, required: false, loot: [], target: null, group: null, alertR: 0, wave: 0, tier: 0 as HostileTier, holdTicks: 0, ...p };
}

/* -------------------------------------------------------------- generator */

function attemptLayout(s: SystemRecord, ctx: SectorContext, attempt: number): SectorLayout {
  const cfg = s.sector;
  const F = SECTOR_FEATURES[cfg.archetype];
  const w = cfg.width;
  const h = cfg.height;
  const cx = w / 2;
  const cy = h / 2;
  const at = (name: string): Rng => stream(s.seed, name, attempt);
  const simulated = s.provenance.status === 'verified-object';

  /* arrival: inset from one seeded side, then the clear zone */
  const ra = at('arrival');
  const side = ra.int(0, 3);
  const along = ra.range(0.35, 0.65);
  const ins = G.arrivalInset;
  const arrival = side === 0 ? { x: r1(w * along), y: h - ins } : side === 1 ? { x: ins, y: r1(h * along) } : side === 2 ? { x: r1(w * along), y: ins } : { x: w - ins, y: r1(h * along) };
  const toCentre = Math.atan2(cy - arrival.y, cx - arrival.x);
  const P = new Placer(w, h, { ...arrival, r: G.arrivalClear });
  const pois: Poi[] = [];
  const landmarks: Landmark[] = [];
  const regions: Region[] = [];
  const spawns: SpawnPoint[] = [{ id: 'arrival', x: r1(arrival.x + Math.cos(toCentre) * 120), y: r1(arrival.y + Math.sin(toCentre) * 120), heading: headingOf(toCentre) }];
  pois.push(poi({ id: 'exit', kind: 'exit', x: arrival.x, y: arrival.y, r: G.interactRadius, label: 'Exit beacon', required: true }));

  /* gates: on an inner ellipse in the neighbour's map direction, nudged until clear */
  const gates = [...ctx.gates].sort((a, b) => (a.to < b.to ? -1 : 1));
  for (const g of gates) {
    let placed: Point | null = null;
    for (const shrink of [1, 0.86, 0.72]) {
      for (const off of [0, 0.18, -0.18, 0.36, -0.36, 0.6, -0.6, 0.9, -0.9, 1.3, -1.3, 1.8, -1.8, 2.4, -2.4, Math.PI]) {
        const a = g.angle + off;
        const x = cx + Math.cos(a) * (w / 2 - G.edgeMargin - G.gateClear) * shrink;
        const y = cy + Math.sin(a) * (h / 2 - G.edgeMargin - G.gateClear) * shrink;
        if (P.fits(x, y, G.gateClear, G.separation, { arrivalGap: G.separation })) {
          placed = { x: r1(x), y: r1(y) };
          break;
        }
      }
      if (placed) break;
    }
    placed ??= P.sample(at(`gate:${g.to}`), G.gateClear, 0, {}) ?? { x: r1(cx), y: r1(cy) };
    P.take({ ...placed, r: G.gateClear });
    const inward = Math.atan2(cy - placed.y, cx - placed.x);
    pois.push(poi({ id: `gate:${g.to}`, kind: 'gate', x: placed.x, y: placed.y, r: G.interactRadius, label: 'Jump gate', required: true, target: g.to }));
    spawns.push({ id: `gate:${g.to}`, x: r1(placed.x + Math.cos(inward) * 140), y: r1(placed.y + Math.sin(inward) * 140), heading: headingOf(inward) });
  }

  /* stars: the primary near the middle, companions close by */
  const rs = at('stars');
  const styles = CATEGORY_STARS[s.category];
  const giant = s.category === 'red-giant' || s.category === 'blue-giant' ? 1.35 : 1;
  styles.forEach((style, i) => {
    const [core, glow] = STAR_SIZE[style];
    const k = giant * rs.range(0.9, 1.1);
    const r = r1(core * k);
    const hz = r1(glow * k);
    const first = landmarks.find((l) => l.kind === 'star');
    const near = first ? { x: first.x, y: first.y, min: first.hazardR + hz + 120, max: first.hazardR + hz + 520 } : { x: cx, y: cy, min: 0, max: Math.min(w, h) * 0.22 };
    const at2 = P.sample(rs, hz, G.separation, { near, arrivalGap: 200 }) ?? P.sample(rs, hz, G.separation, { arrivalGap: 120 });
    if (!at2) return;
    P.take({ ...at2, r: hz });
    const label = i === 0 ? (STAR_LABEL[style] && style !== 'black-hole' && style !== 'anomaly-core' ? STAR_LABEL[style]! : s.name) : 'Companion star';
    landmarks.push({ id: `star-${i + 1}`, kind: 'star', style, x: at2.x, y: at2.y, r, hazardR: hz, label });
  });

  /* station: near the arrival zone (first port of call) */
  if (cfg.station) {
    const rst = at('station');
    const solidR = 46;
    const sp = P.sample(rst, solidR + 70, G.separation, { near: { ...arrival, min: G.arrivalClear + 260, max: G.arrivalClear + 900 } }) ?? P.sample(rst, solidR + 70, G.separation / 2);
    if (sp) {
      P.take({ ...sp, r: solidR + 70 });
      pois.push(poi({ id: 'station', kind: 'station', x: sp.x, y: sp.y, r: solidR + 70, solidR, label: 'Haven Guild station', required: true }));
    }
  }

  /* planet-like bodies (landmarks and obstacles only: no orbits, no landing) */
  const rb = at('bodies');
  const bodies = roll(rb, F.bodies);
  for (let i = 0; i < bodies; i++) {
    const style = pick(rb, F.bodyStyles);
    const r = r1(style === 'gas' ? rb.range(80, 120) : rb.range(40, 96));
    const bp = P.sample(rb, r, G.separation, { arrivalGap: 160 });
    if (!bp) continue;
    P.take({ ...bp, r });
    landmarks.push({ id: `body-${i + 1}`, kind: 'body', style, x: bp.x, y: bp.y, r, hazardR: 0, label: simulated ? `${BODY_LABEL[style]} (simulated)` : BODY_LABEL[style] });
  }

  /* asteroid fields: areas, filled with rocks later; not "taken" so POIs can sit inside */
  const rf = at('fields');
  const fields: Circle[] = [];
  const nf = roll(rf, F.asteroidFields);
  for (let i = 0; i < nf; i++) {
    const r = r1(rf.range(260, 500));
    const fp = P.sample(rf, r, 60, { arrivalGap: 80, avoid: fields.map((f) => ({ ...f, r: f.r + 40 })) });
    if (!fp) continue;
    fields.push({ ...fp, r });
    regions.push({ id: `field-${i + 1}`, kind: 'asteroids', x: fp.x, y: fp.y, r, effect: 'none', strength: 0, label: 'Asteroid field' });
  }

  /* clouds: nebula / dust, carrying the sector hazard; kept off the arrival and gate zones */
  const rc = at('clouds');
  const nc = roll(rc, F.clouds);
  const gateZones = pois.filter((p) => p.kind === 'gate').map((p) => ({ x: p.x, y: p.y, r: G.gateClear }));
  for (let i = 0; i < nc; i++) {
    const r = r1(rc.range(360, 680));
    let cp: Point | null = null;
    for (let t = 0; t < 200 && !cp; t++) {
      const x = rc.range(r * 0.5, w - r * 0.5);
      const y = rc.range(r * 0.5, h - r * 0.5);
      if (dist({ x, y }, arrival) < G.arrivalClear + r + 80) continue;
      if (gateZones.some((z) => dist({ x, y }, z) < z.r + r)) continue;
      if (pois.some((p) => p.kind === 'station' && dist({ x, y }, p) < p.r + r)) continue;
      cp = { x: r1(x), y: r1(y) };
    }
    if (!cp) continue;
    regions.push({ id: `cloud-${i + 1}`, kind: 'nebula', x: cp.x, y: cp.y, r, effect: cfg.hazard, strength: cfg.hazardStrength, label: CLOUD_LABEL[cfg.hazard] });
  }

  /* hostile installations (threat 2+): alert zones far from the arrival */
  const ri = at('installations');
  const hostile = s.encounters.factions.filter((f) => HOSTILE_FACTIONS.includes(f));
  const faction: FactionId = hostile[0] ?? 'tessellate';
  const tierCap = maxTierFor(s.difficulty);
  let slots = s.encounters.threat > 0 ? cfg.encounterSlots : 0;
  const installs = s.encounters.threat >= 3 && slots >= 7 ? 2 : s.encounters.threat >= 2 ? 1 : 0;
  for (let i = 0; i < installs; i++) {
    const solidR = 34;
    const alertR = 360 + 40 * s.encounters.threat;
    const wave = Math.min(slots, Math.max(2, Math.min(4, 1 + s.encounters.threat)));
    if (wave < 1) break;
    const ip = P.sample(ri, alertR, 40, { arrivalGap: 380, avoid: fields });
    if (!ip) continue;
    slots -= wave;
    P.take({ ...ip, r: alertR });
    pois.push(
      poi({
        id: `installation-${i + 1}`,
        kind: 'installation',
        x: ip.x,
        y: ip.y,
        r: alertR,
        solidR,
        label: INSTALLATION_LABEL[faction],
        loot: lootRoll(at(`loot:installation-${i + 1}`), 'installation', s),
        alertR,
        wave,
        tier: tierCap,
        holdTicks: (12 + 4 * s.encounters.threat) * 60,
      }),
    );
  }

  /* derelicts (solid hulls, outside asteroid fields) */
  const rd = at('derelicts');
  const nd = roll(rd, F.derelicts);
  for (let i = 0; i < nd; i++) {
    const solidR = r1(rd.range(24, 38));
    const r = solidR + 60;
    const dp = P.sample(rd, r, G.separation / 2, { arrivalGap: 140, avoid: fields });
    if (!dp) continue;
    P.take({ ...dp, r });
    pois.push(poi({ id: `derelict-${i + 1}`, kind: 'derelict', x: dp.x, y: dp.y, r, solidR, label: pick(rd, WRECKS), loot: lootRoll(at(`loot:derelict-${i + 1}`), 'derelict', s) }));
  }

  /* anomalies: near a star or a cloud when there is one */
  const rn = at('anomalies');
  const nn = roll(rn, F.anomalies) + (s.category === 'anomaly' ? 1 : 0);
  for (let i = 0; i < nn; i++) {
    const anchors = [...landmarks.filter((l) => l.kind === 'star').map((l) => ({ x: l.x, y: l.y, min: l.hazardR + 140, max: l.hazardR + 420 })), ...regions.filter((g) => g.kind === 'nebula').map((g) => ({ x: g.x, y: g.y, min: 0, max: g.r * 0.7 }))];
    const near = anchors.length && rn.next() < 0.65 ? pick(rn, anchors) : undefined;
    const ap = P.sample(rn, 60, G.separation / 2, { near, arrivalGap: 200 }) ?? P.sample(rn, 60, G.separation / 2, { arrivalGap: 200 });
    if (!ap) continue;
    P.take({ ...ap, r: 60 });
    pois.push(poi({ id: `anomaly-${i + 1}`, kind: 'anomaly', x: ap.x, y: ap.y, r: G.interactRadius, label: pick(rn, ANOMALIES), loot: lootRoll(at(`loot:anomaly-${i + 1}`), 'anomaly', s) }));
  }

  /* loot caches: often tucked inside asteroid fields */
  const rk = at('caches');
  const nk = roll(rk, F.caches);
  for (let i = 0; i < nk; i++) {
    const field = fields.length && rk.next() < 0.5 ? pick(rk, fields) : undefined;
    const near = field ? { x: field.x, y: field.y, min: 0, max: field.r * 0.75 } : undefined;
    const kp = P.sample(rk, 50, G.separation / 2, { near, arrivalGap: 160 }) ?? P.sample(rk, 50, G.separation / 2, { arrivalGap: 160 });
    if (!kp) continue;
    P.take({ ...kp, r: 50 });
    pois.push(poi({ id: `cache-${i + 1}`, kind: 'cache', x: kp.x, y: kp.y, r: r1(G.interactRadius * 0.8), label: pick(rk, CACHES), loot: lootRoll(at(`loot:cache-${i + 1}`), 'cache', s) }));
  }

  /* salvage: the catalogue's node count, in clusters of 3-5 around wrecks, in fields or in the open */
  const rv = at('salvage');
  let left = cfg.salvageNodes;
  let group = 0;
  while (left > 0 && group < 16) {
    group += 1;
    const size = Math.min(left, rv.int(3, 5));
    const wrecks = pois.filter((p) => p.kind === 'derelict');
    const choice = rv.next();
    const anchor: { x: number; y: number; min: number; max: number } | undefined =
      wrecks.length && choice < 0.4 ? (({ x, y, r }) => ({ x, y, min: r + 40, max: r + 160 }))(pick(rv, wrecks)) : fields.length && choice < 0.8 ? (({ x, y, r }) => ({ x, y, min: 0, max: r * 0.8 }))(pick(rv, fields)) : undefined;
    const centre = anchor ? { x: anchor.x, y: anchor.y } : P.sample(rv, 160, 0, { arrivalGap: 120 });
    if (!centre) break;
    let n = 0;
    for (let t = 0; t < size * 30 && n < size; t++) {
      const a = rv.next() * Math.PI * 2;
      const d = anchor ? anchor.min + rv.next() * (anchor.max - anchor.min) : rv.range(30, 170);
      const x = r1(centre.x + Math.cos(a) * d);
      const y = r1(centre.y + Math.sin(a) * d);
      if (!P.fits(x, y, 24, 0, { arrivalGap: 80 })) continue;
      if (pois.some((p) => p.group !== null && dist({ x, y }, p) < 60)) continue;
      n += 1;
      pois.push(poi({ id: `salvage-${group}.${n}`, kind: 'salvage', x, y, r: G.collectRadius, label: 'Salvage', group: `salvage-${group}`, loot: lootRoll(at(`loot:salvage-${group}.${n}`), 'salvage', s) }));
    }
    left -= n === 0 ? size : n;
  }
  for (const p of pois) if (p.kind === 'salvage') P.take({ x: p.x, y: p.y, r: 20 });

  /* survey marks: near landmarks, clouds and wrecks, spread apart; the survey needs all of them */
  const rm = at('survey');
  const marks = Math.min(5, 3 + (s.difficulty >= 3 ? 1 : 0) + (Math.max(w, h) >= 5000 ? 1 : 0));
  for (let i = 0; i < marks; i++) {
    const anchors = [
      ...landmarks.map((l) => ({ x: l.x, y: l.y, min: Math.max(l.r, l.hazardR) + 90, max: Math.max(l.r, l.hazardR) + 260 })),
      ...regions.map((g) => ({ x: g.x, y: g.y, min: g.r * 0.4, max: g.r * 0.9 })),
      ...pois.filter((p) => p.kind === 'derelict' || p.kind === 'anomaly').map((p) => ({ x: p.x, y: p.y, min: p.r + 60, max: p.r + 220 })),
    ];
    const near = anchors.length && rm.next() < 0.75 ? pick(rm, anchors) : undefined;
    const mp = P.sample(rm, 40, 420, { near, arrivalGap: 240, avoid: [] }) ?? P.sample(rm, 40, 300, { arrivalGap: 240 });
    if (!mp) continue;
    P.take({ ...mp, r: 40 });
    pois.push(poi({ id: `survey-${i + 1}`, kind: 'survey', x: mp.x, y: mp.y, r: G.markRadius, label: 'Survey mark', required: true }));
  }

  /* rocks: fill the asteroid fields at the sector density, clear of every POI and zone */
  const rr = at('rocks');
  const rocks: Rock[] = [];
  const area = fields.reduce((n, f) => n + Math.PI * f.r * f.r, 0);
  const budget = Math.min(G.maxRocks, Math.round(area * cfg.density * 1.4e-4));
  fields.forEach((f, fi) => {
    const want = area > 0 ? Math.round((budget * Math.PI * f.r * f.r) / area) : 0;
    for (let i = 0, t = 0; i < want && t < want * 8; t++) {
      const rad = r1(10 + 24 * rr.next() ** 2);
      const a = rr.next() * Math.PI * 2;
      const d = Math.sqrt(rr.next()) * (f.r - rad);
      const x = r1(f.x + Math.cos(a) * d);
      const y = r1(f.y + Math.sin(a) * d);
      if (x - rad < G.edgeMargin || y - rad < G.edgeMargin || x + rad > w - G.edgeMargin || y + rad > h - G.edgeMargin) continue;
      if (dist({ x, y }, arrival) < G.arrivalClear + rad) continue;
      if (P.taken.some((c) => dist({ x, y }, c) < c.r + rad + 10)) continue;
      if (pois.some((p) => dist({ x, y }, p) < Math.max(p.r, p.solidR + G.shipClearance) + rad + 16)) continue;
      if (rocks.some((o) => dist({ x, y }, o) < o.r + rad + 6)) continue;
      rocks.push({ x, y, r: rad, field: `field-${fi + 1}`, shape: rr.int(0, 0xffff) });
      i += 1;
    }
  });

  /* patrols: the encounter slots left after the installations; loops away from the arrival */
  const rp = at('patrols');
  const patrols: PatrolRoute[] = [];
  if (s.encounters.threat > 0) {
    const groups = Math.max(1, Math.min(4, Math.ceil(cfg.encounterSlots / 3)));
    for (let i = 0; i < groups && slots > 0; i++) {
      const ships = Math.max(1, Math.min(slots, Math.min(4, s.encounters.threat + rp.int(0, 1))));
      const tier = (rp.next() < 0.3 ? tierCap : Math.max(1, tierCap - 1)) as 1 | 2 | 3;
      const centre = P.sample(rp, 300, 0, { arrivalGap: 700, tries: 80 });
      if (!centre) continue;
      const n = rp.int(3, 4);
      const rad = rp.range(260, 620);
      const pts: Point[] = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + rp.range(-0.3, 0.3);
        const x = r1(Math.min(w - G.edgeMargin, Math.max(G.edgeMargin, centre.x + Math.cos(a) * rad)));
        const y = r1(Math.min(h - G.edgeMargin, Math.max(G.edgeMargin, centre.y + Math.sin(a) * rad)));
        pts.push({ x, y });
      }
      const safe = pts.every((p, k) => segmentDistance(arrival, p, pts[(k + 1) % pts.length]!) >= G.arrivalClear + 260);
      if (!safe) continue;
      slots -= ships;
      patrols.push({ id: `patrol-${i + 1}`, points: pts, ships, tier, faction });
    }
  }

  /* rare rewards are never guaranteed: when every container rolled one, the last one is demoted to scrap */
  const containers = pois.filter((p) => p.kind !== 'salvage' && p.loot.length > 0);
  const isRare = (p: Poi): boolean => p.loot.some((e) => RARE_RESOURCES.includes(e.resource));
  if (containers.length >= 2 && containers.every(isRare)) {
    const last = containers[containers.length - 1]!;
    const loot = new Map<ResourceId, number>();
    for (const e of last.loot) loot.set(RARE_RESOURCES.includes(e.resource) ? 'scrap' : e.resource, (loot.get(RARE_RESOURCES.includes(e.resource) ? 'scrap' : e.resource) ?? 0) + e.amount);
    pois[pois.indexOf(last)] = { ...last, loot: RESOURCE_IDS.filter((id) => loot.has(id)).map((id) => ({ resource: id, amount: loot.get(id)! })) };
  }

  /* combat content (Prompt 9): placed last, from its own streams, so nothing above moves */
  const combat = combatContent(s, P, at, pois, landmarks, regions, rocks, arrival, spawns);

  return {
    systemId: s.id,
    seed: s.seed,
    version: SECTOR_GEN_VERSION,
    archetype: cfg.archetype,
    width: w,
    height: h,
    difficulty: s.difficulty,
    threat: s.encounters.threat,
    encounterSlots: s.encounters.threat > 0 ? cfg.encounterSlots : 0,
    arrival: { x: arrival.x, y: arrival.y, r: G.arrivalClear },
    spawns,
    landmarks,
    regions,
    rocks,
    pois,
    patrols,
    factions: [...s.encounters.factions],
    pattern: s.encounters.pattern,
    sites: combat.sites,
    hazards: combat.hazards,
    resources: { primary: s.resources.primary, secondary: s.resources.secondary, richness: s.resources.richness },
    veins: [],
    attempts: attempt + 1,
  };
}

/* ------------------------------------------------------- combat content */

/** Encounter rewards: the central table of the site kind (a rare one only by chance, never at difficulty 1). */
function siteLoot(rng: Rng, kind: EncounterSite['kind'], s: SystemRecord): LootEntry[] {
  return rollLoot(kind, rng, lootContext(s));
}

/**
 * Encounter sites and hazard zones (Prompt 9). Deterministic from the system
 * seed through dedicated streams. Rules:
 *  - nothing within 900 px of the arrival zone edge (ambush baits 700), so no
 *    fight can start before the pilot can react; hazards keep clear of the
 *    arrival, the gates and every required POI (survey marks, exit);
 *  - disputes need the Gleaners and a salvage field; ambushes need a bait
 *    (wreck, cache or anomaly); wreck defence needs a derelict and difficulty 2+;
 *    an elite needs difficulty 3+ and threat 2+; a capital ship needs
 *    difficulty 4+ and a nest / tide / sentinel / gauntlet pattern;
 *  - at most one capital, one elite and two of every other kind per sector.
 *  - sites keep apart (SITE_GAP between centres; elites and capitals
 *    BOSS_SITE_GAP) so two encounters never wake as one tangled fight.
 */
/** Minimum distance between two encounter-site centres (and from an elite or capital). */
const SITE_GAP = 700;
const BOSS_SITE_GAP = 1000;

function combatContent(
  s: SystemRecord,
  P: Placer,
  at: (name: string) => Rng,
  pois: readonly Poi[],
  landmarks: readonly Landmark[],
  regions: readonly Region[],
  rocks: readonly Rock[],
  arrival: Point,
  spawns: readonly SpawnPoint[],
): { sites: EncounterSite[]; hazards: HazardZone[] } {
  const sites: EncounterSite[] = [];
  const hazards: HazardZone[] = [];
  const threat = s.encounters.threat;
  const d = s.difficulty;
  const pattern = s.encounters.pattern;
  const hostile = s.encounters.factions.filter((f) => HOSTILE_FACTIONS.includes(f));
  const wary = s.encounters.factions.filter((f) => WARY_FACTIONS.includes(f));
  const arrivalR = G.arrivalClear;
  const farFromArrival = (p: Point, gap: number): boolean => dist(p, arrival) >= arrivalR + gap;
  const required = pois.filter((p) => p.required || p.kind === 'survey' || p.kind === 'gate');
  const clearOfRequired = (c: Point, r: number, margin: number): boolean => required.every((p) => dist(c, p) > r + p.r + margin) && spawns.every((sp) => dist(c, sp) > r + G.gateClear);
  const used = new Set<string>();
  const clearOfSites = (c: Point): boolean => sites.every((x) => dist(x, c) >= SITE_GAP);
  const avoidSites = (r: number): Circle[] => sites.map((x) => ({ x: x.x, y: x.y, r: BOSS_SITE_GAP - r }));

  /* disputes: a Gleaner claim on a salvage field (convoy raids: the Red Tally contests it) */
  const rq = at('sites:dispute');
  if (wary.includes('gleaners')) {
    const groups = [...new Set(pois.filter((p) => p.kind === 'salvage' && p.group).map((p) => p.group!))].sort();
    const want = Math.min(groups.length, pattern === 'convoy-raids' ? 2 : 1);
    for (let i = 0, made = 0; i < groups.length && made < want; i++) {
      const g = groups[(i + rq.int(0, groups.length - 1)) % groups.length]!;
      if (used.has(g)) continue;
      const nodes = pois.filter((p) => p.group === g);
      const c = { x: r1(nodes.reduce((n, p) => n + p.x, 0) / nodes.length), y: r1(nodes.reduce((n, p) => n + p.y, 0) / nodes.length) };
      if (!farFromArrival(c, 900) || !clearOfSites(c)) continue;
      used.add(g);
      const rival: FactionId | null = pattern === 'convoy-raids' && hostile.includes('red-tally') ? 'red-tally' : threat > 0 && hostile.length && rq.next() < 0.35 ? hostile[0]! : null;
      const id = `dispute-${made + 1}`;
      sites.push({ id, kind: 'dispute', x: c.x, y: c.y, r: 560, anchor: g, factions: rival ? ['gleaners', rival] : ['gleaners'], size: 2 + (d >= 3 ? 1 : 0), waves: 1, holdTicks: 0, loot: siteLoot(at(`loot:${id}`), 'dispute', s), label: rival ? 'Contested claim' : 'Gleaner claim' });
      made += 1;
    }
  }
  if (threat > 0 && hostile.length > 0) {
    /* ambushes: a bait (wreck, cache, anomaly) far from the arrival */
    const ra = at('sites:ambush');
    const baits = pois.filter((p) => (p.kind === 'derelict' || p.kind === 'cache' || p.kind === 'anomaly') && !p.required && farFromArrival(p, 700));
    const free = (p: Poi): boolean => !used.has(p.id) && clearOfSites(p);
    const nAmb = Math.min(baits.length, pattern === 'ambush' ? 2 : ra.next() < 0.35 ? 1 : 0);
    for (let i = 0; i < nAmb; i++) {
      const open = baits.filter(free);
      const b = open[ra.int(0, Math.max(0, open.length - 1))];
      if (!b) break;
      used.add(b.id);
      const f = hostile.includes('red-tally') ? 'red-tally' : hostile[ra.int(0, hostile.length - 1)]!;
      const id = `ambush-${i + 1}`;
      sites.push({ id, kind: 'ambush', x: b.x, y: b.y, r: 260, anchor: b.id, factions: [f], size: Math.min(4, 2 + Math.floor(d / 2)), waves: 1, holdTicks: 0, loot: siteLoot(at(`loot:${id}`), 'ambush', s), label: 'Ambush' });
    }
    /* wreck defence: a distress beacon on a derelict (difficulty 2+) */
    const rw = at('sites:defence');
    const wrecks = pois.filter((p) => p.kind === 'derelict' && !used.has(p.id) && clearOfSites(p) && farFromArrival(p, 900));
    if (d >= 2 && wrecks.length && (s.sector.archetype === 'derelict-yard' || threat >= 2 || rw.next() < 0.4)) {
      const wk = wrecks[rw.int(0, wrecks.length - 1)]!;
      used.add(wk.id);
      const f = hostile.includes('red-tally') ? 'red-tally' : hostile[rw.int(0, hostile.length - 1)]!;
      sites.push({ id: 'defence-1', kind: 'defence', x: wk.x, y: wk.y, r: 300, anchor: wk.id, factions: [f], size: Math.min(3, 1 + Math.ceil(d / 2)), waves: d >= 4 ? 3 : 2, holdTicks: (18 + 3 * d) * 60, loot: siteLoot(at('loot:defence-1'), 'defence', s), label: 'Distress beacon' });
    }
    /* elite ship: a named ace with escorts */
    const re = at('sites:elite');
    if (d >= 3 && threat >= 2) {
      const f = hostile[re.int(0, hostile.length - 1)]!;
      const ep = P.sample(re, 320, 60, { arrivalGap: 1400, tries: 120, avoid: avoidSites(320) });
      if (ep) {
        P.take({ ...ep, r: 320 });
        sites.push({ id: 'elite-1', kind: 'elite', x: ep.x, y: ep.y, r: 900, anchor: null, factions: [f], size: 1 + Math.min(2, d - 2), waves: 1, holdTicks: 0, loot: siteLoot(at('loot:elite-1'), 'elite', s), label: `${FACTIONS[f].short} ${FACTIONS[f].names.elite ?? 'elite'}` });
      }
    }
    /* capital ship: one boss in the deepest sectors */
    const rc = at('sites:capital');
    if (d >= 4 && (pattern === 'gauntlet' || pattern === 'sentinels' || pattern === 'nest' || pattern === 'swarm-tide')) {
      const f = hostile.find((x) => FACTIONS[x].fields.includes('capital')) ?? hostile[0]!;
      const cp = P.sample(rc, 420, 80, { arrivalGap: 1800, tries: 160, avoid: avoidSites(420) });
      if (cp) {
        P.take({ ...cp, r: 420 });
        sites.push({ id: 'capital-1', kind: 'capital', x: cp.x, y: cp.y, r: 1000, anchor: null, factions: [f], size: 1, waves: 1, holdTicks: 0, loot: siteLoot(at('loot:capital-1'), 'capital', s), label: `${FACTIONS[f].short} ${FACTIONS[f].names.capital ?? 'capital ship'}` });
      }
    }
  }

  /* minefields: laid by security forces and raiders (difficulty 2+) */
  const rm = at('hazards:mines');
  const layer = hostile.find((f) => f === 'cordon' || f === 'red-tally') ?? (pattern === 'gauntlet' ? hostile[0] : undefined);
  if (threat > 0 && d >= 2 && layer) {
    const count = d >= 4 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const r = r1(rm.range(240, 340));
      const c = P.sample(rm, r, 40, { arrivalGap: 600, tries: 120 });
      if (!c || !clearOfRequired(c, r, 60)) continue;
      P.take({ ...c, r });
      const mines: Point[] = [];
      const want = Math.min(12, 6 + d * 2); // two fields at most: never more than 24 field mines
      for (let k = 0; k < want * 6 && mines.length < want; k++) {
        const a = rm.next() * Math.PI * 2;
        const dd = Math.sqrt(rm.next()) * (r - 20);
        const m = { x: r1(c.x + Math.cos(a) * dd), y: r1(c.y + Math.sin(a) * dd) };
        if (mines.some((o) => dist(o, m) < 72)) continue;
        if (rocks.some((k2) => Math.abs(k2.x - m.x) < k2.r + 30 && Math.abs(k2.y - m.y) < k2.r + 30 && dist(k2, m) < k2.r + 24)) continue;
        if (landmarks.some((l) => dist(l, m) < Math.max(l.r, l.hazardR) + 30)) continue;
        mines.push(m);
      }
      if (mines.length >= 4) hazards.push({ id: `minefield-${hazards.filter((z) => z.kind === 'minefield').length + 1}`, kind: 'minefield', x: c.x, y: c.y, r, faction: layer, mines, period: 0, label: 'Minefield' });
    }
  }
  /* sensor interference: ion storms jam sensors; elsewhere a seeded jamming field (difficulty 2+) */
  const rj = at('hazards:interference');
  for (const g of regions.filter((x) => x.effect === 'ion-storm').slice(0, 2)) {
    hazards.push({ id: `interference-${hazards.filter((z) => z.kind === 'interference').length + 1}`, kind: 'interference', x: g.x, y: g.y, r: r1(g.r * 0.9), faction: null, mines: [], period: 0, label: 'Sensor interference' });
  }
  if (d >= 2 && threat > 0 && rj.next() < 0.4 && hazards.filter((z) => z.kind === 'interference').length < 2) {
    const r = r1(rj.range(380, 520));
    const c = P.sample(rj, r, -r, { arrivalGap: 400, tries: 80 }); // may overlap content: it only affects sensors
    if (c) hazards.push({ id: `interference-${hazards.filter((z) => z.kind === 'interference').length + 1}`, kind: 'interference', x: c.x, y: c.y, r, faction: null, mines: [], period: 0, label: 'Sensor interference' });
  }
  /* eruption fields: near violent stars, or in flare / radiation sectors (difficulty 2+) */
  const rx = at('hazards:eruption');
  const violent = landmarks.find((l) => l.kind === 'star' && (l.style === 'neutron' || l.style === 'anomaly-core' || l.style === 'black-hole' || l.style === 'blue'));
  if (d >= 2 && (violent || s.sector.hazard === 'flare' || s.sector.hazard === 'radiation')) {
    const r = r1(rx.range(240, 320));
    const near = violent ? { x: violent.x, y: violent.y, min: Math.max(violent.r, violent.hazardR) + r + 40, max: Math.max(violent.r, violent.hazardR) + r + 360 } : undefined;
    const c = P.sample(rx, r, 20, { arrivalGap: 600, tries: 120, near });
    if (c && clearOfRequired(c, r, 60)) {
      P.take({ ...c, r });
      hazards.push({ id: 'eruption-1', kind: 'eruption', x: c.x, y: c.y, r, faction: null, mines: [], period: rx.int(150, 210), label: 'Eruption field' });
    }
  }
  return { sites, hazards };
}

/** Heading convention of the ship (0 = nose up, clockwise) from a math angle (0 = +x). */
function headingOf(angle: number): number {
  return Math.atan2(Math.cos(angle), -Math.sin(angle));
}

/** Targets the pilot must be able to reach: every POI and every spawn point. */
export function unreachableTargets(L: SectorLayout): string[] {
  const grid = buildGrid(L.width, L.height, solidsOf(L));
  const seen = reachable(grid, L.spawns[0]!);
  const out: string[] = [];
  for (const sp of L.spawns) if (!canReach(grid, seen, sp, 8)) out.push(sp.id);
  for (const p of L.pois) if (!canReach(grid, seen, p, Math.max(p.r, p.solidR + G.shipClearance + 8))) out.push(p.id);
  return out;
}

/** Last resort: clear rocks along the straight line from the arrival to each blocked target. */
export function repairLayout(L: SectorLayout): SectorLayout {
  let rocks = L.rocks;
  for (const id of unreachableTargets(L)) {
    const t = L.pois.find((p) => p.id === id) ?? L.spawns.find((sp) => sp.id === id);
    if (!t) continue;
    rocks = rocks.filter((r) => segmentDistance(r, L.spawns[0]!, t) > r.r + G.shipClearance * 2);
  }
  const fixed = { ...L, rocks };
  // optional targets that are still enclosed (never required ones in practice) are dropped
  const still = new Set(unreachableTargets(fixed));
  const pois = fixed.pois.filter((p) => p.required || !still.has(p.id));
  // encounter sites anchored on a dropped POI (or a salvage field left empty) go with it
  const sites = fixed.sites.filter((st) => st.anchor === null || pois.some((p) => p.id === st.anchor || (st.kind === 'dispute' && p.kind === 'salvage' && p.group === st.anchor)));
  return { ...fixed, pois, sites };
}

/**
 * Generate the sector of `system`. Deterministic: the same record and context
 * always give an identical layout. Gameplay changes are never part of it
 * (they are applied on top from SectorSave).
 */
export function generateSector(system: SystemRecord, ctx: SectorContext): SectorLayout {
  let last: SectorLayout | null = null;
  for (let a = 0; a < G.maxAttempts; a++) {
    last = attemptLayout(system, ctx, a);
    const required = last.pois.filter((p) => p.kind === 'survey').length;
    if (unreachableTargets(last).length === 0 && required >= 3 && last.pois.filter((p) => p.kind === 'gate').length === ctx.gates.length) return withRaidBoxes(withVeins(last, system), system);
  }
  return withRaidBoxes(withVeins(repairLayout(last!), system), system);
}

/**
 * P10.1 Raid Boxes: the authored box of the hull whose ShipDef.salvage names
 * this system, appended after everything else (no seed stream is consumed, so
 * nothing else moves). Id `raidbox` (one box per sector at most, tested), so
 * the saved `done` id passes the existing POI id grammar unchanged. The box is part of the layout whatever the profile
 * owns; the run decides whether its hull still waits (RunOptions.salvage).
 */
function withRaidBoxes(L: SectorLayout, s: SystemRecord): SectorLayout {
  const boxes = SHIPS.filter((d) => d.salvage?.system === s.id).map((d) =>
    poi({ id: 'raidbox', kind: 'raidbox', x: d.salvage!.box[0], y: d.salvage!.box[1], r: G.interactRadius * 0.8, label: 'Raid Box', target: d.id }),
  );
  return boxes.length ? { ...L, pois: [...L.pois, ...boxes] } : L;
}

/**
 * Marked ore veins (Prompt 10), placed on the final rocks (after any repair)
 * from their own seed streams, so nothing else moves. Only larger field rocks
 * qualify, clear of the arrival zone, minefields and eruption fields, at
 * least 320 px apart. Each chip's loot comes from the mining table.
 */
function withVeins(L: SectorLayout, s: SystemRecord): SectorLayout {
  const rv = stream(s.seed, 'veins', 0);
  const hot = L.hazards.filter((z) => z.kind !== 'interference');
  const candidates = L.rocks
    .map((k, i) => ({ k, i }))
    .filter(({ k }) => k.r >= MINING.minRockR && dist(k, L.arrival) > L.arrival.r + 200 && hot.every((z) => dist(k, z) > z.r + k.r + 20));
  if (candidates.length === 0) return L;
  const want = Math.min(MINING.maxVeins, Math.max(1, Math.round(candidates.length / 14) + rv.int(0, 1)));
  const veins: OreVein[] = [];
  const ctx = lootContext(s);
  for (let tries = 0; tries < want * 12 && veins.length < want; tries++) {
    const { k, i } = candidates[rv.int(0, candidates.length - 1)]!;
    if (veins.some((v) => v.rock === i || dist(v, k) < 320)) continue;
    const id = `vein-${veins.length + 1}`;
    const rl = stream(s.seed, `loot:${id}`, 0);
    const n = rl.int(MINING.chips[0], MINING.chips[1]);
    const chips: LootEntry[][] = [];
    for (let c = 0; c < n; c++) chips.push(rollLoot('mining', rl, ctx));
    veins.push({ id, rock: i, x: k.x, y: k.y, r: k.r, angle: Math.round(rv.range(-Math.PI, Math.PI) * 100) / 100, chips: chips.filter((c) => c.length > 0) });
  }
  return { ...L, veins };
}
