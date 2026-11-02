// P11.1 Fleet Command core in a real browser (QA build: needs window.__galaxiaFreeRoam).
//   node fleet-command-p11.mjs [pageUrl] [chromium]
// P11.1 has no fleet panel yet (P11.2): every fleet action goes through the shell's one entry point
// (fleetAct: the same function the P11.2 panel will call), and the status hook fleetCommand() reads the
// stored vessels and the flying wing. Everything else is the game's own input path: E docks and leaves a
// sector, WASD flies, Z is Silent Running, Escape pauses (R twice restarts). Test placement is used only to
// put the ship at the station or the exit beacon, and a guard loop keeps the pilot's hull full (the pilot's
// survival is not under test here). Since Finale P1 every hostile placement pins the visit to ordinary damage
// (qaCrit('normal'), see spawn below): critical hits are covered by critical-hits-f1.mjs. Scenarios:
//   1.  lazy load: the fleetKit chunk is fetched once, on the first fleet action, never before;
//   2.  a purchase deducts the price exactly once (marks once in the ledger, cargo once); the Hangar is untouched;
//   3.  the captain is assigned and stored (only id, archetype, captain, status in the save);
//   4.  invalid purchases are refused with nothing deducted (Heron, an unhired captain, too few marks, a used captain);
//   5.  an uncrewed vessel does not deploy;
//   6.  escorts are separate entities (negative ids, not in the enemy list, not the pilot's ship);
//   7.  Follow Formation under real WASD flight: slots kept, no teleport (per-frame step within the hull's speed);
//   8.  Hold Position: stays within tolerance while the pilot flies away;
//   9.  Defend Me: engages a hostile near the pilot;
//   10. Attack Target: fires on and destroys the ordered hostile;
//   11. invalid targets refused (the pilot, a station, a fleet vessel, unknown); the destroyed target falls back to Follow;
//   12. pause freezes the wing (positions, bolts) and resume continues;
//   13. leaving and re-entering a sector never duplicates the wing; orders reset to Follow;
//   14. save / reload keeps the fleet (the kit loads again only because a vessel is deployable);
//   15. a disabled vessel keeps its ownership and captain, stays disabled across RESTART FLIGHT, returns to service at a dock;
//   16. heat: the fleet's hits use the existing attribution exactly once (3 per hit stamp + 10 for the kill);
//   17. Silent Running stays on with escorts flying: escorts hold fire in Follow and run at the silent signature;
//       (Gravity Shadow line-of-sight is covered by the unit suite: tests/fleetCommand.test.ts)
//   18. a run with no fleet never loads the fleet runtime (flight, dock and the Hangar: no fleetKit request).
//   +   the kit failing to load: a visible notice, no wing, nothing spawned, no page error.
// P11.2 Fleet panel (sessions ui, ui-edges, ui-touch, ui-viewports; run one with P11_ONLY=name):
//   U1  the panel chunk and the kit load on the first FLEET tab only (docking fetches neither), once; opening advances nothing;
//   U2  empty state: the route explained, HANGAR · BRIDGE really opens the Hangar;  U3 hull prices, materials, licences;
//   U4  refusals in the kit's words (and in the accessible name);  U5 purchase review;  U6 double click buys one;
//   U7  Enter twice buys one and stays in the panel;  U8 touch: two taps buy one, one tap one order;
//   U9  a captain move asks first, then moves; invalid transfer refused;  U10 seated crew marked with the reason;
//   U11 release needs CONFIRM, Escape cancels;  U12 out of service / back;  U13 FLEET ORDERS only with a fleet, game paused;
//   U14 flight keys inert while open, panel keys navigate, single-vessel orders;  U15 orders for all;
//   U16 ATTACK needs the pilot's lock (refusal otherwise) and targets exactly it; fallback to Follow;
//   U17 HUD summary follows the orders;  U18 dock repairs;  U19 disabled shown and refused; unrecruited captain never flies;
//   U20 sector change and map: no duplicate;  U21 restart;  U22 ship change leaves the fleet alone;
//   U23 reload persists only {id, ship, captain, status}; a legacy save shows the empty state;
//   U24 the panel chunk failing (notice, station usable, works after reload); input restored after closing (keys, FIRE / BOOST taps);
//   U-vp the eight viewports: docked panel, orders panel, the HUD line after closing (inside, unclipped, >= 10 px,
//   44 x 44 actions with names, no overlap, focus inside, the FLEET tab reachable, clear of the flight controls).
// Automated Chromium only (Playwright); no physical device was used.
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SOL = 'milky-way/sol';
const KV = 'milky-way/kestrel-verge';
const LG = 'milky-way/lantern-gate';
const MAREN = 'maren-sato';
const TOBIAH = 'tobiah-renn';
const ODILE = 'odile-marchetti';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};
function pilot(vessels, extra = {}) {
  return {
    version: 10, createdAt: 1, sessions: 5, flightSeconds: 900, beaconsCharted: 3, surveysCompleted: 3, bestSurveyTicks: 5000,
    currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL, KV, LG], galaxySurveys: { 'milky-way': 3 },
    currentSystem: SOL, visitedSystems: [SOL, KV, LG], sectors: { [SOL]: { done: [], surveyed: true }, [KV]: { done: [], surveyed: true }, [LG]: { done: [], surveyed: true } },
    cargo: { scrap: 60, fuel: 20, alloy: 40, ice: 10 },
    fleet: { active: 'petrel', owned: ['petrel'], loadouts: {} },
    lostCargo: null, modules: {}, milestones: [],
    progression: { marks: 2000, missions: { active: [], completed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], claimed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
    crew: { hired: [MAREN, TOBIAH, ODILE], paid: [MAREN, TOBIAH, ODILE], seats: {} },
    ...(vessels ? { vessels } : {}),
    savedAt: 1, resume: null,
    ...extra,
  };
}
function seedOnce(rec) {
  if (!sessionStorage.getItem('p11-seeded')) {
    sessionStorage.setItem('p11-seeded', '1');
    localStorage.setItem('galaxia:freeroam', JSON.stringify(rec));
    localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
  }
}
/** Every corner-log line and visible notice title since load. */
function watchFeed() {
  window.__p11lines = [];
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) for (const e of [n, ...n.querySelectorAll('.fr-feed-line, .fr-notice-title')]) if (e.classList?.contains('fr-feed-line') || e.classList?.contains('fr-notice-title')) window.__p11lines.push(e.textContent);
  }).observe(document, { childList: true, subtree: true });
}
const lines = (p) => p.evaluate(() => window.__p11lines.slice());
const until = async (p, js, ms = 5000, arg = null) => {
  try { await p.waitForFunction(js, arg, { timeout: ms }); return true; } catch { return false; }
};
const F = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  const c = f.fleetCommand();
  const r = f.state;
  return { kit: c.kit, vessels: c.vessels, captains: c.captains, wing: c.wing, phase: r?.phase, hostiles: r?.hostiles ? r.hostiles.map((a) => a.id) : [], ship: r?.ship ? { x: r.ship.x, y: r.ship.y } : null, silent: r?.silent, owned: f.fleet().owned, active: f.fleet().active, marks: f.progression().marks, cargo: f.profile().cargo, history: f.economy().history.length, heat: f.heat().factions };
});
const act = (p, a) => p.evaluate((a) => window.__galaxiaFreeRoam.fleetAct(a), a);
// Finale P1: critical hits are on by default (10 % per firing event; a confirmed critical destroys a ship at
// once). These scenarios test fleet orders against a living hostile, not critical hits (critical-hits-f1.mjs
// does), so every placement first pins the sector visit to ordinary damage through the QA-only qaCrit hook (it
// exists only in builds with test hooks). A pin that does not take stops the run instead of passing silently.
const spawn = (p, fam, dx, dy) => p.evaluate(([fam, dx, dy]) => {
  const f = window.__galaxiaFreeRoam;
  if (!f.qaCrit('normal')) throw new Error('qaCrit(normal) was refused');
  return f.qaSpawn(fam, dx, dy);
}, [fam, dx, dy]);
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:freeroam')).vessels ?? null);
/** Keep the pilot alive (not under test) without moving it. */
const guard = (p) => p.evaluate(() => {
  if (window.__p11guard) return;
  window.__p11guard = true;
  const loop = () => {
    const r = window.__galaxiaFreeRoam?.state;
    if (r?.craft) { r.invuln = 1e9; r.hull = r.craft.stats.hull; }
    requestAnimationFrame(loop);
  };
  loop();
});
/** Test placement: hold the ship at P every frame (null releases). */
const hold = (p, P) => p.evaluate((P) => {
  window.__p11hold = P;
  if (window.__p11holdLoop) return;
  window.__p11holdLoop = true;
  const loop = () => {
    const r = window.__galaxiaFreeRoam?.state;
    const w = window.__p11hold;
    if (r?.craft && w) Object.assign(r.ship, { x: w.x, y: w.y, px: w.x, py: w.y, vx: 0, vy: 0 });
    requestAnimationFrame(loop);
  };
  loop();
}, P);

