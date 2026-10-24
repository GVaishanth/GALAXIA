// Arcade Display Mode (TD-73): Classic's Responsive / Arcade presentation
// toggle. Release build on the GitHub Pages sub-path.
// Usage: node arcade-display.mjs <url> [chromium,webkit,firefox] [shotDir]
// Browser EMULATION only (Playwright device metrics + touch); not physical
// devices.
//
//  A. matrix (12 viewports): default Responsive (no bezel, arena = shared
//     sizing); SETTINGS switch -> Arcade: the arena really moves / shrinks
//     (>= 90 % of Responsive), centred, aspect kept, bezel visible and inside
//     the play area, HUD follows the arena; settings panel fits; reload keeps
//     the choice; no scroll; switch >= 44 px; Pages asset paths.
//  B. keyboard, mid-game (1366x768): pause -> SETTINGS -> switch with the
//     menu keys + Enter -> the simulation digest (tick, player, score,
//     every enemy and shot) is byte-identical; resume: same loop, same
//     backing store, movement + fire + score keep working; switch back.
//  C. touch, mid-game (390x844): the same with taps; touch fire / move work.
//  D. switch glide (intermediate frames) and reduced motion (instant).
//  E. window resize in Arcade: re-fitted, state kept, one loop.
//  F. storage: legacy Classic record (no setting) -> Responsive and the
//     Classic record stays byte-identical; corrupt prefs; storage blocked.
//  G. Free Roam ignores the setting (no bezel, its own sizing).
//  H. both ◀ MENU buttons: red gradient, white text, 44 px target (TD-75; was yellow in TD-73).
import { chromium, firefox, webkit } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4180/galaxia/';
const ENGINES = (process.argv[3] ?? 'chromium').split(',');
const SHOTS = process.argv[4] ?? null;
const BASE_PATH = new URL(PAGE).pathname;
const ASPECT = 448 / 576;
const VIEWPORTS = [
  // [name, w, h, dpr, touch]
  ['320x568', 320, 568, 2, true], ['360x800', 360, 800, 3, true], ['390x844', 390, 844, 3, true], ['430x932', 430, 932, 3, true],
  ['568x320', 568, 320, 2, true], ['667x375', 667, 375, 2, true], ['768x1024', 768, 1024, 2, true], ['1024x768', 1024, 768, 2, true],
  ['1280x720', 1280, 720, 1, false], ['1366x768', 1366, 768, 1, false], ['1440x900', 1440, 900, 2, false], ['1920x1080', 1920, 1080, 1, false],
];

const checks = [];
const check = (name, ok, info = {}) => { checks.push({ name, ok: !!ok }); if (!ok) console.error('FAIL', name, JSON.stringify(info).slice(0, 900)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engines = { chromium, firefox, webkit };
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// P04.2 guide: start as a returning player (only the first-run guide record is seeded, and only when absent)
const SEED_GUIDE = () => {
  try {
    if (!localStorage.getItem('galaxia:guide')) localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
  } catch {}
};
async function context(bt, w, h, dpr, touch, extra = {}) {
  const ctx = await bt.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, ...(touch ? { hasTouch: true, isMobile: true } : {}), ...extra });
  await ctx.addInitScript(SEED_GUIDE);
  return ctx;
}

function watch(p) {
  const errs = [];
  const bad = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  p.on('response', (r) => { const u = new URL(r.url()); if (u.origin === new URL(PAGE).origin && !u.pathname.startsWith(BASE_PATH)) bad.push(u.pathname); if (r.status() >= 400) bad.push(`${r.status()} ${u.pathname}`); });
  p.on('requestfailed', (r) => bad.push(`failed ${r.url()}`));
  return { errs, bad };
}

async function gotoClassic(p) {
  await p.goto(`${PAGE}?mode=classic&seed=42`, { waitUntil: 'load' });
  await p.waitForFunction(() => (window.__galaxiaGame?.frames ?? 0) > 10, null, { timeout: 20000 });
  await sleep(150);
}

async function open(bt, w, h, dpr, touch, extra) {
  const ctx = await context(bt, w, h, dpr, touch, extra);
  const p = await ctx.newPage();
  const w8 = watch(p);
  await gotoClassic(p);
  return { ctx, p, ...w8 };
}

