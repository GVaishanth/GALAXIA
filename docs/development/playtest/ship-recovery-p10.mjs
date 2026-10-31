// P10.1 ship roster expansion and towable hull recovery in a real browser (QA build: needs window.__galaxiaFreeRoam).
//   node ship-recovery-p10.mjs [pageUrl] [chromium]
// Every gameplay step uses the game's own input path:
//   - E (INTERACT) opens the Raid Box, takes and releases the tow, and docks;
//   - WASD flies; Z is Silent Running; F the ship ability;
//   - the Hangar is driven by clicks.
// The hooks place the ship (test placement, as earlier harnesses do) and read the status snapshots (salvage(), hangar(),
// fleet(), profile()).
//
// Delivery: the ship is guided toward the station by test placement at a steady 180 px/s (below the towing cap) while
// the hull follows through the game's tow simulation; the final dock is the real E key. Scenarios:
//   1.  ten ships in the Hangar (after the first dock; its chunk loads once, at that dock, never before);
//   2.  Harrier and Crane bought with cargo through the normal ACQUIRE / CONFIRM flow;
//   3.  Heron and Raven locked ("LOCKED · RECOVERED, NEVER SOLD", the Raid Box sector named, no ACQUIRE);
//   4.  Kestrel Verge: the recovery chunk is fetched once on entry (never in Sol), and the Raid Box is where the source
//       puts it, clear of solids;
//   5.  E on the box: "RAID BOX OPENED", the hull at its rest point, the box done, the Heron still locked;
//   6.  E on the hull: a real attach (TOW LINE ON), the tow status reads towed;
//   7.  real flight with WASD: the hull follows through a straight run, a turn and a stop; never a jump, always within
//       the tether;
//   8.  penalties: top speed capped at max x 0.7 while towing, the run's tuning untouched, full speed after release;
//       Silent Running and the ability key still work while towing;
//   9.  invalid / interrupted tows (too fast, snapped, RESTART FLIGHT, released) never grant the ship;
//   10. delivery: docking with the hull on the line gives "HERON RECOVERED" once;
//   11. the Heron is owned (the Petrel still flown), selectable in the Hangar, and flies with Survey Sweep;
//   12. a reload keeps the Heron and the opened box;
//   13. no duplicate: re-entering Kestrel Verge shows no hull, no box prompt and fetches no recovery chunk;
//   14. regressions: Raven's Quiet Hull (signature 0.6, Silent Running lower), marks / heat / missions untouched by the
//       recovery, and the failure paths (recovery and Hangar chunks aborted: a visible notice, nothing half-made).
//
// P10.2 (tow HUD, Hangar polish, guide), scenarios 15-35:
//   15. the hull prompt reads TOW HULL · HERON (data-tow=ready) only when a press would attach;
//   16. too fast: the prompt says TOO FAST · MATCH ITS SPEED (refused) and one press gives one TOW · TOO FAST, no tow;
//   17. a body on the line: LINE BLOCKED BY A BODY (refused) and one press gives one TOW · LINE BLOCKED, no tow;
//   18. attached: RELEASE TOW · HERON with TOW ATTACHED · n/260 (data-risk=ok), named for screen readers;
//   19. strain: one TOW LINE STRAINED notice, the prompt adds STRAINED in words (data-risk=strain), still towed;
//   20. no notice spam: held strained or hovering at the threshold never re-warns; well inside re-arms it;
//   21. a body across the line: LINE BLOCKED in the prompt (data-risk=blocked), then one TOW LINE CUT BY A BODY;
//   22. at the station with the hull on the line: DOCK · HAVEN GUILD STATION / DELIVERS THE HERON;
//   23. at the exit beacon while towing: TOWING HERON · LEAVING DROPS THE TOW;
//   24. leaving the sector while towing: one TOW LOST · LEFT THE SECTOR note on the next flight; the hull back at rest;
//   25. RESTART FLIGHT while towing: one TOW LOST · HULL LEFT BEHIND · FLIGHT RESTARTED;
//   26. a wreck while towing: one TOW LOST · HULL LEFT BEHIND · SHIP WRECKED; nothing owned;
//   27. <SHIP> RECOVERED appears only on the delivering dock (never after a release, snap, cut, restart, wreck or exit);
//   28. touch: one tap on the prompt is one request (attach), the next tap releases;
//   29. the tow prompt at 1280x720, 1920x1080, 320x568, 360x640, 390x844, 568x320, 667x375 and 844x390: inside the
//       screen, not clipped, text >= 10 px, clear of FIRE / BOOST / WPN / LOCK / STOP / SILENT / ability / HUD buttons;
//   30. the Hangar names each of the ten ships' signature abilities (the ability table's names, one per ship);
//   31. Harrier and Crane show the catalogue's licence and cargo terms; buying needs CONFIRM; no double purchase;
//   32. Heron and Raven: recovery terms with the sector and station, no price; a recovered Heron flies with no tow,
//       no penalty, stock speed and its own ability;
//   33. HOW TO PLAY (pause) holds the recovery loop with the real sectors and Winch Lock, and no Admin text;
//   34. recovery chunk still loading: RECOVERY SYSTEMS LOADING · TRY AGAIN, the box stays shut, the next press opens it;
//   35. towing steals no control: FIRE shoots, the ability key answers, Silent Running toggles, X never drops the tow.
// Automated Chromium only (Playwright); no physical device was used.
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SOL = 'milky-way/sol';
const KV = 'milky-way/kestrel-verge';
const LG = 'milky-way/lantern-gate';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};
function pilot(system, active = 'petrel', owned = ['petrel'], cargo = { scrap: 30, fuel: 12, ice: 4, alloy: 24 }, kvDone = []) {
  return {
    version: 10, createdAt: 1, sessions: 5, flightSeconds: 900, beaconsCharted: 3, surveysCompleted: 3, bestSurveyTicks: 5000,
    currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL, KV, LG], galaxySurveys: { 'milky-way': 3 },
    currentSystem: system, visitedSystems: [SOL, KV, LG], sectors: { [SOL]: { done: [], surveyed: true }, [KV]: { done: kvDone, surveyed: true }, [LG]: { done: [], surveyed: true } },
    cargo,
    fleet: { active, owned, loadouts: {} },
    lostCargo: null, modules: {}, milestones: [],
    progression: { marks: 100, missions: { active: [], completed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], claimed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
    savedAt: 1, resume: null,
  };
}
function seedOnce(rec) {
  if (!sessionStorage.getItem('p10-seeded')) {
    sessionStorage.setItem('p10-seeded', '1');
    localStorage.setItem('galaxia:freeroam', JSON.stringify(rec));
    localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
  }
}
/** Every corner-log line and every notice card title since the page loaded, in order. */
function watchFeed() {
  window.__p10lines = [];
  window.__p10notices = [];
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) for (const e of [n, ...n.querySelectorAll('.fr-feed-line')]) if (e.classList?.contains('fr-feed-line')) window.__p10lines.push(e.textContent);
  }).observe(document, { childList: true, subtree: true });
  let last = '';
  const loop = () => {
    // the visible notice card (other notice elements may exist hidden)
    const card = [...document.querySelectorAll('.fr-notice')].find((n) => !n.closest('[hidden]') && n.getClientRects().length > 0);
    const s = card ? `${card.querySelector('.fr-notice-title')?.textContent ?? ''} · ${card.querySelector('.fr-notice-detail')?.textContent ?? ''}` : '';
    if (s && s !== last) window.__p10notices.push(s);
    last = s;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
const feed = (p) => p.evaluate(() => window.__p10lines.slice());
const notices = (p) => p.evaluate(() => window.__p10notices.slice());
const S = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  const r = f.state;
  const h = r?.hulk;
  return {
    screen: f.screen(), panel: f.panel(), phase: r?.phase, docked: r?.docked ?? null, tick: r?.tick, ship: r?.craft?.ship,
    x: r?.ship.x, y: r?.ship.y, speed: r ? Math.hypot(r.ship.vx, r.ship.vy) : 0, cap: r?.tune.maxSpeed, silent: r?.silent,
    hulk: h ? { x: h.x, y: h.y, towed: h.towed, ship: h.ship } : null, salvage: f.salvage(), fleet: f.fleet(), done: r ? [...r.done].sort() : [],
    marks: f.progression().marks, heat: JSON.stringify(f.heat().factions), missions: JSON.stringify(f.missions?.() ?? null), cargo: JSON.stringify(f.profile().cargo),
  };
});
/** Hold the ship at P every frame (null releases it); keeps it alive and out of encounters (test placement). */
const hold = (p, P) => p.evaluate((P) => {
  window.__p10hold = P;
  if (window.__p10holdLoop) return;
  window.__p10holdLoop = true;
  const loop = () => {
    const run = window.__galaxiaFreeRoam?.state;
    const w = window.__p10hold;
    if (run?.craft && w) Object.assign(run.ship, { x: w.x, y: w.y, px: w.x, py: w.y, vx: 0, vy: 0 });
    if (run?.craft && !window.__p10free) { run.invuln = 1e9; run.hull = run.craft.stats.hull; run.grace = 1e9; } // P10.2: __p10free lets a wreck happen
    requestAnimationFrame(loop);
  };
  loop();
}, P);
const until = async (p, js, ms = 5000, arg = null) => {
  try { await p.waitForFunction(js, arg, { timeout: ms }); return true; } catch { return false; }
};
const errsAll = [];

