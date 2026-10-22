/**
 * Classic menu focus stays visible (TD-77, release fixes).
 *
 * WebKit 320x568 touch, SETTINGS in Arcade Display: ArrowUp wraps the focus
 * to BACK, then the same key switches the layout to keyboard and the panel
 * shrinks (489 -> 475 -> 320 px tall) under a 528 px list. The reveal ran
 * before the shrink, so BACK stayed focused but clipped below the panel for
 * up to ~90 ms (the intermittent arcade-display "backReachable" failure).
 * The geometry below is the measured WebKit trace.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { revealInPanel, type RevealItem, type RevealPanel } from '../src/ui/screens.ts';

/** A scrolling panel whose item rectangles move with scrollTop, like the DOM. */
function panel(top: number, bottom: number, contentHeight: number, scrollTop = 0): RevealPanel & { item(offsetTop: number, h: number): RevealItem } {
  const p = {
    scrollTop,
    scrollHeight: contentHeight,
    clientHeight: bottom - top,
    getBoundingClientRect: () => ({ top, bottom }),
    item: (offsetTop: number, h: number): RevealItem => ({
      getBoundingClientRect: () => ({ top: top + offsetTop - p.scrollTop, bottom: top + offsetTop - p.scrollTop + h }),
    }),
  };
  return p;
}
const visible = (pn: RevealPanel, it: RevealItem): boolean => {
  const a = pn.getBoundingClientRect();
  const b = it.getBoundingClientRect();
  return b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5;
};

describe('revealInPanel', () => {
  it('first shrink of the WebKit trace: BACK (522.5-566.5) below a 51-528 panel is scrolled fully into view', () => {
    const pn = panel(51.1, 528.2, 528);
    const back = pn.item(522.5 - 51.1, 44);
    expect(visible(pn, back)).toBe(false);
    revealInPanel(pn, back);
    expect(visible(pn, back)).toBe(true);
  });

  it('final Arcade geometry (126.5-448.3, 528 px list): BACK ends inside the panel, as the browser settled', () => {
    const pn = panel(126.5, 448.3, 528);
    const back = pn.item(528 - 44 - 4, 44);
    revealInPanel(pn, back);
    expect(visible(pn, back)).toBe(true);
    expect(pn.scrollTop).toBeGreaterThan(150);
    expect(pn.scrollTop).toBeLessThanOrEqual(528 - (448.3 - 126.5) + 4);
  });

  it('an item above the visible part scrolls back up (wrapping down to the first item)', () => {
    const pn = panel(100, 400, 600, 250);
    const first = pn.item(10, 44);
    expect(visible(pn, first)).toBe(false);
    revealInPanel(pn, first);
    expect(visible(pn, first)).toBe(true);
  });

  it('a panel that fits (touch layout before the switch: 489 = 489) never scrolls; a visible item stays put', () => {
    const fits = panel(11.4, 500.4, 489);
    revealInPanel(fits, fits.item(450, 44));
    expect(fits.scrollTop).toBe(0);
    const pn = panel(0, 300, 600, 100);
    revealInPanel(pn, pn.item(150, 44));
    expect(pn.scrollTop).toBe(100);
  });
});

describe('the open panel keeps its focused item in view on every resize (source rules)', () => {
  const src = readFileSync(new URL('../src/ui/screens.ts', import.meta.url), 'utf8');
  it('Screens observes every panel box and reveals the focused item from the observer and from setPlayfieldRect', () => {
    expect(src).toMatch(/new ResizeObserver\(\(\) => this\.revealFocused\(\)\)/);
    expect(src).toMatch(/for \(const p of Object\.values\(this\.panels\)\) this\.focusObserver\.observe\(p\)/);
    expect(src).toMatch(/applyGeometry[\s\S]*this\.revealFocused\(\);/);
    expect(src).toMatch(/this\.focusObserver\?\.disconnect\(\)/);
  });
  it('menu keys still scroll with revealInPanel, and focus() never scrolls the page (preventScroll)', () => {
    expect(src).toMatch(/target\.focus\(\{ preventScroll: true \}\);\s*revealInPanel\(this\.panels\[this\.current\], target\);/);
  });
});
