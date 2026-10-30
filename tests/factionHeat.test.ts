/**
 * P09.1 Faction Heat (combat/factionHeat.ts) on the real sector simulation:
 * the model and its bounds, central attribution in damageAgent (hit gap, kill
 * once, nothing for NPC fire, hazards or unknown factions), sim-tick decay and
 * its contact delay, lifecycle (pause, dock, restart, a new run with the same
 * book), the two bounded AI effects (detect range, contact memory) with Silent
 * Running and Gravity Shadow still deciding, and persistence through the
 * profile. Fixed seeds; no clock.
 */
import { describe, expect, it } from 'vitest';
import { spawnAgent } from '../src/modes/freeroam/combat/ai.ts';
import { addHeat, HEAT, HEAT_FACTIONS, HEAT_TIER_NAMES, heatBook, heatOf, heatTier, heatToSaved, heatView, heatEffect, HEAT_HELP, type HeatBook } from '../src/modes/freeroam/combat/factionHeat.ts';
import { FAMILIES, type FamilyId } from '../src/modes/freeroam/combat/families.ts';
import type { Agent } from '../src/modes/freeroam/combat/state.ts';
import { STEALTH } from '../src/modes/freeroam/combat/stealth.ts';
import { damageAgent } from '../src/modes/freeroam/combat/world.ts';
import type { FactionId } from '../src/modes/freeroam/catalogue/types.ts';
import { EMPTY_PROFILE, EMPTY_PROGRESSION, loadProfile, saveProfile, withProgression } from '../src/modes/freeroam/profile.ts';
import { progressionFromSaved, progressionToSaved } from '../src/modes/freeroam/progression/persistence.ts';
import { EMPTY_SECTOR_SAVE, type Landmark, type SectorLayout } from '../src/modes/freeroam/sector/model.ts';
import { createSectorRun, pauseSector, restartSector, resumeSector, stepSector, type SectorEvent, type SectorInput, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { auditProfile } from '../src/modes/freeroam/saveAudit.ts';
import { arena } from './helpers/combatProbe.ts';

const NONE: SectorInput = { moveX: 0, moveY: 0 };
const Z: SectorInput = { moveX: 0, moveY: 0, silentToggle: true };
const body = (x: number, y: number, r: number): Landmark => ({ id: 'body-t', kind: 'body', style: 'gas', x, y, r, hazardR: 0, label: 'Test body' });
const heatEvents = (ev: readonly SectorEvent[]) => ev.flatMap((e) => (e.type === 'heat' ? [e] : []));

function world(bodies: readonly Landmark[] = []): { L: SectorLayout; cx: number; cy: number } {
  const base = arena(3);
  const cx = base.arrival.x < base.width / 2 ? base.width - 1500 : 1500;
  const cy = base.arrival.y < base.height / 2 ? base.height - 1500 : 1500;
  return { L: { ...base, landmarks: bodies.map((b) => ({ ...b, x: b.x + cx, y: b.y + cy })) }, cx, cy };
}
function fight(L: SectorLayout, heat?: HeatBook): SectorRun {
  const r = createSectorRun(L, { ...EMPTY_SECTOR_SAVE, surveyed: true }, { seed: 7, ...(heat ? { heat } : {}) });
  r.grace = 0;
  r.invuln = 1e9;
  return r;
}
const pin = (o: { x: number; y: number; px: number; py: number; vx: number; vy: number }, x: number, y: number): void => {
  Object.assign(o, { x, y, px: x, py: y, vx: 0, vy: 0 });
};
function hold(r: SectorRun, n: number, pilot: { x: number; y: number }, agents: readonly { a: Agent; x: number; y: number }[] = [], input: SectorInput = NONE): SectorEvent[] {
  const out: SectorEvent[] = [];
  for (let i = 0; i < n; i++) {
    pin(r.ship, pilot.x, pilot.y);
    for (const p of agents) pin(p.a, p.x, p.y);
    out.push(...stepSector(r, input));
  }
  return out;
}
const foe = (r: SectorRun, faction: FactionId, x: number, y: number, family: FamilyId = 'picket'): Agent => {
  const a = spawnAgent(r, family, faction, 'test', 'guard', x, y);
  if (!a) throw new Error('spawn refused');
  return a;
};
const book = (v: Partial<Record<FactionId, number>>): HeatBook => heatBook(v as Record<string, number>);

/* ------------------------------------------------------------------ model */
describe('faction heat model', () => {
  it('the tuning is centralised, frozen and in sim ticks (hit 3, kill 10, hit gap 60 = 1 s, decay 1 per 720 = 12 s)', () => {
    expect(Object.isFrozen(HEAT)).toBe(true);
    expect(HEAT).toMatchObject({ max: 100, hit: 3, kill: 10, hitGap: 60, decayTicks: 720 });
    expect(HEAT.decayTicks / 60).toBe(12);
    expect(HEAT.rangeMul).toEqual([1, 1.05, 1.1, 1.15, 1.2]);
    expect(HEAT.memory).toEqual([0, 0, 30, 45, 60]);
    expect(HEAT_TIER_NAMES).toEqual(['Quiet', 'Wary', 'Alert', 'Pursuit', 'Hunt']);
  });
  it('heat applies only to factions that field ships, by stable id (the Haven Guild has none)', () => {
    expect(HEAT_FACTIONS).toEqual(['tessellate', 'red-tally', 'cordon', 'gleaners']);
    expect(HEAT_FACTIONS).not.toContain('haven-guild');
  });
  it('tiers: Quiet 0-19, Wary 20-39, Alert 40-59, Pursuit 60-79, Hunt 80-100 (exact boundaries)', () => {
    const at = (n: number) => HEAT_TIER_NAMES[heatTier(n)];
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(at)).toEqual(['Quiet', 'Quiet', 'Wary', 'Wary', 'Alert', 'Alert', 'Pursuit', 'Pursuit', 'Hunt', 'Hunt']);
  });
  it('addHeat clamps to 0..100, ignores unknown factions and non-finite deltas, keeps integers, and reports the applied change', () => {
    const b = heatBook();
    expect(addHeat(b, 'red-tally', 250)).toBe(100);
    expect(heatOf(b, 'red-tally')).toBe(100);
    expect(addHeat(b, 'red-tally', 5)).toBe(0);
    expect(addHeat(b, 'red-tally', -400)).toBe(-100);
    expect(heatOf(b, 'red-tally')).toBe(0);
    expect(addHeat(b, 'haven-guild', 10)).toBe(0);
    expect(addHeat(b, 'nope', 10)).toBe(0);
    expect(addHeat(b, 'cordon', Number.NaN)).toBe(0);
    expect(addHeat(b, 'cordon', Infinity)).toBe(0);
    expect(addHeat(b, 'cordon', 2.9)).toBe(2);
    expect(b.v).toEqual({ 'red-tally': 0, cordon: 2 });
    expect(heatOf(undefined, 'cordon')).toBe(0);
  });
  it('a tier crossing reports one event (up or down), never a repeat while the tier holds', () => {
    const b = heatBook();
    const ev: SectorEvent[] = [];
    addHeat(b, 'tessellate', 19, ev);
    expect(ev).toEqual([]);
    addHeat(b, 'tessellate', 1, ev);
    addHeat(b, 'tessellate', 5, ev);
    addHeat(b, 'tessellate', 14, ev);
    expect(heatEvents(ev)).toEqual([{ type: 'heat', faction: 'tessellate', tier: 1, from: 0 }]);
    addHeat(b, 'tessellate', 70, ev);
    expect(heatEvents(ev).at(-1)).toEqual({ type: 'heat', faction: 'tessellate', tier: 4, from: 1 });
    addHeat(b, 'tessellate', -100, ev);
    expect(heatEvents(ev).at(-1)).toEqual({ type: 'heat', faction: 'tessellate', tier: 0, from: 4 });
    expect(ev).toHaveLength(3);
  });
  it('the read-only view lists every faction with its label, value and tier and never changes the book', () => {
    const b = book({ 'red-tally': 64 });
    const before = JSON.stringify(b);
    expect(heatView(b)).toEqual([
      { faction: 'tessellate', label: 'Tessellate', value: 0, tier: 0, tierName: 'Quiet', effect: heatEffect(0) },
      { faction: 'red-tally', label: 'Red Tally', value: 64, tier: 3, tierName: 'Pursuit', effect: heatEffect(3) },
      { faction: 'cordon', label: expect.any(String), value: 0, tier: 0, tierName: 'Quiet', effect: heatEffect(0) },
      { faction: 'gleaners', label: expect.any(String), value: 0, tier: 0, tierName: 'Quiet', effect: heatEffect(0) },
    ]);
    expect(JSON.stringify(b)).toBe(before);
    expect(heatView(undefined).every((h) => h.value === 0)).toBe(true);
  });

  it('P09.2: the consequence line and help text are read from HEAT (never a second copy of the numbers)', () => {
    expect(heatEffect(0)).toBe('no extra attention');
    expect(heatEffect(1)).toBe('its ships spot you 5% farther');
    for (let t = 2; t < HEAT_TIER_NAMES.length; t++) {
      expect(heatEffect(t)).toContain(`${Math.round((HEAT.rangeMul[t]! - 1) * 100)}% farther`);
      expect(heatEffect(t)).toContain(`${HEAT.memory[t]! / 60} s longer`);
    }
    expect(HEAT_HELP).toContain(`1 point per ${HEAT.decayTicks / 60} s`);
    expect(HEAT_HELP).toMatch(/per faction/);
    expect(HEAT_HELP).toMatch(/Silent Running and planets still hide you/);
    expect(HEAT_HELP).toMatch(/not a difficulty level/);
    expect(HEAT_HELP).not.toMatch(/\b(ally|allied|neutral|hostile)\b/i);
  });
});