async function open(browser, { system = KV, ship = 'petrel', owned, cargo, block = null, viewport = { width: 1280, height: 720 }, kvDone = [], touch = false, delay = null } = {}) {
  const ctx = await browser.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.addInitScript(seedOnce, pilot(system, ship, owned ?? [ship], cargo, kvDone));
  await ctx.addInitScript(watchFeed);
  const p = await ctx.newPage();
  const errs = [];
  const chunks = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  // an aborted chunk is the scenario's point: the browser's own "failed to load" console line is expected there
  p.on('console', (m) => m.type() === 'error' && !(block && /Failed to (load|fetch)|net::ERR_FAILED|dynamically imported module/i.test(m.text())) && errs.push('console: ' + m.text()));
  p.on('request', (q) => { const m = q.url().match(/\/assets\/(tow|shipyard)-[^/]*\.js$/); if (m) chunks.push(m[1]); });
  if (block) await p.route(`**/assets/${block}-*.js`, (r) => r.abort());
  if (delay) await p.route(`**/assets/${delay.chunk}-*.js`, async (r) => { await sleep(delay.ms); await r.continue(); });
  const url = PAGE + '?mode=freeroam' + (touch ? '&controls=touch' : '');
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  return { ctx, p, errs, chunks };
}
async function enter(p) {
  await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
}
async function close(o, tag) {
  check(`${tag}: no page errors`, o.errs.length === 0, o.errs);
  errsAll.push(...o.errs);
  await o.ctx.close();
}
/** Place the ship at the station and dock with the real E key (the hold is released first: docking needs a free ship). */
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
async function openHangar(p) {
  await p.keyboard.press('BracketRight');
  return until(p, () => window.__galaxiaFreeRoam.panel() === 'hangar' && !!window.__galaxiaFreeRoam.hangar(), 6000);
}
async function launch(p) {
  if ((await p.evaluate(() => window.__galaxiaFreeRoam.panel())) !== 'station') {
    await p.keyboard.press('Escape');
    await until(p, () => window.__galaxiaFreeRoam.panel() === 'station');
  }
  await p.click('.fr-tab-launch');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(200);
}
/** Park the ship at P, release it, and wait for the focus the game computes there. */
async function parkAt(p, P, focus) {
  await hold(p, P);
  await sleep(150);
  await hold(p, null);
  return until(p, (f) => window.__galaxiaFreeRoam.state.focus === f, 2000, focus);
}
/** Record ship and hull every frame until stopped (tick-stamped). */
const record = (p) => p.evaluate(() => {
  window.__p10rec = [];
  window.__p10recOn = true;
  const loop = () => {
    if (!window.__p10recOn) return;
    const r = window.__galaxiaFreeRoam.state;
    const h = r.hulk;
    if (h) window.__p10rec.push({ tick: r.tick, sx: r.ship.x, sy: r.ship.y, hx: h.x, hy: h.y, towed: h.towed, speed: Math.hypot(r.ship.vx, r.ship.vy), d: Math.hypot(r.ship.x - h.x, r.ship.y - h.y) });
    requestAnimationFrame(loop);
  };
  loop();
});
const stopRecord = (p) => p.evaluate(() => { window.__p10recOn = false; return window.__p10rec; });
/** Guide the ship toward T at `speed` px/s (test placement; velocity set to match so the tow sees real motion). */
const glide = (p, T, speed) => p.evaluate(([T, speed]) => new Promise((done) => {
  let last = window.__galaxiaFreeRoam.state.tick;
  const loop = () => {
    const r = window.__galaxiaFreeRoam.state;
    if (!r || r.phase !== 'flight') return done(false);
    r.invuln = 1e9;
    r.grace = 1e9;
    r.hull = r.craft.stats.hull;
    const dt = Math.max(0, r.tick - last) / 60;
    last = r.tick;
    const dx = T.x - r.ship.x;
    const dy = T.y - r.ship.y;
    const d = Math.hypot(dx, dy);
    if (d < 4) { Object.assign(r.ship, { x: T.x, y: T.y, vx: 0, vy: 0 }); return done(true); }
    const step = Math.min(d, speed * dt);
    Object.assign(r.ship, { x: r.ship.x + (dx / d) * step, y: r.ship.y + (dy / d) * step, vx: (dx / d) * speed, vy: (dy / d) * speed });
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}), [T, speed]);
const towed = (p) => until(p, () => window.__galaxiaFreeRoam.state.hulk?.towed === true, 2000);
/** P10.2: the INTERACT button as the player sees it (main line, the tow line, its state attributes). */
const prompt = (p) => p.evaluate(() => {
  const b = document.querySelector('.fr-interact');
  const sub = b.querySelector('.fr-interact-sub');
  return { hidden: b.hidden, text: sub ? b.firstChild.textContent : b.textContent, sub: sub?.textContent ?? '', tow: b.dataset.tow ?? '', risk: b.dataset.risk ?? '', aria: b.getAttribute('aria-label') ?? '' };
});
/** Bring the ship beside the resting hull and take it in tow with E. */
async function attach(p) {
  const h = await p.evaluate(() => { const k = window.__galaxiaFreeRoam.state.hulk; return { x: k.x, y: k.y }; });
  await parkAt(p, { x: h.x, y: h.y - 100 }, 'hulk');
  await p.keyboard.press('KeyE');
  return towed(p);
}

/* ------------------------------------------------- 1 - 3: the Hangar (Sol) */
async function hangar(browser) {
  const o = await open(browser, { system: SOL });
  const { p } = o;
  await enter(p);
  check('1: the Hangar chunk is not fetched on the map or in flight', !o.chunks.includes('shipyard') && !o.chunks.includes('tow'), o.chunks);
  check('1: docking works (real E key)', await dock(p));
  check('1: HANGAR opens on the ship flown', await openHangar(p));
  check('1: the Hangar chunk was fetched once, at the dock', o.chunks.filter((c) => c === 'shipyard').length === 1, o.chunks);
  let h = await p.evaluate(() => ({ st: window.__galaxiaFreeRoam.hangar(), cards: [...document.querySelectorAll('.fr-hangar-ship')].map((b) => b.dataset.ship) }));
  check('1: ten ships in the catalogue, in roster order', h.cards.join() === 'petrel,swift,shrike,condor,magpie,albatross,harrier,crane,heron,raven' && Object.keys(h.st.statuses).length === 10, h);
  check('2/3: Harrier and Crane available (licence met, cargo held); Heron and Raven locked', h.st.statuses.harrier === 'available' && h.st.statuses.crane === 'available' && h.st.statuses.heron === 'locked' && h.st.statuses.raven === 'locked', h.st.statuses);
  // 3: the locked recovery cards
  for (const [id, sector] of [['heron', 'KESTREL VERGE'], ['raven', 'LANTERN GATE']]) {
    await p.click(`.fr-hangar-ship[data-ship="${id}"]`);
    await sleep(150);
    const c = await p.evaluate(() => ({ st: window.__galaxiaFreeRoam.hangar(), text: document.querySelector('.fr-panel-hangar').innerText, btn: (() => { const b = document.querySelector('.fr-hangar-action'); return { hidden: b.hidden, disabled: b.disabled || b.getAttribute('aria-disabled') === 'true', text: b.textContent }; })() }));
    check(`3: ${id}: "LOCKED · RECOVERED, NEVER SOLD", the Raid Box in ${sector} named, no ACQUIRE`, c.st.inspected === id && /LOCKED · RECOVERED, NEVER SOLD/.test(c.text) && c.text.includes(`RAID BOX IN ${sector}`) && !/ACQUIRE/.test(c.btn.text) && (c.btn.hidden || c.btn.disabled), { st: c.st.action, btn: c.btn });
    await p.click('.fr-hangar-action', { force: true }).catch(() => {});
    await sleep(150);
    const f = await p.evaluate(() => window.__galaxiaFreeRoam.fleet());
    check(`3: ${id}: forcing its action changes nothing`, !f.owned.includes(id), f);
  }
  // 2: buy Harrier and Crane through ACQUIRE / CONFIRM
  const cargo0 = (await S(p)).cargo;
  for (const id of ['harrier', 'crane']) {
    await p.click(`.fr-hangar-ship[data-ship="${id}"]`);
    await p.click('.fr-hangar-action');
    const armed = await p.evaluate(() => window.__galaxiaFreeRoam.hangar());
    await p.click('.fr-hangar-action');
    await sleep(150);
    const f = await p.evaluate(() => ({ fleet: window.__galaxiaFreeRoam.fleet(), st: window.__galaxiaFreeRoam.hangar() }));
    check(`2: ${id}: ACQUIRE asks to confirm, then pays cargo and adds it (the Petrel still flown)`, armed.pending === 'acquire' && /CONFIRM · PAY/.test(armed.action) && f.fleet.owned.includes(id) && f.fleet.active === 'petrel' && f.st.statuses[id] === 'owned', { armed, f });
  }
  const s = await S(p);
  const c0 = JSON.parse(cargo0);
  const c1 = JSON.parse(s.cargo);
  check('2: the cargo price was paid exactly (alloy 10 + fuel 8, then scrap 14 + alloy 8)', c1.alloy === c0.alloy - 18 && c1.fuel === c0.fuel - 8 && c1.scrap === c0.scrap - 14 && s.marks === 100, { c0, c1, marks: s.marks });
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:freeroam')).fleet.owned);
  check('2: the purchases are saved at once', saved.includes('harrier') && saved.includes('crane') && !saved.includes('heron'), saved);
  await close(o, 'hangar');
}

/* ------------------------------------------------- 4 - 13: the Heron recovery in Kestrel Verge */
async function recovery(browser) {
  const o = await open(browser, { system: KV });
  const { p } = o;
  await enter(p);
  await until(p, () => window.__galaxiaFreeRoam.salvage().recovery === 'ready', 5000);
  let s = await S(p);
  const box = await p.evaluate(() => window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'raidbox'));
  check('4: entering Kestrel Verge fetches the recovery chunk once (status ready); no hull before the box is opened', o.chunks.filter((c) => c === 'tow').length === 1 && s.salvage.recovery === 'ready' && s.hulk === null && s.salvage.next === 'OPEN THE RAID BOX', { chunks: o.chunks, s: s.salvage });
  check('4: one Raid Box, id raidbox, at the source position (600, 2400), naming the Heron', box?.id === 'raidbox' && box.x === 600 && box.y === 2400 && box.target === 'heron', box);
  // 5: open the box with E
  check('5: the box takes the INTERACT prompt', await parkAt(p, { x: 600, y: 2420 }, 'raidbox'));
  await p.keyboard.press('KeyE');
  await until(p, () => !!window.__galaxiaFreeRoam.state.hulk, 2000);
  s = await S(p);
  check('5: E opens the box: the hull rests at (600, 2550), the box is done, the Heron is NOT owned', s.hulk && s.hulk.x === 600 && s.hulk.y === 2550 && !s.hulk.towed && s.done.includes('raidbox') && !s.fleet.owned.includes('heron') && s.salvage.recovered.heron === false, s);
  // the card may queue behind the sector's arrival notice (ui/notices.ts)
  const shown = await until(p, () => [...window.__p10notices, ...window.__p10lines].some((n) => /RAID BOX OPENED · A DISABLED HERON · TOW IT TO A STATION/.test(n)), 8000);
  check('5: "RAID BOX OPENED · A DISABLED HERON · TOW IT TO A STATION"', shown, { notices: await notices(p), feed: (await feed(p)).slice(-4) });
  await p.keyboard.press('KeyE');
  await sleep(200);
  check('5: a second press near the box opens nothing new (one hull)', (await notices(p)).filter((n) => /RAID BOX OPENED/.test(n)).length <= 1 && (await S(p)).hulk !== null);
  // 9a: too fast to attach
  const h0 = (await S(p)).hulk;
  await parkAt(p, { x: 600, y: 2450 }, 'hulk');
  await p.evaluate(() => { window.__galaxiaFreeRoam.state.ship.vx = 200; });
  await p.keyboard.press('KeyE');
  await sleep(200);
  s = await S(p);
  check('9: a fast approach is refused (TOW · TOO FAST): no tow, nothing owned', (await feed(p)).some((l) => /TOW · TOO FAST/.test(l)) && s.hulk && !s.hulk.towed && !s.fleet.owned.includes('heron'), await feed(p));
  // 6: the real attach
  await hold(p, { x: h0.x, y: h0.y - 100 });
  await sleep(150);
  await hold(p, null);
  await p.keyboard.press('KeyE');
  check('6: E on the hull attaches the tow (TOW LINE ON); the status reads towed', (await towed(p)) && (await feed(p)).some((l) => /TOW LINE ON · DOCK AT A STATION TO DELIVER/.test(l)) && (await S(p)).salvage.tow.state === 'towed' && (await S(p)).salvage.next === 'DOCK AT A STATION');
  // 7 + 8: real flight with WASD
  await record(p);
  await p.keyboard.down('KeyD');
  await sleep(2200);
  s = await S(p);
  const cap0 = s.cap;
  const pen = s.salvage.tow.penalty;
  await p.keyboard.up('KeyD');
  await p.keyboard.down('KeyW');
  await sleep(1500);
  await p.keyboard.up('KeyW');
  await sleep(4000); // stop: the hull coasts on, the line catches it, it settles
  const rec = await stopRecord(p);
  let jump = 0;
  for (let i = 1; i < rec.length; i++) {
    const dt = rec[i].tick - rec[i - 1].tick;
    if (dt > 0) jump = Math.max(jump, Math.hypot(rec[i].hx - rec[i - 1].hx, rec[i].hy - rec[i - 1].hy) / dt);
  }
  const maxD = Math.max(...rec.map((r) => r.d));
  const vmax = Math.max(...rec.map((r) => r.speed));
  s = await S(p);
  check('7: the hull follows by flight (straight, turn, stop): never more than 8 px a tick, always within the tether, still towed', rec.length > 200 && jump < 8 && maxD < 260 && rec.every((r) => r.towed) && s.hulk.towed, { n: rec.length, jump, maxD });
  const moved = Math.hypot(rec.at(-1).hx - rec[0].hx, rec.at(-1).hy - rec[0].hy);
  check('7: the hull really travelled with the ship and settled near the rest length', moved > 400 && s.salvage.tow.distance > 90 && s.salvage.tow.distance <= 130, { moved, d: s.salvage.tow.distance });
  check('8: towing penalty {accel 0.55, speed 0.7}; top speed at most cap x 0.7; the run tuning untouched', pen.accel === 0.55 && pen.speed === 0.7 && vmax <= cap0 * 0.7 + 1 && vmax > cap0 * 0.6 && s.cap === cap0, { pen, vmax, cap0 });
  // 8: Silent Running and the ability key while towing
  await p.keyboard.press('KeyZ');
  await sleep(150);
  const silentOn = (await S(p)).silent;
  await p.keyboard.press('KeyZ');
  await sleep(150);
  check('8: Silent Running toggles while towing; the tow holds', silentOn === true && (await S(p)).silent === false && (await S(p)).hulk.towed);
  // 9b: RESTART FLIGHT while towing: lost, hull stays, nothing owned
  const hb = (await S(p)).hulk;
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(400);
  await p.keyboard.press('KeyR'); // RESTART FLIGHT asks once; the second R confirms (as ship-abilities-p08)
  await sleep(150);
  await p.keyboard.press('KeyR');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 4000);
  s = await S(p);
  check('9: RESTART FLIGHT ends the tow (TOW LOST · HULL LEFT BEHIND); the hull stays put; nothing owned', (await feed(p)).some((l) => /TOW LOST · HULL LEFT BEHIND/.test(l)) && s.hulk && !s.hulk.towed && Math.hypot(s.hulk.x - hb.x, s.hulk.y - hb.y) < 2 && !s.fleet.owned.includes('heron'), { s: s.hulk, hb });
  // 9c: snap, 9d: release
  check('9: re-attach works after an interruption', await attach(p));
  await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; Object.assign(r.ship, { x: r.hulk.x + 400, y: r.hulk.y }); });
  await until(p, () => window.__galaxiaFreeRoam.state.hulk?.towed === false, 2000);
  s = await S(p);
  check('9: stretched past 260 the line snaps (TOW LINE SNAPPED · HULL LEFT BEHIND); nothing owned', (await feed(p)).some((l) => /TOW LINE SNAPPED · HULL LEFT BEHIND/.test(l)) && !s.hulk.towed && !s.fleet.owned.includes('heron'));
  await attach(p);
  await sleep(300);
  await p.keyboard.press('KeyE'); // RELEASE TOW (no station in reach)
  await until(p, () => window.__galaxiaFreeRoam.state.hulk?.towed === false, 2000);
  s = await S(p);
  check('9: E again releases the tow (TOW RELEASED); full speed returns; nothing owned', (await feed(p)).some((l) => /TOW RELEASED/.test(l)) && s.salvage.tow.penalty.speed === 1 && !s.fleet.owned.includes('heron'));
  // 10: delivery
  check('10: attach for the delivery run', await attach(p));
  const stn = await p.evaluate(() => window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'station'));
  const start = await S(p);
  // guided along a line clear of the star (via a waypoint east of the hull), then up to the dock from the south
  await glide(p, { x: start.x + 300, y: start.y - 300 }, 180);
  await glide(p, { x: stn.x, y: stn.y + 80 }, 180);
  await sleep(300);
  s = await S(p);
  // the reward check compares the moment of delivery only (flying the real sector may collect pickups on the way)
  const base = { marks: s.marks, heat: s.heat, missions: s.missions, cargo: s.cargo };
  check('10: the hull arrives on the line at the station (still towed, focus on the station)', s.hulk?.towed === true && (await p.evaluate(() => window.__galaxiaFreeRoam.state.focus)) === stn.id, { hulk: s.hulk, focus: await p.evaluate(() => window.__galaxiaFreeRoam.state.focus) });
  const pr22 = await prompt(p);
  check('22: at the station with the hull on the line: DOCK · HAVEN GUILD STATION / DELIVERS THE HERON · n/260', !pr22.hidden && pr22.text === 'DOCK · HAVEN GUILD STATION' && /^DELIVERS THE HERON · \d+\/260$/.test(pr22.sub) && pr22.tow === 'towing', pr22);
  check('27: no HERON RECOVERED notice before the delivering dock (after the refusal, release, snap and restart above)', ![...(await notices(p)), ...(await feed(p))].some((n) => /(HERON|RAVEN) RECOVERED/.test(n)));
  await p.keyboard.press('KeyE');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'station', 3000);
  await sleep(300);
  s = await S(p);
  const nts = await notices(p);
  const fl = await feed(p);
  await until(p, () => [...window.__p10notices, ...window.__p10lines].some((n) => /HERON RECOVERED/.test(n)), 6000);
  check('10: docking delivers it: "HERON RECOVERED · NOW IN YOUR HANGAR" once; the Heron owned, the Petrel still flown', s.fleet.owned.includes('heron') && s.fleet.active === 'petrel' && s.hulk === null && [...nts, ...fl].filter((n) => /HERON RECOVERED/.test(n)).length === 1, { owned: s.fleet, nts, fl: fl.slice(-6) });
  check('14: the delivering dock pays no marks and changes no cargo, heat or missions (no second reward system)', s.marks === base.marks && s.heat === base.heat && s.missions === base.missions && s.cargo === base.cargo, { s: [s.marks, s.heat, s.cargo], base });
  // 11: selectable in the Hangar; flies with its ability
  check('11: HANGAR opens', await openHangar(p));
  let st = await p.evaluate(() => window.__galaxiaFreeRoam.hangar());
  check('11: the Heron is owned in the Hangar (not locked)', st.statuses.heron === 'owned' && st.statuses.raven === 'locked', st.statuses);
  await p.click('.fr-hangar-ship[data-ship="heron"]');
  await p.click('.fr-hangar-action');
  await p.click('.fr-hangar-action');
  await sleep(200);
  s = await S(p);
  check('11: SELECT SHIP + CONFIRM makes the Heron the ship flown', s.fleet.active === 'heron', s.fleet);
  await launch(p);
  s = await S(p);
  check('11: it launches as the Heron with Survey Sweep', s.ship === 'heron' && s.salvage.abilityId === 'survey-sweep', { ship: s.ship, a: s.salvage.abilityId });
  const fresh = await p.evaluate(() => { const f = window.__galaxiaFreeRoam; const r = f.state; return { tow: f.salvage().tow, hulk: r.hulk, cap: r.tune.maxSpeed, stock: r.craft.stats.maxSpeed, hull: r.hull, max: r.craft.stats.hull, ab: f.ability() }; });
  check('32: the recovered Heron flies with no tow or hull, no penalty, stock speed and full hull, its ability not active or cooling', fresh.hulk === null && (fresh.tow === null || (fresh.tow.state === 'none' && fresh.tow.penalty.speed === 1 && fresh.tow.penalty.accel === 1)) && fresh.cap === fresh.stock && fresh.hull === fresh.max && fresh.ab.id === 'survey-sweep' && !fresh.ab.active && fresh.ab.cooldownTicks === 0, fresh);
  // 12: reload keeps it
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  const prof = await p.evaluate(() => { const r = JSON.parse(localStorage.getItem('galaxia:freeroam')); return { owned: r.fleet.owned, active: r.fleet.active, done: r.sectors['milky-way/kestrel-verge'].done, raw: localStorage.getItem('galaxia:freeroam') }; });
  check('12: after a reload the Heron is still owned and the box still done; no tow or hull geometry in the save', prof.owned.includes('heron') && prof.done.includes('raidbox') && !/hulk|towed|tether/.test(prof.raw), { owned: prof.owned, done: prof.done });
  // 13: no duplicate
  const before = o.chunks.length;
  await enter(p);
  await sleep(500);
  await parkAt(p, { x: 600, y: 2420 }, '__none__');
  await sleep(200);
  s = await S(p);
  const focus = await p.evaluate(() => window.__galaxiaFreeRoam.state.focus);
  await p.keyboard.press('KeyE');
  await sleep(200);
  const s2 = await S(p);
  check('13: re-entry: no hull, no box prompt, no recovery chunk fetched; E there grants nothing', s.hulk === null && focus !== 'raidbox' && focus !== 'hulk' && !o.chunks.slice(before).includes('tow') && s.salvage.recovered.heron === true && s2.fleet.owned.filter((x) => x === 'heron').length === 1, { hulk: s.hulk, focus, chunks: o.chunks.slice(before) });
  await close(o, 'recovery');
}

