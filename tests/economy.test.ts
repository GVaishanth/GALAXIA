/**
 * Economy pass: the Guild marks wallet (progression/ledger.ts), the reward
 * hooks (progression/marksRewards.ts), admin-free quotes, insufficient-funds
 * wording and save migration. DOM parts are checked by the browser harness
 * (docs/development/playtest/freeroam-economy.mjs).
 */
import { describe, expect, it } from 'vitest';
import { FAMILIES } from '../src/modes/freeroam/combat/families.ts';
import { EMPTY_PROFILE, EMPTY_PROGRESSION, loadProfile, saveProfile, withProgression } from '../src/modes/freeroam/profile.ts';
import type { GameEvent } from '../src/modes/freeroam/progression/events.ts';
import { MODULE_PRICES, quoteBuyCells, quoteBuyModule, quoteSell, sellPrice, type Wallet } from '../src/modes/freeroam/progression/economy.ts';
import {
  afford,
  award,
  EMPTY_LEDGER,
  ENTRY_KINDS,
  formatDelta,
  formatMarks,
  groupDigits,
  insufficientText,
  ledgerFromSaved,
  ledgerToSaved,
  MARKS,
  record,
  refund,
  seen,
  spend,
  TICKER,
  tickerValue,
  transact,
  validAmount,
  type Ledger,
} from '../src/modes/freeroam/progression/ledger.ts';
import { bountyBase, bountyClaim, bountyLeft, bountyRefillIn, eventClaim, pruneBounties, REWARDS, type BountyBook } from '../src/modes/freeroam/progression/marksRewards.ts';
import { ledgerOf, progressionFromSaved, progressionToSaved, withLedger, type ProgressionState } from '../src/modes/freeroam/progression/persistence.ts';
import { quoteShip, quoteUpgrade } from '../src/modes/freeroam/progression/station.ts';
import { STARTER_FLEET } from '../src/modes/freeroam/ships/hangar.ts';
import { SHIP_BY_ID, SHIPS } from '../src/modes/freeroam/ships/roster.ts';
import { SITE_KINDS } from '../src/modes/freeroam/sector/model.ts';

const L = (balance: number): Ledger => ({ ...EMPTY_LEDGER, balance });
const W = (over: Partial<Wallet> = {}): Wallet => ({ marks: 0, hold: {}, holdCap: 30, modules: {}, ...over });
const kill = (family: string, systemId = 'milky-way/sol', role = 'patrol'): Extract<GameEvent, { type: 'hostile-destroyed' }> => ({ type: 'hostile-destroyed', systemId, faction: 'gleaners' as never, family, role, source: 'patrol-1' });
const memStore = (): { store: Map<string, string>; backing: never } => {
  const store = new Map<string, string>();
  const backing = { persistent: true, read: (k: string) => store.get(k) ?? null, write: (k: string, v: string) => (store.set(k, v), true), remove: (k: string) => void store.delete(k), keys: () => [...store.keys()] };
  return { store, backing: backing as never };
};

describe('Guild marks: one currency, formatted the same everywhere', () => {
  it('keeps the existing name, symbol, cap and a zero starting balance', () => {
    expect(MARKS.name).toBe('Guild marks');
    expect(MARKS.unit).toBe('MARKS');
    expect(MARKS.glyph).toBe('◈');
    expect(MARKS.starting).toBe(0);
    expect(MARKS.max).toBe(9_999_999);
  });

  it('formats amounts with fixed thousands separators (independent of the browser locale)', () => {
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(999)).toBe('999');
    expect(groupDigits(1240)).toBe('1,240');
    expect(groupDigits(12450)).toBe('12,450');
    expect(groupDigits(9_999_999)).toBe('9,999,999');
    expect(groupDigits(Number.NaN)).toBe('0');
    expect(groupDigits(-5)).toBe('0');
    expect(formatMarks(12450)).toBe('◈ 12,450 MARKS');
    expect(formatDelta(15)).toBe('+15');
    expect(formatDelta(-1200)).toBe('\u22121,200');
    expect(formatDelta(0)).toBe('0');
  });

  it('accepts only whole, finite, non-negative amounts within the cap', () => {
    for (const ok of [0, 1, 250, MARKS.max]) expect(validAmount(ok)).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MARKS.max + 1, '5', null, undefined, {}]) expect(validAmount(bad)).toBe(false);
  });
});