/* ------------------------------------------------------------ attribution */
describe('heat attribution (damageAgent, the one place a player hit lands)', () => {
  it('a player hit adds +3 to that ship\'s faction only; others are unchanged', () => {
    const { L, cx, cy } = world();
    const r = fight(L);
    const a = foe(r, 'red-tally', cx + 400, cy, 'heavy');
    const ev: SectorEvent[] = [];
    damageAgent(r, a, 1, 'player', ev);
    expect(r.factionHeat.v).toEqual({ 'red-tally': 3 });
    for (const f of ['tessellate', 'cordon', 'gleaners']) expect(heatOf(r.factionHeat, f)).toBe(0);
  });
  it('rapid hits from one ship count once per hit gap (60 ticks); another ship counts on its own', () => {
    const { L, cx, cy } = world();
    const r = fight(L);
    const a = foe(r, 'red-tally', cx + 400, cy, 'heavy');
    const b = foe(r, 'red-tally', cx + 500, cy, 'heavy');
    const ev: SectorEvent[] = [];
    damageAgent(r, a, 1, 'player', ev);
    for (let i = 0; i < 59; i++) {
      r.tick += 1;
      damageAgent(r, a, 1, 'player', ev);
    }
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(3);
    damageAgent(r, b, 1, 'player', ev);
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(6);
    r.tick += 1; // 60 ticks after a's first counted hit
    damageAgent(r, a, 1, 'player', ev);
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(9);
  });
  it('a kill adds +10 once (with the hit, when the hit gap allows it); a destroyed ship never adds again', () => {
    const { L, cx, cy } = world();
    const r = fight(L);
    const a = foe(r, 'cordon', cx + 400, cy);
    const ev: SectorEvent[] = [];
    expect(damageAgent(r, a, 1e6, 'player', ev)).toBe(true);
    expect(heatOf(r.factionHeat, 'cordon')).toBe(HEAT.hit + HEAT.kill);
    r.tick += 600;
    expect(damageAgent(r, a, 1e6, 'player', ev)).toBe(false);
    expect(heatOf(r.factionHeat, 'cordon')).toBe(13);
    // a kill shot inside the hit gap still pays the kill (only the +3 is rate-limited)
    const b = foe(r, 'cordon', cx + 500, cy, 'heavy');
    damageAgent(r, b, 1, 'player', ev);
    damageAgent(r, b, 1e6, 'player', ev);
    expect(heatOf(r.factionHeat, 'cordon')).toBe(13 + 3 + 10);
  });
  it('NPC fire, hazards and zero or invalid damage never add heat', () => {
    const { L, cx, cy } = world();
    const r = fight(L);
    const a = foe(r, 'red-tally', cx + 400, cy, 'heavy');
    const ev: SectorEvent[] = [];
    damageAgent(r, a, 5, 'tessellate', ev);
    damageAgent(r, a, 5, 'environment', ev);
    damageAgent(r, a, 0, 'player', ev);
    damageAgent(r, a, Number.NaN, 'player', ev);
    damageAgent(r, a, -4, 'player', ev);
    damageAgent(r, a, 1e6, 'gleaners', ev); // destroyed by another faction: no kill heat either
    expect(a.state).toBe('destroyed');
    expect(r.factionHeat.v).toEqual({});
  });
  it('shooting a wary faction raises its heat and provokes it as before; heat never changes who is hostile', () => {
    const { L, cx, cy } = world();
    const r = fight(L, book({ gleaners: 100 }));
    const g = foe(r, 'gleaners', cx + 300, cy, 'heavy');
    hold(r, 30, { x: cx, y: cy }, [{ a: g, x: cx + 300, y: cy }]);
    expect(g.target).toBeNull(); // Hunt-level heat alone does not make a wary faction attack
    expect(r.provoked.has('gleaners')).toBe(false);
    damageAgent(r, g, 1, 'player', []);
    expect(r.provoked.has('gleaners')).toBe(true);
    expect(heatOf(r.factionHeat, 'gleaners')).toBe(100); // clamped
  });
  it('firing without hitting anything adds nothing', () => {
    const { L, cx, cy } = world();
    const r = fight(L);
    const a = foe(r, 'red-tally', cx - 900, cy - 900);
    hold(r, 240, { x: cx, y: cy }, [{ a, x: cx - 900, y: cy - 900 }], { moveX: 0, moveY: 0, fire: true });
    expect(r.factionHeat.v).toEqual({});
  });
});