/* ------------------------------------------------- 14: abilities / stealth, and the failure paths */
async function regressions(browser) {
  // Raven (owned in this save) in Lantern Gate: Quiet Hull through the real F key
  const o = await open(browser, { system: LG, ship: 'raven', owned: ['petrel', 'raven'] });
  const { p } = o;
  await enter(p);
  await hold(p, { x: 1400, y: 2200 });
  await sleep(200);
  const sig = () => p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; return { silent: r.silent, a: window.__galaxiaFreeRoam.ability() }; });
  await p.keyboard.press('KeyF');
  await sleep(200);
  const a1 = await sig();
  await p.keyboard.press('KeyZ');
  await sleep(150);
  const a2 = await sig();
  const ln = await feed(p);
  check('14: Raven: F starts Quiet Hull and Silent Running stays available (Z turns it on during it)', a1.a?.id === 'quiet-hull' && a1.a.active === true && a2.silent === true && !ln.some((l) => /SILENT RUNNING OFF — ABILITY INPUT/.test(l)), { a1, a2 });
  const st = await S(p);
  check('14: a Raven owned in the save means Lantern Gate has no hull and fetches no recovery chunk', st.hulk === null && !o.chunks.includes('tow'), o.chunks);
  await close(o, 'raven');

  // the recovery chunk fails to load: a visible notice, nothing half-made, the box stays shut
  const f = await open(browser, { system: KV, block: 'tow' });
  await enter(f.p);
  await until(f.p, () => window.__galaxiaFreeRoam.salvage().recovery === 'failed', 5000);
  await parkAt(f.p, { x: 600, y: 2420 }, 'raidbox');
  await f.p.keyboard.press('KeyE');
  await sleep(300);
  let s = await S(f.p);
  const fl = await feed(f.p);
  check('14: recovery chunk aborted: "RECOVERY SYSTEMS UNAVAILABLE", the box stays shut (not done), no hull, nothing owned', s.salvage.recovery !== 'ready' && fl.some((l) => /RECOVERY SYSTEMS UNAVAILABLE/.test(l)) && !s.done.includes('raidbox') && s.hulk === null && !s.fleet.owned.includes('heron'), { rec: s.salvage.recovery, fl: fl.slice(-4), done: s.done });
  // flight continues normally without it
  await f.p.keyboard.down('KeyD');
  await sleep(1200);
  await f.p.keyboard.up('KeyD');
  s = await S(f.p);
  check('14: without the recovery chunk the sector still flies normally (no penalty, no tow)', s.phase === 'flight' && s.salvage.tow === null);
  // the network comes back: the next press asks again (report what the browser does with the retried import)
  await f.p.unroute('**/assets/tow-*.js');
  await f.p.keyboard.press('KeyE');
  const retried = await until(f.p, () => window.__galaxiaFreeRoam.salvage().recovery === 'ready', 4000);
  console.log(`INFO retry after the network returns: recovery status ${retried ? 'ready (the import was retried)' : JSON.stringify((await S(f.p)).salvage.recovery) + ' (the browser kept the failed module; a reload recovers)'}`);
  await close(f, 'tow-abort');

  // the Hangar chunk fails to load: a visible notice; the station hub still works
  const g = await open(browser, { system: SOL, block: 'shipyard' });
  await enter(g.p);
  await dock(g.p);
  await g.p.keyboard.press('BracketRight');
  await sleep(600);
  const gs = await S(g.p);
  const gl = await feed(g.p);
  check('14: Hangar chunk aborted: "HANGAR UNAVAILABLE", the station panel stays usable, the fleet unchanged', gs.panel === 'station' && gl.some((l) => /HANGAR UNAVAILABLE/.test(l)) && gs.fleet.owned.join() === 'petrel', { panel: gs.panel, gl: gl.slice(-4) });
  await launch(g.p);
  check('14: launching from that station still works', (await S(g.p)).phase === 'flight');
  await close(g, 'shipyard-abort');
}

