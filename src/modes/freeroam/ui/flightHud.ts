/**
 * Flight HUD view (Prompt 12). DOM only: renders ui/hudModel.ts and the notice
 * queue, touching the DOM only when something visible changed.
 *
 * Layout (CSS places it; phones restack it):
 *  - top left: the ship card (ship, weapon state, SHIELD / HULL / ENERGY bars
 *    with numbers, so no reading depends on colour), then the cargo chip;
 *  - top centre: the system and its survey state, then the tracked objective;
 *    the notice card sits under them (the combat banner takes that slot in a
 *    fight, and notices go to the corner log meanwhile);
 *  - top right: MAP / CARGO / pause (the shell's buttons), then the combat
 *    objective and boss bar (combatHud.ts);
 *  - bottom centre: the interaction prompt, or the nearby chip when nothing is
 *    in range.
 * The flight root gets `data-danger="critical"` (hull low) and
 * `data-loc="compact"` (combat) for styling.
 */
import { NOTICE, type Notice } from './notices.ts';
import type { HudView, ShipCard } from './hudModel.ts';
import type { Motion } from './motion.ts';

export interface LocationLine {
  readonly name: string;
  readonly galaxy: string;
  readonly survey: string;
  readonly surveyed: boolean;
}

export interface HudFrame {
  readonly card: ShipCard;
  readonly location: LocationLine;
  readonly view: HudView;
  readonly objective: string | null;
  readonly objectiveHere: boolean;
  readonly cargo: string;
  readonly notice: Notice | null;
}

export interface FlightHud {
  /** Ship card (top left; also carries the legacy `fr-gauges` class). */
  readonly card: HTMLElement;
  readonly location: HTMLElement;
  readonly mission: HTMLElement;
  readonly cargo: HTMLElement;
  readonly nearby: HTMLElement;
  /** Notice card (also carries the legacy `fr-toast` class). */
  readonly notice: HTMLElement;
  render(f: HudFrame): void;
  /** What is visible now (diagnostics and tests). */
  status(): { readonly cargo: string; readonly objective: string; readonly nearby: string | null; readonly notice: string | null; readonly location: string; readonly critical: boolean; readonly weapon: string };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  n.className = cls;
  if (text) n.textContent = text;
  return n;
};
const setText = (n: HTMLElement, t: string): void => {
  if (n.textContent !== t) n.textContent = t;
};