/* ------------------------------------------------------------------ decay */
describe('heat decay (sim ticks, contact delay)', () => {
  it(`drops one point per ${HEAT.decayTicks} calm ticks: unchanged at ${HEAT.decayTicks - 1}, one less at ${HEAT.decayTicks}`, () => {
    const { L, cx, cy } = world();
    const r = fight(L, book({ 'red-tally': 21, tessellate: 5 }));
    hold(r, HEAT.decayTicks - 1, { x: cx, y: cy });
    expect(r.factionHeat.v).toMatchObject({ 'red-tally': 21, tessellate: 5 });
    const ev = hold(r, 1, { x: cx, y: cy });
    expect(r.factionHeat.v).toMatchObject({ 'red-tally': 20, tessellate: 4 });
    expect(heatEvents(ev)).toEqual([]);
    const ev2 = hold(r, HEAT.decayTicks, { x: cx, y: cy });
    expect(heatEvents(ev2)).toEqual([{ type: 'heat', faction: 'red-tally', tier: 0, from: 1 }]);
  });
  it('never goes below zero and a quiet faction gains nothing', () => {
    const { L, cx, cy } = world();
    const r = fight(L, book({ cordon: 1 }));
    hold(r, HEAT.decayTicks * 3, { x: cx, y: cy });
    expect(heatOf(r.factionHeat, 'cordon')).toBe(0);
    expect(heatOf(r.factionHeat, 'tessellate')).toBe(0);
  });
  it('paused: no tick, no decay; the calm count resumes where it stopped', () => {
    const { L, cx, cy } = world();
    const r = fight(L, book({ 'red-tally': 10 }));
    hold(r, 700, { x: cx, y: cy });
    pauseSector(r);
    for (let i = 0; i < 5000; i++) expect(stepSector(r, NONE)).toEqual([]);
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(10);
    resumeSector(r);
    hold(r, 19, { x: cx, y: cy });
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(10);
    hold(r, 1, { x: cx, y: cy });
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(9);
  });
  it('docked: no decay while the run is docked', () => {
    const { L, cx, cy } = world();
    const r = fight(L, book({ 'red-tally': 10 }));
    r.docked = 'station-x';
    for (let i = 0; i < HEAT.decayTicks * 2; i++) stepSector(r, NONE);
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(10);
    r.docked = null;
    hold(r, HEAT.decayTicks, { x: cx, y: cy });
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(9);
  });
  it('contact delay: while a ship of that faction holds the pilot as its target the count restarts; other factions still decay', () => {
    const { L, cx, cy } = world();
    const r = fight(L, book({ 'red-tally': 10, tessellate: 10 }));
    const a = foe(r, 'red-tally', cx + 200, cy);
    hold(r, HEAT.decayTicks * 2, { x: cx, y: cy }, [{ a, x: cx + 200, y: cy }]);
    expect(a.target).toBe('player');
    expect(heatOf(r.factionHeat, 'red-tally')).toBe(10);
    expect(heatOf(r.factionHeat, 'tessellate')).toBe(8);
    expect(r.factionHeat.calm['red-tally']).toBe(0);
  });
});

