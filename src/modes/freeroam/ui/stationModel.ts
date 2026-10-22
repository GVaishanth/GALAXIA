/**
 * Station interface model (Prompt 12): the docked hub's tabs and its overview.
 * Pure (no DOM), unit-tested. The tab strip is presentation: every tab opens a
 * panel that already existed (hangar, fabricator, missions, exchange,
 * upgrades) or the equipment screen, whose actions call the same rules as
 * before. Nothing here changes what docking does.
 */

export const STATION_TABS = Object.freeze(['station', 'hangar', 'equipment', 'fabricator', 'missions', 'exchange', 'upgrades'] as const);
export type StationTab = (typeof STATION_TABS)[number];

export const TAB_LABEL: Readonly<Record<StationTab, string>> = Object.freeze({
  station: 'STATION',
  hangar: 'HANGAR',
  equipment: 'EQUIPMENT',
  fabricator: 'FABRICATOR',
  missions: 'MISSIONS',
  exchange: 'EXCHANGE',
  upgrades: 'UPGRADES',
});

export function isStationTab(p: string | null): p is StationTab {
  return p !== null && (STATION_TABS as readonly string[]).includes(p);
}

/** The neighbouring tab (wraps). */
export function stepTab(current: StationTab, dir: 1 | -1): StationTab {
  const i = STATION_TABS.indexOf(current);
  return STATION_TABS[(i + dir + STATION_TABS.length) % STATION_TABS.length]!;
}

/** Where Back goes from a tab: sub-tabs return to the overview; the overview has no back (LAUNCH leaves). */
export function backFrom(tab: StationTab): StationTab | null {
  return tab === 'station' ? null : 'station';
}

/** What the overview says (all values come from the shell; nothing is computed from game rules here). */
export interface StationSummary {
  readonly name: string;
  /** First visit (the station was just logged). */
  readonly first: boolean;
  readonly ship: string;
  readonly cells: number;
  /** Free emergency cells granted on this dock (0 = none). */
  readonly emergency: number;
  readonly marks: number;
  readonly ready: number;
  readonly active: number;
  readonly offers: number;
  readonly stored: number;
}

export interface OverviewLine {
  readonly label: string;
  readonly value: string;
  /** Draw attention (e.g. missions ready to turn in). */
  readonly accent: boolean;
}

export interface ServiceCard {
  readonly tab: Exclude<StationTab, 'station'>;
  readonly title: string;
  readonly detail: string;
  readonly badge: string;
}

export interface StationOverview {
  readonly kicker: string;
  readonly title: string;
  readonly status: string;
  readonly lines: readonly OverviewLine[];
  readonly services: readonly ServiceCard[];
}

const plural = (n: number, one: string, many = /[a-z]/.test(one) ? `${one}s` : `${one}S`): string => `${n} ${n === 1 ? one : many}`;

export function stationOverview(s: StationSummary): StationOverview {
  const status = `Docked. Hull, shield and energy restored; the ${s.ship} is safe here.${s.first ? ' Station logged in your record.' : ''}`;
  const lines: OverviewLine[] = [
    { label: 'REACTOR CELLS', value: s.emergency > 0 ? `${s.cells} (+${s.emergency} FREE EMERGENCY)` : String(s.cells), accent: s.emergency > 0 },
    { label: 'GUILD MARKS', value: String(s.marks), accent: false },
    { label: 'MISSIONS', value: s.ready > 0 ? `${s.ready} READY TO TURN IN` : s.active > 0 ? `${s.active} ACTIVE` : 'NONE ACTIVE', accent: s.ready > 0 },
  ];
  const services: ServiceCard[] = [
    { tab: 'missions', title: 'MISSIONS', detail: s.ready > 0 ? 'Turn in completed work, take new jobs.' : 'Take contracts and story missions.', badge: s.ready > 0 ? `${s.ready} READY` : s.offers > 0 ? plural(s.offers, 'OFFER') : '' },
    { tab: 'hangar', title: 'HANGAR', detail: 'Choose, buy and inspect ships.', badge: '' },
    { tab: 'equipment', title: 'EQUIPMENT', detail: 'Fit stored modules to the ship’s slots.', badge: s.stored > 0 ? `${s.stored} STORED` : '' },
    { tab: 'fabricator', title: 'FABRICATOR', detail: 'Build modules from cargo.', badge: '' },
    { tab: 'exchange', title: 'EXCHANGE', detail: 'Trade cargo with the Guild for marks.', badge: '' },
    { tab: 'upgrades', title: 'UPGRADES', detail: 'Tune the ship (Mk I–III).', badge: '' },
  ];
  return { kicker: 'STATION', title: s.name.toUpperCase(), status, lines, services };
}
