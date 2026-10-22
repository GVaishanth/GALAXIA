/**
 * Catalogue validation. Pure; takes untyped input on purpose so the same
 * checks apply to TS data modules today and to a JSON data pack later.
 * Returns every problem found (never throws), each with a stable code and a
 * path such as `systems[12].sector.width` or `system lmc/undertow`.
 *
 * Detects: duplicate ids, duplicate or confusable names, invalid parent
 * references, missing required fields, invalid difficulty, invalid / cyclic /
 * unreachable unlock prerequisites, missing or inconsistent provenance,
 * uncited facts, galaxy and total counts outside the intended range, broken
 * navigation lanes and invalid local-sector configs; since Prompt 4 also
 * invalid inter-galaxy routes (unknown or self endpoints, non-canonical or
 * duplicate ids, a fully connected map, no open starting route), invalid
 * milestones and conditions, and milestone dependency cycles.
 */
import { CATEGORY_ARCHETYPES, ARCHETYPES } from './data/archetypes.ts';
import { systemSeed } from './build.ts';
import {
  DISCOVERY_STATES,
  ENCOUNTER_PATTERNS,
  FACTION_IDS,
  GALAXY_CLASSES,
  GALAXY_IDS,
  GALAXY_RELATIONS,
  HAZARDS,
  HOSTILE_FACTIONS,
  normalFaction,
  LIMITS,
  MAP_SHAPES,
  MILESTONE_KINDS,
  RESOURCE_IDS,
  ROUTE_CLASSES,
  ROUTE_RISKS,
  SECTOR_ARCHETYPES,
  SYSTEM_CATEGORIES,
  SYSTEM_PROVENANCE,
  type SectorArchetype,
  type SectorArchetypeId,
  type SystemCategory,
} from './types.ts';

export type IssueCode =
  | 'missing-field'
  | 'invalid-field'
  | 'invalid-id'
  | 'duplicate-id'
  | 'duplicate-name'
  | 'similar-name'
  | 'invalid-name'
  | 'repetitive-name'
  | 'invalid-parent'
  | 'invalid-difficulty'
  | 'invalid-resources'
  | 'invalid-encounters'
  | 'invalid-discovery'
  | 'invalid-unlock'
  | 'unlock-cycle'
  | 'unreachable'
  | 'missing-provenance'
  | 'invalid-provenance'
  | 'invalid-source'
  | 'unused-source'
  | 'unsupported-claim'
  | 'invalid-connection'
  | 'disconnected'
  | 'invalid-gateway'
  | 'invalid-start'
  | 'invalid-seed'
  | 'duplicate-seed'
  | 'invalid-sector'
  | 'galaxy-count'
  | 'system-count'
  | 'total-count'
  | 'invalid-route'
  | 'invalid-milestone'
  | 'invalid-progression';

export interface CatalogueIssue {
  readonly code: IssueCode;
  readonly path: string;
  readonly message: string;
}

export interface CatalogueInput {
  readonly sources: readonly unknown[];
  readonly galaxies: readonly unknown[];
  readonly systems: readonly unknown[];
  readonly routes: readonly unknown[];
  readonly milestones: readonly unknown[];
  readonly progression: unknown;
}

export interface ValidationRules {
  readonly archetypes: readonly SectorArchetype[];
  readonly categoryArchetypes: Readonly<Record<SystemCategory, readonly SectorArchetypeId[]>>;
}

const DEFAULT_RULES: ValidationRules = { archetypes: ARCHETYPES, categoryArchetypes: CATEGORY_ARCHETYPES };

const SYSTEM_FIELDS = ['id', 'galaxyId', 'name', 'category', 'description', 'fact', 'provenance', 'difficulty', 'resources', 'encounters', 'discovery', 'unlock', 'connections', 'seed', 'sector', 'gateway'] as const;
const GALAXY_FIELDS = ['id', 'name', 'shortName', 'designations', 'morphology', 'relation', 'relatedTo', 'constellation', 'distanceLy', 'description', 'facts', 'provenance', 'gameplay'] as const;
const SOURCE_FIELDS = ['id', 'title', 'publisher', 'url', 'retrieved', 'tier'] as const;
const ROUTE_FIELDS = ['id', 'from', 'to', 'name', 'routeClass', 'cost', 'risk', 'encounter', 'unlock'] as const;
const MILESTONE_FIELDS = ['id', 'kind', 'name', 'description', 'condition', 'rewards'] as const;
const SECTOR_FIELDS = ['archetype', 'width', 'height', 'density', 'salvageNodes', 'encounterSlots', 'hazard', 'hazardStrength', 'station'] as const;

/** Real star / catalogue words that must not appear in invented names (they would read as real objects). */
const REAL_NAME_WORDS = new Set([
  'sol', 'sirius', 'vega', 'rigel', 'betelgeuse', 'polaris', 'altair', 'deneb', 'antares', 'aldebaran', 'arcturus', 'capella', 'procyon', 'spica', 'canopus',
  'pollux', 'castor', 'regulus', 'fomalhaut', 'achernar', 'mira', 'algol', 'proxima', 'centauri', 'barnard', 'barnards', 'trappist', 'kepler', 'gliese', 'ceti',
  'eridani', 'sagittarius', 'orion', 'andromeda', 'triangulum', 'magellan', 'magellanic', 'tarantula', 'sombrero', 'whirlpool', 'pinwheel', 'cartwheel',
  'centaurus', 'messier', 'ngc', 'galaga',
]);
/** Catalogue-style prefixes (NGC 604, M32, SN 2011fe, HD 1234 ...). */
const CATALOGUE_PREFIX = /^(ngc|ic|m|messier|hd|hip|gj|gliese|kepler|toi|psr|sn|sgr|eso|pgc|ugc)\b/i;
/** Words that would turn invented flavour into a claim about real observations. */
const CLAIM_WORDS = /\b(confirmed|discovered|discovery|observed|detected|nasa|esa|eso|hubble|webb|jwst|exoplanets?|astronomers|scientists)\b/i;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-f]{6}$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isIn = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const strArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Lower-case, strip accents, punctuation and a leading article; used for uniqueness. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

interface UnlockCtx {
  readonly systems: ReadonlySet<string>;
  readonly galaxies: ReadonlySet<string>;
  readonly milestones: ReadonlySet<string>;
  readonly self: string;
}