async function open(browser, { vessels = null, block = false, blockPanel = false, extra = {}, legacy = false, viewport = { width: 1280, height: 720 }, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  const rec = pilot(vessels, extra);
  if (legacy) { delete rec.vessels; rec.version = 9; }
  await ctx.addInitScript(seedOnce, rec);
  await ctx.addInitScript(watchFeed);
  const p = await ctx.newPage();
  const errs = [];
  const chunks = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && !((block || blockPanel) && /Failed to (load|fetch)|net::ERR_FAILED|dynamically imported module/i.test(m.text())) && errs.push('console: ' + m.text()));
  p.on('request', (q) => { const m = q.url().match(/\/assets\/(fleetKit|fleetPanel|shipyard|tow)-[^/]*\.js$/); if (m) chunks.push(m[1]); });
  if (block) await p.route('**/assets/fleetKit-*.js', (r) => r.abort());
  const gate = { open: false };
  if (blockPanel) await p.route('**/assets/fleetPanel-*.js', (r) => (gate.open ? r.continue() : r.abort()));
  await p.goto(PAGE + '?mode=freeroam' + (touch ? '&controls=touch' : ''), { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  return { ctx, p, errs, chunks, gate };
}
async function enterAny(p) {
  await p.locator('.fr-det-actions >> text=ENTER SECTOR').locator('visible=true').first().click();
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
}
async function dock(p) {
  const stn = await p.evaluate(() => window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'station'));
  await hold(p, { x: stn.x, y: stn.y + 80 });
  await until(p, (id) => window.__galaxiaFreeRoam.state.focus === id, 3000, stn.id);
  await sleep(200);
  await p.keyboard.press('KeyE');
  const ok = await until(p, () => window.__galaxiaFreeRoam.panel() === 'station');
  await hold(p, null);
  return ok;
}
async function launch(p) {
  if ((await p.evaluate(() => window.__galaxiaFreeRoam.panel())) !== 'station') {
    await p.keyboard.press('Escape');
    await until(p, () => window.__galaxiaFreeRoam.panel() === 'station');
  }
  await p.click('.fr-tab-launch');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
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
/** Record every escort every frame: tick, position and the hull's speed cap. */
const record = (p) => p.evaluate(() => {
  window.__p11rec = [];
  window.__p11recOn = true;
  const loop = () => {
    if (!window.__p11recOn) return;
    const r = window.__galaxiaFreeRoam.state;
    if (r?.wing && r.phase === 'flight') window.__p11rec.push({ tick: r.tick, sx: r.ship.x, sy: r.ship.y, u: r.wing.units.map((u) => ({ id: u.id, x: u.ship.x, y: u.ship.y, max: u.spec.tune.maxSpeed, state: u.state })) });
    requestAnimationFrame(loop);
  };
  loop();
});
const stopRecord = (p) => p.evaluate(() => { window.__p11recOn = false; return window.__p11rec; });
/** Largest per-tick jump beyond what the hull's top speed (plus the separation nudge) allows: <= 0 means no teleport. */
function worstJump(rec) {
  let worst = -Infinity;
  for (let i = 1; i < rec.length; i++) {
    const a = rec[i - 1];
    const b = rec[i];
    const dt = b.tick - a.tick;
    if (dt <= 0) continue;
    for (const u of b.u) {
      const v = a.u.find((x) => x.id === u.id);
      if (v) worst = Math.max(worst, Math.hypot(u.x - v.x, u.y - v.y) - dt * (u.max / 60 + 8));
    }
  }
  return worst;
}
const fly = async (p, key, ms) => { await p.keyboard.down(key); await sleep(ms); await p.keyboard.up(key); };
async function close(o, tag) {
  check(`${tag}: no page errors`, o.errs.length === 0, o.errs);
  await o.ctx.close();
}

/* ------------------------------------------------------------ the main session (Sol) */
async function main(browser) {
  const o = await open(browser);
  const { p } = o;
  await guard(p);
  // 18: no fleet, so no fleet runtime: flight, dock and the Hangar never fetch it
  await enterAny(p);
  await fly(p, 'KeyD', 600);
  let s = await F(p);
  check('18: a run with no fleet: no wing, kit idle, no fleetKit request in flight', s.kit === 'idle' && s.wing === null && !o.chunks.includes('fleetKit'), { kit: s.kit, chunks: o.chunks });
  check('setup: docked with the real E key', await dock(p));
  await p.keyboard.press('BracketRight');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'hangar' && !!window.__galaxiaFreeRoam.hangar(), 6000);
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'station');
  s = await F(p);
  check('18: docking and opening the Hangar still fetch no fleetKit (the Hangar chunk does load)', !o.chunks.includes('fleetKit') && o.chunks.includes('shipyard') && s.kit === 'idle', o.chunks);

  // 4 (first, so the first fleet action is a refusal): nothing deducted
  const before = await F(p);
  const refusals = [];
  refusals.push(await act(p, { kind: 'buy', ship: 'heron', captain: MAREN }));
  // 1: the first fleet action loaded the kit, once
  check('1: the first fleet action fetches the fleetKit chunk exactly once; the kit is ready', o.chunks.filter((c) => c === 'fleetKit').length === 1 && (await F(p)).kit === 'ready', o.chunks);
  refusals.push(await act(p, { kind: 'buy', ship: 'raven', captain: MAREN }));
  refusals.push(await act(p, { kind: 'buy', ship: 'shrike', captain: 'brask-ottley' }));
  refusals.push(await act(p, { kind: 'buy', ship: 'shrike', captain: 'nobody-at-all' }));
  await p.evaluate(() => window.__galaxiaFreeRoam.qaMarks(150));
  refusals.push(await act(p, { kind: 'buy', ship: 'shrike', captain: MAREN }));
  await p.evaluate(() => window.__galaxiaFreeRoam.qaMarks(2000));
  let after = await F(p);
  check('4: invalid purchases refused (Heron, Raven: ineligible; unhired, unknown captain; too few marks), nothing deducted or added', refusals.map((r) => r.reason).join() === 'ineligible,ineligible,not-hired,unknown-crew,marks' && refusals.every((r) => !r.ok && r.text) && JSON.stringify(after.cargo) === JSON.stringify(before.cargo) && after.vessels.list.length === 0 && (await stored(p)) === null, { refusals, cargo: [before.cargo, after.cargo] });

  // 2: a real purchase, deducted exactly once
  const b0 = await F(p);
  const buy1 = await act(p, { kind: 'buy', ship: 'shrike', captain: MAREN });
  const b1 = await F(p);
  const again = await act(p, { kind: 'buy', ship: 'shrike', captain: MAREN });
  const b2 = await F(p);
  const ledger = await p.evaluate(() => window.__galaxiaFreeRoam.economy().history.filter((e) => e.label.startsWith('Fleet hull')));
  check('2: buying a Shrike hull: 200 marks once, alloy 10 and scrap 14 once, one ledger entry; the Hangar (owned, flown) untouched', buy1.ok && b1.marks === b0.marks - 200 && b1.cargo.alloy === b0.cargo.alloy - 10 && b1.cargo.scrap === b0.cargo.scrap - 14 && ledger.length === 1 && ledger[0].delta === -200 && b1.owned.join() === 'petrel' && b1.active === 'petrel', { buy1, m: [b0.marks, b1.marks], ledger, owned: b1.owned });
  check('2: the same purchase again is refused (captain already commands a vessel): nothing deducted twice', !again.ok && again.reason === 'captain' && b2.marks === b1.marks && JSON.stringify(b2.cargo) === JSON.stringify(b1.cargo) && b2.history === b1.history && b2.vessels.list.length === 1, { again, m: [b1.marks, b2.marks] });
  // 3: captain assigned and stored, nothing transient in the save
  const sv = await stored(p);
  check('3: captain assigned and saved: {seq, list:[{id, ship, captain, status}]} only', b1.vessels.list[0]?.captain === MAREN && b1.captains.join() === MAREN && JSON.stringify(sv) === JSON.stringify({ seq: 1, list: [{ id: 'fv-1', ship: 'shrike', captain: MAREN, status: 'active' }] }), sv);

  // 5: a second hull, then its captain returned to the roster: uncrewed, not deployed
  const buy2 = await act(p, { kind: 'buy', ship: 'swift', captain: TOBIAH });
  const rel = await act(p, { kind: 'release', vessel: 'fv-2' });
  await launch(p);
  await until(p, () => !!window.__galaxiaFreeRoam.fleetCommand().wing, 3000);
  s = await F(p);
  check('5: an uncrewed vessel (captain returned to the roster) does not deploy; the crewed one does', buy2.ok && rel.ok && s.vessels.list.length === 2 && s.vessels.list[1].captain === null && s.wing?.units.length === 1 && s.wing.units[0].vessel === 'fv-1', { buy2, rel, wing: s.wing?.units.map((u) => u.vessel) });
  // 6: separate entities
  check('6: the escort is its own entity: negative id, not in the enemy list, not at the pilot\'s position, Shrike hull points', s.wing.units[0].id < 0 && !s.hostiles.includes(s.wing.units[0].id) && Math.hypot(s.wing.units[0].x - s.ship.x, s.wing.units[0].y - s.ship.y) > 10 && s.wing.units[0].ship === 'shrike' && s.wing.units[0].hull > 0, s.wing.units[0]);

  // 7: Follow Formation under real WASD flight
  await record(p);
  await fly(p, 'KeyD', 1500);
  await fly(p, 'KeyS', 700);
  await sleep(1500);
  let rec = await stopRecord(p);
  s = await F(p);
  const dEnd = Math.hypot(s.wing.units[0].x - s.ship.x, s.wing.units[0].y - s.ship.y);
  check('7: Follow under real flight: never a jump (per-tick step within the Shrike\'s speed), back in formation after the stop', rec.length > 60 && worstJump(rec) <= 0.5 && dEnd < 140 && s.wing.units[0].order.kind === 'follow', { frames: rec.length, worst: worstJump(rec), dEnd });

  // 8: Hold Position while the pilot flies away
  const h = await act(p, { kind: 'order', who: 'fv-1', order: { kind: 'hold' } });
  s = await F(p);
  const hp = s.wing.units[0].order;
  await fly(p, 'KeyD', 1500);
  await sleep(1800);
  await record(p);
  await sleep(700);
  rec = await stopRecord(p);
  const off = Math.max(...rec.map((f) => Math.hypot(f.u[0].x - hp.x, f.u[0].y - hp.y)));
  s = await F(p);
  check('8: Hold Position: the escort stays within 24 px of the stored point (+2) while the pilot flies away', h.ok && hp.kind === 'hold' && off <= 26 && Math.hypot(s.ship.x - hp.x, s.ship.y - hp.y) > 150, { h, hp, off });
  await act(p, { kind: 'order', who: 'all', order: { kind: 'follow' } });
  await sleep(2500);

  // 9: Defend Me
  await act(p, { kind: 'order', who: 'all', order: { kind: 'defend' } });
  const d = await spawn(p, 'raider', 220, -160);
  const engaged = await until(p, (id) => { const w = window.__galaxiaFreeRoam.fleetCommand().wing; return w?.units[0].target === id && w.bolts > 0; }, 6000, d);
  check('9: Defend Me: the escort engages the hostile near the pilot and fires', d !== null && engaged, { d, wing: (await F(p)).wing });
  await until(p, (id) => !window.__galaxiaFreeRoam.state.hostiles.some((a) => a.id === id), 15000, d);

  // 10, 11, 16: Attack Target, refusals, fallback and heat exactly once
  const t = await spawn(p, 'raider', 320, 120);
  const bad = [];
  bad.push(await act(p, { kind: 'order', who: 'all', order: { kind: 'attack', target: 'player' } }));
  const stn = await p.evaluate(() => window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'station').id);
  bad.push(await act(p, { kind: 'order', who: 'all', order: { kind: 'attack', target: stn } }));
  bad.push(await act(p, { kind: 'order', who: 'all', order: { kind: 'attack', target: -1 } }));
  bad.push(await act(p, { kind: 'order', who: 'all', order: { kind: 'attack', target: 987654 } }));
  check('11: Attack refuses the pilot, a station, a fleet vessel and an unknown target; orders unchanged', bad.map((r) => r.reason).join() === 'player,station,friendly,invalid-target' && (await F(p)).wing.units[0].order.kind === 'defend', bad);
  const heat0 = (await F(p)).heat;
  await p.evaluate((id) => {
    window.__p11stamps = [];
    const loop = () => {
      const a = window.__galaxiaFreeRoam.state?.hostiles.find((x) => x.id === id);
      if (!a) return;
      if (a.heatAt !== undefined && window.__p11stamps.at(-1) !== a.heatAt) window.__p11stamps.push(a.heatAt);
      requestAnimationFrame(loop);
    };
    loop();
  }, t);
  const atk = await act(p, { kind: 'order', who: 'fv-1', order: { kind: 'attack', target: t } });
  const killed = await until(p, (id) => !window.__galaxiaFreeRoam.state.hostiles.some((a) => a.id === id), 15000, t);
  await sleep(300);
  s = await F(p);
  check('10: Attack Target: the escort fires on the ordered hostile and destroys it', atk.ok && killed, { atk, killed });
  check('11: the destroyed target falls back to Follow Formation', s.wing.units[0].order.kind === 'follow', s.wing.units[0].order);
  const stamps = await p.evaluate(() => window.__p11stamps.length);
  const heatOf = (hh) => hh.find?.((x) => x.faction === 'red-tally')?.value ?? hh['red-tally'] ?? 0;
  const dh = heatOf(s.heat) - heatOf(heat0);
  check('16: heat through the existing attribution exactly once: +3 per hit stamp and +10 for the one kill', stamps >= 1 && dh === 3 * stamps + 10, { stamps, dh, heat0, heat: s.heat });
  // the pilot fired nothing: the heat is the fleet's (the pilot never pressed fire in this harness)

  // 12: pause freezes the wing
  await act(p, { kind: 'order', who: 'all', order: { kind: 'hold' } });
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'pause');
  const p0 = await F(p);
  await sleep(1200);
  const p1 = await F(p);
  check('12: pause freezes the wing (position, hull, bolts, tick)', p0.phase === 'paused' && JSON.stringify(p0.wing) === JSON.stringify(p1.wing), { a: p0.wing?.units[0], b: p1.wing?.units[0] });
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 3000);

  // 17: Silent Running stays on with escorts flying
  await act(p, { kind: 'order', who: 'all', order: { kind: 'follow' } });
  await p.keyboard.press('KeyZ');
  await until(p, () => window.__galaxiaFreeRoam.state.silent === true, 2000);
  await spawn(p, 'raider', 640, 0);
  await sleep(2500);
  s = await F(p);
  const sr = await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; return { silent: r.silent, sig: r.wing.units[0].sig, tracking: r.hostiles.filter((a) => a.target === 'player').length }; });
  check('17: Silent Running stays on with an escort; the escort holds fire in Follow and runs at the silent signature (0.35)', sr.silent && sr.sig === 0.35 && s.wing.bolts === 0, sr);
  await p.keyboard.press('KeyZ');

  // 15: disabled keeps ownership; restart keeps it disabled; a dock returns it to service
  const blast = await p.evaluate(() => window.__galaxiaFreeRoam.qaFleetBlast('fv-1', 1e6));
  await sleep(300);
  s = await F(p);
  const sv15 = await stored(p);
  check('15: an escort at 0 hull is disabled, not removed: owned, captained, saved as disabled', blast && s.wing.units[0].state === 'disabled' && s.vessels.list[0].status === 'disabled' && s.vessels.list[0].captain === MAREN && sv15.list.length === 2 && sv15.list[0].status === 'disabled' && (await lines(p)).some((l) => /DISABLED/.test(l)), { unit: s.wing.units[0], sv15 });
  await restartFlight(p);
  s = await F(p);
  check('15: RESTART FLIGHT does not repair it (still disabled, out of the fight)', s.vessels.list[0].status === 'disabled' && (s.wing?.units ?? []).every((u) => u.state === 'disabled'), s.wing);
  await dock(p);
  s = await F(p);
  check('15: docking returns it to service (status active, full hull)', s.vessels.list[0].status === 'active' && (await stored(p)).list[0].status === 'active', s.vessels);
  await launch(p);
  s = await F(p);
  check('15: back in the fight after the dock', s.wing?.units[0]?.state === 'active' && s.wing.units[0].hull === s.wing.units[0].maxHull, s.wing?.units[0]);

  // 13: leave the sector and come back: one escort, orders reset to Follow
  await act(p, { kind: 'order', who: 'all', order: { kind: 'hold' } });
  const ex = await p.evaluate(() => window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'exit'));
  await hold(p, { x: ex.x, y: ex.y + 40 });
  await until(p, (id) => window.__galaxiaFreeRoam.state.focus === id, 3000, ex.id);
  await hold(p, null);
  await p.keyboard.press('KeyE');
  const left = await until(p, () => window.__galaxiaFreeRoam.screen() !== 'flight', 5000);
  await sleep(300);
  await enterAny(p);
  await until(p, () => !!window.__galaxiaFreeRoam.fleetCommand().wing, 3000);
  s = await F(p);
  check('13: leaving and re-entering a sector: one escort per deployable vessel (no duplicate), orders back to Follow', left && s.wing.units.length === 1 && new Set(s.wing.units.map((u) => u.vessel)).size === 1 && s.wing.units[0].order.kind === 'follow', s.wing);

  // 14: save / reload
  const chunksBefore = o.chunks.filter((c) => c === 'fleetKit').length;
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await guard(p);
  s = await F(p);
  const mapKit = s.kit;
  await enterAny(p);
  await until(p, () => !!window.__galaxiaFreeRoam.fleetCommand().wing, 4000);
  s = await F(p);
  check('14: after a reload the fleet is the saved one (two vessels, captains, statuses) and flies again (one escort)', s.vessels.list.length === 2 && s.vessels.list[0].captain === MAREN && s.vessels.list[1].captain === null && s.wing?.units.length === 1 && o.chunks.filter((c) => c === 'fleetKit').length === chunksBefore + 1, { v: s.vessels, mapKit, chunks: o.chunks });
  await close(o, 'main');
}

