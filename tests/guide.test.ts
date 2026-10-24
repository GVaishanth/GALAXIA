/**
 * P04.2 guide: first-run tutorial and HOW TO PLAY guide (src/modes/guide).
 *
 *  - state: versioned, separate record; finishing / skipping writes only `galaxia:guide`;
 *  - content: built from the real bindings, armory catalogue, ship roster and
 *    marks ledger, so it cannot drift from what the game does;
 *  - mode / input awareness, the Classic Wave 20 gate, touch without keyboard keys;
 *  - no developer-tool wording anywhere in the player-facing text.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/persistence/storage.ts';
import { STORAGE_KEYS } from '../src/shared/persistence/namespaces.ts';
import { acknowledgeGuide, GUIDE_SPEC, GUIDE_VERSION, guideDue, readGuide } from '../src/modes/guide/guideState.ts';
import {
  classicController,
  classicKeyboard,
  classicTouch,
  controlRows,
  customBindings,
  DEFAULT_GUIDE_CONTEXT,
  freeRoamController,
  freeRoamKeyboard,
  freeRoamTouch,
  GUIDE_INPUTS,
  GUIDE_MODES,
  GUIDE_STEPS,
  guideStep,
  MARKS_GLYPH,
  stepText,
  type ControlRow,
  type GuideContext,
} from '../src/modes/guide/guideContent.ts';
import { DEFAULT_BINDINGS, keyLabel, type Bindings } from '../src/modes/freeroam/bindings.ts';
import { formatMarks, insufficientText, MARKS } from '../src/modes/freeroam/progression/ledger.ts';
import { shipsFor } from '../src/modes/freeroam/ships/armory.ts';
import { SHIP_BY_ID, STARTER_SHIP } from '../src/modes/freeroam/ships/roster.ts';
import { PRIMARY_WEAPON, WEAPONS } from '../src/config/weapons.ts';
import { OWNER_IDENTITY, WELCOME_LINE } from '../src/modes/freeroam/admin/login.ts';

const ctx = (over: Partial<GuideContext> = {}): GuideContext => ({ ...DEFAULT_GUIDE_CONTEXT, ...over });
const row = (rows: readonly ControlRow[], id: string): ControlRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};
const keysOf = (r: ControlRow): string[] => r.keys.flat();
/** Every context the guide can show. */
const ALL: GuideContext[] = GUIDE_MODES.flatMap((mode) => GUIDE_INPUTS.flatMap((input) => [false, true].map((classicGate) => ctx({ mode, input, classicGate }))));
const allText = (): string =>
  ALL.flatMap((c) => GUIDE_STEPS.flatMap((id) => [stepText(guideStep(id, c, true)), stepText(guideStep(id, c, false))])).join('\n');

