// P05.1: the hangar's BRIDGE (crew) in a real browser (QA build: needs the test hooks).
// Loads a v10 save without crew, docks at Sol, opens HANGAR > BRIDGE and checks: an old
// save loads with no crew and opening the Bridge writes nothing; the summary and the
// solo / not-active notes; recruits (here, elsewhere, locked with the real requirement);
// a refused paid hire (shortfall) and a confirmed one (two presses, ledger kind crew,
// balance never negative); free story / rescue hires; assignment up to capacity and the
// refusal reason when full (keyboard); unassign; dismiss (two presses); switching to a
// smaller ship keeps everyone; persistence across a reload; slot 2 untouched; LAUNCH
// still flies; and the 360x640 touch layout (no sideways scroll, 44 px targets, text >= 10 px).
//
// Usage: node crew-bridge-p05.mjs [pageUrl] [screenshotDir]
// Run from a folder where `playwright` resolves (e.g. /tmp/pw).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SHOTS = process.argv[3] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const SOL = 'milky-way/sol';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};

/** A v10 save from before P05.1 (no crew field): three story missions done, one distress beacon cleared, Petrel + Swift owned, 100 marks. */
const PILOT = {
  version: 10, createdAt: 1, sessions: 3, flightSeconds: 900, beaconsCharted: 3, surveysCompleted: 1, bestSurveyTicks: 5000,
  currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL], galaxySurveys: { 'milky-way': 1 },
  currentSystem: SOL, visitedSystems: [SOL, 'milky-way/alpha-centauri'],
  sectors: { [SOL]: { done: [], surveyed: true }, 'milky-way/alpha-centauri': { done: ['defence-1'], surveyed: false } },
  cargo: { scrap: 4, fuel: 6 },
  fleet: { active: 'petrel', owned: ['petrel', 'swift'], loadouts: {} },
  lostCargo: null, modules: {}, milestones: [],
  progression: { marks: 100, missions: { active: [], completed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], claimed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
  savedAt: 1, resume: null,
};

const st = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  if (!f) return null;
  return { screen: f.screen(), panel: f.panel(), phase: f.state.phase, sector: f.sector(), fleet: f.fleet(), hangar: f.panel() === 'hangar' ? f.hangar() : null, crew: f.crew(), marks: f.progression().marks, ledger: f.progression().ledger };
}).catch(() => null);
const waitFor = async (p, pred, ms = 8000) => {
  const t0 = Date.now();
  let s = await st(p);
  while (!(s && pred(s)) && Date.now() - t0 < ms) {
    await sleep(40);
    s = await st(p);
  }
  return s;
};
const frames = (p, n = 3) => p.evaluate((k) => new Promise((r) => { const step = () => (k-- <= 0 ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); }), n);
const key = async (p, k) => { await p.keyboard.press(k); await frames(p, 2); await sleep(80); };
const shot = async (p, name) => { if (SHOTS) { await sleep(250); await p.screenshot({ path: join(SHOTS, `p05-${name}.png`), fullPage: false }); } };
const saved = (p, k = 'galaxia:freeroam') => p.evaluate((x) => JSON.parse(localStorage.getItem(x) ?? 'null'), k);
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel);
const btn = (id) => `.fr-bridge button[data-key="${id}"]`;
// force: a refused action is aria-disabled (still focusable and pressable on purpose); Playwright would otherwise wait for "enabled"
const press = async (p, id) => { await p.click(btn(id), { force: true }); await frames(p, 2); await sleep(60); };

async function newPage(browser, { w = 1280, h = 720, touch = false } = {}) {
  const opts = { viewport: { width: w, height: h }, hasTouch: touch };
  if (touch) opts.isMobile = true;
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((rec) => {
    if (!sessionStorage.getItem('p05-seeded')) {
      sessionStorage.setItem('p05-seeded', '1');
      localStorage.setItem('galaxia:freeroam', JSON.stringify(rec));
      localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
    }
  }, PILOT);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  p.on('response', (r) => r.status() >= 400 && errs.push(`${r.status()} ${r.url()}`));
  await p.goto(PAGE + '?mode=freeroam' + (touch ? '&controls=touch' : ''), { waitUntil: 'load' });
  await waitFor(p, (s) => s.screen === 'map');
  await sleep(300);
  return { ctx, p, errs };
}

