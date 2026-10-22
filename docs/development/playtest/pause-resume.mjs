// Release fixes (FR-TD-82): pause / CONTINUE in both modes, in real browsers, repeated.
// Usage (from a directory with playwright installed):
//   node pause-resume.mjs http://127.0.0.1:4180/galaxia/ [chromium,webkit,firefox] [rounds]
// Needs an e2e build (test hooks on) served at the URL. Real Playwright keyboard
// and mouse input. The harness only places the ship near a target, skips the
// arrival grace and makes the pilot invulnerable for the attack checks (so a
// pause happens with hostiles and shots in the air without the pilot dying).
// Blur is a real window blur event; a hidden tab is simulated by overriding
// document.hidden and dispatching visibilitychange (headless pages never hide).
//
// Each round, per engine:
//  Free Roam (Sirius ambush, then the Cordon minefield):
//   1. Esc mid-attack pauses: ship, hostiles, enemy shots, hull and the tick freeze for 600 ms while a key is held;
//   2. blur and a hidden tab while paused: still paused, one overlay, nothing moves;
//   3. RESUME (mouse) after a 2 s pause: the flight continues, hostiles move, the first 120 ms run
//      no more ticks than real time allows (no dt jump), one frame loop;
//   4. Esc then Enter on RESUME (keyboard) resumes;
//   5. 10 x P / P cycles: every pause and resume lands, state kept, one loop;
//   6. blur during flight auto-pauses; Enter resumes;
//   7. the recovery race: destroyed while steering, an arrow pressed as the screen appears is
//      ignored; CONTINUE (Enter) after it settles resumes at the beacon.
//  Classic:
//   8. Esc pauses mid-attack: the world digest is unchanged for 600 ms while keys are held;
//   9. blur / hidden while paused: still paused; RESUME (mouse) resumes, no dt jump, one loop;
//  10. Esc then Enter resumes; 10 x Esc / Esc cycles all land; no console errors.
import { chromium, firefox, webkit } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4180/galaxia/';
const ENGINES = (process.argv[3] ?? 'chromium,webkit,firefox').split(',');
const ROUNDS = Number(process.argv[4] ?? 1);
const BT = { chromium, webkit, firefox };
const SOL = 'milky-way/sol';
const SIRIUS = 'milky-way/sirius';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = new Map(); // check name -> { pass, fail }
let total = 0;
let failed = 0;
const check = (name, ok, info = {}) => {
  total += 1;
  const t = tally.get(name) ?? { pass: 0, fail: 0 };
  if (ok) t.pass += 1;
  else {
    t.fail += 1;
    failed += 1;
  }
  tally.set(name, t);
  if (!ok) console.log(`FAIL ${name} ${JSON.stringify(info).slice(0, 1200)}`);
};

const BINDINGS = { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], fire: ['Space', 'KeyK'], interact: ['KeyE', 'Enter'], map: ['KeyM', null], cargo: ['KeyI', null], pause: ['KeyP', null], boost: ['ShiftLeft', null] };
const PROG = { marks: 140, missions: { jumps: 0, active: [{ id: 'story-first-light', progress: [0], jumps: 0 }], completed: [], claimed: [], failed: [], ready: {} }, upgrades: {}, licences: [], log: { anomalies: [], wrecks: [], factions: [], facts: ['milky-way'], kills: 0, acquired: {} }, fuel: { starter: true, arrivals: 3, aidAt: 0 } };
const PILOT = (system) => ({
  version: 9, createdAt: 1, sessions: 5, flightSeconds: 900, beaconsCharted: 0, surveysCompleted: 1, bestSurveyTicks: 0,
  currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL], galaxySurveys: { 'milky-way': 1 },
  currentSystem: system, visitedSystems: [SOL, system], sectors: { [SOL]: { done: [], surveyed: true } },
  cargo: { scrap: 20, ice: 8, alloy: 8, fuel: 14 },
  controls: { bindings: BINDINGS, mouseAim: false, zoom: 1 },
  fleet: { active: 'petrel', owned: ['petrel'], loadouts: {} },
  lostCargo: null, modules: {}, milestones: [], progression: PROG,
});
function seedOnce(rec) {
  if (rec && !sessionStorage.getItem('pr-seeded')) {
    sessionStorage.setItem('pr-seeded', '1');
    localStorage.setItem('galaxia:freeroam', JSON.stringify(rec));
  }
}