describe('guide state (galaxia:guide)', () => {
  it('is due on a fresh profile and stops after finishing or skipping', () => {
    for (const how of ['completed', 'skipped'] as const) {
      const store = new MemoryStore();
      expect(guideDue(readGuide(store))).toBe(true);
      expect(acknowledgeGuide(store, how)).toBe(true);
      expect(readGuide(store)).toEqual({ seen: GUIDE_VERSION, outcome: how });
      expect(guideDue(readGuide(store))).toBe(false);
    }
  });

  it('has its own namespaced key and a versioned envelope', () => {
    expect(GUIDE_SPEC.key).toBe(STORAGE_KEYS.guide);
    expect(STORAGE_KEYS.guide).toBe('galaxia:guide');
    const store = new MemoryStore();
    acknowledgeGuide(store, 'completed');
    const doc = JSON.parse(store.read('galaxia:guide')!) as Record<string, unknown>;
    expect(doc['version']).toBe(GUIDE_SPEC.version);
  });

  it('writes nothing but its own record (no ships, marks, achievements or unlocks)', () => {
    const store = new MemoryStore();
    const seeded: Record<string, string> = {
      'galaxia:save': '{"version":3,"highScore":51230}',
      'galaxia:prefs': '{"version":1,"audio":{"muted":true}}',
      'galaxia:fleet': '{"version":1,"classicComplete":false,"ships":["petrel"],"classicShip":null}',
      'galaxia:freeroam:slot:1': '{"version":12,"marks":1240,"ships":["petrel"]}',
      'galaxia:freeroam:prefs': '{"version":1}',
    };
    for (const [k, v] of Object.entries(seeded)) store.write(k, v);
    const writes: string[] = [];
    const spy = { persistent: false, read: (k: string) => store.read(k), write: (k: string, v: string) => (writes.push(k), store.write(k, v)), remove: (k: string) => (writes.push(`-${k}`), store.remove(k)) };
    readGuide(spy);
    guideDue(readGuide(spy));
    expect(writes).toEqual([]); // reading never writes
    acknowledgeGuide(spy, 'skipped');
    acknowledgeGuide(spy, 'completed');
    expect(new Set(writes)).toEqual(new Set(['galaxia:guide']));
    for (const [k, v] of Object.entries(seeded)) expect(store.read(k)).toBe(v);
  });

  it('a raised guide version shows the tutorial again; an older build never overwrites a newer record', () => {
    const store = new MemoryStore();
    acknowledgeGuide(store, 'completed', 1);
    expect(guideDue(readGuide(store), 1)).toBe(false);
    expect(guideDue(readGuide(store), 2)).toBe(true); // a future control change re-shows it
    acknowledgeGuide(store, 'skipped', 2);
    expect(readGuide(store)).toEqual({ seen: 2, outcome: 'skipped' });
    acknowledgeGuide(store, 'completed', 1); // an older build
    expect(readGuide(store)).toEqual({ seen: 2, outcome: 'skipped' });
  });

  it('damaged or inconsistent records read as never seen, without throwing', () => {
    const store = new MemoryStore();
    for (const raw of ['not json', '[]', '{"version":1,"seen":"x","outcome":"completed"}', '{"version":1,"seen":1,"outcome":"none"}', '{"version":1,"seen":0,"outcome":"completed"}', '{"version":1,"seen":-3,"outcome":"skipped"}']) {
      store.write('galaxia:guide', raw);
      expect(readGuide(store)).toEqual({ seen: 0, outcome: 'none' });
      expect(guideDue(readGuide(store))).toBe(true);
    }
  });

  it('a store that cannot be written reports false (the host still treats it as seen for the session)', () => {
    const broken = { persistent: false, read: () => null, write: () => false, remove: () => false };
    expect(acknowledgeGuide(broken, 'completed')).toBe(false);
  });
});

describe('Free Roam controls follow the real (rebindable) bindings', () => {
  it('default keys: WASD + arrows, Space/J fire, Shift boost, Q next weapon, X lock, C next target, Esc pause', () => {
    const rows = freeRoamKeyboard(DEFAULT_BINDINGS, false);
    expect(row(rows, 'move').keys).toEqual([
      ['W', 'A', 'S', 'D'],
      ['↑', '←', '↓', '→'],
    ]);
    for (const [id, action] of [
      ['fire', 'fire'],
      ['boost', 'boost'],
      ['weapon', 'missile'],
      ['lock', 'lock'],
      ['target', 'target'],
      ['interact', 'interact'],
      ['map', 'map'],
      ['cargo', 'cargo'],
    ] as const) {
      const expected = DEFAULT_BINDINGS[action].filter((k): k is string => k !== null).map(keyLabel);
      expect(keysOf(row(rows, id))).toEqual(expected);
    }
    expect(keysOf(row(rows, 'weapon'))).toContain('Q');
    expect(keysOf(row(rows, 'lock'))).toContain('X');
    expect(keysOf(row(rows, 'target'))).toContain('C');
    expect(keysOf(row(rows, 'pause'))).toContain('ESC');
  });

  it('a rebound key shows the new key, and the step says "your keys"', () => {
    const b: Bindings = { ...DEFAULT_BINDINGS, missile: ['KeyR', null], lock: ['KeyT', 'KeyY'] };
    const rows = freeRoamKeyboard(b, false);
    expect(keysOf(row(rows, 'weapon'))).toEqual(['R']);
    expect(keysOf(row(rows, 'lock'))).toEqual(['T', 'Y']);
    expect(customBindings(b)).toBe(true);
    expect(customBindings(DEFAULT_BINDINGS)).toBe(false);
    expect(stepText(guideStep('controls', ctx({ bindings: b })))).toMatch(/These are your keys/);
    expect(stepText(guideStep('controls', ctx()))).not.toMatch(/These are your keys/);
  });

  it('the wheel zooms and never switches weapons', () => {
    const rows = freeRoamKeyboard(DEFAULT_BINDINGS, false);
    expect(keysOf(row(rows, 'zoom'))).toContain('WHEEL');
    expect(row(rows, 'zoom').text).toMatch(/never switches weapons/);
    for (const r of rows) if (r.id !== 'zoom') expect(keysOf(r)).not.toContain('WHEEL');
  });

  it('lock is facing only (no auto-move, no auto-fire); next target only while locked', () => {
    const rows = freeRoamKeyboard(DEFAULT_BINDINGS, false);
    const lock = row(rows, 'lock').text;
    expect(lock).toMatch(/nose turns to face/i);
    expect(lock).toMatch(/you still steer, thrust and fire yourself/);
    expect(lock).not.toMatch(/auto|follows the target|fires (at|for) you/i);
    expect(row(rows, 'target').text).toMatch(/^Only while locked/);
  });

  it('mouse aim is described only when it is on', () => {
    expect(row(freeRoamKeyboard(DEFAULT_BINDINGS, true), 'move').text).toMatch(/Mouse aim is on/);
    expect(row(freeRoamKeyboard(DEFAULT_BINDINGS, false), 'move').text).not.toMatch(/Mouse aim is on/);
  });
});