/* -------------------------------------------------------------- lifecycle */
describe('heat lifecycle', () => {
  it('the run uses the shell\'s book by reference; restart, recall and a new run (sector change, ship switch) keep it', () => {
    const { L, cx, cy } = world();
    const b = book({ cordon: 30 });
    const r = fight(L, b);
    expect(r.factionHeat).toBe(b);
    const a = foe(r, 'cordon', cx + 400, cy);
    damageAgent(r, a, 1, 'player', []);
    expect(b.v.cordon).toBe(33);
    restartSector(r);
    expect(r.factionHeat).toBe(b);
    expect(b.v.cordon).toBe(33);
    const next = fight(L, b); // the shell passes the same book to every run of the slot
    expect(heatOf(next.factionHeat, 'cordon')).toBe(33);
  });
  it('a run without a book (the gravity lab) starts quiet and never touches a slot\'s book', () => {
    const { L, cx, cy } = world();
    const r = fight(L);
    expect(r.factionHeat.v).toEqual({});
    const a = foe(r, 'cordon', cx + 400, cy);
    damageAgent(r, a, 1, 'player', []);
    expect(fight(L).factionHeat.v).toEqual({});
  });
  it('is deterministic: the same scenario gives the same heat and events', () => {
    const run = (): string => {
      const { L, cx, cy } = world();
      const r = fight(L, book({ 'red-tally': 39 }));
      const a = foe(r, 'red-tally', cx + 200, cy);
      const ev = hold(r, 400, { x: cx, y: cy }, [{ a, x: cx + 200, y: cy }]);
      damageAgent(r, a, 1, 'player', ev);
      ev.push(...hold(r, 900, { x: cx, y: cy }));
      return JSON.stringify([r.factionHeat.v, heatEvents(ev)]);
    };
    expect(run()).toBe(run());
  });
});