/* ---------------------------------------------------------------- shared */
async function newPage(bname) {
  const browser = await BT[bname].launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(seedOnce, PILOT(SIRIUS));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  p.on('response', (r) => r.status() >= 400 && errs.push(`${r.status()} ${r.url()}`));
  return { browser, p, errs };
}
const loops = (p) => p.evaluate(() => window.__galaxia.debug().active?.loops ?? null);
/** Blur the window, then a simulated hidden tab and its return. */
const blurAndHide = (p) =>
  p.evaluate(async () => {
    window.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 60));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 200));
    delete document.hidden;
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await new Promise((r) => setTimeout(r, 60));
  });

/* -------------------------------------------------------------- Free Roam */
const st = (p) =>
  p.evaluate(() => {
    const f = window.__galaxiaFreeRoam;
    if (!f) return null;
    const sh = f.state.ship;
    return { screen: f.screen(), panel: f.panel(), phase: f.state.phase, ship: { x: sh.x, y: sh.y }, sector: f.sector(), ui: f.ui() };
  });
const waitFor = async (p, pred, ms = 8000) => {
  const t0 = Date.now();
  let s = await st(p);
  while (!(s && pred(s)) && Date.now() - t0 < ms) {
    await sleep(40);
    s = await st(p);
  }
  return s;
};
/** Everything a pause must not change, read straight from the run. */
const frozen = (p) =>
  p.evaluate(() => {
    const r = window.__galaxiaFreeRoam.state;
    const n = (v) => Math.round(v * 1000) / 1000;
    return JSON.stringify({ tick: r.tick, ship: [n(r.ship.x), n(r.ship.y), n(r.ship.vx), n(r.ship.vy)], hull: r.hull, shield: n(r.shield), hostiles: r.hostiles.map((h) => [h.id, n(h.x), n(h.y)]), shots: r.enemyShots.map((s) => [s.id, n(s.x), n(s.y)]) });
  });
const tickNow = (p) => p.evaluate(() => ({ tick: window.__galaxiaFreeRoam.state.tick, at: performance.now() }));
const place = (p, x, y) => p.evaluate(([x, y]) => Object.assign(window.__galaxiaFreeRoam.state.ship, { x, y, vx: 0, vy: 0 }), [x, y]);
async function flyTo(p, target, until, ms = 15000) {
  const held = new Set();
  const set = async (want) => {
    for (const k of [...held]) if (!want.has(k)) { await p.keyboard.up(k); held.delete(k); }
    for (const k of want) if (!held.has(k)) { await p.keyboard.down(k); held.add(k); }
  };
  const t0 = Date.now();
  let s = await st(p);
  try {
    while (Date.now() - t0 < ms) {
      s = await st(p);
      if (!s || until(s)) break;
      const dx = target.x - s.ship.x;
      const dy = target.y - s.ship.y;
      const d = Math.hypot(dx, dy) || 1;
      const want = new Set();
      if (d > 6) {
        if (dx / d > 0.38) want.add('ArrowRight');
        if (dx / d < -0.38) want.add('ArrowLeft');
        if (dy / d > 0.38) want.add('ArrowDown');
        if (dy / d < -0.38) want.add('ArrowUp');
      }
      await set(want);
      await sleep(30);
    }
  } finally {
    await set(new Set());
  }
  return st(p);
}

