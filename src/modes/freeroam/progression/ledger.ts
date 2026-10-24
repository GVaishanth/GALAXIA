/**
 * Guild marks ledger (Economy pass): the one authoritative wallet operations.
 *
 * The balance itself stays `ProgressionState.marks` (saved as
 * `progression.marks` since v9), so every screen reads the same number. This
 * module is the small service around it:
 *
 *   validAmount   a non-negative safe integer no larger than the cap
 *   afford        required / available / shortfall for a price
 *   award         add marks for a validated reason (once per claim id)
 *   spend         take marks atomically (never below zero, once per id)
 *   transact      spend, run the effect, refund if the effect fails
 *   refund        reverse one recorded spend exactly once
 *   record        log a change that a quote already applied (exchange, upgrades)
 *
 * Every change is one immutable step that returns a new ledger or a refusal;
 * nothing is applied half-way. Recent claim ids (bounded) stop the same
 * reward or transaction from being processed twice; the once-only rewards are
 * additionally keyed to facts that are saved once (a completed point of
 * interest, a cleared encounter, a claimed mission), so the bounded id list is
 * a second guard, not the only one. The history is bounded too (never grows
 * the save without limit) and holds no personal data.
 *
 * Pure: no DOM, no storage, no clock.
 */

/** Central currency configuration (display identity, cap, starting balance, bounds). */
export const MARKS = Object.freeze({
  /** Long name in sentences. */
  name: 'Guild marks',
  /** Unit after a number: "◈ 1,240 MARKS". */
  unit: 'MARKS',
  /** Original glyph (a framed diamond), always shown with the number and the unit. */
  glyph: '◈',
  /** The wallet never exceeds this (the save field's cap since v9). */
  max: 9_999_999,
  /** A new pilot's balance. Prompt 11 started pilots at 0 with 12 reactor cells and the first missions pay 60–150. */
  starting: 0,
  /** Entries kept in the history (oldest dropped first). */
  historyLimit: 24,
  /** Claim / transaction ids remembered for duplicate refusal. */
  recentLimit: 48,
  /** Longest stored entry label. */
  labelMax: 64,
});

export const ENTRY_KINDS = ['mission', 'bounty', 'encounter', 'discovery', 'sale', 'purchase', 'upgrade', 'ship', 'travel', 'refund'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface LedgerEntry {
  /** Increasing per profile. */
  readonly seq: number;
  readonly kind: EntryKind;
  readonly label: string;
  /** Signed change in marks (0 = free, e.g. an admin bypass is never recorded at all). */
  readonly delta: number;
  /** Balance after the change. */
  readonly balance: number;
  /** A spend reversed by a later refund entry. */
  readonly refunded?: true;
}

export interface Ledger {
  readonly balance: number;
  /** Last sequence number used. */
  readonly seq: number;
  /** Newest last, at most MARKS.historyLimit. */
  readonly history: readonly LedgerEntry[];
  /** Recently processed claim ids, newest last, at most MARKS.recentLimit. */
  readonly recent: readonly string[];
}

export const EMPTY_LEDGER: Ledger = Object.freeze({ balance: MARKS.starting, seq: 0, history: Object.freeze([]), recent: Object.freeze([]) });

export type Refusal = 'invalid' | 'duplicate' | 'insufficient' | 'cap' | 'unknown';

export type LedgerResult = { readonly ok: true; readonly ledger: Ledger; readonly entry: LedgerEntry } | { readonly ok: false; readonly reason: Refusal; readonly ledger: Ledger };

/** A price or reward the wallet accepts: a safe integer, 0..cap. NaN, infinities, fractions and negatives are refused. */
export const validAmount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MARKS.max;

const isKind = (k: unknown): k is EntryKind => typeof k === 'string' && (ENTRY_KINDS as readonly string[]).includes(k);
const cleanLabel = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MARKS.labelMax);
const pushBounded = <T>(xs: readonly T[], x: T, limit: number): readonly T[] => (xs.length >= limit ? [...xs.slice(xs.length - limit + 1), x] : [...xs, x]);

function apply(l: Ledger, kind: EntryKind, label: string, delta: number, id: string | null): LedgerResult {
  const balance = l.balance + delta;
  const entry: LedgerEntry = { seq: l.seq + 1, kind, label: cleanLabel(label), delta, balance };
  const ledger: Ledger = {
    balance,
    seq: entry.seq,
    history: pushBounded(l.history, entry, MARKS.historyLimit),
    recent: id ? pushBounded(l.recent, id, MARKS.recentLimit) : l.recent,
  };
  return { ok: true, ledger, entry };
}