function checkUnlock(req: unknown, path: string, ctx: UnlockCtx, push: (code: IssueCode, path: string, message: string) => void): void {
  if (!isObj(req)) return push('invalid-unlock', path, 'requirement must be an object');
  switch (req['kind']) {
    case 'system':
      if (!isStr(req['systemId'])) return push('invalid-unlock', path, 'system requirement needs systemId');
      if (req['systemId'] === ctx.self) return push('invalid-unlock', path, 'requirement references itself');
      if (!ctx.systems.has(req['systemId'])) return push('invalid-unlock', path, `unknown system "${req['systemId']}"`);
      return;
    case 'galaxy':
      if (!isStr(req['galaxyId'])) return push('invalid-unlock', path, 'galaxy requirement needs galaxyId');
      if (req['galaxyId'] === ctx.self) return push('invalid-unlock', path, 'requirement references itself');
      if (!ctx.galaxies.has(req['galaxyId'])) return push('invalid-unlock', path, `unknown galaxy "${req['galaxyId']}"`);
      return;
    case 'drive':
      if (!isInt(req['tier'], LIMITS.driveTier.min, LIMITS.driveTier.max)) push('invalid-unlock', path, `drive tier must be an integer ${LIMITS.driveTier.min}-${LIMITS.driveTier.max}`);
      return;
    case 'surveys':
      if (!isInt(req['count'], LIMITS.surveys.min, LIMITS.surveys.max)) push('invalid-unlock', path, `survey count must be an integer ${LIMITS.surveys.min}-${LIMITS.surveys.max}`);
      return;
    case 'milestone':
      if (!isStr(req['milestoneId'])) return push('invalid-unlock', path, 'milestone requirement needs milestoneId');
      if (!ctx.milestones.has(req['milestoneId'])) return push('invalid-unlock', path, `unknown milestone "${req['milestoneId']}"`);
      return;
    default:
      push('invalid-unlock', path, `unknown requirement kind "${String(req['kind'])}"`);
  }
}

/** Galaxies and milestones a condition refers to (for cycle and reachability checks). */
function conditionRefs(cond: unknown, out: { galaxies: string[]; milestones: string[] } = { galaxies: [], milestones: [] }): { galaxies: string[]; milestones: string[] } {
  if (!isObj(cond)) return out;
  if ((cond['kind'] === 'surveys-in' || cond['kind'] === 'exploration') && isStr(cond['galaxyId'])) out.galaxies.push(cond['galaxyId']);
  else if (cond['kind'] === 'milestone' && isStr(cond['milestoneId'])) out.milestones.push(cond['milestoneId']);
  else if ((cond['kind'] === 'all' || cond['kind'] === 'any') && Array.isArray(cond['of'])) for (const c of cond['of']) conditionRefs(c, out);
  return out;
}

function checkCondition(cond: unknown, path: string, ctx: { galaxies: ReadonlySet<string>; milestones: ReadonlySet<string>; self: string }, push: (code: IssueCode, path: string, message: string) => void, depth = 0): void {
  if (!isObj(cond)) return push('invalid-milestone', path, 'condition must be an object');
  if (depth > 3) return push('invalid-milestone', path, 'conditions nest at most 3 levels deep');
  switch (cond['kind']) {
    case 'surveys-in':
    case 'exploration': {
      if (!isStr(cond['galaxyId']) || !ctx.galaxies.has(cond['galaxyId'])) push('invalid-milestone', path, `unknown galaxy "${String(cond['galaxyId'])}"`);
      if (cond['kind'] === 'surveys-in' && !isInt(cond['count'], LIMITS.surveys.min, LIMITS.surveys.max)) push('invalid-milestone', path, `survey count must be an integer ${LIMITS.surveys.min}-${LIMITS.surveys.max}`);
      if (cond['kind'] === 'exploration' && !isInt(cond['percent'], LIMITS.explorationPercent.min, LIMITS.explorationPercent.max)) push('invalid-milestone', path, `percent must be an integer ${LIMITS.explorationPercent.min}-${LIMITS.explorationPercent.max}`);
      return;
    }
    case 'explorer-level':
      if (!isInt(cond['level'], LIMITS.explorerLevel.min, LIMITS.explorerLevel.max)) push('invalid-milestone', path, `explorer level must be an integer ${LIMITS.explorerLevel.min}-${LIMITS.explorerLevel.max}`);
      return;
    case 'milestone':
      if (!isStr(cond['milestoneId']) || !ctx.milestones.has(cond['milestoneId'])) push('invalid-milestone', path, `unknown milestone "${String(cond['milestoneId'])}"`);
      else if (cond['milestoneId'] === ctx.self) push('invalid-milestone', path, 'milestone depends on itself');
      return;
    case 'all':
    case 'any': {
      const of = cond['of'];
      if (!Array.isArray(of) || of.length < 2) return push('invalid-milestone', path, `"${cond['kind']}" needs at least two conditions`);
      of.forEach((c, k) => checkCondition(c, `${path}.of[${k}]`, ctx, push, depth + 1));
      return;
    }
    default:
      push('invalid-milestone', path, `unknown condition kind "${String(cond['kind'])}"`);
  }
}