/* ------------------------------------------------------------ the kit failing to load */
async function failure(browser) {
  const o = await open(browser, { vessels: { seq: 1, list: [{ id: 'fv-1', ship: 'swift', captain: MAREN, status: 'active' }] }, block: true });
  const { p } = o;
  await guard(p);
  await enterAny(p);
  await until(p, () => window.__galaxiaFreeRoam.fleetCommand().kit === 'failed', 5000);
  await sleep(300);
  const s = await F(p);
  check('load failure: a visible FLEET SYSTEMS UNAVAILABLE notice, no wing, nothing spawned, the vessel still owned', s.kit === 'failed' && s.wing === null && !s.hostiles.some((x) => x < 0) && s.vessels.list.length === 1 && (await lines(p)).some((l) => /FLEET SYSTEMS UNAVAILABLE/.test(l)), { kit: s.kit, lines: (await lines(p)).slice(-4) });
  const a = await act(p, { kind: 'order', who: 'all', order: { kind: 'follow' } });
  check('load failure: a fleet action reports the systems unavailable and changes nothing', !a.ok && a.reason === 'unavailable' && JSON.stringify((await stored(p)) ?? null) === JSON.stringify({ seq: 1, list: [{ id: 'fv-1', ship: 'swift', captain: MAREN, status: 'active' }] }), a);
  await fly(p, 'KeyD', 500);
  check('load failure: flight continues normally', (await F(p)).phase === 'flight');
  await close(o, 'failure');
}

