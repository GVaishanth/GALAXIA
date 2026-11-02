// Finale P1 critical hits in a real browser (QA build: needs window.__galaxiaFreeRoam and the test hooks).
//   node critical-hits-f1.mjs [pageUrl] [chromium]
// The rule (10 % per eligible firing event, decided once per shot) is proven by the unit suite
// (tests/criticalHits.test.ts) with deterministic boundaries. This harness checks the same rule end to end
// in the shipped game loop: the QA-only hook qaCrit fixes the outcome for one sector visit (it exists only in
// builds with test hooks, never in a release), qaSpawn places a hostile, and every shot is the player's own
// SPACE key through the normal input path. Test placement holds the pilot still with its nose on the target.
//   C1  a new sector visit starts AUTO with zero decisions; an unknown mode is refused and changes nothing;
//   C2  forced critical: the first shot that strikes a hostile destroys it through the ordinary pipeline
//       (one destroyed ship, one kill, one confirmed critical by the pilot, one restrained log line);
//   C3  forced ordinary: hits only remove hull; nothing is confirmed;
//   C4  protection: a capital ship is never deleted by a critical (ordinary damage only);
//   C5  pause: no decision is drawn while paused, even with FIRE (J) held;
//   C6  a critical on the pilot (held outside the arrival sanctuary) uses the normal loss: one SHIP LOST line, the recovery screen, CONTINUE flies again;
//   C7  RESTART FLIGHT stays inside the sector visit (its state carries on); a new visit after a reload is AUTO with
//       fresh counters, and nothing critical reaches the save;
//   +   no page errors.
// Automated Chromium only (Playwright); no physical device was used.
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SOL = 'milky-way/sol';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};
function pilot() {
  return {
    version: 10, createdAt: 1, sessions: 5, flightSeconds: 900, beaconsCharted: 1, surveysCompleted: 1, bestSurveyTicks: 5000,
    currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL], galaxySurveys: { 'milky-way': 1 },
    currentSystem: SOL, visitedSystems: [SOL], sectors: { [SOL]: { done: [], surveyed: true } },
    cargo: { scrap: 10, fuel: 20, alloy: 0, ice: 0 },
    fleet: { active: 'petrel', owned: ['petrel'], loadouts: {} },
    lostCargo: null, modules: {}, milestones: [],
    progression: { marks: 100, missions: { active: [], completed: ['story-first-light'], claimed: ['story-first-light'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
    crew: { hired: [], paid: [], seats: {} },
    savedAt: 1, resume: null,
  };
}
function seedOnce(rec) {
  if (!sessionStorage.getItem('f1-seeded')) {
    sessionStorage.setItem('f1-seeded', '1');
    localStorage.setItem('galaxia:freeroam', JSON.stringify(rec));
    localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
  }
}
function watchFeed() {
  window.__f1lines = [];
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) for (const e of [n, ...n.querySelectorAll('.fr-feed-line, .fr-notice-title')]) if (e.classList?.contains('fr-feed-line') || e.classList?.contains('fr-notice-title')) window.__f1lines.push(e.textContent);
  }).observe(document, { childList: true, subtree: true });
}
const count = async (p, re) => (await p.evaluate(() => window.__f1lines.slice())).filter((l) => re.test(l)).length;
const until = async (p, js, ms = 5000, arg = null) => {
  try { await p.waitForFunction(js, arg, { timeout: ms }); return true; } catch { return false; }
};
const C = (p) => p.evaluate(() => window.__galaxiaFreeRoam.crit());
const agent = (p, id) => p.evaluate((id) => {
  const a = window.__galaxiaFreeRoam.state.hostiles.find((h) => h.id === id);
  return a ? { state: a.state, hull: a.hull, shield: a.shield, family: a.family } : null;
}, id);
/** A destroyed ship leaves the hostile list once cleaned up: either counts as destroyed. */
const gone = (a) => a === null || a.state === 'destroyed';
/** The lowest hull + shield an agent reaches from now on (shields regenerate between hits, so a later reading can look untouched). */
const watchLow = (p, id) => p.evaluate((id) => {
  const a = window.__galaxiaFreeRoam.state.hostiles.find((h) => h.id === id);
  window.__f1low = { ...window.__f1low, [id]: a.hull + a.shield };
  const loop = () => { if (a.state === 'destroyed') return; window.__f1low[id] = Math.min(window.__f1low[id], a.hull + a.shield); requestAnimationFrame(loop); };
  loop();
}, id);
const low = (p, id) => p.evaluate((id) => window.__f1low[id], id);
/** Test placement: retire every hostile so the next scenario starts with a clear line of fire. */
async function clearBoard(p) {
  await p.evaluate(() => { for (const a of window.__galaxiaFreeRoam.state.hostiles) a.state = 'destroyed'; });
  await until(p, () => window.__galaxiaFreeRoam.state.hostiles.every((a) => a.state === 'destroyed'), 2000);
  await sleep(300);
}
/** Where a hostile sits relative to the pilot, and the pilot's heading (failure diagnostics). */
const geo = (p, id) => p.evaluate((id) => {
  const r = window.__galaxiaFreeRoam.state;
  const a = r.hostiles.find((h) => h.id === id);
  return { rel: a ? [Math.round(a.x - r.ship.x), Math.round(a.y - r.ship.y)] : null, ship: [Math.round(r.ship.x), Math.round(r.ship.y)], held: window.__f1pos, heading: +r.ship.heading.toFixed(3), others: r.hostiles.filter((h) => h.id !== id && h.state !== 'destroyed').length };
}, id);
/** Test placement: hold the ship still with its nose up (heading 0) every frame; keep its hull full unless freed. */
const hold = (p) => p.evaluate(() => {
  if (window.__f1hold) return;
  window.__f1hold = true;
  const loop = () => {
    const r = window.__galaxiaFreeRoam?.state;
    if (r?.craft && r.phase === 'flight' && window.__f1pos) Object.assign(r.ship, { x: window.__f1pos.x, y: window.__f1pos.y, px: window.__f1pos.x, py: window.__f1pos.y, vx: 0, vy: 0, heading: 0 });
    if (r?.craft && !window.__f1free) { r.invuln = 1e9; r.hull = r.craft.stats.hull; }
    requestAnimationFrame(loop);
  };
  loop();
});
const here = (p) => p.evaluate(() => { const s = window.__galaxiaFreeRoam.state.ship; window.__f1pos = { x: s.x, y: s.y }; });
/** Hostiles placed by qaSpawn never move off the line of fire: pin them, and keep their own guns quiet (only the pilot's shots are under test). */
const still = (p, id, quiet = true, rel = null) => p.evaluate(([id, quiet, rel]) => {
  const r = window.__galaxiaFreeRoam.state;
  const a = r.hostiles.find((h) => h.id === id);
  // spawnAgent pushes a ship out of solids, so the exact offset from the pilot is placed here (test placement)
  const at = rel ? { x: r.ship.x + rel[0], y: r.ship.y + rel[1] } : { x: a.x, y: a.y };
  const loop = () => {
    if (a.state === 'destroyed' || window.__galaxiaFreeRoam.state !== r) return;
    Object.assign(a, { x: at.x, y: at.y, vx: 0, vy: 0 });
    if (quiet) a.cooldowns.fill(1e9);
    requestAnimationFrame(loop);
  };
  loop();
}, [id, quiet, rel]);
async function fire(p, ms) {
  await p.keyboard.down('Space');
  await sleep(ms);
  await p.keyboard.up('Space');
  await sleep(150);
}
async function restartFlight(p) {
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(400);
  await p.keyboard.press('KeyR');
  await sleep(150);
  await p.keyboard.press('KeyR');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 4000);
  await sleep(300);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript(seedOnce, pilot());
