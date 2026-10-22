/**
 * Free Roam Prompt 12 (presentation): the pure rules behind the contextual
 * HUD, the notice queue, UI motion, the station hub, the SOUND settings, the
 * synthesised Free Roam sound set and its cues. The DOM and the browser are
 * covered by the playtest (docs/development/playtest/freeroam-p12.mjs).
 */
import { describe, expect, it } from 'vitest';
import { HUD_LIMITS, HUD_TIMING, NO_ATTENTION, arrowFor, cargoText, hudView, nearestPoi, shipCard, stepAttention, type HudInput } from '../src/modes/freeroam/ui/hudModel.ts';
import { EMPTY_NOTICES, NOTICE, clearNotices, flushNotices, noticeLine, pushNotice, tickNotices, type NoticeState } from '../src/modes/freeroam/ui/notices.ts';
import { PRESETS, createMotion, type AnimateFn, type AnimationLike } from '../src/modes/freeroam/ui/motion.ts';
import { STATION_TABS, TAB_LABEL, backFrom, isStationTab, stationOverview, stepTab, type StationSummary, type StationTab } from '../src/modes/freeroam/ui/stationModel.ts';
import { BUS_LABEL, VOLUME_STEP, stepVolume, volumeText } from '../src/modes/freeroam/audio/audioSettings.ts';
import { ENGINE_LEVEL, engineLevel, momentCue, sectorCue, type MomentCue } from '../src/modes/freeroam/audio/frCues.ts';
import { ENGINE_LOOP, FR_SOUNDS, FR_SOUND_IDS } from '../src/modes/freeroam/audio/frSounds.ts';
import type { SectorEvent } from '../src/modes/freeroam/sector/run.ts';
import { panelKeyCommands, panelPadCommands } from '../src/modes/freeroam/input.ts';
import { PANEL_KEYS, trackedCodes, DEFAULT_BINDINGS } from '../src/modes/freeroam/bindings.ts';
import { recipeDurationMs, renderSound } from '../src/audio/synth.ts';
import { SoundSystem, type AudioContextLike, type BufferLike, type GainNodeLike, type SourceLike } from '../src/audio/soundSystem.ts';
import { SOUNDS, type SoundRecipe } from '../src/config/audio.ts';
import { DEFAULT_SAVE } from '../src/persistence/saveData.ts';
import { MemoryStore } from '../src/persistence/storage.ts';
import { PreferencesStore } from '../src/shared/persistence/preferences.ts';

/* ------------------------------------------------------------------ HUD */

const calmInput = (o: Partial<HudInput> = {}): HudInput => ({
  tick: 10_000,
  level: 'calm',
  hull: 100,
  hullMax: 100,
  shield: 100,
  shieldMax: 100,
  holdUsed: 10,
  holdCap: 80,
  cellsShort: false,
  hasObjective: true,
  focus: false,
  nearby: { id: 'p', label: 'Exit beacon', distance: 300, arrow: '↑' },
  ...o,
});

