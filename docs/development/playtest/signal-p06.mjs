// P06.1 + P06.2: signal triangulation in a real browser (QA build: needs the test hooks).
// The hooks only place the ship (as a pilot would fly it); every bearing goes through the real INTERACT
// key, the real 60 Hz sim and the game's notice feed. Checks: the prompt reads TAKE BEARING on an
// unresolved anomaly; INTERACT + holding still records a bearing; a second bearing from a wider angle
// (or the fifth) resolves the source; the marker moves to the fix; INVESTIGATE there pays once; Simple
// Signals (prefs record) resolves with one bearing; no page errors.
// P06.2: the prompt's HOLD STEADY nn% progress, the FAINT SIGNAL / BEARING n RECORDED notices (one line per
// press, however often it is pressed), the drawn bearing line (anomaly-coloured canvas pixels grow), the
// CONTROLS > SIGNALS toggle (keyboard, aria-pressed, saved, applied at once, kept after reload), and the
// prompt and notices clear of FIRE / BOOST / weapon / LOCK / STOP / HUD buttons and the stick at 1280x720,
// 1920x1080, 320x568 and 390x844 (touch layout on the phones).
// Usage: node signal-p06.mjs [pageUrl]
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SOL = 'milky-way/sol';
const SYS = 'milky-way/sirius';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};

const save = () => ({
  version: 10, createdAt: 1, sessions: 3, flightSeconds: 900, beaconsCharted: 3, surveysCompleted: 1, bestSurveyTicks: 5000,
  currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL, SYS], galaxySurveys: { 'milky-way': 1 },
  currentSystem: SYS, visitedSystems: [SOL, SYS],
  sectors: { [SOL]: { done: [], surveyed: true }, [SYS]: { done: [], surveyed: true } },
  cargo: { scrap: 4, fuel: 6 },
  fleet: { active: 'petrel', owned: ['petrel'], loadouts: {} },
  lostCargo: null, modules: {}, milestones: [],
  progression: { marks: 100, missions: { active: [], completed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], claimed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
  savedAt: 1, resume: null,
});

async function newPage(browser, simple, { w = 1280, h = 720, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
  await ctx.addInitScript(([doc, simple]) => {
    if (!sessionStorage.getItem('p06-seeded')) {
      sessionStorage.setItem('p06-seeded', '1');
      localStorage.setItem('galaxia:freeroam', JSON.stringify(doc));
      localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
      if (simple) localStorage.setItem('galaxia:freeroam:prefs', JSON.stringify({ version: 1, controls: { mouseAim: false, zoom: 1, flightMode: 'normal', simpleSignals: true } }));
    }
  }, [save(), simple]);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  p.on('response', (r) => r.status() >= 400 && errs.push(`${r.status()} ${r.url()}`));
  await p.goto(PAGE + '?mode=freeroam' + (touch ? '&controls=touch' : ''), { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(400);
  return { ctx, p, errs };
}

/** Park the ship at `deg` around the anomaly marker, `d` px out, at rest. */
const park = (p, deg, d) => p.evaluate(([deg, d]) => {
  const f = window.__galaxiaFreeRoam;
  const a = f.state.layout.pois.find((q) => q.kind === 'anomaly');
  const sh = f.state.ship;
  sh.x = a.x + Math.cos((deg * Math.PI) / 180) * d;
  sh.y = a.y + Math.sin((deg * Math.PI) / 180) * d;
  sh.px = sh.x; sh.py = sh.y; sh.vx = 0; sh.vy = 0;
}, [deg, d]);
const track = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  const a = f.state.layout.pois.find((q) => q.kind === 'anomaly');
  const t = f.state.signal.tracks.get(a.id);
  return { id: a.id, bearings: t ? t.bearings.length : -1, fix: t?.fix ?? null, refusal: t?.refusal ?? null, done: f.state.done.has(a.id), prompt: document.querySelector('.fr-interact')?.textContent ?? '', focus: f.state.focus };
});
const text = (p) => p.evaluate(() => document.body.innerText);
/** Canvas pixels in the anomaly colour (#e46bff, blended): the marker, its ring and the bearing lines. */
const violet = (p) => p.evaluate(() => {
  const c = document.querySelector('canvas.fr-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 90 && d[i + 2] > 110 && d[i + 2] - d[i + 1] > 60 && d[i] - d[i + 1] > 30) n++;
  return n;
});
async function pauseAction(p, label) {
  const head = '#fr-pause-settings';
  await p.waitForSelector(head);
  if ((await p.getAttribute(head, 'aria-expanded')) !== 'true') { await p.click(head); await sleep(400); }
  await p.click(`.fr-panel-pause .fr-pause-item:text-is("${label}")`);
  await sleep(150);
}
const signalButtons = (p) => p.evaluate(() => [...document.querySelectorAll('.fr-controls-signals button')].map((b) => `${b.textContent}:${b.getAttribute('aria-pressed')}`).join());
const prefs = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:freeroam:prefs') ?? 'null'));
/** The INTERACT prompt and the notice feed against the flight controls (and an optional stick ring). */
const promptLayout = (p, stick = null) => p.evaluate(({ stick }) => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; };
  const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const shown = (e) => e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && Number(getComputedStyle(e).opacity) > 0;
  const prompt = document.querySelector('.fr-interact');
  const feed = [...document.querySelectorAll('.fr-feed > *')].filter(shown);
  const ctl = ['.fr-fire', '.fr-boost', '.fr-wpn', '.fr-lock', '.fr-target', '.fr-stop', '.fr-hud-buttons'].flatMap((q) => [...document.querySelectorAll(q)]).filter(shown);
  const P = shown(prompt) ? box(prompt) : null;
  const hit = [];
  for (const c of ctl) {
    const q = box(c);
    if (P && meet(P, q)) hit.push(`prompt×${c.className}`);
    for (const f of feed) if (meet(box(f), q)) hit.push(`feed×${c.className}`);
  }
  const ring = stick ? { left: stick.x - 59, right: stick.x + 59, top: stick.y - 59, bottom: stick.y + 59 } : null;
  const small = [prompt, ...feed].filter((e) => e && shown(e) && parseFloat(getComputedStyle(e).fontSize) < 10).map((e) => e.textContent);
  return {
    prompt: P ? [Math.round(P.left), Math.round(P.top), Math.round(P.w), Math.round(P.h)] : null,
    text: prompt?.textContent ?? '',
    controls: ctl.map((c) => c.className.split(' ')[0]),
    hit,
    onScreen: !!P && P.left >= 0 && P.top >= 0 && P.right <= innerWidth && P.bottom <= innerHeight,
    ring: ring && P ? meet(P, ring) : null,
    tall: P ? P.h : 0,
    small,
  };
}, { stick });
/** INTERACT (E), then keep the ship parked for ~1.3 s (gravity drift is undone as a pilot would hold position). */
async function takeBearing(p, deg, d) {
  await park(p, deg, d);
  await sleep(120);
  await p.keyboard.press('KeyE');
  for (let i = 0; i < 26; i++) { await park(p, deg, d); await sleep(50); }
  return track(p);
}

