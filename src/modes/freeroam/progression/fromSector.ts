/**
 * Sector runtime events -> gameplay events (Free Roam Prompt 11).
 *
 * The sector runtime already reports what happened (sector/run.ts
 * SectorEvent); this adapter turns the facts missions and the exploration
 * record care about into GameEvents, so the shell only forwards them to the
 * bus. `applied` says whether the collection was accepted by the inventory
 * (a refused or repeated collection publishes nothing), `gained` is what
 * actually entered the hold. Pure.
 */
import type { LootEntry, PoiKind } from '../sector/model.ts';
import type { SectorEvent } from '../sector/run.ts';
import type { GameEvent } from './events.ts';

export interface SectorEventContext {
  readonly systemId: string;
  /** Kind of a POI of the active sector (undefined = not a POI). */
  kindOf(poiId: string): PoiKind | undefined;
  /** The inventory accepted the collection (false: nothing changed, e.g. a repeat). */
  readonly applied: boolean;
  /** Resources that entered the hold with this event. */
  readonly gained: readonly LootEntry[];
}

const acquired = (gained: readonly LootEntry[]): GameEvent[] => gained.filter((g) => g.amount > 0).map((g) => ({ type: 'resource-acquired', resource: g.resource, amount: g.amount }));

export function sectorGameEvents(e: SectorEvent, ctx: SectorEventContext): GameEvent[] {
  const systemId = ctx.systemId;
  switch (e.type) {
    case 'collected':
    case 'looted': {
      if (!ctx.applied) return [];
      const kind = e.type === 'looted' ? e.kind : (ctx.kindOf(e.id) ?? 'salvage');
      const out = acquired(ctx.gained);
      // a node with loot left is not done yet: it completes when it is emptied
      if (e.left.length === 0) out.push({ type: 'poi-completed', systemId, poiId: e.id, kind });
      return out;
    }
    case 'picked':
      return ctx.applied ? acquired(ctx.gained) : [];
    case 'encounter':
      if (e.state === 'cleared') return [{ type: 'encounter-cleared', systemId, encounterId: e.id, kind: e.kind }, ...(ctx.applied ? acquired(ctx.gained) : [])];
      if (e.state === 'failed') return [{ type: 'encounter-failed', systemId, encounterId: e.id, kind: e.kind }];
      return [];
    case 'destroyed':
      if (e.by !== 'player') return [{ type: 'faction-encountered', faction: e.faction }];
      return [
        { type: 'faction-encountered', faction: e.faction },
        { type: 'hostile-destroyed', systemId, faction: e.faction, family: e.family, role: e.role, source: e.source },
      ];
    case 'provoked':
      return [{ type: 'faction-encountered', faction: e.faction }];
    case 'docked':
      return [{ type: 'docked', systemId }];
    default:
      return [];
  }
}
