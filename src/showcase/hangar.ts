/**
 * Hangar: the Stage 1 visual-foundation showcase.
 * Fleet     every look (sprite + state + variant), animated, labelled.
 * Formation the full cast on one playfield at true game scale.
 * Scales    the same scene at classic / fractional / native / large sizes.
 * Rewards   Stage 2 reward bench: scoring, HUD, rescue flow, save (rewardsBench.ts).
 */
import { COLORS } from '../config/palette.ts';
import { PLAYFIELD_ART } from '../config/visual.ts';
import { LOOKS, SPRITES, VARIANTS, type Look, type SpriteCategory } from '../assets/sprites/index.ts';
import { FixedStepClock } from '../core/clock.ts';
import { frameIndexAt } from '../render/sprite/animation.ts';
import { drawFrame } from '../render/sprite/drawSprite.ts';
import { resolveRole } from '../render/sprite/rasterize.ts';
import { SpriteCache } from '../render/sprite/spriteCache.ts';
import { Starfield } from '../render/starfield.ts';
import { fitViewport, syncCanvasSize, type Viewport } from '../render/viewport.ts';
import { openStore } from '../persistence/storage.ts';
import { SaveManager } from '../persistence/saveData.ts';
import { RewardsBench } from './rewardsBench.ts';
import { drawScene } from './scene.ts';

type ViewId = 'fleet' | 'formation' | 'scales' | 'rewards';
const VIEW_IDS: readonly ViewId[] = ['fleet', 'formation', 'scales', 'rewards'];

interface Panel {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  css: { width: number; height: number };
}

interface FleetCard extends Panel {
  readonly look: Look;
  readonly artW: number;
  readonly artH: number;
}

interface ScalePanel extends Panel {
  readonly label: HTMLElement;
  /** Fixed device-independent CSS scale (CSS px per art px), or 'crop'. */
  readonly mode: { kind: 'fit'; cssPerArt: number } | { kind: 'crop'; cssPerArt: number; cx: number; cy: number };
}

