/**
 * DOM HUD layered over the playfield canvas (TD-03: canvas for play, DOM for UI).
 *
 * - Top band: GALAXIA label over the score (left), HIGH SCORE (centre), ticker (right).
 * - Bottom band: reserve ships (left), stage (right).
 * - Centre: interstitial lines (stage intro, challenge results, game over).
 * - Pop-ups: short score labels at playfield positions.
 *
 * Bands map to HUD_LAYOUT (art px), outside the space formations and the
 * player use. The overlay ignores pointer events. Updates touch only changed
 * nodes. One polite live region carries announcements.
 */
import { UI_SCALE } from '../config/devices.ts';
import { HUD_LABELS, HUD_LAYOUT, HUD_TIMING } from '../config/hud.ts';
import { PLAYFIELD_ART } from '../config/visual.ts';
import type { ActiveNotification, HudModel } from './presentation.ts';

export interface PlayfieldRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface HudOptions {
  /** Factory for one reserve-ship icon (e.g. a canvas with the player sprite). */
  readonly reserveIcon?: () => HTMLElement;
  /** Factory for one stage insignia icon of the given denomination. */
  readonly badgeIcon?: (value: number) => HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class Hud {
  readonly root: HTMLElement;
  private readonly scoreLabel: HTMLElement;
  private readonly scoreValue: HTMLElement;
  private readonly highLabel: HTMLElement;
  private readonly highValue: HTMLElement;
  private readonly ticker: HTMLElement;
  private readonly reserves: HTMLElement;
  private readonly reserveOverflow: HTMLElement;
  private readonly stageLabel: HTMLElement;
  private readonly stageValue: HTMLElement;
  private readonly dual: HTMLElement;
  private readonly badges: HTMLElement;
  private readonly pauseFlag: HTMLElement;
  private paused = false;
  private readonly center: HTMLElement;
  private readonly popups: HTMLElement;
  private readonly live: HTMLElement;
  private readonly options: HudOptions;
  private lastRect = '';
  private lastModel: HudModel | null = null;
  private renderedIcons = 0;
  private readonly notificationNodes = new Map<number, HTMLElement>();
  private readonly heat: HTMLElement;
  private readonly heatLabel: HTMLElement;
  private readonly heatFill: HTMLElement;
  private heatKey = '';
  /** Combat P03C: selected weapon readout (post-Wave-20 roster ships only). */
  private readonly wpn: HTMLElement;
  private readonly wpnName: HTMLElement;
  private readonly wpnState: HTMLElement;
  private readonly wpnNotice: HTMLElement;
  private wpnKey = '';

  constructor(container: HTMLElement, options: HudOptions = {}) {
    this.options = options;
    this.root = el('div', 'hud');
    const top = el('div', 'hud-band hud-top');
    top.style.height = `${(HUD_LAYOUT.topBand / PLAYFIELD_ART.height) * 100}%`;
    const left = el('div', 'hud-cell hud-cell-left');
    this.scoreLabel = el('span', 'hud-label hud-label-accent');
    this.scoreValue = el('span', 'hud-value');
    left.append(this.scoreLabel, this.scoreValue);
    const mid = el('div', 'hud-cell hud-cell-center');
    this.highLabel = el('span', 'hud-label hud-label-accent');
    this.highValue = el('span', 'hud-value');
    mid.append(this.highLabel, this.highValue);
    this.ticker = el('div', 'hud-cell hud-cell-right hud-ticker');
    this.pauseFlag = el('span', 'hud-pause-flag', HUD_LABELS.paused);
    this.pauseFlag.hidden = true;
    this.ticker.append(this.pauseFlag);
    top.append(left, mid, this.ticker);

    const bottom = el('div', 'hud-band hud-bottom');
    bottom.style.height = `${(HUD_LAYOUT.bottomBand / PLAYFIELD_ART.height) * 100}%`;
    this.reserves = el('div', 'hud-reserves');
    this.reserveOverflow = el('span', 'hud-overflow');
    const stage = el('div', 'hud-stage');
    this.dual = el('span', 'hud-dual');
    this.badges = el('span', 'hud-badges');
    this.stageLabel = el('span', 'hud-label');
    this.stageValue = el('span', 'hud-value');
    stage.append(this.dual, this.badges, this.stageLabel, this.stageValue);
    // weapon heat (TD-74): a small meter between the reserves and the stage, only during a run
    this.heat = el('div', 'hud-heat');
    this.heat.hidden = true;
    this.heatLabel = el('span', 'hud-heat-label', 'HEAT');
    const heatTrack = el('span', 'hud-heat-track');
    this.heatFill = el('span', 'hud-heat-fill');
    heatTrack.append(this.heatFill);
    this.heat.append(this.heatLabel, heatTrack);
    this.wpn = el('div', 'hud-wpn');
    this.wpn.hidden = true;
    this.wpnName = el('span', 'hud-wpn-name');
    this.wpnState = el('span', 'hud-wpn-state');
    this.wpnNotice = el('span', 'hud-wpn-notice');
    this.wpn.append(this.wpnName, this.wpnState, this.wpnNotice);
    bottom.append(this.reserves, this.heat, this.wpn, stage);

    this.center = el('div', 'hud-center');
    this.popups = el('div', 'hud-popups');
    this.live = el('div', 'visually-hidden');
    this.live.setAttribute('role', 'status');
    this.live.setAttribute('aria-live', 'polite');

    // Visual HUD is decorative for assistive tech; the live region and the
    // labelled summary (aria-label on root) carry the information.
    for (const n of [top, bottom, this.center, this.popups]) n.setAttribute('aria-hidden', 'true');
    this.root.append(top, bottom, this.center, this.popups, this.live);
    this.root.style.setProperty('--hud-fade', `${HUD_TIMING.fadeMs}ms`);
    this.root.style.setProperty('--hud-flash', `${HUD_TIMING.scoreFlashMs}ms`);
    container.append(this.root);
  }

  /**
   * Weapon heat meter (TD-74). `level` 0..1; `overheated` shows OVERHEAT (text,
   * not colour alone). Hidden outside a run. Touches the DOM only on change.
   */
  setHeat(level: number, overheated: boolean, visible: boolean): void {
    const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
    const key = visible ? `${pct}|${overheated}` : 'off';
    if (key === this.heatKey) return;
    this.heatKey = key;
    this.heat.hidden = !visible;
    if (!visible) return;
    this.heatFill.style.width = `${pct}%`;
    this.heat.classList.toggle('is-hot', !overheated && pct >= 70);
    this.heat.classList.toggle('is-overheated', overheated);
    const label = overheated ? 'OVERHEAT' : 'HEAT';
    if (this.heatLabel.textContent !== label) this.heatLabel.textContent = label;
  }

  /** Align the overlay with the playfield's on-screen rectangle (CSS px, relative to the container). */
  setPlayfieldRect(r: PlayfieldRect): void {
    const key = `${r.left}|${r.top}|${r.width}|${r.height}`;
    if (key === this.lastRect) return;
    this.lastRect = key;
    const s = this.root.style;
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    // 1 arcade unit (2 art px) in CSS px: all HUD type scales with the playfield.
    const u = (r.width / PLAYFIELD_ART.width) * 2;
    s.setProperty('--u', `${u}px`);
    // text unit with a floor: HUD text stays readable on small playfields
    s.setProperty('--ut', `${Math.max(u, UI_SCALE.hudTextMinUnit)}px`);
  }

  /**
   * P03C weapon readout: the selected weapon, its ammo / cooldown / lock and a
   * short notice. Shown while a missile weapon is selected (the gun keeps the
   * heat meter, and a brief notice if a press was refused). DOM only on change.
   */
  setWeapon(view: { readonly name: string; readonly state: string; readonly ready: boolean; readonly gun: boolean; readonly notice: string } | null, visible: boolean): void {
    const show = visible && view !== null && (!view.gun || view.notice !== '');
    const key = show && view ? `${view.name}|${view.state}|${view.ready}|${view.notice}|${view.gun}` : 'off';
    if (key === this.wpnKey) return;
    this.wpnKey = key;
    this.wpn.hidden = !show;
    if (!show || !view) return;
    this.wpnName.textContent = view.name;
    // a refusal notice (1 s) takes the state's place, so the readout stays short on a 320 px phone
    this.wpnState.textContent = view.gun || view.notice ? '' : view.state;
    this.wpnNotice.textContent = view.notice;
    this.wpn.classList.toggle('is-unready', !view.ready);
  }

  update(model: HudModel): void {
    const prev = this.lastModel;
    if (!prev || prev.score.text !== model.score.text) {
      this.scoreLabel.textContent = model.score.label;
      this.scoreValue.textContent = model.score.text;
      if (prev) this.flash(this.scoreValue);
    }
    if (!prev || prev.highScore.text !== model.highScore.text || prev.highScore.isPlayers !== model.highScore.isPlayers) {
      this.highLabel.textContent = model.highScore.label;
      this.highValue.textContent = model.highScore.text;
      this.highValue.classList.toggle('hud-value-live', model.highScore.isPlayers);
    }
    if (!prev || prev.reserves.icons !== model.reserves.icons || prev.reserves.overflowText !== model.reserves.overflowText) {
      this.renderReserves(model.reserves.icons, model.reserves.overflowText);
    }
    if (!prev || prev.stage.text !== model.stage.text || prev.stage.label !== model.stage.label || prev.dualFighter !== model.dualFighter) {
      this.stageLabel.textContent = model.stage.text ? model.stage.label : '';
      this.stageValue.textContent = model.stage.text;
      // fighter mode is always visible during a game: SINGLE (dim) or TWIN (highlight)
      this.dual.textContent = model.dualFighter ? HUD_LABELS.dual : model.stage.text ? HUD_LABELS.single : '';
      this.dual.classList.toggle('hud-dual-single', !model.dualFighter);
    }
    if (!prev || prev.stage.number !== model.stage.number) this.renderBadges(model);
    this.root.setAttribute(
      'aria-label',
      `Score ${model.score.value}. High score ${model.highScore.value}. ${model.reserves.count} fighters in reserve. ${model.stage.text ? `${model.stage.label} ${model.stage.text}.` : ''}`,
    );
    this.lastModel = model;
  }

  /** Hide centre interstitials while a menu panel occupies the middle of the field. */
  setMenuOpen(open: boolean): void {
    this.root.classList.toggle('hud-menu-open', open);
  }

  /** Show or hide the PAUSED flag in the top band. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.pauseFlag.hidden = !paused;
    this.root.classList.toggle('hud-is-paused', paused);
    if (paused) this.announce('Paused');
  }

  private renderBadges(model: HudModel): void {
    const make = this.options.badgeIcon;
    const nodes: HTMLElement[] = [];
    if (make) {
      outer: for (const b of model.stage.badges) {
        for (let i = 0; i < b.count; i++) {
          if (nodes.length >= HUD_LAYOUT.maxBadgeIcons) break outer;
          const n = make(b.value);
          n.classList.add('hud-badge');
          n.dataset['value'] = String(b.value);
          nodes.push(n);
        }
      }
    }
    this.badges.replaceChildren(...nodes);
  }

  /** Render active notifications (call every frame; cheap when nothing changes). */
  showNotifications(active: readonly ActiveNotification[]): void {
    const seen = new Set<number>();
    for (const n of active) {
      seen.add(n.id);
      let node = this.notificationNodes.get(n.id);
      if (!node) {
        node = el('div', `hud-note hud-note-${n.placement} hud-tone-${n.tone}`);
        node.dataset['kind'] = n.kind;
        if (n.placement === 'popup' && n.position) {
          node.style.left = `${(n.position.x / PLAYFIELD_ART.width) * 100}%`;
          node.style.top = `${(n.position.y / PLAYFIELD_ART.height) * 100}%`;
        }
        const parent = n.placement === 'ticker' ? this.ticker : n.placement === 'center' ? this.center : this.popups;
        parent.append(node);
        this.notificationNodes.set(n.id, node);
        if (n.announce) this.announce(n.announce);
      }
      const text = n.visibleLines.join('\n');
      if (node.dataset['text'] !== text) {
        node.dataset['text'] = text;
        node.replaceChildren(...n.visibleLines.map((line) => el('span', 'hud-note-line', line)));
      }
      node.classList.toggle('hud-blink-off', !n.blinkOn);
    }
    for (const [id, node] of this.notificationNodes) {
      if (!seen.has(id)) {
        node.remove();
        this.notificationNodes.delete(id);
      }
    }
  }

  announce(text: string): void {
    // Re-setting identical text may not be re-announced; append a zero-width marker toggle.
    this.live.textContent = this.live.textContent === text ? `${text}\u200b` : text;
  }

  clearNotifications(): void {
    this.showNotifications([]);
  }

  private renderReserves(icons: number, overflow: string | null): void {
    if (icons !== this.renderedIcons) {
      const nodes: HTMLElement[] = [];
      for (let i = 0; i < icons; i++) {
        const icon = this.options.reserveIcon ? this.options.reserveIcon() : el('span', 'hud-reserve-pip');
        icon.classList.add('hud-reserve');
        nodes.push(icon);
      }
      this.reserves.replaceChildren(...nodes, this.reserveOverflow);
      this.renderedIcons = icons;
    }
    this.reserveOverflow.textContent = overflow ?? '';
  }

  private flash(node: HTMLElement): void {
    node.classList.remove('hud-flash');
    // Force restyle so the animation restarts on rapid updates.
    void node.offsetWidth;
    node.classList.add('hud-flash');
  }
}
