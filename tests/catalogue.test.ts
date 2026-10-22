import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCatalogue,
  catalogueDigest,
  catalogueIssues,
  getCatalogue,
  indexCatalogue,
  normalizeName,
  systemSeed,
  validateCatalogue,
  CATALOGUE_VERSION,
  GALAXY_IDS,
  LIMITS,
  type Catalogue,
  type IssueCode,
} from '../src/modes/freeroam/catalogue/index.ts';
import { ARCHETYPES } from '../src/modes/freeroam/catalogue/data/archetypes.ts';
import { GALAXIES } from '../src/modes/freeroam/catalogue/data/galaxies.ts';
import { MILESTONES, PROGRESSION } from '../src/modes/freeroam/catalogue/data/milestones.ts';
import { ROUTES } from '../src/modes/freeroam/catalogue/data/routes.ts';
import { SOURCES } from '../src/modes/freeroam/catalogue/data/sources.ts';
import { SYSTEM_DATA } from '../src/modes/freeroam/catalogue/data/systems/index.ts';
import { levenshtein } from '../src/modes/freeroam/catalogue/validate.ts';

/* Mutable deep copy of the shipped catalogue for negative tests. */
type Loose = { sources: Record<string, any>[]; galaxies: Record<string, any>[]; systems: any[]; routes: Record<string, any>[]; milestones: Record<string, any>[]; progression: Record<string, any> };
const fresh = (): Loose => structuredClone(getCatalogue()) as unknown as Loose;
const sys = (c: Loose, id: string): Record<string, any> => {
  const s = c.systems.find((x: Record<string, any>) => x['id'] === id);
  if (!s) throw new Error(`no system ${id}`);
  return s;
};
const gal = (c: Loose, id: string): Record<string, any> => c.galaxies.find((g) => g['id'] === id)!;
const codes = (c: Loose): IssueCode[] => validateCatalogue(c).map((i) => i.code);
const expectIssue = (c: Loose, code: IssueCode, pathPart?: string): void => {
  const issues = validateCatalogue(c);
  const hit = issues.filter((i) => i.code === code && (!pathPart || i.path.includes(pathPart)));
  expect(hit, `expected ${code}${pathPart ? ` at ${pathPart}` : ''}; got ${JSON.stringify(issues.map((i) => `${i.code} ${i.path}`))}`).not.toHaveLength(0);
};