await ctx.addInitScript(watchFeed);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
try {
  await p.goto(PAGE + '?mode=freeroam', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await p.locator('.fr-det-actions >> text=ENTER SECTOR').locator('visible=true').first().click();
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
  await hold(p);
  await here(p);

  // C1
  let c = await C(p);
  const bogus = await p.evaluate(() => window.__galaxiaFreeRoam.qaCrit('always'));
  const c1 = await C(p);
  check('C1: a new visit is AUTO with no decisions; an unknown mode is refused and changes nothing', c?.mode === 'auto' && c.rolls === 0 && c.landed === 0 && bogus === false && c1.mode === 'auto', { c, bogus, c1 });

  // C2
  const lines0 = await count(p, /^CRITICAL HIT/);
  const kills0 = await p.evaluate(() => window.__galaxiaFreeRoam.state.kills);
  await p.evaluate(() => window.__galaxiaFreeRoam.qaCrit('crit'));
  const target = await p.evaluate(() => window.__galaxiaFreeRoam.qaSpawn('heavy', 0, -150));
  await still(p, target, true, [0, -150]);
  await sleep(100);
  const before = await agent(p, target);
  const g2 = await geo(p, target);
  await fire(p, 600);
  await until(p, (id) => { const a = window.__galaxiaFreeRoam.state.hostiles.find((h) => h.id === id); return !a || a.state === 'destroyed'; }, 3000, target);
  c = await C(p);
  const killed = await agent(p, target);
  const kills = (await p.evaluate(() => window.__galaxiaFreeRoam.state.kills)) - kills0;
  const critLines = (await p.evaluate(() => window.__f1lines.slice())).filter((l) => /^CRITICAL HIT/.test(l)).slice(lines0);
  check('C2: forced critical: the struck heavy (full hull) is destroyed through the ordinary pipeline, one kill, one confirmed critical, one log line',
    before?.state !== 'destroyed' && gone(killed) && kills === 1 && c.landed === 1 && c.last.length === 1 && c.last[0].victim === 'hostile' && c.last[0].by === 'player' && c.last[0].what === 'heavy' && critLines.length === 1 && critLines[0] === 'CRITICAL HIT · HEAVY DESTROYED',
    { before, killed, kills, c, critLines, g2 });

  // C3
  await clearBoard(p);
  await p.evaluate(() => window.__galaxiaFreeRoam.qaCrit('normal'));
  const heavy = await p.evaluate(() => window.__galaxiaFreeRoam.qaSpawn('heavy', 0, -150));
  await still(p, heavy, true, [0, -150]);
  const h0 = await agent(p, heavy);
  await watchLow(p, heavy);
  const r0 = (await C(p)).rolls;
  await fire(p, 900);
  const h1 = await agent(p, heavy);
  const lo3 = await low(p, heavy);
  c = await C(p);
  check('C3: forced ordinary: SPACE draws decisions, hits only wear the shield and hull, nothing is confirmed',
    c.mode === 'normal' && c.rolls > r0 && h1?.state !== 'destroyed' && lo3 < h0.hull + h0.shield && c.landed === 1,
    { h0, h1, lo3, c, r0, g: await geo(p, heavy) });

  // C4
  await clearBoard(p);
  await p.evaluate(() => window.__galaxiaFreeRoam.qaCrit('crit'));
  const cap = await p.evaluate(() => window.__galaxiaFreeRoam.qaSpawn('capital', 0, -230));
  await still(p, cap, true, [0, -230]);
  const k0 = await agent(p, cap);
  await watchLow(p, cap);
  const l4 = (await C(p)).landed;
  await fire(p, 1200);
  const k1 = await agent(p, cap);
  const lo4 = await low(p, cap);
  c = await C(p);
  check('C4: a capital ship is protected: forced criticals give it ordinary damage only and it survives',
    k1?.state !== 'destroyed' && lo4 < k0.hull + k0.shield && c.last.every((e) => e.what !== 'capital') && c.landed === l4,
    { k0, k1, lo4, c, g: await geo(p, cap) });
  // clear the board for the pilot checks
  await clearBoard(p);

  // C5
  await p.keyboard.press('Escape');
  const paused = await until(p, () => window.__galaxiaFreeRoam.panel() === 'pause');
  const pr0 = (await C(p)).rolls;
  // J is the second FIRE binding (SPACE would press the focused RESUME button: menu confirm)
  await p.keyboard.down('KeyJ');
  await sleep(900);
  const stillPaused = await p.evaluate(() => window.__galaxiaFreeRoam.panel() === 'pause' && window.__galaxiaFreeRoam.state.phase === 'paused');
  await p.keyboard.up('KeyJ');
  const pr1 = (await C(p)).rolls;
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === null);
  await sleep(200);
  check('C5: paused: no decision is drawn even with FIRE (J) held', paused && stillPaused && pr1 === pr0, { paused, stillPaused, pr0, pr1 });

  // C6
  const lost0 = await count(p, /CRITICAL HIT TAKEN · SHIP LOST/);
  // hostiles never fire into the arrival sanctuary (the ordinary safe zone, untouched by criticals): hold the pilot outside it
  await p.evaluate(() => {
    const r = window.__galaxiaFreeRoam.state;
    const A = r.layout.arrival;
    const dx = r.layout.width / 2 - A.x;
    const dy = r.layout.height / 2 - A.y;
    const n = Math.hypot(dx, dy) || 1;
    window.__f1pos = { x: A.x + (dx / n) * (A.r + 400), y: A.y + (dy / n) * (A.r + 400) };
  });
  await sleep(300);
  await p.evaluate(() => window.__galaxiaFreeRoam.qaCrit('crit'));
  const foe = await p.evaluate(() => window.__galaxiaFreeRoam.qaSpawn('raider', 0, -170));
  await still(p, foe, false);
  // a guard does not notice a pilot that is held still: hand it the pilot as its target (test placement of awareness)
  await p.evaluate((id) => { window.__galaxiaFreeRoam.state.hostiles.find((h) => h.id === id).target = 'player'; }, foe);
  await p.evaluate(() => { window.__f1free = true; const r = window.__galaxiaFreeRoam.state; r.invuln = 0; r.hull = r.craft.stats.hull; });
  const wrecked = await until(p, () => window.__galaxiaFreeRoam.panel() === 'recovery', 15000);
  c = await C(p);
  const lost = (await count(p, /CRITICAL HIT TAKEN · SHIP LOST/)) - lost0;
  check('C6: a hostile critical on the pilot: one SHIP LOST line, the ordinary recovery screen, one pilot record',
    wrecked && lost === 1 && c.last.filter((e) => e.victim === 'player').length === 1, { wrecked, lost, c });
  await p.evaluate(() => { window.__f1free = false; });
  await p.click('.fr-recovery-continue');
  const flying = await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 5000);
  check('C6: CONTINUE returns to flight', flying);

  // C7: RESTART FLIGHT recalls the pilot inside the same sector visit (restartSector: same run), so the visit's
  // critical state carries on; a new visit (here: a reload, which builds the run from the save) starts AUTO.
  await here(p);
  const mode6 = (await C(p)).mode;
  await restartFlight(p);
  await here(p);
  const c7a = await C(p);
  check('C7: RESTART FLIGHT stays in the same sector visit: the visit\'s mode and counters carry on (documented)', c7a.mode === mode6 && c7a.rolls >= 1, { mode6, c7a });
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  const save = await p.evaluate(() => localStorage.getItem('galaxia:freeroam') ?? '');
  await p.locator('.fr-det-actions >> text=ENTER SECTOR').locator('visible=true').first().click();
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  c = await C(p);
  check('C7: a new sector visit after a reload is AUTO with fresh counters; the save holds no critical state',
    c.mode === 'auto' && c.rolls === 0 && c.landed === 0 && c.last.length === 0 && save.length > 0 && !/"crit/i.test(save), { c, saveHasCrit: /"crit/i.test(save) });
} catch (e) {
  check('harness ran to the end', false, { error: String(e) });
}
check('no page errors', errs.length === 0, errs);
await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