/* ===================================================================== P11.2: the Fleet panel */
// U1-U24 (P11.2 §11): the panel inside the station (FLEET tab) and the pause menu (FLEET ORDERS),
// driven by real clicks, keys and taps; every action ends in the shell's one fleetAct.
const FP = '.fr-panel-fleet';
const B = (k) => `${FP} button[data-key="${k}"]`;
const PS = (p) => p.evaluate(() => window.__galaxiaFreeRoam.fleetPanel());
const panelIs = (p, name) => until(p, (n) => window.__galaxiaFreeRoam.panel() === n, 6000, name);
/** The P11.1 commission table (round10(100 + 4 x hull cargo units)); the panel must show these, read from the kit. */
const COMMISSION = { petrel: 100, swift: 160, shrike: 200, condor: 250, magpie: 190, albatross: 160, harrier: 170, crane: 190 };
const panelText = (p) => p.evaluate((sel) => document.querySelector(sel)?.innerText ?? '', FP);
async function fleetTab(p) {
  await p.click('.fr-tab-fleet');
  const ok = await until(p, () => window.__galaxiaFreeRoam.panel() === 'fleet' && !!window.__galaxiaFreeRoam.fleetPanel(), 8000);
  await sleep(250);
  return ok;
}
async function pauseFleet(p, tap = false) {
  if ((await p.evaluate(() => window.__galaxiaFreeRoam.panel())) !== 'pause') {
    await p.keyboard.press('Escape');
    await panelIs(p, 'pause');
    await sleep(400); // the pause menu's reveal guard
  }
  if (tap) await p.tap('.fr-pause-fleet'); else await p.click('.fr-pause-fleet');
  const ok = await until(p, () => window.__galaxiaFreeRoam.panel() === 'fleet' && !!window.__galaxiaFreeRoam.fleetPanel(), 8000);
  await sleep(250);
  return ok;
}
/** BACK from the in-flight panel (to the pause menu), then resume with Escape. */
async function closeToFlight(p) {
  await p.click(B('back'));
  await panelIs(p, 'pause');
  await sleep(400);
  await p.keyboard.press('Escape');
  return until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 4000);
}
const focusInPanel = (p) => p.evaluate((sel) => !!document.activeElement?.closest(sel), FP);
const ledgerHulls = (p) => p.evaluate(() => window.__galaxiaFreeRoam.economy().history.filter((e) => e.label.startsWith('Fleet hull')).length);
const hudLine = (p) => p.evaluate(() => { const e = document.querySelector('.fr-fleet-line'); return e && !e.hidden ? e.textContent : ''; });
const SEATED = { crew: { hired: [MAREN, TOBIAH, ODILE], paid: [MAREN, TOBIAH, ODILE], seats: { petrel: [ODILE] } } };

