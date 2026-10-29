/**
 * System Map screen: one generic, catalogue-driven map for every galaxy (no
 * per-system screens). DOM + canvas, owned by the Free Roam mode scope.
 *
 *  - Canvas (systemMapRender.ts): lanes, markers, course, travel animation.
 *  - DOM: a real <button> per visible system covering its whole lattice cell
 *    (>= 44 CSS px where the screen allows), so taps never need precision and
 *    mouse, touch, keyboard, gamepad and screen readers all work.
 *  - Selecting a system only inspects it: details panel with what the pilot
 *    knows, its lanes and the planned route (or why it is blocked and which
 *    reachable systems are nearest). Travel needs TRAVEL HERE, then ENGAGE in a
 *    confirmation dialog that shows the route and its drive-charge estimate.
 *  - Progress is committed by the shell (deps.travel) before the cosmetic
 *    travel animation plays.
 *  - Prompt 11 (deps.fuel): costs are shown in reactor cells with the cells
 *    aboard; a course the hold cannot pay for offers the recovery instead
 *    (dock for free cells, or a free emergency jump to the nearest station),
 *    and systems with an active mission target are marked.
 */
import type { ModeContext } from '../../types.ts';
import type { DisposableScope } from '../../../shared/lifecycle/scope.ts';
import type { FactionId, GalaxyId, ResourceId, SystemCategory, SystemProvenanceStatus, UnlockRequirement } from '../catalogue/types.ts';
import { RESOURCES } from '../inventory/resources.ts';
import type { MapCommand } from '../input.ts';
import type { NavGraph } from './graph.ts';
import { spatialNext, type Point } from './layout.ts';
import { button, createMapShell, DET_ART_SIZE, el, reqList } from './mapShell.ts';
import { deriveView, describeRequirement, theName, type ExplorationProgress, type RequirementInfo } from './progress.ts';
import { computeSystemLayout, laneCurve, systemGrid, type LaneCurve, type SystemMapLayout } from './systemLayout.ts';
import { CATEGORY_COLOR, drawSystemMap, type SystemLaneDraw, type SystemNodeDraw } from './systemMapRender.ts';
import { HAZARD_LABEL, PATTERN_LABEL, deriveSystemView, type Knowledge, type Lane, type RoutePlan, type SystemState, type SystemTravelResult, type SystemView } from './systems.ts';

declare const __GALAXIA_TEST_HOOKS__: boolean; // vite.config.ts `define` (TD-78: automation hooks, absent from release builds)

type Services = ModeContext['services'];

declare const __GALAXIA_GRAVITY_LAB__: boolean; // vite.config.ts `define` (FR-TD-83: dev / QA builds only)

export interface SystemMapDeps {
  readonly scope: DisposableScope;
  readonly parent: HTMLElement;
  readonly graph: NavGraph;
  readonly services: Services;
  readonly reducedMotion: () => boolean;
  readonly progress: () => ExplorationProgress;
  /** Commit in-galaxy travel (shell applies + persists). */
  readonly travel: (to: string) => SystemTravelResult | FuelRefusal;
  readonly startSurvey: () => void;
  /** Back to the galaxy map. */
  readonly back: () => void;
  /** Ship travel efficiency (Prompt 8): drive-charge multiplier and the ship's name. Default 1. */
  readonly travelFactor?: (() => { readonly factor: number; readonly ship: string }) | undefined;
  /** Prompt 11: reactor cells (absent = the Prompt 5 estimate display, nothing is spent). */
  readonly fuel?: SystemFuelDeps | undefined;
  /** FR-TD-83: the experimental Gravity Flight test (dev / QA builds only): offered on this system while the pilot is in it. */
  readonly gravityTest?: { readonly systemId: string; readonly enter: () => void } | undefined;
}

/** A course refused because the hold lacks reactor cells (shell travel result). */
export interface FuelRefusal {
  readonly ok: false;
  readonly reason: 'fuel';
  readonly need: number;
  readonly have: number;
}

export interface SystemFuelDeps {
  /** Reactor cells aboard. */
  readonly held: () => number;
  /** Cells one hop of this lane charge costs the flown ship. */
  readonly hop: (laneCost: number) => number;
  /** R2: the free emergency jump target from the pilot's system (null = not due). */
  readonly emergency: () => string | null;
  readonly emergencyJump: (to: string) => SystemTravelResult;
  /** Economy pass: the marks side of a route in the confirmation (travel has no marks fee: "TRAVEL FEE FREE (0 MARKS) · BALANCE …"). */
  readonly fee?: (() => string) | undefined;
  /** Systems with an active mission target -> mission titles. */
  readonly missions: () => ReadonlyMap<string, readonly string[]>;
  /** The pilot's system has a station (dock there for free cells). */
  readonly station: (id: string) => boolean;
}