export function validateCatalogue(input: CatalogueInput, rules: ValidationRules = DEFAULT_RULES): CatalogueIssue[] {
  const issues: CatalogueIssue[] = [];
  const push = (code: IssueCode, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  const requireFields = (o: Obj, fields: readonly string[], path: string): boolean => {
    let ok = true;
    for (const f of fields) {
      if (!(f in o) || o[f] === undefined) {
        push('missing-field', `${path}.${f}`, `required property "${f}" is missing`);
        ok = false;
      }
    }
    return ok;
  };

  /* ---------------------------------------------------------- sources */
  const sourceTier = new Map<string, string>();
  const usedSources = new Set<string>();
  input.sources.forEach((s, i) => {
    const path = `sources[${i}]`;
    if (!isObj(s)) return push('invalid-field', path, 'source must be an object');
    if (!requireFields(s, SOURCE_FIELDS, path)) return;
    const id = s['id'];
    if (!isStr(id) || !SOURCE_ID.test(id)) return push('invalid-id', `${path}.id`, 'source id must be lower-case kebab-case');
    if (sourceTier.has(id)) push('duplicate-id', `${path}.id`, `duplicate source id "${id}"`);
    sourceTier.set(id, String(s['tier']));
    if (!isStr(s['title']) || !isStr(s['publisher'])) push('invalid-field', path, 'source needs a title and publisher');
    if (typeof s['url'] !== 'string' || !/^https:\/\/\S+$/.test(s['url'])) push('invalid-source', `${path}.url`, 'source url must be an https URL');
    const r = s['retrieved'];
    if (typeof r !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r) || Number.isNaN(Date.parse(`${r}T00:00:00Z`))) push('invalid-source', `${path}.retrieved`, 'retrieved must be an ISO date (YYYY-MM-DD)');
    if (!isIn(['primary', 'secondary'], s['tier'])) push('invalid-source', `${path}.tier`, 'tier must be primary or secondary');
  });
  const citeAll = (ids: unknown, path: string): string[] => {
    if (!strArray(ids)) {
      push('invalid-source', path, 'sourceIds must be an array of source ids');
      return [];
    }
    for (const id of ids) {
      usedSources.add(id);
      if (!sourceTier.has(id)) push('invalid-source', path, `unknown source "${id}"`);
    }
    return ids;
  };

  /* ------------------------------------------------- collect id tables */
  const galaxyIds = new Set<string>();
  const galaxyById = new Map<string, Obj>();
  input.galaxies.forEach((g) => {
    if (isObj(g) && isStr(g['id'])) {
      galaxyIds.add(g['id']);
      if (!galaxyById.has(g['id'])) galaxyById.set(g['id'], g);
    }
  });
  const systemIds = new Set<string>();
  const systemById = new Map<string, Obj>();
  input.systems.forEach((s) => {
    if (isObj(s) && isStr(s['id']) && !systemById.has(s['id'])) {
      systemIds.add(s['id']);
      systemById.set(s['id'], s);
    }
  });

  const milestoneIds = new Set<string>();
  const milestoneById = new Map<string, Obj>();
  input.milestones.forEach((m) => {
    if (isObj(m) && isStr(m['id']) && !milestoneById.has(m['id'])) {
      milestoneIds.add(m['id']);
      milestoneById.set(m['id'], m);
    }
  });

  /* --------------------------------------------------------- galaxies */
  if (input.galaxies.length !== LIMITS.galaxies) push('galaxy-count', 'galaxies', `expected ${LIMITS.galaxies} galaxies, found ${input.galaxies.length}`);
  const seenGalaxy = new Set<string>();
  const seenGalaxyName = new Map<string, string>();
  const bands = new Map<string, readonly [number, number]>();
  let homes = 0;
  input.galaxies.forEach((g, i) => {
    const path = `galaxies[${i}]`;
    if (!isObj(g)) return push('invalid-field', path, 'galaxy must be an object');
    if (!requireFields(g, GALAXY_FIELDS, path)) return;
    const id = g['id'];
    if (!isIn(GALAXY_IDS, id)) return push('invalid-id', `${path}.id`, `unknown galaxy id "${String(id)}"`);
    if (seenGalaxy.has(id)) push('duplicate-id', `${path}.id`, `duplicate galaxy id "${id}"`);
    seenGalaxy.add(id);
    const gp = `galaxy ${id}`;
    if (!isStr(g['name'])) push('invalid-field', `${gp}.name`, 'name must be a non-empty string');
    else {
      const n = normalizeName(g['name']);
      if (seenGalaxyName.has(n)) push('duplicate-name', `${gp}.name`, `name "${g['name']}" duplicates ${seenGalaxyName.get(n)}`);
      seenGalaxyName.set(n, id);
    }
    const sn = g['shortName'];
    if (typeof sn !== 'string' || sn.trim() !== sn || sn.length < LIMITS.shortNameLength.min || sn.length > LIMITS.shortNameLength.max) push('invalid-name', `${gp}.shortName`, `shortName must be ${LIMITS.shortNameLength.min}-${LIMITS.shortNameLength.max} characters`);
    else {
      const n = `short:${normalizeName(sn)}`;
      if (seenGalaxyName.has(n)) push('duplicate-name', `${gp}.shortName`, `shortName "${sn}" duplicates ${seenGalaxyName.get(n)}`);
      seenGalaxyName.set(n, id);
    }
    if (!strArray(g['designations'])) push('invalid-field', `${gp}.designations`, 'designations must be strings');
    const m = g['morphology'];
    if (!isObj(m) || !isIn(GALAXY_CLASSES, m['class']) || !(m['code'] === null || isStr(m['code'])) || !(m['note'] === null || isStr(m['note']))) push('invalid-field', `${gp}.morphology`, 'morphology needs a known class, code string|null and note string|null');
    if (!isIn(GALAXY_RELATIONS, g['relation'])) push('invalid-field', `${gp}.relation`, 'unknown relation');
    if (g['relation'] === 'home') homes++;
    const rel = g['relatedTo'];
    if (rel !== null && (!isStr(rel) || !galaxyIds.has(rel) || rel === id)) push('invalid-parent', `${gp}.relatedTo`, `relatedTo must be null or another galaxy id`);
    if (g['relation'] === 'milky-way-satellite' && rel !== 'milky-way') push('invalid-parent', `${gp}.relatedTo`, 'a Milky Way satellite must be relatedTo "milky-way"');
    if (!isStr(g['constellation'])) push('invalid-field', `${gp}.constellation`, 'constellation required');
    const d = g['distanceLy'];
    if (d === null) {
      if (g['relation'] !== 'home') push('invalid-field', `${gp}.distanceLy`, 'only the home galaxy may omit its distance');
    } else if (!isObj(d) || typeof d['low'] !== 'number' || typeof d['high'] !== 'number' || !(d['low'] > 0) || d['high'] < d['low']) {
      push('invalid-field', `${gp}.distanceLy`, 'distance must be {low > 0, high >= low}');
    }
    if (typeof g['description'] !== 'string' || g['description'].length < LIMITS.descriptionLength.min || g['description'].length > LIMITS.descriptionLength.max) push('invalid-field', `${gp}.description`, `description must be ${LIMITS.descriptionLength.min}-${LIMITS.descriptionLength.max} characters`);
    // Provenance: a verified destination must rest on at least one primary source.
    const prov = g['provenance'];
    if (!isObj(prov) || prov['status'] !== 'verified-destination') push('missing-provenance', `${gp}.provenance`, 'galaxy provenance must be { status: "verified-destination", sourceIds }');
    else {
      const ids = citeAll(prov['sourceIds'], `${gp}.provenance.sourceIds`);
      if (!ids.some((s) => sourceTier.get(s) === 'primary')) push('invalid-provenance', `${gp}.provenance.sourceIds`, 'needs at least one primary source');
    }
    const facts = g['facts'];
    if (!Array.isArray(facts) || facts.length === 0) push('invalid-provenance', `${gp}.facts`, 'at least one cited fact is required');
    else
      facts.forEach((f, k) => {
        const fp = `${gp}.facts[${k}]`;
        if (!isObj(f) || typeof f['text'] !== 'string' || f['text'].length < LIMITS.factLength.min || f['text'].length > LIMITS.factLength.max) return push('invalid-field', fp, 'fact needs text of sensible length');
        const ids = citeAll(f['sourceIds'], `${fp}.sourceIds`);
        if (ids.length === 0) push('invalid-provenance', fp, 'fact must cite at least one source');
        else if (!ids.some((s) => sourceTier.get(s) === 'primary') && !/\(secondary reference\)/.test(f['text'])) push('invalid-provenance', fp, 'a fact backed only by secondary sources must say "(secondary reference)"');
      });
    // Gameplay
    const gm = g['gameplay'];
    if (!isObj(gm)) return push('missing-field', `${gp}.gameplay`, 'gameplay block required');
    if (!isInt(gm['tier'], 1, 5)) push('invalid-field', `${gp}.gameplay.tier`, 'tier must be an integer 1-5');
    const band = gm['difficultyBand'];
    if (!Array.isArray(band) || band.length !== 2 || !isInt(band[0], LIMITS.difficulty.min, LIMITS.difficulty.max) || !isInt(band[1], LIMITS.difficulty.min, LIMITS.difficulty.max) || band[0] > band[1]) {
      push('invalid-difficulty', `${gp}.gameplay.difficultyBand`, 'band must be [min, max] within 1-5');
    } else bands.set(id, [band[0], band[1]]);
    const gw = gm['gatewaySystemId'];
    const gws = isStr(gw) ? systemById.get(gw) : undefined;
    if (!gws || gws['galaxyId'] !== id || gws['gateway'] !== true) push('invalid-gateway', `${gp}.gameplay.gatewaySystemId`, `gateway "${String(gw)}" must be a gateway system of this galaxy`);
    if ('routes' in gm) push('invalid-field', `${gp}.gameplay.routes`, 'galaxy routes moved to the route table (catalogue.routes)');
    const unlock = gm['unlock'];
    if (!Array.isArray(unlock)) push('invalid-unlock', `${gp}.gameplay.unlock`, 'unlock must be an array');
    else unlock.forEach((u, k) => checkUnlock(u, `${gp}.gameplay.unlock[${k}]`, { systems: systemIds, galaxies: galaxyIds, milestones: milestoneIds, self: id }, push));
    if (g['relation'] === 'home' && (gm['tier'] !== 1 || !Array.isArray(unlock) || unlock.length > 0)) push('invalid-start', gp, 'the home galaxy must be tier 1 with no unlock requirements');
    const th = gm['theme'];
    if (!isObj(th) || !Array.isArray(th['accent']) || th['accent'].length !== 2 || !th['accent'].every((c) => typeof c === 'string' && HEX.test(c)) || !isIn(MAP_SHAPES, th['mapShape']) || !isStr(th['motif'])) {
      push('invalid-field', `${gp}.gameplay.theme`, 'theme needs two #rrggbb accents, a known mapShape and a motif');
    }
  });
  if (homes !== 1) push('invalid-start', 'galaxies', `exactly one home galaxy required, found ${homes}`);
  const homeId = [...galaxyById.entries()].find(([, g]) => g['relation'] === 'home')?.[0];

  /* ------------------------------------------------------- milestones */
  const seenMilestone = new Set<string>();
  const seenMilestoneName = new Map<string, string>();
  input.milestones.forEach((m, i) => {
    const path = `milestones[${i}]`;
    if (!isObj(m)) return push('invalid-milestone', path, 'milestone must be an object');
    if (!requireFields(m, MILESTONE_FIELDS, path)) return;
    const id = m['id'];
    if (!isStr(id) || !SLUG.test(id)) return push('invalid-id', `${path}.id`, 'milestone id must be lower-case kebab-case');
    if (seenMilestone.has(id)) push('duplicate-id', `${path}.id`, `duplicate milestone id "${id}"`);
    seenMilestone.add(id);
    const mp = `milestone ${id}`;
    if (!isIn(MILESTONE_KINDS, m['kind'])) push('invalid-milestone', `${mp}.kind`, `unknown milestone kind "${String(m['kind'])}"`);
    const name = m['name'];
    if (typeof name !== 'string' || name.length < LIMITS.nameLength.min || name.length > LIMITS.nameLength.max) push('invalid-name', `${mp}.name`, `name must be ${LIMITS.nameLength.min}-${LIMITS.nameLength.max} characters`);
    else {
      const n = normalizeName(name);
      if (seenMilestoneName.has(n)) push('duplicate-name', `${mp}.name`, `name "${name}" duplicates ${seenMilestoneName.get(n)}`);
      seenMilestoneName.set(n, id);
    }
    const desc = m['description'];
    if (typeof desc !== 'string' || desc.length < LIMITS.milestoneDescriptionLength.min || desc.length > LIMITS.milestoneDescriptionLength.max) push('invalid-milestone', `${mp}.description`, `description must be ${LIMITS.milestoneDescriptionLength.min}-${LIMITS.milestoneDescriptionLength.max} characters`);
    checkCondition(m['condition'], `${mp}.condition`, { galaxies: galaxyIds, milestones: milestoneIds, self: id }, push);
    const rw = m['rewards'];
    if (!isObj(rw)) push('invalid-milestone', `${mp}.rewards`, 'rewards must be { driveTier, chartSystems }');
    else {
      if (!(rw['driveTier'] === null || isInt(rw['driveTier'], LIMITS.driveTier.min + 1, LIMITS.driveTier.max))) push('invalid-milestone', `${mp}.rewards.driveTier`, `driveTier must be null or ${LIMITS.driveTier.min + 1}-${LIMITS.driveTier.max}`);
      if (!strArray(rw['chartSystems'])) push('invalid-milestone', `${mp}.rewards.chartSystems`, 'chartSystems must be system ids');
      else for (const sid of rw['chartSystems']) if (!systemIds.has(sid)) push('invalid-milestone', `${mp}.rewards.chartSystems`, `unknown system "${sid}"`);
    }
  });

  /* ------------------------------------------------------- progression */
  const prog = input.progression;
  if (!isObj(prog)) push('invalid-progression', 'progression', 'progression must be { startGalaxy, explorerLevelStep }');
  else {
    if (prog['startGalaxy'] !== homeId) push('invalid-progression', 'progression.startGalaxy', 'new pilots must start in the home galaxy');
    if (!isInt(prog['explorerLevelStep'], LIMITS.explorerLevelStep.min, LIMITS.explorerLevelStep.max)) push('invalid-progression', 'progression.explorerLevelStep', `explorerLevelStep must be an integer ${LIMITS.explorerLevelStep.min}-${LIMITS.explorerLevelStep.max}`);
  }

  /* ------------------------------------------------------------ routes */
  const routeById = new Map<string, Obj>();
  const degree = new Map<string, number>();
  input.routes.forEach((r, i) => {
    const path = `routes[${i}]`;
    if (!isObj(r)) return push('invalid-route', path, 'route must be an object');
    if (!requireFields(r, ROUTE_FIELDS, path)) return;
    const { from, to } = r;
    const id = r['id'];
    if (!isStr(id)) return push('invalid-id', `${path}.id`, 'route id must be a string');
    const rp = `route ${id}`;
    if (!isStr(from) || !galaxyIds.has(from) || !isStr(to) || !galaxyIds.has(to)) return push('invalid-route', rp, `route endpoints must be known galaxies ("${String(from)}" -> "${String(to)}")`);
    if (from === to) return push('invalid-route', rp, 'a route cannot connect a galaxy to itself');
    if (!(from < to) || id !== `${from}~${to}`) push('invalid-id', `${rp}.id`, `route id must be canonical "${from < to ? from : to}~${from < to ? to : from}" (from < to)`);
    const key = from < to ? `${from}~${to}` : `${to}~${from}`;
    if (routeById.has(key)) push('duplicate-id', `${rp}.id`, `duplicate route between ${from} and ${to}`);
    else {
      routeById.set(key, r);
      degree.set(from, (degree.get(from) ?? 0) + 1);
      degree.set(to, (degree.get(to) ?? 0) + 1);
    }
    const name = r['name'];
    if (typeof name !== 'string' || name.length < LIMITS.nameLength.min || name.length > LIMITS.nameLength.max) push('invalid-name', `${rp}.name`, `name must be ${LIMITS.nameLength.min}-${LIMITS.nameLength.max} characters`);
    if (!isIn(ROUTE_CLASSES, r['routeClass'])) push('invalid-route', `${rp}.routeClass`, `unknown route class "${String(r['routeClass'])}"`);
    if (!isIn(ROUTE_RISKS, r['risk'])) push('invalid-route', `${rp}.risk`, `unknown risk "${String(r['risk'])}"`);
    if (!isIn(ENCOUNTER_PATTERNS, r['encounter'])) push('invalid-route', `${rp}.encounter`, `unknown encounter class "${String(r['encounter'])}"`);
    if (!isInt(r['cost'], LIMITS.routeCost.min, LIMITS.routeCost.max)) push('invalid-route', `${rp}.cost`, `cost must be an integer ${LIMITS.routeCost.min}-${LIMITS.routeCost.max}`);
    const unlock = r['unlock'];
    if (!Array.isArray(unlock)) push('invalid-unlock', `${rp}.unlock`, 'unlock must be an array');
    else unlock.forEach((u, k) => checkUnlock(u, `${rp}.unlock[${k}]`, { systems: systemIds, galaxies: galaxyIds, milestones: milestoneIds, self: id }, push));
  });
  for (const gid of galaxyIds) {
    const d = degree.get(gid) ?? 0;
    if (d < LIMITS.routesPerGalaxy.min || d > LIMITS.routesPerGalaxy.max) push('invalid-route', `galaxy ${gid}`, `has ${d} routes; each galaxy needs ${LIMITS.routesPerGalaxy.min}-${LIMITS.routesPerGalaxy.max} (no fully connected map)`);
  }
  {
    // the route graph must be one piece (ignoring locks), and must not be complete
    const n = galaxyIds.size;
    if (n > 2 && routeById.size >= (n * (n - 1)) / 2) push('invalid-route', 'routes', 'every galaxy is connected to every other: progression needs a sparse map');
    if (homeId) {
      const seen = new Set<string>([homeId]);
      const queue = [homeId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const r of routeById.values()) {
          const other = r['from'] === cur ? String(r['to']) : r['to'] === cur ? String(r['from']) : null;
          if (other && !seen.has(other)) (seen.add(other), queue.push(other));
        }
      }
      for (const gid of galaxyIds) if (!seen.has(gid)) push('disconnected', `galaxy ${gid}`, 'not connected to the home galaxy by any chain of routes');
      // a useful start: at least one route out of home that is open and leads to an unlocked galaxy
      const openStart = [...routeById.values()].some((r) => {
        const other = r['from'] === homeId ? String(r['to']) : r['to'] === homeId ? String(r['from']) : null;
        const otherUnlock = (galaxyById.get(other ?? '')?.['gameplay'] as Obj | undefined)?.['unlock'];
        return other !== null && Array.isArray(r['unlock']) && r['unlock'].length === 0 && Array.isArray(otherUnlock) && otherUnlock.length === 0;
      });
      if (!openStart) push('invalid-start', 'routes', 'the home galaxy needs at least one open route to a galaxy with no unlock requirements');
    }
  }

  /* ---------------------------------------------------------- systems */
  if (input.systems.length < LIMITS.systemsTotal.min || input.systems.length > LIMITS.systemsTotal.max) {
    push('total-count', 'systems', `expected ${LIMITS.systemsTotal.min}-${LIMITS.systemsTotal.max} systems, found ${input.systems.length}`);
  }
  const seenIds = new Set<string>();
  const seenNames = new Map<string, string>();
  const seeds = new Map<number, string>();
  const stems = new Map<string, string[]>();
  const names: { id: string; norm: string; verified: boolean }[] = [];
  const perGalaxy = new Map<string, Obj[]>();
  const valid: Obj[] = [];

  input.systems.forEach((s, i) => {
    const path = `systems[${i}]`;
    if (!isObj(s)) return push('invalid-field', path, 'system must be an object');
    const complete = requireFields(s, SYSTEM_FIELDS, path);
    const id = s['id'];
    if (!isStr(id)) return;
    const sp = `system ${id}`;
    if (seenIds.has(id)) push('duplicate-id', `${sp}.id`, `duplicate system id "${id}"`);
    seenIds.add(id);
    const gid = s['galaxyId'];
    if (!isStr(gid) || !galaxyIds.has(gid)) push('invalid-parent', `${sp}.galaxyId`, `unknown parent galaxy "${String(gid)}"`);
    const [prefix, slug, extra] = id.split('/');
    if (prefix !== gid || !slug || extra !== undefined || !SLUG.test(slug)) push('invalid-id', `${sp}.id`, 'id must be "<galaxyId>/<kebab-slug>"');
    if (!complete) return;
    if (isStr(gid)) perGalaxy.set(gid, [...(perGalaxy.get(gid) ?? []), s]);
    valid.push(s);

    const prov = s['provenance'];
    const status = isObj(prov) ? prov['status'] : undefined;
    const verified = status === 'verified-object';

    // Names
    const name = s['name'];
    if (!isStr(name) || name.length < LIMITS.nameLength.min || name.length > LIMITS.nameLength.max) push('invalid-name', `${sp}.name`, `name must be ${LIMITS.nameLength.min}-${LIMITS.nameLength.max} characters`);
    else {
      const norm = normalizeName(name);
      const flat = norm.replace(/ /g, '');
      if (seenNames.has(flat)) push('duplicate-name', `${sp}.name`, `name "${name}" duplicates ${seenNames.get(flat)}`);
      else seenNames.set(flat, id);
      names.push({ id, norm, verified });
      if (!verified) {
        if (/\d/.test(name)) push('invalid-name', `${sp}.name`, 'invented names must not contain digits (no numbered labels)');
        if (CATALOGUE_PREFIX.test(norm)) push('invalid-name', `${sp}.name`, 'invented names must not look like catalogue designations');
        const words = norm.split(' ');
        const real = words.find((w) => REAL_NAME_WORDS.has(w));
        if (real) push('invalid-name', `${sp}.name`, `invented name uses the real astronomical name "${real}"`);
        const stem = words[0] ?? '';
        stems.set(stem, [...(stems.get(stem) ?? []), id]);
      }
    }
    if (!isIn(SYSTEM_CATEGORIES, s['category'])) push('invalid-field', `${sp}.category`, `unknown category "${String(s['category'])}"`);
    const desc = s['description'];
    if (typeof desc !== 'string' || desc.length < LIMITS.descriptionLength.min || desc.length > LIMITS.descriptionLength.max) push('invalid-field', `${sp}.description`, `description must be ${LIMITS.descriptionLength.min}-${LIMITS.descriptionLength.max} characters`);
    else if (!verified && CLAIM_WORDS.test(desc)) push('unsupported-claim', `${sp}.description`, `invented content must not read as a real observation ("${desc.match(CLAIM_WORDS)?.[0]}")`);

    // Provenance
    if (!isObj(prov) || !isIn(SYSTEM_PROVENANCE, status)) push('missing-provenance', `${sp}.provenance`, 'provenance.status must be verified-object | fictional | procedural | speculative');
    else {
      const ids = citeAll(prov['sourceIds'], `${sp}.provenance.sourceIds`);
      const note = prov['note'];
      if (verified) {
        if (ids.length === 0) push('invalid-provenance', `${sp}.provenance.sourceIds`, 'a verified object must cite at least one source');
        else if (!ids.some((x) => sourceTier.get(x) === 'primary')) push('invalid-provenance', `${sp}.provenance.sourceIds`, 'a verified object needs at least one primary source');
        const fact = s['fact'];
        if (typeof fact !== 'string' || fact.length < LIMITS.factLength.min || fact.length > LIMITS.factLength.max) push('invalid-provenance', `${sp}.fact`, 'a verified object needs its cited fact');
        if (!isStr(note)) push('invalid-provenance', `${sp}.provenance.note`, 'a verified object needs a note separating fact from simulation');
      } else {
        if (ids.length > 0) push('invalid-provenance', `${sp}.provenance.sourceIds`, `a ${String(status)} system must not cite sources (it is not a real object)`);
        if (s['fact'] !== null) push('invalid-provenance', `${sp}.fact`, `a ${String(status)} system must not carry a real-world fact`);
        if (status === 'speculative' && !isStr(note)) push('invalid-provenance', `${sp}.provenance.note`, 'a speculative system must explain what is hypothetical');
      }
    }

    // Difficulty
    const diff = s['difficulty'];
    if (!isInt(diff, LIMITS.difficulty.min, LIMITS.difficulty.max)) push('invalid-difficulty', `${sp}.difficulty`, `difficulty must be an integer ${LIMITS.difficulty.min}-${LIMITS.difficulty.max}`);
    else {
      const band = isStr(gid) ? bands.get(gid) : undefined;
      if (band && (diff < band[0] || diff > band[1])) push('invalid-difficulty', `${sp}.difficulty`, `difficulty ${diff} is outside the galaxy band ${band[0]}-${band[1]}`);
    }

    // Resources
    const res = s['resources'];
    if (!isObj(res) || !isIn(RESOURCE_IDS, res['primary']) || !(res['secondary'] === null || isIn(RESOURCE_IDS, res['secondary'])) || res['secondary'] === res['primary'] || !isInt(res['richness'], 1, 3)) {
      push('invalid-resources', `${sp}.resources`, 'resources need a known primary, a different secondary or null, and richness 1-3');
    }

    // Encounters
    const rawEnc = s['encounters'];
    // legacy faction ids (pre Prompt 9) are accepted and checked as the faction they map to
    const enc = isObj(rawEnc) && Array.isArray(rawEnc['factions']) ? { ...rawEnc, factions: (rawEnc['factions'] as unknown[]).map((f) => (typeof f === 'string' ? normalFaction(f) : f)) } : rawEnc;
    if (!isObj(enc) || !isInt(enc['threat'], 0, 3) || !isIn(ENCOUNTER_PATTERNS, enc['pattern']) || !strArray(enc['factions']) || !enc['factions'].every((f) => isIn(FACTION_IDS, f)) || new Set(enc['factions']).size !== enc['factions'].length) {
      push('invalid-encounters', `${sp}.encounters`, 'encounters need threat 0-3, a known pattern and unique known factions');
    } else {
      const threat = enc['threat'];
      const hostile = (enc['factions'] as string[]).filter((f) => (HOSTILE_FACTIONS as readonly string[]).includes(f));
      if ((threat === 0) !== (enc['pattern'] === 'none')) push('invalid-encounters', `${sp}.encounters`, 'pattern "none" exactly when threat is 0');
      if (threat > 0 && hostile.length === 0) push('invalid-encounters', `${sp}.encounters`, 'a threatening system needs a hostile faction');
      if (threat === 0 && hostile.length > 0) push('invalid-encounters', `${sp}.encounters`, 'a safe system cannot host hostile factions');
      if (typeof diff === 'number' && (threat > diff || (threat === 3 && diff < 3))) push('invalid-encounters', `${sp}.encounters`, `threat ${threat} does not fit difficulty ${String(diff)}`);
    }

    // Discovery and unlock
    if (!isIn(DISCOVERY_STATES, s['discovery'])) push('invalid-discovery', `${sp}.discovery`, 'unknown discovery state');
    const unlock = s['unlock'];
    if (!Array.isArray(unlock)) push('invalid-unlock', `${sp}.unlock`, 'unlock must be an array');
    else {
      unlock.forEach((u, k) => checkUnlock(u, `${sp}.unlock[${k}]`, { systems: systemIds, galaxies: galaxyIds, milestones: milestoneIds, self: id }, push));
      if (s['discovery'] === 'hidden' && unlock.length === 0) push('invalid-discovery', `${sp}.discovery`, 'a hidden system needs at least one unlock requirement');
    }

    // Seed
    const seed = s['seed'];
    if (!isInt(seed, 0, 0xffffffff) || seed !== systemSeed(id)) push('invalid-seed', `${sp}.seed`, 'seed must be the uint32 derived from the id');
    else if (seeds.has(seed)) push('duplicate-seed', `${sp}.seed`, `seed collides with ${seeds.get(seed)}`);
    else seeds.set(seed, id);

    // Sector
    const sec = s['sector'];
    if (!isObj(sec)) push('invalid-sector', `${sp}.sector`, 'sector config required');
    else {
      const bad = (m: string): void => push('invalid-sector', `${sp}.sector`, m);
      const missing = SECTOR_FIELDS.filter((f) => !(f in sec));
      if (missing.length) bad(`missing ${missing.join(', ')}`);
      const arch = rules.archetypes.find((a) => a.id === sec['archetype']);
      if (!isIn(SECTOR_ARCHETYPES, sec['archetype']) || !arch) bad(`unknown archetype "${String(sec['archetype'])}"`);
      else {
        const allowed = isIn(SYSTEM_CATEGORIES, s['category']) ? rules.categoryArchetypes[s['category']] : [];
        if (!allowed.includes(arch.id)) bad(`archetype "${arch.id}" does not suit category "${String(s['category'])}"`);
        if (!arch.hazards.includes(sec['hazard'] as never)) bad(`hazard "${String(sec['hazard'])}" is not allowed for "${arch.id}"`);
      }
      for (const dim of ['width', 'height'] as const) {
        const v = sec[dim];
        if (!isInt(v, LIMITS.sectorSize.min, LIMITS.sectorSize.max) || v % LIMITS.sectorGrid !== 0) bad(`${dim} must be ${LIMITS.sectorSize.min}-${LIMITS.sectorSize.max} in steps of ${LIMITS.sectorGrid}`);
      }
      const dens = sec['density'];
      if (typeof dens !== 'number' || !Number.isFinite(dens) || dens < 0 || dens > 1) bad('density must be within 0..1');
      if (!isInt(sec['salvageNodes'], LIMITS.salvageNodes.min, LIMITS.salvageNodes.max)) bad('salvageNodes out of range');
      const slots = sec['encounterSlots'];
      if (!isInt(slots, LIMITS.encounterSlots.min, LIMITS.encounterSlots.max)) bad('encounterSlots out of range');
      else if (isObj(enc) && (enc['threat'] === 0) !== (slots === 0)) bad('encounterSlots must be 0 exactly when threat is 0');
      if (!isIn(HAZARDS, sec['hazard'])) bad('unknown hazard');
      const hs = sec['hazardStrength'];
      if (typeof hs !== 'number' || !Number.isFinite(hs) || (sec['hazard'] === 'none' ? hs !== 0 : !(hs > 0 && hs <= 1))) bad('hazardStrength must be 0 for no hazard, otherwise within (0, 1]');
      if (typeof sec['station'] !== 'boolean') bad('station must be boolean');
    }

    // Gateway flag
    if (typeof s['gateway'] !== 'boolean') push('invalid-field', `${sp}.gateway`, 'gateway must be boolean');
  });

  // Name uniqueness beyond exact matches: near-identical spellings and over-used stems.
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      const x = names[a]!;
      const y = names[b]!;
      if (x.verified && y.verified) continue; // real designations may legitimately resemble each other
      if (x.norm.length >= 5 && y.norm.length >= 5 && x.norm !== y.norm && levenshtein(x.norm, y.norm) <= 2) push('similar-name', `system ${y.id}.name`, `name is confusable with ${x.id}`);
    }
  }
  for (const [stem, ids] of stems) if (ids.length > 2) push('repetitive-name', 'systems', `name stem "${stem}" starts ${ids.length} names (${ids.join(', ')})`);

  /* ------------------------------------------------ per-galaxy checks */
  for (const gid of galaxyIds) {
    const list = perGalaxy.get(gid) ?? [];
    const gp = `galaxy ${gid}`;
    if (list.length < LIMITS.systemsPerGalaxy.min || list.length > LIMITS.systemsPerGalaxy.max) push('system-count', gp, `expected ${LIMITS.systemsPerGalaxy.min}-${LIMITS.systemsPerGalaxy.max} systems, found ${list.length}`);
    const gateways = list.filter((s) => s['gateway'] === true);
    if (gateways.length !== 1) push('invalid-gateway', gp, `exactly one gateway system required, found ${gateways.length}`);
    const band = bands.get(gid);
    for (const gw of gateways) {
      const p = `system ${String(gw['id'])}`;
      const sec = gw['sector'];
      if (gw['discovery'] !== 'charted') push('invalid-gateway', p, 'a gateway must start charted');
      if (!Array.isArray(gw['unlock']) || gw['unlock'].length > 0) push('invalid-gateway', p, 'a gateway cannot have unlock requirements (its galaxy has them)');
      if (band && gw['difficulty'] !== band[0]) push('invalid-gateway', p, 'a gateway must sit at the bottom of the galaxy band');
      if (!isObj(sec) || sec['station'] !== true) push('invalid-gateway', p, 'a gateway needs a station');
    }
    // Lanes: existence, same galaxy, no self/duplicates, symmetric, degree, connected.
    const ids = new Set(list.map((s) => String(s['id'])));
    for (const s of list) {
      const p = `system ${String(s['id'])}.connections`;
      const conns = s['connections'];
      if (!strArray(conns)) {
        push('invalid-connection', p, 'connections must be system ids');
        continue;
      }
      if (new Set(conns).size !== conns.length) push('invalid-connection', p, 'duplicate lane');
      if (conns.length < LIMITS.connectionsPerSystem.min || conns.length > LIMITS.connectionsPerSystem.max) push('invalid-connection', p, `a system needs ${LIMITS.connectionsPerSystem.min}-${LIMITS.connectionsPerSystem.max} lanes, has ${conns.length}`);
      for (const c of conns) {
        if (c === s['id']) push('invalid-connection', p, 'lane to itself');
        else if (!systemIds.has(c)) push('invalid-connection', p, `lane to unknown system "${c}"`);
        else if (!ids.has(c)) push('invalid-connection', p, `lane "${c}" leaves the galaxy (inter-galaxy travel uses routes)`);
        else {
          const back = systemById.get(c)?.['connections'];
          if (!strArray(back) || !back.includes(String(s['id']))) push('invalid-connection', p, `lane to "${c}" is not symmetric`);
        }
      }
    }
    const start = gateways[0];
    if (start) {
      const seen = new Set<string>([String(start['id'])]);
      const queue = [String(start['id'])];
      while (queue.length) {
        const cur = systemById.get(queue.shift()!);
        const conns = cur?.['connections'];
        if (!strArray(conns)) continue;
        for (const c of conns) if (ids.has(c) && !seen.has(c)) (seen.add(c), queue.push(c));
      }
      for (const sid of ids) if (!seen.has(sid)) push('disconnected', `system ${sid}`, `not reachable by lanes from gateway ${String(start['id'])}`);
    }
  }

  /* ------------------------------------------ unlock graph: cycles + reach */
  type Req = { kind: string; systemId?: string; galaxyId?: string; milestoneId?: string; tier?: number };
  const reqList = (raw: unknown): Req[] => (Array.isArray(raw) ? raw.filter(isObj).map((r) => r as Req) : []);
  const galaxyReqs = (g: Obj | undefined): Req[] => reqList((g?.['gameplay'] as Obj | undefined)?.['unlock']);
  // Dependency edges: node -> prerequisites. Systems depend on their galaxy; milestones on the galaxies and milestones their condition names.
  const deps = new Map<string, string[]>();
  const toNode = (r: Req): string | null =>
    r.kind === 'system' && r.systemId ? `s:${r.systemId}` : r.kind === 'galaxy' && r.galaxyId ? `g:${r.galaxyId}` : r.kind === 'milestone' && r.milestoneId ? `m:${r.milestoneId}` : null;
  for (const [gid, g] of galaxyById) deps.set(`g:${gid}`, galaxyReqs(g).map(toNode).filter((x): x is string => x !== null));
  for (const s of valid) {
    const own = reqList(s['unlock']).map(toNode).filter((x): x is string => x !== null);
    deps.set(`s:${String(s['id'])}`, [...own, `g:${String(s['galaxyId'])}`]);
  }
  for (const [mid, m] of milestoneById) {
    const refs = conditionRefs(m['condition']);
    deps.set(`m:${mid}`, [...refs.galaxies.map((x) => `g:${x}`), ...refs.milestones.map((x) => `m:${x}`)]);
  }
  const state = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const visit = (node: string, stack: string[]): void => {
    state.set(node, 1);
    for (const next of deps.get(node) ?? []) {
      if (state.get(next) === 1) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const key = [...cycle].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          push('unlock-cycle', node, `unlock requirements form a cycle: ${cycle.join(' -> ')}`);
        }
      } else if (!state.has(next) && deps.has(next)) visit(next, [...stack, next]);
    }
    state.set(node, 2);
  };
  for (const node of deps.keys()) if (!state.has(node)) visit(node, [node]);

  // Reachability: a fixed point from the home galaxy over routes, lanes,
  // requirements and milestones. Survey counts are assumed attainable (their
  // ranges are checked above); a milestone about a galaxy is attainable once
  // that galaxy is reached; drive tiers come only from milestone rewards.
  // (The exact first-session pacing is tested by simulating a player in
  // tests/galaxyMap.test.ts.)
  const reachedG = new Set<string>();
  const reachedS = new Set<string>();
  const reachedM = new Set<string>();
  let maxDrive: number = LIMITS.driveTier.min;
  const step = isObj(prog) && typeof prog['explorerLevelStep'] === 'number' && prog['explorerLevelStep'] > 0 ? prog['explorerLevelStep'] : 1;
  const maxLevel = 1 + Math.floor(valid.length / step);
  const metReq = (r: Req): boolean =>
    r.kind === 'system' ? reachedS.has(r.systemId ?? '') : r.kind === 'galaxy' ? reachedG.has(r.galaxyId ?? '') : r.kind === 'milestone' ? reachedM.has(r.milestoneId ?? '') : r.kind === 'drive' ? (r.tier ?? Infinity) <= maxDrive : true;
  const met = (reqs: Req[]): boolean => reqs.every(metReq);
  const condOk = (c: unknown): boolean => {
    if (!isObj(c)) return false;
    switch (c['kind']) {
      case 'surveys-in':
      case 'exploration':
        return reachedG.has(String(c['galaxyId']));
      case 'explorer-level':
        return typeof c['level'] === 'number' && c['level'] <= maxLevel;
      case 'milestone':
        return reachedM.has(String(c['milestoneId']));
      case 'all':
        return Array.isArray(c['of']) && c['of'].every(condOk);
      case 'any':
        return Array.isArray(c['of']) && c['of'].some(condOk);
      default:
        return false;
    }
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [gid, g] of galaxyById) {
      if (reachedG.has(gid)) continue;
      const linked =
        g['relation'] === 'home' ||
        [...routeById.values()].some((r) => {
          const other = r['from'] === gid ? String(r['to']) : r['to'] === gid ? String(r['from']) : null;
          return other !== null && reachedG.has(other) && met(reqList(r['unlock']));
        });
      if (linked && met(galaxyReqs(g))) (reachedG.add(gid), (changed = true));
    }
    for (const [mid, m] of milestoneById) {
      if (reachedM.has(mid) || !condOk(m['condition'])) continue;
      reachedM.add(mid);
      changed = true;
      const tier = (m['rewards'] as Obj | undefined)?.['driveTier'];
      if (typeof tier === 'number') maxDrive = Math.max(maxDrive, tier);
    }
    for (const s of valid) {
      const sid = String(s['id']);
      if (reachedS.has(sid) || !reachedG.has(String(s['galaxyId']))) continue;
      const conns = s['connections'];
      const adjacent = s['gateway'] === true || (strArray(conns) && conns.some((c) => reachedS.has(c)));
      if (adjacent && met(reqList(s['unlock']))) (reachedS.add(sid), (changed = true));
    }
  }
  for (const gid of galaxyById.keys()) if (!reachedG.has(gid)) push('unreachable', `galaxy ${gid}`, 'can never be unlocked from the home galaxy');
  for (const mid of milestoneById.keys()) if (!reachedM.has(mid)) push('unreachable', `milestone ${mid}`, 'its condition can never be met');
  for (const [key, r] of routeById) if (!met(reqList(r['unlock']))) push('unreachable', `route ${key}`, 'its unlock requirements can never be met');
  for (const s of valid) {
    const sid = String(s['id']);
    if (!reachedS.has(sid) && reachedG.has(String(s['galaxyId']))) push('unreachable', `system ${sid}`, 'its unlock requirements and lanes can never all be satisfied');
  }

  /* --------------------------------------------------- orphan sources */
  for (const id of sourceTier.keys()) if (!usedSources.has(id)) push('unused-source', `source ${id}`, 'source is not cited by any record');

  return issues;
}

/** Throwing wrapper for tooling: formats every issue on its own line. */
export function assertValidCatalogue(input: CatalogueInput, rules?: ValidationRules): void {
  const issues = validateCatalogue(input, rules);
  if (issues.length) throw new Error(`Catalogue validation failed (${issues.length}):\n${issues.map((x) => `  [${x.code}] ${x.path}: ${x.message}`).join('\n')}`);
}
