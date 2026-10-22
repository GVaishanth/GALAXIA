/**
 * Simulated controllers and audio lifecycle in real browsers (TD-81).
 * navigator.getGamepads() is replaced by an init script with a scripted
 * standard-mapping pad; gamepadconnected / gamepaddisconnected are dispatched
 * like the browser does. Reads the automation hooks, so run it against the
 * e2e build (`npm run build:e2e` + `npm run preview:e2e`).
 *
 *   node controller-sim.mjs <url ending in the base> [engines]
 *
 * Physical controllers and listening were NOT tested by this script.
 */
import { chromium, firefox, webkit } from 'playwright';

const URL0 = process.argv[2] ?? 'http://localhost:4181/galaxia/';
const ENGINES = (process.argv[3] ?? 'chromium,firefox,webkit').split(',');
const BT = { chromium, firefox, webkit };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) pass += 1;
  else fails.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 700)}`}`);
};
/** A check that cannot run here: reported, never counted as a pass. */
const skips = [];
const skip = (name, why) => { skips.push(`${name} (${why})`); console.log(`SKIP ${name}  (${why})`); };
/** Can this browser run any AudioContext at all? (No audio output device -> Firefox stays suspended.) */
const audioDeviceOk = (p) => p.evaluate(async () => {
  const c = new AudioContext();
  await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]);
  const ok = c.state === 'running';
  void c.close();
  return ok;
});
const NO_AUDIO = 'environment: this browser cannot start any AudioContext here (no audio output device; a bare context stays suspended)';

function installFakePads() {
  const slots = [null, null, null, null];
  const mk = (i) => ({ index: i, id: 'Simulated pad (STANDARD GAMEPAD)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => slots.slice() });
  const fire = (type, pad) => { const e = new Event(type); Object.defineProperty(e, 'gamepad', { value: pad }); window.dispatchEvent(e); };
  window.__pad = {
    connect(i = 0) { slots[i] = mk(i); fire('gamepadconnected', slots[i]); },
    disconnect(i = 0) { const p = slots[i]; if (!p) return; p.connected = false; slots[i] = null; fire('gamepaddisconnected', p); },
    button(i, b, on) { const p = slots[i]; if (p) { p.buttons[b] = { pressed: on, touched: on, value: on ? 1 : 0 }; p.timestamp += 1; } },
    axis(i, a, v) { const p = slots[i]; if (p) { p.axes[a] = v; p.timestamp += 1; } },
  };
}
const B = { a: 0, b: 1, x: 2, y: 3, select: 8, start: 9, up: 12, down: 13, left: 14, right: 15 };
const pad = (p, fn, ...args) => p.evaluate(([f, a]) => window.__pad[f](...a), [fn, args]);
/** A tap: down for ~3 frames, then up. */
async function tap(p, b, i = 0) { await pad(p, 'button', i, b, true); await sleep(70); await pad(p, 'button', i, b, false); await sleep(70); }

const classic = (p) => p.evaluate(() => {
  const g = window.__galaxiaGame;
  if (!g?.engine) return null;
  const w = g.engine.world;
  return { phase: g.engine.phase, x: w.player?.x ?? null, heat: w.heat?.level ?? 0, autoPauses: g.autoPauses, input: g.inputMode, screen: g.screen, sound: g.sound.stats() };
});
const waitC = async (p, pred, ms = 10000) => {
  const t0 = Date.now(); let s = null;
  while (Date.now() - t0 < ms) { s = await classic(p); if (s && pred(s)) return s; await sleep(50); }
  return s;
};
const fr = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  if (!f) return null;
  const r = f.state;
  const ui = f.ui();
  return { screen: f.screen(), panel: f.panel(), phase: r?.phase, ship: r?.ship ? { x: r.ship.x, y: r.ship.y } : null, shots: r?.shotsFired ?? 0, ready: ui.panelReady, engine: ui.engine, sound: ui.sound };
});
const waitF = async (p, pred, ms = 12000) => {
  const t0 = Date.now(); let s = null;
  while (Date.now() - t0 < ms) { try { s = await fr(p); } catch { s = null; } if (s && pred(s)) return s; await sleep(60); }
  return s;
};

async function open(bname, mode) {
  const browser = await BT[bname].launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(installFakePads);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(`${URL0}?mode=${mode}`, { waitUntil: 'load' });
  return { browser, ctx, p, errs };
}

