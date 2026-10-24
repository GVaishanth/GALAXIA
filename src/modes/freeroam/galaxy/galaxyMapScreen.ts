/**
 * Galaxy Map screen (Free Roam hub). DOM + canvas, owned by the Free Roam mode
 * scope, so dispose() releases everything.
 *
 *  - Canvas (mapRender.ts): starfield, routes, portraits, state rings, travel animation.
 *  - DOM: one real <button> per catalogue galaxy, positioned over its portrait.
 *    Buttons give mouse, touch, Tab, screen-reader and focus support for free; the
 *    arrow keys / D-pad move focus spatially (layout.ts spatialNext).
 *  - Selecting a destination only *inspects* it (details panel). Travel needs the
 *    TRAVEL HERE action and then ENGAGE in a confirmation dialog.
 *  - Progress changes are committed by the shell (deps.travel) before the short
 *    travel animation plays; the animation is cosmetic only.
 *  - SYSTEM MAP / VIEW SYSTEMS open the galaxy's system map (systemMapScreen.ts);
 *    the DOM scaffolding is shared with it (mapShell.ts).
 */
import type { ModeContext } from '../../types.ts';
import type { DisposableScope } from '../../../shared/lifecycle/scope.ts';
import type { GalaxyClass, GalaxyId, GalaxyRecord, RouteClass, RouteRisk } from '../catalogue/types.ts';
import type { MapCommand } from '../input.ts';
import { GalaxyArtCache } from './galaxyArt.ts';
import type { NavEdge, NavGraph } from './graph.ts';
import { computeMapLayout, nodeBox, spatialNext, type MapLayout } from './layout.ts';
import { button, createMapShell, el, reqList } from './mapShell.ts';
import { deriveSystemView } from './systems.ts';
import { drawGalaxyMap, type TravelAnim } from './mapRender.ts';
import {
  checkTravel,
  deriveView,
  describeRequirement,
  edgeState,
  findPath,
  nodeState,
  type EdgeState,
  type ExplorationProgress,
  type NodeState,
  type ProgressView,
  type TravelResult,
} from './progress.ts';

type Services = ModeContext['services'];

export interface GalaxyMapDeps {
  readonly scope: DisposableScope;
  readonly parent: HTMLElement;
  readonly graph: NavGraph;
  readonly services: Services;
  readonly reducedMotion: () => boolean;
  readonly progress: () => ExplorationProgress;
  /** Commit a jump (shell applies + persists; Prompt 11: may refuse for lack of reactor cells). */
  readonly travel: (to: GalaxyId) => TravelResult | { readonly ok: false; readonly reason: 'fuel'; readonly need: number; readonly have: number };
  /** Prompt 11: reactor cells for galaxy jumps (absent = jumps cost nothing). */
  readonly fuel?: GalaxyFuelDeps | undefined;
  readonly startSurvey: () => void;
  /** Open a galaxy's system map (the current galaxy, or any unlocked one to look at). */
  readonly openSystems: (galaxy: GalaxyId) => void;
  readonly exit: () => void;
}

export interface GalaxyFuelDeps {
  readonly held: () => number;
  /** Cells a jump along this route costs the flown ship. */
  readonly jump: (edge: NavEdge) => number;
  /** R3: a free return to the start galaxy is due (no affordable route out). */
  readonly homeDue: () => boolean;
  /** Economy pass: the marks side of the jump in the confirmation (no marks fee). */
  readonly fee?: (() => string) | undefined;
  /** Commit the free return home (shell). */
  readonly home: () => boolean;
}

export interface MapStatus {
  readonly visible: boolean;
  readonly selected: GalaxyId;
  readonly focused: GalaxyId | null;
  readonly hovered: GalaxyId | null;
  readonly current: GalaxyId;
  readonly confirmOpen: boolean;
  readonly transition: boolean;
  readonly orientation: string;
  readonly size: { readonly w: number; readonly h: number };
  readonly states: Readonly<Record<string, NodeState>>;
  readonly draws: number;
}

export interface GalaxyMapScreen {
  readonly root: HTMLElement;
  /** The header row (the mode adds its SAVES button there). */
  readonly head: HTMLElement;
  readonly visible: boolean;
  show(): void;
  hide(): void;
  command(c: MapCommand): void;
  frame(ts: number): void;
  /** Re-read progress (after a survey run or travel). */
  refresh(): void;
  status(): MapStatus;
}

/* ------------------------------------------------------------ labels */