describe('catalogue: shipped data', () => {
  const cat = getCatalogue();

  it('validates with zero issues', () => {
    expect(catalogueIssues()).toEqual([]);
  });

  it('has the ten requested real galaxies with distinct, correct classifications', () => {
    expect(cat.galaxies.map((g) => g.id)).toEqual([...GALAXY_IDS]);
    const cls = Object.fromEntries(cat.galaxies.map((g) => [g.id, g.morphology.class]));
    expect(cls).toEqual({
      'milky-way': 'barred-spiral',
      andromeda: 'spiral',
      triangulum: 'spiral',
      lmc: 'magellanic-spiral',
      smc: 'dwarf-irregular',
      whirlpool: 'interacting-spiral',
      pinwheel: 'intermediate-spiral',
      sombrero: 'spiral-or-elliptical',
      'centaurus-a': 'peculiar-elliptical',
      cartwheel: 'ring',
    });
    expect(new Set(Object.values(cls)).size).toBeGreaterThanOrEqual(8);
    const rel = Object.fromEntries(cat.galaxies.map((g) => [g.id, [g.relation, g.relatedTo]]));
    expect(rel['lmc']).toEqual(['milky-way-satellite', 'milky-way']);
    expect(rel['smc']).toEqual(['milky-way-satellite', 'milky-way']);
    expect(rel['milky-way']).toEqual(['home', null]);
    expect(rel['whirlpool']![0]).toBe('interacting-pair');
    // Disputed types carry an explanatory note rather than a false certainty.
    for (const id of ['sombrero', 'centaurus-a', 'lmc']) expect(cat.galaxies.find((g) => g.id === id)!.morphology.note).toBeTruthy();
  });

  it('keeps 15-20 systems per galaxy and 150-200 overall', () => {
    expect(cat.systems.length).toBeGreaterThanOrEqual(LIMITS.systemsTotal.min);
    expect(cat.systems.length).toBeLessThanOrEqual(LIMITS.systemsTotal.max);
    const idx = indexCatalogue(cat);
    for (const g of GALAXY_IDS) {
      const n = idx.systemsIn(g).length;
      expect(n, g).toBeGreaterThanOrEqual(15);
      expect(n, g).toBeLessThanOrEqual(20);
    }
  });

  it('uses every provenance category, with fiction and procedural and speculative content in every galaxy', () => {
    for (const g of GALAXY_IDS) {
      const kinds = new Set(cat.systems.filter((s) => s.galaxyId === g).map((s) => s.provenance.status));
      expect([...kinds].sort(), g).toEqual(['fictional', 'procedural', 'speculative', 'verified-object']);
    }
    expect(cat.galaxies.every((g) => g.provenance.status === 'verified-destination')).toBe(true);
  });

  it('cites a primary source for every verified object and keeps invented systems free of facts and citations', () => {
    const primary = new Set(cat.sources.filter((s) => s.tier === 'primary').map((s) => s.id));
    for (const s of cat.systems) {
      if (s.provenance.status === 'verified-object') {
        expect(s.fact, s.id).toBeTruthy();
        expect(s.provenance.sourceIds.some((id) => primary.has(id)), s.id).toBe(true);
        expect(s.provenance.note, s.id).toMatch(/simulation/i);
      } else {
        expect(s.fact, s.id).toBeNull();
        expect(s.provenance.sourceIds, s.id).toEqual([]);
      }
    }
  });

  it('never presents individual stars or planets in other galaxies as real', () => {
    const allowed = new Set(['stellar-nursery', 'supernova-remnant', 'supernova-site', 'satellite-galaxy', 'star-cluster', 'galactic-structure', 'black-hole']);
    for (const s of cat.systems) {
      if (s.galaxyId === 'milky-way' || s.provenance.status !== 'verified-object') continue;
      expect(allowed.has(s.category), `${s.id} (${s.category})`).toBe(true);
      expect(s.fact!, s.id).not.toMatch(/\bplanets?\b/i);
    }
    // Planet counts appear only where well sourced (TRAPPIST-1 and Barnard's Star).
    const planetFacts = cat.systems.filter((s) => s.fact && /\bplanets?\b/i.test(s.fact)).map((s) => s.id);
    expect(planetFacts.sort()).toEqual(['milky-way/barnards-star', 'milky-way/trappist-1']);
  });

  it('gives invented systems original names without numbers', () => {
    const invented = cat.systems.filter((s) => s.provenance.status !== 'verified-object');
    for (const s of invented) expect(s.name, s.id).not.toMatch(/\d/);
    expect(new Set(cat.systems.map((s) => normalizeName(s.name))).size).toBe(cat.systems.length);
  });

  it('stores source metadata locally with retrieval dates and https URLs', () => {
    expect(cat.sources.length).toBeGreaterThan(40);
    for (const s of cat.sources) {
      expect(s.url, s.id).toMatch(/^https:\/\//);
      expect(s.retrieved, s.id).toBe('2026-10-19');
    }
  });

  it('is deterministic, frozen and pinned by a golden digest', () => {
    const again = buildCatalogue({ sources: SOURCES, galaxies: GALAXIES, systems: SYSTEM_DATA, archetypes: ARCHETYPES, routes: ROUTES, milestones: MILESTONES, progression: PROGRESSION });
    expect(again).toEqual(cat);
    expect(Object.isFrozen(cat)).toBe(true);
    expect(Object.isFrozen(cat.systems[0]!.sector)).toBe(true);
    expect(CATALOGUE_VERSION).toBe(2);
    // Golden values: changing a seed re-rolls a sector players may have saved.
    expect(systemSeed('milky-way/sol')).toBe(2794121779);
    expect(systemSeed('lmc/tarantula-nebula')).toBe(735266127);
    expect(systemSeed('cartwheel/the-hush')).toBe(1034747242);
    for (const s of cat.systems) expect(s.seed).toBe(systemSeed(s.id));
    // Content digest: update deliberately (and note it in the changelog) when data changes.
    expect(catalogueDigest(cat)).toBe(DIGEST);
  });

  it('is mirrored in docs/freeroam/ASTRONOMY_SOURCES.md (every source URL and verified object)', () => {
    const doc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'freeroam', 'ASTRONOMY_SOURCES.md'), 'utf8');
    for (const s of cat.sources) expect(doc, s.id).toContain(s.url);
    for (const s of cat.systems.filter((x) => x.provenance.status === 'verified-object')) expect(doc, s.id).toContain(`\`${s.id}\``);
  });

  it('does not mutate the authored data while building', () => {
    const before = JSON.stringify({ GALAXIES, SYSTEM_DATA, SOURCES, ROUTES, MILESTONES });
    buildCatalogue({ sources: SOURCES, galaxies: GALAXIES, systems: SYSTEM_DATA, archetypes: ARCHETYPES, routes: ROUTES, milestones: MILESTONES, progression: PROGRESSION });
    expect(JSON.stringify({ GALAXIES, SYSTEM_DATA, SOURCES, ROUTES, MILESTONES })).toBe(before);
  });

  it('builds symmetric lanes from one-way authored links and indexes records', () => {
    const idx = indexCatalogue(cat);
    expect(idx.system('milky-way/hollowmere')!.connections).toEqual(['milky-way/alpha-centauri', 'milky-way/saltmarch']);
    expect(idx.galaxy('lmc')!.gameplay.gatewaySystemId).toBe('lmc/southwind-landing');
    expect(idx.source('nasa-m31')!.publisher).toMatch(/NASA/);
    expect(idx.system('nope/nothing')).toBeUndefined();
    expect(idx.route('andromeda~milky-way')!.unlock).toEqual([{ kind: 'milestone', milestoneId: 'lantern-gate' }]);
    expect(idx.milestone('first-survey')!.kind).toBe('starter-objective');
    expect(idx.route('milky-way~andromeda')).toBeUndefined(); // ids are canonical (from < to)
  });

  it('derives sector configs inside their bounds', () => {
    for (const s of cat.systems) {
      expect(s.sector.width % LIMITS.sectorGrid, s.id).toBe(0);
      expect(s.sector.encounterSlots === 0, s.id).toBe(s.encounters.threat === 0);
      expect(s.gateway ? s.sector.station : true, s.id).toBe(true);
    }
  });
});

