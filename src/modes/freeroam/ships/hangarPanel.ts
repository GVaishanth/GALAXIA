/**
 * Station hangar (Free Roam Prompt 8; production layout P03A, FR-TD-87).
 * DOM only: every rule comes from hangar.ts (ownership, licence, price, safe
 * switching), every number from roster.ts / equipment.ts / upgrades.ts
 * through the view model (hangarView.ts). The shell opens it as the HANGAR
 * tab of a docked station and commits what it returns to the profile.
 *
 * Layout: header (back to the station overview, title, fleet line), the
 * catalogue (filters, sort, one card per roster ship with its real sprite),
 * the bay (a large animated preview drawn with the game's sprite renderer),
 * the info panel (performance with an optional comparison, armament, fit,
 * licence and price) and the action bar (SELECT / ACQUIRE with confirmation,
 * CANCEL, LAUNCH).
 *
 *  - Focusing or clicking a card inspects that ship; inspecting never
 *    changes the fleet. Only SELECT (two presses) switches the flown ship,
 *    and selectShip refuses unowned ships and unsafe moments, so a locked or
 *    unowned ship can never be selected or launched, whatever the UI state.
 *  - The preview animates from the shell's frame loop (frame(ts)): no timer,
 *    no animation loop of its own, nothing runs while the panel is hidden.
 *    Reduced motion draws one still frame per change.
 *  - Filter, sort, comparison and the inspected ship are panel state and are
 *    never saved; opening the hangar starts from the ship flown.
 */
import type { SpriteId } from '../../../assets/sprites/index.ts';
import { FLEET_FLAME_ROWS } from '../../../assets/sprites/fleet.ts';
import { drawFrame } from '../../../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../../../render/sprite/spriteCache.ts';
import type { Viewport } from '../../../render/viewport.ts';
import { MenuList } from '../../../shared/ui/menuList.ts';
import type { UnlockRequirement } from '../catalogue/types.ts';
import { MISSILE } from '../combat/playerMissile.ts';
import { WEAPON_BY_ID } from '../../../config/weapons.ts';
import { compatibleWeapons, setupOf } from './armory.ts';
import { EQUIPMENT_BY_ID } from './equipment.ts';
import { acquireShip, formatStat, loadoutOf, missingFor, selectShip, type FleetState, type ShipStatus } from './hangar.ts';
import {
  catalogue,
  FILTER_LABEL,
  filterCounts,
  HANGAR_FILTERS,
  nextCompare,
  nextSort,
  pilotSkill,
  resolveCompare,
  shipAsFlown,
  SORT_LABEL,
  statRows,
  statusOf,
  weaponSummary,
  yardHighlights,
  type HangarContext,
  type HangarFilter,
  type HangarSort,
} from './hangarView.ts';
import { SHIP_BY_ID, SHIPS } from './roster.ts';
import { SLOT_TYPES, type ShipId } from './types.ts';
import type { UpgradeLevels } from './upgrades.ts';

export interface HangarDeps {
  readonly sprites: SpriteCache;
  readonly fleet: () => FleetState;
  readonly cargo: () => Readonly<Record<string, number>>;
  readonly licenceMet: (req: UnlockRequirement) => boolean;
  /** Licence wording and real progress (galaxy/progress.ts describeRequirement). */
  readonly describe: (req: UnlockRequirement) => { readonly title?: string; readonly detail: string; readonly met: boolean; readonly progress?: string | null };
  /** Installed upgrade levels per ship (the flown craft is built with them; without it: none). */
  readonly levels?: ((id: ShipId) => UpgradeLevels) | undefined;
  /** Docked with no hostile engaged (re-checked when a switch is confirmed). */
  readonly safe: () => boolean;
  /** Commit an acquisition (fleet + the cargo after payment). */
  readonly commitAcquire: (fleet: FleetState, cargo: Readonly<Record<string, number>>, id: ShipId) => void;
  /** Commit a ship switch. */
  readonly commitSelect: (fleet: FleetState, id: ShipId) => void;
  readonly launch: () => void;
  /** Prompt 12: Back / ESC with nothing pending (the station overview); without it Back launches. */
  readonly back?: (() => void) | undefined;
  /** Combat P03B: open the armory for the ship flown (the button shows only while inspecting it). */
  readonly armory?: (() => void) | undefined;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus' | 'pause') => void;
  readonly glow: () => boolean;
  /** OS or game reduced-motion setting: the preview stays still. */
  readonly reducedMotion?: (() => boolean) | undefined;
  /** P04: ships usable only through an active Admin Access session (not owned); labelled ADMIN so they never read as owned. */
  readonly adminOnly?: (() => ReadonlySet<ShipId>) | undefined;
  /** Economy pass: the Guild marks balance, already formatted by the wallet (e.g. "◈ 1,240 MARKS"). Ships cost cargo, never marks. */
  readonly balance?: (() => string) | undefined;
}

