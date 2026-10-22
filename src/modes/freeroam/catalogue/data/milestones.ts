/**
 * Unlock milestones and progression settings (Prompt 4). Config-driven and
 * deterministic: every condition is a count or a percentage of systems the
 * player has charted. Nothing depends on random drops, and the first session
 * offers the LMC at once and the SMC after one survey run.
 *
 * A survey run (the flight-test sector for now) charts the next system of the
 * current galaxy, so "surveys in X" and "explore N% of X" both grow by playing.
 * Later stages can add condition kinds (missions, items) without touching the map.
 *
 * Who needs what (GALAXIA design, not astronomy):
 *   SMC         first-survey            Andromeda   andromeda-charts (+ route: lantern-gate)
 *   Triangulum  local-group-explorer    Centaurus A andromeda-relay
 *   Pinwheel    pinwheel-charts         Whirlpool   pinwheel-relay
 *   Sombrero    sombrero-charts         Cartwheel   deep-field-explorer (+ route: ring-gate)
 */
import type { MilestoneRecord, ProgressionConfig } from '../types.ts';

const none = { driveTier: null, chartSystems: [] } as const;

export const MILESTONES: readonly MilestoneRecord[] = [
  {
    id: 'first-survey',
    kind: 'starter-objective',
    name: 'First Survey',
    description: 'Complete your first survey run in the Milky Way.',
    condition: { kind: 'surveys-in', galaxyId: 'milky-way', count: 1 },
    rewards: none,
  },
  {
    id: 'lantern-gate',
    kind: 'jump-gate',
    name: 'Lantern Gate',
    description: 'Explore 15% of the Milky Way to bring the Lantern Gate back online.',
    condition: { kind: 'exploration', galaxyId: 'milky-way', percent: 15 },
    rewards: { driveTier: 2, chartSystems: ['milky-way/lantern-gate'] },
  },
  {
    id: 'andromeda-charts',
    kind: 'navigation-data',
    name: 'Andromeda Charts',
    description: 'Recover navigation data from both Magellanic Clouds: one survey run in each.',
    condition: {
      kind: 'all',
      of: [
        { kind: 'surveys-in', galaxyId: 'lmc', count: 1 },
        { kind: 'surveys-in', galaxyId: 'smc', count: 1 },
      ],
    },
    rewards: none,
  },
  {
    id: 'local-group-explorer',
    kind: 'exploration-level',
    name: 'Local Group Explorer',
    description: 'Reach explorer level 3 by charting systems in any galaxy.',
    condition: { kind: 'explorer-level', level: 3 },
    rewards: none,
  },
  {
    id: 'andromeda-relay',
    kind: 'regional-mission',
    name: 'Andromeda Relay',
    description: 'Regional mission: complete 3 survey runs in the Andromeda Galaxy.',
    condition: { kind: 'surveys-in', galaxyId: 'andromeda', count: 3 },
    rewards: { driveTier: 3, chartSystems: [] },
  },
  {
    id: 'pinwheel-charts',
    kind: 'navigation-data',
    name: 'Pinwheel Charts',
    description: 'Explore 25% of the Triangulum Galaxy to recover the Pinwheel jump plot.',
    condition: { kind: 'exploration', galaxyId: 'triangulum', percent: 25 },
    rewards: none,
  },
  {
    id: 'pinwheel-relay',
    kind: 'regional-mission',
    name: 'Pinwheel Relay',
    description: 'Regional mission: complete 3 survey runs in the Pinwheel Galaxy.',
    condition: { kind: 'surveys-in', galaxyId: 'pinwheel', count: 3 },
    rewards: { driveTier: 4, chartSystems: [] },
  },
  {
    id: 'sombrero-charts',
    kind: 'navigation-data',
    name: 'Sombrero Charts',
    description: 'Explore 20% of the Whirlpool Galaxy or 20% of Centaurus A.',
    condition: {
      kind: 'any',
      of: [
        { kind: 'exploration', galaxyId: 'whirlpool', percent: 20 },
        { kind: 'exploration', galaxyId: 'centaurus-a', percent: 20 },
      ],
    },
    rewards: none,
  },
  {
    id: 'ring-gate',
    kind: 'jump-gate',
    name: 'Ring Gate',
    description: 'Explore 25% of the Sombrero Galaxy to open the Ring Gate rift.',
    condition: { kind: 'exploration', galaxyId: 'sombrero', percent: 25 },
    rewards: { driveTier: 5, chartSystems: [] },
  },
  {
    id: 'deep-field-explorer',
    kind: 'exploration-level',
    name: 'Deep Field Explorer',
    description: 'Reach explorer level 7 by charting systems in any galaxy.',
    condition: { kind: 'explorer-level', level: 7 },
    rewards: none,
  },
];

export const PROGRESSION: ProgressionConfig = { startGalaxy: 'milky-way', explorerLevelStep: 4 };
