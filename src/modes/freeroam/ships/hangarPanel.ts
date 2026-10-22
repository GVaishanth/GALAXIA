/**
 * Station hangar panel (Free Roam Prompt 8). DOM only: every rule comes from
 * hangar.ts (ownership, licence, price, safe switching) and every number from
 * roster.ts / equipment.ts. The shell opens it when the ship docks at a
 * station with no hostile engaged, and commits what it returns to the profile.
 *
 *  - The list shows every ship with its state (FLYING / OWNED / AVAILABLE /
 *    NEED CARGO / LOCKED). Focusing or clicking a ship inspects it: preview,
 *    appearance states, stats compared with the ship flown, fitted modules,
 *    licence and price.
 *  - ACQUIRE and SELECT both take two presses (the second press confirms and
 *    names the exact price or ship). Changing the inspected ship cancels a
 *    pending confirmation.
 *  - Unowned ships can never be selected (no SELECT button is offered and
 *    selectShip refuses); switching re-checks `safe()` at the moment of the
 *    confirmation.
 */
import type { SpriteId } from '../../../assets/sprites/index.ts';
import { drawFrame } from '../../../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../../../render/sprite/spriteCache.ts';
import type { Viewport } from '../../../render/viewport.ts';
import { MenuList } from '../../../shared/ui/menuList.ts';
import type { UnlockRequirement } from '../catalogue/types.ts';
import { EQUIPMENT_BY_ID } from './equipment.ts';
import { acquireShip, compareStats, formatStat, loadoutOf, missingFor, selectShip, shipStatus, type FleetState, type ShipStatus } from './hangar.ts';
import { SHIP_BY_ID, SHIPS } from './roster.ts';
import { SLOT_TYPES, type ShipId } from './types.ts';

export interface HangarDeps {
  readonly sprites: SpriteCache;
  readonly fleet: () => FleetState;
  readonly cargo: () => Readonly<Record<string, number>>;
  readonly licenceMet: (req: UnlockRequirement) => boolean;
  readonly describe: (req: UnlockRequirement) => { readonly detail: string; readonly met: boolean };
  /** Docked with no hostile engaged (re-checked when a switch is confirmed). */
  readonly safe: () => boolean;
  /** Commit an acquisition (fleet + the cargo after payment). */
  readonly commitAcquire: (fleet: FleetState, cargo: Readonly<Record<string, number>>, id: ShipId) => void;
  /** Commit a ship switch. */
  readonly commitSelect: (fleet: FleetState, id: ShipId) => void;
  readonly launch: () => void;
  /** Prompt 12: Back / ESC with nothing pending (the station overview); without it Back launches. */
  readonly back?: (() => void) | undefined;
  /** Open the station fabricator (Prompt 10; optional so the panel works without it). */
  readonly fabricator?: (() => void) | undefined;
  /** Prompt 11: more station services (missions, exchange, upgrades), shown after the fabricator. */
  readonly services?: readonly { readonly id: string; readonly label: string; readonly aria: string; readonly open: () => void }[] | undefined;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus' | 'pause') => void;
  readonly glow: () => boolean;
}

export interface HangarStatus {
  readonly inspected: ShipId;
  readonly pending: 'acquire' | 'select' | null;
  readonly statuses: Readonly<Record<ShipId, ShipStatus>>;
  readonly action: string;
  readonly message: string;
}

export interface HangarPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  /** Refresh for a docking at `station` and focus the ship flown (call once the panel is visible). */
  open(station: string): void;
  /** Back / ESC: cancel a pending confirmation first, else `back` (or launch). */
  back(): void;
  status(): HangarStatus;
}