async function classicRun(bname) {
  const { browser, p, errs } = await open(bname, 'classic');
  const n = `${bname} classic`;
  try {
    await waitC(p, (s) => s.phase === 'title');
    // a real gesture unlocks audio (pads may not count as one; Firefox does not count
    // modifier keys either): click empty background, never a control
    const spot = await p.evaluate(() => {
      for (const [x, y] of [[640, 700], [20, 700], [1260, 700], [640, 10], [1260, 360]]) {
        const e = document.elementFromPoint(x, y);
        if (e && !e.closest('button, a, input, [role=switch], [tabindex], .mode-exit')) return { x, y, tag: e.tagName + '.' + e.className };
      }
      return null;
    });
    if (!spot) throw new Error('no empty background spot to click');
    await p.mouse.click(spot.x, spot.y);
    await pad(p, 'connect', 0);
    await sleep(200);
    await tap(p, B.a); // START GAME is focused on the title
    let s = await waitC(p, (x) => x.phase === 'playing', 12000);
    check(`${n}: pad connects; A on the title starts a game; input mode becomes gamepad`, s?.phase === 'playing' && s.input === 'gamepad', s);
    s = await waitC(p, (x) => x.sound.context === 'running', 3000);
    const audioEnv = s?.sound.context === 'running' || await audioDeviceOk(p);
    if (audioEnv) check(`${n}: audio is unlocked and the AudioContext is running in play`, s?.sound.unlocked === true && s.sound.context === 'running', s?.sound);
    else { check(`${n}: audio is unlocked (context created inside the gesture)`, s?.sound.unlocked === true, s?.sound); skip(`${n}: AudioContext running in play`, NO_AUDIO); }
    const x0 = s.x;
    await pad(p, 'axis', 0, 0, 1); await sleep(450); await pad(p, 'axis', 0, 0, 0); await sleep(80);
    const x1 = (await classic(p)).x;
    await pad(p, 'button', 0, B.left, true); await sleep(450); await pad(p, 'button', 0, B.left, false); await sleep(80);
    const x2 = (await classic(p)).x;
    check(`${n}: left stick moves right, D-pad left moves left, release stops`, x1 > x0 + 10 && x2 < x1 - 10, { x0, x1, x2 });
    await pad(p, 'button', 0, B.a, true); await sleep(900);
    const hot = (await classic(p)).heat;
    await pad(p, 'button', 0, B.a, false);
    check(`${n}: holding A fires (weapon heats)`, hot > 0, { hot });

    await tap(p, B.start);
    s = await waitC(p, (x) => x.phase === 'paused' && x.sound.context === 'suspended', 3000);
    check(`${n}: START pauses (and suspends audio: AudioContext suspended)`, s?.phase === 'paused' && s.sound.paused === true && s.sound.context === 'suspended', s);
    // (in a no-audio environment the context is suspended anyway: the paused flag carries this check there)
    const xp = s.x;
    await pad(p, 'axis', 0, 0, 1); await sleep(300); await pad(p, 'axis', 0, 0, 0);
    check(`${n}: the stick does nothing while paused`, (await classic(p)).x === xp);
    await tap(p, B.b); // B on the pause menu resumes
    s = await waitC(p, (x) => x.phase !== 'paused' && (x.sound.context === 'running' || !audioEnv), 3000);
    check(`${n}: B on the pause menu resumes (audio resumed${audioEnv ? ': AudioContext running' : ' flag'})`, s && s.phase !== 'paused' && s.sound.paused === false && (!audioEnv || s.sound.context === 'running'), s);
    if (!audioEnv) skip(`${n}: AudioContext running again after resume`, NO_AUDIO);

    // unplug mid-move: auto-pause, everything released; reconnect adds no phantom input
    await pad(p, 'axis', 0, 0, 1); await sleep(150);
    const before = (await classic(p)).autoPauses;
    const sync = await p.evaluate(() => { window.__pad.disconnect(0); const g = window.__galaxiaGame; return { phase: g.engine.phase, paused: g.sound.stats().paused }; });
    s = await waitC(p, (x) => x.phase === 'paused', 3000);
    const xd = s.x;
    await sleep(300);
    check(`${n}: unplugging mid-game auto-pauses at once (audio suspended in the same task)`, s.phase === 'paused' && s.autoPauses === before + 1 && sync.phase === 'paused' && sync.paused === true && (await classic(p)).x === xd, { sync, s });
    await pad(p, 'connect', 1);
    await sleep(300);
    s = await classic(p);
    check(`${n}: reconnecting (another slot) adds no input and stays paused`, s.phase === 'paused' && s.x === xd, s);
    await tap(p, B.start, 1);
    s = await waitC(p, (x) => x.phase !== 'paused', 3000);
    check(`${n}: START on the reconnected pad resumes`, s && s.phase !== 'paused', s);

    // focus loss with A held: auto-pause, and the held A does not fire after resuming
    await sleep(400);
    await pad(p, 'button', 1, B.a, true); await sleep(150);
    const blur = await p.evaluate(() => { window.dispatchEvent(new Event('blur')); const g = window.__galaxiaGame; return { phase: g.engine.phase, paused: g.sound.stats().paused }; });
    check(`${n}: window blur auto-pauses and suspends audio in the same task (hidden tabs run no frames)`, blur.phase === 'paused' && blur.paused === true, blur);
    await p.keyboard.press('Escape'); // keyboard and pad coexist: Esc resumes
    s = await waitC(p, (x) => x.phase !== 'paused', 3000);
    await sleep(100);
    const h0 = (await classic(p)).heat;
    await sleep(700);
    const h1 = (await classic(p)).heat;
    await pad(p, 'button', 1, B.a, false); await sleep(100);
    await pad(p, 'button', 1, B.a, true); await sleep(700);
    const h2 = (await classic(p)).heat;
    await pad(p, 'button', 1, B.a, false);
    check(`${n}: keyboard Esc resumes; A held through the blur does not fire until released and pressed again`, s.phase !== 'paused' && h1 <= h0 + 1e-6 && h2 > h1, { h0, h1, h2 });

    // keyboard still drives the ship with a pad connected
    const k0 = (await classic(p)).x;
    await p.keyboard.down('ArrowLeft'); await sleep(400); await p.keyboard.up('ArrowLeft'); await sleep(60);
    s = await classic(p);
    check(`${n}: keyboard moves the ship while a pad is connected (input mode follows)`, s.x < k0 - 10 && s.input === 'keyboard', { k0, x: s.x, input: s.input });
    check(`${n}: master runs through the safety limiter`, s.sound.limited === true, s.sound);
    check(`${n}: no page errors`, errs.length === 0, errs);
  } finally {
    await browser.close();
  }
}