async function uiMain(browser) {
  const o = await open(browser, { extra: { ...SEATED, fleet: { active: 'petrel', owned: ['petrel', 'swift'], loadouts: {} } } });
  const { p } = o;
  await guard(p);
  await enterAny(p);
  // U13: no fleet, no FLEET ORDERS in the pause menu
  await p.keyboard.press('Escape');
  await panelIs(p, 'pause');
  const noBtn = await p.evaluate(() => { const b = document.querySelector('.fr-pause-fleet'); return !b || b.hidden || b.getClientRects().length === 0; });
  await p.keyboard.press('Escape');
  await panelIs(p, null);
  check('U13: a pilot without a fleet sees no FLEET ORDERS in the pause menu', noBtn);
  check('setup: docked', await dock(p));
  await sleep(300);
  check('U1: docking and the station overview fetch neither the fleetPanel nor the fleetKit chunk', !o.chunks.includes('fleetPanel') && !o.chunks.includes('fleetKit'), o.chunks);
  const tick0 = await p.evaluate(() => window.__galaxiaFreeRoam.state.tick);
  check('U1: the FLEET tab opens the panel', await fleetTab(p));
  await p.click('.fr-tab-station');
  await panelIs(p, 'station');
  await fleetTab(p);
  check('U1: the panel chunk and the kit are fetched once each (reopening fetches nothing); opening advanced no tick and deployed nothing', o.chunks.filter((c) => c === 'fleetPanel').length === 1 && o.chunks.filter((c) => c === 'fleetKit').length === 1 && (await p.evaluate(() => window.__galaxiaFreeRoam.state.tick)) === tick0 && (await F(p)).wing === null, { chunks: o.chunks });
  // U2: the empty state with a real way to the shipyard and the crew
  let s = await PS(p);
  let text = await panelText(p);
  check('U2: empty state explains the route (commission below; crew at the Hangar BRIDGE) and focus is inside the panel', s.rows.length === 0 && /NO FLEET VESSELS YET/.test(text) && /BRIDGE/.test(text) && (await focusInPanel(p)), { text: text.slice(0, 400) });
  await p.click(B('hangar'));
  check('U2: HANGAR · BRIDGE really opens the Hangar', await panelIs(p, 'hangar'));
  await fleetTab(p);
  // U3: hulls with the kit's real prices, licences and materials; Heron and Raven never built
  const hulls = await p.$$eval(`${FP} li[data-ship]`, (ls) => ls.map((l) => ({ ship: l.dataset.ship, text: l.innerText })));
  const priced = Object.entries(COMMISSION).every(([id, n]) => hulls.some((h) => h.ship === id && new RegExp(`COMMISSION \\S+ ${n} MARKS`).test(h.text) && /(LICENCE: |NO LICENCE NEEDED)/.test(h.text)));
  text = await panelText(p);
  check('U3: eight hulls listed with materials, the commission (P11.1 table) and licence; Heron and Raven are not offered and the note says why', hulls.length === 8 && priced && !hulls.some((h) => h.ship === 'heron' || h.ship === 'raven') && /Heron and Raven: /.test(text), hulls.map((h) => h.ship + ':' + h.text.replace(/\n/g, ' | ').slice(0, 160)));
  // U4: refusals in the model's words, nothing deducted
  await p.evaluate(() => window.__galaxiaFreeRoam.qaMarks(150));
  await p.click('.fr-tab-station');
  await panelIs(p, 'station');
  await fleetTab(p);
  s = await PS(p);
  const shrikeBtn = s.buttons.find((x) => x.key === 'hull:shrike');
  const why = await p.$eval(`${FP} li[data-ship="shrike"]`, (l) => l.querySelector('.fr-fab-why')?.textContent ?? '');
  const aria = await p.getAttribute(B('hull:shrike'), 'aria-label');
  check('U4: too few marks: CHOOSE HULL disabled, the kit\'s refusal shown and in the accessible name', shrikeBtn?.disabled && why.length > 8 && aria.includes('unavailable') && aria.includes(why), { shrikeBtn, why, aria });
  await p.evaluate(() => window.__galaxiaFreeRoam.qaMarks(2000));
  await p.click('.fr-tab-station');
  await panelIs(p, 'station');
  await fleetTab(p);
  // U5: the purchase flow by mouse; the seated crew member is marked with the kit's reason
  const m0 = (await F(p)).marks;
  await p.click(B('hull:shrike'));
  await sleep(150);
  s = await PS(p);
  const odile = s.buttons.find((x) => x.key === `cap:${ODILE}`);
  const odileWhy = await p.$eval(`${FP} li[data-crew="${ODILE}"]`, (l) => l.querySelector('.fr-fab-why')?.textContent ?? '');
  const confirm0 = s.buttons.find((x) => x.key === 'confirm');
  check('U10: a crew member seated aboard a ship is marked ineligible with the reason (seated, Hangar BRIDGE); CONFIRM waits for a captain', s.step === 'hull' && odile?.disabled && /Petrel/i.test(odileWhy) && /BRIDGE/.test(odileWhy) && confirm0?.disabled, { odile, odileWhy, confirm0 });
  await p.click(B(`cap:${MAREN}`));
  await sleep(150);
  text = await panelText(p);
  check('U5: the review shows name, description, materials, commission, licence and the chosen captain; nothing paid yet', /NEW HULL · SHRIKE/.test(text) && /COMMISSION \S+ 200 MARKS/.test(text) && (await F(p)).marks === m0 && (await PS(p)).buyCaptain === MAREN && (await focusInPanel(p)));
  // U6: double click on CONFIRM: exactly one hull
  await p.dblclick(B('confirm'));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  await sleep(300);
  s = await PS(p);
  let f = await F(p);
  check('U6: a double click on CONFIRM COMMISSION buys one hull (200 marks once, one ledger line) and opens nothing else', f.vessels.list.length === 1 && f.marks === m0 - 200 && (await ledgerHulls(p)) === 1 && s.step === 'list' && s.rows[0]?.name === 'SHRIKE · ESCORT 1' && s.rows[0].state === 'ready', { n: f.vessels.list.length, marks: f.marks, m0, step: s.step, rows: s.rows });
  // U7: keyboard: Enter twice on CONFIRM buys one hull
  await p.click(B('hull:swift'));
  await sleep(150);
  await p.click(B(`cap:${TOBIAH}`));
  await sleep(150);
  await p.focus(B('confirm'));
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  await sleep(300);
  f = await F(p);
  s = await PS(p);
  const panelNow = await p.evaluate(() => window.__galaxiaFreeRoam.panel());
  check('U7: keyboard: Enter, Enter on CONFIRM COMMISSION buys exactly one Swift (two vessels, two ledger lines); the second Enter stays in the panel (at most the new Swift\'s captain choice, never STATION or another purchase)', f.vessels.list.length === 2 && f.vessels.list[1].ship === 'swift' && (await ledgerHulls(p)) === 2 && panelNow === 'fleet' && (s.step === 'list' || s.captainFor === 'fv-2'), { v: f.vessels, panelNow, step: s.step, cf: s.captainFor });
  if (s.step !== 'list') { await p.keyboard.press('Escape'); await sleep(200); }
  // U9: moving a captain is ambiguous: the first press only arms it
  await p.click(B('captain:fv-2'));
  await sleep(150);
  text = await panelText(p);
  await p.click(B(`cap:${MAREN}`));
  await sleep(150);
  s = await PS(p);
  f = await F(p);
  const armedOk = s.pending === `cap:${MAREN}` && f.vessels.list[0].captain === MAREN && /Moves from the SHRIKE · ESCORT 1/.test(await panelText(p));
  await p.click(B(`cap:${MAREN}`));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  await sleep(200);
  f = await F(p);
  check('U9: moving a captain asks first (CONFIRM CAPTAIN, nothing changed), then moves: Maren to the Swift, the Shrike uncrewed, Tobiah back to the roster', armedOk && f.vessels.list[1].captain === MAREN && f.vessels.list[0].captain === null && !f.captains.includes(TOBIAH), { s, v: f.vessels });
  // invalid transfer: the seated crew member cannot take the empty Shrike
  await p.click(B('captain:fv-1'));
  await sleep(150);
  s = await PS(p);
  check('U9: an invalid transfer (seated crew) is refused before anything changes (button disabled with the reason)', s.step === 'captain' && s.buttons.find((x) => x.key === `cap:${ODILE}`)?.disabled === true);
  await p.click(B(`cap:${TOBIAH}`));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  await sleep(200);
  // U11: release needs two presses; Escape cancels the armed press
  await p.click(B('release:fv-1'));
  await sleep(100);
  const armedRel = (await PS(p)).pending === 'release:fv-1';
  await p.keyboard.press('Escape');
  await sleep(150);
  const afterEsc = { panel: await p.evaluate(() => window.__galaxiaFreeRoam.panel()), s: await PS(p), cap: (await F(p)).vessels.list[0].captain };
  await p.click(B('release:fv-1'));
  await sleep(100);
  await p.click(B('release:fv-1'));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  await sleep(200);
  f = await F(p);
  check('U11: RELEASE CAPTAIN arms first; Escape cancels it (panel stays, captain kept); CONFIRM RELEASE returns Tobiah to the roster', armedRel && afterEsc.panel === 'fleet' && afterEsc.s.pending === null && afterEsc.cap === TOBIAH && f.vessels.list[0].captain === null && (await PS(p)).rows[0].state === 'uncrewed', { afterEsc, v: f.vessels });
  await p.click(B('captain:fv-1'));
  await sleep(150);
  await p.click(B(`cap:${TOBIAH}`));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  await sleep(200);
  // U12: out of service and back
  await p.click(B('service:fv-2'));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  await sleep(150);
  const res = (await PS(p)).rows[1];
  await launch(p);
  f = await F(p);
  check('U12: TAKE OUT OF SERVICE keeps the Swift at the station: only the Shrike launches', res.state === 'reserve' && f.wing?.units.length === 1 && f.wing.units[0].vessel === 'fv-1', { res, wing: f.wing });
  await dock(p);
  await fleetTab(p);
  await p.click(B('service:fv-2'));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  check('U12: RETURN TO SERVICE: ready again', (await PS(p)).rows[1].state === 'ready');
  // U13 + U14: in flight, FLEET ORDERS over the pause menu; opening it freezes everything
  await launch(p);
  await until(p, () => window.__galaxiaFreeRoam.fleetCommand().wing?.units.length === 2, 3000);
  check('U17: the flight HUD shows the wing summary (ESCORTS 2 · FOLLOW)', (await hudLine(p)) === 'ESCORTS 2 · FOLLOW', await hudLine(p));
  check('U13: FLEET ORDERS opens the panel from the pause menu', await pauseFleet(p));
  const fr0 = await F(p);
  await sleep(800);
  const fr1 = await F(p);
  s = await PS(p);
  check('U13: in flight the panel lists both vessels as deployed with hull, orders and the all-escorts row; the game stays paused (wing frozen)', s.mode === 'flight' && s.rows.every((r) => r.state === 'flying' && /HULL \d+/.test(r.hull)) && s.buttons.filter((x) => x.key.startsWith('order:')).length === 12 && fr0.phase === 'paused' && JSON.stringify(fr0.wing) === JSON.stringify(fr1.wing) && (await focusInPanel(p)), { s, phase: fr0.phase });
  // §7: flight keys do nothing while the panel is open
  const k0 = await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; return JSON.stringify({ s: r.silent, w: r.weapon ?? null, l: r.lock ?? null, t: r.tick, panel: window.__galaxiaFreeRoam.panel() }); });
  for (const k of ['KeyZ', 'KeyF', 'KeyC', 'KeyX', 'KeyQ']) await p.keyboard.press(k);
  await sleep(200);
  const k1 = await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; return JSON.stringify({ s: r.silent, w: r.weapon ?? null, l: r.lock ?? null, t: r.tick, panel: window.__galaxiaFreeRoam.panel() }); });
  check('U14: the flight keys Z, F, C, X and Q while the panel is open change nothing (silent, weapon, lock, tick) and keep it open', k0 === k1, { k0, k1 });
  // the game's fixed panel keys: S / W (and arrows) move the selection inside the panel, never out of it
  const navKeys = [];
  for (const k of ['KeyS', 'KeyS', 'ArrowDown', 'KeyW']) { await p.keyboard.press(k); await sleep(60); navKeys.push(await p.evaluate(() => document.activeElement?.dataset?.key ?? null)); }
  check('U14: S / W / arrows move the focus between panel actions (the shared panel keys), staying inside the panel', navKeys.every(Boolean) && new Set(navKeys).size >= 2 && (await focusInPanel(p)) && (await p.evaluate(() => window.__galaxiaFreeRoam.panel())) === 'fleet', navKeys);
  // U14: each order for one vessel by click, then for all
  const kinds = {};
  for (const kind of ['hold', 'defend', 'follow']) {
    await p.click(B(`order:fv-2:${kind}`));
    await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
    kinds[kind] = (await F(p)).wing.units.find((u) => u.vessel === 'fv-2').order.kind;
  }
  check('U14: FOLLOW / HOLD / DEFEND for one vessel: that vessel takes each order', kinds.hold === 'hold' && kinds.defend === 'defend' && kinds.follow === 'follow', kinds);
  await p.click(B('order:all:hold'));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  f = await F(p);
  s = await PS(p);
  check('U15: HOLD for all escorts: every unit holds; the panel rows say HOLD', f.wing.units.every((u) => u.order.kind === 'hold') && s.rows.every((r) => r.order === 'HOLD'), s.rows);
  // U16: ATTACK without a lock is unavailable with the authoritative reason
  const atk = s.buttons.find((x) => x.key === 'order:all:attack');
  const atkAria = await p.getAttribute(B('order:all:attack'), 'aria-label');
  check('U16: ATTACK without a locked target is disabled with the kit\'s reason in its accessible name', atk?.disabled && /unavailable/.test(atkAria), { atk, atkAria });
  check('U13: closing the panel restores flight (BACK, then resume)', await closeToFlight(p));
  check('U17: the HUD follows the order (ESCORTS 2 · HOLD)', (await hudLine(p)) === 'ESCORTS 2 · HOLD', await hudLine(p));
  // input restored: real flight keys
  const x0 = (await F(p)).ship.x;
  await fly(p, 'KeyD', 500);
  check('U24: after closing, WASD flies again', (await F(p)).ship.x > x0 + 5);
  // U16: lock a hostile with X, then ATTACK: the escorts take the locked target
  const t = await spawn(p, 'raider', 260, -60);
  await sleep(400);
  await p.keyboard.press('KeyX');
  await sleep(200);
  const lock = await p.evaluate(() => window.__galaxiaFreeRoam.state.lock ?? window.__galaxiaFreeRoam.state.target ?? null);
  await pauseFleet(p);
  s = await PS(p);
  text = await panelText(p);
  await p.click(B('order:all:attack'));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  f = await F(p);
  s = await PS(p);
  check('U16: with the raider locked (X) ATTACK is offered (LOCKED: name) and every escort attacks exactly that target; the rows say ATTACK · name', t !== null && /LOCKED: /.test(text) && f.wing.units.every((u) => u.order.kind === 'attack' && u.order.target === t) && s.rows.every((r) => /^ATTACK · /.test(r.order)), { t, lock, orders: f.wing.units.map((u) => u.order), rows: s.rows });
  await closeToFlight(p);
  check('U17: HUD: ESCORTS 2 · ATTACK', (await hudLine(p)) === 'ESCORTS 2 · ATTACK', await hudLine(p));
  await until(p, (id) => !window.__galaxiaFreeRoam.state.hostiles.some((a) => a.id === id), 15000, t);
  await sleep(400);
  check('U16: the target destroyed, the escorts fall back to Follow (HUD ESCORTS 2 · FOLLOW)', (await F(p)).wing.units.every((u) => u.order.kind === 'follow') && (await hudLine(p)) === 'ESCORTS 2 · FOLLOW', await hudLine(p));
  // U19: a disabled vessel: shown disabled, orders for it refused, the HUD says so
  await p.evaluate(() => window.__galaxiaFreeRoam.qaFleetBlast('fv-2', 1e6));
  await sleep(300);
  const hudDis = await hudLine(p);
  await pauseFleet(p);
  s = await PS(p);
  const disRow = s.rows.find((r) => r.id === 'fv-2');
  const disBtns = s.buttons.filter((x) => x.key.startsWith('order:fv-2:'));
  check('U19: a disabled vessel is shown DISABLED (row and HUD "2 DISABLED"), every order for it is unavailable; the other still takes orders', disRow?.state === 'disabled' && disRow.order === 'DISABLED' && disBtns.length === 4 && disBtns.every((x) => x.disabled) && s.buttons.filter((x) => x.key.startsWith('order:fv-1:') && x.key !== 'order:fv-1:attack').every((x) => !x.disabled) && /2 DISABLED/.test(hudDis), { disRow, disBtns, hudDis });
  // U21: restart from the pause menu: panel closed, the disabled vessel stays disabled, orders Follow
  await p.click(B('back'));
  await panelIs(p, 'pause');
  await sleep(400);
  await p.keyboard.press('KeyR');
  await sleep(150);
  await p.keyboard.press('KeyR');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 4000);
  await sleep(300);
  f = await F(p);
  check('U21: RESTART FLIGHT with the panel used: closed, one unit per vessel, fv-2 still disabled, fv-1 in Follow', (await p.evaluate(() => window.__galaxiaFreeRoam.panel())) === null && f.wing.units.length === 2 && f.wing.units.find((u) => u.vessel === 'fv-2').state === 'disabled' && f.wing.units.find((u) => u.vessel === 'fv-1').order.kind === 'follow', f.wing);
  // U18: dock repairs; the docked panel shows it ready again
  await dock(p);
  await fleetTab(p);
  s = await PS(p);
  check('U18: docking returns the disabled vessel to service: the panel shows both AVAILABLE (ready)', s.mode === 'docked' && s.rows.every((r) => r.state === 'ready'), s.rows);
  // U22: ship change at the Hangar leaves the fleet alone
  await p.click('.fr-tab-hangar');
  await panelIs(p, 'hangar');
  await until(p, () => !!window.__galaxiaFreeRoam.hangar(), 6000);
  await p.click('.fr-hangar-ship[data-ship="swift"]');
  await sleep(150);
  const shipAct = await p.textContent('.fr-hangar-action');
  await p.click('.fr-hangar-action'); // SELECT SHIP arms the switch
  await sleep(300);
  await p.click('.fr-hangar-action'); // CONFIRM · FLY THE SWIFT
  await sleep(300);
  f = await F(p);
  check('U22: switching the flown ship at the Hangar (to the owned Swift) changes nothing in the fleet (two vessels, same captains)', f.owned?.active === 'swift' || (await p.evaluate(() => window.__galaxiaFreeRoam.fleet().active)) === 'swift', { shipAct, active: await p.evaluate(() => window.__galaxiaFreeRoam.fleet().active) });
  check('U22: fleet unchanged by the ship change', f.vessels.list.length === 2 && f.vessels.list[0].captain === TOBIAH && f.vessels.list[1].captain === MAREN, f.vessels);
  // U20: sector change: leave, re-enter, one unit each, Follow; the panel reflects the new wing
  await launch(p);
  await p.keyboard.press('Escape');
  await panelIs(p, 'pause');
  await p.keyboard.press('Escape');
  await panelIs(p, null);
  const ex = await p.evaluate(() => window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'exit'));
  await hold(p, { x: ex.x, y: ex.y + 40 });
  await until(p, (id) => window.__galaxiaFreeRoam.state.focus === id, 3000, ex.id);
  await hold(p, null);
  await p.keyboard.press('KeyE');
  await until(p, () => window.__galaxiaFreeRoam.screen() !== 'flight', 5000);
  await sleep(300);
  check('U20: between sectors the panel is closed', (await p.evaluate(() => window.__galaxiaFreeRoam.panel())) !== 'fleet');
  await enterAny(p);
  await until(p, () => window.__galaxiaFreeRoam.fleetCommand().wing?.units.length === 2, 3000);
  await pauseFleet(p);
  s = await PS(p);
  check('U20: after the sector change: two flying vessels (no duplicate), orders FOLLOW', s.rows.length === 2 && s.rows.every((r) => r.state === 'flying' && r.order === 'FOLLOW') && (await F(p)).wing.units.length === 2, s.rows);
  await closeToFlight(p);
  // U23: reload: the fleet persists, nothing transient (no order, no panel state) is saved
  const sv = await stored(p);
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  check('U23: saved fleet = {seq, list:[{id, ship, captain, status}]} only: no order, no panel step, no wing', JSON.stringify(Object.keys(sv)) === '["seq","list"]' && sv.list.every((v) => JSON.stringify(Object.keys(v)) === '["id","ship","captain","status"]'), sv);
  await guard(p);
  await enterAny(p);
  await until(p, () => window.__galaxiaFreeRoam.fleetCommand().wing?.units.length === 2, 4000);
  check('U23: after a reload: two escorts fly, in Follow; the panel is not loaded until asked for', (await F(p)).wing.units.every((u) => u.order.kind === 'follow') && (await PS(p)) === null);
  // menu: galaxy map from the pause menu, then back
  await p.keyboard.press('Escape');
  await panelIs(p, 'pause');
  await sleep(400);
  const nav = '#fr-pause-navigation';
  if ((await p.getAttribute(nav, 'aria-expanded')) !== 'true') { await p.click(nav); await sleep(400); }
  await p.click('.fr-panel-pause .fr-pause-item:text-matches("^(GALAXY|SYSTEM) MAP$")');
  await until(p, () => window.__galaxiaFreeRoam.screen() !== 'flight', 5000);
  await sleep(300);
  await enterAny(p);
  await until(p, () => window.__galaxiaFreeRoam.fleetCommand().wing?.units.length === 2, 4000);
  check('U20: map and back from the pause menu: still exactly two escorts', (await F(p)).wing.units.length === 2);
  await p.screenshot({ path: '/tmp/pw/p112-escorts.png' });
  await close(o, 'ui');
}