export const CLASS_LABEL: Readonly<Record<GalaxyClass, string>> = {
  'barred-spiral': 'Barred spiral',
  spiral: 'Spiral',
  'intermediate-spiral': 'Intermediate spiral',
  'magellanic-spiral': 'Magellanic spiral',
  'dwarf-irregular': 'Dwarf irregular',
  'interacting-spiral': 'Interacting spiral',
  'spiral-or-elliptical': 'Spiral or elliptical',
  'peculiar-elliptical': 'Peculiar elliptical',
  ring: 'Ring galaxy',
};
export const ROUTE_LABEL: Readonly<Record<RouteClass, string>> = { 'local-lane': 'Local lane', 'gate-jump': 'Gate jump', 'deep-jump': 'Deep jump', 'rift-jump': 'Rift jump' };
const RISK_LABEL: Readonly<Record<RouteRisk, string>> = { low: 'Low', moderate: 'Moderate', high: 'High', extreme: 'Extreme' };
const STATE_LABEL: Readonly<Record<NodeState, string>> = { current: 'Current location', available: 'Available', discovered: 'Discovered', locked: 'Locked' };
const EDGE_LABEL: Readonly<Record<EdgeState, string>> = { active: 'Open', open: 'Open', sealed: 'Sealed', locked: 'Locked' };

export function formatDistance(g: GalaxyRecord): string {
  const d = g.distanceLy;
  if (!d) return 'You are inside it';
  const fmt = (v: number): string => (v >= 1e6 ? `${Number((v / 1e6).toFixed(1))}` : v.toLocaleString('en-US'));
  const unit = d.high >= 1e6 ? ' million light-years' : ' light-years';
  return d.low === d.high ? `${fmt(d.low)}${unit}` : `${fmt(d.low)}–${fmt(d.high)}${unit}`;
}


/** What entering the local sector in the current galaxy would do. */
export function surveyNote(view: ProgressView): string {
  const sv = deriveSystemView(view, view.progress.current);
  const here = sv.current ? view.graph.system(sv.current) : undefined;
  if (!here) return '';
  const real = (s: { provenance: { status: string } }): string => (s.provenance.status === 'verified-object' ? ' (a real object)' : '');
  if (!view.charted.has(here.id)) return `You are at ${here.name}${real(here)}. Recording the survey marks in its sector charts it.`;
  const next = sv.suggestion();
  const target = next ? view.graph.system(next) : undefined;
  if (target) return `${here.name} is charted. Nearest uncharted system: ${target.name}${real(target)}. Travel there on the system map, or explore this sector.`;
  return `${here.name} is charted, and every system you can reach here is too. More open up as you chart key systems and complete milestones.`;
}

/* ------------------------------------------------------------ screen */

