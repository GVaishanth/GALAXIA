/**
 * Finale P1: the Admin panel's DIAGNOSTICS tab (src/modes/freeroam/admin/diagnostics.ts).
 *
 * The tab's functions run against a real sector run and a real progression state through a DiagHost
 * shaped like the shell's (the shell lends spawnAgent and the ledger's award exactly like this).
 * Checks: authoritative read-outs, safe refusals that change nothing, success paths, restoration of
 * forced modes per visit, no duplicate rewards, no forced outcome outside a session or the QA hooks,
 * and no Admin secret anywhere near the tab.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAG_SPAWN, diagCritMode, diagnosticsModel, diagRewardGuard, diagRuleCheck, diagSpawn, slotPrint, type DiagHost } from '../src/modes/freeroam/admin/diagnostics.ts';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { abilityStatus } from '../src/modes/freeroam/combat/shipAbilities.ts';
import { stealthStatus } from '../src/modes/freeroam/combat/stealth.ts';
import { EMPTY_CREW } from '../src/modes/freeroam/crew/state.ts';
import { shipCrewView } from '../src/modes/freeroam/crew/view.ts';
import { NO_VESSELS } from '../src/modes/freeroam/fleet/vessels.ts';
import { award, EMPTY_LEDGER } from '../src/modes/freeroam/progression/ledger.ts';
import { ledgerOf, progressionFromSaved, withLedger, type ProgressionState } from '../src/modes/freeroam/progression/persistence.ts';
import { EMPTY_PROGRESSION } from '../src/modes/freeroam/profile.ts';
import { EMPTY_SECTOR_SAVE } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, stepSector, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import { arena } from './helpers/combatProbe.ts';

const src = join(__dirname, '..', 'src');
const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));

function flying(): SectorRun {
  const L = arena(1);
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 21, ship: deriveShip('shrike') });
  r.grace = 100_000;
  Object.assign(r.ship, { x: L.width / 2, y: L.height / 2, px: L.width / 2, py: L.height / 2, vx: 0, vy: 0, heading: 0 });
  return r;
}

/** A host shaped like the shell's: the session, the run, the progression and the lent actions. */
function host(o: { run?: SectorRun | null; session?: object | null; prog?: ProgressionState; slot?: string | null } = {}) {
  const state = { run: o.run === undefined ? flying() : o.run, session: o.session === undefined ? {} : o.session, prog: o.prog ?? progressionFromSaved(EMPTY_PROGRESSION), slot: o.slot === undefined ? '{"v":10}' : o.slot, claims: 0 };
  const h: DiagHost = {
    session: () => state.session,
    run: () => state.run,
    prog: () => state.prog,
    vessels: () => NO_VESSELS,
    crew: () => shipCrewView(EMPTY_CREW, 'shrike'),
    heat: () => undefined,
    chains: () => [],
    fleetLines: () => ['VESSELS · none', 'WING · not flying'],
    slot: () => state.slot,
    persists: () => state.session === null,
    // the shell's claimMission refuses every turn-in during Admin Access (and only pays outside it)
    claim: () => {
      state.claims += 1;
      return { ok: false, text: 'Exit Admin Access to turn in missions: the sandbox pays no rewards.' };
    },
    spawn: (family, x, y, heading) => (state.run ? spawnAgent(state.run, family, 'red-tally', 'admin-probe', 'guard', x, y, heading) : null),
    rewardRepeat: (id) => award(ledgerOf(state.prog), 1, 'bounty', 'Admin guard check', id),
  };
  return { h, state };
}