describe('contextual HUD', () => {
  it('a new sector resets the timers: entry readings are not changes, the objective shows in full', () => {
    const a = stepAttention(NO_ATTENTION, 500, { cargo: '10', objective: 'Scan 0/3', sector: 'sol' });
    expect(a.cargoTick).toBeLessThan(0);
    expect(a.objectiveTick).toBe(500);
    expect(a.sectorTick).toBe(500);
    const v = hudView(calmInput({ tick: 520 }), a);
    expect(v.cargo).toBe('hidden');
    expect(v.objective).toBe('full');
    expect(v.hint).toBe(true);
    // unchanged keys return the same object (the view can skip work)
    expect(stepAttention(a, 600, { cargo: '10', objective: 'Scan 0/3', sector: 'sol' })).toBe(a);
  });

  it('cargo shows for a few seconds after the hold changes, then steps back', () => {
    const a0 = stepAttention(NO_ATTENTION, 0, { cargo: '10', objective: '', sector: 's' });
    const a1 = stepAttention(a0, 1000, { cargo: '11', objective: '', sector: 's' });
    expect(a1.cargoTick).toBe(1000);
    expect(hudView(calmInput({ tick: 1000 + HUD_TIMING.cargoTicks - 1 }), a1).cargo).toBe('shown');
    expect(hudView(calmInput({ tick: 1000 + HUD_TIMING.cargoTicks }), a1).cargo).toBe('hidden');
  });

  it('cargo stays up as a warning while the hold is nearly full or cells are short', () => {
    const cap = 80;
    expect(hudView(calmInput({ holdUsed: Math.ceil(cap * HUD_LIMITS.holdWarn), holdCap: cap }), NO_ATTENTION).cargo).toBe('warn');
    expect(hudView(calmInput({ cellsShort: true }), NO_ATTENTION).cargo).toBe('warn');
    // the warning survives combat
    expect(hudView(calmInput({ cellsShort: true, level: 'engaged' }), NO_ATTENTION).cargo).toBe('warn');
  });

  it('the objective goes compact after its full window and hides in combat', () => {
    const a = stepAttention(NO_ATTENTION, 0, { cargo: '', objective: 'Scan 1/3', sector: 's' });
    expect(hudView(calmInput({ tick: HUD_TIMING.objectiveTicks - 1 }), a).objective).toBe('full');
    expect(hudView(calmInput({ tick: HUD_TIMING.objectiveTicks }), a).objective).toBe('compact');
    expect(hudView(calmInput({ tick: 10, level: 'engaged' }), a).objective).toBe('hidden');
    expect(hudView(calmInput({ hasObjective: false }), a).objective).toBe('hidden');
    // progress shows it in full again
    const b = stepAttention(a, 5000, { cargo: '', objective: 'Scan 2/3', sector: 's' });
    expect(hudView(calmInput({ tick: 5001 }), b).objective).toBe('full');
  });

  it('in combat non-combat information shrinks: compact location, no nearby chip, no hint', () => {
    for (const level of ['alert', 'engaged'] as const) {
      const v = hudView(calmInput({ level, tick: 1 }), stepAttention(NO_ATTENTION, 0, { cargo: '', objective: '', sector: 's' }));
      expect(v.location).toBe('compact');
      expect(v.nearby).toBeNull();
      expect(v.hint).toBe(false);
    }
  });

  it('the nearby chip gives way to an interaction prompt', () => {
    expect(hudView(calmInput({ focus: true }), NO_ATTENTION).nearby).toBeNull();
    expect(hudView(calmInput(), NO_ATTENTION).nearby?.label).toBe('Exit beacon');
  });

  it('danger and low shield follow the configured fractions', () => {
    expect(hudView(calmInput({ hull: 29 }), NO_ATTENTION).critical).toBe(true);
    expect(hudView(calmInput({ hull: 30 }), NO_ATTENTION).critical).toBe(false);
    expect(hudView(calmInput({ shield: 34 }), NO_ATTENTION).shieldLow).toBe(true);
    expect(hudView(calmInput({ hullMax: 0, hull: 0 }), NO_ATTENTION).critical).toBe(false);
  });

  it('nearestPoi picks the closest within range, with a compass arrow', () => {
    const c = [
      { id: 'a', label: 'A', x: 0, y: -500 },
      { id: 'b', label: 'B', x: 300, y: 0 },
      { id: 'far', label: 'Far', x: 5000, y: 0 },
    ];
    const n = nearestPoi({ x: 0, y: 0 }, c);
    expect(n).toEqual({ id: 'b', label: 'B', distance: 300, arrow: '→' });
    expect(nearestPoi({ x: 0, y: 0 }, [c[2]!])).toBeNull();
    expect(arrowFor(0, -1)).toBe('↑');
    expect(arrowFor(-1, 1)).toBe('↙');
  });

  it('the ship card states every value in words, not colour alone', () => {
    const card = shipCard({ ship: 'Petrel', weapon: 'Pulse cannon', firing: false, docked: false, shield: 100, shieldMax: 100, hull: 20, hullMax: 100, energy: 50, energyMax: 100, boosting: false });
    expect(card.ship).toBe('PETREL');
    expect(card.weaponText).toBe('READY');
    expect(card.hull).toEqual({ pct: 20, text: 'LOW 20%', low: true });
    expect(card.shield.text).toBe('100%');
    expect(card.label).toContain('hull 20%');
    const docked = shipCard({ ship: 'Petrel', weapon: 'X', firing: true, docked: true, shield: 0, shieldMax: 0, hull: 1, hullMax: 1, energy: 1, energyMax: 1, boosting: false });
    expect(docked.weaponState).toBe('safe');
    expect(docked.shield.pct).toBe(0);
    // key changes with what is visible
    const firing = shipCard({ ship: 'Petrel', weapon: 'Pulse cannon', firing: true, docked: false, shield: 100, shieldMax: 100, hull: 20, hullMax: 100, energy: 50, energyMax: 100, boosting: false });
    expect(firing.key).not.toBe(card.key);
    expect(cargoText(12, 80, 6)).toBe('HOLD 12/80 · CELLS 6');
  });
});