/* ------------------------------------------------------------ AI effects */
describe('heat effects on the affected faction (detect range, contact memory)', () => {
  const D = FAMILIES.picket.detect;
  it('detect range: a pilot just outside the base range is acquired at Pursuit or Hunt only, by that faction only', () => {
    const { L, cx, cy } = world();
    const at = { x: cx + D * 1.12, y: cy };
    const seen = (v: Partial<Record<FactionId, number>>, faction: FactionId): boolean => {
      const r = fight(L, book(v));
      const a = foe(r, faction, at.x, at.y);
      hold(r, 1, { x: cx, y: cy }, [{ a, ...at }]);
      return a.target === 'player';
    };
    expect(seen({}, 'red-tally')).toBe(false);
    expect(seen({ 'red-tally': 59 }, 'red-tally')).toBe(false); // Alert: x1.1
    expect(seen({ 'red-tally': 60 }, 'red-tally')).toBe(true); // Pursuit: x1.15
    expect(seen({ 'red-tally': 100 }, 'red-tally')).toBe(true);
    expect(seen({ 'red-tally': 100 }, 'tessellate')).toBe(false); // another faction's heat does nothing
    // beyond the Hunt multiplier nobody sees the pilot: no unconditional detection
    const r = fight(L, book({ 'red-tally': 100 }));
    const far = { x: cx + D * 1.21, y: cy };
    const a = foe(r, 'red-tally', far.x, far.y);
    hold(r, 60, { x: cx, y: cy }, [{ a, ...far }]);
    expect(a.target).toBeNull();
  });
  it('Silent Running still scales the widened range: silent at Hunt is unseen where normal flight at Quiet is seen', () => {
    const { L, cx, cy } = world();
    const at = { x: cx + D * 0.5, y: cy };
    const r = fight(L, book({ 'red-tally': 100 }));
    stepSector(r, Z);
    expect(r.silent).toBe(true);
    const a = foe(r, 'red-tally', at.x, at.y);
    hold(r, 120, { x: cx, y: cy }, [{ a, ...at }]);
    expect(D * 1.2 * STEALTH.silent).toBeLessThan(D * 0.5);
    expect(a.target).toBeNull();
    const q = fight(L);
    const b = foe(q, 'red-tally', at.x, at.y);
    hold(q, 1, { x: cx, y: cy }, [{ a: b, ...at }]);
    expect(b.target).toBe('player');
  });
  it('Gravity Shadow still hides the pilot at Hunt: no detection through a body', () => {
    const { L, cx, cy } = world([body(0, 0, 120)]);
    const r = fight(L, book({ 'red-tally': 100 }));
    const A = { x: cx - 200, y: cy };
    const a = foe(r, 'red-tally', A.x, A.y);
    hold(r, 240, { x: cx + 200, y: cy }, [{ a, ...A }]);
    expect(a.target).toBeNull();
    expect(a.shadow).toBe(true);
  });
  it('contact memory: Quiet holds the frozen last-seen point for the base memory, Hunt for 60 ticks more, never the live position', () => {
    const memory = (v: Partial<Record<FactionId, number>>): number => {
      const { L, cx, cy } = world([body(0, 0, 120)]);
      const r = fight(L, book(v));
      const A = { x: cx - 200, y: cy };
      const a = foe(r, 'red-tally', A.x, A.y);
      hold(r, 120, { x: cx - 200, y: cy + 300 }, [{ a, ...A }]);
      expect(a.target).toBe('player');
      const seenAt = { ...a.lastSeen! };
      let n = 0;
      while (n < 1000) {
        hold(r, 1, { x: cx + 200, y: cy }, [{ a, ...A }]);
        if (a.target !== 'player') break;
        expect(a.lastSeen).toEqual(seenAt);
        n += 1;
      }
      return n;
    };
    expect(memory({})).toBe(STEALTH.memoryTicks);
    expect(memory({ 'red-tally': 39 })).toBe(STEALTH.memoryTicks);
    expect(memory({ 'red-tally': 40 })).toBe(STEALTH.memoryTicks + 30);
    expect(memory({ 'red-tally': 80 })).toBe(STEALTH.memoryTicks + 60);
    expect(memory({ tessellate: 100 })).toBe(STEALTH.memoryTicks);
  });
});