describe('ledger: award, spend, refund and duplicates', () => {
  it('awards a valid amount once per claim id, with a bounded history entry', () => {
    const a = award(L(10), 25, 'encounter', 'Ambush cleared · Sol', 'enc:milky-way/sol#ambush-1');
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.ledger.balance).toBe(35);
    expect(a.entry).toMatchObject({ seq: 1, kind: 'encounter', delta: 25, balance: 35 });
    expect(seen(a.ledger, 'enc:milky-way/sol#ambush-1')).toBe(true);
    const again = award(a.ledger, 25, 'encounter', 'Ambush cleared · Sol', 'enc:milky-way/sol#ambush-1');
    expect(again).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(again.ledger).toBe(a.ledger);
  });

  it('refuses negative, zero, fractional, NaN and infinite rewards and unknown kinds (balance unchanged)', () => {
    const l = L(40);
    for (const bad of [-5, 0, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = award(l, bad, 'bounty', 'x');
      expect(r.ok).toBe(false);
      expect(r.ledger.balance).toBe(40);
    }
    expect(award(l, 5, 'gift' as never, 'x').ok).toBe(false);
  });

  it('never passes the cap: a reward pays up to it, and nothing at it', () => {
    const near = award(L(MARKS.max - 3), 50, 'mission', 'Mission · x');
    expect(near.ok && near.ledger.balance).toBe(MARKS.max);
    expect(near.ok && near.entry.delta).toBe(3);
    expect(award(L(MARKS.max), 5, 'mission', 'x')).toMatchObject({ ok: false, reason: 'cap' });
  });

  it('spends atomically: all or nothing, never below zero, once per id', () => {
    expect(spend(L(50), 120, 'purchase', 'Cells')).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(spend(L(50), 120, 'purchase', 'Cells').ledger.balance).toBe(50);
    const exact = spend(L(120), 120, 'purchase', 'Cells', 'tx:1');
    expect(exact.ok && exact.ledger.balance).toBe(0);
    if (!exact.ok) return;
    expect(spend(exact.ledger, 0, 'purchase', 'again', 'tx:1')).toMatchObject({ ok: false, reason: 'duplicate' });
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(spend(L(100), bad, 'purchase', 'x').ok).toBe(false);
  });

  it('a free (0) spend changes nothing and writes no history', () => {
    const r = spend(L(70), 0, 'travel', 'Travel');
    expect(r.ok).toBe(true);
    expect(r.ledger.balance).toBe(70);
    expect(r.ledger.history).toEqual([]);
  });

  it('refunds a spend exactly once and never refunds a gain', () => {
    const paid = spend(L(100), 30, 'upgrade', 'Hull Mk I');
    if (!paid.ok) throw new Error('spend');
    const back = refund(paid.ledger, paid.entry.seq);
    expect(back.ok && back.ledger.balance).toBe(100);
    if (!back.ok) return;
    expect(back.ledger.history.find((e) => e.seq === paid.entry.seq)?.refunded).toBe(true);
    expect(refund(back.ledger, paid.entry.seq)).toMatchObject({ ok: false, reason: 'duplicate' });
    const gain = award(L(0), 10, 'bounty', 'b');
    if (!gain.ok) throw new Error('award');
    expect(refund(gain.ledger, gain.entry.seq)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('transact: charges once and completes; a failed effect is refunded; a retry of the same id is refused', () => {
    let applied = 0;
    const ok = transact(L(200), 80, 'purchase', 'Deep Array', 'tx:a', () => ++applied);
    expect(ok.ok && ok.ledger.balance).toBe(120);
    expect(applied).toBe(1);
    if (!ok.ok) return;
    const dup = transact(ok.ledger, 80, 'purchase', 'Deep Array', 'tx:a', () => ++applied);
    expect(dup).toMatchObject({ ok: false, reason: 'duplicate', refunded: false });
    expect(dup.ledger.balance).toBe(120);
    expect(applied).toBe(1);

    const failed = transact(L(200), 80, 'purchase', 'Broken', 'tx:b', () => null);
    expect(failed).toMatchObject({ ok: false, reason: 'failed', refunded: true });
    expect(failed.ledger.balance).toBe(200);
    const threw = transact(L(200), 80, 'purchase', 'Broken', 'tx:c', () => {
      throw new Error('effect failed');
    });
    expect(threw).toMatchObject({ ok: false, reason: 'failed', refunded: true });
    expect(threw.ledger.balance).toBe(200);

    let ran = false;
    const poor = transact(L(10), 80, 'purchase', 'x', 'tx:d', () => (ran = true));
    expect(poor).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(ran).toBe(false);
  });

  it('record logs a change a quote already applied, and refuses no-ops and duplicates', () => {
    const r = record(L(100), 60, 'purchase', 'Bought 5 reactor cells');
    expect(r.ok && r.entry.delta).toBe(-40);
    expect(record(L(100), 100, 'sale', 'x').ok).toBe(false);
    expect(record(L(100), -1, 'sale', 'x').ok).toBe(false);
    const m = record(L(0), 120, 'mission', 'Mission · First light', 'mission:story-first-light');
    if (!m.ok) throw new Error('record');
    expect(record(m.ledger, 240, 'mission', 'Mission · First light', 'mission:story-first-light')).toMatchObject({ ok: false, reason: 'duplicate' });
  });

  it('keeps the history and the duplicate-id list bounded', () => {
    let l = L(0);
    for (let i = 0; i < 100; i++) {
      const r = award(l, 1, 'bounty', `b${i}`, `kill:milky-way/sol:${i}`);
      if (!r.ok) throw new Error('award');
      l = r.ledger;
    }
    expect(l.balance).toBe(100);
    expect(l.history).toHaveLength(MARKS.historyLimit);
    expect(l.history[l.history.length - 1]!.seq).toBe(100);
    expect(l.recent).toHaveLength(MARKS.recentLimit);
    expect(l.seq).toBe(100);
  });

  it('labels are cleaned (no control characters) and bounded', () => {
    const r = award(L(0), 5, 'sale', `Sold\n${'x'.repeat(200)}`);
    expect(r.ok && r.entry.label.length).toBe(MARKS.labelMax);
    expect(r.ok && /[\n\r]/.test(r.entry.label)).toBe(false);
  });

  it('states Required, Available and Shortfall for a price the wallet cannot cover', () => {
    expect(afford(50, 120)).toEqual({ ok: false, required: 120, available: 50, shortfall: 70 });
    expect(afford(120, 120)).toEqual({ ok: true, required: 120, available: 120, shortfall: 0 });
    expect(insufficientText(1200, 450)).toBe('INSUFFICIENT MARKS · Required ◈ 1,200 MARKS · Available ◈ 450 MARKS · Shortfall ◈ 750 MARKS');
  });
});

describe('HUD balance feedback (transient, never saved)', () => {
  it('counts a small change towards the balance, then holds it; the tag fades after its time', () => {
    expect(tickerValue(115, 15, 0, false)).toEqual({ shown: 100, tag: true });
    const mid = tickerValue(115, 15, TICKER.countMs / 2, false).shown;
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThanOrEqual(115);
    expect(tickerValue(115, 15, TICKER.countMs, false)).toEqual({ shown: 115, tag: true });
    expect(tickerValue(115, 15, TICKER.tagMs, false)).toEqual({ shown: 115, tag: false });
  });

  it('reduced motion and large changes jump straight to the balance (the tag stays static)', () => {
    expect(tickerValue(115, 15, 0, true)).toEqual({ shown: 115, tag: true });
    expect(tickerValue(5000, TICKER.countMax + 1, 0, false).shown).toBe(5000);
    expect(tickerValue(80, -40, 0, false).shown).toBe(120);
    expect(tickerValue(80, 0, 0, false)).toEqual({ shown: 80, tag: false });
    expect(tickerValue(80, 10, Number.NaN, false)).toEqual({ shown: 80, tag: false });
  });
});

describe('earning hooks: bounties, encounters, discoveries', () => {
  it('pays a bounty for every real hostile family, scaled with toughness; drones pay nothing', () => {
    const fams = Object.keys(FAMILIES);
    for (const f of fams) expect((REWARDS.bounty as Record<string, number>)[f], f).toBeGreaterThanOrEqual(3);
    const byToughness = [...fams].sort((a, b) => FAMILIES[a as keyof typeof FAMILIES].hull + FAMILIES[a as keyof typeof FAMILIES].shield - (FAMILIES[b as keyof typeof FAMILIES].hull + FAMILIES[b as keyof typeof FAMILIES].shield));
    const pays = byToughness.map((f) => (REWARDS.bounty as Record<string, number>)[f]!);
    for (let i = 1; i < pays.length; i++) expect(pays[i]!).toBeGreaterThanOrEqual(pays[i - 1]!);
    expect(bountyBase(kill('raider'))).toBe(3);
    expect(bountyBase(kill('capital'))).toBe(40);
    expect(bountyBase(kill('raider', 'milky-way/sol', 'launched'))).toBe(0);
    expect(bountyBase(kill('made-up'))).toBe(0);
  });

  it('a system pays bounties from a pool: farming the same system stops paying until enough lane hops pass', () => {
    let book: BountyBook = {};
    let paid = 0;
    let limitedSeen = false;
    for (let i = 0; i < 30; i++) {
      const r = bountyClaim(book, kill('heavy'), 4, String(i));
      book = r.book;
      paid += r.claim?.amount ?? 0;
      limitedSeen ||= r.limited;
    }
    expect(paid).toBe(REWARDS.bountyPool);
    expect(limitedSeen).toBe(true);
    expect(bountyLeft(book, 'milky-way/sol', 4)).toBe(0);
    expect(bountyClaim(book, kill('heavy'), 4, 'x').claim).toBeNull();
    expect(bountyRefillIn(book, 'milky-way/sol', 4)).toBe(REWARDS.bountyWindowJumps);
    // other systems have their own pool
    expect(bountyClaim(book, kill('heavy', 'milky-way/sirius'), 4, 'y').claim?.amount).toBe(10);
    // the pool refills only after the period, counted in saved lane hops (re-entering does not reset it)
    expect(bountyClaim(book, kill('heavy'), 4 + REWARDS.bountyWindowJumps - 1, 'z').claim).toBeNull();
    expect(bountyClaim(book, kill('heavy'), 4 + REWARDS.bountyWindowJumps, 'w').claim?.amount).toBe(10);
  });

  it('bounty claim ids are unique per kill and the book stays bounded', () => {
    const a = bountyClaim({}, kill('raider'), 0, '41');
    const b = bountyClaim(a.book, kill('raider'), 0, '42');
    expect(a.claim?.id).toBe('kill:milky-way/sol:41');
    expect(b.claim?.id).not.toBe(a.claim?.id);
    const big: Record<string, { paid: number; since: number }> = {};
    for (let i = 0; i < 400; i++) big[`g/s${i}`] = { paid: 1, since: 100 };
    expect(Object.keys(pruneBounties(big, 101)).length).toBeLessThanOrEqual(REWARDS.bountyBookMax);
    expect(pruneBounties({ 'g/old': { paid: 60, since: 0 } }, REWARDS.bountyWindowJumps)).toEqual({});
  });

  const ctx = (newEntry: boolean) => ({ newEntry, systemName: (id: string) => (id === 'milky-way/sol' ? 'Sol' : id), galaxyName: (id: string) => (id === 'lmc' ? 'LMC' : id) });

  it('pays every encounter kind once on completion, with a stable claim id', () => {
    for (const k of [...SITE_KINDS, 'outpost'] as const) {
      const c = eventClaim({ type: 'encounter-cleared', systemId: 'milky-way/sol', encounterId: `${k}-1`, kind: k }, ctx(false));
      expect(c?.amount, k).toBe(REWARDS.encounter[k]);
      expect(c?.kind).toBe('encounter');
      expect(c?.id).toBe(`enc:milky-way/sol#${k}-1`);
    }
    expect(eventClaim({ type: 'encounter-failed', systemId: 'milky-way/sol', encounterId: 'ambush-1', kind: 'ambush' }, ctx(false))).toBeNull();
  });

  it('pays first discoveries only: a new log entry, a charted system, a first galaxy', () => {
    expect(eventClaim({ type: 'poi-completed', systemId: 'milky-way/sol', poiId: 'anomaly-1', kind: 'anomaly' }, ctx(true))).toMatchObject({ amount: REWARDS.discovery.anomaly, label: 'Anomaly investigated · Sol', id: 'poi:milky-way/sol#anomaly-1' });
    expect(eventClaim({ type: 'poi-completed', systemId: 'milky-way/sol', poiId: 'anomaly-1', kind: 'anomaly' }, ctx(false))).toBeNull();
    expect(eventClaim({ type: 'poi-completed', systemId: 'milky-way/sol', poiId: 'derelict-1', kind: 'derelict' }, ctx(true))?.amount).toBe(REWARDS.discovery.derelict);
    expect(eventClaim({ type: 'poi-completed', systemId: 'milky-way/sol', poiId: 'salvage-1', kind: 'salvage' as never }, ctx(true))).toBeNull();
    expect(eventClaim({ type: 'system-charted', systemId: 'milky-way/sol', galaxyId: 'milky-way' }, ctx(false))).toMatchObject({ amount: REWARDS.discovery.charted, id: 'chart:milky-way/sol' });
    expect(eventClaim({ type: 'galaxy-reached', galaxyId: 'lmc', first: true }, ctx(false))).toMatchObject({ amount: REWARDS.discovery.galaxy, label: 'New galaxy · LMC', id: 'galaxy:lmc' });
    expect(eventClaim({ type: 'galaxy-reached', galaxyId: 'lmc', first: false }, ctx(false))).toBeNull();
    expect(eventClaim({ type: 'jumped', hops: 3 }, ctx(true))).toBeNull();
    expect(eventClaim({ type: 'docked', systemId: 'milky-way/sol' }, ctx(true))).toBeNull();
  });

  it('a claim paid through the ledger cannot be paid twice', () => {
    const c = eventClaim({ type: 'system-charted', systemId: 'milky-way/sol', galaxyId: 'milky-way' }, ctx(false))!;
    const one = award(L(0), c.amount, c.kind, c.label, c.id);
    if (!one.ok) throw new Error('award');
    expect(award(one.ledger, c.amount, c.kind, c.label, c.id)).toMatchObject({ ok: false, reason: 'duplicate' });
  });

  it('every entry kind used by the rewards is a ledger kind', () => {
    for (const k of ['bounty', 'encounter', 'discovery', 'mission', 'sale', 'purchase', 'upgrade', 'refund']) expect(ENTRY_KINDS).toContain(k);
  });
});

describe('spending: admin-free quotes and insufficient funds', () => {
  it('buying cells without enough marks states the shortfall; the free (admin) quote keeps the balance', () => {
    const poor = quoteBuyCells(W({ marks: 10 }), 5);
    expect(poor.ok).toBe(false);
    if (!poor.ok) expect(poor.reason).toBe(insufficientText(40, 10));
    const free = quoteBuyCells(W({ marks: 10 }), 5, true);
    expect(free.ok).toBe(true);
    if (!free.ok) return;
    expect(free.result.marks).toBe(10);
    expect(free.result.hold['fuel']).toBe(5);
    expect(free.lines.find((l) => l.label === 'Marks')).toEqual({ label: 'Marks', before: '◈ 10 MARKS', after: '◈ 10 MARKS · ADMIN ACCESS — FREE' });
    expect(quoteBuyCells(W({ marks: 10 }), Number.NaN).ok).toBe(false);
    expect(quoteBuyCells(W({ marks: 10 }), -3).ok).toBe(false);
  });

  it('a free module quote still needs its materials (only the marks price is waived)', () => {
    const ship = SHIP_BY_ID.get('petrel')!;
    const withMats = Object.entries(MODULE_PRICES).find(([, p]) => p.materials.length > 0);
    expect(withMats).toBeTruthy();
    const [id, price] = withMats!;
    const r = quoteBuyModule(W({ marks: 0 }), ship, id, true);
    const fits = quoteBuyModule(W({ marks: price.marks + 1000, hold: Object.fromEntries(price.materials.map((m) => [m.resource, m.amount])) }), ship, id);
    if (fits.ok) {
      expect(r.ok).toBe(false); // no materials in the hold
      const ok = quoteBuyModule(W({ marks: 0, hold: Object.fromEntries(price.materials.map((m) => [m.resource, m.amount])) }), ship, id, true);
      expect(ok.ok && ok.result.marks).toBe(0);
    }
  });

  it('upgrades: insufficient marks names the shortfall; admin waives marks but not materials or licences', () => {
    const poor = quoteUpgrade(W({ marks: 20, hold: { alloy: 4 } }), 'petrel', undefined, {}, 'hull', []);
    expect(poor.quote.ok).toBe(false);
    if (!poor.quote.ok) expect(poor.quote.reason).toBe(insufficientText(50, 20));
    const free = quoteUpgrade(W({ marks: 20, hold: { alloy: 4 } }), 'petrel', undefined, {}, 'hull', [], true);
    expect(free.quote.ok).toBe(true);
    if (free.quote.ok) {
      expect(free.quote.result.marks).toBe(20);
      expect(free.quote.result.hold['alloy'] ?? 0).toBe(0);
    }
    const noMats = quoteUpgrade(W({ marks: 20 }), 'petrel', undefined, {}, 'hull', [], true);
    expect(noMats.quote.ok).toBe(false);
    if (!noMats.quote.ok) expect(noMats.quote.reason).toMatch(/Missing/);
    const noLicence = quoteUpgrade(W({ marks: 0, hold: { alloy: 8 } }), 'petrel', undefined, { hull: 1 }, 'hull', [], true);
    expect(noLicence.quote.ok).toBe(false);
    if (!noLicence.quote.ok) expect(noLicence.quote.reason).toMatch(/licence/);
  });

  it('a paid upgrade quote charges the catalogue price exactly once', () => {
    const q = quoteUpgrade(W({ marks: 75, hold: { alloy: 4 } }), 'petrel', undefined, {}, 'hull', []);
    expect(q.quote.ok && q.quote.result.marks).toBe(25);
    expect(q.quote.ok && q.quote.lines[0]).toEqual({ label: 'Marks', before: '◈ 75 MARKS', after: '◈ 25 MARKS' });
  });

  it('ships stay cargo + licence (no marks price); a short hold says what is missing', () => {
    const swift = SHIPS.find((s) => s.id === 'swift')!;
    expect(swift.cost.length).toBeGreaterThan(0);
    const r = quoteShip(W({ marks: 9_000_000 }), STARTER_FLEET, 'swift', () => true);
    expect(r.quote.ok).toBe(false);
    if (!r.quote.ok) expect(r.quote.reason).toMatch(/^INSUFFICIENT CARGO · ships cost materials, not marks · missing /);
    const paid = quoteShip(W({ marks: 77, hold: Object.fromEntries(swift.cost.map((c) => [c.resource, c.amount])) }), STARTER_FLEET, 'swift', () => true);
    expect(paid.quote.ok && paid.quote.result.marks).toBe(77);
  });

  it('selling pays the shown price and is recorded as a sale', () => {
    const price = sellPrice('scrap', 'milky-way/sol');
    expect(price).toBeGreaterThan(0);
    const q = quoteSell(W({ marks: 5, hold: { scrap: 3 } }), 'milky-way/sol', 'scrap', 3);
    if (!q.ok) throw new Error('sell');
    expect(q.result.marks).toBe(5 + 3 * price);
    const r = record(L(5), q.result.marks, 'sale', 'Sold 3 Hull scrap');
    expect(r.ok && r.entry.delta).toBe(3 * price);
  });
});

describe('save: the wallet survives reload and migration', () => {
  it('round-trips the balance, the history, the duplicate ids and the bounty book', () => {
    let p: ProgressionState = progressionFromSaved(EMPTY_PROGRESSION);
    p = { ...p, missions: { ...p.missions, jumps: 9 } };
    const a = award(ledgerOf(p), 25, 'encounter', 'Ambush cleared · Sol', 'enc:milky-way/sol#ambush-1');
    if (!a.ok) throw new Error('award');
    p = withLedger(p, a.ledger);
    const s = spend(ledgerOf(p), 8, 'purchase', 'Bought 1 reactor cell');
    if (!s.ok) throw new Error('spend');
    p = { ...withLedger(p, s.ledger), bounty: { 'milky-way/sol': { paid: 12, since: 7 } } };
    const { backing } = memStore();
    expect(saveProfile(backing, withProgression(EMPTY_PROFILE, progressionToSaved(p)))).toBe(true);
    const loaded = loadProfile(backing);
    expect(loaded.status).toBe('ok');
    const back = progressionFromSaved(loaded.data.progression);
    expect(back.marks).toBe(17);
    expect(back.ledger).toEqual(p.ledger);
    expect(back.bounty).toEqual(p.bounty);
    expect(seen(ledgerOf(back), 'enc:milky-way/sol#ambush-1')).toBe(true);
  });

  it('an older save (no history) keeps its exact balance and gets no starting bonus', () => {
    const { store, backing } = memStore();
    store.set('galaxia:freeroam', JSON.stringify({ ...EMPTY_PROFILE, version: 10, progression: { ...EMPTY_PROGRESSION, marks: 1234 } }));
    const r = loadProfile(backing);
    expect(r.status).toBe('ok');
    const p = progressionFromSaved(r.data.progression);
    expect(p.marks).toBe(1234);
    expect(p.ledger.history).toEqual([]);
    expect(p.bounty).toEqual({});
    // saving it again writes no empty ledger block (unchanged shape) and the same balance
    const saved = progressionToSaved(p);
    expect(saved.marks).toBe(1234);
    expect('ledger' in saved).toBe(false);
    expect('bounty' in saved).toBe(false);
    // loading twice never adds marks
    const again = progressionFromSaved(loadProfile(backing).data.progression);
    expect(again.marks).toBe(1234);
  });

  it('repairs a tampered wallet: bad balance, bad entries, bad ids, an impossible bounty book', () => {
    const { store, backing } = memStore();
    const history = [
      { seq: 1, kind: 'bounty', label: 'ok', delta: 3, balance: 3 },
      { seq: 2, kind: 'BOUNTY', label: 'bad kind', delta: 3, balance: 6 },
      { seq: 3, kind: 'sale', label: 'bad balance', delta: 3, balance: -6 },
      { seq: 4, kind: 'sale', label: 'fractional', delta: 1.5, balance: 6 },
      { seq: 5, kind: 'sale', label: 'x'.repeat(65), delta: 1, balance: 7 },
    ];
    store.set(
      'galaxia:freeroam',
      JSON.stringify({
        ...EMPTY_PROFILE,
        version: 10,
        progression: {
          ...EMPTY_PROGRESSION,
          marks: Number.MAX_SAFE_INTEGER,
          missions: { ...EMPTY_PROGRESSION.missions, jumps: 5 },
          ledger: { seq: -4, history, recent: ['enc:milky-way/sol#ambush-1', 'NOT AN ID', 42, 'kill:milky-way/sol:3'] },
          bounty: { 'milky-way/sol': { paid: 10, since: 4 }, 'milky-way/sirius': { paid: 10, since: 99 }, 'not an id': { paid: 1, since: 0 }, 'milky-way/vega': { paid: -1, since: 0 } },
        },
      }),
    );
    const r = loadProfile(backing);
    expect(r.status).toBe('repaired');
    const p = progressionFromSaved(r.data.progression);
    expect(p.marks).toBe(0);
    expect(p.ledger.history.map((e) => e.seq)).toEqual([1]);
    expect(p.ledger.recent).toEqual(['enc:milky-way/sol#ambush-1', 'kill:milky-way/sol:3']);
    expect(p.ledger.seq).toBe(1);
    expect(p.bounty).toEqual({ 'milky-way/sol': { paid: 10, since: 4 } });
  });

  it('negative, NaN and infinite balances never load', () => {
    for (const bad of [-1, 'NaN', 1e400, null, 3.5]) {
      const { store, backing } = memStore();
      store.set('galaxia:freeroam', `{"version":10,"progression":{"marks":${typeof bad === 'string' ? `"${bad}"` : String(bad)}}}`);
      const r = loadProfile(backing);
      const p = progressionFromSaved(r.data.progression);
      expect(validAmount(p.marks), String(bad)).toBe(true);
    }
  });

  it('ledgerFromSaved ignores an invalid balance and keeps the order of the history', () => {
    const l = ledgerFromSaved(Number.NaN, { seq: 2, history: [{ seq: 1, kind: 'sale', label: 'a', delta: 2, balance: 2 }, { seq: 2, kind: 'purchase', label: 'b', delta: -1, balance: 1 }], recent: [] });
    expect(l.balance).toBe(0);
    expect(ledgerToSaved(l).history.map((e) => e.label)).toEqual(['a', 'b']);
  });
});
