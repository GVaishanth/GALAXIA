/**
 * Notice queue (Prompt 12): the one notice card shown top-centre in flight
 * (arrivals, discoveries, mission results, refusals) and what overflows to the
 * corner log. Pure (no DOM; time is passed in, in milliseconds of the frame
 * clock), so the rules are unit-tested. Presentation only: nothing here
 * changes gameplay, and a notice that is skipped or shortened loses nothing
 * (every one also reaches the log or the panels).
 *
 * Rules:
 *  - at most one card at a time, plus at most `queueMax` waiting;
 *  - a more important notice replaces the card at once (the replaced one goes
 *    to the log); equal or less important ones wait their turn;
 *  - while the card's place is taken (a combat banner is up, or a panel covers
 *    the flight view) cards do not compete: new notices go straight to the
 *    log, and a card already showing steps aside to the log (flushNotices when
 *    a panel opens), so nothing expires unseen behind an overlay;
 *  - the same text again only extends the card (no stacking);
 *  - a waiting notice older than its own lifetime is moved to the log.
 */

export type NoticeKind = 'arrival' | 'mission' | 'discovery' | 'upgrade' | 'danger' | 'warn' | 'info';

export interface NoticeInput {
  readonly kind: NoticeKind;
  readonly title: string;
  readonly detail?: string | undefined;
  /** Display time, ms (default per kind). */
  readonly ms?: number | undefined;
}

export interface Notice {
  readonly kind: NoticeKind;
  readonly title: string;
  readonly detail: string;
  readonly ms: number;
  readonly id: number;
  readonly at: number;
  readonly until: number;
}

export interface NoticeState {
  readonly current: Notice | null;
  readonly queue: readonly Notice[];
  readonly nextId: number;
}

export const NOTICE = Object.freeze({
  queueMax: 3,
  /** A card shows at least this long before an equal-priority one may follow. */
  minMs: 900,
  defaultMs: Object.freeze({ arrival: 2800, mission: 3600, discovery: 2800, upgrade: 2400, danger: 3000, warn: 3200, info: 2600 } satisfies Record<NoticeKind, number>),
  priority: Object.freeze({ danger: 4, mission: 3, discovery: 3, upgrade: 3, arrival: 2, warn: 2, info: 1 } satisfies Record<NoticeKind, number>),
  /** Kicker shown above the title (the colour is never the only cue). */
  kicker: Object.freeze({ arrival: 'ARRIVED', mission: 'MISSION', discovery: 'DISCOVERY', upgrade: 'INSTALLED', danger: 'WARNING', warn: 'NOTICE', info: '' } satisfies Record<NoticeKind, string>),
});

export const EMPTY_NOTICES: NoticeState = Object.freeze({ current: null, queue: Object.freeze([]) as readonly Notice[], nextId: 1 });

/** What a call produced: the new state and any notices that went to the log instead. */
export interface NoticeStep {
  readonly state: NoticeState;
  readonly toLog: readonly Notice[];
}

const lineOf = (n: Pick<Notice, 'title' | 'detail'>): string => (n.detail ? `${n.title} · ${n.detail}` : n.title);

/** One-line text of a notice (for the log). */
export function noticeLine(n: Pick<Notice, 'title' | 'detail'>): string {
  return lineOf(n);
}

/** `aside`: the card's place is taken (combat banner or an open panel): straight to the log. */
export function pushNotice(s: NoticeState, input: NoticeInput, now: number, aside: boolean): NoticeStep {
  const ms = Math.max(400, input.ms ?? NOTICE.defaultMs[input.kind]);
  const n: Notice = { kind: input.kind, title: input.title, detail: input.detail ?? '', ms, id: s.nextId, at: now, until: now + ms };
  const next = { ...s, nextId: s.nextId + 1 };
  if (aside) return { state: next, toLog: [n] };
  const cur = s.current;
  if (cur && lineOf(cur) === lineOf(n)) return { state: { ...next, current: { ...cur, until: Math.max(cur.until, now + ms) } }, toLog: [] };
  if (s.queue.some((q) => lineOf(q) === lineOf(n))) return { state: next, toLog: [] };
  if (!cur) return { state: { ...next, current: n }, toLog: [] };
  if (NOTICE.priority[n.kind] > NOTICE.priority[cur.kind]) return { state: { ...next, current: n }, toLog: [cur] };
  // wait in line (most important first, then oldest); overflow drops the least important to the log
  const queue = [...s.queue, n].sort((a, b) => NOTICE.priority[b.kind] - NOTICE.priority[a.kind] || a.id - b.id);
  const toLog = queue.length > NOTICE.queueMax ? queue.splice(NOTICE.queueMax) : [];
  return { state: { ...next, queue }, toLog };
}

/** Advance time: expire the card, promote the next one, step aside for combat. */
export function tickNotices(s: NoticeState, now: number, aside: boolean): NoticeStep {
  if (aside) return flushNotices(s);
  let cur = s.current;
  if (cur && now < cur.until) return { state: s, toLog: [] };
  const toLog: Notice[] = [];
  const queue = [...s.queue];
  cur = null;
  while (queue.length > 0) {
    const n = queue.shift()!;
    // waited longer than it would have shown: the log has it
    if (now - n.at > n.ms) {
      toLog.push(n);
      continue;
    }
    cur = { ...n, until: now + Math.max(NOTICE.minMs, n.ms - (now - n.at) / 2) };
    break;
  }
  if (cur === s.current && queue.length === s.queue.length) return { state: s, toLog };
  return { state: { ...s, current: cur, queue }, toLog };
}

/** The card and the queue step aside to the log (a panel opened, or a combat banner). */
export function flushNotices(s: NoticeState): NoticeStep {
  if (!s.current && s.queue.length === 0) return { state: s, toLog: [] };
  return { state: { ...s, current: null, queue: [] }, toLog: [...(s.current ? [s.current] : []), ...s.queue] };
}

/** Drop everything (leaving the flight view). */
export function clearNotices(s: NoticeState): NoticeState {
  return s.current || s.queue.length ? { ...s, current: null, queue: [] } : s;
}
