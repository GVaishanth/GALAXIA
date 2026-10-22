/**
 * Exploration milestones (Free Roam Prompt 10). Pure.
 *
 * A milestone is reached from the pilot's lifetime progress (surveys, charted
 * systems, galaxies visited) and pays a fixed reward once. Rewards are claimed
 * at any station fabricator, where the whole reward must fit in the hold; a
 * reached but unclaimed milestone simply waits (nothing is lost). Claimed ids
 * are saved in the profile (`milestones`), so a reward can never be paid twice.
 * Older saves that already passed a milestone can claim it once.
 */
import type { LootEntry } from '../sector/model.ts';

export interface MilestoneProgress {
  readonly surveys: number;
  readonly charted: number;
  readonly galaxies: number;
}

export interface Milestone {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly reached: (p: MilestoneProgress) => boolean;
  readonly loot: readonly LootEntry[];
}

const M = (m: Milestone): Milestone => Object.freeze({ ...m, loot: Object.freeze(m.loot.map((e) => Object.freeze({ ...e }))) });

export const MILESTONES: readonly Milestone[] = Object.freeze([
  M({ id: 'first-survey', label: 'First survey', detail: 'Complete a sector survey.', reached: (p) => p.surveys >= 1, loot: [{ resource: 'components', amount: 4 }, { resource: 'nav-data', amount: 2 }] }),
  M({ id: 'surveys-5', label: 'Seasoned surveyor', detail: 'Complete 5 sector surveys.', reached: (p) => p.surveys >= 5, loot: [{ resource: 'components', amount: 6 }, { resource: 'samples', amount: 4 }, { resource: 'nav-data', amount: 4 }] }),
  M({ id: 'charted-10', label: 'Cartographer', detail: 'Chart 10 systems.', reached: (p) => p.charted >= 10, loot: [{ resource: 'nav-data', amount: 8 }, { resource: 'samples', amount: 2 }] }),
  M({ id: 'galaxies-2', label: 'Beyond the Milky Way', detail: 'Visit a second galaxy.', reached: (p) => p.galaxies >= 2, loot: [{ resource: 'components', amount: 6 }, { resource: 'samples', amount: 4 }] }),
  M({ id: 'galaxies-4', label: 'Deep voyager', detail: 'Visit 4 galaxies.', reached: (p) => p.galaxies >= 4, loot: [{ resource: 'components', amount: 8 }, { resource: 'nav-data', amount: 6 }, { resource: 'samples', amount: 6 }] }),
]);

export const MILESTONE_BY_ID: ReadonlyMap<string, Milestone> = new Map(MILESTONES.map((m) => [m.id, m]));

export type MilestoneState = 'locked' | 'claimable' | 'claimed';

export function milestoneState(m: Milestone, p: MilestoneProgress, claimed: readonly string[]): MilestoneState {
  if (claimed.includes(m.id)) return 'claimed';
  return m.reached(p) ? 'claimable' : 'locked';
}

/** Milestones reached but not claimed yet. */
export const claimableMilestones = (p: MilestoneProgress, claimed: readonly string[]): Milestone[] => MILESTONES.filter((m) => milestoneState(m, p, claimed) === 'claimable');
