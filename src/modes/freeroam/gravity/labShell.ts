/**
 * Gravity Flight prototype P01: the browser side of the experiment (DOM).
 * Loaded only by a dynamic import inside a branch on the
 * __GALAXIA_GRAVITY_LAB__ literal (dev, tests, `npm run build:qa`), so release
 * builds contain none of it (scripts/lib/distCheck.ts checks LAB_MARKER).
 *
 * It owns: the experimental sector run (Sol's sector record, one gravity body),
 * the mapping from the existing controls to rotate-and-thrust (keyboard: turn /
 * thrust / brake; stick and touch joystick: point the nose, push to thrust once
 * it is aligned; mouse aim and right stick: rotate), the LAB button and drawer
 * (scenarios, toggles, bounded tuning, exit), the status chip, the diagnostics
 * panel and the canvas overlay. Settings live for this browser session only;
 * nothing is written to storage and nothing is sent anywhere.
 */
import type { CameraView } from '../camera.ts';
import type { Bindings } from '../bindings.ts';
import type { NavGraph } from '../galaxy/graph.ts';
import { sectorContext } from '../sector/context.ts';
import { generateSector } from '../sector/generate.ts';
import { createSectorRun, type SectorInput, type SectorRun } from '../sector/run.ts';
import type { SectorLayout } from '../sector/model.ts';
import type { DerivedShip } from '../ships/types.ts';
import { DEFAULT_PARAMS, ENEMY_FAMILIES, gravityLabLayout, LAB_NAME, LAB_SAVE, LAB_SYSTEM_ID, PARAM_SPECS, sanitizeParams, scenarioStart, type EnemyFamily, type LabParams, type ParamSpec, type ScenarioId } from './config.ts';
import { applyScenario, createGravityLab, installGravityLab, setLabParams, surfacePullRatio, type GravityLab, type PassRecord } from './lab.ts';
import { drawGravityOverlay, type OverlayOptions } from './render.ts';

/** Carried by this chunk; a release build that contains it fails verify:dist. */
export const LAB_MARKER = 'GALAXIA · Gravity Lab';

/** Lab hotkeys (each works only while no flight action is bound to it). */
export const LAB_KEYS = Object.freeze({ assist: 'KeyG', path: 'KeyV', drawer: 'KeyT', reset: 'KeyR', a: 'Digit1', b: 'Digit2', c: 'Digit3', diag: 'Backquote' });
const RESET_ONLY: readonly (keyof LabParams)[] = ['startSpeed', 'approachDeg', 'enemyGap', 'enemyFamily'];

export interface LabShellDeps {
  readonly graph: NavGraph;
  readonly craft: DerivedShip;
  readonly seed: number;
  /** Positioning context (the flight root). */
  readonly root: HTMLElement;
  /** The HUD button row: the LAB button goes in front of the pause button. */
  readonly hudButtons: HTMLElement;
  /** Pause the flight for the drawer; false if it could not (already paused). */
  readonly pause: () => boolean;
  /** Resume after the drawer (the shell resets its clock). */
  readonly resume: () => void;
  /** Leave the test (back to the system map). */
  readonly exit: () => void;
  readonly notice: (title: string, detail?: string) => void;
  readonly sound: (id: 'uiSelect' | 'uiMove') => void;
  /** After a scenario (re)start: snap the camera, clear effects. */
  readonly onReset: () => void;
}

/** Inputs the shell already reads every frame (existing helpers). */
export interface LabInputParts {
  /** Keyboard WASD / arrows vector (input.ts keyboardVector). */
  readonly keys: { readonly x: number; readonly y: number };
  /** Left stick + touch joystick (input.ts padVector + pointers). */
  readonly stick: { readonly x: number; readonly y: number };
  /** Right stick or mouse aim (relative), or null. */
  readonly aim: { readonly x: number; readonly y: number } | null;
  readonly fire: boolean;
  readonly boost: boolean;
}