/* ------------------------------------------------------------------ P10.2 helpers */
/** Pin the ship (and optionally the hull) every frame: { x, y, vx?, hx?, hy?, osc?: [a, b] alternating hull offsets }; null stops. */
const pin = (p, P) => p.evaluate((P) => {
  window.__p10pin = P;
  if (window.__p10pinLoop) return;
  window.__p10pinLoop = true;
  let f = 0;
  const loop = () => {
    const r = window.__galaxiaFreeRoam?.state;
    const w = window.__p10pin;
    if (r?.craft && w) {
      Object.assign(r.ship, { x: w.x, y: w.y, px: w.x, py: w.y, vx: w.vx ?? 0, vy: 0 });
      const hx = w.osc ? w.x - w.osc[f++ % 2] : w.hx;
      if (hx !== undefined && r.hulk) Object.assign(r.hulk, { x: hx, y: w.hy ?? w.y, px: hx, py: w.hy ?? w.y, vx: 0, vy: 0 });
    }
    requestAnimationFrame(loop);
  };
  loop();
}, P);
/** Test geometry (as the unit tests): a small body on the line, shaped like one of the sector's own; dropBody restores the layout. */
const addBody = (p, x, y) => p.evaluate(([x, y]) => {
  const r = window.__galaxiaFreeRoam.state;
  window.__p10layout = r.layout;
  const ref = r.layout.landmarks.find((l) => l.kind !== 'star') ?? r.layout.landmarks[0];
  r.layout = { ...r.layout, landmarks: [...r.layout.landmarks, { ...ref, id: 'qa-body', x, y, r: 12, hazardR: 0 }] };
}, [x, y]);
const dropBody = (p) => p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; if (window.__p10layout) r.layout = window.__p10layout; window.__p10layout = null; });
const count = async (p, re) => (await feed(p)).filter((l) => re.test(l)).length;
const ready = (p) => until(p, () => window.__galaxiaFreeRoam.salvage().recovery === 'ready' && !!window.__galaxiaFreeRoam.state?.hulk, 8000);
/** ENTER SECTOR from whichever map is showing (the galaxy map, or the system map after leaving a sector). */
async function enterAny(p) {
  const btn = p.locator('.fr-det-actions >> text=ENTER SECTOR').locator('visible=true').first();
  await btn.click();
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
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

/* --------------------------------------------- 15-27, 35: the tow HUD in Kestrel Verge (box already open) */
async function towHud(browser) {
  const o = await open(browser, { system: KV, kvDone: ['raidbox'] });
  const { p } = o;
  await enter(p);
  check('15: the hull is waiting (box opened in the save, recovery chunk ready)', await ready(p));
  const H = await p.evaluate(() => { const k = window.__galaxiaFreeRoam.state.hulk; return { x: k.x, y: k.y }; });
  const near = { x: H.x, y: H.y - 100 };
  // 15: a press would attach
  await parkAt(p, near, 'hulk');
  await sleep(150);
  let pr = await prompt(p);
  let t = (await S(p)).salvage.tow;
  check('15: beside the still hull: TOW HULL · HERON, ready, no second line; the sim agrees (attach null)', !pr.hidden && pr.text === 'TOW HULL · HERON' && pr.sub === '' && pr.tow === 'ready' && t.attach === null && t.focus === true, { pr, t });
  // 16: too fast
  await pin(p, { ...near, vx: 200 });
  await sleep(250);
  pr = await prompt(p);
  t = (await S(p)).salvage.tow;
  const fast0 = await count(p, /TOW · TOO FAST/);
  await p.keyboard.press('KeyE');
  await sleep(250);
  let s = await S(p);
  check('16: too fast: the prompt says TOO FAST · MATCH ITS SPEED (refused); one press = one TOW · TOO FAST; no tow', pr.text === 'TOW HULL · HERON' && pr.sub === 'TOO FAST · MATCH ITS SPEED' && pr.tow === 'refused' && t.attach === 'speed' && (await count(p, /TOW · TOO FAST/)) === fast0 + 1 && !s.hulk.towed, { pr, t, feed: (await feed(p)).slice(-3) });
  await pin(p, null);
  // 17: a body on the line
  await parkAt(p, near, 'hulk');
  await addBody(p, H.x, H.y - 50);
  await sleep(250);
  pr = await prompt(p);
  t = (await S(p)).salvage.tow;
  const blk0 = await count(p, /TOW · LINE BLOCKED/);
  await p.keyboard.press('KeyE');
  await sleep(250);
  s = await S(p);
  check('17: a body on the line: LINE BLOCKED BY A BODY (refused); one press = one TOW · LINE BLOCKED; no tow', pr.text === 'TOW HULL · HERON' && pr.sub === 'LINE BLOCKED BY A BODY' && pr.tow === 'refused' && t.attach === 'blocked' && (await count(p, /TOW · LINE BLOCKED/)) === blk0 + 1 && !s.hulk.towed, { pr, t });
  await dropBody(p);
  // 18: attached
  await parkAt(p, near, 'hulk');
  await p.keyboard.press('KeyE');
  const on = await towed(p);
  await sleep(250);
  pr = await prompt(p);
  check('18: attached: RELEASE TOW · HERON over TOW ATTACHED · n/260 (data-risk ok), both in the accessible name', on && pr.text === 'RELEASE TOW · HERON' && /^TOW ATTACHED · \d+\/260$/.test(pr.sub) && pr.tow === 'towing' && pr.risk === 'ok' && pr.aria === `${pr.text}. ${pr.sub}`, pr);
  // 19: strain (the hull held at 85% of the limit)
  const st0 = await count(p, /TOW LINE STRAINED/);
  await pin(p, { ...near, hx: near.x - 221, hy: near.y });
  await sleep(1500);
  pr = await prompt(p);
  t = (await S(p)).salvage.tow;
  check('19: strained: one TOW LINE STRAINED · EASE OFF OR IT SNAPS; STRAINED in words in the prompt (data-risk strain); still towed', (await count(p, /TOW LINE STRAINED · EASE OFF OR IT SNAPS/)) === st0 + 1 && / · STRAINED$/.test(pr.sub) && pr.risk === 'strain' && t.risk === 'strain' && (await S(p)).hulk.towed, { pr, t });
  // 20: hovering at the threshold, then well inside, then strained again
  await pin(p, { ...near, osc: [0.79 * 260, 0.81 * 260], hy: near.y });
  await sleep(1500);
  const c20a = await count(p, /TOW LINE STRAINED/);
  await pin(p, { ...near, hx: near.x - 130, hy: near.y });
  await sleep(500);
  const pr20 = await prompt(p);
  await pin(p, { ...near, hx: near.x - 221, hy: near.y });
  await sleep(500);
  const c20b = await count(p, /TOW LINE STRAINED/);
  check('20: no notice spam: held or hovering at the threshold never re-warns; well inside re-arms (a second stretch warns once)', c20a === st0 + 1 && pr20.risk === 'ok' && !/STRAINED/.test(pr20.sub) && c20b === st0 + 2, { st0, c20a, c20b, pr20 });
  // 21: a body across the line while towing
  await pin(p, { ...near, hx: near.x - 120, hy: near.y });
  await sleep(300);
  const cut0 = await count(p, /TOW LINE CUT BY A BODY/);
  const st1 = await count(p, /TOW LINE STRAINED/);
  await addBody(p, near.x - 60, near.y + 4);
  const sawBlocked = await until(p, () => document.querySelector('.fr-interact')?.dataset.risk === 'blocked' && / · LINE BLOCKED$/.test(document.querySelector('.fr-interact-sub')?.textContent ?? ''), 1000);
  await until(p, () => window.__galaxiaFreeRoam.state.hulk?.towed === false, 2000);
  await sleep(300);
  check('21: a body across the line: LINE BLOCKED in the prompt (data-risk blocked), then one TOW LINE CUT BY A BODY · HULL LEFT BEHIND', sawBlocked && (await count(p, /TOW LINE CUT BY A BODY · HULL LEFT BEHIND/)) === cut0 + 1 && (await count(p, /TOW LINE STRAINED/)) === st1 && !(await S(p)).hulk.towed, { sawBlocked, feed: (await feed(p)).slice(-4) });
  await pin(p, null);
  await dropBody(p);
  // 35: towing steals no control
  check('35: re-attach after the cut', await attach(p));
  const rel0 = await count(p, /TOW RELEASED/);
  await p.keyboard.down('Space');
  const fired = await until(p, () => window.__galaxiaFreeRoam.state.shots.length > 0, 1500);
  await p.keyboard.up('Space');
  const ab0 = await count(p, /SIGNAL CALIBRATION/);
  await p.keyboard.press('KeyF');
  await sleep(250);
  const abAnswered = (await count(p, /SIGNAL CALIBRATION/)) === ab0 + 1;
  await p.keyboard.press('KeyZ');
  await sleep(150);
  const silentOn = (await S(p)).silent;
  await p.keyboard.press('KeyZ');
  await sleep(150);
  await p.keyboard.press('KeyX');
  await sleep(200);
  s = await S(p);
  check('35: while towing FIRE shoots, F answers (one SIGNAL CALIBRATION line), Z toggles Silent Running, X never drops the tow', fired && abAnswered && silentOn === true && s.silent === false && s.hulk.towed && (await count(p, /TOW RELEASED/)) === rel0, { fired, abAnswered, silentOn, towed: s.hulk.towed });
  // 25: RESTART FLIGHT names its cause, once
  const lost0 = await count(p, /TOW LOST/);
  await restartFlight(p);
  let lost = (await feed(p)).filter((l) => /TOW LOST/.test(l)).slice(lost0);
  check('25: RESTART FLIGHT while towing: exactly one TOW LOST · HULL LEFT BEHIND · FLIGHT RESTARTED', lost.length === 1 && lost[0].includes('TOW LOST · HULL LEFT BEHIND · FLIGHT RESTARTED') && !(await S(p)).hulk.towed, lost);
  // 26: a wreck names its cause, once
  check('26: re-attach after the restart', await attach(p));
  const lost1 = await count(p, /TOW LOST/);
  await p.evaluate(() => { window.__p10free = true; const r = window.__galaxiaFreeRoam.state; r.invuln = 0; r.hull = 0; });
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'recovery', 5000);
  lost = (await feed(p)).filter((l) => /TOW LOST/.test(l)).slice(lost1);
  s = await S(p);
  check('26: a wreck while towing: exactly one TOW LOST · HULL LEFT BEHIND · SHIP WRECKED; the hull resting; nothing owned', lost.length === 1 && lost[0].includes('TOW LOST · HULL LEFT BEHIND · SHIP WRECKED') && !s.hulk.towed && !s.fleet.owned.includes('heron'), { lost, panel: s.panel });
  await p.evaluate(() => { window.__p10free = false; });
  await p.click('.fr-recovery-continue');
  await until(p, () => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 4000);
  await sleep(300);
  // 23: at the exit beacon while towing
  check('23: re-attach after the wreck', await attach(p));
  const ex = await p.evaluate(() => window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'exit'));
  await pin(p, { x: ex.x, y: ex.y + 40, hx: ex.x, hy: ex.y + 150 });
  await until(p, (id) => window.__galaxiaFreeRoam.state.focus === id, 2000, ex.id);
  await sleep(200);
  pr = await prompt(p);
  check('23: at the exit beacon while towing: LEAVE SECTOR · EXIT BEACON over TOWING HERON · LEAVING DROPS THE TOW', pr.text === 'LEAVE SECTOR · EXIT BEACON' && pr.sub === 'TOWING HERON · LEAVING DROPS THE TOW' && pr.tow === 'towing', pr);
  // 24: leave with the hull on the line
  const left0 = await count(p, /LEFT THE SECTOR/);
  await pin(p, null);
  await p.keyboard.press('KeyE');
  await until(p, () => window.__galaxiaFreeRoam.screen() !== 'flight', 4000);
  await sleep(300);
  const onMap = await count(p, /LEFT THE SECTOR/);
  await enterAny(p);
  await ready(p);
  await sleep(600);
  const left = (await feed(p)).filter((l) => /LEFT THE SECTOR/.test(l));
  s = await S(p);
  check('24: leaving while towing: one TOW LOST · LEFT THE SECTOR · THE HERON IS BACK AT ITS RAID BOX on the next flight; the hull at rest', onMap === left0 && left.length === left0 + 1 && left.at(-1).includes('TOW LOST · LEFT THE SECTOR · THE HERON IS BACK AT ITS RAID BOX') && s.hulk && !s.hulk.towed && s.hulk.x === 600 && s.hulk.y === 2550 && !s.fleet.owned.includes('heron'), { left0, onMap, left, hulk: s.hulk });
  // 27: no delivery happened here, so nothing was recovered
  check('27: after refusals, strain, a cut, a restart, a wreck and a sector exit: no HERON / RAVEN RECOVERED notice, the Heron not owned', ![...(await notices(p)), ...(await feed(p))].some((n) => /(HERON|RAVEN) RECOVERED/.test(n)) && !(await S(p)).fleet.owned.includes('heron'), [...(await notices(p)), ...(await feed(p))].filter((n) => /RECOVERED/.test(n)));
  await close(o, 'tow-hud');
}

