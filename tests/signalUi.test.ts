/**
 * P06.2 Signal Triangulation presentation: notice lines per reason (no
 * stacking of repeats), the prompt's hold progress, the presentation reads
 * (progress, recorded noisy bearings) clearing on every interruption, prompt
 * priority next to stations, the CONTROLS SIGNALS setting and the guide.
 * The hidden source never reaches any of it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCatalogue } from '../src/modes/freeroam/catalogue/index.ts';
import { buildNavGraph } from '../src/modes/freeroam/galaxy/graph.ts';
import { sectorContext } from '../src/modes/freeroam/sector/context.ts';
import { generateSector } from '../src/modes/freeroam/sector/generate.ts';
import type { Point, Poi, SectorLayout, SectorSave } from '../src/modes/freeroam/sector/model.ts';
import { applyShip, createSectorRun, disposeSectorRun, interact, pauseSector, restartSector, resumeSector, stepSector, type SectorEvent, type SectorRun } from '../src/modes/freeroam/sector/run.ts';
import { DEG, wrapAngle } from '../src/modes/freeroam/sector/bearing.ts';
import { openBearings, poiVerb, setSignalOptions, SIGNAL, signalProgress, signalSource, signalView, type SignalResult } from '../src/modes/freeroam/sector/signal.ts';
import { deriveShip } from '../src/modes/freeroam/ships/equipment.ts';
import { repeatsLast, SIGNAL_REPEAT_TICKS, signalNotice } from '../src/modes/freeroam/ui/signalNotice.ts';
import { GUIDE_INPUTS, guideStep, type GuideContext } from '../src/modes/guide/guideContent.ts';
import { DEFAULT_BINDINGS } from '../src/modes/freeroam/bindings.ts';

const root = join(__dirname, '..');
const graph = buildNavGraph();
const SYSTEMS = getCatalogue().systems;
const ALL: readonly SectorLayout[] = SYSTEMS.map((s) => generateSector(s, sectorContext(graph, s.id)));
const SOL = ALL.find((L) => L.systemId === 'milky-way/sol')!;
const BASE = ALL.flatMap((L) => L.pois).find((p) => p.kind === 'anomaly')!;
const STATION = SOL.pois.find((p) => p.kind === 'station')!;
const SURVEYED: SectorSave = { done: [], surveyed: true };
const idle = { moveX: 0, moveY: 0 };
const mid: Point = { x: SOL.width / 2, y: SOL.height / 2 };
const anomalyAt = (id: string, at: Point): Poi => ({ ...BASE, id, x: at.x, y: at.y, label: 'Phase shimmer' }) as Poi;
const open = (pois: readonly Poi[]): SectorLayout => ({ ...SOL, landmarks: [], regions: [], rocks: [], patrols: [], sites: [], hazards: [], veins: [], pois });
const polar = (from: Point, deg: number, d: number): Point => ({ x: from.x + Math.cos(deg * DEG) * d, y: from.y + Math.sin(deg * DEG) * d });
const place = (r: SectorRun, at: Point): void => {
  Object.assign(r.ship, { x: at.x, y: at.y, px: at.x, py: at.y, vx: 0, vy: 0 });
};
function fly(r: SectorRun, ticks: number, at: Point | null): SectorEvent[] {
  const out: SectorEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    if (at) place(r, at);
    out.push(...stepSector(r, idle));
  }
  return out;
}
const signals = (ev: readonly SectorEvent[]): SignalResult[] => ev.flatMap((e) => (e.type === 'signal' ? [e.result] : []));
function press(r: SectorRun, id: string, at: Point): SectorEvent[] {
  fly(r, 1, at);
  r.focus = id;
  return interact(r);
}
const setup = () => {
  const p = anomalyAt('anomaly-1', mid);
  const L = open([p]);
  const r = createSectorRun(L, SURVEYED, { seed: 1, ship: deriveShip('petrel') });
  return { p, L, r, s: signalSource(L, p) };
};

/* ------------------------------------------------------------ notice lines */
describe('signal notices (ui/signalNotice.ts)', () => {
  const bearing = (over: Partial<Extract<SignalResult, { kind: 'bearing' }>> = {}): SignalResult => ({ kind: 'bearing', bearing: { x: 0, y: 0, angle: 0, spread: 3.43 }, count: 1, separation: null, toFallback: 4, resolved: null, ...over });

  it('names every refusal and interruption reason, the blocking body first-hand, as a warning', () => {
    const cases: [SignalResult, RegExp][] = [
      [{ kind: 'refused', reason: 'range', by: null }, /^BEARING REFUSED · OUT OF SENSOR RANGE · CLOSE IN$/],
      [{ kind: 'refused', reason: 'speed', by: null }, /^BEARING REFUSED · TOO FAST · SLOW BELOW 60$/],
      [{ kind: 'interrupted', reason: 'occluded', by: 'Ice world' }, /^BEARING LOST · ICE WORLD IN THE WAY · MOVE AROUND IT$/],
      [{ kind: 'refused', reason: 'occluded', by: null }, /^BEARING REFUSED · LINE BLOCKED$/],
      [{ kind: 'refused', reason: 'samePlace', by: null }, /^BEARING REFUSED · SAME SPOT · MOVE TO A NEW POSITION$/],
      [{ kind: 'refused', reason: 'offer', by: null }, /^BEARING REFUSED · DECIDE ON THE HOLD FIRST$/],
    ];
    for (const [r, re] of cases) expect(signalNotice('Phase shimmer', r, false, 35)).toEqual({ text: expect.stringMatching(re), tone: 'warn' });
  });

  it('reports the hold, each recorded bearing, a too-narrow angle, interference and the resolution', () => {
    expect(signalNotice('Phase shimmer', { kind: 'observing', ticks: 0, need: 48 }, false, 35)).toEqual({ text: 'FAINT SIGNAL · PHASE SHIMMER · HOLD STEADY', tone: 'info' });
    expect(signalNotice('x', { kind: 'observing', ticks: 20, need: 48 }, true, 35).text).toBe('BEARING IN PROGRESS · HOLD STEADY · INTERFERENCE: WIDER ERROR');
    expect(signalNotice('x', bearing(), false, 35)).toEqual({ text: 'BEARING 1 RECORDED · ±3.4° · NEXT FROM A NEW ANGLE', tone: 'gain' });
    expect(signalNotice('x', bearing({ count: 2, separation: 21.7, toFallback: 3 }), false, 35)).toEqual({ text: 'BEARING 2 RECORDED · ±3.4° · ONLY 21° APART, NEED 35°', tone: 'info' });
    expect(signalNotice('x', bearing({ count: 3, separation: 50, toFallback: 2 }), false, 35).text).toBe('BEARING 3 RECORDED · ±3.4° · NO FIX YET · AT MOST 2 MORE');
    expect(signalNotice('x', bearing({ bearing: { x: 0, y: 0, angle: 0, spread: 6.86 } }), true, 35).text).toBe('BEARING 1 RECORDED · ±6.9° · INTERFERENCE: WIDER ERROR · NEXT FROM A NEW ANGLE');
    expect(signalNotice('x', bearing({ count: 2, separation: 60, toFallback: 3, resolved: { x: 1, y: 2, how: 'fix', clean: true } }), false, 35)).toEqual({ text: 'BEARING 2 RECORDED · ±3.4° · SOURCE RESOLVED · INVESTIGATE THERE', tone: 'gain' });
  });

  it('does not stack the same line within 1.5 s of sim time; a new line, a later repeat or a restart shows', () => {
    const m = { text: '', tick: -1 };
    expect(repeatsLast(m, 'A', 100)).toBe(false);
    expect(repeatsLast(m, 'A', 100 + SIGNAL_REPEAT_TICKS - 1)).toBe(true);
    expect(repeatsLast(m, 'B', 150)).toBe(false);
    expect(repeatsLast(m, 'B', 150 + SIGNAL_REPEAT_TICKS)).toBe(false);
    expect(repeatsLast(m, 'B', 3)).toBe(false); // restart: the tick went back
  });

  it('an over-speed hold produces one interruption, not one per frame; repeated presses produce one line', () => {
    const { p, r, s } = setup();
    const at = polar(s, 0, 300);
    press(r, p.id, at);
    r.ship.vx = 400;
    const ev = signals(fly(r, 120, null));
    expect(ev.filter((x) => x.kind === 'interrupted')).toHaveLength(1);
    const m = { text: '', tick: -1 };
    let shown = 0;
    place(r, at);
    r.ship.vx = 200;
    for (let i = 0; i < 6; i++) {
      r.focus = p.id;
      for (const x of signals(interact(r))) if (!repeatsLast(m, signalNotice(p.label, x, false, 35).text, r.tick)) shown++;
    }
    expect(shown).toBe(1);
  });
});