export interface SystemMapStatus {
  readonly visible: boolean;
  readonly galaxy: GalaxyId;
  readonly here: boolean;
  readonly selected: string | null;
  readonly focused: string | null;
  readonly hovered: string | null;
  readonly current: string | null;
  readonly confirmOpen: boolean;
  readonly transition: boolean;
  readonly orientation: string;
  readonly compact: boolean;
  readonly size: { readonly w: number; readonly h: number };
  /** Visible systems only. */
  readonly knowledge: Readonly<Record<string, Knowledge>>;
  readonly states: Readonly<Record<string, SystemState>>;
  readonly lanes: number;
  readonly plan: RoutePlan | null;
  readonly suggestion: string | null;
  /** Wide-lattice cells (deterministic; compared across engines by tests). */
  readonly cells: Readonly<Record<string, { readonly col: number; readonly row: number }>>;
  readonly draws: number;
}

export interface SystemMapScreen {
  readonly root: HTMLElement;
  readonly visible: boolean;
  show(galaxy: GalaxyId): void;
  hide(): void;
  command(c: MapCommand): void;
  frame(ts: number): void;
  refresh(): void;
  status(): SystemMapStatus;
}

/* ------------------------------------------------------------ labels */

export const CATEGORY_LABEL: Readonly<Record<SystemCategory, string>> = {
  'yellow-dwarf': 'Yellow dwarf star',
  'orange-dwarf': 'Orange dwarf star',
  'red-dwarf': 'Red dwarf star',
  'blue-giant': 'Blue giant',
  'red-giant': 'Red giant',
  'white-dwarf': 'White dwarf',
  'binary-star': 'Binary star',
  'multiple-star': 'Multiple star',
  'neutron-star': 'Neutron star',
  'black-hole': 'Black hole',
  'stellar-nursery': 'Stellar nursery',
  'star-cluster': 'Star cluster',
  'supernova-remnant': 'Supernova remnant',
  'supernova-site': 'Supernova site',
  'dark-nebula': 'Dark nebula',
  'debris-field': 'Debris field',
  'asteroid-field': 'Asteroid field',
  'relay-station': 'Relay station',
  'deep-void': 'Deep void',
  'satellite-galaxy': 'Satellite galaxy',
  'galactic-structure': 'Galactic structure',
  anomaly: 'Anomaly',
};
export const PROVENANCE_TAG: Readonly<Record<SystemProvenanceStatus, string>> = {
  'verified-object': 'Real object',
  fictional: 'GALAXIA fiction',
  procedural: 'Procedural',
  speculative: 'Speculative',
};
/** Resource names come from the one resource catalogue (inventory/resources.ts). */
const RESOURCE_LABEL = (id: ResourceId): string => RESOURCES[id].name;
const FACTION_LABEL: Readonly<Record<FactionId, string>> = { tessellate: 'the Tessellate', 'red-tally': 'the Red Tally', cordon: 'the Cordon', gleaners: 'Gleaners', 'haven-guild': 'Haven Guild' };
const KNOWLEDGE_LABEL: Readonly<Record<Knowledge, string>> = { hidden: 'Hidden', signal: 'Unknown signal', known: 'Known', surveyed: 'Surveyed' };
const STATE_LABEL: Readonly<Record<SystemState, string>> = { current: 'You are here', reachable: 'Reachable', blocked: 'No open route', locked: 'Locked', remote: 'View only' };
const pips = (d: number): string => '▮'.repeat(d) + '▯'.repeat(Math.max(0, 5 - d));

/** Travel animation length: 260 ms per hop, at most 1.2 s (200 ms with reduced motion). */
export function systemTravelMs(hops: number, reduced: boolean): number {
  return reduced ? 200 : Math.min(1200, 260 * Math.max(1, hops));
}

/* ------------------------------------------------------------ screen */

