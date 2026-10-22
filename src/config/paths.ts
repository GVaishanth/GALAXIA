/**
 * Scripted flight paths as chains of cubic Béziers, in art px.
 * Each path is [p0, c1, c2, p1, c1, c2, p2, ...] (3n+1 points): the end point
 * of one segment starts the next. Mirroring (x -> 448 - x) is done in code,
 * so each shape is authored once. Coordinates may lie off-screen (entries
 * and exits).
 */
import { deepFreeze } from './freeze.ts';

export type PathPoints = readonly (readonly [number, number])[];

export const ENTRY_PATHS = deepFreeze({
  /** From top centre, curling out to the left and up into the formation area. */
  topDrop: [
    [196, -24], [196, 120], [140, 260], [100, 300],
    [60, 340], [36, 250], [96, 220],
    [130, 204], [160, 200], [180, 196],
  ],
  /** From the lower left edge, a rising loop through the middle. */
  sideLoop: [
    [-24, 470], [80, 470], [180, 440], [210, 360],
    [240, 280], [150, 246], [128, 300],
    [108, 350], [196, 360], [216, 290],
  ],
  /** From the top, swinging wide right then back toward the centre. */
  topArc: [
    [300, -24], [300, 140], [424, 220], [384, 300],
    [344, 380], [240, 330], [276, 250],
  ],
} satisfies Record<string, PathPoints>);

export type EntryPathId = keyof typeof ENTRY_PATHS;

export const CHALLENGE_PATHS = deepFreeze({
  arcAcross: [
    [-24, 100], [150, 100], [300, 200], [300, 300],
    [300, 420], [120, 420], [140, 300],
    [160, 180], [380, 140], [480, 160],
  ],
  centreDive: [
    [200, -24], [200, 200], [60, 260], [80, 360],
    [100, 460], [300, 470], [340, 360],
    [380, 250], [260, 120], [250, -40],
  ],
  sideSweep: [
    [-24, 520], [120, 420], [160, 300], [224, 260],
    [288, 220], [360, 300], [300, 360],
    [240, 420], [160, 200], [200, -40],
  ],
  topLoop: [
    [120, -24], [120, 160], [340, 180], [340, 260],
    [340, 360], [160, 360], [160, 260],
    [160, 160], [400, 60], [480, 40],
  ],
  zigzag: [
    [480, 140], [300, 140], [200, 240], [224, 300],
    [250, 360], [100, 400], [80, 320],
    [60, 240], [200, 120], [-40, 100],
  ],
} satisfies Record<string, PathPoints>);

export type ChallengePathId = keyof typeof CHALLENGE_PATHS;
