#!/usr/bin/env node
/**
 * Finale P3 browser harness: the opening cinematic and the home-page handoff.
 * Post-release cockpit upgrade: same 65 checks; the run now also captures the
 * cabin's reveal (desk-approach/cabin/display/push/home and per-viewport
 * *-cabin.png) into .cinematic-f3-shots/ for human review.
 *
 * Usage: node docs/development/playtest/cinematic-opening-f3.mjs [baseUrl]
 * (default http://127.0.0.1:4181/galaxia/), against a served QA / build:e2e
 * build (it reads window.__galaxia.debug().intro and plays the timeline with
 * Playwright's fake clock: deterministic frames without touching production
 * hooks). Release builds have no __galaxia; run this against the QA build.
 */
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 500)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shotDir = new URL('.cinematic-f3-shots/', import.meta.url).pathname;

const SKIPPED_GUIDE = JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }); // galaxia:guide record (seen = guide content version)

async function open({ w = 1280, h = 800, reduced = 'no-preference', touch = false, blockIntro = false, query = '', seedGuide = true, seedPrefs = null } = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: reduced, hasTouch: touch, isMobile: touch });
  if (seedGuide) await ctx.addInitScript((v) => localStorage.setItem('galaxia:guide', v), SKIPPED_GUIDE);
  if (seedPrefs) await ctx.addInitScript((v) => { const cur = JSON.parse(localStorage.getItem('galaxia:prefs') ?? '{}'); cur.audio = { ...(cur.audio ?? {}), ...v }; cur.version = 1; localStorage.setItem('galaxia:prefs', JSON.stringify(cur)); }, seedPrefs);
  if (blockIntro) await ctx.route(/openingCinematic-[^/]*\.js/, (r) => r.abort());
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  return { browser, ctx, p, errs, query };
}
const gotoHome = async (p, query = '') => p.goto(PAGE + query, { waitUntil: 'load' });
const debug = (p) => p.evaluate(() => window.__galaxia?.debug() ?? null);
const intro = async (p) => (await debug(p))?.intro ?? null;
const music = async (p) => (await debug(p))?.music ?? null;
const saveDump = (p) => p.evaluate(() => Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]));

/** Advance the fake clock and collect the observed phases. `shots` (phase -> filename) captures the first
 *  sighting of each wanted phase for human review (post-release cockpit upgrade review shots). */
async function runThrough(p, untilMs, log = [], shots = null) {
  let t = log.length ? log[log.length - 1][0] : 0;
  while (t < untilMs) {
    await p.clock.runFor(250);
    t += 250;
    const i = await intro(p);
    if (i) log.push([t, i.phase, i.state, i.outcome, (await music(p))?.loads ?? null]);
    if (!i) log.push([t, 'no-intro', 'resolved', null, 0]);
    if (i && shots && shots[i.phase]) {
      await p.screenshot({ path: `${shotDir}${shots[i.phase]}` });
      delete shots[i.phase];
    }
    if (i && i.state === 'resolved') break;
  }
  return log;
}
const STUB_PHASES = ['arrival', 'battle', 'victory', 'track', 'approach', 'cabin', 'display', 'push', 'handoff'];

