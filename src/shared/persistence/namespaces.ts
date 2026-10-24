/**
 * Storage namespaces (Free Roam Prompt 2). Every localStorage key GALAXIA uses
 * is listed here, so modes can never collide.
 *
 *  - `galaxia:save`      Classic Mode record (high score, best stage). UNCHANGED
 *                        format and key (persistence/saveData.ts). Its legacy
 *                        audio/display fields are kept, never deleted; they seed
 *                        the shared preferences once (migration) and stay as a
 *                        fallback for older builds.
 *  - `galaxia:prefs`     Shared preferences (audio + display), used by every mode.
 *  - `galaxia:freeroam`  Free Roam save slot 1 (the original Free Roam key, kept
 *                        as is so existing progress is slot 1; FR-TD-74).
 *  - `galaxia:freeroam:slot2`, `galaxia:freeroam:slot3`  Free Roam slots 2 and 3
 *                        (same record format as slot 1, fully independent).
 *  - `galaxia:freeroam:slots`  Which Free Roam slot is in use (slot meta).
 *  - `galaxia:freeroam:prefs`  Free Roam settings shared by every slot (flight
 *                        controls); seeded once from slot 1's legacy `controls`.
 *  - `galaxia:fleet`     Cross-mode ship registry (Combat P03C, modes/crossMode.ts):
 *                        whether Classic Wave 20 was completed, and once it was,
 *                        the one authoritative set of unlocked roster ships that
 *                        every Free Roam slot and Classic's ship selector share.
 *                        Nothing is written before the milestone.
 *  - `galaxia:guide`     First-run guide (P04.2 guide, modes/guide/guideState.ts): which
 *                        guide version was finished or skipped. Per browser, like
 *                        the shared prefs; never touches progression.
 *  - `<key>:backup`      Raw copy of the most recent damaged or repaired version of
 *                        a record, written before the record is reset / rewritten.
 *  - `<key>:v<N>`        Raw copy of a record as it was at version N, written once
 *                        before it is migrated to a newer version; never overwritten.
 *  - `galaxia:probe`     Write test used by openStore() (removed immediately).
 */
import { SAVE_KEY } from '../../persistence/saveData.ts';

export const STORAGE_KEYS = Object.freeze({
  classic: SAVE_KEY,
  prefs: 'galaxia:prefs',
  freeroam: 'galaxia:freeroam',
  freeroamSlots: 'galaxia:freeroam:slots',
  freeroamPrefs: 'galaxia:freeroam:prefs',
  fleet: 'galaxia:fleet',
  guide: 'galaxia:guide',
  probe: 'galaxia:probe',
});

/** Free Roam save slot keys, slot 1 first (slot 1 is the original Free Roam key). */
export const FREEROAM_SLOT_KEYS: readonly [string, string, string] = Object.freeze([STORAGE_KEYS.freeroam, 'galaxia:freeroam:slot2', 'galaxia:freeroam:slot3']) as readonly [string, string, string];

export type NamespaceId = 'classic' | 'prefs' | 'freeroam';

export function backupKey(key: string): string {
  return `${key}:backup`;
}

/** Pre-migration copy of a record at `version` (written once, never overwritten). */
export function versionKey(key: string, version: number): string {
  return `${key}:v${version}`;
}

/** Problems worth telling the player about (shown once on the title screen). */
export type StorageNotice = 'unavailable' | 'write-failed' | 'corrupt-reset' | 'future-version' | 'backup-failed';

export const NOTICE_TEXT: Readonly<Record<StorageNotice, string>> = Object.freeze({
  unavailable: 'Browser storage is unavailable: progress lasts until this tab closes.',
  'write-failed': 'Saving failed (storage full or blocked): recent progress may not persist.',
  'corrupt-reset': 'A damaged save was reset. A backup copy of the old data was kept.',
  'future-version': 'Save data from a newer version was found; it is read but never overwritten.',
  'backup-failed': 'Old save data needed repair but no backup copy could be written (storage full or blocked): it was left untouched and new progress is not saved.',
});