export function createGalaxyMap(deps: GalaxyMapDeps): GalaxyMapScreen {
  const { graph, services, scope } = deps;
  const art = new GalaxyArtCache();
  scope.add(() => art.clear());

  let visible = false;
  let view: ProgressView = deriveView(graph, deps.progress());
  let states = {} as Record<GalaxyId, NodeState>;
  let edgeStates = new Map<string, EdgeState>();
  let selected: GalaxyId = view.progress.current;
  let hovered: GalaxyId | null = null;
  let layout: MapLayout | null = null;
  let confirmTarget: GalaxyId | null = null;
  let travel: { from: GalaxyId; to: GalaxyId; start: number | null; dur: number } | null = null;
  let travelT = 0;
  let arrival: { start: number | null } | null = null;
  let arrivalT = 0;
  let draws = 0;

  /* ---------------------------------------------------------- DOM */
  const shell = createMapShell({
    scope,
    parent: deps.parent,
    services,
    label: 'Galaxy map',
    title: 'GALAXY MAP',
    back: { text: '◀ MENU', aria: 'Back to main menu', onClick: () => deps.exit(), menu: true },
    note: 'STYLISED CHART · NOT TO SCALE',
    hintKeys: 'ARROWS MOVE · ENTER ACTIONS · ESC BACK',
    hintTouch: 'TAP A GALAXY TO INSPECT IT',
    navLabel: 'Destinations',
    detailsId: 'fr-map-details',
    detailsLabel: 'Destination details',
    confirm: {
      titleId: 'fr-confirm-title',
      kicker: 'CONFIRM JUMP',
      note: deps.fuel ? 'A galaxy jump burns reactor cells. If you ever lack the cells for any open route, the Guild flies you back to the Milky Way for free.' : 'Prototype: jumps cost nothing yet and have no transit encounters; charge and risk take effect in a later update.',
      onEngage: () => engage(),
      onCancel: () => closeConfirm(true),
    },
  });
  const { root, back, sub, surface, nodesNav, details, detArt, detKicker, detName, detClass, detBody, detActions, actionMenu, confirmLayer, cTitle, cRoute, cStats, confirmMenu } = shell;

  const nodeButtons = new Map<GalaxyId, HTMLButtonElement>();
  for (const node of graph.nodes) {
    const b = el('button', 'fr-node');
    b.type = 'button';
    b.dataset['galaxy'] = node.id;
    b.setAttribute('aria-controls', details.id);
    b.append(el('span', 'fr-node-name', node.galaxy.shortName), el('span', 'fr-node-sub'));
    b.addEventListener('click', () => {
      if (travel) return;
      if (selected !== node.id) services.sound.play('uiMove');
      select(node.id);
      b.focus({ preventScroll: true }); // Safari does not focus buttons on click
    });
    b.addEventListener('focus', () => {
      if (!travel && selected !== node.id) select(node.id);
    });
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') hovered = node.id;
    });
    b.addEventListener('pointerleave', () => {
      if (hovered === node.id) hovered = null;
    });
    nodesNav.append(b);
    nodeButtons.set(node.id, b);
  }

  /* ---------------------------------------------------- rendering */
  const announce = (text: string): void => shell.announce(text);

  const course = (to: GalaxyId | null): Set<string> => {
    const out = new Set<string>();
    if (!to || to === view.progress.current) return out;
    const path = findPath(view, to);
    if (!path) return out;
    for (let i = 1; i < path.length; i++) {
      const e = graph.edgeBetween(path[i - 1]!, path[i]!);
      if (e) out.add(e.id);
    }
    return out;
  };

  const nodeSub = (id: GalaxyId): string => {
    const st = states[id];
    const pct = view.exploration(id).percent;
    if (st === 'current') return `HERE · ${pct}%`;
    if (st === 'locked') return 'LOCKED';
    if (st === 'available') return pct > 0 ? `GO · ${pct}%` : 'AVAILABLE';
    return `${pct}%`;
  };

  const refreshNodes = (): void => {
    for (const node of graph.nodes) {
      const b = nodeButtons.get(node.id)!;
      const st = states[node.id];
      b.dataset['state'] = st;
      b.setAttribute('aria-pressed', String(node.id === selected));
      if (st === 'current') b.setAttribute('aria-current', 'location');
      else b.removeAttribute('aria-current');
      const subText = nodeSub(node.id);
      const subEl = b.lastElementChild as HTMLElement;
      if (subEl.textContent !== subText) subEl.textContent = subText;
      const g = node.galaxy;
      b.setAttribute('aria-label', `${g.name}, ${CLASS_LABEL[g.morphology.class].toLowerCase()}. ${STATE_LABEL[st]}. ${view.exploration(node.id).percent}% explored.`);
    }
  };


  const renderDetails = (): void => {
    const node = graph.node(selected)!;
    const g = node.galaxy;
    const st = states[selected];
    const current = graph.node(view.progress.current)!.galaxy;
    details.dataset['state'] = st;
    const dctx = detArt.getContext('2d');
    if (dctx) {
      dctx.clearRect(0, 0, 48, 48);
      dctx.drawImage(art.get(g, 48, st === 'locked' ? 'mono' : 'color'), 0, 0);
    }
    detKicker.textContent = STATE_LABEL[st].toUpperCase();
    detName.textContent = g.name;
    detClass.textContent = `${CLASS_LABEL[g.morphology.class]}${g.morphology.code ? ` · ${g.morphology.code}` : ''}`;

    const body: HTMLElement[] = [el('p', 'fr-det-desc', g.description)];
    const ex = view.exploration(selected);
    const facts = el('dl', 'fr-det-facts');
    facts.append(el('dt', '', 'DISTANCE'), el('dd', '', formatDistance(g)), el('dt', '', 'EXPLORED'), el('dd', '', `${ex.percent}% · ${ex.charted} / ${ex.total} systems charted`));
    body.push(facts);
    const bar = el('div', 'fr-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', `${g.shortName} exploration`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(ex.percent));
    const fill = el('i', '');
    fill.style.width = `${ex.percent}%`;
    bar.append(fill);
    body.push(bar);

    const check = checkTravel(view, selected);
    if (st === 'current') {
      body.push(el('p', 'fr-det-note', surveyNote(view)));
    } else if (check.ok) {
      const r = check.edge.route;
      body.push(el('p', 'fr-det-note', `One jump from ${current.shortName}: ${r.name} · ${ROUTE_LABEL[r.routeClass]} · risk ${RISK_LABEL[r.risk].toLowerCase()}.`));
      if (deps.fuel) {
        const need = deps.fuel.jump(check.edge);
        const have = deps.fuel.held();
        const line = el('p', `fr-det-note${have < need ? ' fr-fuel-warn' : ''}`, `JUMP COST ${need} REACTOR CELLS · YOU HAVE ${have}${have < need ? '. Dock at a station for free emergency cells or buy cells at an exchange.' : ''}`);
        body.push(line);
      }
    } else if (check.reason === 'locked') {
      body.push(el('h3', 'fr-det-h', 'TO UNLOCK'), reqList(g.gameplay.unlock.map((req) => describeRequirement(view, req))));
      if (check.edge && !view.routeOpen(check.edge)) body.push(el('h3', 'fr-det-h', `ROUTE SEALED · ${check.edge.route.name.toUpperCase()}`), reqList(check.edge.route.unlock.map((req) => describeRequirement(view, req))));
    } else if (check.reason === 'sealed' && check.edge) {
      body.push(el('h3', 'fr-det-h', `ROUTE SEALED · ${check.edge.route.name.toUpperCase()}`), reqList(check.edge.route.unlock.map((req) => describeRequirement(view, req))));
    } else if (check.reason === 'no-route') {
      const path = findPath(view, selected);
      body.push(
        el(
          'p',
          'fr-det-note',
          path
            ? `No direct route from ${current.shortName}. Course: ${path.map((id) => graph.node(id)!.galaxy.shortName).join(' → ')} (${path.length - 1} jumps).`
            : `No direct route from ${current.shortName}, and no open course yet.`,
        ),
      );
    }

    const routes = el('ul', 'fr-route-list');
    for (const e of graph.edgesOf(selected)) {
      const other = graph.node(graph.other(e, selected))!.galaxy;
      const es = edgeStates.get(e.id) ?? 'locked';
      const li = el('li', 'fr-route');
      li.dataset['state'] = es;
      li.append(el('span', 'fr-route-to', `→ ${other.shortName}`), el('span', 'fr-route-meta', `${ROUTE_LABEL[e.route.routeClass]} · ${RISK_LABEL[e.route.risk]} risk`), el('span', 'fr-route-state', EDGE_LABEL[es].toUpperCase()));
      routes.append(li);
    }
    body.push(el('h3', 'fr-det-h', 'ROUTES'), routes);
    detBody.replaceChildren(...body);
    detBody.scrollTop = 0;

    const actions: HTMLButtonElement[] = [];
    if (st === 'current') {
      const m = button('fr-btn', 'SYSTEM MAP', () => deps.openSystems(selected));
      m.setAttribute('aria-label', `Open the ${g.shortName} system map`);
      actions.push(m, button('fr-btn', 'ENTER SECTOR', () => deps.startSurvey()));
      if (deps.fuel?.homeDue()) {
        body.push(el('p', 'fr-det-note fr-fuel-warn', `Too few reactor cells for any open route out of ${g.shortName}. The Guild flies you back to the Milky Way gateway for free; its station tops you up.`));
        detBody.replaceChildren(...body);
        actions.push(button('fr-btn fr-btn-sos', 'RETURN HOME · FREE', () => homeJump()));
      }
    } else {
      if (check.ok && deps.fuel && deps.fuel.held() < deps.fuel.jump(check.edge)) {
        // not enough cells: the cost line above explains the recovery; no dead TRAVEL button
      } else if (check.ok) {
        const t = button('fr-btn', 'TRAVEL HERE', () => openConfirm(selected));
        t.setAttribute('aria-label', `Travel to ${g.name}`);
        actions.push(t);
      }
      if (st !== 'locked') {
        const v = button('fr-btn', 'VIEW SYSTEMS', () => deps.openSystems(selected));
        v.setAttribute('aria-label', `View the ${g.shortName} system map`);
        actions.push(v);
      }
    }
    detActions.replaceChildren(...actions);
    detActions.hidden = actions.length === 0;
  };

  const refreshHeader = (): void => {
    const cur = graph.node(view.progress.current)!.galaxy;
    sub.textContent = `${cur.shortName.toUpperCase()} · LV ${view.explorerLevel} · ${view.charted.size} CHARTED`;
    sub.title = `Explorer level ${view.explorerLevel}, ${view.charted.size} systems charted`;
  };

  function refresh(): void {
    view = deriveView(graph, deps.progress());
    states = Object.fromEntries(graph.nodes.map((n) => [n.id, nodeState(view, n.id)])) as Record<GalaxyId, NodeState>;
    edgeStates = new Map(graph.edges.map((e) => [e.id, edgeState(view, e)]));
    refreshNodes();
    refreshHeader();
    renderDetails();
  }

  function select(id: GalaxyId, announceIt = true): void {
    selected = id;
    refreshNodes();
    renderDetails();
    if (announceIt) {
      const g = graph.node(id)!.galaxy;
      announce(`${g.name}. ${STATE_LABEL[states[id]]}.`);
    }
  }

  const focusNode = (id: GalaxyId): void => nodeButtons.get(id)?.focus({ preventScroll: true });
  const focusedNode = (): GalaxyId | null => {
    const a = document.activeElement;
    return a instanceof HTMLElement && a.classList.contains('fr-node') && nodesNav.contains(a) ? (a.dataset['galaxy'] as GalaxyId) : null;
  };

  /* -------------------------------------------------- confirm + travel */
  const setInert = (on: boolean): void => shell.setInert(on);

  function openConfirm(id: GalaxyId): void {
    const check = checkTravel(view, id);
    if (!check.ok) {
      announce('That destination cannot be reached from here.');
      return;
    }
    services.sound.play('uiSelect');
    confirmTarget = id;
    const from = graph.node(view.progress.current)!.galaxy;
    const to = graph.node(id)!.galaxy;
    const r = check.edge.route;
    cTitle.textContent = to.name.toUpperCase();
    cRoute.textContent = `${from.shortName} → ${to.shortName} via ${r.name}`;
    cStats.textContent = `${ROUTE_LABEL[r.routeClass].toUpperCase()} · RISK ${RISK_LABEL[r.risk].toUpperCase()} · ${deps.fuel ? `COST ${deps.fuel.jump(check.edge)} CELLS · YOU HAVE ${deps.fuel.held()}${deps.fuel.fee ? ` · ${deps.fuel.fee()}` : ''}` : `CHARGE ${r.cost}`}`;
    confirmLayer.hidden = false;
    root.dataset['confirm'] = 'open';
    setInert(true);
    confirmMenu.focus(0);
  }

  function closeConfirm(restoreFocus: boolean): void {
    if (confirmTarget === null) return;
    confirmTarget = null;
    confirmLayer.hidden = true;
    delete root.dataset['confirm'];
    setInert(false);
    if (restoreFocus) {
      services.sound.play('uiMove');
      actionMenu.focus(0);
    }
  }

  function engage(): void {
    const to = confirmTarget;
    if (to === null) return;
    const from = view.progress.current;
    const result = deps.travel(to);
    closeConfirm(false);
    if (!result.ok) {
      announce(result.reason === 'fuel' && 'need' in result ? `Jump cancelled: it needs ${result.need} reactor cells and the hold has ${result.have}.` : 'Jump cancelled: the route is not open.');
      refresh();
      focusNode(selected);
      return;
    }
    flyTo(from, to);
  }

  /** R3: the free return to the start galaxy. */
  function homeJump(): void {
    const from = view.progress.current;
    if (!deps.fuel || !deps.fuel.home()) {
      announce('Return unavailable.');
      refresh();
      return;
    }
    flyTo(from, graph.start);
  }

  function flyTo(from: GalaxyId, to: GalaxyId): void {
    services.sound.play('uiSelect');
    travel = { from, to, start: null, dur: deps.reducedMotion() ? 240 : 720 };
    travelT = 0;
    root.dataset['travel'] = 'on';
    nodesNav.inert = true;
    details.inert = true;
    announce(`Jumping to ${graph.node(to)!.galaxy.name}.`);
  }

  function finishTravel(): void {
    if (!travel) return;
    const to = travel.to;
    travel = null;
    delete root.dataset['travel'];
    nodesNav.inert = false;
    details.inert = false;
    refresh();
    select(to, false);
    focusNode(to);
    arrival = { start: null };
    services.sound.play('bonus');
    announce(`Arrived at ${graph.node(to)!.galaxy.name}.`);
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
    // a focused header control (◀ MENU, SAVES) or detail action: Enter / Space / A presses it
    const inHead = a instanceof HTMLElement && a !== shell.head && shell.head.contains(a);
    if (a instanceof HTMLElement && (details.contains(a) || a === back || inHead)) {
      if (c === 'back') {
        focusNode(selected);
        services.sound.play('uiMove');
      } else if (c === 'confirm') a.click();
      else if (details.contains(a) && actionMenu.buttons().length > 1 && (c === 'up' || c === 'down')) actionMenu.move(c === 'up' ? -1 : 1);
      else focusNode(selected);
      return;
    }
    if (c === 'back') {
      deps.exit();
      return;
    }
    if (c === 'confirm') {
      const id = focusedNode() ?? selected;
      if (id !== selected) select(id);
      if (actionMenu.buttons().length > 0) {
        services.sound.play('uiMove');
        actionMenu.focus(0);
      } else {
        const g = graph.node(id)!.galaxy;
        const check = checkTravel(view, id);
        announce(`${g.name} cannot be reached from here${!check.ok && check.reason === 'locked' ? ': it is locked' : ''}. See the details panel.`);
        focusNode(id);
      }
      return;
    }
    if (!layout) return;
    const from = focusedNode() ?? selected;
    const next = spatialNext(layout.nodes, from, c) as GalaxyId | null;
    if (next) {
      services.sound.play('uiMove');
      select(next);
      focusNode(next);
    } else focusNode(from);
  }

  /* ---------------------------------------------------------- frame */
  const placeNodes = (L: MapLayout): void => {
    root.dataset['orientation'] = L.orientation;
    root.dataset['compact'] = String(L.compact);
    for (const node of graph.nodes) {
      const b = nodeButtons.get(node.id)!;
      const box = nodeBox(L, node.id);
      b.style.left = `${box.left}px`;
      b.style.top = `${box.top}px`;
      b.style.width = `${box.width}px`;
      b.style.height = `${box.height}px`;
    }
  };

  function frame(ts: number): void {
    if (!visible) return;
    const b = surface.fit();
    const w = surface.css.width;
    const h = surface.css.height;
    if (!layout || Math.abs(layout.width - w) > 0.5 || Math.abs(layout.height - h) > 0.5) {
      layout = computeMapLayout(w, h);
      placeNodes(layout);
    }
    let anim: TravelAnim | null = null;
    if (travel) {
      travel.start ??= ts;
      travelT = Math.min(1, (ts - travel.start) / travel.dur);
      anim = { from: travel.from, to: travel.to, t: travelT };
    }
    let flash: number | null = null;
    if (arrival) {
      arrival.start ??= ts;
      arrivalT = Math.min(1, (ts - arrival.start) / (deps.reducedMotion() ? 200 : 420));
      flash = arrivalT;
      if (arrivalT >= 1) arrival = null;
    }
    drawGalaxyMap(
      surface.ctx,
      b.width,
      b.height,
      {
        graph,
        layout,
        nodeStates: states,
        edgeStates,
        current: travel ? travel.from : view.progress.current,
        selected: travel ? null : selected,
        hovered: travel ? null : hovered,
        highlight: travel ? new Set(graph.edgeBetween(travel.from, travel.to) ? [graph.edgeBetween(travel.from, travel.to)!.id] : []) : course(hovered ?? selected),
        travel: anim,
        arrival: flash,
      },
      art,
      { ratio: b.ratio, timeMs: ts, reducedMotion: deps.reducedMotion() },
    );
    draws += 1;
    if (travel && travelT >= 1) finishTravel();
  }

  return {
    root,
    head: shell.head,
    get visible() {
      return visible;
    },
    show() {
      visible = true;
      root.hidden = false;
      layout = null;
      refresh();
      select(view.progress.current, false);
      focusNode(selected);
    },
    hide() {
      visible = false;
      closeConfirm(false);
      if (travel) {
        travel = null; // progress was already committed; only the cosmetic animation is dropped
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
      return {
        visible,
        selected,
        focused: focusedNode(),
        hovered,
        current: view.progress.current,
        confirmOpen: confirmTarget !== null,
        transition: travel !== null,
        orientation: layout?.orientation ?? 'none',
        size: { w: layout?.width ?? 0, h: layout?.height ?? 0 },
        states: { ...states },
        draws,
      };
    },
  };
}