/* --------------------------------------------- 28-29: touch and the eight viewports */
const VIEWPORTS = [[1280, 720], [1920, 1080], [320, 568], [360, 640], [390, 844], [568, 320], [667, 375], [844, 390]];
async function touchAndViewports(browser) {
  const o = await open(browser, { system: KV, kvDone: ['raidbox'], touch: true, viewport: { width: 390, height: 844 } });
  const { p } = o;
  await enter(p);
  await ready(p);
  const H = await p.evaluate(() => { const k = window.__galaxiaFreeRoam.state.hulk; return { x: k.x, y: k.y }; });
  await parkAt(p, { x: H.x, y: H.y - 100 }, 'hulk');
  await sleep(150);
  const on0 = await count(p, /TOW LINE ON/);
  const rel0 = await count(p, /TOW RELEASED/);
  await p.tap('.fr-interact');
  await sleep(400);
  const afterTap = { on: await count(p, /TOW LINE ON/), rel: await count(p, /TOW RELEASED/), towed: (await S(p)).hulk.towed };
  await p.tap('.fr-interact');
  await sleep(400);
  const afterTap2 = { on: await count(p, /TOW LINE ON/), rel: await count(p, /TOW RELEASED/), towed: (await S(p)).hulk.towed };
  check('28: touch: one tap on TOW HULL is one attach (no release with it); the next tap on RELEASE TOW is one release', afterTap.on === on0 + 1 && afterTap.rel === rel0 && afterTap.towed === true && afterTap2.on === on0 + 1 && afterTap2.rel === rel0 + 1 && afterTap2.towed === false, { afterTap, afterTap2 });
  await close(o, 'touch-tow');
  for (const [w, h] of VIEWPORTS) {
    const touch = w < 1000;
    const v = await open(browser, { system: KV, kvDone: ['raidbox'], touch, viewport: { width: w, height: h } });
    const q = v.p;
    const tag = `${w}x${h}${touch ? ' touch' : ''}`;
    try {
      await enter(q);
      await ready(q);
      const K = await q.evaluate(() => { const k = window.__galaxiaFreeRoam.state.hulk; return { x: k.x, y: k.y }; });
      await parkAt(q, { x: K.x, y: K.y - 100 }, 'hulk');
      await sleep(150);
      if (touch) await q.tap('.fr-interact'); else await q.keyboard.press('KeyE');
      await towed(q);
      // the longest tow line: strained
      await pin(q, { x: K.x, y: K.y - 100, hx: K.x - 221, hy: K.y - 100 });
      await sleep(500);
      const m = await q.evaluate(() => {
        const b = document.querySelector('.fr-interact');
        const sub = b.querySelector('.fr-interact-sub');
        const R = (e) => e.getBoundingClientRect();
        const shown = (e) => e && !e.hidden && !e.closest('[hidden]') && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' && R(e).width > 0;
        const rb = R(b);
        const meet = (a, c) => a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5;
        const ctl = ['.fr-fire', '.fr-boost', '.fr-wpn', '.fr-lock', '.fr-target', '.fr-flightctl > *', '.fr-hud-buttons button'].flatMap((s) => [...document.querySelectorAll(s)]).filter(shown);
        return {
          text: b.textContent, shown: shown(b),
          inside: rb.left >= -0.5 && rb.top >= -0.5 && rb.right <= innerWidth + 0.5 && rb.bottom <= innerHeight + 0.5,
          clipped: b.scrollWidth > b.clientWidth + 1 || (!!sub && sub.scrollWidth > sub.clientWidth + 1),
          font: Math.min(parseFloat(getComputedStyle(b).fontSize), sub ? parseFloat(getComputedStyle(sub).fontSize) : 99),
          hits: ctl.filter((e) => e !== b && meet(rb, R(e))).map((e) => e.className), w: Math.round(rb.width), h: Math.round(rb.height),
        };
      });
      check(`29: ${tag}: the strained tow prompt is inside the screen, not clipped, text >= 10 px, >= 44 px tall, clear of every flight control`, m.shown && /STRAINED/.test(m.text) && m.inside && !m.clipped && m.font >= 10 && m.h >= 44 && m.hits.length === 0, m);
      await pin(q, null);
    } catch (e) {
      check(`29: ${tag}: ran to the end`, false, String(e?.stack ?? e).slice(0, 400));
    }
    await close(v, `viewport ${tag}`);
  }
}