/** Presentation snapshot: status + DOM (bezel, HUD, switch, scroll). */
const snap = (p) => p.evaluate(() => {
  const g = window.__galaxiaGame;
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
  const bz = document.querySelector('.arcade-bezel');
  const hud = document.querySelector('.hud');
  const sw = document.querySelector('.screen-switch');
  const se = document.scrollingElement;
  return {
    display: g.display, area: g.playArea, layout: g.layout.mode, backing: g.backing, resizes: g.canvasResizes,
    dataDisplay: document.querySelector('.game-app').dataset.display,
    bezel: bz ? { hidden: bz.hidden, box: box(bz), border: parseFloat(getComputedStyle(bz).borderTopWidth), pe: getComputedStyle(bz).pointerEvents, mark: bz.classList.contains('arcade-bezel-mark') } : null,
    hud: box(hud),
    sw: sw ? { checked: sw.getAttribute('aria-checked'), role: sw.getAttribute('role'), state: sw.textContent.trim(), desc: document.getElementById(sw.getAttribute('aria-describedby'))?.textContent ?? null, label: document.getElementById(sw.getAttribute('aria-labelledby'))?.textContent ?? null } : null,
    scroll: { x: scrollX, y: scrollY, over: se.scrollHeight - innerHeight, overX: se.scrollWidth - innerWidth },
    vw: innerWidth, vh: innerHeight,
    loops: window.__galaxia?.debug().active?.loops ?? null,
    prefs: localStorage.getItem('galaxia:prefs'),
  };
});

/** Open Classic SETTINGS from the title (click / tap). */
async function openSettings(p, touch) {
  if (touch) await p.tap('[data-action=settings]'); else await p.click('[data-action=settings]');
  await p.waitForFunction(() => window.__galaxiaGame.screen === 'settings', null, { timeout: 5000 });
  await sleep(120);
}

async function backToTitle(p, touch) {
  const sel = '.screen-settings [data-action=back]';
  if (touch) await p.tap(sel); else await p.click(sel);
  await p.waitForFunction(() => window.__galaxiaGame.screen !== 'settings', null, { timeout: 5000 });
  await sleep(350); // past the switch glide
}

async function flipSwitch(p, touch) {
  if (touch) await p.tap('.screen-switch'); else await p.click('.screen-switch');
  await sleep(350);
}

/** Settings panel fits (no inner scroll) and the switch row is on screen. */
const settingsFit = (p) => p.evaluate(() => {
  const panel = document.querySelector('.screen-settings');
  const sw = document.querySelector('.screen-switch').getBoundingClientRect();
  const row = document.querySelector('.screen-row-switch').getBoundingClientRect();
  const desc = document.querySelector('.screen-row-desc');
  const ds = parseFloat(getComputedStyle(desc).fontSize);
  const back = panel.querySelector('[data-action=back]');
  const pr = panel.getBoundingClientRect();
  return { pr: { t: pr.top, b: Math.min(pr.bottom, innerHeight) }, back: !!back, scrolls: panel.scrollHeight - panel.clientHeight, scrollable: getComputedStyle(panel).overflowY === 'auto', swH: sw.height, swW: sw.width, rowIn: row.top >= 0 && row.bottom <= innerHeight && row.left >= 0 && row.right <= innerWidth, swIn: sw.top >= 0 && sw.bottom <= innerHeight && sw.right <= innerWidth, descFont: ds };
});

/** Settings fit + BACK reachable with the menu keys (wraps from the first item to BACK; the panel scrolls to it). */
async function settingsUsable(p) {
  const f = await settingsFit(p);
  await p.evaluate(() => document.querySelector('.screen-settings button, .screen-settings input').focus({ preventScroll: true }));
  await p.keyboard.press('ArrowUp'); // wrap to the last item (BACK)
  // TD-77: measure what is painted. The key also switches a touch device to the keyboard layout; between
  // the keydown and the next rendered frame the layout CSS has changed but the menu box has not (never
  // painted). A fixed 80 ms sleep read that transient state when WebKit delayed its next frame.
  await sleep(80);
  await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => done(); ch.port2.postMessage(0); }))));
  const r = await p.evaluate(() => { const a = document.activeElement; const panel = document.querySelector('.screen-settings').getBoundingClientRect(); const b = a.getBoundingClientRect(); return { isBack: a.dataset.action === 'back', visible: b.top >= panel.top - 0.5 && b.bottom <= Math.min(panel.bottom, innerHeight) + 0.5 }; });
  // a key press on a touch device switches Classic to the keyboard layout (Stage 8, input-device driven):
  // tap the heading to return to touch input before the next taps
  if (await p.evaluate(() => document.querySelector('.game-app').dataset.input === 'keyboard' && matchMedia('(pointer: coarse)').matches)) {
    await p.tap('.screen-settings .screen-heading'); await sleep(250);
  }
  await p.evaluate(() => { document.querySelector('.screen-settings').scrollTop = 0; document.querySelector('.screen-switch').focus({ preventScroll: true }); });
  return { ...f, backReachable: r.isBack && r.visible, backFocus: r };
}

/** The arena geometry contract for one snapshot. */
function arenaChecks(name, s) {
  const f = s.display.field;
  const a = s.area;
  check(`${name}: arena keeps the 448:576 aspect`, near(f.width / f.height, ASPECT, 0.01), { f });
  check(`${name}: arena inside the play area`, f.left >= a.left - 1 && f.top >= a.top - 1 && f.left + f.width <= a.left + a.width + 1 && f.top + f.height <= a.top + a.height + 1, { f, a });
  check(`${name}: HUD follows the arena`, near(s.hud.l, f.left, 2) && near(s.hud.t, f.top, 2) && near(s.hud.w, f.width, 2) && near(s.hud.h, f.height, 2), { hud: s.hud, f });
  check(`${name}: no page scroll`, s.scroll.x === 0 && s.scroll.y === 0 && s.scroll.over <= 0 && s.scroll.overX <= 0, s.scroll);
}