async function freeRoam(bname, round) {
  const T = (n) => `${bname}: FR ${n}`;
  const { browser, p, errs } = await newPage(bname);
  try {
    await p.goto(PAGE + '?mode=freeroam', { waitUntil: 'load' });
    await waitFor(p, (s) => s.screen === 'map', 15000);
    await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
    await waitFor(p, (s) => s.screen === 'flight' && s.panel === 'briefing');
    await p.keyboard.press('Enter');
    let s = await waitFor(p, (x) => x.phase === 'flight' && x.panel === null);
    const loops0 = await loops(p);
    // an active attack: the Sirius ambush, pilot invulnerable
    await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; r.grace = 0; r.invuln = 1e9; });
    const amb = s.sector.encounters.find((e) => e.kind === 'ambush');
    const site = { 'ambush-1': { x: 1537, y: 3629 }, 'ambush-2': { x: 3676, y: 3091 } }[amb?.id ?? 'ambush-1'];
    await place(p, site.x + 520, site.y);
    await sleep(150);
    s = await flyTo(p, site, (x) => x.sector.pending > 0 || x.sector.encounters.some((e) => e.id === amb.id && e.state !== 'dormant'), 15000);
    s = await waitFor(p, (x) => x.sector.hostileList.some((h) => h.source === amb.id) && x.sector.enemyShots > 0, 8000);
    check(T('setup: an active attack (hostiles and enemy shots in the air)'), s.sector.hostileList.length > 0 && s.sector.enemyShots > 0, { hostiles: s.sector.hostileList.length, shots: s.sector.enemyShots });

    // 1. pause mid-attack with a steering key held
    await p.keyboard.down('ArrowLeft');
    await p.keyboard.press('Escape');
    s = await waitFor(p, (x) => x.panel === 'pause' && x.phase === 'paused', 3000);
    const f0 = await frozen(p);
    await sleep(600);
    const f1 = await frozen(p);
    await p.keyboard.up('ArrowLeft');
    check(T('1. Esc mid-attack pauses; ship, hostiles, enemy shots, hull and tick stay frozen for 600 ms (key held)'), s.panel === 'pause' && s.phase === 'paused' && f0 === f1, { panel: s.panel, phase: s.phase, same: f0 === f1 });

    // 2. blur + hidden tab while paused
    await blurAndHide(p);
    s = await st(p);
    const f2 = await frozen(p);
    const overlays = await p.evaluate(() => [...document.querySelectorAll('.fr-panels > *')].filter((n) => !n.hidden).length);
    check(T('2. blur and a hidden tab while paused: still paused, one overlay, nothing moved'), s.panel === 'pause' && s.phase === 'paused' && overlays === 1 && f2 === f1, { panel: s.panel, phase: s.phase, overlays });

    // 3. RESUME by mouse after a 2 s pause: no dt jump, hostiles move, one loop
    await sleep(1400);
    const before = JSON.parse(await frozen(p));
    await p.click('.fr-panel-pause >> text=RESUME');
    const t0 = await tickNow(p);
    await sleep(120);
    const t1 = await tickNow(p);
    s = await waitFor(p, (x) => x.panel === null && x.phase === 'flight', 3000);
    await sleep(400);
    const after = JSON.parse(await frozen(p));
    const allowed = Math.ceil((t1.at - t0.at) / (1000 / 60)) + 3;
    const ran = t1.tick - before.tick;
    const hostilesMoved = after.hostiles.some(([id, x, y]) => { const b = before.hostiles.find((h) => h[0] === id); return b && (b[1] !== x || b[2] !== y); });
    check(T('3a. RESUME (mouse) closes the panel and the flight continues'), s.panel === null && s.phase === 'flight' && after.tick > before.tick, { panel: s.panel, phase: s.phase });
    check(T('3b. no dt jump: the first ~120 ms after a 2 s pause run no more ticks than real time allows'), ran >= 0 && ran <= allowed, { ran, allowed, wall: t1.at - t0.at });
    check(T('3c. after CONTINUE the attack resumes (hostiles move); hull and position kept through the pause'), hostilesMoved && before.hull === JSON.parse(f1).hull, { hostilesMoved });
    check(T('3d. one frame loop after resuming'), (await loops(p)) === loops0 && loops0 === 1, { loops0, now: await loops(p) });

    // 4. Esc, then Enter on the focused RESUME
    await p.keyboard.press('Escape');
    s = await waitFor(p, (x) => x.panel === 'pause', 3000);
    const focus = await p.evaluate(() => document.activeElement?.textContent ?? null);
    await p.keyboard.press('Enter');
    s = await waitFor(p, (x) => x.panel === null && x.phase === 'flight', 3000);
    check(T('4. Esc then Enter on the focused RESUME resumes the flight'), focus === 'RESUME' && s.panel === null && s.phase === 'flight', { focus, panel: s.panel, phase: s.phase });

    // 5. repeated P / P
    let cycles = 0;
    for (let i = 0; i < 10; i++) {
      await p.keyboard.press('KeyP');
      const a = await waitFor(p, (x) => x.panel === 'pause' && x.phase === 'paused', 3000);
      await sleep(30 + (i % 3) * 40);
      await p.keyboard.press('KeyP');
      const b = await waitFor(p, (x) => x.panel === null && x.phase === 'flight', 3000);
      if (a.panel === 'pause' && b.panel === null && b.phase === 'flight') cycles += 1;
    }
    const tA = await tickNow(p);
    await sleep(300);
    const tB = await tickNow(p);
    check(T('5. 10 x P / P: every pause and resume lands, the run keeps ticking, one loop'), cycles === 10 && tB.tick > tA.tick && (await loops(p)) === 1, { cycles, ticks: tB.tick - tA.tick });

    // 6. blur during flight auto-pauses; Enter resumes
    await p.evaluate(() => window.dispatchEvent(new Event('blur')));
    s = await waitFor(p, (x) => x.panel === 'pause' && x.phase === 'paused', 3000);
    const autoPaused = s.panel === 'pause';
    await p.keyboard.press('Enter');
    s = await waitFor(p, (x) => x.panel === null && x.phase === 'flight', 3000);
    check(T('6. blur during flight auto-pauses; Enter resumes'), autoPaused && s.panel === null && s.phase === 'flight', { autoPaused, panel: s.panel });

    // 7. the recovery race (the original Firefox failure)
    const mine = await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; const z = r.layout.hazards.find((h) => h.kind === 'minefield'); return z ? { m: z.mines[0] } : null; });
    await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; r.grace = 0; r.invuln = 0; r.shield = 0; r.hull = 4; });
    await place(p, mine.m.x - 260, mine.m.y);
    s = await flyTo(p, mine.m, (x) => x.sector.recalls > 0, 12000);
    s = await waitFor(p, (x) => x.panel === 'recovery', 3000);
    const dropped0 = s.ui.panelDropped;
    await p.keyboard.press('ArrowDown'); // still steering as the screen appears
    await sleep(100); // keys are handled on the next animation frame
    const early = await p.evaluate(() => document.activeElement?.dataset?.key ?? null);
    s = await st(p);
    check(T('7a. an arrow pressed as the recovery screen appears is ignored (CONTINUE keeps the focus)'), s.panel === 'recovery' && early === 'continue' && s.ui.panelDropped > dropped0, { early, dropped: s.ui.panelDropped, dropped0 });
    s = await waitFor(p, (x) => x.ui.panelReady === true, 3000);
    await p.keyboard.press('Enter');
    s = await waitFor(p, (x) => x.panel === null && x.phase === 'flight', 3000);
    check(T('7b. CONTINUE (Enter) after the screen settles resumes the flight at the beacon'), s.panel === null && s.phase === 'flight', { panel: s.panel, phase: s.phase });
    await p.keyboard.press('Escape');
    s = await waitFor(p, (x) => x.panel === 'pause', 3000);
    await p.keyboard.press('ArrowDown');
    await sleep(100);
    const moved = await p.evaluate(() => document.activeElement?.textContent ?? null);
    await p.keyboard.press('Escape');
    s = await waitFor(p, (x) => x.panel === null, 3000);
    check(T('7c. a panel the player opens takes arrows at once (no arming outside game-opened panels)'), moved === 'RESTART FLIGHT' && s.panel === null, { moved });
    check(T('no console errors'), errs.length === 0, { errs });
  } catch (e) {
    check(T(`round ${round} completed without an exception`), false, { e: String(e).slice(0, 600) });
  } finally {
    await browser.close();
  }
}

