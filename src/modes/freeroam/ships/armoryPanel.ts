/**
 * Station armory (Combat P03B, FR-TD-88). DOM only: every rule comes from
 * armory.ts (mounts, start weapon, switching cycle), every number from the
 * shared weapon catalogue (config/weapons.ts) or the flown craft through the
 * view model (armoryView.ts). The shell opens it as the ARMORY tab of a docked
 * station (and from the hangar) and commits the fleet it returns.
 *
 * Layout: header (back to the hangar, title, the ship flown and its start
 * weapon), the loadout (ship sprite and its switching cycle), the weapon
 * catalogue (one card per weapon, unavailable ones still inspectable), the
 * bay (a to-scale tactical plot drawn with the game's sprites), the details
 * (role, specifications, saved ammunition, compatibility, a missile and nuke
 * comparison) and the action bar (SET AS START, ADD / REMOVE FROM CYCLE).
 *
 *  - Focusing or clicking a card only inspects it. Configuration happens only
 *    through the two actions, which call setStart / setInRotation; those
 *    re-check the ship's mounts, so a disabled or tampered button changes
 *    nothing.
 *  - The plot is drawn once per change or resize from the shell's frame loop
 *    (no timer, no animation loop of its own); nothing runs while hidden.
 *  - The inspected weapon is panel state and never saved.
 */
import type { SpriteId } from '../../../assets/sprites/index.ts';
import { FLEET_FLAME_ROWS } from '../../../assets/sprites/fleet.ts';
import { PRIMARY_WEAPON, WEAPON_BY_ID, WEAPONS, type WeaponDef, type WeaponId } from '../../../config/weapons.ts';
import { drawFrame } from '../../../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../../../render/sprite/spriteCache.ts';
import type { Viewport } from '../../../render/viewport.ts';
import { MenuList } from '../../../shared/ui/menuList.ts';
import { canStartWith, refusalText, setInRotation, setStart, setupOf, type ArmoryResult } from './armory.ts';
import { ammoLine, availability, blastCatch, compatibility, flightDistance, gunRows, ordnanceComparison, ordnanceRows, runtimeLine, STATE_TEXT, weaponState, type DetailRow, type WeaponState } from './armoryView.ts';
import { EQUIPMENT_BY_ID } from './equipment.ts';
import { loadoutOf, type FleetState } from './hangar.ts';
import { SHIP_BY_ID } from './roster.ts';
import type { DerivedShip } from './types.ts';

export interface ArmoryDeps {
  readonly sprites: SpriteCache;
  readonly fleet: () => FleetState;
  /** Saved ammunition counts (the profile's `ordnance`; shown as they are). */
  readonly ordnance: () => Readonly<Record<string, number>>;
  /** The flown ship as built for flight (gun profile with upgrades, energy capacity). */
  readonly craft: () => DerivedShip;
  /** Commit a changed fleet (the shell stores it in the profile and saves). */
  readonly commit: (fleet: FleetState) => void;
  /** Back / ESC: the hangar. */
  readonly back: () => void;
  readonly sound: (cue: 'uiMove' | 'uiSelect' | 'bonus' | 'pause') => void;
  readonly glow: () => boolean;
  /** Economy pass: the Guild marks balance, already formatted by the wallet. The armory sells nothing for marks (restocks are free at stations). */
  readonly balance?: (() => string) | undefined;
}

export interface ArmoryStatus {
  readonly ship: string;
  readonly inspected: WeaponId;
  readonly states: Readonly<Record<WeaponId, WeaponState>>;
  readonly start: WeaponId;
  readonly rotation: readonly WeaponId[];
  /** Ammunition badges as shown. */
  readonly ammo: Readonly<Record<WeaponId, string>>;
  readonly startAction: { readonly text: string; readonly disabled: boolean };
  readonly cycleAction: { readonly text: string; readonly disabled: boolean };
  readonly message: string;
  /** Plot diagnostics: the weapon drawn last and the number of draws. */
  readonly plot: { readonly weapon: WeaponId | null; readonly draws: number };
}