describe('Admin DIAGNOSTICS: actions through the authoritative functions', () => {
  it('critical mode: refused (nothing changes) without a session, without flight, when docked or for an unknown mode', () => {
    const { h, state } = host({ session: null });
    expect(diagCritMode(h, 'crit')).toMatch(/^Refused/);
    expect(state.run!.crit.mode).toBe('auto');
    state.session = {};
    state.run!.docked = 'milky-way/sol';
    expect(diagCritMode(h, 'crit')).toMatch(/^Refused/);
    expect(state.run!.crit.mode).toBe('auto');
    state.run!.docked = null;
    for (const bad of ['always', '', null, 1, { mode: 'crit' }]) expect(diagCritMode(h, bad)).toMatch(/^Refused/);
    expect(state.run!.crit.mode).toBe('auto');
    expect(diagCritMode(host({ run: null }).h, 'crit')).toMatch(/^Refused/);
  });

  it('critical mode: FORCE CRITICAL / FORCE ORDINARY / AUTO apply to this sector visit only; a new visit is AUTO again', () => {
    const { h, state } = host();
    expect(diagCritMode(h, 'crit')).toMatch(/FORCED CRITICAL/);
    expect(state.run!.crit.mode).toBe('crit');
    expect(diagCritMode(h, 'normal')).toMatch(/FORCED ORDINARY/);
    expect(state.run!.crit.mode).toBe('normal');
    expect(diagCritMode(h, 'auto')).toMatch(/AUTO/);
    expect(state.run!.crit.mode).toBe('auto');
    diagCritMode(h, 'crit');
    state.run = flying(); // the next sector visit
    expect(state.run.crit.mode).toBe('auto');
  });

  it('test target: spawnAgent places one hostile ahead; refusals (no session, docked, unknown family, ship limit) change nothing', () => {
    const { h, state } = host();
    const r = state.run!;
    const n0 = r.hostiles.length;
    expect(diagSpawn(h, 'raider')).toMatch(/Raider #\d+ placed ahead/);
    expect(r.hostiles).toHaveLength(n0 + 1);
    const a = r.hostiles[r.hostiles.length - 1]!;
    expect(a).toMatchObject({ family: 'raider', faction: 'red-tally', source: 'admin-probe' });
    expect(a.y).toBeLessThan(r.ship.y); // ahead of the nose (heading 0 = up)
    expect(diagSpawn(h, 'capital')).toMatch(/protected from critical hits/);
    for (const bad of ['viper', 'elite', '', null]) expect(diagSpawn(h, bad)).toMatch(/^Refused/);
    state.session = null;
    expect(diagSpawn(h, 'raider')).toMatch(/^Refused/);
    state.session = {};
    r.docked = 'milky-way/sol';
    expect(diagSpawn(h, 'raider')).toMatch(/^Refused/);
    r.docked = null;
    const n1 = r.hostiles.length;
    let refused = '';
    for (let i = 0; i < 40 && !refused; i++) {
      const t = diagSpawn(h, 'raider');
      if (t.startsWith('Refused')) refused = t;
    }
    expect(refused).toMatch(/ship limit/);
    const atCap = r.hostiles.length;
    expect(diagSpawn(h, 'raider')).toMatch(/ship limit/);
    expect(r.hostiles).toHaveLength(atCap);
    expect(atCap).toBeGreaterThan(n1);
    expect(DIAG_SPAWN).toEqual(['raider', 'heavy', 'capital']);
  });

  it('rule check: the policy functions themselves (boundary, one spend, capital protection, invalid mode) pass', () => {
    expect(diagRuleCheck()).toMatch(/^Rule check passed/);
  });

  it('reward guards: the real turn-in is refused and a repeat claim id is refused by the ledger; nothing is applied', () => {
    let p = progressionFromSaved(EMPTY_PROGRESSION);
    const got = award(ledgerOf(p), 120, 'bounty', 'Test bounty', 'bounty:test-1');
    expect(got.ok).toBe(true);
    p = withLedger(p, got.ledger);
    const { h, state } = host({ prog: p });
    const before = JSON.stringify(state.prog);
    const text = diagRewardGuard(h);
    expect(text).toMatch(/Turn-in refused: Exit Admin Access/);
    expect(text).toMatch(/repeat of claim id bounty:test-1: refused \(duplicate\)/);
    expect(text).toMatch(/balance unchanged at 120/);
    expect(JSON.stringify(state.prog)).toBe(before); // no reward, no ledger entry
    expect(state.claims).toBe(1);
    // with no claim recorded yet it says so (and still pays nothing)
    expect(diagRewardGuard(host().h)).toMatch(/no claim id recorded yet/);
  });
});

describe('Admin DIAGNOSTICS: read-outs from the owning systems', () => {
  it('the critical block shows the run’s own counters and records; the ship block is abilityStatus; stealth is stealthStatus', () => {
    const { h, state } = host();
    const r = state.run!;
    diagCritMode(h, 'crit');
    diagSpawn(h, 'heavy');
    const a = r.hostiles[r.hostiles.length - 1]!;
    for (let i = 0; i < 80 && a.state !== 'destroyed'; i++) {
      Object.assign(a, { x: r.ship.x, y: r.ship.y - 140, vx: 0, vy: 0 });
      a.cooldowns.fill(1e9);
      stepSector(r, { moveX: 0, moveY: 0, fire: i % 2 === 0 });
    }
    expect(a.state).toBe('destroyed');
    const m = diagnosticsModel(h);
    const crit = m.find((s) => s.id === 'crit')!;
    expect(crit.lines[0]).toMatch(/FORCED CRITICAL/);
    expect(crit.lines[1]).toBe(`This visit: ${r.crit.rolls} firing events decided · ${r.crit.rolled} critical · ${r.crit.landed} confirmed on a ship`);
    expect(crit.lines.some((l) => /HEAVY · destroyed · by the pilot's side/.test(l))).toBe(true);
    const ab = abilityStatus(r);
    expect(m.find((s) => s.id === 'ship')!.lines[1]).toContain(`${ab.name} [${ab.tag}]`);
    const st = stealthStatus(r);
    expect(m.find((s) => s.id === 'stealth')!.lines[1]).toContain(`tracking ${st.tracking} · searching ${st.searching}`);
    expect(m.find((s) => s.id === 'fleet')!.lines.slice(0, 2)).toEqual(['VESSELS · none', 'WING · not flying']);
    expect(m.find((s) => s.id === 'flight')!.lines.join(' ')).toMatch(/source positions are never shown/);
    expect(m.map((s) => s.id)).toEqual(['crit', 'ship', 'stealth', 'flight', 'recovery', 'fleet', 'crew', 'missions', 'save']);
  });

  it('outside a sector it explains what needs flight and still reads fleet, crew, missions and the save', () => {
    const m = diagnosticsModel(host({ run: null }).h);
    expect(m.map((s) => s.id)).toEqual(['crit', 'fleet', 'crew', 'missions', 'save']);
    expect(m[0]!.lines[0]).toMatch(/Fly in a sector/);
    expect(m.find((s) => s.id === 'crew')!.lines[1]).toMatch(/never fly, fire, target or command/);
  });

  it('persistence: the stored slot is fingerprinted when the session first checks it; a change would be reported', () => {
    const session = {};
    const { h, state } = host({ session, slot: '{"version":10,"marks":5}' });
    const first = diagnosticsModel(h).find((s) => s.id === 'save')!;
    expect(first.lines[0]).toMatch(/refused for the whole Admin session/);
    expect(first.lines[1]).toMatch(/unchanged since this session first checked it/);
    expect(diagnosticsModel(h).find((s) => s.id === 'save')!.lines[1]).toMatch(/unchanged/);
    state.slot = '{"version":10,"marks":6}';
    expect(diagnosticsModel(h).find((s) => s.id === 'save')!.lines[1]).toMatch(/^Stored slot .* CHANGED \(was 24 chars · [0-9a-f]{8}\)$/);
    expect(slotPrint(null)).toBe('empty slot');
    expect(slotPrint('a')).not.toBe(slotPrint('b'));
  });
});

describe('Admin DIAGNOSTICS: containment', () => {
  it('forced critical outcomes exist only in the tab (session-checked) and the QA build hooks; never a normal-play path', () => {
    const users = files(src)
      .filter((f) => /\bforceCritical\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f).replace(/\\/g, '/'))
      .sort();
    expect(users).toEqual(['modes/freeroam/admin/diagnostics.ts', 'modes/freeroam/combat/critical.ts', 'modes/freeroam/freeRoamMode.ts']);
    const shell = readFileSync(join(src, 'modes/freeroam/freeRoamMode.ts'), 'utf8');
    const calls = shell.split('\n').filter((l) => /\bforceCritical\(/.test(l));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/qaCrit: __GALAXIA_TEST_HOOKS__ \? /); // compiled out of release builds
    // the tab is fetched only from the session-checked dep, and that dep refuses without a session
    expect(shell).toMatch(/const adminDiag = \(host: HTMLElement, say: \(text: string\) => void, again: \(focus\?: string\) => void\): void => \{\n\s*if \(!isAdmin\(admin\)\) return;/);
  });

  it('the tab holds no Admin secret and never reaches the activation or login code, storage or the network', () => {
    const code = readFileSync(join(src, 'modes/freeroam/admin/diagnostics.ts'), 'utf8');
    expect(code).not.toMatch(/activation|login|password|sequence|passphrase/i);
    expect(code).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|console|Math\.random|Date\.now|performance\.now|setTimeout|setInterval|requestAnimationFrame)\b/);
  });

  it('the internal Admin diagnostics harness is kept out of the release; the critical-hit QA harness ships without Admin access', () => {
    const zip = readFileSync(join(src, '..', 'scripts/lib/releaseZip.ts'), 'utf8');
    expect(zip).toContain('critical-hits-f1');
    expect(zip).not.toContain('admin-diagnostics-f1');
    const qa = readFileSync(join(src, '..', 'docs/development/playtest/critical-hits-f1.mjs'), 'utf8');
    expect(qa).not.toMatch(/F8|adminLogin|ADMIN ACCESS|password|sequence/i);
  });
});

it('the ledger fixtures used above are the real ones (sanity: an empty ledger has no recent ids)', () => {
  expect(EMPTY_LEDGER.recent).toEqual([]);
});