export interface LabStatus {
  readonly scenario: ScenarioId;
  readonly assist: boolean;
  readonly path: boolean;
  readonly diag: boolean;
  readonly drawer: boolean;
  readonly model: LabParams['flightModel'];
  readonly params: LabParams;
  readonly tick: number;
  readonly resets: number;
  readonly speed: number;
  readonly speedRel: number;
  readonly maxSpeed: number;
  readonly gravity: number;
  readonly engine: number;
  readonly assistThrust: number;
  readonly altitude: number;
  readonly energy: number;
  readonly inField: boolean;
  readonly fieldRadius: number;
  readonly fieldSeconds: number;
  readonly collisions: number;
  readonly escapes: number;
  readonly enemyDistance: number | null;
  readonly enemyState: string | null;
  readonly enemyLocked: boolean;
  readonly lockLosses: number;
  readonly prediction: { readonly count: number; readonly impactIn: number; readonly closest: number };
  readonly advice: { readonly heading: number | null; readonly escapes: boolean; readonly status: string; readonly time: number | null };
  readonly combat: {
    readonly sightBlocked: boolean;
    readonly blockedSeconds: number;
    readonly coveredSeconds: number;
    readonly exposedSeconds: number;
    readonly enemyShots: number;
    readonly shotsStopped: number;
    readonly damageShots: number;
    readonly damageRam: number;
    readonly damagePlanet: number;
    readonly fireDelayAfterCover: number;
    readonly pursuit: string;
    readonly engineDv: number;
    readonly assistDv: number;
    readonly headingChangeDeg: number;
  };
  readonly passes: readonly PassRecord[];
  readonly current: PassRecord | null;
  readonly body: { readonly x: number; readonly y: number; readonly r: number };
  readonly heading: number;
  /** Ship position and velocity (sector px), for automated-browser pilots. */
  readonly ship: { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number };
}

export interface LabShell {
  readonly layout: SectorLayout;
  readonly run: SectorRun;
  readonly lab: GravityLab;
  /** Codes the key tracker must watch while the lab is active. */
  readonly codes: readonly string[];
  readonly drawerOpen: boolean;
  /** Rotate-and-thrust input for this frame (vector model) or the plain input (assisted model). */
  input(parts: LabInputParts, live: boolean): SectorInput;
  /** A key press in flight; true when the lab used it. */
  key(code: string, binds: Bindings): boolean;
  /** A key press while the drawer is open (all presses are swallowed). */
  drawerKey(code: string): void;
  openDrawer(): void;
  closeDrawer(): void;
  scenario(id: ScenarioId): void;
  reset(): void;
  draw(ctx: CanvasRenderingContext2D, view: CameraView, o: OverlayOptions): void;
  /** DOM refresh (chip, diagnostics), throttled to the sim tick. */
  frame(panelOpen: boolean): void;
  status(): LabStatus;
  dispose(): void;
}