/* ------------------------------------------------------------ presentation reads */
describe('presentation reads: hold progress, recorded bearings', () => {
  it('progress follows the sim ticks of the hold and the prompt shows it; it clears on every interruption', () => {
    const { p, r, s } = setup();
    const at = polar(s, 0, 300);
    fly(r, 1, at);
    expect(poiVerb(r, p, 'Investigate')).toBe('Take bearing');
    press(r, p.id, at);
    expect(signalProgress(r)).toBe(0);
    fly(r, 24, at);
    expect(signalProgress(r)).toBeCloseTo(0.5, 9);
    expect(signalProgress(r, p.id)).toBeCloseTo(0.5, 9);
    expect(signalProgress(r, 'other')).toBe(0);
    expect(poiVerb(r, p, 'Investigate')).toBe('Hold steady 50%');
    fly(r, 24, at);
    expect(signalProgress(r)).toBe(0); // recorded
    expect(poiVerb(r, p, 'Investigate')).toBe('Take bearing 2');
    const at2 = polar(s, 70, 300);
    const breaks: [string, () => void][] = [
      ['speed', () => { r.ship.vx = 400; stepSector(r, idle); }],
      ['pause', () => { pauseSector(r); resumeSector(r); }],
      ['ship change', () => applyShip(r, deriveShip('swift'))],
      ['restart', () => restartSector(r)],
    ];
    for (const [name, cut] of breaks) {
      press(r, p.id, at2);
      fly(r, 10, at2);
      expect(signalProgress(r), name).toBeGreaterThan(0);
      cut();
      expect(signalProgress(r), name).toBe(0);
    }
    press(r, p.id, at2);
    fly(r, 10, at2);
    disposeSectorRun(r);
    expect(signalProgress(r)).toBe(0);
  });

  it('the drawn bearings are the recorded, noisy observations (not the true directions), and vanish on resolution', () => {
    const { p, L, r, s } = setup();
    const recorded: number[] = [];
    for (const deg of [0, 70]) {
      const at = polar(s, deg, 300);
      press(r, p.id, at);
      for (const x of signals(fly(r, SIGNAL.holdTicks, at))) if (x.kind === 'bearing') recorded.push(x.bearing.angle);
      if (deg === 0) {
        const bs = openBearings(r, p)!;
        expect(bs.map((b) => b.angle)).toEqual(recorded);
        const truth = Math.atan2(s.y - at.y, s.x - at.x);
        expect(Math.abs(wrapAngle(bs[0]!.angle - truth))).toBeGreaterThan(1e-6); // noise, not the source direction
        expect(Math.abs(wrapAngle(bs[0]!.angle - truth))).toBeLessThanOrEqual(bs[0]!.spread * DEG + 1e-9);
      }
    }
    expect(signalView(r, p)!.fix).not.toBeNull();
    expect(openBearings(r, p)).toBeNull(); // resolved: the investigation point takes over
    expect(openBearings(r, { ...STATION })).toBeNull();
    void L;
  });
});