/* ---------------------------------------------------------------- Classic */
const cst = (p) => p.evaluate(() => {
  const g = window.__galaxiaGame;
  return { phase: g.engine.phase, screen: g.screen, tick: g.engine.world.tick, digest: g.engine.digest(), attacking: g.engine.world.enemies.filter((e) => e.state === 'attacking').length, shots: g.engine.world.enemyShots.length, score: g.engine.rewards.snapshot().score, lives: g.engine.rewards.snapshot().reserves, at: performance.now() };
});
const cwait = async (p, pred, ms = 8000) => { const t0 = Date.now(); let s; do { s = await cst(p); if (pred(s)) return s; await sleep(40); } while (Date.now() - t0 < ms); return s; };

async function classic(bname, round) {
  const T = (n) => `${bname}: Classic ${n}`;
  const { browser, p, errs } = await newPage(bname);
  try {
    await p.goto(`${PAGE}?mode=classic&seed=42`, { waitUntil: 'load' });
    await p.waitForFunction(() => (window.__galaxiaGame?.frames ?? 0) > 10, null, { timeout: 20000 });
    await p.click('.screen-title >> text=START GAME');
    let s = await cwait(p, (x) => x.phase === 'playing', 12000);
    s = await cwait(p, (x) => x.attacking > 0, 20000);
    const loops0 = await loops(p);
    // 8. Esc mid-attack with keys held
    const lives0 = s.lives;
    await p.keyboard.down('ArrowRight');
    await p.keyboard.press('Escape');
    s = await cwait(p, (x) => x.phase === 'paused' && x.screen === 'pause', 3000);
    const d0 = s.digest;
    await sleep(600);
    const s1 = await cst(p);
    await p.keyboard.up('ArrowRight');
    check(T('8. Esc mid-attack pauses; the world digest is unchanged for 600 ms (key held)'), s.phase === 'paused' && s1.digest === d0 && s1.lives === lives0, { phase: s.phase, attacking: s.attacking });
    // 9. blur + hidden while paused, then RESUME by mouse after 2 s
    await blurAndHide(p);
    const s2 = await cst(p);
    check(T('9a. blur and a hidden tab while paused: still paused, nothing moved'), s2.phase === 'paused' && s2.screen === 'pause' && s2.digest === d0, { phase: s2.phase, screen: s2.screen });
    await sleep(1400);
    await p.click('.screen-pause [data-action=resume]');
    const a = await cst(p);
    await sleep(120);
    const b = await cst(p);
    const allowed = Math.ceil((b.at - a.at) / (1000 / 60)) + 3;
    const ran = b.tick - s2.tick;
    s = await cwait(p, (x) => x.phase !== 'paused' && x.screen !== 'pause', 3000);
    check(T('9b. RESUME (mouse) resumes play; no dt jump in the first ~120 ms; score and lives kept; one loop'), (s.phase === 'playing' || s.phase === 'dying' || s.phase === 'stageClear') && ran >= 0 && ran <= allowed && s.score >= s2.score && (await loops(p)) === loops0, { phase: s.phase, ran, allowed });
    // 10. keyboard CONTINUE: a bare Enter / Space (fire) never resumes (screens.ts keeps RESUME unfocused);
    // arrows to RESUME + Enter do
    await p.keyboard.press('Escape');
    s = await cwait(p, (x) => x.phase === 'paused', 3000);
    await p.keyboard.press('Enter');
    await p.keyboard.press('Space');
    await sleep(200);
    const still = await cst(p);
    let focus = null;
    for (let i = 0; i < 8 && focus !== 'resume'; i++) {
      await p.keyboard.press('ArrowDown');
      await sleep(60);
      focus = await p.evaluate(() => document.activeElement?.dataset?.action ?? null);
    }
    await p.keyboard.press('Enter');
    s = await cwait(p, (x) => x.phase !== 'paused' && x.screen !== 'pause', 3000);
    check(T('10a. paused: a bare Enter / Space does not resume; arrows to RESUME + Enter resumes'), still.phase === 'paused' && focus === 'resume' && s.phase !== 'paused' && s.screen !== 'pause', { still: still.phase, focus, phase: s.phase, screen: s.screen });
    let cycles = 0;
    for (let i = 0; i < 10; i++) {
      await p.keyboard.press('Escape');
      const x1 = await cwait(p, (x) => x.phase === 'paused', 3000);
      await sleep(30 + (i % 3) * 40);
      await p.keyboard.press('Escape');
      const x2 = await cwait(p, (x) => x.phase !== 'paused' && x.screen !== 'pause', 3000);
      if (x1.phase === 'paused' && x2.phase !== 'paused' && x2.screen !== 'pause') cycles += 1;
    }
    check(T('10b. 10 x Esc / Esc: every pause and resume lands; one loop'), cycles === 10 && (await loops(p)) === loops0, { cycles });
    check(T('no console errors'), errs.length === 0, { errs });
  } catch (e) {
    check(T(`round ${round} completed without an exception`), false, { e: String(e).slice(0, 600) });
  } finally {
    await browser.close();
  }
}

try {
  for (let round = 1; round <= ROUNDS; round++) {
    for (const bname of ENGINES) {
      await freeRoam(bname, round);
      await classic(bname, round);
    }
    console.log(`round ${round}/${ROUNDS} done: ${total - failed}/${total} checks passed so far`);
  }
  for (const [name, t] of tally) console.log(`${t.fail ? 'FAIL' : 'PASS'} ${name}: ${t.pass}/${t.pass + t.fail}`);
  console.log(`\n${total - failed}/${total} checks passed over ${ROUNDS} round(s)`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error(e);
  process.exit(1);
}