/** Session-only settings (survive leaving and re-entering the lab, never stored). */
let session: { params: LabParams; assist: boolean; path: boolean; diag: boolean; scenario: ScenarioId } = { params: DEFAULT_PARAMS, assist: false, path: false, diag: false, scenario: 'B' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const STYLE_ID = 'fr-gravity-lab-style';
const CSS = `
.fr-lab-chip{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(max(10px,var(--safe-bottom,0px)) + 22px);margin:0;padding:2px 8px;max-width:calc(100% - 24px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:rgba(6,7,15,.72);border-left:2px solid #5cefff;color:#f3efe4;font-size:10px;letter-spacing:.12em;pointer-events:none}
/* touch layouts: bottom-left, above the wrapped hint and left of BOOST / FIRE */
@media (pointer:coarse){.fr-lab-chip{left:max(10px,var(--safe-left,0px));transform:none;bottom:calc(max(10px,var(--safe-bottom,0px)) + 64px);max-width:calc(100% - 200px);white-space:normal}}
.freeroam-app[data-input='touch'] .fr-lab-chip{left:max(10px,var(--safe-left,0px));transform:none;bottom:calc(max(10px,var(--safe-bottom,0px)) + 64px);max-width:calc(100% - 200px);white-space:normal}
.freeroam-app:not([data-panel='none']) .fr-lab-chip,.fr-lab-chip[hidden]{display:none}
.fr-hud-cargo[hidden]{display:none}
.fr-lab-diag{position:absolute;left:max(10px,var(--safe-left,0px));top:calc(max(8px,var(--safe-top,0px)) + 96px);margin:0;padding:6px 8px;max-width:min(400px,calc(100vw - 20px));max-height:calc(100% - 220px);overflow:hidden;background:rgba(6,7,15,.7);border:1px solid rgba(92,239,255,.35);color:#f3efe4;font:10px/1.35 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none}
/* narrow screens: the panel spans the width, so keep it compact and above the screen centre (the ship) */
@media (max-width:760px){.fr-lab-diag{font-size:8px;max-height:max(40px,calc(50% - 150px))}}
.freeroam-app:not([data-panel='none']) .fr-lab-diag,.fr-lab-diag[hidden]{display:none}
.fr-lab-btn{color:#5cefff}
.freeroam-app:not([data-panel='none']) .fr-lab-btn{visibility:hidden}
.fr-lab-drawer{position:absolute;inset:max(8px,var(--safe-top,0px)) max(8px,var(--safe-right,0px)) max(8px,var(--safe-bottom,0px)) max(8px,var(--safe-left,0px));margin:auto;width:min(560px,calc(100% - 16px));max-height:calc(100% - 16px);height:fit-content;overflow:auto;padding:12px 14px;display:grid;gap:10px;align-content:start;background:rgba(6,7,15,.94);border:1px solid #5cefff;color:#f3efe4;z-index:30}
.fr-lab-drawer[hidden]{display:none}
.fr-lab-drawer h2{margin:0;font-size:14px;letter-spacing:.14em;color:#5cefff}
.fr-lab-drawer p{margin:0;font-size:11px;line-height:1.45;color:#b9bdd0}
.fr-lab-drawer h3{margin:4px 0 0;font-size:11px;letter-spacing:.14em;color:#7d84a3}
.fr-lab-row{display:flex;flex-wrap:wrap;gap:6px}
.fr-lab-row button,.fr-lab-drawer select{min-height:44px;min-width:44px;padding:0 10px;border:1px solid rgba(243,239,228,.35);background:rgba(20,22,38,.9);color:#f3efe4;font:inherit;font-size:11px;letter-spacing:.08em;cursor:pointer;touch-action:manipulation}
.fr-lab-row button[aria-pressed='true']{border-color:#5cefff;color:#5cefff}
.fr-lab-row button:focus-visible,.fr-lab-drawer select:focus-visible,.fr-lab-drawer input:focus-visible{outline:2px solid #5cefff;outline-offset:1px}
.fr-lab-row button.is-exit{border-color:#ff3b4e;color:#fff;background:#8a1622}
.fr-lab-params{display:grid;gap:4px}
.fr-lab-param{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px 10px;font-size:11px}
.fr-lab-param input{grid-column:1 / -1;width:100%;min-height:32px;accent-color:#5cefff}
.fr-lab-param output{color:#5cefff;font-variant-numeric:tabular-nums}
.fr-lab-param small{color:#7d84a3}
`;

const fmt = (n: number, d = 0): string => (Number.isFinite(n) ? n.toFixed(d) : '—');
const dist = (n: number | null): string => (n === null ? '—' : fmt(n));

export function createLabShell(deps: LabShellDeps): LabShell {
  const sys = deps.graph.system(LAB_SYSTEM_ID);
  if (!sys) throw new Error('gravity lab: Sol is missing from the catalogue');
  const base = generateSector(sys, sectorContext(deps.graph, LAB_SYSTEM_ID));
  const params = sanitizeParams(session.params);
  const { layout, body } = gravityLabLayout(base, params);
  const run = createSectorRun(layout, LAB_SAVE, { seed: deps.seed, ship: deps.craft, phase: 'flight' });
  const lab = createGravityLab(body, params);
  lab.scenario = session.scenario;
  lab.assist = session.assist;
  lab.showPath = session.path;
  installGravityLab(run, lab);
  let diagOn = session.diag;
  let drawer = false;
  const remember = (): void => {
    session = { params: lab.params, assist: lab.assist, path: lab.showPath, diag: diagOn, scenario: lab.scenario };
  };

  /* ---- DOM ---- */
  if (!document.getElementById(STYLE_ID)) {
    const style = el('style', '');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }
  const labBtn = el('button', 'fr-hudbtn fr-lab-btn', 'LAB');
  labBtn.type = 'button';
  labBtn.setAttribute('aria-label', 'Gravity test: scenarios, Flight Assist and tuning');
  labBtn.addEventListener('click', () => {
    openDrawer();
    labBtn.blur();
  });
  const pauseBtn = deps.hudButtons.querySelector('.fr-pause');
  deps.hudButtons.insertBefore(labBtn, pauseBtn);
  // cargo is closed in the lab (jettison would write the profile): hide its HUD button rather than show a dead control
  const cargoBtn = deps.hudButtons.querySelector<HTMLElement>('.fr-hud-cargo');
  const cargoWasHidden = cargoBtn?.hidden ?? false;
  if (cargoBtn) cargoBtn.hidden = true;
  const chip = el('p', 'fr-lab-chip');
  chip.setAttribute('aria-live', 'polite');
  const diagEl = el('pre', 'fr-lab-diag');
  diagEl.hidden = !diagOn;
  const drawerEl = el('div', 'fr-lab-drawer');
  drawerEl.hidden = true;
  drawerEl.setAttribute('role', 'dialog');
  drawerEl.setAttribute('aria-modal', 'true');
  drawerEl.setAttribute('aria-label', `${LAB_MARKER}: experimental gravity test`);
  deps.root.append(chip, diagEl, drawerEl);

  const toggles: { btn: HTMLButtonElement; get: () => boolean; label: string }[] = [];
  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement => {
    const b = el('button', '');
    b.type = 'button';
    b.addEventListener('click', () => {
      set(!get());
      deps.sound('uiMove');
      refreshDrawer();
      remember();
    });
    toggles.push({ btn: b, get, label });
    return b;
  };
  const button = (label: string, fn: () => void, cls = ''): HTMLButtonElement => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  const outputs = new Map<keyof LabParams, { input: HTMLInputElement; out: HTMLOutputElement; spec: ParamSpec }>();
  const showValue = (s: ParamSpec, v: number): string => `${fmt(v * (s.scale ?? 1), s.step * (s.scale ?? 1) < 1 ? (s.step * (s.scale ?? 1) < 0.1 ? 2 : 1) : 0)} ${s.unit ?? ''}`.trim();
  const buildDrawer = (): void => {
    const head = el('h2', '', `${LAB_NAME} · EXPERIMENTAL`);
    const note = el('p', '', 'Simulated gravity prototype in a separate Sol sector. Nothing here is saved or counts toward progress. Settings last for this session only.');
    const scen = el('div', 'fr-lab-row');
    for (const id of ['A', 'B', 'C'] as const) scen.append(button(scenarioStart(id, lab.params).title, () => {
      scenario(id);
      closeDrawer();
    }));
    const goal = el('p', 'fr-lab-goal', '');
    goal.dataset['role'] = 'goal';
    const tg = el('div', 'fr-lab-row');
    tg.append(
      toggle('GRAVITY FLIGHT ASSIST', () => lab.assist, (v) => (lab.assist = v)),
      toggle('PATH', () => lab.showPath, (v) => (lab.showPath = v)),
      toggle('DIAGNOSTICS', () => diagOn, (v) => {
        diagOn = v;
        diagEl.hidden = !v;
      }),
      toggle('VECTOR MODEL', () => lab.params.flightModel === 'vector', (v) => setLabParams(lab, { flightModel: v ? 'vector' : 'assisted' })),
    );
    const assistNote = el('p', '', 'Assist: while you thrust it cancels part of the sideways pull (never all of it, never along your thrust) and shows a suggested escape heading. It never turns, aims, fires or dodges, and does not guarantee escape. Off: gravity still acts in full. PATH: the engines-off estimate. VECTOR MODEL off: the normal controller with gravity added (comparison).');
    const enemy = el('div', 'fr-lab-row');
    const fam = el('select', '');
    fam.setAttribute('aria-label', 'Interceptor type (scenario C)');
    for (const f of ENEMY_FAMILIES) {
      const o = el('option', '', f.toUpperCase());
      o.value = f;
      fam.append(o);
    }
    fam.value = lab.params.enemyFamily;
    fam.addEventListener('change', () => {
      setLabParams(lab, { enemyFamily: fam.value as EnemyFamily });
      remember();
    });
    enemy.append(
      fam,
      toggle('ENEMY GRAVITY', () => lab.params.enemyGravity, (v) => setLabParams(lab, { enemyGravity: v })),
      toggle('ENEMY FIRE', () => lab.params.enemyFires, (v) => setLabParams(lab, { enemyFires: v })),
      toggle('PLANET BLOCKS SIGHT', () => lab.params.occlusion, (v) => setLabParams(lab, { occlusion: v })),
    );
    const list = el('div', 'fr-lab-params');
    for (const s of PARAM_SPECS) {
      const row = el('label', 'fr-lab-param');
      const name = el('span', '', s.label);
      if (RESET_ONLY.includes(s.key)) name.append(el('small', '', ' · next reset'));
      const out = el('output', '');
      const input = el('input', '');
      input.type = 'range';
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      input.value = String(lab.params[s.key]);
      input.addEventListener('input', () => {
        setLabParams(lab, { [s.key]: Number(input.value) } as Partial<LabParams>);
        out.textContent = showValue(s, lab.params[s.key]);
        remember();
      });
      out.textContent = showValue(s, lab.params[s.key]);
      row.append(name, out, input);
      list.append(row);
      outputs.set(s.key, { input, out, spec: s });
    }
    const end = el('div', 'fr-lab-row');
    end.append(
      button('DEFAULTS', () => {
        setLabParams(lab, DEFAULT_PARAMS);
        refreshDrawer();
        remember();
      }),
      button('RESET SCENARIO', () => {
        reset();
        closeDrawer();
      }),
      button('RESUME', () => closeDrawer()),
      button('EXIT TEST', () => deps.exit(), 'is-exit'),
    );
    const keysNote = el('p', '', 'Keys: A/D or ←/→ rotate · W/↑ thrust · S/↓ brake (reverse thrust) · fire and boost as usual · G assist · V path · R reset · 1/2/3 scenario · T this panel · ` diagnostics. Stick or touch joystick: point where you want the nose; push further to thrust once it faces that way.');
    drawerEl.append(head, note, el('h3', '', 'SCENARIO'), scen, goal, el('h3', '', 'DISPLAY AND ASSIST'), tg, assistNote, el('h3', '', 'INTERCEPTOR (C)'), enemy, el('h3', '', 'TUNING (BOUNDED)'), list, end, keysNote);
  };
  const refreshDrawer = (): void => {
    for (const t of toggles) {
      const on = t.get();
      t.btn.textContent = `${t.label}: ${on ? 'ON' : 'OFF'}`;
      t.btn.setAttribute('aria-pressed', String(on));
    }
    for (const [k, o] of outputs) {
      o.input.value = String(lab.params[k]);
      o.out.textContent = showValue(o.spec, lab.params[k] as number);
    }
    const goal = drawerEl.querySelector<HTMLElement>('[data-role="goal"]');
    if (goal) {
      const s = scenarioStart(lab.scenario, lab.params);
      goal.textContent = `Now: ${s.title} · ${s.goal}`;
    }
  };
  buildDrawer();
  refreshDrawer();

  /* ---- behaviour ---- */
  const announce = (): void => {
    const s = scenarioStart(lab.scenario, lab.params);
    deps.notice(s.title, s.goal);
  };
  function scenario(id: ScenarioId): void {
    applyScenario(run, lab, id);
    deps.sound('uiSelect');
    deps.onReset();
    remember();
    refreshDrawer();
    announce();
  }
  function reset(): void {
    scenario(lab.scenario);
  }
  function openDrawer(): void {
    if (drawer || run.phase !== 'flight') return;
    if (!deps.pause()) return;
    drawer = true;
    refreshDrawer();
    drawerEl.hidden = false;
    deps.sound('uiSelect');
    drawerEl.querySelector<HTMLButtonElement>('button')?.focus();
  }
  function closeDrawer(): void {
    if (!drawer) return;
    drawer = false;
    drawerEl.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    deps.resume();
  }

  let lastDiag = -1;
  let lastChip = '';
  const passLine = (p: PassRecord, moving: boolean): string =>
    `#${p.index} ${p.scenario}  in ${fmt(p.entrySpeed)} → peak ${fmt(p.maxSpeed)} → out ${fmt(p.exitSpeed)} px/s\n` +
    (moving ? `   planet frame: in ${fmt(p.entrySpeedRel)} → out ${fmt(p.exitSpeedRel)}\n` : '') +
    `   min alt ${fmt(p.altitude)} px · bend ${fmt(p.deflectionDeg)}° · ${fmt((p.exitTick - p.entryTick) / 60, 1)} s · hits ${p.collisions}\n` +
    `   engine Δv ${fmt(p.engineDv)} · assist Δv ${fmt(p.assistDv)} · ${p.escaped ? 'ESCAPED' : 'fell back'}\n` +
    (p.enemyAtEntry !== null ? `   enemy ${dist(p.enemyAtEntry)} → ${dist(p.enemyAtExit)} → +3 s ${dist(p.enemyAfter3s)} px\n` : '');
  const diagText = (): string => {
    const d = lab.diag;
    const moving = lab.params.planetSpeed > 0;
    const thrust = lab.params.thrust;
    const surface = surfacePullRatio(lab, run.tune.radius);
    const lines = [
      `${LAB_NAME} · DIAGNOSTICS (simulated)`,
      `scenario ${lab.scenario} · ${lab.params.flightModel} model · t ${fmt(lab.tick / 60, 1)} s`,
      `sight     ${d.sightBlocked ? 'BLOCKED by planet' : 'clear'} · blocked ${fmt(d.blockedSeconds, 1)} s · ${d.pursuit.toUpperCase()}`,
      `in range  covered ${fmt(d.coveredSeconds, 1)} s · exposed ${fmt(d.exposedSeconds, 1)} s`,
      `shots     ${d.enemyShots} fired · ${d.shotsStopped} stopped · ${d.fireDelayAfterCover >= 0 ? `fired ${fmt(d.fireDelayAfterCover / 60, 2)} s after cover` : 'no shot after cover'}`,
      `damage    shots ${fmt(d.damageShots, 1)} · ram ${fmt(d.damageRam, 1)} · planet ${fmt(d.damagePlanet, 1)}`,
      `effort    engine Δv ${fmt(d.engineDv)} · assist Δv ${fmt(d.assistDv)} · turned ${fmt(d.headingChangeDeg)}°`,
      `advice    ${lab.assist ? (lab.advice.status === 'escape' ? `ESCAPE ${fmt(lab.advice.time, 1)} s · turn ${fmt((lab.advice.turn * 180) / Math.PI)}°` : lab.advice.status === 'climb' ? 'CLIMB · no exit within look-ahead' : lab.advice.horizon > 0 ? `NO SAFE ESCAPE IN ${fmt(lab.advice.horizon)} s` : '—') : 'assist off'}`,
      `speed     ${fmt(d.speed)} px/s${moving ? ` · planet frame ${fmt(d.speedRel)}` : ''}`,
      `start     ${fmt(d.startSpeed)} · peak ${fmt(d.maxSpeed)}`,
      `gravity   ${fmt(d.gravity)} px/s² (${fmt((d.gravity / thrust) * 100)}% of thrust)`,
      `surface   pull ${fmt(surface * 100)}% of thrust${surface >= 1 ? ' · CANNOT LIFT OFF (boost only)' : ''}`,
      `engine    ${fmt(d.engine)} · assist ${fmt(d.assist)} px/s²`,
      `altitude  ${fmt(d.altitude)} px · field r ${fmt(d.fieldRadius)} ${d.inField ? 'IN' : 'out'}`,
      `energy    ${fmt(d.energy)} (≥ 0 leaves the field unpowered)`,
      `in field  ${fmt(d.fieldSeconds, 1)} s · hits ${d.collisions} · escapes ${d.escapes}`,
      `enemy     ${d.enemyDistance === null ? 'none' : `${fmt(d.enemyDistance)} px · ${d.enemyState} · ${d.enemyLocked ? 'LOCKED' : 'no lock'}`} · lock lost ${d.lockLosses}`,
      `estimate  ${lab.prediction.impactIn >= 0 ? `IMPACT in ${fmt(lab.prediction.impactIn, 1)} s` : 'no impact'} · closest ${fmt(lab.prediction.closest)} px`,
    ];
    if (d.current) lines.push(`pass #${d.current.index} in progress · in ${fmt(d.current.entrySpeed)} · peak ${fmt(d.current.maxSpeed)} · min alt ${fmt(d.current.altitude)}`);
    const last = d.passes.slice(-2);
    if (last.length) lines.push('— recent passes —');
    for (const p of last) lines.push(passLine(p, moving).trimEnd());
    return lines.join('\n');
  };

  return {
    layout,
    run,
    lab,
    codes: Object.values(LAB_KEYS),
    get drawerOpen() {
      return drawer;
    },
    input(p: LabInputParts, live: boolean): SectorInput {
      if (!live) return { moveX: 0, moveY: 0 };
      if (lab.params.flightModel === 'assisted') {
        // comparison model: the normal controller and its usual input
        const x = p.keys.x + p.stick.x;
        const y = p.keys.y + p.stick.y;
        const l = Math.hypot(x, y);
        const mx = l > 1 ? x / l : x;
        const my = l > 1 ? y / l : y;
        return p.aim ? { moveX: mx, moveY: my, aimX: p.aim.x, aimY: p.aim.y, fire: p.fire, boost: p.boost } : { moveX: mx, moveY: my, fire: p.fire, boost: p.boost };
      }
      const turn = p.keys.x > 0.1 ? 1 : p.keys.x < -0.1 ? -1 : 0;
      const thrust = p.keys.y < -0.1 ? 1 : 0;
      const reverse = p.keys.y > 0.1 ? 1 : 0;
      const sl = Math.hypot(p.stick.x, p.stick.y);
      const vector = { turn, thrust, reverse, pointX: p.stick.x, pointY: p.stick.y, aimX: p.aim?.x, aimY: p.aim?.y };
      // the boost rule needs "thrust held": main engine keys, or a stick pushed past the thrust threshold
      const level = Math.max(thrust, reverse, sl > 0.3 ? 1 : 0);
      return { moveX: 0, moveY: -level, vector, fire: p.fire, boost: p.boost };
    },
    key(code: string, binds: Bindings): boolean {
      if (Object.values(binds).some((k) => k.includes(code))) return false;
      if (code === LAB_KEYS.assist) {
        lab.assist = !lab.assist;
        deps.notice(`GRAVITY FLIGHT ASSIST ${lab.assist ? 'ON' : 'OFF'}`);
      } else if (code === LAB_KEYS.path) {
        lab.showPath = !lab.showPath;
        deps.notice(`PATH ESTIMATE ${lab.showPath ? 'ON' : 'OFF'}`);
      } else if (code === LAB_KEYS.diag) {
        diagOn = !diagOn;
        diagEl.hidden = !diagOn;
      } else if (code === LAB_KEYS.reset) reset();
      else if (code === LAB_KEYS.a) scenario('A');
      else if (code === LAB_KEYS.b) scenario('B');
      else if (code === LAB_KEYS.c) scenario('C');
      else if (code === LAB_KEYS.drawer) openDrawer();
      else return false;
      deps.sound('uiMove');
      remember();
      refreshDrawer();
      return true;
    },
    drawerKey(code: string): void {
      if (code === 'Escape' || code === LAB_KEYS.drawer) closeDrawer();
    },
    openDrawer,
    closeDrawer,
    scenario,
    reset,
    draw(ctx: CanvasRenderingContext2D, view: CameraView, o: OverlayOptions): void {
      drawGravityOverlay(ctx, run, lab, view, o);
    },
    frame(panelOpen: boolean): void {
      const chipText = `${LAB_NAME} · ${scenarioStart(lab.scenario, lab.params).title} · ASSIST ${lab.assist ? 'ON' : 'OFF'}${lab.params.flightModel === 'assisted' ? ' · NORMAL CONTROLLER' : ''}`;
      if (chipText !== lastChip) {
        chip.textContent = chipText;
        lastChip = chipText;
      }
      chip.hidden = panelOpen || drawer;
      if (diagOn && !panelOpen && (lab.tick - lastDiag >= 6 || lab.tick < lastDiag)) {
        lastDiag = lab.tick;
        diagEl.textContent = diagText();
      }
    },
    status(): LabStatus {
      const d = lab.diag;
      return {
        scenario: lab.scenario,
        assist: lab.assist,
        path: lab.showPath,
        diag: diagOn,
        drawer,
        model: lab.params.flightModel,
        params: lab.params,
        tick: lab.tick,
        resets: lab.resets,
        speed: d.speed,
        speedRel: d.speedRel,
        maxSpeed: d.maxSpeed,
        gravity: d.gravity,
        engine: d.engine,
        assistThrust: d.assist,
        altitude: d.altitude,
        energy: d.energy,
        inField: d.inField,
        fieldRadius: d.fieldRadius,
        fieldSeconds: d.fieldSeconds,
        collisions: d.collisions,
        escapes: d.escapes,
        enemyDistance: d.enemyDistance,
        enemyState: d.enemyState,
        enemyLocked: d.enemyLocked,
        lockLosses: d.lockLosses,
        prediction: { count: lab.prediction.count, impactIn: lab.prediction.impactIn, closest: lab.prediction.closest },
        advice: {
          heading: Number.isFinite(lab.advice.heading) ? lab.advice.heading : null,
          escapes: lab.advice.escapes,
          status: lab.advice.status,
          time: Number.isFinite(lab.advice.time) ? lab.advice.time : null,
        },
        combat: {
          sightBlocked: d.sightBlocked,
          blockedSeconds: d.blockedSeconds,
          coveredSeconds: d.coveredSeconds,
          exposedSeconds: d.exposedSeconds,
          enemyShots: d.enemyShots,
          shotsStopped: d.shotsStopped,
          damageShots: d.damageShots,
          damageRam: d.damageRam,
          damagePlanet: d.damagePlanet,
          fireDelayAfterCover: d.fireDelayAfterCover,
          pursuit: d.pursuit,
          engineDv: d.engineDv,
          assistDv: d.assistDv,
          headingChangeDeg: d.headingChangeDeg,
        },
        passes: d.passes.map((p) => ({ ...p })),
        current: d.current ? { ...d.current } : null,
        body: { x: lab.body.x, y: lab.body.y, r: lab.body.r },
        heading: run.ship.heading,
        ship: { x: run.ship.x, y: run.ship.y, vx: run.ship.vx, vy: run.ship.vy },
      };
    },
    dispose(): void {
      remember();
      labBtn.remove();
      chip.remove();
      diagEl.remove();
      drawerEl.remove();
      if (cargoBtn) cargoBtn.hidden = cargoWasHidden;
      run.flight = null;
    },
  };
}