export interface HangarStatus {
  readonly inspected: ShipId;
  readonly pending: 'acquire' | 'select' | null;
  readonly statuses: Readonly<Record<ShipId, ShipStatus>>;
  readonly action: string;
  /** P03B: the armory button is offered (the flown ship is inspected). */
  readonly armory: boolean;
  readonly message: string;
  /** P03A: transient view state (never saved). */
  readonly filter: HangarFilter;
  readonly sort: HangarSort;
  readonly compare: ShipId | null;
  /** Visible catalogue entries, in display order. */
  readonly visible: readonly ShipId[];
  /** Preview diagnostics: the ship drawn last, draws so far, whether a transition is running. */
  readonly preview: { readonly ship: ShipId | null; readonly draws: number; readonly transition: boolean };
}

export interface HangarPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  /** Refresh for a docking at `station` and focus the ship flown (call once the panel is visible). */
  open(station: string): void;
  /** Back / ESC: cancel a pending confirmation first, else `back` (or launch). */
  back(): void;
  /** Shell frame loop: animates the preview while the panel is visible (a no-op when hidden). */
  frame(ts: number): void;
  status(): HangarStatus;
}

const STATUS_TEXT: Readonly<Record<ShipStatus, string>> = { active: 'FLYING', owned: 'OWNED', available: 'AVAILABLE', unaffordable: 'NEED CARGO', locked: 'LOCKED' };
/** Longer state line for the inspected ship (text, never colour alone). */
const STATE_LINE: Readonly<Record<ShipStatus, string>> = {
  active: 'FLYING · YOUR SELECTED SHIP',
  owned: 'OWNED · READY TO SELECT',
  available: 'FOR SALE · LICENCE MET',
  unaffordable: 'FOR SALE · NOT ENOUGH CARGO',
  locked: 'LOCKED · LICENCE REQUIRED',
};
const label = (id: string): string => id.replace(/-/g, ' ').toUpperCase();
const costText = (cost: readonly { readonly resource: string; readonly amount: number }[]): string => cost.map((c) => `${label(c.resource)} ${c.amount}`).join(' + ');
const trimNum = (v: number, d = 1): string => (Number.isInteger(v) ? String(v) : v.toFixed(d));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const SVG = 'http://www.w3.org/2000/svg';
/** Status glyph: a shape per state, so the state reads without colour. */
function statusIcon(st: ShipStatus): Element {
  if (st === 'locked') {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 10 12');
    s.setAttribute('class', 'fr-hangar-ico');
    s.setAttribute('aria-hidden', 'true');
    const body = document.createElementNS(SVG, 'rect');
    for (const [k, v] of Object.entries({ x: '1', y: '5', width: '8', height: '6.5', rx: '1' })) body.setAttribute(k, v);
    body.setAttribute('fill', 'currentColor');
    const shackle = document.createElementNS(SVG, 'path');
    shackle.setAttribute('d', 'M3 5V3.5a2 2 0 0 1 4 0V5');
    shackle.setAttribute('fill', 'none');
    shackle.setAttribute('stroke', 'currentColor');
    shackle.setAttribute('stroke-width', '1.4');
    s.append(body, shackle);
    return s;
  }
  const glyph = { active: '►', owned: '✓', available: '◇', unaffordable: '◇' }[st];
  const sp = el('span', 'fr-hangar-ico', glyph);
  sp.setAttribute('aria-hidden', 'true');
  return sp;
}

/** Appearance states shown in the strip: sprite state, variant and an optional shield flare. */
const STRIP: readonly { readonly name: string; readonly state: 'idle' | 'thrust' | 'boost'; readonly scorched?: boolean; readonly flare?: boolean }[] = [
  { name: 'IDLE', state: 'idle' },
  { name: 'ENGINE', state: 'thrust' },
  { name: 'BOOST', state: 'boost' },
  { name: 'SHIELD', state: 'idle', flare: true },
  { name: 'DAMAGED', state: 'idle', scorched: true },
];

/** Preview cross-fade length (ms) and the frame interval while animating (~30 fps is plenty for a hover). */
const TRANSITION_MS = 220;
const FRAME_MS = 33;