/* -------------------------------------------------------------- notices */

const push = (s: NoticeState, kind: Parameters<typeof pushNotice>[1]['kind'], title: string, now: number, combat = false) => pushNotice(s, { kind, title }, now, combat);

describe('notice queue', () => {
  it('shows one card at a time; equal priority waits and follows after expiry', () => {
    let r = push(EMPTY_NOTICES, 'info', 'One', 0);
    r = push(r.state, 'info', 'Two', 10);
    expect(r.state.current?.title).toBe('One');
    expect(r.state.queue.map((n) => n.title)).toEqual(['Two']);
    // at expiry 'Two' is still within its own lifetime: it follows
    expect(tickNotices(r.state, NOTICE.defaultMs.info + 1, false).state.current?.title).toBe('Two');
    const t = tickNotices(r.state, NOTICE.defaultMs.info + 100, false);
    // 'Two' waited longer than its own lifetime: it went to the log
    expect(t.state.current).toBeNull();
    expect(t.toLog.map((n) => n.title)).toEqual(['Two']);
  });

  it('a waiting notice is promoted when the card expires in time', () => {
    let r = pushNotice(EMPTY_NOTICES, { kind: 'info', title: 'One', ms: 500 }, 0, false);
    r = push(r.state, 'info', 'Two', 100);
    const t = tickNotices(r.state, 600, false);
    expect(t.state.current?.title).toBe('Two');
    expect(t.state.current!.until - 600).toBeGreaterThanOrEqual(NOTICE.minMs);
  });

  it('a more important notice replaces the card at once (the old one goes to the log)', () => {
    let r = push(EMPTY_NOTICES, 'info', 'Routine', 0);
    r = push(r.state, 'mission', 'Mission complete', 50);
    expect(r.state.current?.title).toBe('Mission complete');
    expect(r.toLog.map((n) => n.title)).toEqual(['Routine']);
  });

  it('the same text extends the card instead of stacking', () => {
    let r = push(EMPTY_NOTICES, 'warn', 'Hold full', 0);
    const until = r.state.current!.until;
    r = push(r.state, 'warn', 'Hold full', 1000);
    expect(r.state.queue).toHaveLength(0);
    expect(r.state.current!.until).toBeGreaterThan(until);
  });

  it('the queue is bounded; overflow goes to the log (nothing is lost)', () => {
    let s = push(EMPTY_NOTICES, 'danger', 'Top', 0).state;
    const logged: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = push(s, 'info', `N${i}`, i);
      s = r.state;
      logged.push(...r.toLog.map((n) => n.title));
    }
    expect(s.queue.length).toBe(NOTICE.queueMax);
    expect(logged.length + s.queue.length).toBe(6);
  });

  it('combat banner: new notices go to the log and a showing card steps aside', () => {
    const r = push(EMPTY_NOTICES, 'discovery', 'Survey mark recorded', 0, true);
    expect(r.state.current).toBeNull();
    expect(r.toLog).toHaveLength(1);
    const s = push(EMPTY_NOTICES, 'arrival', 'Sol', 0).state;
    const t = tickNotices(s, 10, true);
    expect(t.state.current).toBeNull();
    expect(t.toLog.map((n) => n.title)).toEqual(['Sol']);
  });

  it('a panel opening over the card sends it and the queue to the log (nothing expires unseen)', () => {
    let s = push(EMPTY_NOTICES, 'mission', 'Mission complete', 0).state;
    s = push(s, 'info', 'Launched', 5).state;
    const f = flushNotices(s);
    expect(f.state.current).toBeNull();
    expect(f.state.queue).toHaveLength(0);
    expect(f.toLog.map((n) => n.title)).toEqual(['Mission complete', 'Launched']);
    expect(flushNotices(EMPTY_NOTICES).state).toBe(EMPTY_NOTICES);
    // raised while covered: straight to the log
    expect(pushNotice(EMPTY_NOTICES, { kind: 'mission', title: 'X' }, 0, true).toLog).toHaveLength(1);
  });

  it('clearNotices empties the card and queue; noticeLine joins title and detail', () => {
    const s = pushNotice(EMPTY_NOTICES, { kind: 'arrival', title: 'Sol', detail: 'Milky Way' }, 0, false).state;
    expect(noticeLine(s.current!)).toBe('Sol · Milky Way');
    expect(clearNotices(s).current).toBeNull();
    expect(clearNotices(EMPTY_NOTICES)).toBe(EMPTY_NOTICES);
    for (const k of Object.keys(NOTICE.defaultMs)) expect(NOTICE.priority[k as keyof typeof NOTICE.priority]).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- motion */

class FakeAnim implements AnimationLike {
  onfinish: ((this: AnimationLike, ev: unknown) => unknown) | null = null;
  oncancel: ((this: AnimationLike, ev: unknown) => unknown) | null = null;
  cancelled = false;
  cancel(): void {
    this.cancelled = true;
    this.oncancel?.call(this, null);
  }
  finish(): void {
    this.onfinish?.call(this, null);
  }
}

interface FakeEl {
  readonly id: string;
  readonly kids: FakeEl[];
  contains(o: unknown): boolean;
}
const fakeEl = (id: string, kids: FakeEl[] = []): FakeEl => {
  const me: FakeEl = { id, kids, contains: (o) => o === me || kids.some((k) => k.contains(o)) };
  return me;
};

function motionRig(reduced = false) {
  const anims: FakeAnim[] = [];
  const opts: KeyframeAnimationOptions[] = [];
  const animate: AnimateFn = (_t, _k, o) => {
    const a = new FakeAnim();
    anims.push(a);
    opts.push(o);
    return a;
  };
  let red = reduced;
  const m = createMotion({ animate, reduced: () => red });
  return { m, anims, opts, setReduced: (v: boolean) => (red = v) };
}

describe('UI motion', () => {
  it('every preset is short and ends on the resting state', () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      expect(p.ms, name).toBeGreaterThanOrEqual(100);
      expect(p.ms, name).toBeLessThanOrEqual(260);
      const last = p.frames[p.frames.length - 1]!;
      if ('opacity' in last) expect(last.opacity, name).toBe(1);
      if ('transform' in last) expect(last.transform, name).toBe('none');
    }
  });

  it('one animation per element and channel; a new one cancels the old', () => {
    const { m, anims } = motionRig();
    const el = fakeEl('a') as unknown as Element;
    m.play(el, 'enter');
    m.play(el, 'enter');
    expect(anims[0]!.cancelled).toBe(true);
    expect(m.active()).toBe(1);
    m.play(el, 'flash', { channel: 'value' });
    expect(m.active()).toBe(2);
    anims[1]!.finish();
    expect(m.active()).toBe(1);
  });

  it('cancelWithin stops animations under a root; cancelAll leaves nothing running', () => {
    const { m, anims } = motionRig();
    const child = fakeEl('child');
    const root = fakeEl('root', [child]);
    const other = fakeEl('other');
    m.play(child as unknown as Element, 'rise');
    m.play(other as unknown as Element, 'pop');
    m.cancelWithin(root as unknown as Element);
    expect(anims[0]!.cancelled).toBe(true);
    expect(anims[1]!.cancelled).toBe(false);
    m.cancelAll();
    expect(m.active()).toBe(0);
    expect(m.started()).toBe(2);
  });

  it('reduced motion or no WAAPI: nothing plays (the result is identical)', () => {
    const { m, anims, setReduced } = motionRig(true);
    expect(m.play(fakeEl('a') as unknown as Element, 'enter')).toBe(false);
    expect(anims).toHaveLength(0);
    setReduced(false);
    expect(m.play(fakeEl('a') as unknown as Element, 'enter')).toBe(true);
    const none = createMotion({ animate: null, reduced: () => false });
    expect(none.play(fakeEl('b') as unknown as Element, 'enter')).toBe(false);
    const throwing = createMotion({
      animate: () => {
        throw new Error('unsupported');
      },
      reduced: () => false,
    });
    expect(throwing.play(fakeEl('c') as unknown as Element, 'enter')).toBe(false);
    expect(throwing.active()).toBe(0);
  });

  it('a delay is passed through and fill is backwards only (the end state is never held by the animation)', () => {
    const { m, opts } = motionRig();
    m.play(fakeEl('a') as unknown as Element, 'enter', { delayMs: 650 });
    expect(opts[0]).toMatchObject({ delay: 650, fill: 'backwards' });
  });
});

/* -------------------------------------------------------------- station */

const summary = (o: Partial<StationSummary> = {}): StationSummary => ({ name: 'Haven Guild Station', first: false, ship: 'Petrel', cells: 14, emergency: 0, marks: 140, ready: 0, active: 0, offers: 0, stored: 0, ...o });

describe('station hub', () => {
  it('tabs cycle in order and wrap; Back from a service returns to the overview', () => {
    expect(STATION_TABS[0]).toBe('station');
    expect(stepTab('station', 1)).toBe('hangar');
    expect(stepTab('station', -1)).toBe('upgrades');
    expect(stepTab('upgrades', 1)).toBe('station');
    let t: StationTab = STATION_TABS[0];
    for (let i = 0; i < STATION_TABS.length; i++) t = stepTab(t, 1);
    expect(t).toBe('station');
    expect(backFrom('equipment')).toBe('station');
    expect(backFrom('station')).toBeNull();
    expect(isStationTab('fabricator')).toBe(true);
    expect(isStationTab('pause')).toBe(false);
    expect(isStationTab(null)).toBe(false);
    for (const tab of STATION_TABS) expect(TAB_LABEL[tab]).toMatch(/^[A-Z]+$/);
  });

  it('the overview reports what docking did and what is waiting, from the shell values only', () => {
    const o = stationOverview(summary({ first: true, emergency: 2, ready: 1, offers: 3, stored: 2 }));
    expect(o.title).toBe('HAVEN GUILD STATION');
    expect(o.status).toContain('Station logged');
    expect(o.lines.find((l) => l.label === 'REACTOR CELLS')).toMatchObject({ value: '14 (+2 FREE EMERGENCY)', accent: true });
    expect(o.lines.find((l) => l.label === 'MISSIONS')).toMatchObject({ value: '1 READY TO TURN IN', accent: true });
    expect([...o.services.map((s) => s.tab)].sort()).toEqual(STATION_TABS.filter((t) => t !== 'station').sort());
    expect(o.services[0]!.tab).toBe('missions'); // work waiting comes first
    expect(o.services.find((s) => s.tab === 'missions')!.badge).toBe('1 READY');
    expect(o.services.find((s) => s.tab === 'equipment')!.badge).toBe('2 STORED');
    const calm = stationOverview(summary({ offers: 3 }));
    expect(calm.status).not.toContain('logged');
    expect(calm.services.find((s) => s.tab === 'missions')!.badge).toBe('3 OFFERS');
    expect(stationOverview(summary({ offers: 1 })).services.find((s) => s.tab === 'missions')!.badge).toBe('1 OFFER');
    expect(stationOverview(summary({ active: 2 })).lines.find((l) => l.label === 'MISSIONS')!.value).toBe('2 ACTIVE');
  });
});

/* -------------------------------------------------- keys for the station */

describe('station tab keys', () => {
  it('[ ] and PageUp / PageDown switch tabs; the pad X steps forward', () => {
    expect(panelKeyCommands(['BracketLeft', 'BracketRight', 'PageUp', 'PageDown'])).toEqual(['tabPrev', 'tabNext', 'tabPrev', 'tabNext']);
    expect(panelPadCommands({ moveX: 0, presses: ['x'], active: true, fireHeld: false })).toEqual(['tabNext']);
    const tracked = trackedCodes(DEFAULT_BINDINGS);
    for (const code of [...PANEL_KEYS.tabPrev, ...PANEL_KEYS.tabNext]) expect(tracked).toContain(code);
  });
});

/* ---------------------------------------------------------- audio prefs */

describe('SOUND settings', () => {
  it('volume steps are clamped and snapped (no float drift)', () => {
    expect(VOLUME_STEP).toBe(0.1);
    expect(stepVolume(0.8, 1)).toBe(0.9);
    expect(stepVolume(1, 1)).toBe(1);
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(0.73, 1)).toBe(0.8);
    expect(stepVolume(Number.NaN, 1)).toBe(0.1);
    let v = 0;
    for (let i = 0; i < 10; i++) v = stepVolume(v, 1);
    expect(v).toBe(1);
    expect(volumeText(0.7)).toBe('70%');
    expect(volumeText(2)).toBe('100%');
    expect(volumeText(Number.NaN)).toBe('0%');
    expect(BUS_LABEL).toEqual({ master: 'MASTER', sfx: 'EFFECTS', music: 'MUSIC' });
  });

  it('mute and volumes persist in the shared preferences (one setting for Classic and Free Roam)', () => {
    const store = new MemoryStore();
    const prefs = new PreferencesStore(store);
    prefs.setAudio({ muted: true, master: stepVolume(prefs.get().audio.master, -1) });
    const again = new PreferencesStore(store);
    expect(again.get().audio.muted).toBe(true);
    expect(again.get().audio.master).toBe(prefs.get().audio.master);
    // out-of-range values are sanitised, never stored
    again.setAudio({ sfx: 7 });
    expect(again.get().audio.sfx).toBeLessThanOrEqual(1);
  });
});