/** Has this claim / transaction id been processed recently? */
export const seen = (l: Ledger, id: string | null | undefined): boolean => !!id && l.recent.includes(id);

/** Affordability of a price: what is needed, what there is, and what is missing (0 = affordable). */
export function afford(balance: number, price: number): { readonly ok: boolean; readonly required: number; readonly available: number; readonly shortfall: number } {
  const required = validAmount(price) ? price : 0;
  const available = validAmount(balance) ? balance : 0;
  return { ok: validAmount(price) && available >= required, required, available, shortfall: Math.max(0, required - available) };
}

/**
 * Add marks. Refused: an invalid amount (negative, fractional, NaN, infinite, above the cap),
 * an unknown kind, or an id already processed. A reward that would pass the cap pays up to the cap.
 * A zero reward is refused as invalid (nothing to record).
 */
export function award(l: Ledger, amount: unknown, kind: EntryKind, label: string, id: string | null = null): LedgerResult {
  if (!validAmount(amount) || amount === 0 || !isKind(kind)) return { ok: false, reason: 'invalid', ledger: l };
  if (seen(l, id)) return { ok: false, reason: 'duplicate', ledger: l };
  const room = MARKS.max - l.balance;
  if (room <= 0) return { ok: false, reason: 'cap', ledger: l };
  return apply(l, kind, label, Math.min(amount, room), id);
}

/** Take marks atomically: all of it or nothing, never below zero, once per id. */
export function spend(l: Ledger, price: unknown, kind: EntryKind, label: string, id: string | null = null): LedgerResult {
  if (!validAmount(price) || !isKind(kind)) return { ok: false, reason: 'invalid', ledger: l };
  if (seen(l, id)) return { ok: false, reason: 'duplicate', ledger: l };
  if (price > l.balance) return { ok: false, reason: 'insufficient', ledger: l };
  if (price === 0) return { ok: true, ledger: id ? { ...l, recent: pushBounded(l.recent, id, MARKS.recentLimit) } : l, entry: { seq: l.seq, kind, label: cleanLabel(label), delta: 0, balance: l.balance } };
  return apply(l, kind, label, -price, id);
}

/** Reverse one recorded spend (by sequence number) exactly once. */
export function refund(l: Ledger, seq: number, label?: string): LedgerResult {
  const i = l.history.findIndex((e) => e.seq === seq);
  const e = i >= 0 ? l.history[i]! : null;
  if (!e || e.delta >= 0 || e.kind === 'refund') return { ok: false, reason: 'unknown', ledger: l };
  if (e.refunded) return { ok: false, reason: 'duplicate', ledger: l };
  const marked = l.history.map((x, j) => (j === i ? { ...x, refunded: true as const } : x));
  const back = Math.min(-e.delta, MARKS.max - l.balance);
  return apply({ ...l, history: marked }, 'refund', label ?? `Refund · ${e.label}`, back, null);
}

export type TransactResult<T> =
  | { readonly ok: true; readonly ledger: Ledger; readonly value: T; readonly charged: number }
  | { readonly ok: false; readonly ledger: Ledger; readonly reason: Refusal | 'failed'; readonly refunded: boolean };

/**
 * Pay, then complete: the price is taken first (exactly once, by id), then `effect` runs. If the
 * effect returns null or throws, the payment is refunded, so a failed purchase never leaves the
 * pilot charged; a duplicate id is refused before anything is taken.
 */
export function transact<T>(l: Ledger, price: number, kind: EntryKind, label: string, id: string | null, effect: () => T | null): TransactResult<T> {
  const paid = spend(l, price, kind, label, id);
  if (!paid.ok) return { ok: false, ledger: l, reason: paid.reason, refunded: false };
  let value: T | null = null;
  try {
    value = effect();
  } catch {
    value = null;
  }
  if (value !== null) return { ok: true, ledger: paid.ledger, value, charged: price };
  if (price === 0) return { ok: false, ledger: l, reason: 'failed', refunded: false }; // nothing was taken
  const back = refund(paid.ledger, paid.entry.seq, `Refund · ${cleanLabel(label)} (not completed)`);
  // the id stays recorded with the refund, so the same request cannot be charged again by a retry of the same callback
  return { ok: false, ledger: back.ok ? back.ledger : paid.ledger, reason: 'failed', refunded: back.ok };
}

