/**
 * Combat HUD view (DOM, Free Roam chunk). Renders combat/hudModel.ts each
 * frame, touching the DOM only when the text or a bar actually changes:
 *  - a warning banner (text + tone class; the tone is never the only cue);
 *  - the active encounter's objective line;
 *  - the boss bar of an elite or capital ship (name, shield and hull).
 * The flight root carries `data-combat="calm|alert|engaged"` for styling.
 */
import type { CombatHudModel } from './combat/hudModel.ts';
import { el } from './progression/ui/common.ts';

export interface CombatHudView {
  readonly root: HTMLElement;
  render(m: CombatHudModel | null): void;
}

export function createCombatHud(host: HTMLElement): CombatHudView {
  const root = el('div', 'fr-combat');
  const bannerEl = el('p', 'fr-alert');
  bannerEl.setAttribute('role', 'alert');
  bannerEl.hidden = true;
  const objectiveEl = el('p', 'fr-objective');
  objectiveEl.setAttribute('aria-live', 'polite');
  objectiveEl.hidden = true;
  const bossEl = el('div', 'fr-boss');
  bossEl.setAttribute('role', 'img');
  bossEl.hidden = true;
  const bossName = el('span', 'fr-boss-name');
  const bar = (cls: string): HTMLElement => {
    const b = el('span', `fr-boss-bar ${cls}`);
    const fill = el('span', 'fr-boss-fill');
    b.append(fill);
    bossEl.append(b);
    return fill;
  };
  bossEl.append(bossName);
  const shieldFill = bar('fr-boss-shield');
  const hullFill = bar('fr-boss-hull');
  root.append(objectiveEl, bossEl);
  host.append(bannerEl, root);

  let last = '';
  return {
    root,
    render(m) {
      const key = m ? `${m.level}|${m.banner?.text ?? ''}|${m.objective ?? ''}|${m.boss ? `${m.boss.name}|${Math.round(m.boss.hull * 200)}|${Math.round(m.boss.shield * 200)}|${m.boss.phase2}` : ''}` : '';
      if (key === last) return;
      last = key;
      host.dataset['combat'] = m?.level ?? 'calm';
      const b = m?.banner ?? null;
      bannerEl.hidden = !b;
      if (b) {
        if (bannerEl.textContent !== b.text) bannerEl.textContent = b.text;
        bannerEl.dataset['tone'] = b.tone;
      }
      const o = m?.objective ?? null;
      objectiveEl.hidden = !o;
      if (o && objectiveEl.textContent !== o) objectiveEl.textContent = o;
      const boss = m?.boss ?? null;
      bossEl.hidden = !boss;
      if (boss) {
        bossName.textContent = boss.phase2 ? `${boss.name} · FULL ARMS` : boss.name;
        shieldFill.style.width = `${Math.round(boss.shield * 100)}%`;
        hullFill.style.width = `${Math.round(boss.hull * 100)}%`;
        bossEl.setAttribute('aria-label', `${boss.name}: shield ${Math.round(boss.shield * 100)}%, hull ${Math.round(boss.hull * 100)}%`);
      }
    },
  };
}