export function createHangarPanel(d: HangarDeps): HangarPanel {
  const ctx = (): HangarContext => ({ fleet: d.fleet(), cargo: d.cargo(), licenceMet: d.licenceMet, levels: d.levels ?? (() => ({})) });
  const reduced = (): boolean => d.reducedMotion?.() ?? false;
  const NO_ADMIN: ReadonlySet<ShipId> = new Set();
  const adminOnly = (): ReadonlySet<ShipId> => d.adminOnly?.() ?? NO_ADMIN;
  /** Card / badge text: an admin-access ship never reads as OWNED. */
  const statusText = (id: ShipId, st: ShipStatus): string => (st === 'owned' && adminOnly().has(id) ? 'ADMIN' : STATUS_TEXT[st]);

  const root = el('section', 'fr-panel fr-panel-hangar');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Station hangar');
  root.hidden = true;

  /* header */
  const head = el('header', 'fr-hangar-head');
  const backBtn = el('button', 'fr-hangar-back', '◀ STATION');
  backBtn.type = 'button';
  backBtn.setAttribute('aria-label', 'Back to the station overview');
  backBtn.hidden = !d.back;
  const titles = el('div', 'fr-hangar-titles');
  const kicker = el('p', 'fr-kicker', 'STATION HANGAR');
  const title = el('h2', 'fr-title', 'HANGAR');
  const sub = el('p', 'fr-hangar-sub', 'Inspect the yard, compare ships and choose the one you launch in.');
  titles.append(kicker, title, sub);
  const fleetLine = el('p', 'fr-hangar-fleet');
  const wallet = el('p', 'fr-wallet');
  wallet.setAttribute('aria-label', 'Guild marks balance');
  wallet.hidden = !d.balance;
  const side = el('div', 'fr-head-side');
  side.append(fleetLine, wallet);
  head.append(backBtn, titles, side);

  /* bay: the large preview, identity and appearance states */
  const bay = el('section', 'fr-hangar-bay');
  bay.setAttribute('aria-label', 'Selected ship preview');
  const stage = el('div', 'fr-hangar-stage');
  const preview = el('canvas', 'fr-hangar-preview');
  preview.setAttribute('role', 'img');
  const badge = el('p', 'fr-hangar-badge');
  stage.append(preview, badge);
  const ident = el('div', 'fr-hangar-ident');
  const name = el('h3', 'fr-hangar-name');
  const role = el('p', 'fr-hangar-role');
  const state = el('p', 'fr-hangar-state');
  ident.append(name, role, state);
  const strip = el('canvas', 'fr-hangar-strip');
  strip.setAttribute('role', 'img');
  strip.setAttribute('aria-label', 'Appearance states: idle, engine, boost, shield impact and damaged');
  bay.append(stage, ident, strip);

  /* catalogue */
  const cat = el('section', 'fr-hangar-catalog');
  cat.setAttribute('aria-label', 'Ship catalogue');
  const tools = el('div', 'fr-hangar-tools');
  const filters = el('div', 'fr-hangar-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter ships');
  const filterBtns = new Map<HangarFilter, HTMLButtonElement>();
  for (const f of HANGAR_FILTERS) {
    const b = el('button', 'fr-hangar-filter');
    b.type = 'button';
    b.dataset['filter'] = f;
    b.append(el('span', 'fr-hangar-filter-name', FILTER_LABEL[f]), el('span', 'fr-hangar-filter-count', ''));
    b.addEventListener('click', () => setFilter(f));
    filters.append(b);
    filterBtns.set(f, b);
  }
  const sortBtn = el('button', 'fr-hangar-sort');
  sortBtn.type = 'button';
  sortBtn.addEventListener('click', () => setSort(nextSort(sort)));
  tools.append(filters, sortBtn);
  const list = el('div', 'fr-hangar-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Ships');
  const empty = el('p', 'fr-text fr-text-dim fr-hangar-empty', 'No ships in this group.');
  empty.hidden = true;
  cat.append(tools, list, empty);

  /* info */
  const detail = el('section', 'fr-hangar-detail');
  detail.setAttribute('aria-label', 'Ship details');
  const desc = el('p', 'fr-text fr-text-dim fr-hangar-desc');
  const highs = el('ul', 'fr-hangar-highs');
  highs.setAttribute('aria-label', 'Strengths');
  const perfHead = el('div', 'fr-hangar-sec-head');
  const vsBtn = el('button', 'fr-hangar-vs');
  vsBtn.type = 'button';
  vsBtn.addEventListener('click', () => {
    compareChoice = nextCompare(ctx(), inspected, resolveCompare(ctx(), inspected, compareChoice));
    d.sound('uiMove');
    refreshDetail();
  });
  perfHead.append(el('h4', 'fr-hangar-sec', 'PERFORMANCE'), vsBtn);
  const legend = el('p', 'fr-hangar-legend');
  const stats = el('div', 'fr-hangar-stats');
  stats.setAttribute('role', 'table');
  const arms = el('div', 'fr-hangar-kvs');
  arms.setAttribute('aria-label', 'Armament');
  const fitHead = el('h4', 'fr-hangar-sec', 'FITTED');
  const slotsBox = el('ul', 'fr-hangar-slots');
  slotsBox.setAttribute('aria-label', 'Fitted equipment');
  const termsHead = el('h4', 'fr-hangar-sec', 'ACQUISITION');
  const terms = el('ul', 'fr-hangar-terms');
  detail.append(desc, highs, perfHead, legend, stats, el('h4', 'fr-hangar-sec', 'ARMAMENT'), arms, fitHead, slotsBox, termsHead, terms);

  const body = el('div', 'fr-hangar');
  body.append(bay, cat, detail);

  /* action bar */
  const foot = el('footer', 'fr-hangar-foot');
  const message = el('p', 'fr-text fr-hangar-msg');
  message.setAttribute('role', 'status');
  const menu = el('div', 'fr-menu fr-hangar-actions');
  const actionBtn = el('button', 'fr-btn fr-hangar-action', 'SELECT');
  actionBtn.type = 'button';
  const cancelBtn = el('button', 'fr-btn fr-hangar-cancel', 'CANCEL');
  cancelBtn.type = 'button';
  cancelBtn.hidden = true;
  const launchBtn = el('button', 'fr-btn fr-hangar-launch', 'LAUNCH');
  launchBtn.type = 'button';
  const armoryBtn = el('button', 'fr-btn fr-hangar-armory', 'ARMORY ▸');
  armoryBtn.type = 'button';
  armoryBtn.hidden = true;
  menu.append(actionBtn, cancelBtn, armoryBtn, launchBtn);
  foot.append(message, menu);
  root.append(head, body, foot);

  /* cards */
  const cards = new Map<ShipId, { readonly btn: HTMLButtonElement; readonly thumb: HTMLCanvasElement; readonly state: HTMLElement }>();
  for (const s of SHIPS) {
    const b = el('button', 'fr-hangar-ship');
    b.type = 'button';
    b.dataset['ship'] = s.id;
    const thumb = el('canvas', 'fr-hangar-thumb');
    thumb.setAttribute('aria-hidden', 'true');
    const text = el('span', 'fr-hangar-ship-text');
    const top = yardHighlights(s.id)[0];
    text.append(el('span', 'fr-hangar-ship-name', s.name.toUpperCase()), el('span', 'fr-hangar-ship-role', s.role.toUpperCase()));
    if (top) text.append(el('span', 'fr-hangar-ship-chip', top.short));
    const st = el('span', 'fr-hangar-ship-state', '');
    text.append(st);
    b.append(thumb, text);
    // focus (arrows, gamepad, Tab) and click both inspect; a keyboard activation of the inspected card moves on to its action
    b.addEventListener('focus', () => inspect(s.id));
    b.addEventListener('click', (e) => {
      const was = inspected === s.id;
      inspect(s.id);
      if (was && e.detail === 0 && !actionBtn.hidden && !actionBtn.disabled) actionBtn.focus();
    });
    list.append(b);
    cards.set(s.id, { btn: b, thumb, state: st });
  }
  // the whole panel is one roving menu (MenuList reads the buttons live, in DOM order)
  const menuList = new MenuList(root, () => d.sound('uiMove'));

  let inspected: ShipId = d.fleet().active;
  let pending: 'acquire' | 'select' | null = null;
  let filter: HangarFilter = 'all';
  let sort: HangarSort = 'roster';
  /** undefined = automatic (the ship flown); null = no comparison. */
  let compareChoice: ShipId | null | undefined;
  let visible: ShipId[] = SHIPS.map((s) => s.id);

  /* --------------------------------------------------------- canvases */
  const viewport = (w: number, h: number, scale: number): Viewport => ({ scale, offsetX: 0, offsetY: 0, deviceWidth: w, deviceHeight: h, artWidth: w / scale, artHeight: h / scale });
  const dpr = (): number => Math.min(Math.max(1, Math.round(window.devicePixelRatio || 1)), 3);
  const fitCanvas = (c: HTMLCanvasElement, cssW: number, cssH: number): { w: number; h: number; ratio: number } => {
    const ratio = dpr();
    const w = Math.max(1, Math.round(cssW * ratio));
    const h = Math.max(1, Math.round(cssH * ratio));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return { w, h, ratio };
  };
  const spriteOf = (id: ShipId): SpriteId => SHIP_BY_ID.get(id)!.sprite as SpriteId;

  const drawThumbs = (): void => {
    const glow = d.glow();
    for (const [id, c] of cards) {
      const { w, h } = fitCanvas(c.thumb, c.thumb.clientWidth || 52, c.thumb.clientHeight || 52);
      const g = c.thumb.getContext('2d');
      if (!g) continue;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, h);
      const fr = d.sprites.frame(spriteOf(id), 'idle', 0);
      const fw = fr.raster.sprite.width;
      const fh = fr.raster.sprite.height;
      // the idle frame carries blank flame rows above and below the hull: size the hull itself
      const scale = Math.max(1, Math.floor(Math.min(w / fw, h / Math.max(1, fh - 2 * FLEET_FLAME_ROWS))));
      drawFrame(g, d.sprites, fr, viewport(w, h, scale), w / 2 / scale, h / 2 / scale, { glow });
    }
  };

  const drawStrip = (id: ShipId): void => {
    const ship = SHIP_BY_ID.get(id)!;
    const sprite = spriteOf(id);
    const glow = d.glow();
    const cell = 64;
    const { w, h, ratio } = fitCanvas(strip, cell * STRIP.length, 70);
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
      const cy = 30 * ratio;
      drawFrame(c, d.sprites, d.sprites.frame(sprite, s.state, 0, s.scorched ? 'scorched' : undefined), v, cx / scale, cy / scale, { glow });
      if (s.flare) drawFrame(c, d.sprites, d.sprites.frame('fx.shield.impact', 'flare', 1), v, cx / scale + ship.radius + 3, cy / scale, { rotation: Math.PI / 2, glow, zoom: Math.max(1, ship.radius / 12) });
      c.globalAlpha = 1;
      c.fillStyle = '#8f9bb8';
      c.fillText(s.name, cx, h - 2 * ratio);
    });
  };

  /* the bay: one draw per call; frame() decides when */
  const bayState = { from: null as ShipId | null, t0: 0, lastDraw: -Infinity, dirty: true, cssW: 0, cssH: 0, draws: 0, drawn: null as ShipId | null };
  const drawBay = (ts: number): void => {
    const cssW = preview.clientWidth || 320;
    const cssH = preview.clientHeight || 200;
    const { w: W, h: H, ratio: r } = fitCanvas(preview, cssW, cssH);
    const c = preview.getContext('2d');
    if (!c) return;
    const still = reduced();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.clearRect(0, 0, W, H);
    // backdrop: hangar volume, a soft overhead light and a perspective deck
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b1022');
    bg.addColorStop(0.6, '#070a17');
    bg.addColorStop(1, '#04050b');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);
    const light = c.createRadialGradient(W / 2, -H * 0.15, 0, W / 2, -H * 0.15, H * 1.1);
    light.addColorStop(0, 'rgba(92, 239, 255, 0.13)');
    light.addColorStop(1, 'rgba(92, 239, 255, 0)');
    c.fillStyle = light;
    c.fillRect(0, 0, W, H);
    const horizon = Math.round(H * 0.64);
    c.lineWidth = Math.max(1, r);
    c.strokeStyle = 'rgba(92, 239, 255, 0.07)';
    c.beginPath();
    for (let i = 0; i <= 7; i++) {
      const y = Math.round(horizon + (H - horizon) * (i / 7) ** 1.7) + 0.5;
      c.moveTo(0, y);
      c.lineTo(W, y);
    }
    for (let j = -7; j <= 7; j++) {
      c.moveTo(W / 2 + j * W * 0.035, horizon);
      c.lineTo(W / 2 + j * W * 0.2, H);
    }
    c.stroke();
    // docking pad
    const padY = horizon + (H - horizon) * 0.3;
    const rx = Math.min(W * 0.3, H * 0.62);
    const ry = rx * 0.2;
    c.fillStyle = 'rgba(92, 239, 255, 0.05)';
    c.beginPath();
    c.ellipse(W / 2, padY, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
    c.setLineDash([6 * r, 5 * r]);
    c.lineDashOffset = still ? 0 : -(ts / 60) * r;
    c.strokeStyle = 'rgba(92, 239, 255, 0.3)';
    c.stroke();
    c.setLineDash([]);
    c.strokeStyle = 'rgba(92, 239, 255, 0.12)';
    c.beginPath();
    c.ellipse(W / 2, padY, rx * 0.66, ry * 0.66, 0, 0, Math.PI * 2);
    c.stroke();
    // frame corners
    const inset = 8 * r;
    const len = 14 * r;
    c.strokeStyle = 'rgba(92, 239, 255, 0.35)';
    c.beginPath();
    for (const [x, y, sx, sy] of [[inset, inset, 1, 1], [W - inset, inset, -1, 1], [inset, H - inset, 1, -1], [W - inset, H - inset, -1, -1]] as const) {
      c.moveTo(x, y + sy * len);
      c.lineTo(x, y);
      c.lineTo(x + sx * len, y);
    }
    c.stroke();

    // ships: the new one rises in, the previous one sinks out (one cross-fade at a time)
    const k = still || bayState.from === null ? 1 : Math.min(1, (ts - bayState.t0) / TRANSITION_MS);
    const ease = 1 - (1 - k) ** 3;
    const bob = still ? 0 : Math.sin((ts / 3200) * Math.PI * 2) * 2 * r;
    const drawShip = (id: ShipId, alpha: number, dy: number): void => {
      if (alpha <= 0.01) return;
      const sprite = spriteOf(id);
      const fr = still ? d.sprites.frame(sprite, 'idle', 0) : d.sprites.frame(sprite, 'thrust', Math.floor(ts / 150) % 2);
      const fw = fr.raster.sprite.width;
      const fh = fr.raster.sprite.height;
      const scale = Math.max(1, Math.floor(Math.min((W * 0.42) / fw, (H * 0.6) / fh)));
      const cy = padY - fh * scale * 0.5 + dy;
      // contact shadow on the pad (smaller as the ship lifts)
      c.globalAlpha = alpha * 0.55;
      c.fillStyle = '#000';
      c.beginPath();
      c.ellipse(W / 2, padY, fw * scale * 0.38 * (1 - bob / (40 * r)), ry * 0.45, 0, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
      const locked = statusOf(ctx(), id) === 'locked';
      if (locked) c.filter = 'grayscale(1) brightness(0.62)';
      drawFrame(c, d.sprites, fr, viewport(W, H, scale), W / 2 / scale, (cy - bob) / scale, { glow: d.glow(), alpha: locked ? alpha * 0.85 : alpha });
      if (locked) c.filter = 'none';
    };
    if (bayState.from && k < 1) drawShip(bayState.from, 1 - ease, ease * 10 * r);
    drawShip(inspected, ease, (1 - ease) * 12 * r);
    c.globalAlpha = 1;
    if (k >= 1) bayState.from = null;
    bayState.lastDraw = ts;
    bayState.dirty = false;
    bayState.cssW = cssW;
    bayState.cssH = cssH;
    bayState.draws += 1;
    bayState.drawn = inspected;
  };

  /* ---------------------------------------------------------- refresh */
  const refreshList = (): void => {
    const cx = ctx();
    const counts = filterCounts(cx);
    for (const [f, b] of filterBtns) {
      b.setAttribute('aria-pressed', String(f === filter));
      b.querySelector('.fr-hangar-filter-count')!.textContent = String(counts[f]);
      b.setAttribute('aria-label', `Show ${f === 'all' ? 'all ships' : FILTER_LABEL[f].toLowerCase() + ' ships'}: ${counts[f]}`);
    }
    sortBtn.textContent = `SORT · ${SORT_LABEL[sort]}`;
    sortBtn.setAttribute('aria-label', `Sort ships by ${SORT_LABEL[sort].toLowerCase()}; press to change`);
    visible = catalogue(cx, filter, sort);
    // display order = DOM order, so arrow keys follow what the player sees
    for (const id of visible) list.append(cards.get(id)!.btn);
    for (const [id, c] of cards) {
      const st = statusOf(cx, id);
      const ship = SHIP_BY_ID.get(id)!;
      c.btn.hidden = !visible.includes(id);
      c.btn.dataset['status'] = st;
      c.btn.classList.toggle('is-inspected', id === inspected);
      c.btn.setAttribute('aria-pressed', String(id === inspected));
      const text = statusText(id, st);
      c.state.replaceChildren(statusIcon(st), document.createTextNode(text));
      c.btn.setAttribute('aria-label', `${ship.name}, ${ship.role}: ${st === 'active' ? 'flying, your selected ship' : text.toLowerCase()}`);
      if (adminOnly().has(id)) c.btn.dataset['admin'] = 'true';
      else delete c.btn.dataset['admin'];
    }
    empty.hidden = visible.length > 0;
    const f = cx.fleet;
    const granted = adminOnly();
    const ownedCount = f.owned.filter((id) => !granted.has(id)).length;
    fleetLine.textContent = `FLYING ${SHIP_BY_ID.get(f.active)!.name.toUpperCase()}\u00a0· OWNED\u00a0${ownedCount}\u00a0OF\u00a0${SHIPS.length}${granted.size ? '\u00a0· ADMIN ACCESS' : ''}`; // no-break: the count never splits
    if (d.balance) {
      wallet.textContent = d.balance();
      wallet.setAttribute('aria-label', `Guild marks balance: ${wallet.textContent}`);
    }
    launchBtn.textContent = `LAUNCH · ${SHIP_BY_ID.get(f.active)!.name.toUpperCase()}`;
    launchBtn.setAttribute('aria-label', `Launch: undock and fly the ${SHIP_BY_ID.get(f.active)!.name}`);
  };

  const kv = (k: string, v: string, note?: string): HTMLElement => {
    const row = el('div', 'fr-hangar-kv');
    row.append(el('span', 'fr-hangar-k', k), el('span', 'fr-hangar-v', v));
    if (note) row.append(el('span', 'fr-hangar-note', note));
    return row;
  };

  const refreshDetail = (): void => {
    const cx = ctx();
    const f = cx.fleet;
    const ship = SHIP_BY_ID.get(inspected)!;
    const st = statusOf(cx, inspected);
    const flown = shipAsFlown(cx, inspected);
    name.textContent = ship.name.toUpperCase();
    role.textContent = `${ship.role.toUpperCase()} · HIT RADIUS ${ship.radius}`;
    const viaAdmin = adminOnly().has(inspected);
    state.replaceChildren(statusIcon(st), document.createTextNode(viaAdmin ? (st === 'active' ? 'FLYING · ADMIN ACCESS, NOT OWNED' : 'ADMIN ACCESS · NOT OWNED, THIS SESSION ONLY') : STATE_LINE[st]));
    state.dataset['status'] = st;
    badge.replaceChildren(statusIcon(st), document.createTextNode(statusText(inspected, st)));
    badge.dataset['status'] = st;
    preview.setAttribute('aria-label', `${ship.name}, ${ship.role}: ${statusText(inspected, st).toLowerCase()}`);
    desc.textContent = ship.description;
    highs.replaceChildren(...yardHighlights(inspected).map((h) => {
      const li = el('li', 'fr-hangar-high', h.short);
      li.title = h.text;
      return li;
    }));
    highs.hidden = highs.childElementCount === 0;

    // performance (bars on the roster scale; a tick marks the comparison ship on the same scale)
    const against = resolveCompare(cx, inspected, compareChoice);
    const others = f.owned.filter((id) => id !== inspected);
    vsBtn.hidden = others.length === 0;
    const againstName = against ? SHIP_BY_ID.get(against)!.name : null;
    vsBtn.textContent = againstName ? `VS ${againstName.toUpperCase()}` : 'NO COMPARISON';
    vsBtn.setAttribute('aria-label', `${againstName ? `Comparing with your ${againstName}` : 'No comparison'}; press to compare with another owned ship`);
    const upgraded = Object.keys(cx.levels(inspected)).length > 0;
    legend.textContent = `${upgraded ? 'Includes installed upgrades. ' : ''}Bars: fuller is better${againstName ? ` · ▲ better, ▼ worse than the ${againstName} (│ marks its value)` : ''}.`;
    stats.setAttribute('aria-label', againstName ? `Stats compared with your ${againstName}` : 'Stats');
    stats.replaceChildren();
    for (const row of statRows(cx, inspected, against)) {
      const r = el('div', 'fr-hangar-stat');
      r.setAttribute('role', 'row');
      const bar = el('span', 'fr-hangar-bar');
      const fill = el('span', 'fr-hangar-fill');
      fill.style.width = `${Math.round(row.fill * 100)}%`;
      bar.append(fill);
      if (row.otherFill !== null) {
        const mark = el('span', 'fr-hangar-mark');
        mark.style.left = `${Math.round(row.otherFill * 100)}%`;
        bar.append(mark);
      }
      const cmp = el('span', `fr-hangar-delta${row.delta > 0 ? ' is-better' : row.delta < 0 ? ' is-worse' : ''}`, row.delta > 0 ? '▲' : row.delta < 0 ? '▼' : '');
      const value = el('span', 'fr-hangar-value', formatStat(row.key, row.value));
      const lab = el('span', 'fr-hangar-label', row.label);
      lab.setAttribute('role', 'rowheader');
      value.setAttribute('role', 'cell');
      r.setAttribute('aria-label', `${row.label} ${formatStat(row.key, row.value)}${row.delta && row.other !== null ? `, ${row.delta > 0 ? 'better' : 'worse'} than the ${againstName}'s ${formatStat(row.key, row.other)}` : ''}`);
      r.append(lab, bar, value, cmp);
      stats.append(r);
    }

    // P03B: the weapons this hull's mounts take (armory rules); the flown ship also shows its start weapon
    const ordnanceRow = (): HTMLElement => {
      const fits = compatibleWeapons(inspected).map((id) => WEAPON_BY_ID.get(id)!.short);
      const note = st === 'active' ? `starts with ${WEAPON_BY_ID.get(setupOf(f, inspected).start)!.short} · change in the armory` : 'weapons this hull can carry';
      return kv('ORDNANCE', fits.join(' · '), note);
    };
    // armament: the fitted first weapon (the one that fires) with its derived numbers; the pilot missile is the same on every ship
    const lo = loadoutOf(f, inspected);
    const gun = EQUIPMENT_BY_ID.get(lo.weapon[0] ?? '');
    const w = weaponSummary(flown.weapon);
    const ms = pilotSkill(MISSILE, flown.stats.energy);
    arms.replaceChildren(
      kv('PRIMARY', gun && gun.slot === 'weapon' ? `${gun.name} · ${gun.weaponClass.toUpperCase()}` : '—'),
      kv('FIRE RATE', `${trimNum(w.volleysPerSecond)} /s · ${w.boltsPerVolley === 2 ? '2 bolts' : '1 bolt'} × ${w.damagePerBolt} dmg`),
      kv('OUTPUT', `${trimNum(w.output)} dmg/s`, 'if every bolt hits'),
      kv('REACH', `${Math.round(w.reach)}`, 'bolt travel at rest'),
      kv('HARDPOINTS', `${ship.slots.weapon} · ${ship.weaponClasses.map((x) => x.toUpperCase()).join(' / ')}`),
      ordnanceRow(),
      kv('LOCK-ON', `${ms.damage} dmg · ${trimNum(ms.lockSeconds)} s lock · ${trimNum(ms.cooldownSeconds)} s cooldown`, `fitted on every ship · ${ms.energyCost} energy, ${ms.perFullEnergy} per full bar`),
    );

    // fitted modules per slot (stock for ships not owned yet); only the first weapon fires
    const owned = st === 'active' || st === 'owned';
    fitHead.textContent = owned ? 'FITTED' : 'STOCK FIT';
    slotsBox.replaceChildren();
    for (const slot of SLOT_TYPES) {
      for (let i = 0; i < ship.slots[slot]; i++) {
        const item = lo[slot][i] ? EQUIPMENT_BY_ID.get(lo[slot][i]!) : undefined;
        const li = el('li', 'fr-hangar-slot');
        const extra = slot === 'weapon' && i > 0 && item ? ' · not fired' : '';
        li.append(el('span', 'fr-hangar-slot-type', slot.toUpperCase()), el('span', 'fr-hangar-slot-item', item ? item.name + extra : '— empty'));
        if (item) li.title = item.description;
        slotsBox.append(li);
      }
    }

    // licence (with real progress) and price, only for ships not owned
    terms.replaceChildren();
    terms.hidden = termsHead.hidden = owned;
    if (!owned) {
      for (const req of ship.licence) {
        const info = d.describe(req);
        const li = el('li', `fr-hangar-term${info.met ? ' is-met' : ''}`);
        li.append(el('span', 'fr-hangar-term-mark', info.met ? '✓' : '✗'), el('span', 'fr-hangar-term-text', `LICENCE · ${info.title ? `${info.title}: ` : ''}${info.detail}${info.progress ? ` (${info.progress})` : ''}`));
        terms.append(li);
      }
      const missing = new Map(missingFor(ship.cost, cx.cargo).map((c) => [c.resource, c.amount]));
      for (const c of ship.cost) {
        const have = cx.cargo[c.resource] ?? 0;
        const ok = !missing.has(c.resource);
        const li = el('li', `fr-hangar-term${ok ? ' is-met' : ''}`);
        li.append(el('span', 'fr-hangar-term-mark', ok ? '✓' : '✗'), el('span', 'fr-hangar-term-text', `${label(c.resource)} ${c.amount} · IN HOLD ${have}`));
        terms.append(li);
      }
      // Economy pass: ships are paid in cargo; say so instead of leaving the marks price implied
      if (ship.cost.length) terms.append(el('li', 'fr-hangar-term fr-hangar-term-note', adminOnly().size ? 'PAID IN CARGO · NO MARKS · ADMIN ACCESS SHIPS ARE FREE FOR THE SESSION' : 'PAID IN CARGO FROM THE HOLD · NO MARKS'));
    }

    // the one contextual action
    cancelBtn.hidden = pending === null;
    actionBtn.hidden = st === 'active';
    armoryBtn.hidden = !d.armory || st !== 'active';
    armoryBtn.setAttribute('aria-label', `Armory: weapons of the ${ship.name}`);
    actionBtn.disabled = st === 'locked' || st === 'unaffordable';
    actionBtn.classList.toggle('is-armed', pending !== null);
    if (st === 'owned') actionBtn.textContent = pending === 'select' ? `CONFIRM · FLY THE ${ship.name.toUpperCase()}` : 'SELECT SHIP';
    else if (st === 'available') actionBtn.textContent = pending === 'acquire' ? `CONFIRM · PAY ${costText(ship.cost)}` : `ACQUIRE · ${costText(ship.cost)}`;
    else if (st === 'unaffordable') actionBtn.textContent = 'NOT ENOUGH CARGO';
    else if (st === 'locked') actionBtn.textContent = 'LICENCE REQUIRED';
    actionBtn.setAttribute('aria-label', actionBtn.textContent ?? '');
  };

  const refresh = (): void => {
    refreshList();
    refreshDetail();
    drawStrip(inspected);
    bayState.dirty = true;
    if (!root.hidden) drawBay(performance.now());
  };

  function inspect(id: ShipId): void {
    if (id === inspected) return;
    bayState.from = bayState.drawn ?? inspected;
    bayState.t0 = performance.now();
    inspected = id;
    pending = null;
    message.textContent = '';
    refresh();
  }

  function setFilter(f: HangarFilter): void {
    if (f === filter) return;
    filter = f;
    d.sound('uiMove');
    const shown = catalogue(ctx(), filter, sort);
    // keep inspecting a ship the player can see (an empty group keeps the last one)
    if (shown.length > 0 && !shown.includes(inspected)) inspect(shown[0]!);
    else refresh();
  }

  function setSort(s: HangarSort): void {
    sort = s;
    d.sound('uiMove');
    refreshList();
  }

  actionBtn.addEventListener('click', () => {
    const st = statusOf(ctx(), inspected);
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
        message.textContent = `Now flying the ${ship.name}. LAUNCH when ready.`;
      } else message.textContent = r.reason === 'unsafe' ? 'Ships can only be switched while docked with no hostiles engaged.' : 'That ship cannot be selected.';
    } else if (st === 'locked') message.textContent = 'Locked: meet the licence shown under ACQUISITION first.';
    else if (st === 'unaffordable') message.textContent = 'Not enough cargo in the hold for this price.';
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
  armoryBtn.addEventListener('click', () => d.armory?.());
  backBtn.addEventListener('click', () => d.back?.());

  return {
    root,
    menu: menuList,
    open(station: string) {
      inspected = d.fleet().active;
      pending = null;
      filter = 'all';
      sort = 'roster';
      compareChoice = undefined;
      bayState.from = null;
      bayState.drawn = null;
      kicker.textContent = `STATION HANGAR · ${station.toUpperCase()}`;
      message.textContent = 'Docked and repaired. Inspect, acquire or switch ships here.';
      drawThumbs();
      refresh();
      // call after the panel is shown: focus lands on the ship flown (focus inspects, so it must be this one)
      cards.get(inspected)?.btn.focus({ preventScroll: true });
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
    frame(ts: number) {
      if (root.hidden) return;
      const resized = preview.clientWidth !== bayState.cssW || preview.clientHeight !== bayState.cssH;
      const animating = !reduced() || bayState.from !== null;
      if (resized) drawThumbs(); // a layout change (rotation, breakpoint) resized the cards too
      if (bayState.dirty || resized || (animating && ts - bayState.lastDraw >= FRAME_MS)) drawBay(ts);
    },
    status() {
      const cx = ctx();
      const statuses = {} as Record<ShipId, ShipStatus>;
      for (const s of SHIPS) statuses[s.id] = statusOf(cx, s.id);
      return {
        inspected,
        pending,
        statuses,
        action: actionBtn.hidden ? '' : (actionBtn.textContent ?? ''),
        armory: !armoryBtn.hidden,
        message: message.textContent ?? '',
        filter,
        sort,
        compare: resolveCompare(cx, inspected, compareChoice),
        visible: [...visible],
        preview: { ship: bayState.drawn, draws: bayState.draws, transition: bayState.from !== null },
      };
    },
  };
}