/* ------------------------------------------------------------ sound set */

describe('Free Roam sound set', () => {
  it('has every required moment, namespaced and distinct from Classic ids', () => {
    const required = ['fr.engine', 'fr.shot', 'fr.impact', 'fr.shieldHit', 'fr.shieldDown', 'fr.hullHit', 'fr.boom', 'fr.bigBoom', 'fr.playerBoom', 'fr.collect', 'fr.loot', 'fr.discover', 'fr.dock', 'fr.jump', 'fr.arrive', 'fr.upgrade', 'fr.alert', 'fr.deny', 'fr.clear', 'fr.mission', 'fr.complete'];
    for (const id of required) expect(FR_SOUND_IDS).toContain(id);
    for (const id of FR_SOUND_IDS) {
      expect(id.startsWith('fr.')).toBe(true);
      expect(id in SOUNDS).toBe(false);
    }
    expect(ENGINE_LOOP).not.toContain('.');
  });

  it.each(FR_SOUND_IDS)('%s renders clean, short (or seamlessly looping) audio', (id) => {
    const r = FR_SOUNDS[id] as SoundRecipe;
    const s = renderSound(r, 8000);
    let peak = 0;
    for (const v of s) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.01);
    if (r.loop) {
      const sec = (r.loopMs ?? 0) / 1000;
      expect(sec).toBeGreaterThan(0);
      for (const v of r.voices) {
        expect(Math.abs(v.f0 * sec - Math.round(v.f0 * sec))).toBeLessThan(1e-9);
        if (v.vibHz) expect(Math.abs(v.vibHz * sec - Math.round(v.vibHz * sec))).toBeLessThan(1e-9);
        expect(v.f1).toBeUndefined();
      }
    } else {
      expect(recipeDurationMs(r)).toBeLessThan(2000);
      expect(s[0]).toBe(0);
      expect(Math.abs(s[s.length - 1]!)).toBeLessThan(0.02);
    }
  });

  it('jingles use the music bus; combat repeats have minimum gaps', () => {
    expect(FR_SOUNDS['fr.mission'].bus).toBe('music');
    expect(FR_SOUNDS['fr.complete'].bus).toBe('music');
    for (const id of ['fr.shot', 'fr.impact', 'fr.shieldHit', 'fr.hullHit'] as const) expect(FR_SOUNDS[id].minGapMs, id).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------------- cues */

const ev = (e: Record<string, unknown>): SectorEvent => e as unknown as SectorEvent;

describe('Free Roam cues', () => {
  it('maps sector events to sounds; shield vs hull comes from the batch shield', () => {
    expect(sectorCue(ev({ type: 'hit', source: 'x', damage: 5 }), { shieldBefore: 50, shieldAfter: 40 })).toBe('fr.shieldHit');
    expect(sectorCue(ev({ type: 'hit', source: 'x', damage: 5 }), { shieldBefore: 5, shieldAfter: 0 })).toBe('fr.shieldDown');
    expect(sectorCue(ev({ type: 'hit', source: 'x', damage: 5 }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.hullHit');
    expect(sectorCue(ev({ type: 'destroyed', size: 3 }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.bigBoom');
    expect(sectorCue(ev({ type: 'destroyed', size: 1 }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.boom');
    expect(sectorCue(ev({ type: 'recorded' }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.discover');
    expect(sectorCue(ev({ type: 'looted', loot: [] }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.discover');
    expect(sectorCue(ev({ type: 'looted', loot: [{}] }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.loot');
    expect(sectorCue(ev({ type: 'encounter', state: 'cleared' }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.clear');
    expect(sectorCue(ev({ type: 'telegraph', weapon: 'bolt' }), { shieldBefore: 0, shieldAfter: 0 })).toBeNull();
    expect(sectorCue(ev({ type: 'telegraph', weapon: 'missile' }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.alert');
    expect(sectorCue(ev({ type: 'recalled' }), { shieldBefore: 0, shieldAfter: 0 })).toBe('fr.playerBoom');
    expect(sectorCue(ev({ type: 'somethingNew' }), { shieldBefore: 0, shieldAfter: 0 })).toBeNull();
  });

  it('every cue names a defined sound', () => {
    const moments: MomentCue[] = ['jump', 'arrive', 'missionComplete', 'missionFailed', 'upgrade', 'refused', 'launch'];
    for (const m of moments) expect(FR_SOUND_IDS).toContain(momentCue(m));
  });

  it('engine level: silent when not live, idle murmur, rising with thrust and boost, clamped', () => {
    expect(engineLevel({ live: false, thrust: 1, boost: 1 })).toBe(0);
    expect(engineLevel({ live: true, thrust: 0, boost: 0 })).toBeCloseTo(ENGINE_LEVEL.idle, 6);
    expect(engineLevel({ live: true, thrust: 1, boost: 0 })).toBeGreaterThan(engineLevel({ live: true, thrust: 0.5, boost: 0 }));
    expect(engineLevel({ live: true, thrust: 9, boost: 9 })).toBe(1);
    expect(engineLevel({ live: true, thrust: Number.NaN, boost: -1 })).toBeCloseTo(ENGINE_LEVEL.idle, 6);
  });
});

/* -------------------------------------------- SoundSystem define / loops */

class Src implements SourceLike {
  buffer: BufferLike | null = null;
  loop = false;
  onended: (() => void) | null = null;
  stopped = 0;
  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {
    this.stopped += 1;
  }
}

class Ctx implements AudioContextLike {
  state = 'running';
  currentTime = 0;
  sampleRate = 8000;
  destination = {};
  sources: Src[] = [];
  targets: number[] = [];
  createGain(): GainNodeLike {
    const targets = this.targets;
    return { gain: { value: 1, setTargetAtTime: (v: number) => void targets.push(v) }, connect: () => undefined, disconnect: () => undefined };
  }
  createBuffer(_c: number, length: number, rate: number): BufferLike {
    return { duration: length / rate, copyToChannel: () => undefined };
  }
  createBufferSource(): SourceLike {
    const s = new Src();
    this.sources.push(s);
    return s;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
}

describe('SoundSystem: Free Roam recipes and the engine loop', () => {
  it('define registers namespaced recipes (idempotent) and they obey mute', () => {
    const ctx = new Ctx();
    const sys = new SoundSystem(() => ctx, { ...DEFAULT_SAVE.audio });
    expect(() => sys.define('nodot' as `fr.${string}`, FR_SOUNDS['fr.shot'] as SoundRecipe)).toThrow();
    for (const id of FR_SOUND_IDS) sys.define(id, FR_SOUNDS[id] as SoundRecipe);
    sys.define('fr.shot', FR_SOUNDS['fr.shot'] as SoundRecipe);
    expect(sys.stats().defined).toBe(FR_SOUND_IDS.length);
    expect(sys.play('fr.shot')).toBe(false); // locked until a gesture
    sys.unlock();
    expect(sys.play('fr.collect')).toBe(true);
    sys.setPrefs({ ...DEFAULT_SAVE.audio, muted: true });
    expect(sys.play('fr.discover')).toBe(false);
  });

  it('the engine loop starts once, eases its level, and always stops', () => {
    const ctx = new Ctx();
    const sys = new SoundSystem(() => ctx, { ...DEFAULT_SAVE.audio });
    sys.define('fr.engine', FR_SOUNDS['fr.engine'] as SoundRecipe);
    expect(sys.startLoop(ENGINE_LOOP, 'fr.engine', 0.2)).toBe(false); // locked
    sys.unlock();
    expect(sys.startLoop(ENGINE_LOOP, 'fr.engine', 0.2)).toBe(true);
    expect(sys.startLoop(ENGINE_LOOP, 'fr.engine', 0.2)).toBe(false);
    expect(sys.loopLevel(ENGINE_LOOP)).toBeCloseTo(0.2, 6);
    sys.setLoopGain(ENGINE_LOOP, 0.9);
    expect(sys.loopLevel(ENGINE_LOOP)).toBeCloseTo(0.9, 6);
    expect(ctx.targets).toContain(0.9);
    sys.setLoopGain(ENGINE_LOOP, 0.9001); // unchanged: no new ramp
    expect(ctx.targets.filter((v) => v === 0.9001)).toHaveLength(0);
    sys.setLoopGain(ENGINE_LOOP, 5);
    expect(sys.loopLevel(ENGINE_LOOP)).toBe(1);
    sys.stopLoop(ENGINE_LOOP);
    expect(sys.loopLevel(ENGINE_LOOP)).toBeNull();
    expect(ctx.sources.some((s) => s.loop && s.stopped > 0)).toBe(true);
    expect(sys.stats().loops).toBe(0);
  });
});