describe('drawing boundary', () => {
  const src = (f: string): string => readFileSync(join(root, 'src/modes/freeroam', f), 'utf8');
  it('the world renderer reads only marker, ring, progress and recorded bearings; the ring is centred on the marker', () => {
    expect(src('sector/render.ts')).toMatch(/^import \{ openBearings, ringRadius, signalPoint, signalProgress \} from '\.\/signal\.ts';$/m);
    expect(src('ui/signalNotice.ts')).toMatch(/^import type \{ SignalRefusal, SignalResult \} from '\.\.\/sector\/signal\.ts';$/m);
    for (const f of ['sector/render.ts', 'ui/signalNotice.ts', 'freeRoamMode.ts']) expect(src(f)).not.toMatch(/signalSource|measureBearing|signalBlocker|resolveSignal|sourceRadius/);
  });
});

/* ------------------------------------------------------------ prompt priority */
describe('INTERACT priority next to stations', () => {
  it('a station within its reach keeps the prompt even when an unresolved marker is nearer; the observed signal keeps it while held', () => {
    const st = { ...STATION, x: mid.x, y: mid.y } as Poi;
    const ship = { x: st.x + st.r - 6, y: st.y };
    const p = { ...anomalyAt('anomaly-1', { x: ship.x + 60, y: ship.y }), r: 20 } as Poi; // nearer than the station, beyond its own investigate reach
    const L = open([st, p]);
    const r = createSectorRun(L, SURVEYED, { seed: 1, ship: deriveShip('petrel') });
    expect(60).toBeGreaterThan(p.r + r.tune.radius);
    expect(60).toBeLessThan(Math.hypot(ship.x - st.x, ship.y - st.y)); // P06.1 picked the nearer anomaly here
    fly(r, 1, ship);
    expect(r.focus).toBe(st.id);
    // away from the station: the signal answers within sensor range
    const far = { x: p.x + 300, y: p.y + 200 };
    fly(r, 1, far);
    expect(r.focus).toBe(p.id);
    expect(signals(interact(r))[0]?.kind).toBe('observing');
    // during the hold the signal keeps the prompt, even beside the station
    fly(r, 5, far);
    expect(r.focus).toBe(p.id);
    fly(r, SIGNAL.holdTicks, far);
    fly(r, 1, ship);
    expect(r.focus).toBe(st.id); // bearing done: the station is back
    expect(interact(r).some((e) => e.type === 'docked')).toBe(true);
  });

  it('an unresolved anomaly is never investigated from the prompt; resolved, it is investigated at the fix', () => {
    const { p, r, s } = setup();
    fly(r, 1, p);
    expect(r.focus).toBe(p.id);
    expect(interact(r).some((e) => e.type === 'looted')).toBe(false);
    setSignalOptions(r, { simple: true, assist: 1 });
    fly(r, SIGNAL.holdTicks, p); // the press at the marker above started a bearing
    const fix = signalView(r, p)!.fix!;
    expect(fix.how).toBe('simple');
    fly(r, 1, fix);
    expect(r.focus).toBe(p.id);
    expect(poiVerb(r, p, 'Investigate')).toBe('Investigate');
    expect(interact(r).filter((e) => e.type === 'looted')).toHaveLength(1);
    void s;
  });
});

