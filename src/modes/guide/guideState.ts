/**
 * First-run guide state (P04.2 guide). One small record, `galaxia:guide`,
 * separate from every progression record:
 *
 *   { version: 1, seen: <guide content version acknowledged>, outcome }
 *
 *  - `GUIDE_VERSION` is the version of the guide's *content*. The tutorial
 *    opens automatically while `seen < GUIDE_VERSION`. A future major control
 *    change raises GUIDE_VERSION, so the guide shows once more (as an updated
 *    guide), without touching anything else.
 *  - `outcome` records how the last acknowledged version ended: `completed`
 *    (FINISH or a PLAY button on the last step) or `skipped` (SKIP TUTORIAL,
 *    or closing it). Both stop the automatic tutorial.
 *  - The record holds nothing else: opening, skipping or finishing the guide
 *    never writes the Classic record, a Free Roam slot, the fleet registry,
 *    Guild marks or any unlock.
 *
 * Scope: GALAXIA has no player accounts. The guide comes before a mode or a
 * Free Roam save slot is chosen, so it is stored per browser, like the shared
 * audio / display preferences (`galaxia:prefs`).
 *
 * Pure apart from the KeyValueStore it is given; works without storage
 * (the in-memory fallback simply forgets it when the tab closes).
 */
import type { KeyValueStore } from '../../persistence/storage.ts';
import { STORAGE_KEYS } from '../../shared/persistence/namespaces.ts';
import { parseRecord, writeRecord, type RecordSpec } from '../../shared/persistence/record.ts';

/** Version of the guide's content. Raise it only for a change players must relearn (e.g. new core controls). */
export const GUIDE_VERSION = 1;

export type GuideOutcome = 'none' | 'completed' | 'skipped';
const OUTCOMES: readonly GuideOutcome[] = ['none', 'completed', 'skipped'];

export interface GuideRecord {
  /** Highest guide content version the player finished or dismissed (0 = never). */
  readonly seen: number;
  readonly outcome: GuideOutcome;
}

const EMPTY: GuideRecord = Object.freeze({ seen: 0, outcome: 'none' });

export const GUIDE_SPEC: RecordSpec<GuideRecord> = Object.freeze({
  key: STORAGE_KEYS.guide,
  version: 1,
  defaults: EMPTY,
  sanitize(doc: Record<string, unknown>) {
    const s = doc['seen'];
    const o = doc['outcome'];
    const seenOk = typeof s === 'number' && Number.isInteger(s) && s >= 0 && s <= 1000;
    const outcomeOk = typeof o === 'string' && (OUTCOMES as readonly string[]).includes(o);
    const seen = seenOk ? s : 0;
    // an acknowledged version needs a real outcome; anything inconsistent counts as "not seen"
    const outcome: GuideOutcome = outcomeOk ? (o as GuideOutcome) : 'none';
    const consistent = (seen === 0) === (outcome === 'none');
    return { data: consistent ? { seen, outcome } : EMPTY, repaired: !seenOk || !outcomeOk || !consistent };
  },
});

/** The stored guide state (read only; a damaged record reads as "never seen"). */
export function readGuide(store: KeyValueStore): GuideRecord {
  return parseRecord(store.read(GUIDE_SPEC.key), GUIDE_SPEC).data;
}

/** True when the first-run tutorial should open automatically. */
export function guideDue(rec: GuideRecord, version: number = GUIDE_VERSION): boolean {
  return rec.seen < version;
}

/**
 * Remember that the current guide was finished or skipped. Writes only the
 * guide record. A record written by a newer build is left as it is. Returns
 * false when nothing could be stored (the caller still treats the guide as
 * seen for the rest of the page session).
 */
export function acknowledgeGuide(store: KeyValueStore, outcome: Exclude<GuideOutcome, 'none'>, version: number = GUIDE_VERSION): boolean {
  const current = parseRecord(store.read(GUIDE_SPEC.key), GUIDE_SPEC);
  if (!current.writable) return false;
  if (current.data.seen > version) return true; // a newer guide was already acknowledged
  return writeRecord(store, GUIDE_SPEC, { seen: version, outcome });
}
