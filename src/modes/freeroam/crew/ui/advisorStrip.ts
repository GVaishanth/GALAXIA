/**
 * Advisor strip (P05.2, P05.3): the one compact line where the Ship Mind and
 * the crew speak in flight. DOM only: what to say, when and how urgently comes
 * from crew/advisor.ts (advisorView); this file decides nothing and owns no
 * timer, frame callback or listener (the shell calls `render` from its frame).
 *
 *  - Drawn as a corner-log line (styles.css .fr-feed-line: edge, tone, type
 *    and its short fade-in, which reduced motion turns off); the head uses the
 *    notice card's kicker type. styles.css .fr-advice only places it.
 *  - Never takes input: `pointer-events: none`, no buttons, never focusable,
 *    so it cannot cover or steal a touch from the joystick, FIRE, BOOST, LOCK
 *    or STOP (styles.css places it clear of them on phones).
 *  - Level is never colour alone: an icon (◆ critical, ▲ warning, ● info,
 *    ○ note) and the level word lead the line; the speaker is named; the edge
 *    tone repeats it (critical is also dashed).
 *  - Screen readers: a polite live region; critical messages are assertive.
 *    Hidden means `hidden` (gone for assistive tech too).
 *  - No sound: the existing notices and combat banner keep their own.
 */
import { el } from '../../progression/ui/common.ts';
import type { AdviceLevel, AdvisorView } from '../advisor.ts';

/** Icon, word and the corner-log tone of each level (styles.css .fr-feed-line.is-*; critical's edge is also dashed). */
export const LEVEL_MARK: Readonly<Record<AdviceLevel, { readonly icon: string; readonly word: string; readonly tone: string }>> = Object.freeze({
  critical: { icon: '◆', word: 'CRITICAL', tone: 'is-warn' },
  warning: { icon: '▲', word: 'WARNING', tone: 'is-caution' },
  info: { icon: '●', word: 'INFO', tone: 'is-gain' },
  optional: { icon: '○', word: 'NOTE', tone: 'is-info' },
});

export interface AdvisorStrip {
  readonly root: HTMLElement;
  /** Show this view (null = hide). Cheap when nothing changed. */
  render(v: AdvisorView | null): void;
  /** What is on screen (QA). */
  status(): { readonly visible: boolean; readonly level: AdviceLevel | null; readonly source: string | null; readonly speaker: string; readonly text: string };
}

export function createAdvisorStrip(parent: HTMLElement): AdvisorStrip {
  const root = el('div', 'fr-advice fr-feed-line');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-atomic', 'true');
  root.hidden = true;
  const icon = el('span', 'fr-advice-icon');
  icon.setAttribute('aria-hidden', 'true');
  // level word and speaker on the head line (the notice kicker type), the advice under it
  const head = el('div', 'fr-notice-kicker fr-advice-head');
  const level = el('span', 'fr-advice-level');
  const who = el('span', 'fr-advice-who');
  head.append(level, who);
  const text = el('div', 'fr-advice-text');
  const body = el('div', 'fr-advice-body');
  body.append(head, text);
  root.append(icon, body);
  parent.append(root);

  let tone = '';
  let serial = -1;
  let shown: AdvisorView | null = null;
  return {
    root,
    render(v) {
      if (v === null) {
        if (shown === null) return;
        shown = null;
        serial = -1;
        root.hidden = true;
        return;
      }
      if (v.serial === serial) return;
      serial = v.serial;
      shown = v;
      const m = LEVEL_MARK[v.level];
      root.setAttribute('aria-live', v.level === 'critical' ? 'assertive' : 'polite');
      root.dataset['level'] = v.level;
      root.dataset['source'] = v.source;
      if (tone !== m.tone) {
        if (tone) root.classList.remove(tone);
        root.classList.add(m.tone);
        tone = m.tone;
      }
      icon.textContent = m.icon;
      level.textContent = `${m.word} · `;
      who.textContent = v.speaker;
      text.textContent = v.text;
      root.hidden = false;
    },
    status: () => ({ visible: shown !== null, level: shown?.level ?? null, source: shown?.source ?? null, speaker: shown?.speaker ?? '', text: shown?.text ?? '' }),
  };
}