/* ------------------------------------------------------------ settings */
describe('CONTROLS · SIGNALS (Simple Signals)', () => {
  const shell = readFileSync(join(root, 'src/modes/freeroam/freeRoamMode.ts'), 'utf8');

  it('is a STANDARD / SIMPLE pair in the CONTROLS panel, after SHIP MIND, saved through the existing prefs path', () => {
    expect(shell).toMatch(/el\('div', 'fr-controls-mode fr-controls-signals'\)/);
    expect(shell).toMatch(/signalRow\.setAttribute\('aria-label', 'Simple Signals'\)/);
    expect(shell).toMatch(/signalBtns = \{ standard: signalBtn\('standard', 'STANDARD'\), simple: signalBtn\('simple', 'SIMPLE'\) \}/);
    expect(shell).toMatch(/adviceDesc\.after\(signalRow, signalDesc\)/);
    expect(shell).toMatch(/controls = withSimpleSignals\(controls, m === 'simple'\);\s*setControls\(\{\}\);/);
    // the toggle state: aria-pressed and the selected style follow the saved preference on every refresh
    expect(shell).toMatch(/signalBtns\[m\]\.setAttribute\('aria-pressed', String\(simple === \(m === 'simple'\)\)\)/);
    // not the flight-mode hook (a harness counts .fr-mode-btn) and no new settings store
    expect(shell).not.toMatch(/signalBtn[^\n]*fr-mode-btn/);
    expect(shell.match(/saveFreeRoamPrefs\(/g)?.length).toBe(1);
  });

  it('turning it off restores multi-bearing play; the run reads the preference each frame', () => {
    expect(shell).toMatch(/setSignalOptions\(r, \{ simple: controls\.simpleSignals === true,/);
    const { p, r, s } = setup();
    setSignalOptions(r, { simple: true, assist: 1 });
    setSignalOptions(r, { simple: false, assist: 1 });
    const at = polar(s, 0, 300);
    press(r, p.id, at);
    fly(r, SIGNAL.holdTicks, at);
    expect(signalView(r, p)).toMatchObject({ state: 'bearings', fix: null });
  });
});

/* ------------------------------------------------------------ guide */
describe('HOW TO PLAY: tracing a faint signal', () => {
  const ctx = (o: Partial<GuideContext> = {}): GuideContext => ({ mode: 'freeroam', input: 'keyboard', bindings: DEFAULT_BINDINGS, mouseAim: false, classicGate: false, ...o }) as GuideContext;
  const text = (c: GuideContext): string => JSON.stringify(guideStep('controls', c).blocks);

  it('explains the sequence on every Free Roam input with the existing INTERACT control, and not in Classic', () => {
    for (const input of GUIDE_INPUTS) {
      const t = text(ctx({ input }));
      for (const w of ['FAINT SIGNAL', 'below 60 speed', 'hold steady', '35°', 'same spot', 'planet or star in the line', 'interference', 'INVESTIGATE', 'usual reward, once', 'SIGNALS: SIMPLE']) expect(t, `${input}: ${w}`).toContain(w);
    }
    expect(text(ctx({ input: 'touch' }))).toContain('tap the TAKE BEARING prompt');
    expect(text(ctx({ mode: 'classic' }))).not.toContain('FAINT SIGNAL');
  });
});