const shot = async (p, file) => { if (SHOTS) { await sleep(file.includes('webkit') ? 800 : 250); await p.screenshot({ path: `${SHOTS}/${file}` }); } };

const gameState = (p) => p.evaluate(() => {
  const g = window.__galaxiaGame; const e = g.engine; const w = e.world; const r = e.rewards.snapshot();
  return { digest: e.digest(), phase: e.phase, tick: w.tick, x: w.player.x, enemies: w.enemies.length, shots: w.playerShots.length, eshots: w.enemyShots.length, score: r.score, stage: r.stage, reserves: r.reserves, frames: g.frames, resizes: g.canvasResizes, backing: g.backing, loops: window.__galaxia?.debug().active?.loops ?? null, mode: g.display.mode, switches: g.display.switches };
});

/** Play until there are enemies on screen and some score, firing as we go. */
async function playABit(p, touch, ms = 4500) {
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) {
    if (touch) await p.tap('.touch-fire'); else await p.keyboard.press('Space');
    if (!touch && i % 6 === 0) { await p.keyboard.down(i % 12 === 0 ? 'ArrowLeft' : 'ArrowRight'); await sleep(120); await p.keyboard.up(i % 12 === 0 ? 'ArrowLeft' : 'ArrowRight'); }
    await sleep(110);
    i++;
  }
}