export function createSystemMap(deps: SystemMapDeps): SystemMapScreen {
  const { graph, services, scope } = deps;

  let visible = false;
  let galaxy: GalaxyId = deps.progress().current;
  let sv: SystemView = deriveSystemView(deriveView(graph, deps.progress()), galaxy);
  let selected: string | null = null;
  let hovered: string | null = null;
  let layout: SystemMapLayout | null = null;
  let curves = new Map<string, LaneCurve>();
  let confirmTarget: string | null = null;
  let travel: { path: string[]; curves: LaneCurve[]; start: number | null; dur: number } | null = null;
  let travelT = 0;
  let arrival: { start: number | null } | null = null;
  let draws = 0;
  /** Drive charge of one hop as the current ship would spend it (with fuel: reactor cells, rounded up). */
  const charge = (n: number): number => {
    if (deps.fuel) return deps.fuel.hop(n);
    const f = deps.travelFactor?.().factor ?? 1;
    return n > 0 ? Math.max(1, Math.round(n * f)) : 0;
  };
  /** A route's charge: the sum of its hops (what the shell burns). */
  const routeCharge = (lanes: readonly Lane[]): number => lanes.reduce((n, l) => n + charge(l.cost), 0);
  const unit = (): string => (deps.fuel ? 'CELLS' : 'DRIVE CHARGE');
  const costText = (lanes: readonly Lane[]): string => {
    const n = routeCharge(lanes);
    if (!deps.fuel) return `DRIVE CHARGE ${n} (${estimate()})`;
    const t = deps.travelFactor?.();
    const f = t && Math.abs(t.factor - 1) > 1e-6 ? ` (${t.ship.toUpperCase()} ×${t.factor.toFixed(2)})` : '';
    return `COST ${n} CELL${n === 1 ? '' : 'S'}${f} · YOU HAVE ${deps.fuel.held()}`;
  };
  /** ESTIMATE, plus the ship's travel factor when it is not 1. */
  const estimate = (): string => {
    const t = deps.travelFactor?.();
    return t && Math.abs(t.factor - 1) > 1e-6 ? `ESTIMATE · ${t.ship.toUpperCase()} ×${t.factor.toFixed(2)}` : 'ESTIMATE';
  };

  const shell = createMapShell({
    scope,
    parent: deps.parent,
    services,
    rootClass: 'fr-sysmap',
    label: 'System map',
    kicker: 'SYSTEM MAP',
    title: '',
    back: { text: '◀ GALAXIES', aria: 'Back to the galaxy map', onClick: () => deps.back() },
    note: 'STYLISED CHART · LANES NOT TO SCALE',
    hintKeys: 'ARROWS MOVE · ENTER ACTIONS · ESC BACK',
    hintTouch: 'TAP A SYSTEM TO INSPECT IT',
    navLabel: 'Systems',
    detailsId: 'fr-sys-details',
    detailsLabel: 'System details',
    confirm: {
      titleId: 'fr-sys-confirm-title',
      kicker: 'CONFIRM COURSE',
      note: deps.fuel ? 'Every hop burns reactor cells from the hold. Stations top you up for free when you dock, and an emergency jump to a station is always free, so no course can strand you.' : 'Drive charge is a route estimate. There is no fuel yet, so no course can strand you: every lane you fly stays open behind you.',
      onEngage: () => engage(),
      onCancel: () => closeConfirm(true),
    },
  });
  const { root, title, sub, surface, nodesNav, details, detArt, detKicker, detName, detClass, detBody, detActions, actionMenu, confirmLayer, cTitle, cRoute, cStats, confirmMenu } = shell;
  const announce = (t: string): void => shell.announce(t);

  let nodeButtons = new Map<string, HTMLButtonElement>();
  let builtFor: GalaxyId | null = null;

  const name = (id: string): string => sv.intel(id).name;

  const buildNodes = (): void => {
    if (builtFor === galaxy) return;
    builtFor = galaxy;
    nodeButtons = new Map();
    const buttons: HTMLButtonElement[] = [];
    for (const s of sv.graph.systems) {
      const b = el('button', 'fr-node fr-sysnode');
      b.type = 'button';
      b.dataset['system'] = s.id;
      b.setAttribute('aria-controls', details.id);
      b.append(el('span', 'fr-node-name'), el('span', 'fr-node-sub'));
      b.addEventListener('click', () => {
        if (travel) return;
        if (selected !== s.id) services.sound.play('uiMove');
        select(s.id);
        b.focus({ preventScroll: true });
      });
      b.addEventListener('focus', () => {
        if (!travel && selected !== s.id) select(s.id);
      });
      b.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') hovered = s.id;
      });
      b.addEventListener('pointerleave', () => {
        if (hovered === s.id) hovered = null;
      });
      buttons.push(b);
      nodeButtons.set(s.id, b);
    }
    nodesNav.replaceChildren(...buttons);
    layout = null;
  };

  const nodeSub = (id: string): string => {
    const st = sv.state(id);
    const k = sv.knowledge(id);
    if (st === 'current') return 'HERE';
    if (st === 'locked') return 'LOCKED';
    if (k === 'signal') return 'SIGNAL';
    const d = sv.intel(id).difficulty ?? 0;
    return `${k === 'surveyed' ? 'CHARTED' : 'UNCHARTED'} ${pips(d)}`;
  };

  const refreshNodes = (): void => {
    const missionMap = deps.fuel?.missions() ?? new Map<string, readonly string[]>();
    for (const [id, b] of nodeButtons) {
      const k = sv.knowledge(id);
      b.hidden = k === 'hidden';
      if (b.hidden) continue;
      const st = sv.state(id);
      const intel = sv.intel(id);
      b.dataset['state'] = st;
      b.dataset['knowledge'] = k;
      b.setAttribute('aria-pressed', String(id === selected));
      if (st === 'current') b.setAttribute('aria-current', 'location');
      else b.removeAttribute('aria-current');
      const [nameEl, subEl] = [b.firstElementChild as HTMLElement, b.lastElementChild as HTMLElement];
      const n = k === 'signal' ? 'Unknown signal' : intel.name;
      if (nameEl.textContent !== n) nameEl.textContent = n;
      const subText = nodeSub(id);
      if (subEl.textContent !== subText) subEl.textContent = subText;
      const marks = sv.markers(id).filter((m) => m.kind !== 'resource').map((m) => m.label);
      const diff = intel.difficulty ? ` Difficulty ${intel.difficulty} of 5.` : '';
      const mission = missionMap.get(id);
      if (mission?.length) b.dataset['mission'] = 'true';
      else delete b.dataset['mission'];
      b.setAttribute('aria-label', `${n}. ${KNOWLEDGE_LABEL[k]}. ${STATE_LABEL[st]}.${diff}${marks.length ? ` ${marks.join('. ')}.` : ''}${mission?.length ? ` Mission target: ${mission.join(', ')}.` : ''}`);
    }
  };

  /** Unlock checklist; a key system the pilot has not identified yet is not named. */
  const requirements = (unlock: readonly UnlockRequirement[]): RequirementInfo[] =>
    unlock.map((r) => {
      const info = describeRequirement(sv.view, r);
      if (r.kind !== 'system' || info.met) return info;
      const k = sv.graph.system(r.systemId) ? sv.knowledge(r.systemId) : 'known';
      if (k !== 'hidden' && k !== 'signal') return info;
      return { ...info, title: 'Chart a key system', detail: 'An unidentified system nearby holds the key. Explore the neighbouring lanes to find it.', progress: null, parts: [] };
    });

  const laneHazardText = (l: Lane): string => {
    if (l.hazard) return sv.knowledge(l.hazard.at) === 'surveyed' ? `${HAZARD_LABEL[l.hazard.id]} hazard` : 'hazard unknown';
    return sv.knowledge(l.a) === 'surveyed' && sv.knowledge(l.b) === 'surveyed' ? 'clear' : 'hazard unknown';
  };
  const laneEventText = (l: Lane): string | null => (l.event && sv.knowledge(l.event.at) === 'surveyed' ? `${PATTERN_LABEL[l.event.pattern].toLowerCase()} likely` : null);

  const facts = (rows: readonly (readonly [string, string])[]): HTMLElement => {
    const dl = el('dl', 'fr-det-facts');
    for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
    return dl;
  };

  const routeBlock = (plan: RoutePlan): HTMLElement[] => {
    const out: HTMLElement[] = [el('h3', 'fr-det-h', 'ROUTE')];
    if (plan.ok) {
      const ol = el('ol', 'fr-hop-list');
      plan.path.forEach((id, i) => {
        const li = el('li', 'fr-hop', i === 0 ? `${name(id)} (here)` : name(id));
        if (i > 0) {
          const l = plan.lanes[i - 1]!;
          const ev = laneEventText(l);
          li.append(el('span', 'fr-hop-meta', ` · ${deps.fuel ? `${charge(l.cost)} cell${charge(l.cost) === 1 ? '' : 's'}` : `charge ${charge(l.cost)}`} · ${laneHazardText(l)}${ev ? ` · ${ev}` : ''}`));
        }
        ol.append(li);
      });
      const sum = el('p', 'fr-route-sum', `${plan.jumps} ${plan.jumps === 1 ? 'JUMP' : 'JUMPS'} · ${costText(plan.lanes)}`);
      if (deps.fuel && deps.fuel.held() < routeCharge(plan.lanes)) sum.dataset['short'] = 'true';
      out.push(sum, ol);
      return out;
    }
    const why: Record<string, string> = {
      here: 'You are here.',
      elsewhere: `You are in ${theName(graph.node(deps.progress().current)!.galaxy.name)}. Travel to this galaxy on the galaxy map to fly its lanes.`,
      hidden: 'No navigation data.',
      locked: 'This system is locked: it cannot be entered until its requirements are met.',
      'no-route': plan.blocker
        ? `Every known route passes ${name(plan.blocker)}, which is locked.`
        : 'No known route yet. Chart or visit neighbouring systems to reveal more lanes.',
    };
    out.push(el('p', 'fr-det-note fr-blocked', why[plan.reason] ?? ''));
    if (plan.reason === 'no-route' && plan.blocker) {
      const s = sv.graph.system(plan.blocker)!;
      out.push(el('p', 'fr-det-sub', `TO UNLOCK ${name(plan.blocker).toUpperCase()}`), reqList(requirements(s.unlock)));
    }
    if (plan.alternatives.length) {
      out.push(el('p', 'fr-det-sub', 'REACHABLE NEARBY'));
      const box = el('div', 'fr-alts');
      for (const id of plan.alternatives) {
        const p = sv.plan(id);
        const b = button('fr-alt', `${name(id)}${p.ok ? ` · ${p.jumps}J · ${routeCharge(p.lanes)}${deps.fuel ? ' cells' : ''}` : ''}`, () => {
          services.sound.play('uiMove');
          select(id);
          focusNode(id);
        });
        b.setAttribute('aria-label', `Select ${name(id)}${p.ok ? `, ${p.jumps} jumps, ${unit().toLowerCase()} ${routeCharge(p.lanes)}` : ''}`);
        box.append(b);
      }
      out.push(box);
    }
    return out;
  };

  const drawBadge = (id: string): void => {
    const ctx = detArt.getContext('2d');
    if (!ctx) return;
    const S = DET_ART_SIZE;
    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#06070f';
    ctx.fillRect(0, 0, S, S);
    const k = sv.knowledge(id);
    const intel = sv.intel(id);
    const locked = sv.state(id) === 'locked';
    if (k === 'signal' || !intel.category) {
      ctx.strokeStyle = 'rgba(166,251,255,0.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#a6fbff';
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', S / 2, S / 2 + 1);
      return;
    }
    ctx.fillStyle = locked ? '#8a90ad' : CATEGORY_COLOR[intel.category];
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(S / 2 - 1, 6, 2, S - 12);
    ctx.fillRect(6, S / 2 - 1, S - 12, 2);
    ctx.strokeStyle = k === 'surveyed' ? 'rgba(92,239,255,0.9)' : 'rgba(138,144,173,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, 15, 0, Math.PI * 2);
    ctx.stroke();
  };

  const renderDetails = (): void => {
    const id = selected;
    if (!id) {
      detBody.replaceChildren();
      detActions.replaceChildren();
      detActions.hidden = true;
      return;
    }
    const s = sv.graph.system(id)!;
    const k = sv.knowledge(id);
    const st = sv.state(id);
    const intel = sv.intel(id);
    details.dataset['state'] = st;
    details.dataset['knowledge'] = k;
    drawBadge(id);
    detKicker.textContent = `${STATE_LABEL[st]} · ${KNOWLEDGE_LABEL[k]}`.toUpperCase();
    detName.textContent = intel.name;
    detClass.replaceChildren();
    if (intel.category && intel.provenance) {
      detClass.append(`${CATEGORY_LABEL[intel.category]} `, el('span', `fr-prov fr-prov-${intel.provenance}`, PROVENANCE_TAG[intel.provenance]));
    } else detClass.textContent = 'Unidentified · incomplete record';

    const body: HTMLElement[] = [el('p', 'fr-det-desc', intel.description)];
    if (intel.fact) body.push(el('p', 'fr-det-fact', intel.fact));
    const rows: [string, string][] = [];
    rows.push(['NAV ID', k === 'signal' ? '— (unidentified)' : s.id]);
    if (intel.difficulty) rows.push(['DIFFICULTY', `${pips(intel.difficulty)} ${intel.difficulty}/5`]);
    if (k === 'known') {
      rows.push(['RESOURCES', `${RESOURCE_LABEL(intel.resourceHint!)} (sensor hint) · survey to confirm`]);
      rows.push(['HOSTILES', 'Unknown until surveyed']);
      rows.push(['POINTS OF INTEREST', 'Unknown until surveyed']);
    } else if (k === 'surveyed') {
      const r = intel.resources!;
      rows.push(['RESOURCES', `${[r.primary, r.secondary].filter((x): x is ResourceId => !!x).map((x) => RESOURCE_LABEL(x)).join(', ')} · richness ${r.richness}/3`]);
      const h = intel.hostiles!;
      rows.push(['HOSTILES', h.factions.length && h.threat > 0 ? `Threat ${h.threat}/3 · ${PATTERN_LABEL[h.pattern]} · ${h.factions.map((f) => FACTION_LABEL[f]).join(', ')}` : 'None detected']);
      if (intel.friendly && intel.friendly.length) rows.push(['FRIENDLY', intel.friendly.map((f) => FACTION_LABEL[f]).join(', ')]);
      if (intel.neutral && intel.neutral.length) rows.push(['NEUTRAL', `${intel.neutral.map((f) => FACTION_LABEL[f]).join(', ')} (hostile if provoked)`]);
      rows.push(['HAZARD', intel.hazard && intel.hazard.id !== 'none' ? HAZARD_LABEL[intel.hazard.id] : 'None']);
      rows.push(['POINTS OF INTEREST', intel.pois!.join(' · ')]);
      if (intel.anomaly) rows.push(['ANOMALY', intel.anomaly]);
    } else rows.push(['RECORD', 'Incomplete: fly to a neighbouring system or chart one to identify it']);
    body.push(facts(rows));

    const missionTitles = deps.fuel?.missions().get(id) ?? [];
    if (missionTitles.length) {
      const ul = el('ul', 'fr-marker-list fr-mission-marks');
      for (const t of missionTitles) {
        const li = el('li', 'fr-marker', `MISSION · ${t}`);
        li.dataset['kind'] = 'mission';
        ul.append(li);
      }
      body.push(ul);
    }
    const marks = sv.markers(id).filter((m) => m.kind !== 'resource');
    if (marks.length) {
      const ul = el('ul', 'fr-marker-list');
      for (const m of marks) {
        const li = el('li', 'fr-marker', m.label);
        li.dataset['kind'] = m.kind;
        ul.append(li);
      }
      body.push(ul);
    }

    if (st === 'current') {
      body.push(el('p', 'fr-det-note', sv.view.charted.has(id) ? `${intel.name} is charted. Its sector stays open to explore: wrecks, caches, gates and the station.` : `Recording the survey marks in this sector charts ${intel.name}${s.provenance.status === 'verified-object' ? ' (the sector itself is a GALAXIA simulation)' : ''}.`));
    } else if (st === 'locked' && s.unlock.length) {
      body.push(el('h3', 'fr-det-h', 'TO UNLOCK'), reqList(requirements(s.unlock)));
    }
    const plan = sv.plan(id);
    if (st !== 'current') body.push(...routeBlock(plan));

    const lanes = sv.graph.lanesOf(id).filter((l) => sv.laneVisible(l));
    if (lanes.length) {
      const ul = el('ul', 'fr-route-list');
      for (const l of lanes) {
        const other = sv.graph.other(l, id);
        const ls = sv.laneState(l);
        const li = el('li', 'fr-route');
        li.dataset['state'] = ls;
        li.append(el('span', 'fr-route-to', `→ ${name(other)}`), el('span', 'fr-route-meta', `${deps.fuel ? `${charge(l.cost)} cell${charge(l.cost) === 1 ? '' : 's'}` : `charge ${charge(l.cost)}`} · ${laneHazardText(l)}`), el('span', 'fr-route-state', ls === 'locked' ? 'LOCKED' : 'OPEN'));
        ul.append(li);
      }
      const hiddenLanes = sv.graph.lanesOf(id).length - lanes.length;
      body.push(el('h3', 'fr-det-h', 'LANES'), ul);
      if (hiddenLanes > 0 && k !== 'signal') body.push(el('p', 'fr-det-sub', `${hiddenLanes} more ${hiddenLanes === 1 ? 'lane leads' : 'lanes lead'} into uncharted space.`));
    }
    detBody.replaceChildren(...body);
    detBody.scrollTop = 0;

    const actions: HTMLButtonElement[] = [];
    if (st === 'current') {
      actions.push(button('fr-btn', 'ENTER SECTOR', () => deps.startSurvey()));
      const lab = deps.gravityTest;
      if (__GALAXIA_GRAVITY_LAB__ && lab && lab.systemId === id) actions.push(button('fr-btn fr-btn-lab', 'GRAVITY TEST · EXPERIMENTAL', () => lab.enter()));
      const sos = deps.fuel?.emergency() ?? null;
      if (sos) {
        body.push(el('p', 'fr-det-note fr-fuel-warn', `Too few reactor cells for any lane out of ${intel.name}, and it has no station. The Guild covers an emergency jump to ${name(sos)}, the nearest station: free, and you can dock there for free cells.`));
        const e = button('fr-btn fr-btn-sos', `EMERGENCY JUMP · ${name(sos).toUpperCase()} · FREE`, () => emergency(sos));
        actions.push(e);
      } else if (deps.fuel && deps.fuel.station(id) && deps.fuel.held() < Math.min(...sv.graph.lanesOf(id).map((l) => charge(l.cost)))) {
        body.push(el('p', 'fr-det-note fr-fuel-warn', `Too few reactor cells for any lane out. Enter the sector and dock at the station: the Guild tops you up for free.`));
      } else if (deps.fuel && deps.fuel.held() < Math.min(...sv.graph.lanesOf(id).map((l) => charge(l.cost)))) {
        body.push(el('p', 'fr-det-note fr-fuel-warn', `Too few reactor cells for any lane out, and no station in reach. Open the galaxy map: the Guild flies you back to the Milky Way for free.`));
      }
    } else if (plan.ok) {
      const need = routeCharge(plan.lanes);
      const have = deps.fuel ? deps.fuel.held() : Infinity;
      if (have < need) {
        body.push(el('p', 'fr-det-note fr-fuel-warn', `NEEDS ${need} REACTOR CELLS · YOU HAVE ${have}. Dock at a station for free emergency cells or buy cells at an exchange.`));
      } else {
        const t = button('fr-btn', 'TRAVEL HERE', () => openConfirm(id));
        t.setAttribute('aria-label', `Travel to ${intel.name}: ${plan.jumps} jumps, ${unit().toLowerCase()} ${need}`);
        actions.push(t);
      }
    }
    if (deps.fuel) detBody.replaceChildren(...body); // fuel notes join the details
    detActions.replaceChildren(...actions);
    detActions.hidden = actions.length === 0;
  };

  const refreshHeader = (): void => {
    const g = graph.node(galaxy)!.galaxy;
    title.textContent = g.name.toUpperCase();
    const ex = sv.view.exploration(galaxy);
    const where = sv.current ? `AT ${name(sv.current).toUpperCase()}` : 'VIEW ONLY';
    sub.textContent = `${g.shortName.toUpperCase()} · ${ex.charted}/${ex.total} CHARTED · ${where}`;
    sub.title = `${ex.charted} of ${ex.total} systems charted${sv.current ? `; you are at ${name(sv.current)}` : '; you are in another galaxy'}`;
  };

  function refresh(): void {
    sv = deriveSystemView(deriveView(graph, deps.progress()), galaxy);
    buildNodes();
    if (selected && sv.knowledge(selected) === 'hidden') selected = null;
    selected ??= sv.current ?? sv.suggestion() ?? sv.visible[0] ?? null;
    refreshNodes();
    refreshHeader();
    renderDetails();
  }

  function select(id: string, announceIt = true): void {
    if (sv.knowledge(id) === 'hidden') return;
    selected = id;
    refreshNodes();
    renderDetails();
    if (announceIt) announce(`${name(id)}. ${STATE_LABEL[sv.state(id)]}.`);
  }

  const focusNode = (id: string | null): void => {
    if (id) nodeButtons.get(id)?.focus({ preventScroll: true });
  };
  const focusedNode = (): string | null => {
    const a = document.activeElement;
    return a instanceof HTMLElement && a.classList.contains('fr-sysnode') && nodesNav.contains(a) ? (a.dataset['system'] ?? null) : null;
  };

  /* -------------------------------------------------- confirm + travel */
  function openConfirm(id: string): void {
    const plan = sv.plan(id);
    if (!plan.ok) {
      announce('There is no open route to that system.');
      return;
    }
    services.sound.play('uiSelect');
    confirmTarget = id;
    cTitle.textContent = name(id).toUpperCase();
    cRoute.textContent = plan.path.map(name).join(' → ');
    const hazards = [...new Set(plan.lanes.map(laneHazardText).filter((t) => t !== 'clear'))];
    const fee = deps.fuel?.fee?.();
    cStats.textContent = `${plan.jumps} ${plan.jumps === 1 ? 'JUMP' : 'JUMPS'} · ${costText(plan.lanes)}${fee ? ` · ${fee}` : ''} · ${hazards.length ? hazards.join(', ').toUpperCase() : 'NO KNOWN HAZARDS'}`;
    confirmLayer.hidden = false;
    root.dataset['confirm'] = 'open';
    shell.setInert(true);
    confirmMenu.focus(0);
  }

  function closeConfirm(restoreFocus: boolean): void {
    if (confirmTarget === null) return;
    confirmTarget = null;
    confirmLayer.hidden = true;
    delete root.dataset['confirm'];
    shell.setInert(false);
    if (restoreFocus) {
      services.sound.play('uiMove');
      actionMenu.focus(0);
    }
  }

  const curveFor = (from: string, to: string): LaneCurve | null => {
    const l = sv.graph.laneBetween(from, to);
    const c = l ? curves.get(l.id) : undefined;
    if (!l || !c) return null;
    return l.a === from ? c : { ax: c.bx, ay: c.by, cx: c.cx, cy: c.cy, bx: c.ax, by: c.ay, bent: c.bent };
  };

  function engage(): void {
    const to = confirmTarget;
    if (to === null) return;
    const result = deps.travel(to);
    closeConfirm(false);
    if (!result.ok) {
      announce(result.reason === 'fuel' ? `Course cancelled: it needs ${(result as FuelRefusal).need} reactor cells and the hold has ${(result as FuelRefusal).have}.` : 'Course cancelled: the route is not open.');
      refresh();
      focusNode(selected);
      return;
    }
    flyRoute(to, result.plan.path);
  }

  /** R2: the free emergency jump to the nearest station. */
  function emergency(to: string): void {
    const result = deps.fuel?.emergencyJump(to);
    if (!result || !result.ok) {
      announce('Emergency jump unavailable.');
      refresh();
      return;
    }
    flyRoute(to, result.plan.path);
  }

  function flyRoute(to: string, route: readonly string[]): void {
    services.sound.play('uiSelect');
    const path = [...route];
    const hopCurves = path.slice(1).map((id, i) => curveFor(path[i]!, id)).filter((c): c is LaneCurve => c !== null);
    travel = { path, curves: hopCurves, start: null, dur: systemTravelMs(path.length - 1, deps.reducedMotion()) };
    travelT = 0;
    root.dataset['travel'] = 'on';
    nodesNav.inert = true;
    details.inert = true;
    announce(`Course laid in for ${name(to)}.`);
  }

  function finishTravel(): void {
    if (!travel) return;
    const to = travel.path[travel.path.length - 1]!;
    travel = null;
    delete root.dataset['travel'];
    nodesNav.inert = false;
    details.inert = false;
    refresh();
    select(to, false);
    focusNode(to);
    arrival = { start: null };
    services.sound.play('bonus');
    announce(`Arrived at ${name(to)}.`);
  }

  /* ------------------------------------------------------- commands */
  function command(c: MapCommand): void {
    if (!visible || travel) return;
    if (confirmTarget !== null) {
      if (c === 'up' || c === 'left') confirmMenu.move(-1);
      else if (c === 'down' || c === 'right') confirmMenu.move(1);
      else if (c === 'confirm') confirmMenu.activate();
      else if (c === 'back') closeConfirm(true);
      return;
    }
    const a = document.activeElement;
    if (a instanceof HTMLElement && (details.contains(a) || a === shell.back)) {
      const inActions = detActions.contains(a);
      if (c === 'back') {
        focusNode(selected);
        services.sound.play('uiMove');
      } else if (c === 'confirm') a.click();
      else if (inActions && actionMenu.buttons().length > 1 && (c === 'up' || c === 'down')) actionMenu.move(c === 'up' ? -1 : 1);
      else focusNode(selected);
      return;
    }
    if (c === 'back') {
      deps.back();
      return;
    }
    if (c === 'confirm') {
      const id = focusedNode() ?? selected;
      if (!id) return;
      if (id !== selected) select(id);
      if (actionMenu.buttons().length > 0) {
        services.sound.play('uiMove');
        actionMenu.focus(0);
      } else {
        const plan = sv.plan(id);
        const why = plan.ok ? '' : plan.reason === 'locked' ? ': it is locked' : plan.reason === 'elsewhere' ? ': you are in another galaxy' : plan.reason === 'no-route' ? ': no open route' : '';
        announce(`${name(id)} cannot be reached from here${why}. See the details panel.`);
        focusNode(id);
      }
      return;
    }
    if (!layout) return;
    const pts: Record<string, Point> = {};
    for (const id of sv.visible) pts[id] = layout.nodes[id]!;
    const from = focusedNode() ?? selected;
    if (!from) return;
    const next = spatialNext(pts, from, c);
    if (next) {
      services.sound.play('uiMove');
      select(next);
      focusNode(next);
    } else focusNode(from);
  }

  /* ---------------------------------------------------------- frame */
  const placeNodes = (L: SystemMapLayout): void => {
    root.dataset['orientation'] = L.orientation;
    root.dataset['compact'] = String(L.compact);
    for (const [id, b] of nodeButtons) {
      const box = L.boxes[id]!;
      const p = L.nodes[id]!;
      b.style.left = `${box.x}px`;
      b.style.top = `${box.y}px`;
      b.style.width = `${box.w}px`;
      b.style.height = `${box.h}px`;
      const padTop = Math.max(0, Math.round(p.y - box.y + L.radius + 3));
      b.style.paddingTop = `${padTop}px`;
      // a second name line only where the cell is wide and tall enough to hold it above the status line
      b.dataset['lines'] = L.cellW >= 72 && box.h - padTop >= 26 + (L.compact ? 0 : 12) ? '2' : '1';
    }
    curves = new Map(sv.graph.lanes.map((l) => [l.id, laneCurve(L, l.a, l.b)]));
  };

  function frame(ts: number): void {
    if (!visible) return;
    const b = surface.fit();
    const w = surface.css.width;
    const h = surface.css.height;
    if (!layout || Math.abs(layout.width - w) > 0.5 || Math.abs(layout.height - h) > 0.5) {
      layout = computeSystemLayout(systemGrid(sv.graph), w, h);
      placeNodes(layout);
    }
    let flash: number | null = null;
    if (arrival) {
      arrival.start ??= ts;
      flash = Math.min(1, (ts - arrival.start) / (deps.reducedMotion() ? 200 : 420));
      if (flash >= 1) arrival = null;
    }
    let anim: { path: readonly string[]; curves: readonly LaneCurve[]; t: number } | null = null;
    if (travel) {
      travel.start ??= ts;
      travelT = Math.min(1, (ts - travel.start) / travel.dur);
      anim = { path: travel.path, curves: travel.curves, t: travelT };
    }
    const focus = travel ? null : (hovered ?? selected);
    const plan = focus && focus !== sv.current ? sv.plan(focus) : null;
    const course = new Set<string>(plan && plan.ok ? plan.lanes.map((l) => l.id) : []);
    const nodes: SystemNodeDraw[] = sv.visible.map((id) => ({
      id,
      knowledge: sv.knowledge(id),
      state: sv.state(id),
      category: sv.intel(id).category,
      markers: sv.markers(id).map((m) => m.kind),
    }));
    const lanes: SystemLaneDraw[] = sv.graph.lanes.filter((l) => sv.laneVisible(l)).map((l) => ({ id: l.id, a: l.a, b: l.b, cost: l.cost, state: sv.laneState(l), curve: curves.get(l.id)! }));
    drawSystemMap(
      surface.ctx,
      b.width,
      b.height,
      {
        layout,
        nodes,
        lanes,
        course,
        current: travel ? null : sv.current,
        selected: travel ? null : selected,
        hovered: travel ? null : hovered,
        travel: anim,
        arrival: flash,
      },
      { ratio: b.ratio, timeMs: ts, reducedMotion: deps.reducedMotion() },
    );
    draws += 1;
    if (travel && travelT >= 1) finishTravel();
  }

  return {
    root,
    get visible() {
      return visible;
    },
    show(g: GalaxyId) {
      const changed = g !== galaxy;
      galaxy = g;
      visible = true;
      root.hidden = false;
      layout = null;
      if (changed) selected = null;
      sv = deriveSystemView(deriveView(graph, deps.progress()), galaxy);
      selected = sv.current ?? (selected && sv.knowledge(selected) !== 'hidden' ? selected : null) ?? sv.suggestion();
      refresh();
      focusNode(selected);
    },
    hide() {
      visible = false;
      closeConfirm(false);
      if (travel) {
        travel = null; // progress was already committed; only the animation is dropped
        delete root.dataset['travel'];
        nodesNav.inert = false;
        details.inert = false;
      }
      arrival = null;
      root.hidden = true;
      hovered = null;
    },
    command,
    frame,
    refresh,
    status() {
      if (!__GALAXIA_TEST_HOOKS__) return null as never; // P08.1 (TD-78): a browser-check reader only; release builds keep a stub
      const knowledge: Record<string, Knowledge> = {};
      const states: Record<string, SystemState> = {};
      for (const id of sv.visible) {
        knowledge[id] = sv.knowledge(id);
        states[id] = sv.state(id);
      }
      return {
        visible,
        galaxy,
        here: sv.here,
        selected,
        focused: focusedNode(),
        hovered,
        current: sv.current,
        confirmOpen: confirmTarget !== null,
        transition: travel !== null,
        orientation: layout?.orientation ?? 'none',
        compact: layout?.compact ?? false,
        size: { w: layout?.width ?? 0, h: layout?.height ?? 0 },
        knowledge,
        states,
        lanes: sv.graph.lanes.filter((l) => sv.laneVisible(l)).length,
        plan: selected ? sv.plan(selected) : null,
        suggestion: sv.suggestion(),
        cells: systemGrid(sv.graph).cells,
        draws,
      };
    },
  };
}