/* the panel chunk failing to load, a legacy save, a captain no longer recruited */
async function uiEdges(browser) {
  const o = await open(browser, { blockPanel: true });
  const { p } = o;
  await guard(p);
  await enterAny(p);
  await dock(p);
  await p.click('.fr-tab-fleet');
  await sleep(1500);
  const l = await lines(p);
  check('U24: panel chunk blocked: FLEET COMMAND UNAVAILABLE is shown, the station stays usable, nothing changed', (await p.evaluate(() => window.__galaxiaFreeRoam.panel())) === 'station' && l.some((x) => /FLEET COMMAND UNAVAILABLE/.test(x)) && (await stored(p)) === null, l.slice(-4));
  await p.click('.fr-tab-launch');
  check('U24: launching still works after the failure', await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 4000));
  o.gate.open = true;
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await enterAny(p);
  await dock(p);
  check('U24: after the connection returns and a reload, the FLEET tab opens', await fleetTab(p));
  await close(o, 'ui-load-failure');

  const g = await open(browser, { legacy: true });
  await guard(g.p);
  await enterAny(g.p);
  await dock(g.p);
  const ok = await fleetTab(g.p);
  const s = await PS(g.p);
  check('U23: a legacy (version 9, no vessels) save: the FLEET tab shows the empty state', ok && s.rows.length === 0 && /NO FLEET VESSELS YET/.test(await panelText(g.p)));
  await close(g, 'ui-legacy');

  const u = await open(browser, { vessels: { seq: 2, list: [{ id: 'fv-1', ship: 'swift', captain: 'brask-ottley', status: 'active' }, { id: 'fv-2', ship: 'shrike', captain: MAREN, status: 'active' }] } });
  await guard(u.p);
  await enterAny(u.p);
  await until(u.p, () => !!window.__galaxiaFreeRoam.fleetCommand().wing, 4000);
  const fw = await F(u.p);
  await dock(u.p);
  await fleetTab(u.p);
  const su = await PS(u.p);
  check('U19: a captain who is not a recruited crew member never flies: only the crewed Shrike deploys; the Swift is listed without that captain', fw.wing?.units.length === 1 && fw.wing.units[0].vessel === 'fv-2' && su.rows.length === 2 && su.rows[0].state === 'uncrewed', { wing: fw.wing, rows: su.rows, v: fw.vessels });
  await close(u, 'ui-unavailable-crew');
}

