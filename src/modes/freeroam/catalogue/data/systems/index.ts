/** All authored system rows, one module per galaxy (content data only). */
import type { GalaxySystems } from '../../types.ts';
import { ANDROMEDA_SYSTEMS } from './andromeda.ts';
import { CARTWHEEL_SYSTEMS } from './cartwheel.ts';
import { CENTAURUS_A_SYSTEMS } from './centaurusA.ts';
import { LMC_SYSTEMS } from './lmc.ts';
import { MILKY_WAY_SYSTEMS } from './milkyWay.ts';
import { PINWHEEL_SYSTEMS } from './pinwheel.ts';
import { SMC_SYSTEMS } from './smc.ts';
import { SOMBRERO_SYSTEMS } from './sombrero.ts';
import { TRIANGULUM_SYSTEMS } from './triangulum.ts';
import { WHIRLPOOL_SYSTEMS } from './whirlpool.ts';

export const SYSTEM_DATA: readonly GalaxySystems[] = [
  MILKY_WAY_SYSTEMS,
  ANDROMEDA_SYSTEMS,
  TRIANGULUM_SYSTEMS,
  LMC_SYSTEMS,
  SMC_SYSTEMS,
  WHIRLPOOL_SYSTEMS,
  PINWHEEL_SYSTEMS,
  SOMBRERO_SYSTEMS,
  CENTAURUS_A_SYSTEMS,
  CARTWHEEL_SYSTEMS,
];