describe('touch and controller', () => {
  const KEYBOARD_WORDS = /\b(SPACE|SHIFT|ESC|ENTER|WHEEL|KEY|[QXCWASDJKEMIP])\b/;

  it('touch shows no keyboard-only actions', () => {
    for (const rows of [freeRoamTouch(), classicTouch(false), classicTouch(true)]) {
      for (const r of rows) for (const k of keysOf(r)) expect(k, `${r.id}: ${k}`).not.toMatch(KEYBOARD_WORDS);
    }
  });

  it('Free Roam touch: stick, FIRE, BOOST, WPN above FIRE, LOCK on the left, » only while locked', () => {
    const rows = freeRoamTouch();
    expect(keysOf(row(rows, 'move'))).toEqual(['DRAG']);
    expect(keysOf(row(rows, 'fire'))).toEqual(['FIRE']);
    expect(keysOf(row(rows, 'boost'))).toEqual(['BOOST']);
    expect(row(rows, 'weapon').text).toMatch(/above FIRE/);
    expect(row(rows, 'weapon').text).toMatch(/never fires/);
    expect(row(rows, 'lock').text).toMatch(/^On the left/);
    expect(keysOf(row(rows, 'target'))).toEqual(['»']);
    expect(row(rows, 'target').text).toMatch(/while locked/);
  });

  it('the Free Roam controller has no lock button, and the guide says where lock lives', () => {
    const rows = freeRoamController();
    expect(rows.map((r) => r.id)).not.toContain('lock');
    expect(rows.map((r) => r.id)).not.toContain('target');
    expect(keysOf(row(rows, 'weapon'))).toEqual(['R3']);
    expect(stepText(guideStep('controls', ctx({ input: 'controller' })))).toMatch(/Target lock and next target are on the keyboard/);
  });
});

describe('Classic: no Free Roam features, weapon switching after Wave 20', () => {
  it('Classic rows never offer boost, zoom, lock or next target', () => {
    for (const rows of [classicKeyboard(false), classicKeyboard(true), classicTouch(false), classicTouch(true), classicController(false), classicController(true)]) {
      const ids = rows.map((r) => r.id);
      for (const banned of ['boost', 'zoom', 'lock', 'target', 'interact', 'map', 'cargo']) expect(ids).not.toContain(banned);
    }
  });

  it('Classic keyboard matches the fixed keys (Space/Z/X fire, P/Esc pause, Q next weapon, M mute)', () => {
    const rows = classicKeyboard(false);
    expect(keysOf(row(rows, 'fire'))).toEqual(['SPACE', 'Z', 'X']);
    expect(keysOf(row(rows, 'pause'))).toEqual(['P', 'ESC']);
    expect(keysOf(row(rows, 'weapon'))).toEqual(['Q']);
    expect(keysOf(row(rows, 'mute'))).toEqual(['M']);
    expect(keysOf(row(classicController(false), 'weapon'))).toEqual(['Y']);
  });

  it('before the gate, every Classic weapon row says it opens after Wave 20; after it, the rows say it is open', () => {
    for (const [rows, rowsAfter] of [
      [classicKeyboard(false), classicKeyboard(true)],
      [classicTouch(false), classicTouch(true)],
      [classicController(false), classicController(true)],
    ] as const) {
      expect(row(rows, 'weapon').text).toMatch(/After Wave 20|after you complete Wave 20/i);
      expect(row(rowsAfter, 'weapon').text).not.toMatch(/^Opens after/);
    }
    const before = stepText(guideStep('ships', ctx({ mode: 'classic', classicGate: false })));
    const after = stepText(guideStep('ships', ctx({ mode: 'classic', classicGate: true })));
    expect(before).toMatch(/Wave 20 is not complete yet/);
    expect(after).toMatch(/Wave 20 is complete/);
  });

  it('Classic steps do not describe marks, the hangar or the armory as part of Classic', () => {
    const marks = stepText(guideStep('marks', ctx({ mode: 'classic' })));
    expect(marks).toMatch(/no currency/);
    expect(marks).not.toMatch(/EARN|SPEND/);
    expect(stepText(guideStep('weapons', ctx({ mode: 'classic' })))).toMatch(/Classic has no armory screen/);
  });
});

