/**
 * Release smoke test (TD-78): a normal production session driven through the
 * DOM, keyboard and pointer only. It never reads window.__galaxia* hooks, so
 * it runs against the real release build (`npm run build` + `npm run preview`),
 * where the hooks do not exist, and checks that they really are absent.
 *
 *   node release-smoke.mjs <url ending in the base, e.g. http://localhost:4180/galaxia/> [engines]
 *
 * A. title loads, both mode cards, no automation hooks, dev URL params ignored
 * B. Classic launches, the playfield animates, pause + RESUME, QUIT -> menu
 * C. Free Roam launches (map -> sector -> flight), animates, pause + RESUME
 * D. Classic HUD: top-left label reads GALAXIA, top-left aligned, same type as
 *    HIGH SCORE, unclipped, no overlap; score / reserves / stage still shown;
 *    Responsive and Arcade Display at phone, landscape-phone and desktop sizes
 * E. preferences survive a reload (Arcade Display + mute in galaxia:prefs)
 * F. no page errors, failed requests or requests outside the base
 */
import { chromium, firefox, webkit } from 'playwright';

const URL0 = process.argv[2] ?? 'http://localhost:4180/galaxia/';
const ENGINES = (process.argv[3] ?? 'chromium,firefox,webkit').split(',');
const BT = { chromium, firefox, webkit };
const BASE_URL = new URL(URL0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) pass += 1;
  else fails.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 900)}`}`);
};

const HOOKS = ['__galaxia', '__galaxiaGame', '__galaxiaFreeRoam', '__galaxiaHangar'];
const hooks = (p) => p.evaluate((names) => ({ present: names.filter((n) => n in window), booted: window.__galaxiaBooted === true }), HOOKS);
const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return !e.closest('[hidden]') && r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; }, sel);
const waitVisible = (p, sel, ms = 10000) => p.waitForFunction((s) => { const e = document.querySelector(s); if (!e || e.closest('[hidden]')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel, { timeout: ms }).then(() => true, () => false);
const waitGone = (p, sel, ms = 6000) => p.waitForFunction((s) => { const e = document.querySelector(s); return !e || !!e.closest('[hidden]') || e.getBoundingClientRect().width === 0; }, sel, { timeout: ms }).then(() => true, () => false);
/** Downscaled pixel digest of a canvas (to tell whether the picture is changing). */
const digest = (p, sel) => p.evaluate((s) => {
  const c = document.querySelector(s);
  if (!c || !c.width) return null;
  const o = document.createElement('canvas');
  o.width = 64; o.height = 40;
  const x = o.getContext('2d');
  x.drawImage(c, 0, 0, 64, 40);
  const d = x.getImageData(0, 0, 64, 40).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 1) h = (h * 31 + d[i]) >>> 0;
  return h;
}, sel);
/** Number of distinct digests over n samples, ms apart. */
async function animates(p, sel, n = 6, ms = 180) {
  const seen = new Set();
  for (let i = 0; i < n; i += 1) { seen.add(await digest(p, sel)); await sleep(ms); }
  return seen.size;
}
const press = async (p, sel, touch) => (touch ? p.tap(sel) : p.click(sel));

async function launch(bname, { w, h, touch = false, dpr = 1, query = '' }) {
  const browser = await BT[bname].launch();
  const opts = { viewport: { width: w, height: h }, hasTouch: touch, deviceScaleFactor: dpr };
  if (touch && bname !== 'firefox') opts.isMobile = true;
  const ctx = await browser.newContext(opts);
  const p = await ctx.newPage();
  const errs = [];
  const offBase = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('requestfailed', (r) => errs.push(`requestfailed ${r.url()} ${r.failure()?.errorText ?? ''}`));
  p.on('response', (r) => { if (r.status() >= 400) errs.push(`${r.status()} ${r.url()}`); });
  p.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && (u.origin !== BASE_URL.origin || !u.pathname.startsWith(BASE_URL.pathname))) offBase.push(r.url()); });
  await p.goto(URL0 + query, { waitUntil: 'load' });
  return { browser, ctx, p, errs, offBase };
}