async function freeRoamRun(bname) {
  const { browser, p, errs } = await open(bname, 'freeroam');
  const n = `${bname} freeroam`;
  try {
    await waitF(p, (s) => s.screen === 'map', 15000);
    await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
    await waitF(p, (s) => s.panel === 'briefing' && s.ready);
    await p.keyboard.press('Enter');
    let s = await waitF(p, (x) => x.phase === 'flight' && x.panel === null);
    await p.evaluate(() => { window.__galaxiaFreeRoam.state.grace = 1e9; });
    await pad(p, 'connect', 0);
    await sleep(200);
    const s0 = s.ship;
    await pad(p, 'axis', 0, 1, -1); await sleep(800);
    s = await fr(p);
    const moved = Math.hypot(s.ship.x - s0.x, s.ship.y - s0.y);
    check(`${n}: left stick flies the ship; the engine hum follows thrust`, moved > 20 && s.engine > 0, { moved, engine: s.engine });
    // unplug while thrusting: pause at once, hum silenced in the same task
    const sync = await p.evaluate(() => { window.__pad.disconnect(0); const f = window.__galaxiaFreeRoam; return { panel: f.panel(), engine: f.ui().engine }; });
    s = await waitF(p, (x) => x.panel === 'pause', 3000);
    check(`${n}: unplugging in flight pauses at once and silences the engine hum without waiting for a frame`, sync.panel === 'pause' && sync.engine === 0 && s.panel === 'pause', { sync, panel: s.panel });
    await pad(p, 'connect', 0);
    await sleep(300);
    s = await fr(p);
    check(`${n}: reconnecting adds no input (still paused)`, s.panel === 'pause', s);
    await tap(p, B.start);
    s = await waitF(p, (x) => x.panel === null, 3000);
    check(`${n}: START on the pause panel resumes flight`, s.panel === null && s.phase === 'flight', s);
    await tap(p, B.start);
    s = await waitF(p, (x) => x.panel === 'pause', 3000);
    check(`${n}: START in flight pauses`, s.panel === 'pause', s);
    await tap(p, B.b);
    s = await waitF(p, (x) => x.panel === null, 3000);
    check(`${n}: B on the pause panel resumes`, s.panel === null, s);
    // hidden tab: the host pauses; the hum stops in the same task
    await pad(p, 'axis', 0, 1, -1); await sleep(400);
    const hidden = await p.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      const f = window.__galaxiaFreeRoam;
      const out = { panel: f.panel(), engine: f.ui().engine };
      delete document.hidden; delete document.visibilityState;
      return out;
    });
    await pad(p, 'axis', 0, 1, 0);
    check(`${n}: a hidden tab pauses flight and silences the hum at once`, hidden.panel === 'pause' && hidden.engine === 0, hidden);
    check(`${n}: no page errors`, errs.length === 0, errs);
  } finally {
    await browser.close();
  }
}

for (const b of ENGINES) {
  try { await classicRun(b); } catch (e) { check(`${b} classic: run completed`, false, String(e)); }
  try { await freeRoamRun(b); } catch (e) { check(`${b} freeroam: run completed`, false, String(e)); }
}
console.log(`\ncontroller-sim: ${pass}/${pass + fails.length} passed${skips.length ? `, ${skips.length} skipped (not counted)` : ''}${fails.length ? `\nFAILED:\n  ${fails.join('\n  ')}` : ''}${skips.length ? `\nSKIPPED:\n  ${skips.join('\n  ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
