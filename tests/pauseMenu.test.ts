/**
 * Pause menu refinement: RESUME and RESTART FLIGHT on top, the other eight actions in three
 * disclosure groups. The menu is DOM code inside freeRoamMode.ts (no jsdom in this project), so
 * these are source-level guards; the behaviour itself is exercised in a real browser by
 * docs/development/playtest/pause-menu-groups.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shell = readFileSync(resolve(root, 'src/modes/freeroam/freeRoamMode.ts'), 'utf8');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');

const block = ((): string => {
  const a = shell.indexOf('/* ---------------------------- pause menu groups');
  const b = shell.indexOf('const buildPanel = (', a);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return shell.slice(a, b);
})();

describe('pause menu: every original action, unchanged handler', () => {
  it('RESUME and RESTART FLIGHT stay at the top level', () => {
    expect(block).toContain("pauseButton('fr-pause-resume', 'RESUME', actions.resume)");
    expect(block).toContain("pauseButton('fr-pause-restart', 'RESTART FLIGHT', openRestartAsk)");
  });

  it('the three groups hold exactly the requested actions, each wired to the handler it had before', () => {
    expect(block).toContain("{ id: 'progress', label: 'MISSIONS & PROGRESS', items: [['MISSIONS', () => actions.log('missions')], ['RECORD', () => actions.log('record')], ['SAVES', openSaves]] }");
    expect(block).toContain("{ id: 'settings', label: 'SETTINGS & HELP', items: [['CONTROLS', actions.controls], ['HOW TO PLAY', actions.howTo], ['SOUND', actions.sound]] }");
    expect(block).toContain("{ id: 'navigation', label: 'NAVIGATION', items: [['GALAXY MAP', actions.openMap], ['MAIN MENU', actions.exit]] }");
  });

  it('the old flat list is gone (no action is listed twice)', () => {
    expect(shell).toContain("pause: buildPanel('pause', 'FREE ROAM', 'PAUSED', [(pauseInfo = el('p', 'fr-stats fr-pause-info'))], []),");
    expect(shell.match(/\['HOW TO PLAY', actions\.howTo\]/g)).toHaveLength(1);
    expect(shell.match(/\['MAIN MENU', actions\.exit\]/g)).toHaveLength(1);
  });
});

describe('pause menu: disclosure groups', () => {
  it('group rows are buttons with aria-expanded / aria-controls; their actions are a labelled group, hidden when closed', () => {
    expect(block).toContain("head.setAttribute('aria-expanded', 'false')");
    expect(block).toContain("head.setAttribute('aria-controls', `fr-pause-${d.id}-items`)");
    expect(block).toContain("body.setAttribute('role', 'group')");
    expect(block).toContain("body.setAttribute('aria-labelledby', head.id)");
    expect(block).toContain('g.body.hidden = !open;'); // hidden groups also drop out of MenuList's arrow order
  });

  it('one group open at a time; activating the open group closes it', () => {
    expect(block).toContain('pauseOpen = pauseOpen === id ? null : id;');
  });

  it('a pointer click that is the tail of a double click on the row cannot trigger a revealed action (keyboard never delayed)', () => {
    expect(block).toMatch(/e\.detail > 0 && performance\.now\(\) - pauseOpenedAt < PAUSE_REVEAL_GUARD_MS/);
  });

  it('every fresh pause starts compact; returning from a submenu focuses the action that opened it', () => {
    expect(shell).toMatch(/pauseOpen = null;\s*pauseReturn = null;\s*paintPauseGroups\(\);\s*showPanel\('pause'\);/);
    expect(shell).toContain("if (p === 'pause' && pauseReturn && pauseReturn.isConnected && !pauseReturn.closest('[hidden]')) pauseReturn.focus({ preventScroll: true });");
  });

  it('the menu code never steps, pauses or resumes the simulation and has no admin entry', () => {
    for (const forbidden of ['stepSector', 'pauseSector', 'resumeSector', 'requestAnimationFrame', 'setTimeout', 'setInterval', 'admin', 'ADMIN']) expect(block).not.toContain(forbidden);
  });
});

describe('pause menu: RESTART FLIGHT asks first', () => {
  it('confirming uses the existing restart path, unchanged', () => {
    expect(block).toMatch(/function confirmRestart\(\): void \{[\s\S]*?actions\.restart\(\); \/\/ the existing restart path, unchanged/);
  });

  it('R in the pause menu asks (R again confirms); the survey-complete panel keeps its direct R restart', () => {
    expect(shell).toContain("else if (c === 'restart' && panel === 'pause') {");
    expect(shell).toContain('if (restartAsk.hidden) openRestartAsk();');
    expect(shell).toContain("} else if (c === 'restart' && panel === 'complete') actions.restart();");
    expect(shell).not.toContain("else if (c === 'restart' && (panel === 'pause' || panel === 'complete')) actions.restart();");
  });

  it('Esc closes the question instead of resuming; the question never survives leaving the pause menu', () => {
    expect(shell).toContain("else if (panel === 'pause' && !restartAsk.hidden) closeRestartAsk(true);");
    expect(shell).toContain("if (p !== 'pause') closeRestartAsk(false);");
  });

  it('the question defaults to CANCEL', () => {
    expect(block).toContain('restartNo.focus({ preventScroll: true }); // the safe choice is under the cursor');
  });
});

describe('pause menu: styles', () => {
  it('reveals respect reduced motion (system setting and the game setting)', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.fr-pause-ask,\s*\.fr-pause-items \{\s*animation: none;/);
    expect(css).toMatch(/\.freeroam-app\[data-motion='reduced'\] \.fr-pause-ask,\s*\.freeroam-app\[data-motion='reduced'\] \.fr-pause-items \{\s*animation: none;/);
  });

  it('the card is anchored at the top so opening a group never moves the rows above it', () => {
    expect(css).toMatch(/\.fr-panel\.fr-panel-pause \{[^}]*align-self: start;/);
  });

  it('closed groups are display:none (not just visually hidden)', () => {
    expect(css).toMatch(/\.fr-pause-items\[hidden\] \{\s*display: none;/);
    expect(css).toMatch(/\.fr-pause-ask\[hidden\] \{\s*display: none;/);
  });
});