async function main() {
  /* ============ A. full cinematic, desktop 1280x800 ============ */
  {
    const { browser, p, errs } = await open();
    const before = { save: null };
    await p.clock.install();
    await gotoHome(p);
    before.save = await saveDump(p);
    // initial: overlay from the first frame, hidden SKIP (until the reveal threshold)
    const reqLog = [];
    p.on('request', (r) => reqLog.push(r.url()));
    const initial = await p.evaluate(() => {
      const i = window.__galaxia?.debug().intro;
      const ov = document.querySelector('.intro-overlay');
      return { intro: i, overlay: !!ov, skip: ov?.querySelector('.intro-skip')?.hidden, inert: document.querySelector('.title-inner')?.inert };
    });
    check('A01 overlay owns the first frame (cover + live title)', initial.overlay === true && initial.inert === true);
    check('A02 SKIP INTRO is hidden until the intro has been seen', initial.skip === true);
    check('A03 the intro starts exactly once, in loading or playing', initial.intro && initial.intro.loads === 1 && ['loading', 'playing'].includes(initial.intro.state));
    check('A04 the theme does not load while the intro runs', (await music(p)).loads === 0);
    // skip has no effect before the threshold
    const log = [];
    await p.clock.runFor(300);
    log.push([300, (await intro(p)).phase]);
    const e = await p.evaluate(() => document.querySelector('.intro-overlay')?.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }))); // synthetic: SKIP INTRO stays usable only as the OS reports Escape here
    check('A06 Escape before the skip threshold does nothing', (await intro(p)).state !== 'resolved', e ? {} : {});
    await p.clock.runFor(400);
    log.push([700, (await intro(p)).phase]);
    const skipShown = await p.evaluate(() => {
      const b = document.querySelector('.intro-skip');
      return { shown: !b.hidden, focused: document.activeElement === b, minH: b.getBoundingClientRect().height >= 44 };
    });
    check('A07 SKIP INTRO appears with visible focus and a 44px target', skipShown.shown && skipShown.focused && skipShown.minH);

    // walk the phases deterministically (screenshots of the cockpit reveal are meant to be looked at)
    await runThrough(p, 11000, log, { approach: 'desk-approach.png', cabin: 'desk-cabin.png', display: 'desk-display.png', push: 'desk-push.png' });
    const phases = [...new Set(log.map(([, ph]) => ph))];
    check('A08 every phase in its documented order', JSON.stringify(phases.filter((p2) => STUB_PHASES.includes(p2))) === JSON.stringify(STUB_PHASES), { phases });
    const done = await intro(p);
    check('A09 resolves as played at the end', done.state === 'resolved' && done.outcome === 'played', done);
    const leftovers = await p.evaluate(() => ({
      overlay: !!document.querySelector('.intro-overlay'),
      stageCanvases: document.querySelectorAll('.galaxia-root > canvas').length,
      transform: document.querySelector('.title-screen').style.transform || '',
    }));
    check('A10 cleanup: overlay gone, nothing drawn over the root, loop and listeners at 0', !leftovers.overlay && leftovers.stageCanvases === 0 && leftovers.transform === '' && done.cinematic && done.cinematic.loops === 0 && done.cinematic.listeners === 0 && done.cinematic.disposed === true, leftovers);
    await p.screenshot({ path: `${shotDir}desk-home.png` });
    check('A11 bounded work: frames and particles capped', done.cinematic.frames < 1200 && done.cinematic.maxParticles <= 160, done.cinematic);

    // the handoff: live page, untransformed, unobstructed, focused
    const home = await p.evaluate(() => {
      const t = document.querySelector('.title-screen');
      const b = document.querySelector('.mode-card-classic').getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      const m = window.__galaxia.debug();
      return { transform: t.style.transform || '', visible: !t.hidden, covered: el === null || el.closest('.intro-overlay') !== null, isCard: el === document.querySelector('.mode-card-classic') || el?.closest('.mode-card-classic') !== null, focused: document.activeElement?.dataset?.mode === 'classic', music: m.music.status, blocked: m.title.visible && m.music };
    });
    check('A12 the home page is full-viewport at the identity (no transform)', home.transform === '' && home.visible);
    check('A13 no layer covers the CLASSIC card', home.isCard && !home.covered);
    check('A14 focus returns to the highlighted mode card', home.focused);
    check('A15 after the handoff the theme is truthful (locked, or playing only if this browser genuinely allows autoplay)', ['locked', 'playing', 'loading', 'muted', 'sound-off'].includes((await music(p)).status), await music(p));
    const running = log.filter(([, , st]) => st !== 'resolved' && st !== undefined);
    const res = log.find(([, , st]) => st === 'resolved');
    const musicLoadsWhileRunning = running.map((r) => r[4]);
    check("A16 the theme's chunk stays unfetched while the cinematic runs", musicLoadsWhileRunning.every((x) => x === 0) && !!res && (res[4] ?? 0) <= 1, { running: musicLoadsWhileRunning, res });
    await sleep(400);
    check('A16b the theme loads after the handoff (lazy, only when the home page wants it)', reqLog.some((u) => /galaxiaTheme-[^/]*\.js/.test(u)));

    // saves untouched
    const after = JSON.stringify(await saveDump(p));
    check('A17 localStorage is byte-identical before and after the cinematic', after === JSON.stringify(before.save));

    // post-handoff navigation
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__galaxia?.debug().mode === 'classic', null, { timeout: 15000 });
    await sleep(600);
    check('A18 Enter on CLASSIC starts Classic after the handoff', true);
    await p.evaluate(() => window.__galaxia.menu());
    await p.waitForFunction(() => window.__galaxia?.debug()?.title?.visible === true, null, { timeout: 10000 });
    check('A19 returning home shows no overlay and never replays the intro', await p.evaluate(() => !document.querySelector('.intro-overlay') && window.__galaxia.debug().intro.state === 'resolved'));
    check('A20 the theme now starts trying to play (locked without a gesture)', ['locked', 'playing', 'loading'].includes((await music(p)).status), await music(p));
    // PLAY MUSIC on the real home page (if this browser's autoplay rule already started it, PLAY MUSIC is simply not shown)
    const st = (await music(p)).status;
    if (st === 'locked' || st === 'blocked') {
      await p.click('.title-music-play');
      await sleep(500);
      check('A21 PLAY MUSIC starts the theme on the real home page', (await music(p)).status === 'playing', await music(p));
    } else {
      check('A21 PLAY MUSIC starts the theme on the real home page (autoplay allowed: already playing, the button is honestly hidden)', st === 'playing' && (await p.evaluate(() => document.querySelector('.title-music-play').hidden)), st);
    }
    check('A22 no page errors', errs.length === 0, errs);
    await browser.close();
  }

  /* ============ B. skip paths ============ */
  {
    const { browser, p, errs } = await open();
    await p.clock.install();
    await gotoHome(p);
    await p.clock.runFor(900);
    // click twice as fast as possible: one resolution, no duplicate state
    const b = await p.$('.intro-skip');
    await Promise.race([b.click(), sleep(1)]);
    await b.click().catch(() => {});
    await b.click().catch(() => {});
    const d = await intro(p);
    check('B01 skip resolves once, outcome skipped', d.state === 'resolved' && d.outcome === 'skipped', d);
    for (let i = 0; i < 30 && (await p.evaluate(() => !!document.querySelector('.intro-overlay'))); i++) await p.clock.runFor(120); // the skip fade (fake clock)
    check('B02 the home page is interactive after a skip', await p.evaluate(() => !document.querySelector('.intro-overlay') && !document.querySelector('.title-screen').hidden && document.querySelector('.title-inner').inert === false));
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__galaxia?.debug().mode === 'freeroam', null, { timeout: 20000 });
    check('B03 after a skip, Enter on FREE ROAM starts the mode', true);
    check('B04 no page errors', errs.length === 0, errs);
    await browser.close();
  }
  {
    const { browser, p, errs } = await open();
    await p.clock.install();
    await gotoHome(p);
    await p.clock.runFor(700 + 2500); // mid-battle
    const mid = await intro(p);
    check('B05 skipping mid-battle: in the battle phase', mid.phase === 'battle', mid.phase);
    await p.keyboard.press('Escape');
    const d = await intro(p);
    check('B06 Escape skips once it is available', d.state === 'resolved' && d.outcome === 'skipped');
    check('B07 no mode started by the Escape', (await debug(p)).mode === null);
    check('B08 no page errors', errs.length === 0, errs);
    await browser.close();
  }
  {
    // skipping during a phase a fraction past a kill: repeatable and staged
    const { browser, p, errs } = await open();
    await p.clock.install();
    await gotoHome(p);
    for (let i = 0; i < 60 && (await intro(p)).phase !== 'display'; i++) await p.clock.runFor(150); // walk into the display phase (the async chunk load eats some ticks)
    const d0 = await intro(p);
    check('B09 late skip from the display phase is possible', d0.state === 'playing' && d0.phase === 'display', d0);
    await p.click('.intro-skip');
    const d = await intro(p);
    check('B10 the display phase skip reaches the same resolved home page', d.state === 'resolved' && d.outcome === 'skipped');
    check('B11 no page errors', errs.length === 0, errs);
    await browser.close();
  }

  /* ============ C. reduced motion ============ */
  {
    const { browser, p, errs } = await open({ reduced: 'reduce' });
    await p.clock.install();
    await gotoHome(p);
    const log = await runThrough(p, 6000);
    const phases = [...new Set(log.map(([, ph]) => ph))].filter((x) => x !== 'idle');
    const d = await intro(p);
    const only = phases.filter((x) => x !== 'complete');
    const orderOK = JSON.stringify(only) === JSON.stringify([...only].sort((x, y) => ['cabin', 'display', 'push', 'handoff'].indexOf(x) - ['cabin', 'display', 'push', 'handoff'].indexOf(y)));
    check('C01 reduced motion visits only cabin..handoff, in order (a 250 ms phase can fall between two samples)', only.length >= 3 && orderOK && only[0] === 'cabin' && only.includes('display') && only.includes('handoff') && !['arrival', 'battle', 'victory', 'track', 'approach'].some((x) => only.includes(x)), phases);
    check('C02 reduced motion resolves within its budget (~1.65 s)', d.state === 'resolved' && d.outcome === 'reduced' && d.cinematic && d.cinematic.time <= 2000, d.cinematic);
    check('C03 the reduced sequence was flag-marked in the cinematic', (await p.evaluate(() => document.querySelector('.galaxia-root').dataset.introOutcome)) === 'reduced');
    check('C04 the home page is the same afterwards', await p.evaluate(() => !document.querySelector('.intro-overlay') && document.querySelector('.mode-card-classic') !== null && !document.querySelector('.title-screen').hidden));
    check('C05 no page errors', errs.length === 0, errs);
    await browser.close();
  }

  /* ============ D. failure and deep links ============ */
  {
    const { browser, p, errs } = await open({ blockIntro: true });
    await p.clock.install();
    await gotoHome(p);
    const log = await runThrough(p, 9000); // fake network fails at once; the watchdog is the only bound
    const d = await intro(p);
    check('D01 a cinematic-chunk failure resolves (failed, not a trap)', d.state === 'resolved' && ['failed', 'timeout'].includes(d.outcome), d);
    const notice = await p.evaluate(() => ({ text: [...document.querySelectorAll('.title-notice')].map((n) => n.textContent), visible: !document.querySelector('.title-screen').hidden }));
    check('D02 an honest notice replaces the menu', notice.text.some((t) => t.includes('opening cinematic')) && notice.visible);
    check('D03 the home page still works after the failure', await p.evaluate(() => !document.querySelector('.intro-overlay') && !document.querySelector('.title-screen').inert));
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => window.__galaxia?.debug().mode === 'classic', null, { timeout: 15000 });
    check('D04 Enter starts Classic after the intro failed', true);
    await p.evaluate(() => window.__galaxia.menu());
    await sleep(300);
    check('D05 returning home does not retry the failed intro', (await intro(p)).outcome === 'failed' || (await intro(p)).outcome === 'timeout');
    check('D06 no page errors besides the expected load failure', errs.filter((e) => !/openingCinematic|Failed to fetch|net::ERR|dynamic import/i.test(e)).length === 0, errs);
    await browser.close();
  }
  {
    const { browser, p } = await open();
    await gotoHome(p, '?intro=skip');
    await sleep(700);
    const d = await intro(p);
    check('D07 ?intro=skip opens the home page with no intro at all', d === null && await p.evaluate(() => !document.querySelector('.intro-overlay') && !document.querySelector('.title-screen').hidden));
    await browser.close();
  }
  {
    const { browser, p } = await open();
    await p.clock.install();
    await gotoHome(p, '?mode=classic');
    await runThrough(p, 2500);
    check('D08 a ?mode= deep link never shows the intro', await p.evaluate(() => !document.querySelector('.intro-overlay') && window.__galaxia.debug().intro === null));
    await p.evaluate(() => window.__galaxia.menu());
    await sleep(400);
    await runThrough(p, 1500);
    check('D09 the first home-page showing after a deep link is plain (once per page load, the intro is not owed)', await p.evaluate(() => window.__galaxia.debug().intro === null && !document.querySelector('.intro-overlay')));
    await browser.close();
  }

  /* ============ E. music and prefs survive the cinematic ============ */
  {
    const { browser, p, errs } = await open({ seedPrefs: { master: 1, sfx: 1, music: 1, musicMuted: true, muted: false } });
    await p.clock.install();
    await gotoHome(p);
    await runThrough(p, 11000);
    const m = await music(p);
    check('E01 a muted player stays muted through the cinematic', m.status === 'muted' && await p.evaluate(() => !document.querySelector('.intro-overlay')), m);
    const prefs = await p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:prefs')).audio);
    check('E02 the cinematic never touches saved audio prefs', prefs.musicMuted === true && prefs.music === 1);
    check('E03 no page errors', errs.length === 0, errs);
    await browser.close();
  }

  /* ============ F. viewports (screenshots are inspected by a human) ============ */
  for (const [w, h, tag] of [[320, 568, 'm-phone-portrait'], [844, 390, 'm-phone-landscape'], [768, 1024, 'm-tablet'], [390, 844, 'm-heat']]) {
    const { browser, p, errs } = await open({ w, h, touch: true });
    await p.clock.install();
    await gotoHome(p);
    const cabShot = { cabin: `${tag}-cabin.png` }; // reviewed by a human: the cockpit reveal on each form factor
    for (let t = 0; t < 6500; t += 250) {
      await p.clock.runFor(250);
      const i = await intro(p);
      if (i && cabShot.cabin && i.phase === 'cabin') {
        await p.screenshot({ path: `${shotDir}${cabShot.cabin}` });
        delete cabShot.cabin;
      }
    } // cabin / display
    const mid = await intro(p);
    await p.screenshot({ path: `${shotDir}${tag}-display.png` });
    check(`F01 [${tag}] the intro is in its cockpit/display phases on this size`, ['cabin', 'display'].includes(mid.phase) || mid.phase === 'push', mid.phase);
    await runThrough(p, 4000);
    const d = await intro(p);
    check(`F02 [${tag}] reaches the interactive home page on this size`, d.state === 'resolved' && d.outcome === 'played', d);
    check(`F03 [${tag}] no page errors`, errs.length === 0, errs);
    await p.screenshot({ path: `${shotDir}${tag}-home.png` });
    await browser.close();
  }

  /* ============ G. touch: a tap on SKIP INTRO cannot activate the mode cards beneath ============ */
  {
    const { browser, p, errs } = await open({ w: 390, h: 844, touch: true });
    await p.clock.install();
    await gotoHome(p);
    await p.clock.runFor(800);
    const b = await p.$('.intro-skip');
    const bb = await b.boundingBox();
    await p.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    const d = await intro(p);
    check('G01 a touch tap skips the intro', d.state === 'resolved' && d.outcome === 'skipped', d);
    check('G02 the tap never reached a mode card', (await debug(p)).mode === null);
    check('G03 no page errors', errs.length === 0, errs);
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