for (const bname of ENGINES) {
  const bt = await engines[bname].launch();

  /* ---------------- A. matrix ---------------- */
  for (const [vname, w, h, dpr, touch] of VIEWPORTS) {
    const name = `${bname} ${vname}${touch ? ' touch' : ''}`;
    const { ctx, p, errs, bad } = await open(bt, w, h, dpr, touch);
    const off = await snap(p);
    check(`${name}: new player starts in Responsive Display (no bezel)`, off.display.mode === 'responsive' && off.dataDisplay === 'responsive' && off.bezel.hidden && off.display.bezelBox === null && off.display.bezel === 0, { d: off.display, bz: off.bezel });
    arenaChecks(`${name} responsive`, off);
    // the shared sizing: the arena fills the play area on its binding axis
    const fillW = off.display.field.width / off.area.width;
    const fillH = off.display.field.height / off.area.height;
    check(`${name} responsive: arena as large as fits (binding axis filled)`, Math.max(fillW, fillH) > 0.985, { fillW, fillH });
    await shot(p, `arcade-${bname}-${vname}-off.png`);

    await openSettings(p, touch);
    const sOff = await snap(p);
    check(`${name}: SETTINGS shows ARCADE DISPLAY MODE as an OFF switch with its description`, sOff.sw.role === 'switch' && sOff.sw.checked === 'false' && sOff.sw.label === 'ARCADE DISPLAY MODE' && sOff.sw.state === 'OFF' && /RESPONSIVE DISPLAY/.test(sOff.sw.desc), sOff.sw);
    const fit0 = await settingsUsable(p);
    // the whole panel fits (no inner scroll) at every size, BACK included, and BACK is reachable with the menu keys
    const fits = (f) => f.scrolls <= 1 && f.backReachable && f.rowIn && f.swIn;
    check(`${name}: settings panel fits without scrolling, BACK reachable by keys; switch touch-sized (>= 44 px), description >= 10 px`, fits(fit0) && fit0.swH >= 43.5 && fit0.descFont >= 10, fit0);
    if (['320x568', '390x844', '568x320', '1366x768'].includes(vname)) await shot(p, `arcade-${bname}-${vname}-settings-off.png`);
    await flipSwitch(p, touch);
    const sOn = await snap(p);
    check(`${name}: switch turns ON, description follows`, sOn.sw.checked === 'true' && sOn.sw.state === 'ON' && /ARCADE DISPLAY/.test(sOn.sw.desc), sOn.sw);
    check(`${name}: saved to galaxia:prefs (display.arcadeDisplay = true)`, sOn.prefs && JSON.parse(sOn.prefs).display?.arcadeDisplay === true, { prefs: sOn.prefs });
    const fit1 = await settingsUsable(p);
    check(`${name}: settings panel equally usable in Arcade Display`, fits(fit1), fit1);
    if (['320x568', '390x844', '568x320', '1366x768'].includes(vname)) await shot(p, `arcade-${bname}-${vname}-settings-on.png`);
    await backToTitle(p, touch);
    // TD-77: closing the panel returns focus to the control that opened it
    const ret = await p.evaluate(() => document.activeElement?.dataset?.action ?? null);
    check(`${name}: closing SETTINGS returns focus to the SETTINGS button`, ret === 'settings', { ret });
    if (!touch) {
      // keyboard round trip: Enter opens (focus on the first control), ArrowUp wraps to BACK with a visible
      // focus ring, Space activates BACK, focus is back on SETTINGS
      await p.keyboard.press('Enter');
      await p.waitForFunction(() => window.__galaxiaGame.screen === 'settings', null, { timeout: 5000 });
      await sleep(120);
      const first = await p.evaluate(() => { const a = document.activeElement; return a?.closest('.screen-settings') ? (a.dataset.setting ?? a.getAttribute('aria-label') ?? a.textContent) : null; });
      await p.keyboard.press('ArrowUp');
      await sleep(80);
      await p.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const ring = await p.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); const pr = document.querySelector('.screen-settings').getBoundingClientRect(); const b = a.getBoundingClientRect();
        const idle = getComputedStyle(document.querySelector('.screen-title [data-action=start]'));
        // the menu focus style: the accent arrow marker (::before) plus the highlight colour (not colour alone)
        return { back: a.dataset.action === 'back', marker: getComputedStyle(a, '::before').opacity === '1', colour: cs.color !== idle.color || cs.borderColor !== idle.borderColor, visible: b.top >= pr.top - 0.5 && b.bottom <= Math.min(pr.bottom, innerHeight) + 0.5 && b.left >= 0 && b.right <= innerWidth }; });
      await p.keyboard.press('Space');
      await p.waitForFunction(() => window.__galaxiaGame.screen === 'title', null, { timeout: 5000 }).catch(() => undefined);
      await sleep(120);
      const after = await p.evaluate(() => ({ screen: window.__galaxiaGame.screen, focus: document.activeElement?.dataset?.action ?? null }));
      check(`${name}: keyboard: Enter opens SETTINGS on its first control, ArrowUp reaches BACK (visible focus marker, unclipped), Space activates it, focus returns to SETTINGS`,
        first !== null && ring.back && ring.marker && ring.colour && ring.visible && after.screen === 'title' && after.focus === 'settings', { first, ring, after });
    }

    const on = await snap(p);
    const fo = off.display.field;
    const fn = on.display.field;
    check(`${name}: Arcade Display is in effect (status + data-display)`, on.display.mode === 'arcade' && on.dataDisplay === 'arcade' && on.display.switches === 1, { d: on.display });
    arenaChecks(`${name} arcade`, on);
    check(`${name} arcade: the layout really changes (arena smaller and moved)`, fn.width < fo.width - 1 && (fn.left !== fo.left || fn.top !== fo.top), { fo, fn });
    check(`${name} arcade: still large (>= 90 % of the Responsive arena)`, fn.width / fo.width >= 0.9 - 0.005, { ratio: fn.width / fo.width });
    const a = on.area;
    const cx = fn.left + fn.width / 2 - (a.left + a.width / 2);
    const cy = fn.top + fn.height / 2 - (a.top + a.height / 2);
    check(`${name} arcade: centred in the play area${on.layout === 'desktop' && on.display.field.top <= a.top + 40 && Math.abs(cy) > 2 ? ' (horizontally; panels below)' : ''}`, Math.abs(cx) <= 1.5 && (Math.abs(cy) <= 1.5 || (on.layout === 'desktop' && fn.top < a.top + 40)), { cx, cy });
    const bb = on.bezel.box;
    check(`${name} arcade: bezel visible around the arena, click-through, inside the play area and the viewport`, !on.bezel.hidden && on.bezel.pe === 'none' && on.display.bezel >= 1 && near(on.bezel.border, on.display.bezel, 0.6)
      && near(bb.l, fn.left - on.display.bezel, 1.5) && near(bb.t, fn.top - on.display.bezel, 1.5) && near(bb.w, fn.width + 2 * on.display.bezel, 1.5)
      && bb.l >= a.left - 1 && bb.t >= a.top - 1 && bb.r <= a.left + a.width + 1 && bb.b <= a.top + a.height + 1 && bb.l >= 0 && bb.r <= on.vw && bb.b <= on.vh, { bz: on.bezel, d: on.display, a });
    check(`${name} arcade: restrained frame (bezel <= 14 px; mark only when >= 11 px)`, on.display.bezel <= 14 && on.bezel.mark === (on.display.bezel >= 11), { bezel: on.display.bezel, mark: on.bezel.mark });
    check(`${name}: switching did not reallocate the canvas (same backing store)`, on.resizes === off.resizes && on.backing.width === off.backing.width && on.backing.height === off.backing.height, { a: off.resizes, b: on.resizes });
    await shot(p, `arcade-${bname}-${vname}-on.png`);

    // reload: the choice is restored before the first frame
    await gotoClassic(p);
    const re = await snap(p);
    check(`${name}: Arcade Display restored after a reload`, re.display.mode === 'arcade' && !re.bezel.hidden && near(re.display.field.width, fn.width, 0.5) && near(re.display.field.left, fn.left, 0.5) && re.display.switches === 0, { d: re.display });
    // and back to Responsive (persisted too)
    await openSettings(p, touch);
    await flipSwitch(p, touch);
    await backToTitle(p, touch);
    const back = await snap(p);
    check(`${name}: back to Responsive: the original arena, no bezel`, back.display.mode === 'responsive' && back.bezel.hidden && near(back.display.field.width, fo.width, 0.5) && near(back.display.field.left, fo.left, 0.5) && near(back.display.field.top, fo.top, 0.5), { fo, now: back.display.field });
    await gotoClassic(p);
    const re2 = await snap(p);
    check(`${name}: Responsive restored after a reload`, re2.display.mode === 'responsive' && re2.bezel.hidden, { d: re2.display });
    check(`${name}: no errors, every asset under ${BASE_PATH}`, errs.length === 0 && bad.length === 0, { errs, bad });
    await ctx.close();
  }

  /* ---------------- B. keyboard, mid-game ---------------- */
  {
    const name = `${bname} keyboard mid-game 1366x768`;
    const { ctx, p, errs, bad } = await open(bt, 1366, 768, 1, false);
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__galaxiaGame.engine.phase !== 'title', null, { timeout: 8000 });
    await playABit(p, false, 5000);
    await p.keyboard.down('Space'); await sleep(40); await p.keyboard.up('Space');
    await p.keyboard.press('p');
    await p.waitForFunction(() => window.__galaxiaGame.engine.phase === 'paused', null, { timeout: 5000 });
    await sleep(200);
    const before = await gameState(p);
    const fOff = (await snap(p)).display.field;
    // pause menu -> SETTINGS with the keys: ArrowDown to RESUME, ArrowDown to SETTINGS, Enter
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__galaxiaGame.screen === 'settings', null, { timeout: 5000 });
    // keyboard to the switch: the menu keys walk the settings items
    let focused = '';
    for (let i = 0; i < 14 && focused !== 'arcadeDisplay'; i++) {
      await p.keyboard.press('ArrowDown');
      focused = await p.evaluate(() => document.activeElement?.dataset?.setting ?? '');
    }
    check(`${name}: the switch is reachable with the menu keys`, focused === 'arcadeDisplay', { focused });
    await p.keyboard.press('Enter');
    await sleep(350);
    const sw = await snap(p);
    check(`${name}: Enter toggles the switch ON`, sw.sw.checked === 'true' && sw.display.mode === 'arcade', sw.sw);
    await p.keyboard.press('Space'); // Space toggles too (native button)
    await sleep(350);
    const sw2 = await snap(p);
    check(`${name}: Space toggles it back OFF`, sw2.sw.checked === 'false' && sw2.display.mode === 'responsive', sw2.sw);
    await p.keyboard.press('Space');
    await sleep(350);
    const mid = await gameState(p);
    check(`${name}: switching while paused changes nothing in the simulation (digest: tick, player, score, every enemy and shot)`, mid.digest === before.digest && mid.tick === before.tick && mid.phase === 'paused', { before, mid });
    check(`${name}: same frame loop, same backing store (no restart, no reallocation)`, mid.loops === 1 && mid.resizes === before.resizes && mid.backing.width === before.backing.width && mid.switches === before.switches + 3, { before, mid });
    await p.keyboard.press('Escape'); // SETTINGS -> pause menu
    await p.waitForFunction(() => window.__galaxiaGame.screen === 'pause', null, { timeout: 5000 });
    await shot(p, `arcade-${bname}-midgame-paused-on.png`);
    await p.keyboard.press('p');
    await p.waitForFunction(() => window.__galaxiaGame.engine.phase !== 'paused', null, { timeout: 5000 });
    const fOn = (await snap(p)).display.field;
    check(`${name}: the arena moved into the arcade frame`, fOn.width < fOff.width - 1, { fOff, fOn });
    const x0 = (await gameState(p)).x;
    await p.keyboard.down('ArrowLeft'); await sleep(400); await p.keyboard.up('ArrowLeft');
    const x1 = (await gameState(p)).x;
    let maxShots = 0;
    for (let i = 0; i < 8; i++) { await p.keyboard.press('Space'); await sleep(60); maxShots = Math.max(maxShots, (await gameState(p)).shots); }
    await playABit(p, false, 2500);
    const after = await gameState(p);
    check(`${name}: after resuming: the game runs on, score / stage / lives kept, keyboard move + fire work`, after.tick > before.tick && after.score >= before.score && after.stage >= before.stage && (after.reserves === before.reserves || after.phase !== 'playing' || after.reserves >= before.reserves - 1) && x1 !== x0 && maxShots >= 1, { before, after, x0, x1, maxShots });
    const fr0 = await gameState(p); await sleep(1000); const fr1 = await gameState(p);
    check(`${name}: one frame loop (frame rate not doubled)`, fr1.loops === 1 && fr1.frames - fr0.frames < 80, { perSecond: fr1.frames - fr0.frames });
    await shot(p, `arcade-${bname}-midgame-on.png`);
    // and back to Responsive mid-game
    await p.keyboard.press('p'); await p.waitForFunction(() => window.__galaxiaGame.engine.phase === 'paused', null, { timeout: 5000 });
    const b2 = await gameState(p);
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__galaxiaGame.screen === 'settings', null, { timeout: 5000 });
    await p.click('.screen-switch'); await sleep(350);
    const m2 = await gameState(p);
    check(`${name}: switching back to Responsive mid-game: digest unchanged, Responsive in effect`, m2.digest === b2.digest && m2.mode === 'responsive', { b2, m2 });
    check(`${name}: no errors, assets under ${BASE_PATH}`, errs.length === 0 && bad.length === 0, { errs, bad });
    await ctx.close();
  }

  /* ---------------- C. touch, mid-game ---------------- */
  {
    const name = `${bname} touch mid-game 390x844`;
    const { ctx, p, errs, bad } = await open(bt, 390, 844, 3, true);
    await p.tap('[data-action=start]');
    await p.waitForFunction(() => window.__galaxiaGame.engine.phase !== 'title', null, { timeout: 8000 });
    await playABit(p, true, 5000);
    await p.tap('.touch-pause');
    await p.waitForFunction(() => window.__galaxiaGame.engine.phase === 'paused', null, { timeout: 5000 });
    await sleep(200);
    const before = await gameState(p);
    const fOff = (await snap(p)).display.field;
    await p.tap('.screen-pause [data-action=settings]');
    await p.waitForFunction(() => window.__galaxiaGame.screen === 'settings', null, { timeout: 5000 });
    await p.tap('.screen-switch'); await sleep(350);
    const mid = await gameState(p);
    check(`${name}: tap toggles Arcade Display; simulation digest unchanged`, mid.mode === 'arcade' && mid.digest === before.digest && mid.loops === 1 && mid.resizes === before.resizes, { before, mid });
    await p.tap('.screen-settings [data-action=back]');
    await p.waitForFunction(() => window.__galaxiaGame.screen === 'pause', null, { timeout: 5000 });
    await p.tap('.screen-pause [data-action=resume]');
    await p.waitForFunction(() => window.__galaxiaGame.engine.phase !== 'paused', null, { timeout: 5000 });
    const s = await snap(p);
    const fOn = s.display.field;
    check(`${name}: arena centred in the frame above the touch controls`, fOn.width < fOff.width && fOn.top > fOff.top - 400 && !s.bezel.hidden, { fOff, fOn });
    const pad = await p.evaluate(() => { const r = document.querySelector('.touch-pad').getBoundingClientRect(); return { t: r.top }; });
    check(`${name}: bezel clear of the touch pad`, s.bezel.box.b <= pad.t + 0.5, { bz: s.bezel.box, pad });
    // touch move: hold the right half of the move zone
    const x0 = (await gameState(p)).x;
    await p.evaluate(async () => {
      const z = document.querySelector('.touch-move'); const r = z.getBoundingClientRect();
      const opt = (x) => ({ pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: r.top + r.height / 2, bubbles: true, cancelable: true });
      z.dispatchEvent(new PointerEvent('pointerdown', opt(r.left + r.width * 0.92)));
      await new Promise((res) => setTimeout(res, 450));
      z.dispatchEvent(new PointerEvent('pointerup', opt(r.left + r.width * 0.92)));
    });
    const x1 = (await gameState(p)).x;
    let maxShots = 0;
    for (let i = 0; i < 6; i++) { await p.tap('.touch-fire'); await sleep(60); maxShots = Math.max(maxShots, (await gameState(p)).shots); }
    await playABit(p, true, 2000);
    const after = await gameState(p);
    check(`${name}: touch move + fire work after the switch; score / stage kept; one loop`, x1 !== x0 && maxShots >= 1 && after.tick > before.tick && after.score >= before.score && after.stage >= before.stage && after.loops === 1, { x0, x1, maxShots, before, after });
    await shot(p, `arcade-${bname}-touch-midgame-on.png`);
    check(`${name}: no errors, assets under ${BASE_PATH}`, errs.length === 0 && bad.length === 0, { errs, bad });
    await ctx.close();
  }

  /* ---------------- D. glide + reduced motion ---------------- */
  for (const reduced of [false, true]) {
    const name = `${bname} switch ${reduced ? 'with reduced motion (instant)' : 'glide'}`;
    const { ctx, p, errs } = await open(bt, 1280, 720, 1, false, reduced ? { reducedMotion: 'reduce' } : {});
    await openSettings(p, false);
    const widths = await p.evaluate(async () => {
      const g = window.__galaxiaGame;
      const out = [g.display.field.width];
      document.querySelector('.screen-switch').click();
      const seen = { gliding: false };
      await new Promise((res) => {
        const t0 = performance.now();
        const step = () => { out.push(g.display.field.width); if (g.display.gliding) seen.gliding = true; if (performance.now() - t0 < 500) requestAnimationFrame(step); else res(); };
        requestAnimationFrame(step);
      });
      return { out, gliding: seen.gliding, end: g.display };
    });
    const first = widths.out[0];
    const last = widths.out[widths.out.length - 1];
    const between = widths.out.filter((v) => v < first - 0.5 && v > last + 0.5).length;
    if (reduced) check(`${name}: no intermediate frames, no glide`, between === 0 && !widths.gliding && widths.end.mode === 'arcade', { between, gliding: widths.gliding });
    else check(`${name}: intermediate frames, then settles (glide finished)`, between >= 2 && widths.end.gliding === false && widths.end.mode === 'arcade', { between, n: widths.out.length, first, last });
    check(`${name}: no errors`, errs.length === 0, { errs });
    await ctx.close();
  }

  /* ---------------- E. resize in Arcade ---------------- */
  {
    const name = `${bname} resize in Arcade`;
    const { ctx, p, errs } = await open(bt, 1366, 768, 1, false);
    await openSettings(p, false); await flipSwitch(p, false); await backToTitle(p, false);
    await p.keyboard.press('ArrowDown'); // focus came back to SETTINGS (TD-77): wrap to START GAME
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__galaxiaGame.engine.phase !== 'title', null, { timeout: 8000 });
    await playABit(p, false, 3000);
    const before = await gameState(p);
    for (const [w, h] of [[1024, 700], [800, 1000], [1600, 900]]) {
      await p.setViewportSize({ width: w, height: h }); await sleep(450);
      const s = await snap(p);
      arenaChecks(`${name} ${w}x${h}`, s);
      const f = s.display.field; const bb = s.bezel.box; const a = s.area;
      check(`${name} ${w}x${h}: still Arcade, bezel re-fitted inside the play area`, s.display.mode === 'arcade' && !s.bezel.hidden && bb.l >= a.left - 1 && bb.t >= a.top - 1 && bb.r <= a.left + a.width + 1 && bb.b <= a.top + a.height + 1 && near(bb.l, f.left - s.display.bezel, 1.5), { d: s.display, bb, a });
    }
    const after = await gameState(p);
    check(`${name}: score / stage / lives kept, game runs, one loop`, after.tick > before.tick && after.score >= before.score && after.stage >= before.stage && after.loops === 1 && after.switches === before.switches, { before, after });
    check(`${name}: no errors`, errs.length === 0, { errs });
    await ctx.close();
  }

  /* ---------------- F. storage ---------------- */
  {
    // legacy Classic record (Stage 2-9 shape: no arcadeDisplay, no galaxia:prefs)
    const name = `${bname} legacy save`;
    const ctx = await context(bt, 1280, 720, 1, false);
    const p = await ctx.newPage();
    const { errs } = watch(p);
    const LEGACY = JSON.stringify({ version: 1, highScore: 33480, bestStage: 7, audio: { muted: true, master: 0.5, sfx: 0.9, music: 0.2 }, display: { glow: false, pixelPerfect: true, reducedMotion: 'on' } });
    await p.goto(PAGE, { waitUntil: 'load' });
    await p.evaluate((rec) => { localStorage.clear(); localStorage.setItem('galaxia:save', rec); }, LEGACY);
    await gotoClassic(p);
    const s = await snap(p);
    check(`${name}: loads in Responsive Display; other prefs migrated as before`, s.display.mode === 'responsive' && JSON.parse(s.prefs).display.arcadeDisplay === false && JSON.parse(s.prefs).display.pixelPerfect === true && JSON.parse(s.prefs).audio.muted === true, { prefs: s.prefs });
    await openSettings(p, false); await flipSwitch(p, false); await backToTitle(p, false);
    const after = await p.evaluate(() => ({ save: localStorage.getItem('galaxia:save'), prefs: localStorage.getItem('galaxia:prefs'), high: document.querySelector('.hud')?.textContent ?? '' }));
    const pr = JSON.parse(after.prefs);
    check(`${name}: switching writes only galaxia:prefs; the Classic record stays byte-identical; other settings kept`, after.save === LEGACY && pr.display.arcadeDisplay === true && pr.display.pixelPerfect === true && pr.display.glow === false && pr.display.reducedMotion === 'on' && pr.audio.muted === true, { after });
    check(`${name}: high score still shown`, after.high.includes('33480'), { hud: after.high.slice(0, 120) });
    check(`${name}: no errors`, errs.length === 0, { errs });
    await ctx.close();
  }
  {
    const name = `${bname} corrupt prefs`;
    const ctx = await context(bt, 1280, 720, 1, false);
    const p = await ctx.newPage();
    const { errs } = watch(p);
    await p.goto(PAGE, { waitUntil: 'load' });
    await p.evaluate(() => { localStorage.clear(); localStorage.setItem('galaxia:prefs', '{"version":1,"display":{"arcadeDisplay":"maybe","glow":false}'); });
    await gotoClassic(p);
    const s = await snap(p);
    check(`${name}: unparsable prefs -> Responsive Display, game playable`, s.display.mode === 'responsive' && s.loops === 1, { d: s.display });
    const ctx2 = await context(bt, 1280, 720, 1, false);
    const p2 = await ctx2.newPage();
    const w2 = watch(p2);
    await p2.goto(PAGE, { waitUntil: 'load' });
    await p2.evaluate(() => { localStorage.clear(); localStorage.setItem('galaxia:prefs', JSON.stringify({ version: 1, audio: { muted: false, master: 0.8, sfx: 1, music: 0.7 }, display: { glow: false, pixelPerfect: false, reducedMotion: 'system', arcadeDisplay: 'maybe' } })); });
    await gotoClassic(p2);
    const s2 = await snap(p2);
    const pr2 = JSON.parse(s2.prefs);
    check(`${name}: wrong-typed setting repaired to Responsive; glow=false kept`, s2.display.mode === 'responsive' && pr2.display.arcadeDisplay === false && pr2.display.glow === false, { prefs: s2.prefs });
    check(`${name}: no errors`, errs.length === 0 && w2.errs.length === 0, { errs, e2: w2.errs });
    await ctx.close(); await ctx2.close();
  }
  {
    const name = `${bname} storage blocked`;
    const ctx = await context(bt, 1280, 720, 1, false);
    await ctx.addInitScript(() => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    const p = await ctx.newPage();
    const { errs } = watch(p);
    await p.goto(`${PAGE}?mode=classic&seed=42`, { waitUntil: 'load' });
    await p.waitForFunction(() => (window.__galaxiaGame?.frames ?? 0) > 10, null, { timeout: 20000 });
    await openSettings(p, false);
    await p.click('.screen-switch'); await sleep(350);
    const s = await p.evaluate(() => ({ mode: window.__galaxiaGame.display.mode, checked: document.querySelector('.screen-switch').getAttribute('aria-checked') }));
    check(`${name}: the switch still works for the session`, s.mode === 'arcade' && s.checked === 'true', s);
    check(`${name}: no errors`, errs.length === 0, { errs });
    await ctx.close();
  }

  /* ---------------- G. Free Roam ignores it; H. ◀ MENU buttons ---------------- */
  {
    const name = `${bname} free roam + menu buttons`;
    const { ctx, p, errs, bad } = await open(bt, 1366, 768, 1, false);
    await openSettings(p, false); await flipSwitch(p, false); await backToTitle(p, false);
    const exitStyle = await p.evaluate(() => { const b = document.querySelector('.mode-exit'); const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); return { cls: b.className, bg: cs.backgroundImage, color: cs.color, h: r.height, w: r.width, text: b.textContent }; });
    check(`${name}: Classic ◀ MENU has the red gradient, white text, 44 px target`, /gradient/.test(exitStyle.bg) && /196, 26, 47/.test(exitStyle.bg) && exitStyle.color === 'rgb(255, 255, 255)' && exitStyle.h >= 44 && exitStyle.w >= 44 && exitStyle.text === '◀ MENU', exitStyle);
    await shot(p, `arcade-${bname}-menu-classic.png`);
    await p.click('.mode-exit');
    await p.waitForFunction(() => !window.__galaxiaGame || window.__galaxiaGame.disposed, null, { timeout: 8000 }).catch(() => {});
    await p.goto(`${PAGE}?mode=freeroam`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 20000 });
    await sleep(300);
    const fr = await p.evaluate(() => {
      const back = document.querySelector('.fr-map:not(.fr-sysmap) .fr-map-back');
      const cs = getComputedStyle(back); const r = back.getBoundingClientRect();
      const sys = document.querySelector('.fr-sysmap .fr-map-back');
      return { bezels: document.querySelectorAll('.arcade-bezel').length, cls: back.className, bg: cs.backgroundImage, color: cs.color, h: r.height, text: back.textContent, sysCls: sys?.className ?? null, arcadePref: JSON.parse(localStorage.getItem('galaxia:prefs')).display.arcadeDisplay };
    });
    check(`${name}: Free Roam keeps its own responsive sizing with Arcade Display on (no bezel)`, fr.bezels === 0 && fr.arcadePref === true, fr);
    check(`${name}: Free Roam galaxy map ◀ MENU has the same red gradient`, fr.text === '◀ MENU' && /menu-btn/.test(fr.cls) && /196, 26, 47/.test(fr.bg) && fr.color === 'rgb(255, 255, 255)' && fr.h >= 44, fr);
    check(`${name}: the system map's in-map back link stays plain (not a menu exit)`, fr.sysCls === null || !/menu-btn/.test(fr.sysCls), { sysCls: fr.sysCls });
    await shot(p, `arcade-${bname}-menu-freeroam.png`);
    check(`${name}: no errors, assets under ${BASE_PATH}`, errs.length === 0 && bad.length === 0, { errs, bad });
    await ctx.close();
  }

  await bt.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