async function dockAndOpenBridge(p, touch = false) {
  const tap = (sel) => (touch ? p.tap(sel) : p.click(sel));
  const s = await st(p);
  if (s.screen === 'map') {
    await tap('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
    await waitFor(p, (x) => x.panel === 'briefing');
    await tap('.fr-panel-briefing >> text=START FLIGHT');
    await waitFor(p, (x) => x.phase === 'flight' && x.panel === null);
  }
  await p.evaluate(() => { const f = window.__galaxiaFreeRoam; const stn = f.sector().pois.find((q) => q.kind === 'station'); const sh = f.state.ship; sh.x = stn.x; sh.y = stn.y + 70; sh.vx = 0; sh.vy = 0; });
  await waitFor(p, (x) => x.sector.focus === x.sector.pois.find((q) => q.kind === 'station').id, 4000);
  if (touch) await p.tap('.fr-interact');
  else await key(p, 'KeyE');
  await waitFor(p, (x) => x.panel === 'station');
  await tap('.fr-tab-hangar');
  await waitFor(p, (x) => x.panel === 'hangar');
  await tap('.fr-hangar-view-bridge');
  return waitFor(p, (x) => x.hangar?.view === 'bridge');
}

const browser = await chromium.launch();
try {
  /* ---------------------------------------------------------------- desktop */
  const { ctx, p, errs } = await newPage(browser);
  let s = await st(p);
  check('old save (no crew field) loads with an empty crew', s.crew.state.hired.length === 0 && s.crew.state.paid.length === 0 && Object.keys(s.crew.state.seats).length === 0 && s.crew.view.members.length === 0, s.crew);
  let sv = await saved(p);
  check('loading never adds a crew field to the save', sv && !('crew' in sv), Object.keys(sv ?? {}));

  s = await dockAndOpenBridge(p);
  check('HANGAR > BRIDGE opens the crew view of the ship flown', s.hangar?.view === 'bridge' && s.hangar.bridge?.ship === 'petrel', s.hangar);
  check('the Bridge view tab is a real selected tab', await p.evaluate(() => document.querySelector('.fr-hangar-view-bridge').getAttribute('aria-selected') === 'true' && document.querySelector('.fr-hangar-view-ship').getAttribute('aria-selected') === 'false'));
  sv = await saved(p);
  check('opening the Bridge writes no crew to the save', sv && !('crew' in sv));
  const summary = await text(p, '.fr-bridge-line');
  check('summary: ship, seats, occupied, unassigned', /PETREL\s·\s2 CREW SEATS\s·\s0 OCCUPIED\s·\s0 UNASSIGNED/.test(summary), summary);
  const notes = await text(p, '.fr-bridge-summary');
  // P05.2: crew advice is real now; the Bridge says it is advice only and names the unbuilt roles as planned
  check('solo play is stated as valid; crew duties as advice only, the rest planned', /Flying solo is fully supported/.test(notes) && /never steer, brake, fire, lock, pay or travel/.test(notes) && /Quartermaster duties are planned/.test(notes), notes);
  const contribution = await p.evaluate(() => document.body.innerText.match(/active now|is active|bonus active/i));
  check('nothing on the Bridge claims an ability is active', contribution === null, contribution);
  await shot(p, 'bridge-empty');

  const rec = Object.fromEntries(s.hangar.bridge.recruits.map((r) => [r.id, r]));
  check('Maren Sato (Sol) can sign on here; Odile waits at Morrow\'s Anchor', rec['maren-sato']?.state === 'here' && rec['odile-marchetti']?.state === 'elsewhere' && /Morrow’s Anchor|Morrow's Anchor/.test(rec['odile-marchetti'].reason), rec);
  check('Corin Vasht is locked behind the real story mission', rec['corin-vasht']?.state === 'locked' && /Quiet Lanes/.test(rec['corin-vasht'].reason), rec['corin-vasht']);
  check('story (Silent Hull) and rescue (distress beacon) recruits are offered free here', rec['tobiah-renn']?.state === 'here' && rec['tobiah-renn'].enabled && rec['brask-ottley']?.state === 'here' && rec['brask-ottley'].enabled);
  check('with 100 marks the 130-mark hire is refused with the shortfall', rec['maren-sato'] && !rec['maren-sato'].enabled && /30/.test(rec['maren-sato'].reason), rec['maren-sato']);
  await press(p, 'hire:maren-sato');
  s = await st(p);
  check('pressing a refused hire repeats the reason and charges nothing', /30/.test(s.hangar.bridge.message) && s.marks === 100 && s.crew.state.hired.length === 0, s.hangar.bridge);

  // paid hire, by keyboard: Enter arms, Enter confirms
  await p.evaluate(() => window.__galaxiaFreeRoam.qaMarks(300));
  await press(p, 'hire:tobiah-renn'); // free: one press
  s = await st(p);
  check('a free story recruit signs on with one press, joins the roster unassigned, no ledger entry', s.crew.state.hired.includes('tobiah-renn') && s.marks === 300 && Object.keys(s.crew.state.seats).length === 0, { hired: s.crew.state.hired, marks: s.marks });
  await p.focus(btn('hire:maren-sato'));
  await key(p, 'Enter');
  s = await st(p);
  check('first Enter arms the paid hire (balance unchanged)', s.hangar.bridge.pending === 'hire:maren-sato' && s.marks === 300 && /Press again/.test(s.hangar.bridge.message), s.hangar.bridge);
  const armedLabel = await text(p, btn('hire:maren-sato'));
  check('the armed button names the fee', /CONFIRM · PAY ◈ 130 MARKS/.test(armedLabel), armedLabel);
  await key(p, 'Enter');
  s = await st(p);
  const last = s.ledger?.history?.at(-1);
  check('second Enter signs Maren on and charges 130 once through the ledger (kind crew)', s.crew.state.hired.includes('maren-sato') && s.marks === 170 && last?.kind === 'crew' && last?.delta === -130, { marks: s.marks, last });
  check('the hangar wallet follows the hire at once', /◈ 170 MARKS/.test(await text(p, '.fr-panel-hangar .fr-wallet')));
  sv = await saved(p);
  check('the hire is saved (crew field written; fee marked paid)', sv?.crew?.hired?.includes('maren-sato') && sv.crew.paid.includes('maren-sato') && sv.progression.marks === 170, sv?.crew);
  await press(p, 'hire:brask-ottley');

  // seats
  await press(p, 'assign:maren-sato');
  await press(p, 'assign:tobiah-renn');
  s = await st(p);
  check('two crew take the Petrel\'s two seats', JSON.stringify(s.hangar.bridge.seats) === JSON.stringify(['maren-sato', 'tobiah-renn']), s.hangar.bridge.seats);
  check('the read-only view of the flown ship lists them (frozen)', s.crew.view.members.map((m) => m.id).join() === 'maren-sato,tobiah-renn', s.crew.view);
  check('the view object is frozen in the page', await p.evaluate(() => { const v = window.__galaxiaFreeRoam.crew().view; return Object.isFrozen(v) && Object.isFrozen(v.members) && Object.isFrozen(v.members[0]); }));
  const fullBtn = await p.evaluate((sel) => { const b = document.querySelector(sel); return b ? { aria: b.getAttribute('aria-disabled'), label: b.getAttribute('aria-label'), reason: b.parentElement.querySelector('.fr-bridge-reason')?.textContent } : null; }, btn('assign:brask-ottley'));
  check('a full ship refuses the third assignment and says why', fullBtn?.aria === 'true' && /All 2 seats on the Petrel are taken/.test(fullBtn.reason ?? ''), fullBtn);
  await p.focus(btn('assign:brask-ottley'));
  await key(p, 'Enter');
  s = await st(p);
  check('the refusal is focusable and repeated on Enter; nothing changes', /All 2 seats/.test(s.hangar.bridge.message) && !s.crew.state.seats.petrel.includes('brask-ottley'), s.hangar.bridge.message);
  await key(p, 'ArrowDown');
  const moved = await p.evaluate(() => document.activeElement?.dataset?.key ?? document.activeElement?.className);
  check('arrow keys move through the Bridge controls', !!moved && moved !== 'assign:brask-ottley', moved);
  await shot(p, 'bridge-full');

  await press(p, 'unassign:tobiah-renn');
  s = await st(p);
  check('unassign returns the member to the roster (still hired)', s.crew.state.hired.includes('tobiah-renn') && !(s.crew.state.seats.petrel ?? []).includes('tobiah-renn'), s.crew.state);
  await press(p, 'dismiss:brask-ottley');
  s = await st(p);
  check('dismiss arms first (two presses)', s.hangar.bridge.pending === 'dismiss:brask-ottley' && s.crew.state.hired.includes('brask-ottley'));
  await sleep(400);
  await press(p, 'dismiss:brask-ottley');
  s = await st(p);
  check('the second press ends the contract; the recruit is offered again', !s.crew.state.hired.includes('brask-ottley') && s.hangar.bridge.recruits.some((r) => r.id === 'brask-ottley' && r.enabled), s.hangar.bridge);

  // a smaller ship: inspect the Swift, select it, nobody is deleted
  await p.click('.fr-hangar-ship[data-ship="swift"]');
  await frames(p, 2);
  s = await st(p);
  check('inspecting the Swift shows its single seat and the Petrel crew as movable', /SWIFT\s·\s1 CREW SEAT\s·\s0 OCCUPIED/.test(s.hangar.bridge.summary) && s.hangar.bridge.roster.includes('maren-sato'), s.hangar.bridge);
  const moveLabel = await text(p, btn('assign:maren-sato'));
  check('crew aboard another ship offer MOVE TO SWIFT', /MOVE TO SWIFT/.test(moveLabel), moveLabel);
  await p.click('.fr-hangar-action');
  await sleep(120);
  await p.click('.fr-hangar-action');
  s = await waitFor(p, (x) => x.fleet.active === 'swift', 3000);
  check('flying the Swift: its view is empty and the Petrel crew are kept, not deleted', s.fleet.active === 'swift' && s.crew.view.ship === 'swift' && s.crew.view.members.length === 0 && s.crew.state.seats.petrel?.includes('maren-sato') && s.crew.state.hired.includes('tobiah-renn'), s.crew);
  await press(p, 'assign:tobiah-renn');
  s = await st(p);
  check('assigning to the Swift fills its one seat; the view follows', s.crew.view.members.map((m) => m.id).join() === 'tobiah-renn', s.crew.view);

  // persistence across a reload
  const before = (await st(p)).crew.state;
  await p.reload({ waitUntil: 'load' });
  s = await waitFor(p, (x) => x.screen === 'map' || x.phase === 'flight' || x.panel !== null);
  await sleep(300);
  s = await st(p);
  check('crew, seats and the balance persist across a reload', JSON.stringify(s.crew.state) === JSON.stringify(before) && s.marks === 170 && s.fleet.active === 'swift', { before, after: s.crew.state, marks: s.marks });
  check('slot 2 is untouched', (await p.evaluate(() => localStorage.getItem('galaxia:freeroam:slot2'))) === null);

  // LAUNCH still flies (no crew effect on flight)
  s = await dockAndOpenBridge(p);
  await p.click('.fr-hangar-launch');
  s = await waitFor(p, (x) => x.phase === 'flight' && x.panel === null, 4000);
  check('LAUNCH from the Bridge undocks and flies', s.phase === 'flight' && s.panel === null, { phase: s.phase, panel: s.panel });
  check('no console errors (desktop)', errs.length === 0, errs);
  await ctx.close();

  /* ------------------------------------------------------- 360x640 touch layout */
  const m = await newPage(browser, { w: 360, h: 640, touch: true });
  await m.p.evaluate(() => window.__galaxiaFreeRoam.qaMarks(300));
  s = await dockAndOpenBridge(m.p, true);
  check('mobile: the Bridge opens by tap', s.hangar?.view === 'bridge');
  await m.p.tap(btn('hire:maren-sato'));
  await sleep(450);
  await m.p.tap(btn('hire:maren-sato'));
  await sleep(150);
  await m.p.tap(btn('assign:maren-sato'));
  await sleep(150);
  const lay = await m.p.evaluate(() => {
    const pn = document.querySelector('.fr-panel-hangar');
    const br = pn.querySelector('.fr-bridge');
    const leaf = [...br.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && e.textContent.trim() && e.getClientRects().length > 0);
    const targets = [...br.querySelectorAll('button'), ...pn.querySelectorAll('.fr-hangar-view')].filter((b) => b.getClientRects().length > 0).map((b) => ({ k: b.dataset.key ?? b.className, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width }));
    return {
      sideways: Math.max(document.documentElement.scrollWidth, pn.scrollWidth) - innerWidth,
      outside: leaf.filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).map((e) => e.textContent.slice(0, 30)),
      small: leaf.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 10).map((e) => e.textContent.slice(0, 30)),
      tiny: targets.filter((t) => t.h < 36 || t.w < 44).map((t) => `${t.k}:${Math.round(t.h)}x${Math.round(t.w)}`),
      actionsSmall: targets.filter((t) => /^(hire|assign|unassign|dismiss):/.test(t.k) && t.h < 44).map((t) => t.k),
    };
  });
  s = await st(m.p);
  check('mobile: tap hire (two taps) and assign work', s.crew.state.seats.petrel?.includes('maren-sato'), s.crew.state);
  check('mobile 360x640: no sideways scroll, nothing outside the screen', lay.sideways <= 1 && lay.outside.length === 0, lay);
  check('mobile 360x640: Bridge text >= 10 px', lay.small.length === 0, lay.small);
  check('mobile 360x640: crew actions are >= 44 px tall touch targets', lay.actionsSmall.length === 0 && lay.tiny.length === 0, lay);
  await shot(m.p, 'bridge-mobile');
  check('no console errors (mobile)', m.errs.length === 0, m.errs);
  await m.ctx.close();
} finally {
  await browser.close();
}
const ok = checks.filter((c) => c.ok).length;
console.log(`\n${ok}/${checks.length} checks passed`);
process.exit(ok === checks.length ? 0 : 1);