export interface ArmoryPanel {
  readonly root: HTMLElement;
  readonly menu: MenuList;
  /** Refresh for a docking at `station` and focus the start weapon (call once the panel is visible). */
  open(station: string): void;
  back(): void;
  /** Shell frame loop: redraws the plot after a change or a resize (a no-op when hidden). */
  frame(ts: number): void;
  status(): ArmoryStatus;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag: string, attrs: Record<string, string>): SVGElement => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** A distinct silhouette per weapon (shape, not colour, tells them apart). */
function weaponIcon(icon: WeaponDef['icon']): SVGElement {
  const s = svgEl('svg', { viewBox: '0 0 24 24', class: 'fr-armory-icon', 'aria-hidden': 'true' });
  const fill = { fill: 'currentColor' };
  const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (icon === 'plasma') {
    // a stream of bolts leaving a muzzle
    s.append(svgEl('rect', { x: '10', y: '2', width: '4', height: '6', rx: '2', ...fill }), svgEl('rect', { x: '10.5', y: '10', width: '3', height: '4.5', rx: '1.5', ...fill, opacity: '0.75' }), svgEl('rect', { x: '11', y: '16.5', width: '2', height: '3', rx: '1', ...fill, opacity: '0.5' }), svgEl('path', { d: 'M6 22h12', ...line }));
  } else if (icon === 'heavy-missile') {
    // a thick missile inside a wide blast ring
    s.append(svgEl('circle', { cx: '12', cy: '7', r: '6', ...line, 'stroke-dasharray': '2.2 2' }), svgEl('path', { d: 'M12 2.5l2.5 4v11h-5v-11z', ...fill }), svgEl('path', { d: 'M9.5 15l-3 4.5h3zM14.5 15l3 4.5h-3z', ...fill }));
  } else if (icon === 'lock-missile') {
    // a slim missile inside lock brackets
    s.append(svgEl('path', { d: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5', ...line }), svgEl('path', { d: 'M12 5l1.6 3v8.5h-3.2V8z', ...fill }), svgEl('path', { d: 'M10.4 14l-2 3h2zM13.6 14l2 3h-2z', ...fill }));
  } else {
    // a trefoil warhead inside a dashed slow-field ring
    s.append(svgEl('circle', { cx: '12', cy: '12', r: '10', ...line, 'stroke-dasharray': '1.5 2.5' }), svgEl('circle', { cx: '12', cy: '12', r: '1.8', ...fill }));
    for (const a of [-90, 30, 150]) {
      const r1 = 3.2;
      const r2 = 7.5;
      const p = (deg: number, r: number): string => `${(12 + r * Math.cos((deg * Math.PI) / 180)).toFixed(2)} ${(12 + r * Math.sin((deg * Math.PI) / 180)).toFixed(2)}`;
      s.append(svgEl('path', { d: `M${p(a - 30, r1)}L${p(a - 30, r2)}A${r2} ${r2} 0 0 1 ${p(a + 30, r2)}L${p(a + 30, r1)}A${r1} ${r1} 0 0 0 ${p(a - 30, r1)}z`, ...fill }));
    }
  }
  return s;
}

/** State glyph: a shape per state, so it reads without colour. */
const STATE_GLYPH: Readonly<Record<WeaponState, string>> = { start: '►', rotation: '●', off: '○', unavailable: '✕' };

const TICK_DRAW_MIN_MS = 33;

export function createArmoryPanel(d: ArmoryDeps): ArmoryPanel {
  const root = el('section', 'fr-panel fr-panel-armory');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Station armory');
  root.hidden = true;

  /* header */
  const head = el('header', 'fr-armory-head');
  const backBtn = el('button', 'fr-armory-back', '◀ HANGAR');
  backBtn.type = 'button';
  backBtn.setAttribute('aria-label', 'Back to the hangar');
  const titles = el('div', 'fr-armory-titles');
  const kicker = el('p', 'fr-kicker', 'STATION ARMORY');
  const title = el('h2', 'fr-title', 'ARMORY');
  const sub = el('p', 'fr-armory-sub', 'Choose the weapons your ship carries in its switching cycle and the one it starts with.');
  titles.append(kicker, title, sub);
  const shipLine = el('p', 'fr-armory-shipline');
  const wallet = el('p', 'fr-wallet');
  wallet.hidden = !d.balance;
  const headSide = el('div', 'fr-head-side');
  headSide.append(shipLine, wallet);
  head.append(backBtn, titles, headSide);

  /* loadout: the ship flown and its cycle */
  const side = el('section', 'fr-armory-side');
  side.setAttribute('aria-label', 'Active loadout and weapon catalogue');
  const loadout = el('div', 'fr-armory-loadout');
  const thumb = el('canvas', 'fr-armory-thumb');
  thumb.setAttribute('aria-hidden', 'true');
  const loText = el('div', 'fr-armory-lo-text');
  const loName = el('p', 'fr-armory-lo-name');
  const cycle = el('ol', 'fr-armory-cycle');
  cycle.setAttribute('aria-label', 'Switching cycle');
  loText.append(loName, cycle);
  const cycleNote = el('p', 'fr-armory-cycle-note', 'In flight NEXT WEAPON (Q by default, R3) or the WPN button steps through these in this order; FIRE fires the selected weapon.');
  loadout.append(thumb, loText);

  /* catalogue */
  const list = el('div', 'fr-armory-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Weapons');
  side.append(loadout, cycleNote, list);

  /* bay: the plot and identity */
  const bay = el('section', 'fr-armory-bay');
  bay.setAttribute('aria-label', 'Selected weapon');
  const stage = el('div', 'fr-armory-stage');
  const plot = el('canvas', 'fr-armory-plot');
  plot.setAttribute('role', 'img');
  const caption = el('p', 'fr-armory-caption');
  stage.append(plot);
  const ident = el('div', 'fr-armory-ident');
  const wName = el('h3', 'fr-armory-name');
  const wKind = el('p', 'fr-armory-kind');
  const runtime = el('p', 'fr-armory-runtime');
  const runtimeNote = el('p', 'fr-armory-runtime-note');
  ident.append(wName, wKind, runtime, runtimeNote);
  bay.append(stage, caption, ident);

  /* details */
  const detail = el('section', 'fr-armory-detail');
  detail.setAttribute('aria-label', 'Weapon details');
  const role = el('p', 'fr-armory-role');
  const desc = el('p', 'fr-text fr-text-dim fr-armory-desc');
  const tactics = el('ul', 'fr-armory-tactics');
  tactics.setAttribute('aria-label', 'Tactics');
  const specs = el('div', 'fr-armory-kvs');
  const ammoText = el('p', 'fr-armory-ammo-text');
  const compat = el('ul', 'fr-armory-compat');
  compat.setAttribute('aria-label', 'Ships that can carry this weapon');
  const avail = el('p', 'fr-armory-avail');
  const cmpTable = el('table', 'fr-armory-compare');
  const sec = (t: string): HTMLElement => el('h4', 'fr-armory-sec', t);
  detail.append(role, desc, tactics, sec('SPECIFICATIONS'), specs, sec('AMMUNITION'), ammoText, sec('SHIP COMPATIBILITY'), compat, avail, sec('MISSILES AND NUKE COMPARED'), cmpTable);

  const body = el('div', 'fr-armory');
  body.append(side, bay, detail);

  /* action bar */
  const foot = el('footer', 'fr-armory-foot');
  const message = el('p', 'fr-text fr-armory-msg');
  message.setAttribute('role', 'status');
  const actions = el('div', 'fr-menu fr-armory-actions');
  const startBtn = el('button', 'fr-btn fr-armory-start', 'SET AS START');
  startBtn.type = 'button';
  const cycleBtn = el('button', 'fr-btn fr-armory-toggle', 'ADD TO CYCLE');
  cycleBtn.type = 'button';
  actions.append(startBtn, cycleBtn);
  foot.append(message, actions);
  root.append(head, body, foot);

  /* cards */
  const cards = new Map<WeaponId, { readonly btn: HTMLButtonElement; readonly state: HTMLElement; readonly ammo: HTMLElement }>();
  for (const w of WEAPONS) {
    const b = el('button', 'fr-armory-weapon');
    b.type = 'button';
    b.dataset['weapon'] = w.id;
    b.dataset['category'] = w.category;
    const text = el('span', 'fr-armory-weapon-text');
    const st = el('span', 'fr-armory-weapon-state');
    text.append(el('span', 'fr-armory-weapon-name', w.name.toUpperCase()), el('span', 'fr-armory-weapon-kind', w.kind.toUpperCase()), st);
    const ammo = el('span', 'fr-armory-ammo');
    b.append(weaponIcon(w.icon), text, ammo);
    b.addEventListener('focus', () => inspect(w.id));
    b.addEventListener('click', (e) => {
      const was = inspected === w.id;
      inspect(w.id);
      // a keyboard activation of the inspected card moves on to its first live action
      if (was && e.detail === 0) (!startBtn.disabled ? startBtn : !cycleBtn.disabled ? cycleBtn : null)?.focus();
    });
    list.append(b);
    cards.set(w.id, { btn: b, state: st, ammo });
  }
  const menuList = new MenuList(root, () => d.sound('uiMove'));

  let inspected: WeaponId = PRIMARY_WEAPON;

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
  const shipSprite = (): SpriteId => SHIP_BY_ID.get(d.fleet().active)!.sprite as SpriteId;

  const drawThumb = (): void => {
    const { w, h } = fitCanvas(thumb, thumb.clientWidth || 52, thumb.clientHeight || 52);
    const g = thumb.getContext('2d');
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const fr = d.sprites.frame(shipSprite(), 'idle', 0);
    const scale = Math.max(1, Math.floor(Math.min(w / fr.raster.sprite.width, h / Math.max(1, fr.raster.sprite.height - 2 * FLEET_FLAME_ROWS))));
    drawFrame(g, d.sprites, fr, viewport(w, h, scale), w / 2 / scale, h / 2 / scale, { glow: d.glow() });
  };

  /**
   * The tactical plot: distances to scale (px of the game world), sprites at a
   * readable size. The ship flown sits at the bottom and fires up the screen.
   */
  const plotState = { dirty: true, cssW: 0, cssH: 0, draws: 0, drawn: null as WeaponId | null, last: -Infinity };
  const PATROL_SPACING = 60;
  const PATROL = 5;
  const drawPlot = (ts: number): void => {
    const cssW = plot.clientWidth || 320;
    const cssH = plot.clientHeight || 200;
    const { w: W, h: H, ratio: r } = fitCanvas(plot, cssW, cssH);
    const c = plot.getContext('2d');
    if (!c) return;
    const w = WEAPON_BY_ID.get(inspected)!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.clearRect(0, 0, W, H);
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0f20');
    bg.addColorStop(1, '#05070f');
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    // world extent of the drawing: the weapon's reach plus its blast (or the gun's reach)
    const craft = d.craft();
    const reach = w.fire === 'ordnance' ? (w.guidance.kind === 'lock' ? Math.min(w.guidance.acquire.range, flightDistance(w)) : flightDistance(w)) : (craft.weapon.shotSpeed * craft.weapon.lifeTicks) / 60;
    const blastR = w.fire === 'ordnance' ? Math.max(w.blast?.radius ?? 0, w.dilation?.radius ?? 0) : 0;
    const extentY = reach + blastR + 40;
    const extentX = Math.max(2 * blastR + 80, 2 * PATROL_SPACING * 2.6);
    const k = Math.min((H * 0.86) / extentY, (W * 0.92) / extentX); // device px per world px
    const ox = W / 2;
    const oy = H - 24 * r; // the ship
    const at = (x: number, y: number): [number, number] => [ox + x * k, oy - y * k];

    // range grid: a ring every 100 px around the ship
    c.lineWidth = Math.max(1, r);
    c.strokeStyle = 'rgba(92, 239, 255, 0.07)';
    for (let d0 = 100; d0 <= extentY; d0 += 100) {
      c.beginPath();
      c.arc(ox, oy, d0 * k, Math.PI, 2 * Math.PI);
      c.stroke();
    }
    // scale bar
    const bar = 100 * k;
    c.strokeStyle = 'rgba(200, 210, 235, 0.55)';
    c.beginPath();
    c.moveTo(10 * r, H - 10 * r);
    c.lineTo(10 * r + bar, H - 10 * r);
    c.moveTo(10 * r, H - 13 * r);
    c.lineTo(10 * r, H - 7 * r);
    c.moveTo(10 * r + bar, H - 13 * r);
    c.lineTo(10 * r + bar, H - 7 * r);
    c.stroke();
    c.fillStyle = 'rgba(200, 210, 235, 0.7)';
    c.font = `${10 * r}px ui-monospace, Menlo, Consolas, monospace`;
    c.textBaseline = 'bottom';
    c.fillText('100 px', 14 * r + bar, H - 5 * r);

    const glow = d.glow();
    const sprite = (id: SpriteId, state: string, x: number, y: number, scale: number, alpha = 1): void => {
      const fr = d.sprites.frame(id, state as never, 0);
      drawFrame(c, d.sprites, fr, viewport(W, H, scale), x / scale, y / scale, { glow, alpha });
    };
    const sScale = Math.max(1, Math.round(r * (H > 260 * r ? 2 : 1)));

    // the target point and the patrol around it
    const ty = reach;
    const [tx0, ty0] = at(0, ty);
    const patrol = blastCatch(w, PATROL_SPACING, PATROL);
    const inBlast = (dx: number, dy: number): boolean => w.fire === 'ordnance' && !!w.blast && Math.hypot(dx, dy) <= w.blast.radius;

    // path from the ship to the target
    c.setLineDash([4 * r, 4 * r]);
    c.strokeStyle = 'rgba(232, 236, 248, 0.45)';
    c.beginPath();
    c.moveTo(ox, oy);
    if (w.fire === 'ordnance' && w.guidance.kind === 'lock') {
      // a homing curve onto a target off the nose, with the acquisition cone
      const cone = w.guidance.acquire.cone;
      c.quadraticCurveTo(ox - reach * 0.25 * k, oy - reach * 0.55 * k, tx0, ty0);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = 'rgba(92, 239, 255, 0.05)';
      c.beginPath();
      c.moveTo(ox, oy);
      c.arc(ox, oy, w.guidance.acquire.range * k, -Math.PI / 2 - cone, -Math.PI / 2 + cone);
      c.closePath();
      c.fill();
    } else {
      c.lineTo(tx0, ty0);
      c.stroke();
      c.setLineDash([]);
    }

    // blast and slow-field rings to scale
    if (w.fire === 'ordnance' && w.dilation) {
      c.setLineDash([3 * r, 5 * r]);
      c.strokeStyle = 'rgba(180, 160, 255, 0.75)';
      c.beginPath();
      c.arc(tx0, ty0, w.dilation.radius * k, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    }
    if (w.fire === 'ordnance' && w.blast) {
      const g = c.createRadialGradient(tx0, ty0, 0, tx0, ty0, w.blast.radius * k);
      g.addColorStop(0, 'rgba(255, 196, 92, 0.35)');
      g.addColorStop(1, 'rgba(255, 140, 60, 0.06)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(tx0, ty0, w.blast.radius * k, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(255, 196, 92, 0.85)';
      c.beginPath();
      c.arc(tx0, ty0, w.blast.radius * k, 0, Math.PI * 2);
      c.stroke();
    }

    // patrol (raiders): dimmed when the blast does not reach them
    for (const [dx, dy] of patrol.offsets) {
      const [x, y] = at(dx, ty + dy);
      const hit = w.fire !== 'ordnance' ? dx === 0 && dy === 0 : !w.blast ? dx === 0 && dy === 0 : inBlast(dx, dy);
      sprite('foe.raider', 'fly', x, y, sScale, hit ? 1 : 0.4);
    }
    if (w.fire === 'ordnance') {
      if (w.guidance.kind === 'lock') {
        // lock brackets on the target
        const s = 14 * r;
        c.strokeStyle = 'rgba(92, 239, 255, 0.95)';
        c.lineWidth = 1.5 * r;
        c.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          c.moveTo(tx0 + sx * s, ty0 + sy * s * 0.45);
          c.lineTo(tx0 + sx * s, ty0 + sy * s);
          c.lineTo(tx0 + sx * s * 0.45, ty0 + sy * s);
        }
        c.stroke();
        c.lineWidth = Math.max(1, r);
      }
      sprite('fx.explosion.enemy', 'burst', tx0, ty0, sScale, 0.9);
    } else {
      // plasma: a stream of real bolt sprites along the nose
      const n = 6;
      for (let i = 1; i <= n; i++) {
        const [x, y] = at(0, (reach * i) / (n + 1));
        sprite('fx.shot.player', 'fly', x, y, sScale);
      }
    }
    // the ship flown
    sprite(shipSprite(), 'thrust', ox, oy, sScale);

    // labels on the plot
    c.fillStyle = 'rgba(232, 236, 248, 0.85)';
    c.textBaseline = 'top';
    c.textAlign = 'left';
    const tag = (t: string, y: number): void => c.fillText(t, 10 * r, y);
    if (w.fire === 'ordnance') {
      if (w.blast) tag(`BLAST ${w.blast.radius} px`, 8 * r);
      if (w.dilation) tag(`SLOW FIELD ${w.dilation.radius} px · ${w.dilation.scale}× · ${(w.dilation.durationTicks / 60).toFixed(0)} s`, 22 * r);
    } else tag(`REACH ${Math.round(reach)} px`, 8 * r);
    c.textAlign = 'start';

    plotState.dirty = false;
    plotState.cssW = cssW;
    plotState.cssH = cssH;
    plotState.draws += 1;
    plotState.drawn = inspected;
    plotState.last = ts;
    const caught = w.fire === 'ordnance' && w.blast ? patrol.caught : 1;
    caption.textContent = w.fire === 'ordnance' && w.blast
      ? `Distances to scale. Against ${patrol.offsets.length} raiders ${PATROL_SPACING} px apart, the blast reaches ${caught}.`
      : 'Distances to scale. Bolts hit one target each.';
    plot.setAttribute('aria-label', `${w.name} plot. ${caption.textContent}`);
  };

  /* ---------------------------------------------------------- refresh */
  const kv = (row: DetailRow): HTMLElement => {
    const r = el('div', 'fr-armory-kv');
    r.append(el('span', 'fr-armory-k', row.label), el('span', 'fr-armory-v', row.value));
    if (row.note) r.append(el('span', 'fr-armory-note', row.note));
    return r;
  };

  const refresh = (): void => {
    const f = d.fleet();
    const ship = SHIP_BY_ID.get(f.active)!;
    const setup = setupOf(f, f.active);
    const craft = d.craft();
    const ord = d.ordnance();
    const startDef = WEAPON_BY_ID.get(setup.start)!;
    shipLine.textContent = `${ship.name.toUpperCase()}\u00a0· START\u00a0${startDef.short}`;
    if (d.balance) {
      wallet.textContent = d.balance();
      wallet.setAttribute('aria-label', `Guild marks balance: ${wallet.textContent}`);
    }
    loName.textContent = `${ship.name.toUpperCase()} · ${ship.role.toUpperCase()}`;
    cycle.replaceChildren(...setup.rotation.map((id) => {
      const wd = WEAPON_BY_ID.get(id)!;
      const li = el('li', `fr-armory-chip${id === setup.start ? ' is-start' : ''}`);
      li.append(weaponIcon(wd.icon), document.createTextNode(`${id === setup.start ? '► ' : ''}${wd.short}`));
      return li;
    }));
    cycle.setAttribute('aria-label', `Switching cycle: ${setup.rotation.map((id) => WEAPON_BY_ID.get(id)!.name).join(', ')}; starts with ${startDef.name}`);

    for (const [id, card] of cards) {
      const wd = WEAPON_BY_ID.get(id)!;
      const st = weaponState(f, f.active, id);
      card.btn.dataset['state'] = st;
      card.btn.classList.toggle('is-inspected', id === inspected);
      card.btn.setAttribute('aria-pressed', String(id === inspected));
      card.state.textContent = `${STATE_GLYPH[st]} ${STATE_TEXT[st]}`;
      const a = ammoLine(wd, ord, craft.stats.energy);
      card.ammo.textContent = a.badge;
      card.btn.setAttribute('aria-label', `${wd.name}, ${wd.kind}: ${STATE_TEXT[st].toLowerCase()}; ammunition ${a.badge === '∞' ? 'unlimited' : a.badge}`);
    }

    // details of the inspected weapon
    const w = WEAPON_BY_ID.get(inspected)!;
    const st = weaponState(f, f.active, inspected);
    wName.textContent = w.name.toUpperCase();
    wKind.replaceChildren(weaponIcon(w.icon), document.createTextNode(`${w.kind.toUpperCase()}`));
    const rt = runtimeLine(w);
    runtime.textContent = rt.label;
    runtime.dataset['runtime'] = rt.status;
    runtimeNote.textContent = rt.note;
    role.textContent = w.role;
    desc.textContent = w.description;
    tactics.replaceChildren(...w.tactics.map((t) => el('li', 'fr-armory-tactic', t)));
    const gunName = EQUIPMENT_BY_ID.get(loadoutOf(f, f.active).weapon[0] ?? '')?.name ?? 'Pulse Cannon';
    specs.replaceChildren(...(w.fire === 'fitted-gun' ? gunRows(craft.weapon, gunName) : ordnanceRows(w)).map(kv));
    ammoText.textContent = ammoLine(w, ord, craft.stats.energy).text;
    compat.replaceChildren(...compatibility(inspected).map((c) => {
      const li = el('li', `fr-armory-fit${c.fits ? ' is-fit' : ''}${c.ship === f.active ? ' is-flown' : ''}`);
      li.append(el('span', 'fr-armory-fit-mark', c.fits ? '✓' : '✕'), document.createTextNode(c.name.toUpperCase()));
      li.setAttribute('aria-label', `${c.name}: ${c.fits ? 'can carry it' : 'cannot carry it'}${c.ship === f.active ? ' (your ship)' : ''}`);
      return li;
    }));
    const av = availability(f, f.active, inspected);
    avail.textContent = av.text;
    avail.dataset['ok'] = String(av.ok);

    // comparison of the missiles and the nuke on the same units
    const cols = ordnanceComparison();
    cmpTable.replaceChildren();
    const cap = el('caption', 'fr-armory-cmp-cap', 'Same units for each column; no combined score.');
    const thead = el('thead', '');
    const hr = el('tr', '');
    hr.append(el('th', '', ''));
    for (const col of cols) {
      const th = el('th', col.id === inspected ? 'is-inspected' : '', col.short);
      th.setAttribute('scope', 'col');
      hr.append(th);
    }
    thead.append(hr);
    const tbody = el('tbody', '');
    const rowOf = (label: string, cell: (c: (typeof cols)[number]) => Node | string): void => {
      const tr = el('tr', '');
      const th = el('th', '', label);
      th.setAttribute('scope', 'row');
      tr.append(th);
      for (const col of cols) {
        const td = el('td', col.id === inspected ? 'is-inspected' : '');
        const v = cell(col);
        if (typeof v === 'string') td.textContent = v;
        else td.append(v);
        tr.append(td);
      }
      tbody.append(tr);
    };
    rowOf('TARGETING', (c) => c.guidance);
    rowOf('LOCK', (c) => c.lock);
    rowOf('BLAST', (c) => {
      const box = el('span', 'fr-armory-cmp-blast');
      const b = el('span', 'fr-armory-cmp-bar');
      const fill = el('span', 'fr-armory-cmp-fill');
      fill.style.width = `${Math.max(4, Math.round(c.blastFill * 100))}%`;
      b.append(fill);
      box.append(el('span', '', `${c.blast} px`), b);
      return box;
    });
    rowOf('CENTRE DMG', (c) => c.centre);
    rowOf('DIRECT HIT', (c) => c.direct);
    rowOf('COOLDOWN', (c) => c.cooldown);
    rowOf('AMMO', (c) => c.ammo);
    cmpTable.append(cap, thead, tbody);

    // the two actions (the rules re-check everything on press)
    const canStart = canStartWith(f.active, inspected);
    if (st === 'unavailable') {
      startBtn.textContent = 'NOT FITTED';
      startBtn.disabled = true;
      cycleBtn.textContent = 'NOT FITTED';
      cycleBtn.disabled = true;
    } else {
      startBtn.textContent = st === 'start' ? '✓ START WEAPON' : canStart ? 'SET AS START' : 'NOT A START WEAPON';
      startBtn.disabled = st === 'start' || !canStart;
      cycleBtn.textContent = inspected === PRIMARY_WEAPON ? 'ALWAYS IN CYCLE' : st === 'off' ? 'ADD TO CYCLE' : 'REMOVE FROM CYCLE';
      cycleBtn.disabled = inspected === PRIMARY_WEAPON;
    }
    startBtn.setAttribute('aria-label', `${startBtn.textContent}: ${w.name}`);
    cycleBtn.setAttribute('aria-label', `${cycleBtn.textContent}: ${w.name}`);
    plotState.dirty = true;
    if (!root.hidden) drawPlot(performance.now());
  };

  function inspect(id: WeaponId): void {
    if (id === inspected) return;
    inspected = id;
    message.textContent = '';
    refresh();
  }

  const apply = (r: ArmoryResult, done: (startReset: boolean) => string): void => {
    if (!r.ok) {
      message.textContent = refusalText(r.reason, d.fleet().active, inspected);
      d.sound('pause');
    } else {
      if (r.changed) d.commit(r.fleet);
      message.textContent = r.changed ? `${done(r.startReset)} Saved.` : 'No change.';
      d.sound(r.changed ? 'uiSelect' : 'uiMove');
    }
    refresh();
    (startBtn.disabled ? (cycleBtn.disabled ? cards.get(inspected)!.btn : cycleBtn) : startBtn).focus();
  };

  startBtn.addEventListener('click', () => {
    const w = WEAPON_BY_ID.get(inspected)!;
    apply(setStart(d.fleet(), d.fleet().active, inspected), () => `${w.name}: the start weapon of the ${SHIP_BY_ID.get(d.fleet().active)!.name}.`);
  });
  cycleBtn.addEventListener('click', () => {
    const f = d.fleet();
    const w = WEAPON_BY_ID.get(inspected)!;
    const on = weaponState(f, f.active, inspected) === 'off';
    apply(setInRotation(f, f.active, inspected, on), (reset) => (on ? `${w.name} added to the cycle.` : `${w.name} removed from the cycle.${reset ? ` The start weapon is back to the ${WEAPON_BY_ID.get(setupOf(d.fleet(), d.fleet().active).start)!.name}.` : ''}`));
  });
  backBtn.addEventListener('click', () => d.back());

  return {
    root,
    menu: menuList,
    open(station: string) {
      const f = d.fleet();
      inspected = setupOf(f, f.active).start;
      kicker.textContent = `STATION ARMORY · ${station.toUpperCase()}`;
      message.textContent = 'Pick a weapon to inspect. Changes save at once.';
      drawThumb();
      refresh();
      cards.get(inspected)?.btn.focus({ preventScroll: true });
    },
    back() {
      d.back();
    },
    frame(ts: number) {
      if (root.hidden) return;
      const resized = plot.clientWidth !== plotState.cssW || plot.clientHeight !== plotState.cssH;
      if (resized) drawThumb();
      if ((plotState.dirty || resized) && ts - plotState.last >= TICK_DRAW_MIN_MS) drawPlot(ts);
    },
    status() {
      const f = d.fleet();
      const setup = setupOf(f, f.active);
      const states = {} as Record<WeaponId, WeaponState>;
      const ammo = {} as Record<WeaponId, string>;
      for (const w of WEAPONS) {
        states[w.id] = weaponState(f, f.active, w.id);
        ammo[w.id] = ammoLine(w, d.ordnance(), d.craft().stats.energy).badge;
      }
      return {
        ship: f.active,
        inspected,
        states,
        start: setup.start,
        rotation: [...setup.rotation],
        ammo,
        startAction: { text: startBtn.textContent ?? '', disabled: startBtn.disabled },
        cycleAction: { text: cycleBtn.textContent ?? '', disabled: cycleBtn.disabled },
        message: message.textContent ?? '',
        plot: { weapon: plotState.drawn, draws: plotState.draws },
      };
    },
  };
}