describe('catalogue validation: detects broken content', () => {
  it('detects duplicate ids', () => {
    const c = fresh();
    c.systems.push(structuredClone(c.systems[3]));
    expectIssue(c, 'duplicate-id');
  });

  it('detects duplicate names, ignoring case, spacing and punctuation', () => {
    const c = fresh();
    sys(c, 'milky-way/saltmarch')['name'] = '  morrows ANCHOR ';
    expectIssue(c, 'duplicate-name', 'saltmarch');
  });

  it('detects confusable and generic numbered or real-star names', () => {
    const c = fresh();
    sys(c, 'milky-way/saltmarch')['name'] = 'Hollowmeer';
    expectIssue(c, 'similar-name');
    const d = fresh();
    sys(d, 'milky-way/saltmarch')['name'] = 'Sector Seven 7';
    sys(d, 'milky-way/cinderwake')['name'] = 'Vega Reach';
    sys(d, 'milky-way/larkspur')['name'] = 'NGC Haven';
    const bad = validateCatalogue(d).filter((i) => i.code === 'invalid-name').map((i) => i.path);
    expect(bad).toEqual(expect.arrayContaining([expect.stringContaining('saltmarch'), expect.stringContaining('cinderwake'), expect.stringContaining('larkspur')]));
    const e = fresh();
    for (const id of ['milky-way/saltmarch', 'milky-way/cinderwake', 'milky-way/larkspur']) sys(e, id)['name'] = `Ember ${id.split('/')[1]}`;
    expectIssue(e, 'repetitive-name');
  });

  it('detects missing or invalid parent references', () => {
    const c = fresh();
    sys(c, 'lmc/brinehold')['galaxyId'] = 'm87';
    expectIssue(c, 'invalid-parent', 'lmc/brinehold');
    const d = fresh();
    gal(d, 'smc')['relatedTo'] = 'nowhere';
    expectIssue(d, 'invalid-parent', 'galaxy smc');
  });

  it('detects missing required properties', () => {
    const c = fresh();
    delete sys(c, 'smc/frostlace')['description'];
    delete gal(c, 'pinwheel')['facts'];
    expectIssue(c, 'missing-field', 'description');
    expectIssue(c, 'missing-field', 'facts');
  });

  it('detects invalid difficulty values and values outside the galaxy band', () => {
    for (const bad of [0, 6, 2.5, '3', null]) {
      const c = fresh();
      sys(c, 'milky-way/saltmarch')['difficulty'] = bad;
      expect(codes(c), String(bad)).toContain('invalid-difficulty');
    }
    const c = fresh();
    sys(c, 'centaurus-a/bulwark')['difficulty'] = 2; // band is 4-5
    expectIssue(c, 'invalid-difficulty', 'bulwark');
  });

  it('detects invalid unlock prerequisites', () => {
    const cases: [string, unknown][] = [
      ['unknown system', { kind: 'system', systemId: 'lmc/atlantis' }],
      ['self reference', { kind: 'system', systemId: 'lmc/undertow' }],
      ['bad drive tier', { kind: 'drive', tier: 9 }],
      ['bad survey count', { kind: 'surveys', count: 0 }],
      ['unknown kind', { kind: 'karma', amount: 3 }],
      ['unknown galaxy', { kind: 'galaxy', galaxyId: 'm87' }],
    ];
    for (const [label, req] of cases) {
      const c = fresh();
      sys(c, 'lmc/undertow')['unlock'] = [req];
      expect(codes(c), label).toContain('invalid-unlock');
    }
  });

  it('detects unlock cycles and unreachable content', () => {
    const c = fresh();
    sys(c, 'lmc/undertow')['unlock'] = [{ kind: 'system', systemId: 'lmc/the-drowned-lens' }];
    expectIssue(c, 'unlock-cycle');
    expectIssue(c, 'unreachable', 'lmc/undertow');
    const d = fresh();
    gal(d, 'cartwheel')['gameplay']['unlock'] = [{ kind: 'system', systemId: 'cartwheel/hubstone' }];
    expectIssue(d, 'unlock-cycle');
    expectIssue(d, 'unreachable', 'galaxy cartwheel');
    const e = fresh();
    sys(e, 'smc/the-quiet-engine')['discovery'] = 'hidden';
    sys(e, 'smc/the-quiet-engine')['unlock'] = [];
    expectIssue(e, 'invalid-discovery', 'the-quiet-engine');
  });

  it('detects missing or inconsistent provenance and uncited facts', () => {
    const a = fresh();
    sys(a, 'milky-way/sirius')['provenance'] = {};
    expectIssue(a, 'missing-provenance', 'sirius');
    const b = fresh();
    sys(b, 'milky-way/sirius')['provenance']['sourceIds'] = [];
    expectIssue(b, 'invalid-provenance', 'sirius');
    const c = fresh();
    sys(c, 'lmc/brinehold')['fact'] = 'A real star with three confirmed planets.';
    expectIssue(c, 'invalid-provenance', 'brinehold');
    const d = fresh();
    sys(d, 'lmc/the-drowned-lens')['provenance']['note'] = null;
    expectIssue(d, 'invalid-provenance', 'the-drowned-lens');
    const e = fresh();
    sys(e, 'milky-way/sirius')['provenance']['sourceIds'] = ['made-up-source'];
    expectIssue(e, 'invalid-source', 'sirius');
    const f = fresh();
    sys(f, 'milky-way/sirius')['provenance']['sourceIds'] = ['wiki-milky-way']; // secondary only
    expectIssue(f, 'invalid-provenance', 'sirius');
    const g = fresh();
    gal(g, 'andromeda')['provenance'] = { status: 'unverified', sourceIds: [] };
    gal(g, 'triangulum')['facts'][0]['sourceIds'] = [];
    expectIssue(g, 'missing-provenance', 'galaxy andromeda');
    expectIssue(g, 'invalid-provenance', 'galaxy triangulum.facts[0]');
    const h = fresh();
    h.sources.push({ id: 'orphan', title: 'x', publisher: 'y', url: 'https://example.org', retrieved: '2026-10-19', tier: 'primary' });
    expectIssue(h, 'unused-source', 'orphan');
  });

  it('flags invented content that reads like a real observation', () => {
    const c = fresh();
    sys(c, 'pinwheel/bunting')['description'] = 'Astronomers confirmed three exoplanets orbiting this red dwarf.';
    expectIssue(c, 'unsupported-claim', 'bunting');
  });

  it('detects galaxy and total counts outside the intended range', () => {
    const few = fresh();
    few.systems = few.systems.filter((s: Record<string, any>) => !(s['galaxyId'] === 'smc' && s['id'] === 'smc/sedgewind'));
    expectIssue(few, 'system-count', 'galaxy smc');
    const many = fresh();
    for (let i = 0; i < 3; i++) many.systems.push({ ...structuredClone(sys(many, 'milky-way/hollowmere')), id: `milky-way/extra-${'abc'[i]}`, name: `Extra ${'Alpha Beta Gamma'.split(' ')[i]}` });
    expectIssue(many, 'system-count', 'galaxy milky-way');
    const total = fresh();
    total.systems = total.systems.slice(0, 120);
    expectIssue(total, 'total-count');
    const galaxies = fresh();
    galaxies.galaxies.pop();
    expectIssue(galaxies, 'galaxy-count');
  });

  it('detects systems without a valid local-sector config', () => {
    const mutations: [string, (s: Record<string, any>) => void][] = [
      ['missing sector', (s) => delete s['sector']],
      ['bad width', (s) => (s['sector']['width'] = 1000)],
      ['off-grid height', (s) => (s['sector']['height'] = 4100)],
      ['density > 1', (s) => (s['sector']['density'] = 1.5)],
      ['unknown hazard', (s) => (s['sector']['hazard'] = 'lava')],
      ['unknown archetype', (s) => (s['sector']['archetype'] = 'castle')],
      ['archetype unsuited to category', (s) => (s['sector']['archetype'] = 'void-drift')],
      ['slots without threat', (s) => ((s['encounters']['threat'] = 0), (s['encounters']['pattern'] = 'none'), (s['encounters']['factions'] = []))],
      ['strength without hazard', (s) => ((s['sector']['hazard'] = 'none'), (s['sector']['hazardStrength'] = 0.5))],
    ];
    for (const [label, mutate] of mutations) {
      const c = fresh();
      mutate(sys(c, 'smc/thimble-cluster'));
      const found = codes(c);
      expect(found.includes('invalid-sector') || found.includes('missing-field'), `${label}: ${found.join(', ')}`).toBe(true);
    }
  });

  it('detects broken lanes, gateways and seeds', () => {
    const a = fresh();
    sys(a, 'lmc/brinehold')['connections'] = ['lmc/galleon-rest', 'lmc/southwind-landing', 'smc/frostlace'];
    expectIssue(a, 'invalid-connection', 'brinehold');
    const b = fresh();
    sys(b, 'lmc/scrimshaw')['connections'] = [];
    for (const s of b.systems) if (s['galaxyId'] === 'lmc') s['connections'] = s['connections'].filter((x: string) => x !== 'lmc/scrimshaw');
    expectIssue(b, 'disconnected', 'scrimshaw');
    const c = fresh();
    sys(c, 'lmc/southwind-landing')['discovery'] = 'rumoured';
    expectIssue(c, 'invalid-gateway', 'southwind-landing');
    const d = fresh();
    sys(d, 'lmc/brinehold')['seed'] = 12345;
    expectIssue(d, 'invalid-seed', 'brinehold');
    const e = fresh();
    gal(e, 'smc')['gameplay']['routes'] = ['milky-way', 'cartwheel'];
    expectIssue(e, 'invalid-field', 'galaxy smc.gameplay.routes'); // routes live in the route table now
  });

  it('detects invalid inter-galaxy routes', () => {
    const route = (c: Loose, id: string): Record<string, any> => c.routes.find((r) => r['id'] === id)!;
    const cases: [string, (c: Loose) => void, IssueCode, string][] = [
      ['unknown endpoint', (c) => (route(c, 'lmc~smc')['to'] = 'atlantis'), 'invalid-route', 'lmc~smc'],
      ['self route', (c) => (route(c, 'lmc~smc')['to'] = 'lmc'), 'invalid-route', 'lmc~smc'],
      ['non-canonical id', (c) => (route(c, 'lmc~smc')['id'] = 'smc~lmc'), 'invalid-id', 'smc~lmc'],
      ['duplicate pair', (c) => c.routes.push({ ...route(c, 'lmc~smc') }), 'duplicate-id', 'lmc~smc'],
      ['bad class', (c) => (route(c, 'lmc~smc')['routeClass'] = 'wormhole'), 'invalid-route', 'routeClass'],
      ['bad risk', (c) => (route(c, 'lmc~smc')['risk'] = 'mild'), 'invalid-route', 'risk'],
      ['bad encounter', (c) => (route(c, 'lmc~smc')['encounter'] = 'dragons'), 'invalid-route', 'encounter'],
      ['bad cost', (c) => (route(c, 'lmc~smc')['cost'] = 9), 'invalid-route', 'cost'],
      ['unknown milestone', (c) => (route(c, 'lmc~smc')['unlock'] = [{ kind: 'milestone', milestoneId: 'nope' }]), 'invalid-unlock', 'lmc~smc'],
      ['isolated galaxy', (c) => (c.routes = c.routes.filter((r) => r['from'] !== 'cartwheel' && r['to'] !== 'cartwheel')), 'invalid-route', 'galaxy cartwheel'],
      ['no open start', (c) => (route(c, 'lmc~milky-way')['unlock'] = route(c, 'milky-way~smc')['unlock'] = [{ kind: 'milestone', milestoneId: 'first-survey' }]), 'invalid-start', 'routes'],
      ['sealed forever', (c) => (route(c, 'cartwheel~sombrero')['unlock'] = [{ kind: 'galaxy', galaxyId: 'cartwheel' }]), 'unreachable', 'galaxy cartwheel'],
    ];
    for (const [label, mutate, code, part] of cases) {
      const c = fresh();
      mutate(c);
      expectIssue(c, code, part);
      void label;
    }
    // a fully connected map is rejected
    const full = fresh();
    const ids = GALAXY_IDS.slice().sort();
    full.routes = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) full.routes.push({ id: `${ids[i]}~${ids[j]}`, from: ids[i], to: ids[j], name: 'Test Lane', routeClass: 'local-lane', cost: 1, risk: 'low', encounter: 'none', unlock: [] });
    expectIssue(full, 'invalid-route', 'routes');
  });

  it('detects invalid milestones and progression settings', () => {
    const ms = (c: Loose, id: string): Record<string, any> => c.milestones.find((m) => m['id'] === id)!;
    const cases: [(c: Loose) => void, IssueCode, string][] = [
      [(c) => (ms(c, 'first-survey')['kind'] = 'quest'), 'invalid-milestone', 'first-survey.kind'],
      [(c) => (ms(c, 'first-survey')['condition'] = { kind: 'surveys-in', galaxyId: 'atlantis', count: 1 }), 'invalid-milestone', 'first-survey.condition'],
      [(c) => (ms(c, 'first-survey')['condition'] = { kind: 'exploration', galaxyId: 'lmc', percent: 0 }), 'invalid-milestone', 'first-survey.condition'],
      [(c) => (ms(c, 'first-survey')['condition'] = { kind: 'explorer-level', level: 99 }), 'invalid-milestone', 'first-survey.condition'],
      [(c) => (ms(c, 'first-survey')['condition'] = { kind: 'milestone', milestoneId: 'first-survey' }), 'invalid-milestone', 'first-survey.condition'],
      [(c) => (ms(c, 'first-survey')['condition'] = { kind: 'all', of: [{ kind: 'explorer-level', level: 2 }] }), 'invalid-milestone', 'first-survey.condition'],
      [(c) => (ms(c, 'first-survey')['condition'] = { kind: 'random-drop', chance: 0.01 }), 'invalid-milestone', 'first-survey.condition'],
      [(c) => (ms(c, 'first-survey')['rewards'] = { driveTier: 9, chartSystems: [] }), 'invalid-milestone', 'rewards.driveTier'],
      [(c) => (ms(c, 'first-survey')['rewards'] = { driveTier: null, chartSystems: ['milky-way/nowhere'] }), 'invalid-milestone', 'rewards.chartSystems'],
      [(c) => c.milestones.push({ ...ms(c, 'first-survey') }), 'duplicate-id', 'milestones'],
      [(c) => (ms(c, 'lantern-gate')['name'] = 'First Survey'), 'duplicate-name', 'lantern-gate.name'],
      [(c) => (c.progression['startGalaxy'] = 'lmc'), 'invalid-progression', 'startGalaxy'],
      [(c) => (c.progression['explorerLevelStep'] = 0), 'invalid-progression', 'explorerLevelStep'],
      [(c) => (gal(c, 'smc')['gameplay']['unlock'] = [{ kind: 'milestone', milestoneId: 'ghost' }]), 'invalid-unlock', 'galaxy smc'],
      [(c) => (gal(c, 'smc')['shortName'] = 'LMC'), 'duplicate-name', 'galaxy smc.shortName'],
      [(c) => (gal(c, 'smc')['shortName'] = 'Small Magellanic'), 'invalid-name', 'galaxy smc.shortName'],
    ];
    for (const [mutate, code, part] of cases) {
      const c = fresh();
      mutate(c);
      expectIssue(c, code, part);
    }
    // milestone cycle: Andromeda needs a milestone that needs Andromeda explored
    const cyc = fresh();
    ms(cyc, 'andromeda-charts')['condition'] = { kind: 'exploration', galaxyId: 'andromeda', percent: 10 };
    expectIssue(cyc, 'unlock-cycle');
    expectIssue(cyc, 'unreachable', 'galaxy andromeda');
  });

  it('reports malformed entries without throwing', () => {
    const c = fresh();
    c.systems.push(42, null, { id: 'lmc/half' });
    (c.galaxies as unknown[]).push('nope');
    expect(() => validateCatalogue(c)).not.toThrow();
    expect(codes(c)).toEqual(expect.arrayContaining(['invalid-field', 'missing-field']));
  });

  it('keeps the lenient builder honest: bad rows surface as validation issues', () => {
    const broken = SYSTEM_DATA.map((g) =>
      g.galaxyId !== 'lmc' ? g : { ...g, rows: g.rows.map((r) => (r.slug === 'brinehold' ? { ...r, archetype: 'castle' as never, links: [...r.links, 'atlantis'] } : r)) },
    );
    const cat: Catalogue = buildCatalogue({ sources: SOURCES, galaxies: GALAXIES, systems: broken, archetypes: ARCHETYPES, routes: ROUTES, milestones: MILESTONES, progression: PROGRESSION });
    const found = validateCatalogue(cat).map((i) => `${i.code} ${i.path}`);
    expect(found).toEqual(expect.arrayContaining(['invalid-sector system lmc/brinehold.sector', 'invalid-connection system lmc/brinehold.connections']));
  });

  it('normalises names and measures edit distance', () => {
    expect(normalizeName('  The Morrow’s  Anchor ')).toBe('morrows anchor');
    expect(normalizeName('Café Ñandú')).toBe('cafe nandu');
    expect(levenshtein('shoalmark', 'whorlmark')).toBe(2);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });
});

// Prompt 9: factions renamed (tessellate / red-tally / cordon, gleaners added to 62 salvage-rich systems) -> new digest.
// Prompt 15: the Cartwheel Core fact reworded (it followed ESA/Webb's CC BY text too closely) -> new digest.
const DIGEST = '17a5f124';