/* touch: one tap is one action; the panel never covers the flight controls once closed */
async function uiTouch(browser) {
  const o = await open(browser, { touch: true, viewport: { width: 390, height: 844 } });
  const { p } = o;
  await guard(p);
  await enterAny(p);
  await dock(p);
  await p.tap('.fr-tab-fleet');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'fleet' && !!window.__galaxiaFreeRoam.fleetPanel(), 8000);
  await sleep(300);
  await p.tap(B('hull:shrike'));
  await sleep(150);
  await p.tap(B(`cap:${MAREN}`));
  await sleep(150);
  const m0 = (await F(p)).marks;
  await p.tap(B('confirm'));
  await p.tap(B('confirm')).catch(() => {});
  await sleep(500);
  const f = await F(p);
  const s = await PS(p);
  check('U8: touch: two quick taps on CONFIRM COMMISSION buy one hull (200 marks once) and open nothing else', f.vessels.list.length === 1 && f.marks === m0 - 200 && (await ledgerHulls(p)) === 1 && s.step === 'list' && s.captainFor === null, { n: f.vessels.list.length, step: s.step, cf: s.captainFor });
  await p.tap('.fr-tab-launch');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 4000);
  await sleep(300);
  await p.keyboard.press('Escape');
  await panelIs(p, 'pause');
  await sleep(400);
  await pauseFleet(p, true);
  const msgs0 = (await PS(p)).message;
  await p.tap(B('order:all:hold'));
  await until(p, () => !window.__galaxiaFreeRoam.fleetPanel().busy, 3000);
  const held = (await F(p)).wing.units.every((u) => u.order.kind === 'hold');
  check('U8: touch: one tap on HOLD is one order (all units hold)', held && (await PS(p)).message !== msgs0);
  await p.tap(B('back'));
  await panelIs(p, 'pause');
  await sleep(400);
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 4000);
  await sleep(300);
  const hit = await p.evaluate((sel) => {
    const out = {};
    for (const c of ['.fr-fire', '.fr-boost']) {
      const e = document.querySelector(c);
      if (!e || e.getClientRects().length === 0) { out[c] = 'absent'; continue; }
      const r = e.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out[c] = !!at && (at === e || e.contains(at));
    }
    const fp = document.querySelector(sel);
    out.panelGone = !fp || fp.hidden || fp.getClientRects().length === 0;
    return out;
  }, FP);
  check('U24: touch: after closing, FIRE and BOOST receive taps (nothing of the panel left over them)', hit['.fr-fire'] === true && hit.panelGone && hit['.fr-boost'] !== false, hit);
  await close(o, 'ui-touch');
}