async function openClassic(p, touch) {
  await press(p, '.mode-card-classic', touch);
  return waitVisible(p, '.screen-title [data-action=start]');
}
async function startClassic(p, touch) {
  await press(p, '.screen-title [data-action=start]', touch);
  await waitGone(p, '.screen-title');
  // the HUD score label is filled once the run's first frame lands
  return p.waitForFunction(() => document.querySelector('.hud-cell-left .hud-label')?.textContent?.length > 0, null, { timeout: 8000 }).then(() => true, () => false);
}
async function setArcade(p, touch, on) {
  await press(p, '.screen-title [data-action=settings]', touch);
  await waitVisible(p, '.screen-switch');
  const cur = await p.evaluate(() => document.querySelector('.screen-switch').getAttribute('aria-checked') === 'true');
  if (cur !== on) { await press(p, '.screen-switch', touch); await sleep(350); }
  const now = await p.evaluate(() => document.querySelector('.game-app').dataset.display);
  await press(p, '.screen-settings [data-action=back]', touch);
  await waitVisible(p, '.screen-title [data-action=start]');
  await sleep(350);
  return now;
}

/** HUD top band geometry from the text itself (Range boxes, not the flex cells). */
const hudGeometry = (p) => p.evaluate(() => {
  const textBox = (e) => { if (!e || !e.firstChild) return null; const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
  // Painted glyphs (ink) of a single-line text: the range box above is the font's
  // content area (ascent + descent, including empty space above capitals and below
  // the baseline); the ink is measured with the same font on a canvas.
  const mc = document.createElement('canvas').getContext('2d');
  const inkBox = (e) => {
    const b = textBox(e); if (!b) return null;
    const st = getComputedStyle(e);
    mc.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
    const m = mc.measureText(e.textContent);
    const base = b.t + m.fontBoundingBoxAscent;
    return { l: b.l, r: b.r, t: base - m.actualBoundingBoxAscent, b: base + m.actualBoundingBoxDescent, w: b.w };
  };
  const q = (s) => document.querySelector(s);
  const label = q('.hud-cell-left .hud-label');
  const score = q('.hud-cell-left .hud-value');
  const hiLabel = q('.hud-cell-center .hud-label');
  const hiValue = q('.hud-cell-center .hud-value');
  const ticker = q('.hud-ticker');
  const hud = q('.hud').getBoundingClientRect();
  const cell = q('.hud-cell-left');
  const cs = getComputedStyle(label);
  const hs = getComputedStyle(hiLabel);
  const reserves = q('.hud-reserves');
  const stageBits = [...document.querySelectorAll('.hud-stage > span')].map((s) => s.textContent).join('|');
  return {
    text: label.textContent, scoreText: score.textContent, hiText: hiLabel.textContent,
    label: textBox(label), score: textBox(score), hiLabel: textBox(hiLabel), hiValue: textBox(hiValue),
    labelInk: inkBox(label), scoreInk: inkBox(score),
    ticker: ticker.textContent.trim() ? textBox(ticker) : null,
    hud: { l: hud.left, r: hud.right, t: hud.top, b: hud.bottom },
    cellClip: cell.scrollWidth - cell.clientWidth,
    font: { size: cs.fontSize, family: cs.fontFamily, weight: cs.fontWeight, colour: cs.color, letter: cs.letterSpacing },
    hiFont: { size: hs.fontSize, family: hs.fontFamily, weight: hs.fontWeight, colour: hs.color, letter: hs.letterSpacing },
    reserves: reserves ? reserves.children.length + (reserves.textContent.trim() ? 1 : 0) : 0,
    stage: stageBits,
    display: q('.game-app').dataset.display,
    vw: innerWidth, vh: innerHeight,
  };
});
const sep = (a, b) => !a || !b || a.r <= b.l - 1 || b.r <= a.l - 1 || a.b <= b.t || b.b <= a.t;

/* ---------- A-C, E-F: one desktop session per engine ---------- */
async function session(bname) {
  const { browser, ctx, p, errs, offBase } = await launch(bname, { w: 1366, h: 768 });
  try {
    /* A */
    const titleOk = await waitVisible(p, '.mode-card-classic') && await visible(p, '.mode-card-freeroam');
    const h0 = await hooks(p);
    check(`${bname}: A title loads with both mode cards`, titleOk);
    check(`${bname}: A no automation hooks on window (only the boot watchdog flag)`, h0.present.length === 0 && h0.booted, h0);

    /* B Classic */
    check(`${bname}: B Classic opens on its title`, await openClassic(p, false));
    check(`${bname}: B START GAME begins a run`, await startClassic(p, false));
    await sleep(600);
    const moving = await animates(p, '.game-app canvas');
    check(`${bname}: B the Classic playfield animates`, moving >= 3, { moving });
    await p.keyboard.down('ArrowLeft'); await sleep(400); await p.keyboard.up('ArrowLeft');
    await p.keyboard.press('Escape');
    const paused = await waitVisible(p, '.screen-pause [data-action=resume]', 4000);
    await sleep(300);
    const frozen = await animates(p, '.game-app canvas', 4, 150);
    check(`${bname}: B Escape pauses (pause menu shown, playfield still)`, paused && frozen <= 2, { paused, frozen });
    await p.click('.screen-pause [data-action=resume]');
    const resumed = await waitGone(p, '.screen-pause');
    await sleep(300);
    const again = await animates(p, '.game-app canvas');
    check(`${bname}: B RESUME closes the menu and the run continues`, resumed && again >= 3, { resumed, again });
    const h1 = await hooks(p);
    check(`${bname}: B still no hooks while Classic runs`, h1.present.length === 0, h1);
    await p.keyboard.press('Escape');
    await waitVisible(p, '.screen-pause [data-action=quit]', 4000);
    await p.click('.screen-pause [data-action=quit]');
    await waitVisible(p, '.mode-exit', 4000);
    await p.click('.mode-exit');
    check(`${bname}: B QUIT then ◀ MENU returns to the mode menu`, await waitVisible(p, '.mode-card-freeroam'));

    /* C Free Roam */
    await p.click('.mode-card-freeroam');
    const map = await waitVisible(p, '.fr-map:not(.fr-sysmap) .fr-det-actions', 15000);
    check(`${bname}: C Free Roam opens on the sector map`, map);
    await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
    const brief = await waitVisible(p, '.fr-panel-briefing:not([data-arming])', 10000);
    await sleep(150);
    await p.keyboard.press('Enter');
    const flying = brief && await waitGone(p, '.fr-panel-briefing', 6000);
    await sleep(500);
    await p.keyboard.down('ArrowUp'); // thrust: an idle ship in a quiet sector can look still
    const frMoving = await animates(p, '.fr-canvas');
    check(`${bname}: C briefing -> START FLIGHT -> the sector animates`, flying && frMoving >= 3, { brief, flying, frMoving });
    const h2 = await hooks(p);
    check(`${bname}: C still no hooks while Free Roam runs`, h2.present.length === 0, h2);
    await p.keyboard.press('Escape');
    const frPaused = await waitVisible(p, '.fr-panel-pause:not([data-arming])', 4000);
    await sleep(300);
    const frFrozen = await animates(p, '.fr-canvas', 4, 150); // thrust still held: nothing may move
    check(`${bname}: C Escape pauses Free Roam (panel shown, sector still, thrust held)`, frPaused && frFrozen <= 2, { frPaused, frFrozen });
    await p.click('.fr-panel-pause >> text=RESUME');
    const frResumed = await waitGone(p, '.fr-panel-pause');
    await sleep(300);
    await p.keyboard.up('ArrowUp'); // input is cleared on pause: press again
    await p.keyboard.down('ArrowUp');
    const frAgain = await animates(p, '.fr-canvas');
    await p.keyboard.up('ArrowUp');
    check(`${bname}: C RESUME closes the panel and flight continues`, frResumed && frAgain >= 3, { frResumed, frAgain });

    /* E prefs survive a reload */
    await p.goto(URL0, { waitUntil: 'load' });
    await openClassic(p, false);
    const disp = await setArcade(p, false, true);
    await p.click('.screen-title [data-action=settings]');
    await waitVisible(p, '.screen-settings [data-action=back]');
    const muteSel = '.screen-settings .screen-toggle[aria-label="SOUND"]';
    const soundState = () => p.evaluate((s) => document.querySelector(s)?.textContent.trim() ?? null, muteSel);
    const s0 = await soundState();
    await p.click(muteSel);
    await sleep(150);
    const s1 = await soundState();
    const prefsBefore = await p.evaluate(() => localStorage.getItem('galaxia:prefs'));
    await p.goto(URL0, { waitUntil: 'load' });
    await openClassic(p, false);
    const afterDisp = await p.evaluate(() => document.querySelector('.game-app').dataset.display);
    const prefsAfter = await p.evaluate(() => localStorage.getItem('galaxia:prefs'));
    await p.click('.screen-title [data-action=settings]');
    await waitVisible(p, '.screen-settings [data-action=back]');
    const s2 = await soundState();
    check(`${bname}: E Arcade Display and SOUND persist across a reload (galaxia:prefs)`, disp === 'arcade' && afterDisp === 'arcade' && s0 !== s1 && s2 === s1 && prefsAfter === prefsBefore && !!prefsAfter, { disp, afterDisp, s0, s1, s2, prefsBefore, prefsAfter });
    await p.click(muteSel); // sound back on
    await p.click('.screen-settings [data-action=back]');
    await waitVisible(p, '.screen-title [data-action=start]');
    await sleep(350);
    await setArcade(p, false, false);

    /* A2 dev parameters do nothing in the release build */
    await p.goto(`${URL0}?debug=1&stage=9&view=hangar`, { waitUntil: 'load' });
    const devOff = await waitVisible(p, '.mode-card-classic') && !(await p.$('.hangar, [class*="hangar"]'));
    const h3 = await hooks(p);
    check(`${bname}: A ?debug=1&stage=9&view=hangar opens the normal menu (no Hangar, no hooks)`, devOff && h3.present.length === 0, { devOff, h3 });

    /* F */
    check(`${bname}: F no page errors or failed requests`, errs.length === 0, errs);
    check(`${bname}: F every request stays under ${BASE_URL.pathname}`, offBase.length === 0, offBase);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

/* ---------- D: HUD label across viewports and both displays ---------- */
const VIEWPORTS = [
  { w: 320, h: 568, touch: true, dpr: 2 },
  { w: 390, h: 844, touch: true, dpr: 3 },
  { w: 568, h: 320, touch: true, dpr: 2 },
  { w: 1280, h: 720, touch: false, dpr: 1 },
  { w: 1920, h: 1080, touch: false, dpr: 1 },
];
async function hud(bname, vp) {
  const query = vp.touch && bname !== 'webkit' ? '?controls=touch' : '';
  const { browser, ctx, p, errs } = await launch(bname, { ...vp, query });
  try {
    await openClassic(p, vp.touch);
    for (const want of ['responsive', 'arcade']) {
      const got = await setArcade(p, vp.touch, want === 'arcade');
      await startClassic(p, vp.touch);
      await sleep(2600); // past the stage intro: reserves and stage drawn
      const g = await hudGeometry(p);
      const tag = `${bname} ${vp.w}x${vp.h} ${want}`;
      const top = Math.abs(g.label.t - g.hiLabel.t);
      check(`${tag}: D HUD top-left label reads GALAXIA`, g.text === 'GALAXIA' && got === want, { text: g.text, got });
      check(`${tag}: D label sits top-left in the HUD, top-aligned with HIGH SCORE`, g.label.l >= g.hud.l && g.label.l - g.hud.l < (g.hud.r - g.hud.l) * 0.12 && g.label.t >= g.hud.t && top <= 1.5, { label: g.label, hud: g.hud, top });
      // label vs HIGH SCORE / ticker: text boxes; label vs the score stacked under it:
      // painted glyphs (their content boxes touch by design, as with the old 1UP label)
      check(`${tag}: D label is unclipped and clear of the score, HIGH SCORE and ticker`, g.cellClip <= 0 && g.label.r <= g.vw && sep(g.label, g.hiLabel) && sep(g.label, g.hiValue) && sep(g.label, g.ticker) && sep(g.labelInk, g.scoreInk) && sep(g.score, g.hiValue), g);
      check(`${tag}: D label keeps the HUD label typography (same as HIGH SCORE)`, JSON.stringify(g.font) === JSON.stringify(g.hiFont), { font: g.font, hi: g.hiFont });
      check(`${tag}: D score, reserves and stage indicators still shown`, /^\d+$/.test(g.scoreText) && g.hiText === 'HIGH SCORE' && g.reserves >= 1 && /STAGE\|\d+|\|STAGE\|/.test(g.stage + '|'), { score: g.scoreText, reserves: g.reserves, stage: g.stage });
      await p.keyboard.press('Escape');
      await waitVisible(p, '.screen-pause [data-action=quit]', 4000);
      await press(p, '.screen-pause [data-action=quit]', vp.touch);
      await waitVisible(p, '.screen-title [data-action=start]', 6000);
      await sleep(300);
    }
    check(`${bname} ${vp.w}x${vp.h}: D no page errors`, errs.length === 0, errs);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

for (const b of ENGINES) {
  try { await session(b); } catch (e) { check(`${b}: session completed`, false, String(e)); }
  for (const vp of VIEWPORTS) {
    try { await hud(b, vp); } catch (e) { check(`${b} ${vp.w}x${vp.h}: HUD run completed`, false, String(e)); }
  }
}
console.log(`\nrelease-smoke: ${pass}/${pass + fails.length} passed${fails.length ? `\nFAILED:\n  ${fails.join('\n  ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