const CATEGORY_TITLES: Record<SpriteCategory, string> = {
  player: 'Player',
  enemy: 'Enemy families',
  special: 'Special transforms',
  effect: 'Projectiles & effects',
  fleet: 'Free Roam fleet',
  foe: 'Free Roam enemies & factions',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makePanel(canvas: HTMLCanvasElement): Panel {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas 2D is not available in this browser');
  return { canvas, ctx, css: { width: canvas.clientWidth, height: canvas.clientHeight } };
}

export interface HangarStatus {
  framesBuilt: number;
  errors: string[];
  ready: boolean;
}

export function mountHangar(root: HTMLElement): HangarStatus {
  const status: HangarStatus = { framesBuilt: 0, errors: [], ready: false };
  const cache = new SpriteCache();
  const stars = new Starfield();
  const clock = new FixedStepClock({ hz: 60 });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Rasterise everything up front so a broken sprite fails loudly at startup.
  try {
    status.framesBuilt = cache.warm([undefined, ...(Object.keys(VARIANTS) as (keyof typeof VARIANTS)[])]);
  } catch (err) {
    status.errors.push(err instanceof Error ? err.message : String(err));
  }

  // Versioned local save; falls back to memory if storage is unavailable.
  const save = new SaveManager(openStore());
  let view: ViewId = 'formation';
  let paused = false;
  let glow = save.get().display.glow;
  let pixelPerfect = save.get().display.pixelPerfect;

  /* Shell ---------------------------------------------------------------- */
  root.replaceChildren();
  const header = el('header', 'bar');
  const brand = el('div', 'brand');
  brand.append(el('span', 'brand-mark', 'GALAXIA'), el('span', 'brand-sub', 'Hangar · developer showcase'));

  const tabs = el('div', 'tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Showcase view');
  const tabButtons = new Map<ViewId, HTMLButtonElement>();
  VIEW_IDS.forEach((id, i) => {
    const b = el('button', 'tab', `${i + 1} · ${id[0]!.toUpperCase()}${id.slice(1)}`);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset['view'] = id;
    b.addEventListener('click', () => setView(id));
    tabButtons.set(id, b);
    tabs.append(b);
  });

  const toggles = el('div', 'toggles');
  const toggle = (label: string, initial: boolean, onChange: (v: boolean) => void): HTMLButtonElement => {
    const b = el('button', 'toggle', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(initial));
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(next));
      onChange(next);
    });
    toggles.append(b);
    return b;
  };
  const pauseBtn = toggle('Pause', false, (v) => {
    paused = v;
    clock.resetTiming();
  });
  toggle('Glow', glow, (v) => {
    glow = v;
    save.setDisplay({ glow: v });
  });
  toggle('Pixel-perfect', pixelPerfect, (v) => {
    pixelPerfect = v;
    save.setDisplay({ pixelPerfect: v });
  });

  header.append(brand, tabs, toggles);

  const main = el('main', 'views');
  const fleetView = el('section', 'view view-fleet');
  const formationView = el('section', 'view view-formation');
  const scalesView = el('section', 'view view-scales');
  const rewardsView = el('section', 'view view-rewards');
  main.append(fleetView, formationView, scalesView, rewardsView);

  const footer = el('footer', 'status');
  footer.setAttribute('role', 'status');
  root.append(header, main, footer);

  /* Fleet view ---------------------------------------------------------------- */
  const cards: FleetCard[] = [];
  for (const category of Object.keys(CATEGORY_TITLES) as SpriteCategory[]) {
    const looks = LOOKS.filter((l) => l.category === category);
    if (looks.length === 0) continue;
    const group = el('div', 'fleet-group');
    group.append(el('h2', 'fleet-title', CATEGORY_TITLES[category]));
    const grid = el('div', 'fleet-grid');
    for (const look of looks) {
      const def = SPRITES[look.sprite];
      const frames = (def.states as Record<string, readonly unknown[]>)[look.state]!;
      let artW = 0;
      let artH = 0;
      let contentW = 0;
      let contentH = 0;
      for (let i = 0; i < frames.length; i++) {
        const f = cache.frame(look.sprite, look.state, i, look.variant);
        artW = Math.max(artW, f.raster.sprite.width);
        artH = Math.max(artH, f.raster.sprite.height);
        contentW = Math.max(contentW, f.raster.contentWidth);
        contentH = Math.max(contentH, f.raster.contentHeight);
      }
      const card = el('figure', 'card');
      const canvas = el('canvas', 'card-canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${look.label} sprite`);
      const caption = el('figcaption', 'card-caption');
      caption.append(
        el('span', 'card-name', look.label),
        el('span', 'card-meta', `${look.sprite} · ${look.state}${look.variant ? ' · ' + look.variant : ''}`),
        el('span', 'card-meta', `${contentW}×${contentH} art px · ${frames.length} frame${frames.length > 1 ? 's' : ''}`),
      );
      const swatches = el('span', 'swatches');
      const roles = new Set(Object.values(def.palette).map((r) => resolveRole(r, look.variant ? VARIANTS[look.variant] : undefined)));
      for (const role of roles) {
        const sw = el('span', 'swatch');
        sw.style.background = COLORS[role];
        sw.title = `${role} ${COLORS[role]}`;
        swatches.append(sw);
      }
      caption.append(swatches);
      card.append(canvas, caption);
      grid.append(card);
      cards.push({ ...makePanel(canvas), look, artW, artH });
    }
    group.append(grid);
    fleetView.append(group);
  }

  /* Formation view ------------------------------------------------------------ */
  const formationCanvas = el('canvas', 'stage-canvas');
  formationCanvas.setAttribute('role', 'img');
  formationCanvas.setAttribute('aria-label', 'Full cast at true game scale on the playfield background');
  formationView.append(formationCanvas);
  const formation = makePanel(formationCanvas);

  /* Scales view --------------------------------------------------------------- */
  const scalePanels: ScalePanel[] = [];
  const scaleSpecs: { title: string; mode: ScalePanel['mode'] }[] = [
    { title: 'Small: classic 224×288', mode: { kind: 'fit', cssPerArt: 0.5 } },
    { title: 'Medium: fractional 0.75×', mode: { kind: 'fit', cssPerArt: 0.75 } },
    { title: 'Native: 448×576', mode: { kind: 'fit', cssPerArt: 1 } },
    { title: 'Large: 3× detail crop', mode: { kind: 'crop', cssPerArt: 3, cx: 300, cy: 150 } },
  ];
  for (const spec of scaleSpecs) {
    const fig = el('figure', 'scale-panel');
    const canvas = el('canvas', 'scale-canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${spec.title} rendering`);
    if (spec.mode.kind === 'fit') {
      canvas.style.width = `${PLAYFIELD_ART.width * spec.mode.cssPerArt}px`;
      canvas.style.height = `${PLAYFIELD_ART.height * spec.mode.cssPerArt}px`;
    } else {
      canvas.style.width = '432px';
      canvas.style.height = '576px';
    }
    const label = el('figcaption', 'scale-label', spec.title);
    fig.append(canvas, label);
    scalesView.append(fig);
    scalePanels.push({ ...makePanel(canvas), label, mode: spec.mode });
  }

  /* Rewards view ------------------------------------------------------------- */
  let bench: RewardsBench | null = null;
  try {
    bench = new RewardsBench(rewardsView, { cache, stars, save });
  } catch (err) {
    status.errors.push(err instanceof Error ? err.message : String(err));
  }

  /* Sizing ------------------------------------------------------------------- */
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target as HTMLCanvasElement;
      const panel = [formation, ...cards, ...scalePanels].find((p) => p.canvas === target);
      if (panel) panel.css = { width: entry.contentRect.width, height: entry.contentRect.height };
    }
  });
  [formation, ...cards, ...scalePanels].forEach((p) => observer.observe(p.canvas));

  function setView(next: ViewId): void {
    view = next;
    for (const [id, b] of tabButtons) {
      const active = id === next;
      b.setAttribute('aria-selected', String(active));
      b.tabIndex = active ? 0 : -1;
    }
    fleetView.hidden = next !== 'fleet';
    formationView.hidden = next !== 'formation';
    scalesView.hidden = next !== 'scales';
    rewardsView.hidden = next !== 'rewards';
    root.dataset['view'] = next;
  }

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === '1') setView('fleet');
    else if (e.key === '2') setView('formation');
    else if (e.key === '3') setView('scales');
    else if (e.key === '4') setView('rewards');
    else if (e.key === ' ') {
      e.preventDefault();
      pauseBtn.click();
    }
  });

  const viewParam = new URLSearchParams(location.search).get('view');
  if (VIEW_IDS.includes(viewParam as ViewId)) setView(viewParam as ViewId);
  else setView('formation');

  /* Rendering ------------------------------------------------------------------ */
  const motion = (): number => (reducedMotion.matches ? 0.25 : 1);

  function renderFleet(t: number, dpr: number): void {
    for (const card of cards) {
      const { width, height } = syncCanvasSize(card.canvas, card.css.width, card.css.height, dpr);
      const v = fitViewport(width, height, { artWidth: card.artW, artHeight: card.artH, integerScale: true, maxScale: 6 * dpr });
      const ctx = card.ctx;
      ctx.fillStyle = COLORS['space.void'];
      ctx.fillRect(0, 0, width, height);
      const look = card.look;
      const def = SPRITES[look.sprite];
      const index = frameIndexAt(def, look.state, t);
      const blinkOff = look.blinkMs !== undefined && Math.floor(t / look.blinkMs) % 2 === 1;
      const variant = blinkOff ? undefined : look.variant;
      const frame = cache.frame(look.sprite, look.state, index, variant);
      drawFrame(ctx, cache, frame, v, v.artWidth / 2, v.artHeight / 2, { glow });
    }
  }

  function renderFormation(t: number, dpr: number): void {
    const { width, height } = syncCanvasSize(formation.canvas, formation.css.width, formation.css.height, dpr);
    const v = fitViewport(width, height, { integerScale: pixelPerfect });
    drawScene(formation.ctx, cache, stars, v, t, { glow, motion: motion() });
    footer.dataset['scale'] = v.scale.toFixed(3);
  }

  function renderScales(t: number, dpr: number): void {
    for (const panel of scalePanels) {
      const { width, height } = syncCanvasSize(panel.canvas, panel.css.width, panel.css.height, dpr);
      let v: Viewport;
      if (panel.mode.kind === 'fit') {
        v = fitViewport(width, height);
      } else {
        const scale = panel.mode.cssPerArt * dpr;
        v = {
          scale,
          offsetX: Math.round(width / 2 - panel.mode.cx * scale),
          offsetY: Math.round(height / 2 - panel.mode.cy * scale),
          deviceWidth: width,
          deviceHeight: height,
          artWidth: PLAYFIELD_ART.width,
          artHeight: PLAYFIELD_ART.height,
        };
      }
      drawScene(panel.ctx, cache, stars, v, t, { glow, motion: motion() });
      panel.label.dataset['scale'] = `${v.scale.toFixed(2)} device px per art px`;
    }
  }

  function updateFooter(): void {
    const errs = status.errors.length;
    footer.textContent = errs
      ? `Sprite errors: ${status.errors.join('; ')}`
      : `${Object.keys(SPRITES).length} sprites · ${status.framesBuilt} frame variants rasterised · ${paused ? 'paused' : 'running'} · keys 1–4 switch view, Space pauses · save: ${save.persistent ? 'local' : 'memory'}`;
    footer.classList.toggle('status-error', errs > 0);
  }

  let lastFooterState = '';
  function frame(now: number): void {
    if (!paused) clock.advance(now, () => {});
    const t = clock.timeMs;
    const dpr = window.devicePixelRatio || 1;
    try {
      if (view === 'fleet') renderFleet(t, dpr);
      else if (view === 'formation') renderFormation(t, dpr);
      else if (view === 'rewards') bench?.render(t, dpr, { glow, pixelPerfect, motion: motion() });
      else renderScales(t, dpr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!status.errors.includes(msg)) status.errors.push(msg);
    }
    const footerState = `${paused}|${status.errors.length}`;
    if (footerState !== lastFooterState) {
      updateFooter();
      lastFooterState = footerState;
    }
    status.ready = true;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return status;
}