/* the eight viewports: docked panel, in-flight panel, the HUD line after closing */
const VIEWPORTS = [[1280, 720], [1920, 1080], [320, 568], [360, 640], [390, 844], [568, 320], [667, 375], [844, 390]];
const layout = (p, minH) => p.evaluate(({ sel, minH }) => {
  const root = document.querySelector(sel);
  const R = (e) => e.getBoundingClientRect();
  const shown = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && R(e).width > 0;
  // the panel's own actions (its body); the shared station tab strip is checked on its own below
  const bs = [...root.querySelectorAll('.fr-menu button')].filter(shown);
  const rr = R(root);
  const texts = [...root.querySelectorAll('p, span, button, h2')].filter(shown);
  const small = bs.filter((b) => R(b).height < minH - 0.5 || R(b).width < 44).map((b) => `${b.dataset.key ?? b.textContent}:${Math.round(R(b).width)}x${Math.round(R(b).height)}`);
  const meet = (a, c) => a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5;
  const overlaps = [];
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) if (meet(R(bs[i]), R(bs[j]))) overlaps.push(`${bs[i].dataset.key}/${bs[j].dataset.key}`);
  return {
    inside: rr.left >= -0.5 && rr.right <= innerWidth + 0.5,
    noSideScroll: document.documentElement.scrollWidth <= innerWidth + 1 && root.scrollWidth <= root.clientWidth + 1,
    clipped: bs.filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.dataset.key),
    font: Math.min(...texts.map((e) => parseFloat(getComputedStyle(e).fontSize))),
    small, overlaps, n: bs.length,
    named: bs.every((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length > 1),
    focus: !!document.activeElement?.closest(sel),
    tab: (() => {
      const t = root.querySelector('.fr-tab-fleet');
      if (!t) return null;
      t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = R(t);
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { reachable: !!at && (at === t || t.contains(at)), current: t.getAttribute('aria-selected') === 'true' || t.getAttribute('aria-current') !== null || t.classList.contains('is-active'), h: Math.round(r.height) };
    })(),
    scrolls: root.scrollHeight <= root.clientHeight + 1 || ['auto', 'scroll'].includes(getComputedStyle(root).overflowY) || ['auto', 'scroll'].includes(getComputedStyle(root.querySelector('.fr-menu') ?? root).overflowY),
  };
}, { sel: FP, minH });
const layoutOk = (m) => m.inside && m.noSideScroll && m.clipped.length === 0 && m.font >= 10 && m.small.length === 0 && m.overlaps.length === 0 && m.named && m.focus && m.scrolls && (m.tab === null || m.tab.reachable);
async function uiViewports(browser) {
  for (const [w, h] of VIEWPORTS) {
    const touch = w < 1000;
    const tag = `${w}x${h}${touch ? ' touch' : ''}`;
    const v = await open(browser, { touch, viewport: { width: w, height: h }, vessels: { seq: 2, list: [{ id: 'fv-1', ship: 'shrike', captain: MAREN, status: 'active' }, { id: 'fv-2', ship: 'swift', captain: TOBIAH, status: 'active' }] } });
    const q = v.p;
    try {
      await guard(q);
      await enterAny(q);
      await dock(q);
      await fleetTab(q);
      await sleep(1000);
      const d = await layout(q, 44);
      await q.screenshot({ path: `/tmp/pw/p112-docked-${w}x${h}.png` });
      check(`U-vp ${tag}: docked FLEET panel: inside the screen, no sideways scroll, no clipped label, text >= 10 px, every action >= 44x44 with a name, no overlap, focus inside, scrollable`, layoutOk(d), d);
      await launch(q);
      await until(q, () => window.__galaxiaFreeRoam.fleetCommand().wing?.units.length === 2, 4000);
      await pauseFleet(q);
      await sleep(1000);
      const fl = await layout(q, 44);
      await q.screenshot({ path: `/tmp/pw/p112-orders-${w}x${h}.png` });
      check(`U-vp ${tag}: in-flight FLEET panel (orders): same checks`, layoutOk(fl), fl);
      await closeToFlight(q);
      await sleep(300);
      const hud = await q.evaluate(() => {
        const e = document.querySelector('.fr-fleet-line');
        const R = (x) => x.getBoundingClientRect();
        const shown = (x) => x && x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden' && getComputedStyle(x).display !== 'none' && R(x).width > 0;
        const meet = (a, c) => a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5;
        const ctl = ['.fr-fire', '.fr-boost', '.fr-wpn', '.fr-lock', '.fr-target', '.fr-flightctl > *', '.fr-hud-buttons button', '.fr-joy', '.fr-stick'].flatMap((s) => [...document.querySelectorAll(s)]).filter(shown);
        const r = e && R(e);
        const fire = document.querySelector('.fr-fire');
        let fireOk = null;
        if (shown(fire)) { const fr = R(fire); const at = document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2); fireOk = !!at && (at === fire || fire.contains(at)); }
        const card = document.querySelector('.fr-shipcard');
        const cr = card && R(card);
        const big = (x) => R(x).width * R(x).height > innerWidth * innerHeight * 0.4;
        // what a player reads or presses: buttons and elements carrying their own text (layout wrappers are not obstacles)
        const leaf = (x) => x.tagName === 'BUTTON' || [...x.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const others = [...document.querySelectorAll('.fr-flight *')].filter((x) => shown(x) && cr && !card.contains(x) && !x.contains(card) && x.tagName !== 'CANVAS' && leaf(x) && !big(x) && getComputedStyle(x).opacity !== '0');
        // the strip the fleet line adds to the card (its top down to the card's bottom); at 568x320 the card itself
        // already touches SILENT by 3 px without any fleet (inherited, reported), so only the added strip is judged
        const strip = cr && r ? { left: cr.left, right: cr.right, top: r.top, bottom: cr.bottom } : null;
        const cardHits = strip ? others.filter((x) => meet(strip, R(x))).map((x) => x.className) : [];
        return { cardHits, text: e?.textContent ?? '', shown: shown(e), inside: !!r && r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5, clipped: !!e && e.scrollWidth > e.clientWidth + 1, font: e ? parseFloat(getComputedStyle(e).fontSize) : 0, hits: r ? ctl.filter((c) => meet(r, R(c))).map((c) => c.className) : [], fireOk, panel: window.__galaxiaFreeRoam.panel() };
      });
      await q.screenshot({ path: `/tmp/pw/p112-hud-${w}x${h}.png` });
      check(`U-vp ${tag}: after closing: HUD "ESCORTS 2 · FOLLOW" inside the screen, unclipped, >= 10 px, clear of every flight control, the strip it adds to the card clear of the other HUD elements; FIRE takes taps (touch)`, hud.panel === null && hud.text === 'ESCORTS 2 · FOLLOW' && hud.shown && hud.inside && !hud.clipped && hud.font >= 10 && hud.hits.length === 0 && hud.cardHits.length === 0 && (touch ? hud.fireOk === true : true), hud);
    } catch (e) {
      check(`U-vp ${tag}: ran to the end`, false, String(e?.stack ?? e).slice(0, 400));
    }
    await close(v, `viewport ${tag}`);
  }
}

const browser = await chromium.launch();
console.log(`browser: chromium ${browser.version()} (Playwright, automated; no physical device)`);
const ONLY = (process.env.P11_ONLY ?? '').split(',').filter(Boolean);
for (const [name, fn] of [['main', main], ['failure', failure], ['ui', uiMain], ['ui-edges', uiEdges], ['ui-touch', uiTouch], ['ui-viewports', uiViewports]]) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  try { await fn(browser); } catch (e) { check(`${name}: ran to the end`, false, String(e?.stack ?? e).slice(0, 600)); }
}
await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? '\nFAILED:\n' + failed.map((c) => '  ' + c.name).join('\n') : ''}`);
process.exit(failed.length ? 1 : 0);
