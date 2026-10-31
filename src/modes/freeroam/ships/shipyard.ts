/**
 * P10.1 lazy boundary (docs/freeroam/SHIP_EXPANSION.md "Code splitting"): the
 * in-game Hangar panel (ship bay, purchases, recovery terms, compare, Bridge)
 * is loaded on demand by the shell, first when the pilot docks.
 *
 * This file is only the chunk's entry, so the emitted file is
 * `assets/shipyard-*.js`: the release verifier (scripts/lib/distCheck.ts)
 * rejects any file named like the developer Hangar showcase (/hangar/i), and
 * that guard stays as strict as it was.
 */
export { createHangarPanel } from './hangarPanel.ts';