export function createFlightHud(host: HTMLElement, motion: Motion): FlightHud {
  // ship card
  const card = el('div', 'fr-shipcard fr-gauges');
  card.setAttribute('role', 'img');
  const head = el('div', 'fr-shipcard-head');
  const shipName = el('span', 'fr-gauge-ship fr-ship-name');
  const weapon = el('span', 'fr-weapon');
  head.append(shipName, weapon);
  card.append(head);
  const bar = (name: string, cls: string): { row: HTMLElement; fill: HTMLElement; value: HTMLElement } => {
    const row = el('div', `fr-meter ${cls}`);
    const track = el('span', 'fr-meter-track');
    const fill = el('span', 'fr-meter-fill');
    track.append(fill);
    const value = el('span', 'fr-meter-value');
    row.append(el('span', 'fr-meter-label', name), track, value);
    card.append(row);
    return { row, fill, value };
  };
  const shield = bar('SHIELD', 'fr-meter-shield');
  const hull = bar('HULL', 'fr-meter-hull fr-gauge-hull');
  const energy = bar('ENERGY', 'fr-meter-energy fr-gauge-energy');
  const heat = bar('HEAT', 'fr-meter-heat'); // weapon heat (FR-TD-79)

  // location + objective
  const location = el('div', 'fr-loc');
  const locName = el('span', 'fr-loc-name');
  const locGalaxy = el('span', 'fr-loc-galaxy');
  const survey = el('span', 'fr-survey');
  location.append(locName, locGalaxy, survey);
  const mission = el('p', 'fr-hud-mission');
  mission.hidden = true;
  mission.setAttribute('aria-live', 'polite');
  const top = el('div', 'fr-top');
  top.append(location, mission);

  const cargo = el('p', 'fr-cargochip');
  cargo.hidden = true;
  const nearby = el('p', 'fr-nearby');
  nearby.hidden = true;

  const notice = el('div', 'fr-notice fr-toast');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const nKicker = el('span', 'fr-notice-kicker');
  const nTitle = el('span', 'fr-notice-title');
  const nDetail = el('span', 'fr-notice-detail');
  notice.append(nKicker, nTitle, nDetail);

  host.append(card, top, cargo, nearby, notice);

  let cardKey = '';
  let locKey = '';
  let objKey = '';
  let cargoKey = '';
  let nearKey = '';
  let noticeId = 0;
  let rootKey = '';
  const paint = (b: { row: HTMLElement; fill: HTMLElement; value: HTMLElement }, g: { pct: number; text: string; low: boolean }): void => {
    b.fill.style.width = `${g.pct}%`;
    setText(b.value, g.text);
    b.row.classList.toggle('is-low', g.low);
  };

  return {
    card,
    location,
    mission,
    cargo,
    nearby,
    notice,
    render(f) {
      const c = f.card;
      if (c.key !== cardKey) {
        cardKey = c.key;
        setText(shipName, c.ship);
        setText(weapon, `${c.weapon} · ${c.weaponText}`);
        weapon.dataset['state'] = c.weaponState;
        paint(shield, c.shield);
        paint(hull, c.hull);
        paint(energy, c.energy);
        paint(heat, c.heat);
        heat.row.classList.toggle('is-overheated', c.weaponState === 'overheated');
        card.classList.toggle('is-boosting', c.boosting);
        card.classList.toggle('is-damaged', c.hull.low);
        card.setAttribute('aria-label', c.label);
      }
      const v = f.view;
      const rk = `${v.critical}|${v.location}|${v.hint}`;
      if (rk !== rootKey) {
        rootKey = rk;
        if (v.critical) host.dataset['danger'] = 'critical';
        else delete host.dataset['danger'];
        host.dataset['loc'] = v.location;
        host.dataset['hint'] = v.hint ? 'on' : 'off';
      }
      const lk = `${f.location.name}|${f.location.galaxy}|${f.location.survey}|${f.location.surveyed}`;
      if (lk !== locKey) {
        locKey = lk;
        setText(locName, f.location.name);
        setText(locGalaxy, f.location.galaxy);
        setText(survey, f.location.survey);
        survey.classList.toggle('is-done', f.location.surveyed);
      }
      const ok = v.objective === 'hidden' || !f.objective ? '' : `${v.objective}|${f.objective}|${f.objectiveHere}`;
      if (ok !== objKey) {
        const textChanged = !!f.objective && !objKey.endsWith(`|${f.objective}|${f.objectiveHere}`);
        objKey = ok;
        mission.hidden = !ok;
        if (ok && f.objective) {
          setText(mission, `◆ ${f.objective}`);
          mission.dataset['mode'] = v.objective;
          mission.classList.toggle('is-here', f.objectiveHere);
          if (textChanged && v.objective === 'full') motion.play(mission, 'flash', { channel: 'flash' });
        }
      }
      const ck = v.cargo === 'hidden' ? '' : `${v.cargo}|${f.cargo}`;
      if (ck !== cargoKey) {
        const appeared = !cargoKey && !!ck;
        cargoKey = ck;
        cargo.hidden = !ck;
        if (ck) {
          setText(cargo, v.cargo === 'warn' ? `${f.cargo} · CHECK HOLD` : f.cargo);
          cargo.dataset['state'] = v.cargo;
          if (appeared) motion.play(cargo, 'fade');
          else motion.play(cargo, 'flash', { channel: 'flash' });
        }
      }
      const n = v.nearby;
      const nk = n ? `${n.id}|${n.arrow}` : '';
      if (nk !== nearKey) {
        nearKey = nk;
        nearby.hidden = !n;
        if (n) {
          setText(nearby, `NEARBY · ${n.arrow} ${n.label.toUpperCase()}`);
          nearby.setAttribute('aria-label', `Nearby: ${n.label}`);
        }
      }
      const nt = f.notice;
      if ((nt?.id ?? 0) !== noticeId) {
        noticeId = nt?.id ?? 0;
        notice.hidden = !nt;
        if (nt) {
          notice.dataset['kind'] = nt.kind;
          const k = NOTICE.kicker[nt.kind];
          setText(nKicker, k);
          nKicker.hidden = !k;
          setText(nTitle, nt.title);
          setText(nDetail, nt.detail);
          nDetail.hidden = !nt.detail;
          motion.play(notice, nt.kind === 'mission' || nt.kind === 'upgrade' ? 'pop' : 'rise');
        }
      }
    },
    status() {
      return {
        cargo: cargo.hidden ? '' : cargo.textContent ?? '',
        objective: mission.hidden ? '' : `${mission.dataset['mode'] ?? ''}:${mission.textContent ?? ''}`,
        nearby: nearby.hidden ? null : nearby.textContent,
        notice: notice.hidden ? null : notice.textContent,
        location: location.textContent ?? '',
        critical: host.dataset['danger'] === 'critical',
        weapon: weapon.textContent ?? '',
      };
    },
  };
}