const browser = await chromium.launch();
try {
  /* ----------------------------------------------------- 1. two-angle fix */
  {
    const { ctx, p, errs } = await newPage(browser, false);
    let t = await track(p);
    check('the sector has an unresolved signal target (faint)', t.bearings === 0 && t.fix === null && !t.done, t);
    await park(p, 0, 300);
    await sleep(200);
    t = await track(p);
    check('INTERACT prompt on an unresolved anomaly reads TAKE BEARING', /^TAKE BEARING · /.test(t.prompt) && t.focus === t.id, t);
    const violet0 = await violet(p);
    // P06.2: the hold, step by step: the prompt counts sim-tick progress; the feed says FAINT SIGNAL once
    await p.keyboard.press('KeyE');
    for (let i = 0; i < 8; i++) { await park(p, 0, 300); await sleep(50); }
    const mid = await track(p);
    check('P06.2: during the hold the prompt reads HOLD STEADY nn% (sim-tick progress)', /^HOLD STEADY \d{1,2}0?% · /.test(mid.prompt), mid);
    check('P06.2: the feed names the faint signal and asks to hold steady', /FAINT SIGNAL · .+ · HOLD STEADY/.test(await text(p)));
    for (let i = 0; i < 20; i++) { await park(p, 0, 300); await sleep(50); }
    t = await track(p);
    check('INTERACT + holding still records exactly one bearing', t.bearings === 1 && t.fix === null, t);
    check('the notice feed reports it (BEARING 1 RECORDED · ±…° · NEXT FROM A NEW ANGLE)', /BEARING 1 RECORDED · ±\d\.\d°.* · NEXT FROM A NEW ANGLE/.test(await text(p)));
    check('P06.2: the prompt numbers the next bearing (TAKE BEARING 2)', /^TAKE BEARING 2 · /.test(t.prompt), t);
    await sleep(100);
    const violet1 = await violet(p);
    check('P06.2: the recorded bearing line is drawn (anomaly-coloured canvas pixels grow)', violet1 > violet0 + 150, { violet0, violet1 });
    await p.screenshot({ path: '/tmp/p06-bearing1.png' });
    const again = await takeBearing(p, 0, 300);
    check('a second press from the same spot is refused (no duplicate)', again.bearings === 1 && again.refusal === 'samePlace', again);
    // a burst of presses (well inside the 1.5 s sim-time repeat window) adds at most one line
    const same = () => p.evaluate(() => [...document.querySelectorAll('.fr-feed > *')].filter((e) => /SAME SPOT · MOVE TO A NEW POSITION/.test(e.textContent)).length);
    const before = await same();
    for (let i = 0; i < 6; i++) { await p.keyboard.press('KeyE'); await sleep(50); }
    const after = await same();
    check('P06.2: six quick presses from the same spot add at most one SAME SPOT line', before >= 1 && after - before <= 1, { before, after });
    for (const deg of [70, 140, 210, 280]) {
      t = await takeBearing(p, deg, 300);
      if (t.fix) break;
    }
    check('a wider second angle (or the fifth bearing) resolves the source', t.fix !== null && t.bearings <= 5, t);
    check('the feed says SOURCE RESOLVED', /SOURCE RESOLVED · INVESTIGATE THERE/.test(await text(p)));
    await sleep(150);
    await p.screenshot({ path: '/tmp/p06-resolved.png' });
    await p.evaluate(() => { const f = window.__galaxiaFreeRoam; const a = f.state.layout.pois.find((q) => q.kind === 'anomaly'); const fx = f.state.signal.tracks.get(a.id).fix; const sh = f.state.ship; sh.x = fx.x; sh.y = fx.y; sh.px = fx.x; sh.py = fx.y; sh.vx = 0; sh.vy = 0; });
    await sleep(250);
    t = await track(p);
    check('at the fix the prompt is the existing INVESTIGATE', /^INVESTIGATE · /.test(t.prompt), t);
    await p.screenshot({ path: '/tmp/p06-at-fix.png' });
    const marks0 = await p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:freeroam') ?? '{}').progression?.marks ?? null);
    await p.keyboard.press('KeyE');
    await sleep(400);
    t = await track(p);
    check('INVESTIGATE completes the anomaly (done)', t.done, t);
    await p.keyboard.press('KeyE');
    await sleep(300);
    const doc = await p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:freeroam') ?? '{}'));
    check('the completion is saved once (sector done list)', (doc.sectors?.[SYS]?.done ?? []).filter((x) => x === t.id).length === 1, doc.sectors?.[SYS]);
    check('no signal state in the save', !JSON.stringify(doc).includes('bearings'), {});
    console.log('marks before/after investigate:', marks0, doc.progression?.marks);
    check('no page errors', errs.length === 0, errs);
    await ctx.close();
  }
  /* ----------------------------------------------------- 2. Simple Signals */
  {
    const { ctx, p, errs } = await newPage(browser, true);
    const t = await takeBearing(p, 0, 300);
    check('Simple Signals (prefs record): one bearing resolves', t.bearings === 1 && t.fix?.how === 'simple', t);
    check('no page errors (Simple Signals)', errs.length === 0, errs);
    await ctx.close();
  }
  /* ----------------------------------------------------- 3. P06.2 CONTROLS > SIGNALS */
  {
    const { ctx, p, errs } = await newPage(browser, false);
    await p.keyboard.press('Escape');
    await sleep(200);
    await pauseAction(p, 'CONTROLS');
    check('CONTROLS: SIGNALS shows STANDARD pressed by default (no prefs record)', (await signalButtons(p)) === 'STANDARD:false,SIMPLE:false'.replace('STANDARD:false', 'STANDARD:true'), await signalButtons(p));
    const lay = await p.evaluate(() => {
      const row = document.querySelector('.fr-controls-signals');
      const desc = row.nextElementSibling;
      const btns = [...row.querySelectorAll('button')];
      return { group: row.getAttribute('role'), label: row.getAttribute('aria-label'), afterAdvice: row.previousElementSibling?.previousElementSibling?.classList.contains('fr-controls-advice'), desc: desc?.textContent ?? '', min: Math.min(...btns.map((b) => b.getBoundingClientRect().height)), font: Math.min(...[row, desc, ...btns].map((e) => parseFloat(getComputedStyle(e).fontSize))) };
    });
    check('SIGNALS is a labelled group after SHIP MIND, with a short explanation', lay.group === 'group' && lay.label === 'Simple Signals' && lay.afterAdvice && /two angles at least 35°/.test(lay.desc), lay);
    // the CONTROLS panel's segmented rows (FLIGHT MODE, SHIP MIND) use 40 px buttons; SIGNALS matches them
    check('SIGNALS buttons are >= 40 px tall like the other CONTROLS rows; text >= 10 px', lay.min >= 39.5 && lay.font >= 10, lay);
    // keyboard: focus SIMPLE and press Enter
    await p.focus('.fr-controls-signals button:text-is("SIMPLE")');
    await p.keyboard.press('Enter');
    await sleep(150);
    const on = await signalButtons(p);
    const desc = await p.evaluate(() => document.querySelector('.fr-controls-signals').nextElementSibling.textContent);
    check('keyboard Enter on SIMPLE turns it on (aria-pressed) and the text explains the rules that still apply', on === 'STANDARD:false,SIMPLE:true' && /one valid bearing/.test(desc) && /under 60 speed/.test(desc), { on, desc });
    check('the choice is saved in the existing prefs record', (await prefs(p))?.controls?.simpleSignals === true, await prefs(p));
    await p.keyboard.press('Escape');
    await sleep(200);
    await p.keyboard.press('Escape');
    await sleep(400);
    const t = await takeBearing(p, 0, 300);
    check('applied at once: one bearing resolves (same flight, no reload)', t.bearings === 1 && t.fix?.how === 'simple', t);
    await p.reload({ waitUntil: 'load' });
    await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
    await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
    await p.click('.fr-panel-briefing >> text=START FLIGHT');
    await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
    await sleep(300);
    await p.keyboard.press('Escape');
    await sleep(200);
    await pauseAction(p, 'CONTROLS');
    check('kept after a reload (SIMPLE still pressed)', (await signalButtons(p)) === 'STANDARD:false,SIMPLE:true', await signalButtons(p));
    await p.click('.fr-controls-signals button:text-is("STANDARD")');
    await sleep(150);
    check('STANDARD turns it off again (saved: the key is dropped, i.e. the default)', (await signalButtons(p)) === 'STANDARD:true,SIMPLE:false' && (await prefs(p))?.controls?.simpleSignals === undefined && (await prefs(p))?.controls?.flightMode === 'normal', { b: await signalButtons(p), prefs: await prefs(p) });
    check('no page errors (SIGNALS setting)', errs.length === 0, errs);
    await ctx.close();
  }
  /* ----------------------------------------------------- 4. P06.2 layouts */
  for (const [w, h, touch] of [[1280, 720, false], [1920, 1080, false], [320, 568, true], [390, 844, true]]) {
    const { ctx, p, errs } = await newPage(browser, false, { w, h, touch });
    const tag = `${w}x${h}${touch ? ' touch' : ''}`;
    // where the game tells the left thumb to go (the DRAG TO FLY hint, measured before it fades)
    const hintSpot = touch ? await p.evaluate(() => { const e = document.querySelector('.fr-hint-touch'); const r = e?.getBoundingClientRect(); return r && r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; }) : null;
    await park(p, 0, 300);
    await sleep(200);
    if (touch) await p.tap('.fr-interact'); else await p.keyboard.press('KeyE');
    for (let i = 0; i < 10; i++) { await park(p, 0, 300); await sleep(50); }
    const lay = await promptLayout(p);
    check(`${tag}: HOLD STEADY prompt on screen, >= 10 px, clear of ${touch ? 'FIRE / BOOST / weapon / LOCK / HUD buttons' : 'the HUD buttons'}`, /^HOLD STEADY/.test(lay.text) && lay.onScreen && lay.hit.length === 0 && lay.small.length === 0 && (!touch || ['fr-fire', 'fr-boost', 'fr-wpn', 'fr-lock'].every((c) => lay.controls.includes(c))), lay);
    for (let i = 0; i < 20; i++) { await park(p, 0, 300); await sleep(50); }
    // a long notice: a too-narrow second bearing (20° round), then the feed with its longest kinds of line
    await park(p, 20, 300);
    await sleep(150);
    if (touch) await p.tap('.fr-interact'); else await p.keyboard.press('KeyE');
    for (let i = 0; i < 26; i++) { await park(p, 20, 300); await sleep(50); }
    const lay2 = await promptLayout(p);
    check(`${tag}: after a recorded bearing the notices and the TAKE BEARING 2 prompt stay clear of the controls`, /RECORDED/.test(await text(p)) && /^TAKE BEARING/.test(lay2.text) && lay2.hit.length === 0 && lay2.small.length === 0, lay2);
    await p.screenshot({ path: `/tmp/p06-${w}x${h}.png` });
    if (touch) {
      // the floating stick at the DRAG TO FLY spot: the prompt sits elsewhere
      const lay3 = await promptLayout(p, hintSpot);
      check(`${tag}: the stick's ring at the DRAG TO FLY spot does not meet the prompt`, !!hintSpot && lay3.ring === false, { hintSpot, lay3 });
      // measured, not pass/fail: a thumb lower in the corner (20 % across, 88 % down)
      const low = { x: Math.round(w * 0.2), y: Math.round(h * 0.88) };
      console.log(`NOTE ${tag}: prompt ${JSON.stringify(lay3.prompt)} vs a stick ring at ${low.x},${low.y}: ${(await promptLayout(p, low)).ring ? 'overlaps (the prompt layout is unchanged from P06.1)' : 'clear'}`);
    }
    check(`${tag}: no page errors`, errs.length === 0, errs);
    await ctx.close();
  }
} finally {
  await browser.close();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