/* --------------------------------------------- 30-33: Hangar polish and HOW TO PLAY */
const PAUSE_HEAD = { 'HOW TO PLAY': 'settings' };
async function hangarPolish(browser) {
  const o = await open(browser, { system: SOL });
  const { p } = o;
  await enter(p);
  check('30: dock in Sol', await dock(p));
  check('30: HANGAR opens', await openHangar(p));
  const ABIL = { petrel: 'SIGNAL CALIBRATION', swift: 'VECTOR BURST', shrike: 'PREDATOR FOCUS', condor: 'BULWARK', magpie: 'SALVAGE PULSE', albatross: 'DEEP SCAN', harrier: 'PIVOT JETS', crane: 'WINCH LOCK', heron: 'SURVEY SWEEP', raven: 'QUIET HULL' };
  const seen = {};
  for (const id of Object.keys(ABIL)) {
    await p.click(`.fr-hangar-ship[data-ship="${id}"]`);
    await sleep(120);
    seen[id] = await p.evaluate(() => {
      const a = document.querySelector('.fr-hangar-ability');
      return { ability: a && !a.hidden ? a.textContent : '', name: document.querySelector('.fr-hangar-name')?.textContent ?? '', role: document.querySelector('.fr-hangar-role')?.textContent ?? '', stats: document.querySelector('.fr-hangar-stats')?.innerText ?? '', terms: document.querySelector('.fr-hangar-terms')?.innerText ?? '', action: document.querySelector('.fr-hangar-action')?.textContent ?? '', thumb: !!document.querySelector(`.fr-hangar-ship[data-ship="${window.__galaxiaFreeRoam.hangar().inspected}"] canvas`) };
    });
  }
  check('30: each of the ten ships shows its own name, role, stats and thumbnail, and SIGNATURE ABILITY with the table name', Object.entries(ABIL).every(([id, n]) => seen[id].name === id.toUpperCase() && seen[id].ability.startsWith(`${n} · `) && /s cooldown\. ./.test(seen[id].ability) && seen[id].role && seen[id].thumb) && new Set(Object.values(seen).map((v) => v.stats)).size === 10 && new Set(Object.values(seen).map((v) => v.ability)).size === 10, Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.ability.slice(0, 40)])));
  check('31: Harrier and Crane show the catalogue terms (licence and cargo with the hold)', /LICENCE · /.test(seen.harrier.terms) && /ALLOY 10 · IN HOLD 24/.test(seen.harrier.terms) && /FUEL 8 · IN HOLD 12/.test(seen.harrier.terms) && /LICENCE · /.test(seen.crane.terms) && /SCRAP 14 · IN HOLD 30/.test(seen.crane.terms) && /ALLOY 8 · IN HOLD 24/.test(seen.crane.terms), { h: seen.harrier.terms, c: seen.crane.terms });
  for (const [id, sector] of [['heron', 'KESTREL VERGE'], ['raven', 'LANTERN GATE']]) {
    const v = seen[id];
    check(`32: ${id}: recovery terms (the Raid Box in ${sector}, that sector's station), no price or ACQUIRE`, v.terms.includes(`OPEN THE RAID BOX IN ${sector}`) && v.terms.includes("TOW ITS HULL TO THAT SECTOR'S STATION AND DOCK") && !/PAY|ACQUIRE|IN HOLD|◈/.test(v.terms + v.action) && v.action === 'RECOVERY REQUIRED', { terms: v.terms, action: v.action });
  }
  // 31: buying needs CONFIRM; a second press never pays twice
  const cargo = async () => JSON.parse((await S(p)).cargo);
  await p.click('.fr-hangar-ship[data-ship="harrier"]');
  const c0 = await cargo();
  await p.click('.fr-hangar-action');
  await sleep(150);
  const armed = { text: await p.locator('.fr-hangar-action').textContent(), cargo: await cargo(), owned: (await S(p)).fleet.owned };
  await p.click('.fr-hangar-action');
  await sleep(200);
  const paid = { cargo: await cargo(), owned: (await S(p)).fleet.owned, text: await p.locator('.fr-hangar-action').textContent() };
  await p.click('.fr-hangar-action');
  await sleep(200);
  const again = { cargo: await cargo(), owned: (await S(p)).fleet.owned };
  check('31: ACQUIRE asks CONFIRM first (nothing paid); CONFIRM pays the catalogue price once; the next press pays nothing', /^CONFIRM · PAY/.test(armed.text) && JSON.stringify(armed.cargo) === JSON.stringify(c0) && !armed.owned.includes('harrier') && paid.owned.includes('harrier') && paid.cargo.alloy === c0.alloy - 10 && paid.cargo.fuel === c0.fuel - 8 && JSON.stringify(again.cargo) === JSON.stringify(paid.cargo) && again.owned.filter((x) => x === 'harrier').length === 1, { armed, paid, again });
  // 33: HOW TO PLAY from the pause menu, on the ship step
  await launch(p);
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(300);
  const head = `#fr-pause-${PAUSE_HEAD['HOW TO PLAY']}`;
  if ((await p.getAttribute(head, 'aria-expanded')) !== 'true') { await p.click(head); await sleep(400); }
  await p.click('.fr-panel-pause .fr-pause-item:text-is("HOW TO PLAY")');
  await until(p, () => !!document.querySelector('.guide:not([hidden])'), 4000);
  for (let i = 0; i < 2; i++) { await p.locator('.guide-back').click(); await sleep(200); }
  const g = await p.evaluate(() => { const e = document.querySelector('.guide:not([hidden])'); return { step: e?.dataset.step, text: e?.innerText ?? '' }; });
  check('33: HOW TO PLAY (CHOOSE YOUR SHIP): the recovery loop 1-10 with Kestrel Verge, Lantern Gate and Winch Lock; no Admin text', g.step === 'ships' && /RECOVERING A HULL/.test(g.text) && /Kestrel Verge/.test(g.text) && /Lantern Gate/.test(g.text) && /1 · FIND/.test(g.text) && /10 · FLY IT/.test(g.text) && /WINCH LOCK/.test(g.text) && !/admin/i.test(g.text), { step: g.step, text: g.text.slice(0, 300) });
  await p.locator('.guide-close').click().catch(() => {});
  await close(o, 'hangar-guide');
}