/**
 * Log a balance change that a quote already applied (exchange trades, upgrades, mission rewards):
 * `after` is the quoted balance. Refused when the step is not a valid change.
 */
export function record(l: Ledger, after: number, kind: EntryKind, label: string, id: string | null = null): LedgerResult {
  if (!validAmount(after) || !isKind(kind)) return { ok: false, reason: 'invalid', ledger: l };
  if (seen(l, id)) return { ok: false, reason: 'duplicate', ledger: l };
  const delta = after - l.balance;
  if (delta === 0) return { ok: false, reason: 'invalid', ledger: l };
  return apply(l, kind, label, delta, id);
}

/* --------------------------------------------------------------- display */

/** "12450" -> "12,450" (fixed grouping, independent of the browser locale). */
export function groupDigits(n: number): string {
  const v = Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0));
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "◈ 12,450 MARKS". */
export const formatMarks = (n: number): string => `${MARKS.glyph} ${groupDigits(n)} ${MARKS.unit}`;
/** "+15" / "−120" (a real minus sign) / "0". */
export const formatDelta = (d: number): string => (d > 0 ? `+${groupDigits(d)}` : d < 0 ? `\u2212${groupDigits(-d)}` : '0');
/** Words for screen readers: "12,450 Guild marks". */
export const spokenMarks = (n: number): string => `${groupDigits(n)} ${MARKS.name}`;

/** HUD balance feedback timing (transient: never saved). */
export const TICKER = Object.freeze({ countMs: 420, tagMs: 1800, countMax: 500 });

/**
 * The balance the HUD shows `ageMs` after a change of `delta`: small changes count up (or down)
 * with an ease-out over TICKER.countMs; large ones and reduced motion jump straight to the
 * balance. `tag` keeps the +N / −N indicator visible for TICKER.tagMs (static, no motion).
 */
export function tickerValue(balance: number, delta: number, ageMs: number, reduced: boolean): { readonly shown: number; readonly tag: boolean } {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : Infinity;
  const tag = delta !== 0 && age < TICKER.tagMs;
  if (reduced || delta === 0 || Math.abs(delta) > TICKER.countMax || age >= TICKER.countMs) return { shown: balance, tag };
  const t = 1 - (1 - age / TICKER.countMs) ** 3;
  return { shown: Math.max(0, Math.min(MARKS.max, Math.round(balance - delta * (1 - t)))), tag };
}

/** The standard refusal text for a price the wallet cannot cover. */
export function insufficientText(price: number, balance: number): string {
  const a = afford(balance, price);
  return `INSUFFICIENT MARKS · Required ${formatMarks(a.required)} · Available ${formatMarks(a.available)} · Shortfall ${formatMarks(a.shortfall)}`;
}

/* ------------------------------------------------------------------- save */

export interface SavedLedgerShape {
  readonly seq: number;
  readonly history: readonly { readonly seq: number; readonly kind: string; readonly label: string; readonly delta: number; readonly balance: number; readonly refunded?: boolean }[];
  readonly recent: readonly string[];
}

/** Ledger from the saved shapes (profile.ts already checked them): the balance is the saved `marks`. */
export function ledgerFromSaved(balance: number, saved: SavedLedgerShape | undefined): Ledger {
  const b = validAmount(balance) ? balance : MARKS.starting;
  if (!saved) return { ...EMPTY_LEDGER, balance: b };
  const history: LedgerEntry[] = [];
  for (const e of saved.history.slice(-MARKS.historyLimit)) {
    if (!isKind(e.kind) || !Number.isSafeInteger(e.seq) || !Number.isSafeInteger(e.delta) || !validAmount(e.balance)) continue;
    history.push(e.refunded ? { seq: e.seq, kind: e.kind, label: cleanLabel(e.label), delta: e.delta, balance: e.balance, refunded: true } : { seq: e.seq, kind: e.kind, label: cleanLabel(e.label), delta: e.delta, balance: e.balance });
  }
  const seq = Math.max(Number.isSafeInteger(saved.seq) && saved.seq > 0 ? saved.seq : 0, ...history.map((e) => e.seq));
  return { balance: b, seq, history, recent: saved.recent.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 96).slice(-MARKS.recentLimit) };
}

export function ledgerToSaved(l: Ledger): SavedLedgerShape {
  return { seq: l.seq, history: l.history.map((e) => ({ ...e })), recent: [...l.recent] };
}
