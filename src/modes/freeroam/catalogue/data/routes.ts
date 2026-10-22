/**
 * Inter-galaxy routes (Prompt 4): the travel graph of the galaxy map.
 *
 * GALAXIA design, not astronomy. Intergalactic travel is fiction and the map is
 * a stylised navigation chart, not to scale. The graph is deliberately sparse
 * (never every galaxy to every galaxy) so progression has a shape:
 *
 *   Milky Way ─ LMC ─ SMC (local triangle, open from the start)
 *       └─ Lantern Gate ─ Andromeda ─ Triangulum ─ Pinwheel ─ Whirlpool ─┐
 *                             └─ Centaurus A ─────────────── Sombrero ──┴─ Ring Gate ─ Cartwheel
 *
 * Ids are canonical: `${from}~${to}` with from < to, one route per pair.
 */
import type { RouteRecord } from '../types.ts';

export const ROUTES: readonly RouteRecord[] = [
  { id: 'lmc~milky-way', from: 'lmc', to: 'milky-way', name: 'Magellanic Lane', routeClass: 'local-lane', cost: 1, risk: 'low', encounter: 'none', unlock: [] },
  { id: 'milky-way~smc', from: 'milky-way', to: 'smc', name: 'Southern Lane', routeClass: 'local-lane', cost: 1, risk: 'low', encounter: 'none', unlock: [] },
  { id: 'lmc~smc', from: 'lmc', to: 'smc', name: 'Bridge Lane', routeClass: 'local-lane', cost: 1, risk: 'low', encounter: 'patrols', unlock: [] },
  {
    id: 'andromeda~milky-way',
    from: 'andromeda',
    to: 'milky-way',
    name: 'Lantern Gate Jump',
    routeClass: 'gate-jump',
    cost: 3,
    risk: 'moderate',
    encounter: 'patrols',
    unlock: [{ kind: 'milestone', milestoneId: 'lantern-gate' }],
  },
  { id: 'andromeda~triangulum', from: 'andromeda', to: 'triangulum', name: 'Triangle Lane', routeClass: 'local-lane', cost: 2, risk: 'moderate', encounter: 'patrols', unlock: [] },
  { id: 'andromeda~centaurus-a', from: 'andromeda', to: 'centaurus-a', name: 'Long Southern Jump', routeClass: 'deep-jump', cost: 4, risk: 'high', encounter: 'ambush', unlock: [] },
  { id: 'pinwheel~triangulum', from: 'pinwheel', to: 'triangulum', name: 'Northern Deep Jump', routeClass: 'deep-jump', cost: 4, risk: 'high', encounter: 'convoy-raids', unlock: [] },
  { id: 'pinwheel~whirlpool', from: 'pinwheel', to: 'whirlpool', name: 'Houndsway Jump', routeClass: 'deep-jump', cost: 3, risk: 'high', encounter: 'swarm-tide', unlock: [] },
  { id: 'sombrero~whirlpool', from: 'sombrero', to: 'whirlpool', name: 'Brimside Jump', routeClass: 'deep-jump', cost: 4, risk: 'high', encounter: 'sentinels', unlock: [] },
  { id: 'centaurus-a~sombrero', from: 'centaurus-a', to: 'sombrero', name: 'Dustlane Jump', routeClass: 'deep-jump', cost: 4, risk: 'high', encounter: 'gauntlet', unlock: [] },
  {
    id: 'cartwheel~sombrero',
    from: 'cartwheel',
    to: 'sombrero',
    name: 'Ring Gate Rift',
    routeClass: 'rift-jump',
    cost: 5,
    risk: 'extreme',
    encounter: 'gauntlet',
    unlock: [{ kind: 'milestone', milestoneId: 'ring-gate' }],
  },
];
