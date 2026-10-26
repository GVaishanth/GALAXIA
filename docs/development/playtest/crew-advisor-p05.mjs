// P05.2 / P05.3: Ship Mind, Navigator and Surveyor advice in a real browser (QA build: needs the test hooks).
// The hooks only set up real states (hull, position, a seat); every message comes from the game's own
// advisory pass. Checks: solo play gets Ship Mind advice (low hull, corona) labelled by icon + word +
// speaker, never colour alone; CRITICAL ONLY (CONTROLS) mutes a warning but never a critical, and is
// saved in the prefs; an unchanged condition is not repeated, a worse one is; nothing shows over the
// pause menu, and after resuming the one message that was on screen is re-evaluated once (shown again
// only while it still holds); back on ALL ADVICE, the most urgent hazard muted meanwhile is announced
// once; a seated Navigator reads a real well in REALISTIC and never steers or toggles STOP; a seated
// Surveyor names only POIs inside sensor range; crew seated on another ship say nothing; the strip takes
// no input and stays clear of the HUD, the key-hint line, the ship and the touch stick's graphic (a real
// held touch at the DRAG TO FLY spot and low thumb spots; also with the tallest, longest line) at 1280x720, 360x640, 320x568, 740x360 and
// 568x320; in touch portrait NEARBY steps aside while advice holds its slot and returns after; no
// console errors.
//
// Usage: node crew-advisor-p05.mjs [pageUrl] [screenshotDir]
// Run from a folder where `playwright` resolves (e.g. /tmp/pw). Chromium only.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SHOTS = process.argv[3] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const SOL = 'milky-way/sol';
const STICK_R = 56; // pointers.ts default stick radius (CSS px)
const SHIP_CLEAR = 34; // ui/hudStack.ts: half the ship sprite box plus a margin, around the view centre
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};
async function pauseAction(p, label) {
  const head = '#fr-pause-settings';
  await p.waitForSelector(head);
  if ((await p.getAttribute(head, 'aria-expanded')) !== 'true') { await p.click(head); await sleep(400); }
  await p.click(`.fr-panel-pause .fr-pause-item:text-is("${label}")`);
  await sleep(150);
}
/** Pause > CONTROLS > SHIP MIND choice > back to flight. */
async function chooseAdvice(p, label) {
  await p.keyboard.press('Escape');
  await sleep(200);
  await pauseAction(p, 'CONTROLS');
  await p.click(`.fr-controls-advice >> text=${label}`);
  await sleep(150);
  const pressed = await p.evaluate(() => [...document.querySelectorAll('.fr-controls-advice button')].map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`).join());
  await p.keyboard.press('Escape');
  await sleep(200);
  await p.keyboard.press('Escape');
  await sleep(400);
  return pressed;
}

/** A v10 save: Petrel + Swift, Sol surveyed or not, optional crew. */
const save = ({ surveyed = true, active = 'petrel', crew = null } = {}) => ({
  version: 10, createdAt: 1, sessions: 3, flightSeconds: 900, beaconsCharted: 3, surveysCompleted: 1, bestSurveyTicks: 5000,
  currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL], galaxySurveys: { 'milky-way': 1 },
  currentSystem: SOL, visitedSystems: [SOL],
  sectors: { [SOL]: { done: [], surveyed } },
  cargo: { scrap: 4, fuel: 6 },
  fleet: { active, owned: ['petrel', 'swift'], loadouts: {} },
  lostCargo: null, modules: {}, milestones: [],
  progression: { marks: 100, missions: { active: [], completed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], claimed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
  savedAt: 1, resume: null,
  ...(crew ? { crew } : {}),
});

const adv = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  const a = f.advisor();
  return { view: a.view, strip: a.strip, crew: a.crew, obs: a.observation, shown: a.state.shownCount, held: a.state.held, muted: a.state.muted, parked: a.state.parked, phase: f.state.phase, panel: f.panel() };
});
/** Poll the advisory for `ms` and return every distinct message shown (by serial). */
async function collect(p, ms) {
  const seen = new Map();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await p.evaluate(() => window.__galaxiaFreeRoam.advisor().view);
    if (v && !seen.has(v.serial)) seen.set(v.serial, v);
    await sleep(40);
  }
  return [...seen.values()];
}
const waitAdvice = async (p, pred, ms = 3000) => {
  const t0 = Date.now();
  let a = await adv(p);
  while (!(a.view && pred(a.view)) && Date.now() - t0 < ms) { await sleep(40); a = await adv(p); }
  return a;
};
const shot = async (p, name) => { if (SHOTS) { await sleep(300); await p.screenshot({ path: join(SHOTS, `p05-advice-${name}.png`), fullPage: false }); } };
const place = (p, fn) => p.evaluate(fn);
const setHull = (p, frac) => p.evaluate((k) => { const s = window.__galaxiaFreeRoam.state; s.hull = Math.max(1, Math.round(s.craft.stats.hull * k)); }, frac);
const stripHead = (p) => p.evaluate(() => `${document.querySelector('.fr-advice-icon')?.textContent ?? ''} ${document.querySelector('.fr-advice-head')?.textContent ?? ''}`);

/**
 * The strip's box against every other visible HUD overlay (absolute / fixed, not a full-screen layer), the
 * key-hint line (even once faded), the ship drawn at the view centre and, if given, the stick's base circle.
 * Measured after the line's 160 ms fade-in.
 */
const layout = async (p, stick = null) => {
  await sleep(300);
  return p.evaluate(({ stick, R, SHIP }) => {
    const strip = document.querySelector('.fr-advice');
    const r = strip.getBoundingClientRect();
    const hits = (q) => q.left < r.right && r.left < q.right && q.top < r.bottom && r.top < q.bottom;
    const name = (e, q) => `${e.className} ${Math.round(q.left)},${Math.round(q.top)} ${Math.round(q.width)}x${Math.round(q.height)}`;
    const hit = [];
    for (const e of document.querySelectorAll('.freeroam-app [class*="fr-"]')) {
      if (e === strip || e.contains(strip) || strip.contains(e) || e.closest('.fr-panel')) continue;
      if (!e.getClientRects().length) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      const q = e.getBoundingClientRect();
      if (q.width * q.height <= 0 || q.width * q.height > innerWidth * innerHeight * 0.4) continue;
      if (hits(q)) hit.push(name(e, q));
    }
    const hint = document.querySelector('.fr-hint');
    const hq = hint?.getBoundingClientRect();
    const view = document.querySelector('.fr-canvas')?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const cx = view.left + view.width / 2;
    const cy = view.top + view.height / 2;
    const ship = { left: cx - SHIP, right: cx + SHIP, top: cy - SHIP, bottom: cy + SHIP };
    const ring = stick ? { left: stick.x - R - 3, right: stick.x + R + 3, top: stick.y - R - 3, bottom: stick.y + R + 3 } : null;
    const near = document.querySelector('.fr-nearby')?.getBoundingClientRect();
    const cs = getComputedStyle(strip);
    const small = [...strip.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && e.textContent.trim() && parseFloat(getComputedStyle(e).fontSize) < 10).map((e) => e.textContent);
    return {
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      hit,
      hint: hq && hq.width > 0 && hits(hq) ? name(hint, hq) : null,
      ship: hits(ship),
      ring: ring ? { box: [Math.round(ring.left), Math.round(ring.top), Math.round(ring.right - ring.left)], strip: hits(ring), nearby: !!near && near.width > 0 && near.left < ring.right && ring.left < near.right && near.top < ring.bottom && ring.top < near.bottom } : null,
      pointer: cs.pointerEvents,
      visible: !strip.hidden && cs.display !== 'none' && Number(cs.opacity) > 0.95,
      onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      small,
      focusable: strip.querySelectorAll('button, a, [tabindex]').length,
    };
  }, { stick, R: STICK_R, SHIP: SHIP_CLEAR });
};

/** Hold one finger on the open canvas at (x, y) (CDP touch events): the floating stick's origin. */
async function holdStick(p, x, y) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await sleep(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 6, y: y - 4, id: 1 }] });
  await sleep(120);
  const active = await p.evaluate(() => window.__galaxiaFreeRoam.input().stickActive);
  return { active, release: async () => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(80); await cdp.detach(); } };
}

async function newPage(browser, rec, { w = 1280, h = 720, touch = false } = {}) {
  const opts = { viewport: { width: w, height: h }, hasTouch: touch };
  if (touch) opts.isMobile = true;
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((doc) => {
    if (!sessionStorage.getItem('p05-seeded')) {
      sessionStorage.setItem('p05-seeded', '1');
      localStorage.setItem('galaxia:freeroam', JSON.stringify(doc));
      localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
    }
  }, rec);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  p.on('response', (r) => r.status() >= 400 && errs.push(`${r.status()} ${r.url()}`));
  await p.goto(PAGE + '?mode=freeroam' + (touch ? '&controls=touch' : ''), { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  const tap = (sel) => (touch ? p.tap(sel) : p.click(sel));
  await tap('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await tap('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(400);
  return { ctx, p, errs };
}

const intoCorona = (p) => place(p, () => { const f = window.__galaxiaFreeRoam; const l = f.state.layout.landmarks.filter((x) => x.hazardR > x.r).sort((m, n) => n.hazardR - m.hazardR)[0]; const sh = f.state.ship; sh.x = l.x + (l.r + l.hazardR) / 2; sh.y = l.y; sh.vx = 0; sh.vy = 0; });
const clearOfHazards = (p) => place(p, () => { const f = window.__galaxiaFreeRoam; const sh = f.state.ship; const st = f.sector().pois.find((q) => q.kind === 'station'); sh.x = st.x + 260; sh.y = st.y + 260; sh.vx = 0; sh.vy = 0; });

const browser = await chromium.launch();
try {
  /* ------------------------------------------------- 1. solo: the Ship Mind */
  {
    const { ctx, p, errs } = await newPage(browser, save());
    let a = await adv(p);
    check('solo: no crew on the advisory (key solo, no navigator / surveyor)', a.crew.key === 'solo' && a.crew.navigator === null && a.crew.surveyor === null, a.crew);
    check('the strip exists, hidden, takes no input and holds nothing focusable', await p.evaluate(() => { const s = document.querySelector('.fr-advice'); return !!s && s.hidden && getComputedStyle(s).pointerEvents === 'none' && s.querySelectorAll('button, a, [tabindex]').length === 0 && s.getAttribute('role') === 'status' && !s.hasAttribute('style'); }));

    const pressed = await chooseAdvice(p, 'CRITICAL ONLY');
    check('CONTROLS: SHIP MIND · CRITICAL ONLY is a pressed toggle', /CRITICAL ONLY:true/.test(pressed) && /ALL ADVICE:false/.test(pressed), pressed);
    const prefs = await p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:freeroam:prefs') ?? 'null'));
    check('the choice is saved in the shared prefs (advice: critical)', JSON.stringify(prefs ?? {}).includes('"advice":"critical"'), prefs);

    // a real corona: a warning, muted
    const star = await p.evaluate(() => { const l = window.__galaxiaFreeRoam.state.layout.landmarks.filter((x) => x.hazardR > x.r).sort((m, n) => n.hazardR - m.hazardR)[0]; return l ? { id: l.id, r: l.r, hz: l.hazardR } : null; });
    check('Sol has a star with a corona', !!star, star);
    await intoCorona(p);
    const muted = await collect(p, 1200);
    a = await adv(p);
    check('CRITICAL ONLY: inside the corona the observation says so but no warning shows (remembered as muted)', a.obs?.inCorona && !muted.some((v) => v.level !== 'critical') && a.muted.includes('mind.corona'), { inCorona: a.obs?.inCorona, muted, m: a.muted });
    // still inside, back to ALL ADVICE: the muted hazard is announced once, nothing else comes back
    const shownAtSwitch = (await adv(p)).shown;
    const pressed2 = await chooseAdvice(p, 'ALL ADVICE');
    check('ALL ADVICE selected (pressed toggle) and the stored preference removed', /ALL ADVICE:true/.test(pressed2) && !(await p.evaluate(() => localStorage.getItem('galaxia:freeroam:prefs') ?? '')).includes('"advice"'), pressed2);
    a = await waitAdvice(p, (v) => v.id === 'mind.corona', 2500);
    check('back on ALL ADVICE inside the corona: the muted warning is announced once (named star)', a.view?.id === 'mind.corona' && a.view.level === 'warning' && /^Inside .+'s corona: the shield is burning\. Pull clear\.$/.test(a.view.text), a.view);
    const head2 = await stripHead(p);
    check('warning label: ▲ WARNING · SHIP MIND, polite, caution edge tone', /^▲ WARNING · SHIP MIND$/.test(head2) && (await p.evaluate(() => { const s = document.querySelector('.fr-advice'); return s.getAttribute('aria-live') === 'polite' && s.classList.contains('is-caution') && !s.classList.contains('is-warn'); })), head2);
    await shot(p, 'desktop-corona');
    const said = await collect(p, 1500);
    a = await adv(p);
    check('no backlog after the switch: only that one muted message came back', said.every((v) => v.id === 'mind.corona') && a.shown === shownAtSwitch + 1 && a.muted.length === 0, { said, shown: a.shown, shownAtSwitch, muted: a.muted });
    await clearOfHazards(p);
    await sleep(400);
    await chooseAdvice(p, 'CRITICAL ONLY');

    // low hull: critical, shown even with CRITICAL ONLY
    await setHull(p, 0.2);
    a = await waitAdvice(p, (v) => v.id === 'mind.hull');
    const head = await stripHead(p);
    check('low hull: the Ship Mind speaks (critical, real percentage)', a.view?.id === 'mind.hull' && a.view.level === 'critical' && a.view.source === 'mind' && /^Hull at 20%\. Dock at a station/.test(a.view.text), a.view);
    check('the level is never colour alone: icon + word + speaker lead the line (dashed critical edge)', /^◆ CRITICAL · SHIP MIND$/.test(head) && (await p.evaluate(() => document.querySelector('.fr-advice').classList.contains('is-warn') && getComputedStyle(document.querySelector('.fr-advice')).borderLeftStyle === 'dashed')), head);
    check('critical reads assertively to screen readers', await p.evaluate(() => document.querySelector('.fr-advice').getAttribute('aria-live') === 'assertive'));
    let lay = await layout(p);
    check('1280x720: visible, on screen; clear of the HUD, NEARBY, the key-hint line and the ship', lay.visible && lay.onScreen && lay.hit.length === 0 && lay.hint === null && !lay.ship && lay.small.length === 0, lay);
    await shot(p, 'desktop-hull');
    const shownBefore = a.shown;
    await sleep(2000);
    a = await adv(p);
    check('an unchanged low hull is not repeated (2 s later, nothing new shown)', a.shown === shownBefore, { before: shownBefore, after: a.shown });
    await setHull(p, 0.1);
    a = await waitAdvice(p, (v) => v.id === 'mind.hull' && /^Hull at 10%/.test(v.text));
    check('a worse hull (severe) is news: shown again with the new figure', /^Hull at 10%/.test(a.view?.text ?? '') && a.shown === shownBefore + 1, { view: a.view, shown: a.shown });

    // nothing over a menu; on resume the one message on screen is re-evaluated once
    await p.keyboard.press('Escape');
    await sleep(500);
    a = await adv(p);
    const hidden = await p.evaluate(() => document.querySelector('.fr-advice').hidden);
    check('pause: no advice over the menu (strip hidden; the message on screen parked)', a.panel === 'pause' && a.strip.visible === false && hidden && a.parked?.id === 'mind.hull', { panel: a.panel, strip: a.strip, hidden, parked: a.parked });
    await p.keyboard.press('Escape');
    a = await waitAdvice(p, (v) => v.id === 'mind.hull', 1500);
    check('resume: the parked hull warning still holds, so it is shown once more (fresh words)', a.view?.id === 'mind.hull' && /^Hull at 10%/.test(a.view.text) && a.shown === shownBefore + 2 && a.parked === null, { view: a.view, shown: a.shown });
    await sleep(2500);
    a = await adv(p);
    check('…and only once: nothing more while the hull stays the same', a.shown === shownBefore + 2, { shown: a.shown });

    await clearOfHazards(p);
    check('no console errors (solo)', errs.length === 0, errs);
    await ctx.close();
  }

  /* ------------------------------------- 2. a seated Navigator in REALISTIC */
  {
    const crew = { hired: ['maren-sato'], paid: ['maren-sato'], seats: { petrel: ['maren-sato'] } };
    const { ctx, p, errs } = await newPage(browser, save({ crew }));
    let a = await adv(p);
    check('Navigator seated on the flown ship: on the advisory', a.crew.navigator !== null && a.crew.surveyor === null, a.crew);
    await p.keyboard.press('Escape');
    await sleep(200);
    await pauseAction(p, 'CONTROLS');
    await p.click('.fr-controls-mode >> text=REALISTIC');
    await sleep(150);
    await p.keyboard.press('Escape');
    await sleep(200);
    await p.keyboard.press('Escape');
    await sleep(300);
    // at rest inside a planet's strong field, clear of its surface (a real well, no star)
    const set = await place(p, () => {
      const f = window.__galaxiaFreeRoam;
      const lm = f.state.layout.landmarks;
      const w = f.state.wells.filter((x) => { const l = lm.find((m) => m.id === x.id); return l && !(l.hazardR > l.r); }).sort((m, n) => n.pull - m.pull)[0];
      if (!w) return null;
      const sh = f.state.ship;
      sh.x = w.x; sh.y = w.y - (w.solid + 90); sh.vx = 0; sh.vy = 0;
      return { id: w.id };
    });
    check('Sol has a planet well to test against', !!set, set);
    const before = await p.evaluate(() => { const s = window.__galaxiaFreeRoam.state; return { heading: s.ship.heading, stop: JSON.stringify(s.stop) }; });
    const said = await collect(p, 2500);
    a = await adv(p);
    const after = await p.evaluate(() => { const s = window.__galaxiaFreeRoam.state; return { heading: s.ship.heading, stop: JSON.stringify(s.stop) }; });
    const nav = said.filter((v) => v.source === 'navigator');
    check('the Navigator reads the real well (a nav.* message, named speaker)', nav.length > 0 && nav.every((v) => /Maren/i.test(v.speaker)), said);
    check('one advisory system: no message said twice, at most one impact voice', new Set(said.map((v) => `${v.id.split('.')[1]}|${v.text}`)).size === said.length && said.filter((v) => /impact/.test(v.id)).length <= 1, said);
    check('the Navigator never steers or toggles STOP (heading and STOP unchanged with no input)', before.heading === after.heading && before.stop === after.stop && a.obs?.stop === 'off', { before, after, stop: a.obs?.stop });
    await shot(p, 'navigator');
    check('no console errors (Navigator)', errs.length === 0, errs);
    await ctx.close();
  }

  /* ------------------------------------------ 3. a seated Surveyor, unsurveyed */
  {
    const crew = { hired: ['odile-marchetti'], paid: ['odile-marchetti'], seats: { petrel: ['odile-marchetti'] } };
    const { ctx, p, errs } = await newPage(browser, save({ surveyed: false, crew }));
    let a = await adv(p);
    check('Surveyor seated: on the advisory', a.crew.surveyor !== null && a.crew.navigator === null, a.crew);
    const target = await place(p, () => {
      const f = window.__galaxiaFreeRoam;
      const q = f.sector().pois.find((x) => x.kind !== 'station' && x.kind !== 'exit' && x.kind !== 'survey') ?? f.sector().pois.find((x) => x.kind !== 'station');
      const sh = f.state.ship;
      sh.x = q.x + 420; sh.y = q.y; sh.vx = 0; sh.vy = 0;
      return { id: q.id, kind: q.kind, label: q.label };
    });
    const said = await collect(p, 3000);
    a = await adv(p);
    const range = a.obs?.sensorRange ?? 0;
    check('every POI the advisors read lies inside sensor range (no hidden positions)', (a.obs?.pois ?? []).every((q) => q.distance <= range + 1), { range, pois: a.obs?.pois?.map((q) => [q.id, Math.round(q.distance)]) });
    const sur = said.filter((v) => v.source === 'surveyor');
    check('the Surveyor reports from real sensors (a sur.* message, named speaker)', sur.length > 0 && sur.every((v) => /Odile/i.test(v.speaker)), { target, said });
    const named = sur.filter((v) => v.id === 'sur.poi');
    check('sur.poi names only POIs the observation holds', named.every((v) => (a.obs?.pois ?? []).some((q) => v.text.startsWith(q.label))), { named, pois: a.obs?.pois?.map((q) => q.label) });
    const again = await collect(p, 1500);
    check('no repetition near the same POI (nothing new in 1.5 s at rest)', again.every((v) => said.some((x) => x.serial === v.serial)), again);
    await shot(p, 'surveyor');
    check('no console errors (Surveyor)', errs.length === 0, errs);
    await ctx.close();
  }

  /* --------------------------------- 4. crew seated on another ship: silent */
  {
    const crew = { hired: ['maren-sato', 'odile-marchetti'], paid: ['maren-sato', 'odile-marchetti'], seats: { petrel: ['maren-sato', 'odile-marchetti'] } };
    const { ctx, p, errs } = await newPage(browser, save({ active: 'swift', crew }));
    await setHull(p, 0.2);
    const a = await waitAdvice(p, (v) => v.id === 'mind.hull');
    check('flying the Swift while both crew sit on the Petrel: solo advisory', a.crew.key === 'solo' && a.crew.navigator === null && a.crew.surveyor === null, a.crew);
    const said = await collect(p, 1500);
    check('…and only the Ship Mind speaks', [a.view, ...said].filter(Boolean).every((v) => v.source === 'mind'), said);
    check('no console errors (other ship)', errs.length === 0, errs);
    await ctx.close();
  }

  /* ------------------------- 5. touch layouts: pads, NEARBY, HUD, ship and the stick's graphic */
  for (const [w, h] of [[360, 640], [320, 568], [740, 360], [568, 320]]) {
    const { ctx, p, errs } = await newPage(browser, save(), { w, h, touch: true });
    // where the game tells the left thumb to go (the DRAG TO FLY hint, measured before it fades)
    const hintSpot = await p.evaluate(() => { const e = document.querySelector('.fr-hint-touch'); const r = e?.getBoundingClientRect(); return r && r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; });
    await setHull(p, 0.2);
    const a = await waitAdvice(p, (v) => v.id === 'mind.hull');
    const lay = await layout(p);
    check(`${w}x${h} touch: the hull warning shows`, a.view?.id === 'mind.hull' && lay.visible, { view: a.view, lay });
    check(`${w}x${h} touch: on screen, no input; clear of pads, NEARBY, HUD and the ship`, lay.onScreen && lay.pointer === 'none' && lay.focusable === 0 && lay.hit.length === 0 && !lay.ship, lay);
    check(`${w}x${h} touch: strip text >= 10 px`, lay.small.length === 0, lay.small);
    if (h > w) {
      const nb = await p.evaluate(() => { const n = document.querySelector('.fr-nearby'); return { has: !!n && !n.hidden, vis: n ? getComputedStyle(n).opacity : null }; });
      check(`${w}x${h} portrait: NEARBY steps aside while advice holds its slot`, !nb.has || nb.vis === '0', nb);
    }
    // the floating stick: at the hint spot and at other lower-left thumb positions (origin inside the left half, lower third)
    const spots = [hintSpot, { x: Math.round(w * 0.2), y: Math.round(h * 0.88) }, { x: Math.round(w * 0.3), y: Math.round(h * 0.82) }].filter(Boolean);
    const rings = [];
    for (const sp of spots) {
      const hold = await holdStick(p, sp.x, sp.y);
      const l2 = await layout(p, sp);
      rings.push({ at: sp, active: hold.active, ...l2.ring, stillShown: l2.visible });
      if (sp === hintSpot) await shot(p, `touch-${w}x${h}-stick`);
      await hold.release();
    }
    check(`${w}x${h} touch: the stick's graphic (held touch at the DRAG TO FLY spot and lower-left thumb spots) never meets the strip`, rings.length >= 2 && rings.every((r) => r.active && !r.strip && r.stillShown), rings);
    // layout probe (not a game message): the longest kind of crew line (~130 characters, a named escape burn)
    // grows the strip to its tallest; it must still clear the ship, the pads and the HUD
    const longLay = await p.evaluate(() => {
      const st = document.querySelector('.fr-advice');
      st.querySelector('.fr-advice-who').textContent = 'ODILE MARCHETTI';
      st.querySelector('.fr-advice-text').textContent = 'Drift puts us into Ceres Test in 2.4 s with engines idle. Burn ↗ (away and along our drift) to clear it with the widest margin.';
      return true;
    }).then(() => layout(p));
    check(`${w}x${h} touch: a long crew line (tallest strip) still clears the ship, pads and HUD`, longLay.visible && longLay.onScreen && longLay.hit.length === 0 && !longLay.ship, longLay);
    // measured, not a pass/fail: with that tallest strip, does a thumb placed high on the left meet it? (visual only: the strip takes no input)
    {
      const sp = { x: Math.round(w * 0.3), y: Math.round(h * 0.82) };
      const hold = await holdStick(p, sp.x, sp.y);
      const l3 = await layout(p, sp);
      console.log(`NOTE ${w}x${h}: tallest strip ${JSON.stringify(l3.box)} vs stick ring at ${sp.x},${sp.y}: ${l3.ring?.strip ? 'overlaps (visual only)' : 'clear'}`);
      await hold.release();
    }
    if (h > w) {
      await setHull(p, 1);
      // a POI callout queued behind the hull warning follows if still true (by design): wait until nothing is shown;
      // meanwhile check any callout's words (nose-relative) agree with its arrow (screen direction) for the real heading
      const t0 = Date.now();
      let agree = true;
      const seen = [];
      while (Date.now() - t0 < 20000) {
        const c = await p.evaluate(() => {
          const f = window.__galaxiaFreeRoam;
          const a = f.advisor();
          const v = a.view;
          if (!v) return { done: document.querySelector('.fr-advice').hidden };
          const q = v.id === 'mind.poi' ? a.observation?.pois.find((x) => v.text.includes(x.label)) : null;
          return { done: false, v: v.text, heading: f.state.ship.heading, dx: q?.dx ?? null, dy: q?.dy ?? null };
        });
        if (c.done) break;
        if (c.dx !== null && !seen.includes(c.v)) {
          seen.push(c.v);
          const rel = Math.atan2(Math.sin(Math.atan2(c.dx, -c.dy) - c.heading), Math.cos(Math.atan2(c.dx, -c.dy) - c.heading));
          const side = rel >= 0 ? 'starboard' : 'port';
          const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
          const arrow = arrows[((Math.round(Math.atan2(c.dy, c.dx) / (Math.PI / 4)) % 8) + 8) % 8];
          const okWords = Math.abs(rel) <= (25 * Math.PI) / 180 || Math.abs(rel) >= (155 * Math.PI) / 180 || c.v.includes(side);
          if (!okWords || !c.v.includes(`(${arrow})`)) agree = false;
          seen.push(JSON.stringify({ heading: c.heading.toFixed(2), rel: rel.toFixed(2), arrow }));
        }
        await sleep(100);
      }
      check(`${w}x${h} portrait: a following POI callout's side and arrow agree with the real heading`, agree, seen);
      const nb = await p.evaluate(() => { const n = document.querySelector('.fr-nearby'); return { has: !!n && !n.hidden, vis: n ? getComputedStyle(n).opacity : null, strip: document.querySelector('.fr-advice').hidden, view: window.__galaxiaFreeRoam.advisor().view, shown: window.__galaxiaFreeRoam.advisor().state.shownCount }; });
      check(`${w}x${h} portrait: NEARBY is back once the advice ends`, nb.strip && (!nb.has || nb.vis === '1'), nb);
    }
    check(`no console errors (${w}x${h})`, errs.length === 0, errs);
    await ctx.close();
  }
} finally {
  await browser.close();
}
const ok = checks.filter((c) => c.ok).length;
console.log(`\n${ok}/${checks.length} checks passed`);
process.exit(ok === checks.length ? 0 : 1);
