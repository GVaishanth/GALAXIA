/**
 * Typed gameplay events (Free Roam Prompt 11).
 *
 * The systems that own the facts publish them: travel (system and galaxy
 * jumps), the sector runtime (collection, combat, docking: translated by
 * fromSector.ts), the survey (charting) and the station exchange (mission
 * deliveries). The mission manager and the exploration record only consume
 * events; no UI component decides mission progress.
 *
 * The bus is synchronous and tiny: publish() hands an event to every
 * subscriber in subscription order. Pure (no DOM, no timers).
 */
import type { FactionId } from '../catalogue/types.ts';
import type { PoiKind, EncounterKind } from '../sector/model.ts';

export type GameEvent =
  /** The pilot arrived in a system (every system on a flown route, gateways after a galaxy jump). */
  | { readonly type: 'system-visited'; readonly systemId: string; readonly galaxyId: string; readonly first: boolean }
  | { readonly type: 'galaxy-reached'; readonly galaxyId: string; readonly first: boolean }
  /** A system became charted (survey run or mission navigation data). */
  | { readonly type: 'system-charted'; readonly systemId: string; readonly galaxyId: string }
  /** A one-time point of interest was completed (salvage emptied, derelict inspected, cache opened, anomaly investigated). */
  | { readonly type: 'poi-completed'; readonly systemId: string; readonly poiId: string; readonly kind: PoiKind }
  /** The player destroyed a hostile ship. `role` tells a patrol ship from an encounter ship. */
  | { readonly type: 'hostile-destroyed'; readonly systemId: string; readonly faction: FactionId; readonly family: string; readonly role: string; readonly source: string }
  | { readonly type: 'encounter-cleared'; readonly systemId: string; readonly encounterId: string; readonly kind: EncounterKind }
  | { readonly type: 'encounter-failed'; readonly systemId: string; readonly encounterId: string; readonly kind: EncounterKind }
  | { readonly type: 'faction-encountered'; readonly faction: FactionId }
  /** Resources the pilot actually took aboard from the world (never purchases or mission rewards). */
  | { readonly type: 'resource-acquired'; readonly resource: string; readonly amount: number }
  /** A mission delivery was handed over at a station (published by the exchange transaction). */
  | { readonly type: 'delivered'; readonly missionId: string; readonly systemId: string; readonly resource: string; readonly amount: number }
  /** Lane hops flown (system routes, sector gates, galaxy jumps count 1 each). */
  | { readonly type: 'jumped'; readonly hops: number }
  | { readonly type: 'docked'; readonly systemId: string }
  | { readonly type: 'route-opened'; readonly routeId: string };

export type GameEventType = GameEvent['type'];

export interface EventBus {
  publish(e: GameEvent): void;
  publishAll(events: readonly GameEvent[]): void;
  /** Returns an unsubscribe function. */
  subscribe(fn: (e: GameEvent) => void): () => void;
  readonly subscribers: number;
}

export function createEventBus(): EventBus {
  const subs: ((e: GameEvent) => void)[] = [];
  const bus: EventBus = {
    publish(e) {
      for (const fn of [...subs]) fn(e);
    },
    publishAll(events) {
      for (const e of events) bus.publish(e);
    },
    subscribe(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    get subscribers() {
      return subs.length;
    },
  };
  return bus;
}