const STATUS_TEXT: Readonly<Record<ShipStatus, string>> = { active: 'FLYING', owned: 'OWNED', available: 'AVAILABLE', unaffordable: 'NEED CARGO', locked: 'LOCKED' };
const label = (id: string): string => id.replace(/-/g, ' ').toUpperCase();
const costText = (cost: readonly { readonly resource: string; readonly amount: number }[]): string => cost.map((c) => `${label(c.resource)} ${c.amount}`).join(' + ');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Appearance states shown in the strip: sprite state, variant and an optional shield flare. */
const STRIP: readonly { readonly name: string; readonly state: 'idle' | 'thrust' | 'boost'; readonly scorched?: boolean; readonly flare?: boolean }[] = [
  { name: 'IDLE', state: 'idle' },
  { name: 'ENGINE', state: 'thrust' },
  { name: 'BOOST', state: 'boost' },
  { name: 'SHIELD', state: 'idle', flare: true },
  { name: 'DAMAGED', state: 'idle', scorched: true },
];

export function createHangarPanel(d: HangarDeps): HangarPanel {
  const root = el('section', 'fr-panel fr-panel-hangar');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Station hangar');
  root.hidden = true;
  const kicker = el('p', 'fr-kicker', 'STATION HANGAR');
  const title = el('h2', 'fr-title', 'HANGAR');
  const body = el('div', 'fr-hangar');
  const list = el('div', 'fr-hangar-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Ships');
  const detail = el('div', 'fr-hangar-detail');
  const preview = el('canvas', 'fr-hangar-preview');
  preview.setAttribute('role', 'img');
  const strip = el('canvas', 'fr-hangar-strip');
  strip.setAttribute('role', 'img');
  strip.setAttribute('aria-label', 'Appearance states: idle, engine, boost, shield impact and damaged');
  const name = el('h3', 'fr-hangar-name');
  const role = el('p', 'fr-hangar-role');
  const desc = el('p', 'fr-text fr-text-dim fr-hangar-desc');
  const state = el('p', 'fr-hangar-state');
  const stats = el('div', 'fr-hangar-stats');
  stats.setAttribute('role', 'table');
  stats.setAttribute('aria-label', 'Stats compared with the ship you fly');
  const slotsBox = el('ul', 'fr-hangar-slots');
  slotsBox.setAttribute('aria-label', 'Fitted equipment');
  const terms = el('ul', 'fr-hangar-terms');
  const message = el('p', 'fr-text fr-hangar-msg');
  message.setAttribute('role', 'status');
  const views = el('div', 'fr-hangar-views');
  views.append(preview, strip);
  detail.append(views, name, role, state, desc, stats, slotsBox, terms);
  body.append(list, detail);
  const menu = el('div', 'fr-menu fr-hangar-actions');
  const actionBtn = el('button', 'fr-btn fr-hangar-action', 'SELECT');
  actionBtn.type = 'button';
  const cancelBtn = el('button', 'fr-btn fr-hangar-cancel', 'CANCEL');
  cancelBtn.type = 'button';
  cancelBtn.hidden = true;
  const fabBtn = el('button', 'fr-btn fr-hangar-fab', 'FABRICATOR');
  fabBtn.type = 'button';
  fabBtn.hidden = !d.fabricator;
  fabBtn.setAttribute('aria-label', 'Fabricator: build modules from resources, fit stored modules, claim milestones');
  const launchBtn = el('button', 'fr-btn fr-hangar-launch', 'LAUNCH');
  launchBtn.type = 'button';
  const serviceBtns = (d.services ?? []).map((sv) => {
    const b = el('button', `fr-btn fr-hangar-svc fr-hangar-${sv.id}`, sv.label);
    b.type = 'button';
    b.dataset['service'] = sv.id;
    b.setAttribute('aria-label', sv.aria);
    b.addEventListener('click', () => sv.open());
    return b;
  });
  menu.append(actionBtn, cancelBtn, fabBtn, ...serviceBtns, launchBtn);
  root.append(kicker, title, body, message, menu);

  const shipButtons = new Map<ShipId, HTMLButtonElement>();
  for (const s of SHIPS) {
    const b = el('button', 'fr-hangar-ship');
    b.type = 'button';
    b.dataset['ship'] = s.id;
    b.append(el('span', 'fr-hangar-ship-name', s.name.toUpperCase()), el('span', 'fr-hangar-ship-role', s.role.toUpperCase()), el('span', 'fr-hangar-ship-state', ''));
    // focus (arrows, gamepad) and click both inspect; the list order is the menu order
    b.addEventListener('focus', () => inspect(s.id));
    b.addEventListener('click', () => inspect(s.id));
    list.append(b);
    shipButtons.set(s.id, b);
  }
  // the ship list and the actions form one roving menu (MenuList reads buttons live)
  const menuList = new MenuList(root, () => d.sound('uiMove'));

  let inspected: ShipId = d.fleet().active;
  let pending: 'acquire' | 'select' | null = null;

  const statusOf = (id: ShipId): ShipStatus => shipStatus(d.fleet(), id, d.licenceMet, d.cargo());

  const viewport = (w: number, h: number, scale: number): Viewport => ({ scale, offsetX: 0, offsetY: 0, deviceWidth: w, deviceHeight: h, artWidth: w / scale, artHeight: h / scale });
  const fitCanvas = (c: HTMLCanvasElement, cssW: number, cssH: number): { w: number; h: number; ratio: number } => {
    const ratio = Math.min(Math.max(1, Math.round(window.devicePixelRatio || 1)), 3);
    const w = cssW * ratio;
    const h = cssH * ratio;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return { w, h, ratio };
  };
  const drawPreview = (id: ShipId): void => {
    const ship = SHIP_BY_ID.get(id)!;
    const sprite = ship.sprite as SpriteId;
    const glow = d.glow();
    // main view: the ship at an integer scale (crisp pixels at any DPR)
    {
      const { w, h, ratio } = fitCanvas(preview, 168, 132);
      const c = preview.getContext('2d');
      if (c) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, w, h);
        const scale = 4 * ratio;
        drawFrame(c, d.sprites, d.sprites.frame(sprite, 'idle', 0), viewport(w, h, scale), w / 2 / scale, h / 2 / scale, { glow });
      }
      preview.setAttribute('aria-label', `${ship.name}, ${ship.role}: preview`);
    }
    // state strip: the same ship in each appearance state
    {
      const cell = 64;
      const { w, h, ratio } = fitCanvas(strip, cell * STRIP.length, 78);
      const c = strip.getContext('2d');
      if (!c) return;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, w, h);
      const scale = 2 * ratio;
      const v = viewport(w, h, scale);
      c.font = `${10 * ratio}px ui-monospace, Menlo, Consolas, monospace`;
      c.textAlign = 'center';
      c.textBaseline = 'bottom';
      STRIP.forEach((s, i) => {
        const cx = (i + 0.5) * cell * ratio;
        const cy = 34 * ratio;
        drawFrame(c, d.sprites, d.sprites.frame(sprite, s.state, 0, s.scorched ? 'scorched' : undefined), v, cx / scale, cy / scale, { glow });
        if (s.flare) drawFrame(c, d.sprites, d.sprites.frame('fx.shield.impact', 'flare', 1), v, cx / scale + ship.radius + 3, cy / scale, { rotation: Math.PI / 2, glow, zoom: Math.max(1, ship.radius / 12) });
        c.globalAlpha = 1;
        c.fillStyle = '#8f9bb8';
        c.fillText(s.name, cx, h - 2 * ratio);
      });
    }
  };

  const refreshList = (): void => {
    for (const [id, b] of shipButtons) {
      const st = statusOf(id);
      b.dataset['status'] = st;
      b.classList.toggle('is-inspected', id === inspected);
      b.setAttribute('aria-pressed', String(id === inspected));
      b.querySelector('.fr-hangar-ship-state')!.textContent = STATUS_TEXT[st];
      b.setAttribute('aria-label', `${SHIP_BY_ID.get(id)!.name}, ${SHIP_BY_ID.get(id)!.role}: ${STATUS_TEXT[st].toLowerCase()}`);
    }
  };

  const refreshDetail = (): void => {
    const f = d.fleet();
    const ship = SHIP_BY_ID.get(inspected)!;
    const st = statusOf(inspected);
    name.textContent = ship.name.toUpperCase();
    role.textContent = `${ship.role.toUpperCase()} · RADIUS ${ship.radius} · WEAPONS ${ship.weaponClasses.map((c) => c.toUpperCase()).join(' / ')}`;
    desc.textContent = ship.description;
    state.textContent = STATUS_TEXT[st];
    state.dataset['status'] = st;

    // stats vs the ship flown (bars: fuller = better; arrows mark better / worse)
    stats.replaceChildren();
    for (const row of compareStats(f, inspected)) {
      const r = el('div', 'fr-hangar-stat');
      r.setAttribute('role', 'row');
      const bar = el('span', 'fr-hangar-bar');
      const fill = el('span', 'fr-hangar-fill');
      fill.style.width = `${Math.round(row.fill * 100)}%`;
      bar.append(fill);
      const mark = row.delta > 0 ? '▲' : row.delta < 0 ? '▼' : '';
      const cmp = el('span', `fr-hangar-delta${row.delta > 0 ? ' is-better' : row.delta < 0 ? ' is-worse' : ''}`, mark);
      const value = el('span', 'fr-hangar-value', formatStat(row.key, row.value));
      const lab = el('span', 'fr-hangar-label', row.label);
      lab.setAttribute('role', 'rowheader');
      value.setAttribute('role', 'cell');
      r.setAttribute('aria-label', `${row.label} ${formatStat(row.key, row.value)}${row.delta ? `, ${row.delta > 0 ? 'better' : 'worse'} than your ${formatStat(row.key, row.current)}` : ''}`);
      r.append(lab, bar, value, cmp);
      stats.append(r);
    }

    // fitted modules per slot (stock for ships not owned yet)
    slotsBox.replaceChildren();
    const lo = loadoutOf(f, inspected);
    for (const slot of SLOT_TYPES) {
      const n = ship.slots[slot];
      for (let i = 0; i < n; i++) {
        const item = lo[slot][i] ? EQUIPMENT_BY_ID.get(lo[slot][i]!) : undefined;
        const li = el('li', 'fr-hangar-slot');
        li.append(el('span', 'fr-hangar-slot-type', slot.toUpperCase()), el('span', 'fr-hangar-slot-item', item ? item.name : '— empty'));
        if (item) li.title = item.description;
        slotsBox.append(li);
      }
    }

    // licence and price (only for ships not owned)
    terms.replaceChildren();
    terms.hidden = st === 'active' || st === 'owned';
    if (!terms.hidden) {
      for (const req of ship.licence) {
        const info = d.describe(req);
        const li = el('li', `fr-hangar-term${info.met ? ' is-met' : ''}`, `${info.met ? '✓' : '✗'} LICENCE · ${info.detail}`);
        terms.append(li);
      }
      const missing = new Map(missingFor(ship.cost, d.cargo()).map((c) => [c.resource, c.amount]));
      for (const c of ship.cost) {
        const have = d.cargo()[c.resource] ?? 0;
        const ok = !missing.has(c.resource);
        terms.append(el('li', `fr-hangar-term${ok ? ' is-met' : ''}`, `${ok ? '✓' : '✗'} ${label(c.resource)} ${c.amount} · IN HOLD ${have}`));
      }
    }

    // the one contextual action
    cancelBtn.hidden = pending === null;
    actionBtn.hidden = st === 'active';
    actionBtn.disabled = st === 'locked' || st === 'unaffordable';
    if (st === 'owned') actionBtn.textContent = pending === 'select' ? `CONFIRM · FLY THE ${ship.name.toUpperCase()}` : 'SELECT SHIP';
    else if (st === 'available') actionBtn.textContent = pending === 'acquire' ? `CONFIRM · PAY ${costText(ship.cost)}` : `ACQUIRE · ${costText(ship.cost)}`;
    else if (st === 'unaffordable') actionBtn.textContent = 'NOT ENOUGH CARGO';
    else if (st === 'locked') actionBtn.textContent = 'LICENCE REQUIRED';
    actionBtn.setAttribute('aria-label', actionBtn.textContent ?? '');
  };

  const refresh = (): void => {
    refreshList();
    refreshDetail();
    drawPreview(inspected);
  };

  function inspect(id: ShipId): void {
    if (id === inspected) return;
    inspected = id;
    pending = null;
    message.textContent = '';
    refresh();
  }

  actionBtn.addEventListener('click', () => {
    const st = statusOf(inspected);
    const ship = SHIP_BY_ID.get(inspected)!;
    if (st === 'available') {
      if (pending !== 'acquire') {
        pending = 'acquire';
        message.textContent = `Press again to pay ${costText(ship.cost)} from the hold.`;
        d.sound('uiMove');
        refresh();
        actionBtn.focus();
        return;
      }
      const r = acquireShip(d.fleet(), d.cargo(), inspected, d.licenceMet);
      pending = null;
      if (r.ok) {
        d.commitAcquire(r.fleet, r.cargo, inspected);
        d.sound('bonus');
        message.textContent = `${ship.name} acquired. Select it to fly it.`;
      } else message.textContent = r.reason === 'unaffordable' ? 'Not enough cargo.' : r.reason === 'locked' ? 'The licence is not met.' : 'Already owned.';
    } else if (st === 'owned') {
      if (pending !== 'select') {
        pending = 'select';
        message.textContent = `Press again to switch to the ${ship.name}. Its hull, shield and energy start full.`;
        d.sound('uiMove');
        refresh();
        actionBtn.focus();
        return;
      }
      const r = selectShip(d.fleet(), inspected, d.safe());
      pending = null;
      if (r.ok) {
        d.commitSelect(r.fleet, inspected);
        d.sound('uiSelect');
        message.textContent = `Now flying the ${ship.name}.`;
      } else message.textContent = r.reason === 'unsafe' ? 'Ships can only be switched while docked with no hostiles engaged.' : 'That ship cannot be selected.';
    }
    refresh();
    // keep focus on a live control (the action may have hidden itself)
    if (actionBtn.hidden || actionBtn.disabled) launchBtn.focus();
    else actionBtn.focus();
  });
  cancelBtn.addEventListener('click', () => {
    pending = null;
    message.textContent = 'Cancelled.';
    d.sound('uiMove');
    refresh();
    actionBtn.focus();
  });
  launchBtn.addEventListener('click', () => d.launch());
  fabBtn.addEventListener('click', () => d.fabricator?.());

  return {
    root,
    menu: menuList,
    open(station: string) {
      inspected = d.fleet().active;
      pending = null;
      kicker.textContent = `STATION HANGAR · ${station.toUpperCase()}`;
      message.textContent = 'Docked: hull, shield and energy restored. Inspect, acquire or switch ships here.';
      refresh();
      // call after the panel is shown: focus lands on the ship flown (focus inspects, so it must be this one)
      shipButtons.get(inspected)?.focus({ preventScroll: true });
    },
    back() {
      if (pending) {
        pending = null;
        message.textContent = 'Cancelled.';
        refresh();
        actionBtn.focus();
      } else if (d.back) d.back();
      else d.launch();
    },
    status() {
      const statuses = {} as Record<ShipId, ShipStatus>;
      for (const s of SHIPS) statuses[s.id] = statusOf(s.id);
      return { inspected, pending, statuses, action: actionBtn.hidden ? '' : (actionBtn.textContent ?? ''), message: message.textContent ?? '' };
    },
  };
}
