/**
 * In-flight collection UI (Free Roam Prompt 10). DOM only.
 *
 *  - LootFeed: a short log in the bottom-left corner (at most four lines,
 *    each fading after a few seconds; aria-live polite). Collection notices
 *    go here instead of the centre of the screen, so they never cover
 *    incoming fire. Pointer events pass through.
 *  - OfferPrompt: the non-blocking full-hold choice. Flight continues; the
 *    prompt sits low in the centre with three buttons (TAKE WHAT FITS / SWAP
 *    / LEAVE IT) and key hints. It closes by itself when the ship flies out
 *    of reach (the runtime drops the offer).
 */
import type { LootOffer } from '../../sector/collect.ts';
import { iconImg, lootIconKey } from './iconImages.ts';

export interface LootFeed {
  readonly root: HTMLElement;
  push(text: string, iconKey?: string, tone?: 'gain' | 'warn' | 'info'): void;
  /** Drop expired lines (call once per frame). */
  tick(nowMs: number): void;
  clear(): void;
  lines(): string[];
}

export const FEED_LINES = 4;
export const FEED_MS = 4500;

export function createLootFeed(now: () => number): LootFeed {
  const root = document.createElement('ul');
  root.className = 'fr-feed';
  root.setAttribute('role', 'log');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-label', 'Collection log');
  const until = new WeakMap<Element, number>();
  return {
    root,
    push(text, iconKey, tone = 'gain') {
      const li = document.createElement('li');
      li.className = `fr-feed-line is-${tone}`;
      if (iconKey) li.append(iconImg(iconKey, 'fr-icon fr-feed-icon'));
      const span = document.createElement('span');
      span.textContent = text;
      li.append(span);
      root.append(li);
      until.set(li, now() + FEED_MS);
      while (root.children.length > FEED_LINES) root.firstElementChild?.remove();
    },
    tick(nowMs) {
      for (const li of [...root.children]) if ((until.get(li) ?? 0) < nowMs) li.remove();
    },
    clear() {
      root.replaceChildren();
    },
    lines() {
      return [...root.children].map((li) => li.textContent ?? '');
    },
  };
}

export interface OfferHandlers {
  readonly take: () => void;
  readonly swap: () => void;
  readonly leave: () => void;
}

export interface OfferView {
  readonly root: HTMLElement;
  /** Show the offer (or hide with null). `swap` = whether SWAP would gain anything. */
  render(offer: LootOffer | null, swap: boolean, keys: { readonly take: string; readonly swap: string; readonly leave: string }, text: (o: LootOffer) => readonly [string, string]): void;
}

export function createOfferPrompt(h: OfferHandlers): OfferView {
  const root = document.createElement('div');
  root.className = 'fr-offer';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Hold full: choose what to do with the find');
  root.hidden = true;
  const head = document.createElement('p');
  head.className = 'fr-offer-text';
  head.setAttribute('role', 'status');
  const row = document.createElement('div');
  row.className = 'fr-offer-actions';
  const btn = (cls: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `fr-offer-btn ${cls}`;
    b.addEventListener('click', () => {
      fn();
      b.blur(); // keep Space / Enter for flight
    });
    row.append(b);
    return b;
  };
  const take = btn('fr-offer-take', h.take);
  const swap = btn('fr-offer-swap', h.swap);
  const leave = btn('fr-offer-leave', h.leave);
  root.append(head, row);
  /** Button label plus its keyboard shortcut in a separate span (hidden on touch-only devices). */
  const setLabel = (b: HTMLButtonElement, text: string, keyName: string): void => {
    // the first word always shows; the rest is dropped on short screens (CSS) to keep one row
    const [first, ...rest] = text.split(' ');
    b.replaceChildren(document.createTextNode(first ?? text));
    if (rest.length) {
      const more = document.createElement('span');
      more.className = 'fr-offer-more';
      more.textContent = ` ${rest.join(' ')}`;
      b.append(more);
    }
    if (keyName) {
      const k = document.createElement('span');
      k.className = 'fr-offer-key';
      k.textContent = ` · ${keyName}`;
      b.append(k);
    }
  };
  let key = '';
  return {
    root,
    render(o, canSwap, keys, text) {
      const k = o ? `${o.id}|${o.need}|${o.space}|${canSwap}|${keys.take}|${keys.swap}|${keys.leave}` : '';
      if (k === key) return;
      key = k;
      root.hidden = !o;
      if (!o) return;
      const [lead, detail] = text(o);
      const leadEl = document.createElement('span');
      leadEl.className = 'fr-offer-lead';
      leadEl.textContent = lead;
      const detailEl = document.createElement('span');
      detailEl.className = 'fr-offer-detail';
      detailEl.textContent = detail ? ` · ${detail}` : '';
      head.replaceChildren(iconImg(lootIconKey(o.loot), 'fr-icon fr-offer-icon'), leadEl, detailEl);
      setLabel(take, 'TAKE WHAT FITS', keys.take);
      take.disabled = o.space <= 0;
      take.setAttribute('aria-label', o.space > 0 ? `Take what fits: ${o.space} of ${o.need} units` : 'Take what fits: no free space');
      setLabel(swap, 'SWAP', keys.swap);
      swap.disabled = !canSwap;
      swap.setAttribute('aria-label', canSwap ? 'Swap: jettison cheaper cargo as a pod and take the more valuable find' : 'Swap: nothing cheaper in the hold');
      setLabel(leave, 'LEAVE IT', keys.leave);
      leave.setAttribute('aria-label', 'Leave it: the find stays here and is marked on the sector map');
    },
  };
}