/* --------------------------------------------- 34: the recovery chunk still loading */
async function loading(browser) {
  const o = await open(browser, { system: KV, delay: { chunk: 'tow', ms: 6000 } });
  const { p } = o;
  await enter(p);
  const st0 = (await S(p)).salvage.recovery;
  await parkAt(p, { x: 600, y: 2420 }, 'raidbox');
  await p.keyboard.press('KeyE');
  await sleep(300);
  let s = await S(p);
  check('34: still loading: RECOVERY SYSTEMS LOADING · TRY AGAIN; the box stays shut, no hull, nothing owned', st0 !== 'ready' && (await count(p, /RECOVERY SYSTEMS LOADING · TRY AGAIN/)) === 1 && !s.done.includes('raidbox') && s.hulk === null && !s.fleet.owned.includes('heron'), { st0, rec: s.salvage.recovery, feed: (await feed(p)).slice(-3) });
  await until(p, () => window.__galaxiaFreeRoam.salvage().recovery === 'ready', 10000);
  await parkAt(p, { x: 600, y: 2420 }, 'raidbox');
  await p.keyboard.press('KeyE');
  const opened = await until(p, () => !!window.__galaxiaFreeRoam.state.hulk, 3000);
  s = await S(p);
  check('34: once loaded, the next press opens the box and the hull appears at its rest point', opened && s.done.includes('raidbox') && s.hulk?.x === 600 && s.hulk?.y === 2550, s.hulk);
  await close(o, 'loading');
}

const browser = await chromium.launch();
console.log(`browser: chromium ${browser.version()} (Playwright, automated; no physical device)`);
const ONLY = (process.env.P10_ONLY ?? '').split(',').filter(Boolean);
for (const [name, fn] of [['hangar', hangar], ['recovery', recovery], ['regressions', regressions], ['towhud', towHud], ['touch', touchAndViewports], ['hangar2', hangarPolish], ['loading', loading]]) {
  if (ONLY.length && !ONLY.includes(name)) continue;
  try { await fn(browser); } catch (e) { check(`${name}: ran to the end`, false, String(e?.stack ?? e).slice(0, 600)); }
}
await browser.close();
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? '\nFAILED:\n' + failed.map((c) => '  ' + c.name).join('\n') : ''}`);
process.exit(failed.length ? 1 : 0);
