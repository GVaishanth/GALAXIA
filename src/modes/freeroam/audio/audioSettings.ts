/**
 * Audio settings steps (Prompt 12): the SOUND panel's volume buttons. Pure.
 * The values are the shared `galaxia:prefs` audio preferences, so a change in
 * Free Roam is the same setting Classic uses (and the other way round).
 */
export const VOLUME_STEP = 0.1;

export type VolumeBus = 'master' | 'sfx' | 'music';

export const BUS_LABEL: Readonly<Record<VolumeBus, string>> = Object.freeze({ master: 'MASTER', sfx: 'EFFECTS', music: 'MUSIC' });

/** One step up or down, clamped to 0..1 and snapped to the step (no float drift). */
export function stepVolume(v: number, dir: 1 | -1): number {
  const base = Number.isFinite(v) ? v : 0;
  const snapped = Math.round(base / VOLUME_STEP) * VOLUME_STEP;
  return Math.round(Math.min(1, Math.max(0, snapped + dir * VOLUME_STEP)) * 100) / 100;
}

export function volumeText(v: number): string {
  return `${Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)) * 100)}%`;
}