describe('content changes with the mode and the input', () => {
  it('the controls step differs for every mode × input pair', () => {
    const seen = new Set<string>();
    for (const mode of GUIDE_MODES) for (const input of GUIDE_INPUTS) seen.add(stepText(guideStep('controls', ctx({ mode, input }))));
    expect(seen.size).toBe(GUIDE_MODES.length * GUIDE_INPUTS.length);
  });

  it('touch steps carry a diagram of the right layout; keyboard and controller do not', () => {
    for (const mode of GUIDE_MODES) {
      const blocks = guideStep('controls', ctx({ mode, input: 'touch' })).blocks;
      expect(blocks.some((b) => b.kind === 'diagram' && b.layout === mode)).toBe(true);
      expect(guideStep('controls', ctx({ mode, input: 'keyboard' })).blocks.some((b) => b.kind === 'diagram')).toBe(false);
    }
    expect(controlRows(ctx({ mode: 'classic', input: 'touch' }))).toEqual(classicTouch(false));
  });

  it('steps declare which switch changes them', () => {
    for (const id of GUIDE_STEPS) {
      const s = guideStep(id, ctx());
      const byModeReal = stepText(guideStep(id, ctx({ mode: 'classic' }))) !== stepText(guideStep(id, ctx({ mode: 'freeroam' })));
      if (byModeReal) expect(s.byMode, id).toBe(true);
      const byInputReal = GUIDE_INPUTS.some((input) => stepText(guideStep(id, ctx({ input }))) !== stepText(s));
      if (byInputReal) expect(s.byInput, id).toBe(true);
    }
  });
});

describe('ships, weapons and Guild marks match the game data', () => {
  it('the hangar step names the real starting ship', () => {
    expect(stepText(guideStep('ships', ctx()))).toContain(SHIP_BY_ID.get(STARTER_SHIP)!.name);
  });

  it('weapon compatibility comes from the armory catalogue', () => {
    const text = stepText(guideStep('weapons', ctx()));
    for (const w of WEAPONS) {
      if (w.id === PRIMARY_WEAPON) {
        expect(text).toContain(`The ${w.name} is always in the cycle.`);
        continue;
      }
      const names = shipsFor(w.id).map((id) => SHIP_BY_ID.get(id)!.name);
      expect(names.length).toBeGreaterThan(0);
      const line = text.split('\n').find((l) => l.startsWith(w.role));
      expect(line, w.id).toBeDefined();
      for (const n of names) expect(line).toContain(n);
      for (const other of [...SHIP_BY_ID.values()].filter((s) => !names.includes(s.name))) expect(line).not.toContain(other.name);
    }
  });

  it('the marks glyph, balance and insufficient-funds text are the ledger\'s own', () => {
    expect(MARKS_GLYPH).toBe(MARKS.glyph);
    const blocks = guideStep('marks', ctx()).blocks;
    const samples = blocks.flatMap((b) => (b.kind === 'sample' ? b.lines : []));
    expect(samples).toContain(formatMarks(1240));
    expect(samples).toContain(insufficientText(40, 3));
  });

  it('ships are not bought with marks, travel has no marks fee, and nothing promises starting credits', () => {
    const text = stepText(guideStep('marks', ctx()));
    expect(text).toMatch(/Ships cost cargo materials and a licence/);
    expect(text).toMatch(/FREE \(0 MARKS\)/);
    expect(allText()).not.toMatch(/starting (credits|marks)|free marks|bonus marks/i);
  });
});

describe('no developer tools in the player guide', () => {
  const BANNED = /admin|password|passcode|unlimited ammo|hidden login|secret|cheat|debug|gravity lab|\?mode=qa/i;

  it('no step, in any mode, input or gate state, mentions them', () => {
    const text = allText();
    expect(text).not.toMatch(BANNED);
    // the developer-tool identity strings, taken from their module (not repeated here)
    for (const s of [OWNER_IDENTITY, WELCOME_LINE]) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
  });

  it('the guide sources carry no developer wording either', () => {
    for (const f of ['guideContent.ts', 'guideDialog.ts', 'guideState.ts']) {
      const src = readFileSync(new URL(`../src/modes/guide/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/ADMIN_SEQUENCE|adminLogin|password|freeroam\/admin/i);
      for (const s of [OWNER_IDENTITY, WELCOME_LINE]) expect(src, f).not.toContain(s);
    }
  });
});