/* ------------------------------------------------------------ persistence */
describe('heat persistence (progression.heat, optional field)', () => {
  const save = (heat: unknown) => {
    const store = new MemoryStore();
    const ok = saveProfile(store, withProgression(EMPTY_PROFILE, { ...EMPTY_PROGRESSION, heat } as never));
    return { store, ok };
  };
  it('round trip: non-zero values are saved and loaded exactly; a quiet book saves nothing', () => {
    const b = book({ 'red-tally': 42, gleaners: 7 });
    addHeat(b, 'cordon', 0);
    const saved = progressionToSaved(progressionFromSaved(EMPTY_PROGRESSION), b);
    expect(saved.heat).toEqual({ 'red-tally': 42, gleaners: 7 });
    expect(progressionToSaved(progressionFromSaved(EMPTY_PROGRESSION), heatBook()).heat).toBeUndefined();
    expect('heat' in progressionToSaved(progressionFromSaved(EMPTY_PROGRESSION))).toBe(false);
    const { store, ok } = save(saved.heat);
    expect(ok).toBe(true);
    const loaded = loadProfile(store);
    expect(loaded.data.progression.heat).toEqual({ 'red-tally': 42, gleaners: 7 });
    expect(heatBook(loaded.data.progression.heat).v).toEqual({ 'red-tally': 42, gleaners: 7 });
    expect(heatToSaved(heatBook(loaded.data.progression.heat))).toEqual({ 'red-tally': 42, gleaners: 7 });
    // transient calm counters are never part of the stored form
    expect(JSON.stringify(heatToSaved(b))).not.toMatch(/calm/);
  });
  it('the load audit (saveAudit, run on every slot load) keeps the heat and reports no change for it', () => {
    const p = withProgression(EMPTY_PROFILE, { ...EMPTY_PROGRESSION, heat: { 'red-tally': 42, gleaners: 7 } });
    const a = auditProfile(buildNavGraph(), p);
    expect(a.profile.progression.heat).toEqual({ 'red-tally': 42, gleaners: 7 });
    expect(a.changed).toBe(0);
    // a faction this build does not field is dropped there, like every other unknown id
    const b = auditProfile(buildNavGraph(), withProgression(EMPTY_PROFILE, { ...EMPTY_PROGRESSION, heat: { 'future-faction': 9, cordon: 3 } }));
    expect(b.profile.progression.heat).toEqual({ cordon: 3 });
  });
  it('a legacy save (no heat field) loads unchanged and starts every faction quiet', () => {
    const store = new MemoryStore();
    expect(saveProfile(store, EMPTY_PROFILE)).toBe(true);
    expect(store.read('galaxia:freeroam')).not.toMatch(/"heat"/);
    const loaded = loadProfile(store);
    expect(loaded.status).toBe('ok');
    expect(loaded.data.progression.heat).toBeUndefined();
    expect(heatBook(loaded.data.progression.heat).v).toEqual({});
  });
  it('malformed heat is normalised: out-of-range, non-integer, bad keys and non-objects are dropped, never a crash or a reset', () => {
    const cases: [unknown, Record<string, number> | undefined][] = [
      [{ 'red-tally': 150, gleaners: -3, cordon: 2.5, tessellate: 'x' }, undefined],
      [{ 'red-tally': 50, 'Bad Key!': 9, gleaners: 0 }, { 'red-tally': 50 }],
      [[1, 2, 3], undefined],
      ['hot', undefined],
      [null, undefined],
    ];
    for (const [heat, want] of cases) {
      const store = new MemoryStore();
      const raw = { ...EMPTY_PROFILE, progression: { ...EMPTY_PROGRESSION, marks: 77, heat } };
      saveProfile(store, raw as never);
      const loaded = loadProfile(store);
      expect(loaded.data.progression.heat, JSON.stringify(heat)).toEqual(want);
      expect(loaded.status, JSON.stringify(heat)).toBe('repaired');
      expect(loaded.data.progression.marks).toBe(77); // the rest of the save is kept
    }
    // an unknown but well-formed faction id survives the profile (forward compatible) and is ignored by the book
    expect(heatBook({ 'red-tally': 5, 'future-faction': 9 }).v).toEqual({ 'red-tally': 5 });
    expect(heatBook({ cordon: 999 }).v).toEqual({ cordon: 100 });
  });
});
