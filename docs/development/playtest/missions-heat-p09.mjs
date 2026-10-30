// P09.1 Connected Missions & Faction Heat in a real browser (QA build: needs window.__galaxiaFreeRoam).
//   node missions-heat-p09.mjs [pageUrl]
// Missions are offered, accepted, delivered and turned in through the real station panels (clicks, the
// two-press confirm), ships are destroyed by the real FIRE key and the game's own 60 Hz simulation, and pause
// is the real Escape key. The hooks only seed the save (localStorage, as freeroam-p11 does), place ships
// (test placement, as earlier harnesses do; qaSpawn spawns a Red Tally raider) and read the read-only
// snapshots (heat(), chains(), missions(), economy()). Scenarios:
//   1.  first stage offered: after its story prerequisite, the Guild dispatch offers the first stage of each
//       chain (Claim Jumpers, Faint Lanterns) and never a later stage; chains() names them as current;
//   2.  accept + real kills + reward once: ACCEPT (two presses) Claim Jumpers, destroy three Red Tally raiders
//       with FIRE (the mission completes from those kills), dock and TURN IN twice: +120 marks once, one ledger
//       line for the mission;
//   3.  next stage unlocks: after the turn-in Fair Shares is offered; with Gleaner heat at Alert it is not, and
//       chains() gives the heat gate as the reason (data, not text);
//   4.  reload: no second reward, the stage is never re-offered, and the heat is still there (saved);
//   5.  hostile acts: those kills raised Red Tally heat (hit + kill per ship), every other faction stayed at 0,
//       and the Quiet -> Wary crossing was logged once;
//   6.  decay: one point after ~720 calm ticks of flight; paused (Escape) nothing moves: heat, calm count and
//       tick are frozen for 3 s, and the count continues from the same value after resume;
//   7.  behaviour: a Red Tally raider 1.12x its detect range away does not acquire the pilot at Quiet and does
//       at Hunt (same placement, fresh page each);
//   8.  Silent Running and Gravity Shadow still decide at Hunt: silent at half the detect range is unseen, and a
//       planet between the raider and the pilot hides the pilot; with neither, it acquires;
//   9.  consequence once: DELIVER the scrap for Fair Shares at the target station, TURN IN: Gleaner heat drops by
//       exactly 20 once; a second press and a reload change nothing more;
//   10. legacy saves: a pre-P09 save (no heat field) loads with every faction Quiet and its missions intact; a
//       malformed heat field is normalised without losing the rest of the save; no page errors;
//   11. contracts are unchanged: the station board posts contracts, ACCEPT takes one (saved) and no heat
//       changes; ABANDON fails it and grants nothing;
//   12. P08 still works: Swift's F starts Vector Burst (status active), and the ability changes no heat.
// P09.2 (the board's GUILD CHAINS and FACTION STANDING sections, the notices; read from the DOM and the feed):
//   U1-U2  both chains shown, each with three stage lines and "STAGE k OF 3";
//   U3-U4  a locked stage gives its reason; the Gleaner gate reads "below 40 when you accept (now N)";
//   U5     an accepted stage stays ACTIVE (and deliverable) when its faction's heat is above the gate;
//   U6-U8  TURN IN pays once, says the consequence and the next stage, the chain card moves on; a reload pays nothing;
//   U9-U10 four factions with canonical labels, value, tier, a meter and a consequence line, equal to heat();
//   U11-U12 one feed notice per real tier crossing (kills: one per crossing, not per hit; turn-in: one);
//   U13-U14 the consequence updates FACTION STANDING; after a reload no heat notice repeats;
//   U15    viewing changes nothing; docked, the sections do not re-render or decay; the pause-menu log shows the
//          same standing, frozen while paused;
//   U16    a legacy save (no heat) and a malformed one show four Quiet factions and the whole board;
//   U17    the contract board sits beside the chains and still accepts (11); U18 P08 (12) and the P06/P07/P08
//          harnesses are run separately;
//   V      viewports 1280x720 ... 320x568, 568x320: no horizontal overflow, cards inside the viewport, focus in
//          the panel (screenshots in <os tmpdir>/p092-shots).
// Automated Chromium only: no physical device was used.
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SOL = 'milky-way/sol';
const SIRIUS = 'milky-way/sirius';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 1200)}`);
};
const STORY3 = ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'];
const missions = (over = {}) => ({ jumps: 0, active: [], completed: [...STORY3], claimed: [...STORY3], failed: [], ready: {}, ...over });
function pilot({ system = SOL, ship = 'petrel', marks = 100, m = missions(), heat, cargo = { scrap: 20, fuel: 8, ice: 4 } } = {}) {
  return {
    version: 10, createdAt: 1, sessions: 5, flightSeconds: 900, beaconsCharted: 3, surveysCompleted: 1, bestSurveyTicks: 5000,
    currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL, SIRIUS], galaxySurveys: { 'milky-way': 1 },
    currentSystem: system, visitedSystems: [SOL, SIRIUS], sectors: { [SOL]: { done: [], surveyed: true }, [SIRIUS]: { done: [], surveyed: true } },
    cargo,
    fleet: { active: ship, owned: [ship], loadouts: {} },
    lostCargo: null, modules: {}, milestones: [],
    progression: { marks, missions: m, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 }, ...(heat === undefined ? {} : { heat }) },
    savedAt: 1, resume: null,
  };
}
function seedOnce(rec) {
  if (!sessionStorage.getItem('p09-seeded')) {
    sessionStorage.setItem('p09-seeded', '1');
    localStorage.setItem('galaxia:freeroam', JSON.stringify(rec));
    localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
  }
}
function watchFeed() {
  window.__p09lines = [];
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) for (const e of [n, ...n.querySelectorAll('.fr-feed-line')]) if (e.classList?.contains('fr-feed-line')) window.__p09lines.push(e.textContent);
  }).observe(document, { childList: true, subtree: true });
}
const feed = (p) => p.evaluate(() => window.__p09lines.slice());
const saved = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:freeroam') ?? 'null'));
/** The read-only snapshots. */
const S = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  const r = f.state;
  const heat = f.heat();
  return {
    screen: f.screen(), panel: f.panel(), phase: r?.phase, tick: r?.tick, silent: r?.silent,
    heat: Object.fromEntries(heat.factions.map((h) => [h.faction, h.value])), tiers: Object.fromEntries(heat.factions.map((h) => [h.faction, h.tierName])), log: heat.log,
    calm: r?.factionHeat ? { ...r.factionHeat.calm } : null,
    chains: f.chains(), keys: f.missions().keys, pending: f.missions().pending, marks: f.economy().marks, history: f.economy().history,
    prog: { completed: [...f.progression().missions.completed], claimed: [...f.progression().missions.claimed], active: f.progression().missions.active.map((m) => m.id) },
  };
});
const until = async (p, js, arg, ms = 8000) => {
  try { await p.waitForFunction(js, arg, { timeout: ms }); return true; } catch { return false; }
};
/** Hold the ship at P every frame (null releases it); invulnerable; calm (grace) unless __p09calm === false. */
const hold = (p, P) => p.evaluate((P) => {
  window.__p09hold = P;
  if (window.__p09holdLoop) return;
  window.__p09holdLoop = true;
  const loop = () => {
    const run = window.__galaxiaFreeRoam?.state;
    const w = window.__p09hold;
    if (run?.craft && w) Object.assign(run.ship, { x: w.x, y: w.y, px: w.x, py: w.y, vx: 0, vy: 0 });
    if (run?.craft) { run.invuln = 1e9; run.hull = run.craft.stats.hull; if (window.__p09calm !== false) run.grace = 1e9; }
    requestAnimationFrame(loop);
  };
  loop();
}, P);
/** Pin hostile `id` at Q every frame (test placement). */
const pinFoe = (p, id, Q) => p.evaluate(([id, Q]) => {
  window.__p09pin = { id, Q };
  if (window.__p09pinLoop) return;
  window.__p09pinLoop = true;
  const loop = () => {
    const run = window.__galaxiaFreeRoam?.state;
    const w = window.__p09pin;
    const a = w && run?.hostiles?.find((h) => h.id === w.id);
    if (a && a.state !== 'destroyed') Object.assign(a, { x: w.Q.x, y: w.Q.y, px: w.Q.x, py: w.Q.y, vx: 0, vy: 0 });
    requestAnimationFrame(loop);
  };
  loop();
}, [id, Q]);
const errsAll = [];

async function open(browser, seed, { flight = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(seedOnce, seed);
  await ctx.addInitScript(watchFeed);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  await p.goto(PAGE + '?mode=freeroam', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  if (flight) await enter(p);
  return { ctx, p, errs };
}
async function enter(p) {
  await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
}
async function close(o, tag) {
  check(`${tag}: no page errors`, o.errs.length === 0, o.errs);
  errsAll.push(...o.errs);
  await o.ctx.close();
}
/** Place the ship beside the station and dock with the real E key. */
async function dock(p) {
  const stn = await p.evaluate(() => window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'station'));
  await hold(p, { x: stn.x, y: stn.y - 80 }); // inside the docking radius, clear of the solid hull
  await sleep(250);
  await p.keyboard.press('KeyE');
  const ok = await until(p, () => window.__galaxiaFreeRoam.panel() === 'station');
  await hold(p, null);
  return ok;
}
async function missionsTab(p) {
  await p.click('.fr-tab-missions');
  return until(p, () => window.__galaxiaFreeRoam.panel() === 'missions');
}
/** The two-press confirm on a mission button. */
async function confirm(p, key) {
  await p.click(`button[data-key="${key}"]`, { force: true });
  await sleep(150);
  if ((await p.$(`button[data-key="${key}"]`)) && (await S(p)).pending === key) {
    await p.click(`button[data-key="${key}"]`, { force: true });
    await sleep(200);
  }
}
async function launch(p) {
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'station');
  await p.click('.fr-tab-launch');
  return until(p, () => window.__galaxiaFreeRoam.panel() === null && window.__galaxiaFreeRoam.state.phase === 'flight');
}
/** A point (and the point dx, dy from it) far from stations, gates, bodies, regions and the arrival sanctuary (grid search). */
const openPoint = (p, gap = 350, dx = 0, dy = 0) => p.evaluate(([gap, dx, dy]) => {
  const r = window.__galaxiaFreeRoam.state;
  const L = r.layout;
  const things = [...L.pois.map((q) => ({ x: q.x, y: q.y, pad: (q.r ?? 0) + 200 })), ...L.landmarks.map((l) => ({ x: l.x, y: l.y, pad: (l.r ?? 0) + (l.hazardR ?? 0) + 300 })), ...L.regions.map((g) => ({ x: g.x, y: g.y, pad: (g.r ?? 0) + 300 })), ...L.rocks.map((k) => ({ x: k.x, y: k.y, pad: k.r + 100 })), ...L.hazards.map((z) => ({ x: z.x, y: z.y, pad: z.r + 300 })), { x: L.arrival.x, y: L.arrival.y, pad: L.arrival.r + 400 }];
  // the widest clearance this sector allows (Sol is busy): try the requested gap, then smaller ones
  for (const g of [gap, gap * 0.6, gap * 0.3, 0]) {
    for (let gy = 600; gy < L.height - 600; gy += 100) {
      for (let gx = 600; gx < L.width - 600; gx += 100) {
        const clear = (x, y) => things.every((t) => Math.hypot(t.x - x, t.y - y) > g + t.pad);
        if (clear(gx, gy) && clear(gx + dx, gy + dy)) return { x: gx, y: gy };
      }
    }
  }
  return null;
}, [gap, dx, dy]);
/** Spawn a Red Tally raider straight ahead and fire until it is destroyed (real FIRE key, real simulation). */
async function killRaider(p) {
  const before = await p.evaluate(() => window.__galaxiaFreeRoam.state.kills);
  const id = await p.evaluate(() => { const f = window.__galaxiaFreeRoam; const sh = f.state.ship; return f.qaSpawn('raider', Math.sin(sh.heading) * 150, -Math.cos(sh.heading) * 150); });
  await p.keyboard.down('Space');
  const ok = await until(p, (k) => window.__galaxiaFreeRoam.state.kills > k, before, 8000);
  await p.keyboard.up('Space');
  await sleep(150);
  return ok && id !== null;
}

/* ------------------------------------------------------------- 1 - 5: a chain through the real path */
async function chainFlow(browser) {
  const seed = pilot({ marks: 100 });
  const o = await open(browser, seed);
  const { p } = o;
  await dock(p);
  await missionsTab(p);
  let s = await S(p);
  check('1. first stages offered: the dispatch offers Claim Jumpers and Faint Lanterns, never a later stage; chains() names them as current',
    s.keys.includes('accept:chain-accord-claims') && s.keys.includes('accept:chain-lanterns-echo') && !s.keys.some((k) => /accept:chain-(accord-shares|accord-ledger|lanterns-charts|lanterns-coolant)/.test(k)) &&
      s.chains.map((c) => c.current).join() === 'chain-accord-claims,chain-lanterns-echo' && s.chains[0].stages[1].lockedBy?.kind === 'mission',
    { keys: s.keys, chains: s.chains });
  await confirm(p, 'accept:chain-accord-claims');
  let rec = await saved(p);
  check('2a. ACCEPT takes Claim Jumpers through the existing path (saved, active)', rec.progression.missions.active.map((m) => m.id).includes('chain-accord-claims'), rec.progression.missions);
  await launch(p);
  const P = await openPoint(p);
  await hold(p, P);
  await sleep(200);
  await p.evaluate(() => { window.__galaxiaFreeRoam.state.ship.heading = 0; });
  await hold(p, null);
  await p.evaluate((P) => { window.__p09hold = P; }, P);
  const s0 = await S(p);
  const h0 = s0.heat;
  let kills = 0;
  for (let i = 0; i < 3; i++) kills += (await killRaider(p)) ? 1 : 0;
  await sleep(400);
  s = await S(p);
  const lines = (await feed(p)).join(' | ');
  check('2b. three Red Tally raiders destroyed with FIRE complete the stage (from the kills: 1/3, 2/3, 3/3 log lines)', kills === 3 && s.prog.completed.includes('chain-accord-claims') && /CLAIM JUMPERS · 1\/3.*CLAIM JUMPERS · 2\/3.*CLAIM JUMPERS · 3\/3/i.test(lines), { kills, prog: s.prog, lines: lines.slice(-400) });
  const tallyGain = s.heat['red-tally'] - (h0['red-tally'] ?? 0);
  // each kill adds +10 once; hits add +3 at most once per ship per second; the calm pilot (arrival grace held, so the
  // raiders never target it) also decays 1 per 720 ticks: gain = 30 + 3n - d, n >= 3, 0 <= d <= ticks / 720
  const maxDecay = Math.ceil((s.tick - s0.tick) / 720);
  const fits = Array.from({ length: maxDecay + 1 }, (_, d) => tallyGain + d - 30).some((x) => x >= 9 && x % 3 === 0);
  const tiers = s.log.filter((e) => e.faction === 'red-tally');
  check('5. hostile acts: Red Tally heat rose by 3 kills x 10 + whole hit increments (>= 3); every other faction stayed at 0; each tier crossing logged once, in order',
    fits && ['tessellate', 'cordon', 'gleaners'].every((f) => s.heat[f] === 0) &&
      tiers.length === Math.floor(s.heat['red-tally'] / 20) && tiers.every((e, i) => e.from === i && e.tier === i + 1 && e.cause === 'flight'),
    { heat: s.heat, log: s.log, h0, ticks: s.tick - s0.tick });
  const ups = (await feed(p)).filter((l) => /RED TALLY HEAT UP/.test(l));
  check('U11-U12. one feed notice per real tier crossing (not per hit): "RED TALLY HEAT UP · <TIER>" lines = crossings, each tier once, with its effect',
    ups.length === tiers.length && ups.length >= 1 && tiers.every((e, i) => ups[i]?.includes(`· ${['QUIET', 'WARY', 'ALERT', 'PURSUIT', 'HUNT'][e.tier]} ·`)) && ups.every((l) => /farther/.test(l)),
    { ups, tiers });
  await p.evaluate(() => { window.__p09hold = null; });
  await dock(p);
  await missionsTab(p);
  const m0 = (await S(p)).marks;
  await confirm(p, 'claim:chain-accord-claims');
  await p.click('button[data-key="claim:chain-accord-claims"]', { force: true, timeout: 800 }).catch(() => {});
  await sleep(300);
  s = await S(p);
  rec = await saved(p);
  const ledger = s.history.filter((e) => /Claim Jumpers/.test(e.label));
  check('2c. TURN IN pays +120 marks once (a second press pays nothing; one ledger line; saved)',
    s.marks - m0 === 120 && rec.progression.marks === s.marks && ledger.length === 1 && rec.progression.missions.claimed.includes('chain-accord-claims') && !s.keys.includes('claim:chain-accord-claims'),
    { m0, marks: s.marks, ledger, keys: s.keys });
  check('3a. next stage unlocks: Fair Shares is offered (Gleaner heat Quiet); chains() current = chain-accord-shares, 1 of 3 done',
    s.keys.includes('accept:chain-accord-shares') && !s.keys.includes('accept:chain-accord-claims') && s.chains[0].current === 'chain-accord-shares' && s.chains[0].completed === 1,
    { keys: s.keys, chain: s.chains[0] });
  const heatBefore = s.heat['red-tally'];
  check('4a. the heat is saved with the progression (non-zero values only)', rec.progression.heat?.['red-tally'] === heatBefore && Object.keys(rec.progression.heat).join() === 'red-tally', rec.progression.heat);
  // 4. reload
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await enter(p);
  await dock(p);
  await missionsTab(p);
  s = await S(p);
  check('4b. after a reload: no second reward, Claim Jumpers never re-offered, Fair Shares still offered, the heat kept',
    s.marks === rec.progression.marks && !s.keys.includes('claim:chain-accord-claims') && !s.keys.includes('accept:chain-accord-claims') && s.keys.includes('accept:chain-accord-shares') && s.heat['red-tally'] === heatBefore && s.log.length === 0,
    { marks: s.marks, keys: s.keys, heat: s.heat, log: s.log });
  await close(o, '1-5');
  // 3b. the heat gate
  const gated = await open(browser, pilot({ m: missions({ completed: [...STORY3, 'chain-accord-claims'], claimed: [...STORY3, 'chain-accord-claims'] }), heat: { gleaners: 45 } }));
  await dock(gated.p);
  await missionsTab(gated.p);
  s = await S(gated.p);
  check('3b. heat gate: at Gleaner Alert (45) Fair Shares is not offered; chains() gives { kind: heat, faction: gleaners, below: 40 } as the reason',
    !s.keys.includes('accept:chain-accord-shares') && s.tiers.gleaners === 'Alert' && JSON.stringify(s.chains[0].stages[1].lockedBy) === JSON.stringify({ kind: 'heat', faction: 'gleaners', below: 40 }),
    { keys: s.keys, stage: s.chains[0].stages[1], tiers: s.tiers });
  await close(gated, '3b');
}

/* ------------------------------------------------------------- 6: decay and pause */
async function decay(browser) {
  const o = await open(browser, pilot({ heat: { 'red-tally': 20 } }));
  const { p } = o;
  const P = await openPoint(p);
  await hold(p, P);
  const ok = await until(p, () => (window.__galaxiaFreeRoam.state.factionHeat.v['red-tally'] ?? 0) === 19, null, 16000);
  let s = await S(p);
  check('6a. decay: Red Tally 20 -> 19 after ~720 calm ticks of flight (Wary -> Quiet logged once)', ok && s.heat['red-tally'] === 19 && s.log.filter((e) => e.faction === 'red-tally').length === 1 && s.log[0].tier === 0 && s.log[0].from === 1, { heat: s.heat, log: s.log, calm: s.calm });
  await sleep(1000);
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'pause');
  const a = await S(p);
  await sleep(3000);
  const b = await S(p);
  check('6b. paused (Escape): heat, calm count and tick are frozen for 3 s', a.panel === 'pause' && a.tick === b.tick && a.heat['red-tally'] === b.heat['red-tally'] && a.calm['red-tally'] === b.calm['red-tally'] && a.calm['red-tally'] > 0, { a: [a.tick, a.calm], b: [b.tick, b.calm] });
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === null);
  await sleep(500);
  s = await S(p);
  check('6c. after resume the calm count continues from the same value (no reset, no skip)', s.calm['red-tally'] > b.calm['red-tally'] && s.calm['red-tally'] - b.calm['red-tally'] === s.tick - b.tick, { b: [b.tick, b.calm], s: [s.tick, s.calm] });
  await close(o, '6');
}

/* ------------------------------------------------------------- 7 - 8: behaviour */
/** Pilot at P, a Red Tally raider at P + (dx, dy), pinned; does it acquire the pilot within `ms`? */
async function acquires(browser, heat, dx, dy, { silent = false, shadow = false, ms = 1500 } = {}) {
  const o = await open(browser, pilot(heat ? { heat } : {}));
  const { p } = o;
  let P;
  let Q;
  if (shadow) {
    const g = await p.evaluate(() => { const L = window.__galaxiaFreeRoam.state.layout; const b = L.landmarks.filter((l) => l.kind === 'body' && l.r >= 60).sort((x, y) => y.r - x.r)[0]; return b ? { x: b.x, y: b.y, r: b.r, h: b.hazardR ?? 0 } : null; });
    const off = g.r + 90;
    P = { x: g.x + off, y: g.y };
    Q = { x: g.x - off, y: g.y };
  } else {
    P = await openPoint(p, 350, dx, dy);
    Q = { x: P.x + dx, y: P.y + dy };
  }
  await hold(p, P);
  if (silent) {
    await p.keyboard.press('KeyZ');
    await until(p, () => window.__galaxiaFreeRoam.state.silent === true, null, 2000);
  }
  await p.evaluate(() => { window.__p09calm = false; window.__galaxiaFreeRoam.state.grace = 0; }); // the arrival grace served: sight decides
  const id = await p.evaluate(([P, Q]) => window.__galaxiaFreeRoam.qaSpawn('raider', Q.x - P.x, Q.y - P.y), [P, Q]);
  await pinFoe(p, id, Q);
  const seen = await until(p, (id) => window.__galaxiaFreeRoam.state.hostiles.find((h) => h.id === id)?.target === 'player', id, ms);
  const info = await p.evaluate((id) => { const r = window.__galaxiaFreeRoam.state; const a = r.hostiles.find((h) => h.id === id); return { target: a?.target, shadow: a?.shadow, silent: r.silent, d: a ? Math.hypot(a.x - r.ship.x, a.y - r.ship.y) : null, heat: { ...r.factionHeat.v } }; }, id);
  await close(o, `acquire ${JSON.stringify(heat)} ${silent ? 'silent' : ''}${shadow ? 'shadow' : ''}`);
  return { seen, info };
}
async function behaviour(browser) {
  const D = 420; // raider detect range (combat/families.ts)
  const far = D * 1.12;
  const q = await acquires(browser, null, far, 0);
  const h = await acquires(browser, { 'red-tally': 90 }, far, 0);
  check('7. behaviour differs by heat: a Red Tally raider 1.12x its detect range away ignores a Quiet pilot and acquires at Hunt (90)', !q.seen && h.seen, { quiet: q, hunt: h });
  const sil = await acquires(browser, { 'red-tally': 100 }, D * 0.5, 0, { silent: true });
  const loud = await acquires(browser, { 'red-tally': 100 }, D * 0.5, 0);
  const sh = await acquires(browser, { 'red-tally': 100 }, 0, 0, { shadow: true, ms: 2000 });
  check('8. at Hunt Silent Running (0.5x detect away) still hides the pilot, and a planet between still hides it (Gravity Shadow); with neither it acquires',
    !sil.seen && sil.info.silent && loud.seen && !sh.seen && sh.info.shadow === true, { sil, loud, sh });
}

/* ------------------------------------------------------------- 9: consequence once */
async function consequence(browser) {
  const active = [{ id: 'chain-accord-shares', at: 0, progress: [0], targets: [SOL] }];
  const seed = pilot({ m: missions({ completed: [...STORY3, 'chain-accord-claims'], claimed: [...STORY3, 'chain-accord-claims'], active }), heat: { gleaners: 30, 'red-tally': 12 } });
  const o = await open(browser, seed);
  const { p } = o;
  await dock(p);
  await missionsTab(p);
  let s = await S(p);
  const deliverKey = s.keys.find((k) => k === 'deliver:chain-accord-shares');
  await confirm(p, 'deliver:chain-accord-shares');
  await sleep(200);
  s = await S(p);
  const delivered = s.prog.completed.includes('chain-accord-shares');
  const g0 = s.heat.gleaners;
  const m0 = s.marks;
  await confirm(p, 'claim:chain-accord-shares');
  await p.click('button[data-key="claim:chain-accord-shares"]', { force: true, timeout: 800 }).catch(() => {});
  await sleep(300);
  s = await S(p);
  let rec = await saved(p);
  check('9a. DELIVER at the target station completes Fair Shares; TURN IN pays +100 and lowers Gleaner heat by exactly 20, once (Red Tally untouched)',
    !!deliverKey && delivered && s.marks - m0 === 100 && g0 === 30 && s.heat.gleaners === 10 && s.heat['red-tally'] === 12 && rec.progression.heat?.gleaners === 10 && s.log.filter((e) => e.cause === 'mission' && e.faction === 'gleaners').length === 1,
    { deliverKey, delivered, m0, marks: s.marks, heat: s.heat, saved: rec.progression.heat, log: s.log });
  check('9b. the chain moves on: The Red Ledger is offered; chains() shows the applied consequence as data', s.keys.includes('accept:chain-accord-ledger') && s.chains[0].stages[1].status === 'claimed' && JSON.stringify(s.chains[0].stages[1].heat) === JSON.stringify({ faction: 'gleaners', delta: -20 }), { keys: s.keys, stage: s.chains[0].stages[1] });
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  s = await S(p);
  rec = await saved(p);
  check('9c. after a reload the consequence is not applied again (Gleaners 10, marks unchanged)', s.heat.gleaners === 10 && s.marks === rec.progression.marks && rec.progression.missions.claimed.filter((x) => x === 'chain-accord-shares').length === 1, { heat: s.heat, marks: s.marks });
  await close(o, '9');
}

/* ------------------------------------------------------------- 10: legacy saves */
async function legacy(browser) {
  const old = pilot({ m: missions({ active: [{ id: 'story-quiet-lanes', at: 0, progress: [0], targets: [''] }] }) });
  const o = await open(browser, old, { flight: false });
  let s = await S(o.p);
  let rec = await saved(o.p);
  check('10a. a pre-P09 save (no heat field) loads: every faction Quiet, its missions intact, nothing reset', Object.values(s.heat).every((v) => v === 0) && s.prog.active.join() === 'story-quiet-lanes' && s.prog.claimed.join() === STORY3.join() && s.marks === 100 && !('heat' in rec.progression), { heat: s.heat, prog: s.prog, marks: s.marks });
  await close(o, '10a');
  const bad = await open(browser, pilot({ marks: 77, heat: { 'red-tally': 500, gleaners: 'hot', cordon: 12 } }), { flight: false });
  s = await S(bad.p);
  check('10b. a malformed heat field is normalised (out-of-range and non-numbers dropped, valid values kept); marks and missions kept', s.heat['red-tally'] === 0 && s.heat.gleaners === 0 && s.heat.cordon === 12 && s.marks === 77 && s.prog.claimed.join() === STORY3.join(), { heat: s.heat, marks: s.marks });
  await close(bad, '10b');
}

/* ------------------------------------------------------------- 11: contracts */
async function contracts(browser) {
  const o = await open(browser, pilot({ heat: { cordon: 25 } }));
  const { p } = o;
  await dock(p);
  await missionsTab(p);
  let s = await S(p);
  const c = s.keys.find((k) => k.startsWith('accept:c:'));
  const h0 = JSON.stringify(s.heat);
  if (c) await confirm(p, c);
  s = await S(p);
  const rec = await saved(p);
  const id = c?.slice('accept:'.length);
  const accepted = !!id && rec.progression.missions.active.some((m) => m.id === id);
  const m0 = s.marks;
  if (id) await confirm(p, `abandon:${id}`);
  await sleep(200);
  s = await S(p);
  check('11. contracts unchanged: the board posts contracts, ACCEPT takes one (saved), ABANDON fails it and pays nothing; no heat changes', !!c && accepted && !s.prog.active.includes(id) && s.marks === m0 && JSON.stringify(s.heat) === h0, { c, accepted, active: s.prog.active, heat: [h0, s.heat] });
  await close(o, '11');
}

/* ------------------------------------------------------------- 12: P08 */
async function abilities(browser) {
  const o = await open(browser, pilot({ ship: 'swift', heat: { tessellate: 50 } }));
  const { p } = o;
  const P = await openPoint(p);
  await hold(p, P);
  await sleep(200);
  const h0 = (await S(p)).heat;
  await p.keyboard.press('KeyF');
  const on = await until(p, () => window.__galaxiaFreeRoam.ability()?.active === true, null, 2000);
  const a = await p.evaluate(() => window.__galaxiaFreeRoam.ability());
  const h1 = (await S(p)).heat;
  check('12. P08 still works: Swift F starts Vector Burst (status active, the table duration); the ability changes no heat', on && a.id === 'vector-burst' && a.durationTicks === 105 && JSON.stringify(h0) === JSON.stringify(h1), { a, h0, h1 });
  await close(o, '12');
}

/* ------------------------------------------------------------- P09.2 UI: the board sections */
/** The GUILD CHAINS and FACTION STANDING sections as the player sees them (DOM text, meters). */
const UI = (p) => p.evaluate(() => {
  const menu = document.querySelector('.fr-panel-missions .fr-menu');
  const heads = [...menu.querySelectorAll('.fr-fab-head')].map((h) => h.textContent);
  const card = (k) => { const li = menu.querySelector(`li[data-key="${k}"]`); return li ? { name: li.querySelector('.fr-fab-name')?.textContent, lines: [...li.querySelectorAll('.fr-mission-obj > li')].map((x) => x.textContent), meter: li.querySelector('meter') ? { v: li.querySelector('meter').value, max: li.querySelector('meter').max, aria: li.querySelector('meter').getAttribute('aria-label') } : null, desc: li.querySelector('.fr-fab-desc')?.textContent } : null; };
  return {
    heads, message: document.querySelector('.fr-panel-missions [role="status"]')?.textContent ?? '',
    chains: { accord: card('gleaner-accord'), lanterns: card('faint-lanterns') },
    standing: Object.fromEntries(['tessellate', 'red-tally', 'cordon', 'gleaners'].map((f) => [f, card(f)])),
    help: [...menu.querySelectorAll(':scope > p.fr-fab-desc')].map((x) => x.textContent).join(' '),
  };
});
const LABEL = { tessellate: 'TESSELLATE', 'red-tally': 'RED TALLY', cordon: 'CORDON', gleaners: 'GLEANERS' };
const standingMatches = (u, s) => Object.entries(LABEL).every(([f, l]) => {
  const c = u.standing[f];
  return c && c.name === `${l} · HEAT ${s.heat[f]}/100 · ${s.tiers[f].toUpperCase()}` && c.meter?.v === s.heat[f] && c.meter.max === 100 && /heat$/.test(c.meter.aria) && !!c.desc;
});
const progOf = (rec) => JSON.stringify([rec.progression.missions, rec.progression.heat ?? null, rec.progression.marks]);

async function uiBoard(browser) {
  const o = await open(browser, pilot({ m: missions({ completed: [...STORY3, 'chain-accord-claims'], claimed: [...STORY3, 'chain-accord-claims'] }), heat: { gleaners: 45, 'red-tally': 12 } }));
  const { p } = o;
  await dock(p);
  const rec0 = await saved(p);
  await missionsTab(p);
  let u = await UI(p);
  let s = await S(p);
  check('U1-U2. GUILD CHAINS lists both chains, each "TITLE · STAGE k OF 3" with three stage lines (and a detail line for the current stage)',
    u.heads.filter((h) => h === 'GUILD CHAINS').length === 1 && u.chains.accord?.name === 'GLEANER ACCORD · STAGE 2 OF 3' && u.chains.lanterns?.name === 'FAINT LANTERNS · STAGE 1 OF 3' &&
      [u.chains.accord, u.chains.lanterns].every((c) => c.lines.filter((l) => /^[✓▸○] \d · /.test(l)).length === 3 && c.lines.length === 4),
    u.chains);
  const [l1, l2, l3, ] = [u.chains.accord.lines[0], u.chains.accord.lines[1], u.chains.accord.lines[3]];
  const st2 = s.chains[0].stages[1];
  check('U3. stage status in words: 1 TURNED IN (✓), 3 LOCKED with its reason (turn in Fair Shares first)',
    /^✓ 1 · CLAIM JUMPERS · TURNED IN$/.test(l1) && /^○ 3 · THE RED LEDGER · LOCKED: turn in Fair Shares first$/.test(l3), { l1, l3 });
  check('U4. the gate is explained as acceptance-only with the live value; the detail line shows objective, data rewards and the consequence; no ACCEPT for it',
    l2 === '▸ 2 · FAIR SHARES · LOCKED: Gleaners heat must be below 40 when you accept (now 45)' && !s.keys.includes('accept:chain-accord-shares') &&
      u.chains.accord.lines[2] === `${st2.objective} · REWARD ${st2.rewards.join(' · ')} · GLEANERS HEAT −20 ON TURN-IN` && /0\/6/.test(st2.objective),
    { l2, detail: u.chains.accord.lines[2], st2 });
  check('U9-U10. FACTION STANDING: four factions, canonical labels, "HEAT v/100 · TIER", a 0-100 meter (named) and a consequence line, equal to heat()',
    u.heads.filter((h) => h === 'FACTION STANDING').length === 1 && standingMatches(u, s) && u.standing.gleaners.desc === 'its ships spot you 10% farther, search your last position 0.5 s longer' && u.standing.cordon.desc === 'no extra attention' &&
      /per faction/.test(u.help) && /not a difficulty level/.test(u.help) && /Silent Running and planets still hide you/.test(u.help),
    { standing: u.standing, help: u.help, heat: s.heat });
  // lifecycle: tab away and back, idle
  await p.click('.fr-tab-hangar');
  await until(p, () => window.__galaxiaFreeRoam.panel() !== 'missions');
  await missionsTab(p);
  u = await UI(p);
  const muts = await p.evaluate(async () => {
    let n = 0;
    const ob = new MutationObserver((l) => { n += l.length; });
    ob.observe(document.querySelector('.fr-panel-missions .fr-menu'), { childList: true, subtree: true, characterData: true, attributes: true });
    const h0 = JSON.stringify(window.__galaxiaFreeRoam.heat().factions);
    await new Promise((r) => setTimeout(r, 2500));
    ob.disconnect();
    return { n, same: JSON.stringify(window.__galaxiaFreeRoam.heat().factions) === h0 };
  });
  const rec1 = await saved(p);
  check('U15a. viewing changes nothing (missions, heat, marks saved as before); after a tab switch each section appears once; docked and idle for 2.5 s: no DOM churn, no decay',
    progOf(rec0) === progOf(rec1) && u.heads.filter((h) => h === 'GUILD CHAINS' || h === 'FACTION STANDING').length === 2 && muts.n === 0 && muts.same,
    { muts, heads: u.heads });
  await close(o, 'U board');
}

async function uiConsequence(browser) {
  const active = [{ id: 'chain-accord-shares', at: 0, progress: [0], targets: [SOL] }];
  const o = await open(browser, pilot({ m: missions({ completed: [...STORY3, 'chain-accord-claims'], claimed: [...STORY3, 'chain-accord-claims'], active }), heat: { gleaners: 70, 'red-tally': 12 } }));
  const { p } = o;
  await dock(p);
  await missionsTab(p);
  let u = await UI(p);
  let s = await S(p);
  check('U5. accepted before the heat rose: at Gleaners 70 (Pursuit) Fair Shares stays ACTIVE (no gate reason) and can be delivered (gate checked at acceptance only)',
    u.chains.accord.lines[1] === '▸ 2 · FAIR SHARES · ACTIVE' && s.keys.includes('deliver:chain-accord-shares'), { line: u.chains.accord.lines[1], keys: s.keys });
  await confirm(p, 'deliver:chain-accord-shares');
  await sleep(200);
  const m0 = (await S(p)).marks;
  await confirm(p, 'claim:chain-accord-shares');
  await p.click('button[data-key="claim:chain-accord-shares"]', { force: true, timeout: 800 }).catch(() => {});
  await sleep(300);
  u = await UI(p);
  s = await S(p);
  check('U6-U7. TURN IN pays +100 once and says so with the applied consequence and the next stage ("GLEANERS HEAT −20 (now 50, Alert)." "Next: The Red Ledger is on the Guild dispatch.")',
    s.marks - m0 === 100 && /^Reward claimed: /.test(u.message) && u.message.includes('GLEANERS HEAT −20 (now 50, Alert).') && u.message.includes('Next: The Red Ledger is on the Guild dispatch.') &&
      u.chains.accord.name === 'GLEANER ACCORD · STAGE 3 OF 3' && u.chains.accord.lines[1] === '✓ 2 · FAIR SHARES · TURNED IN' && /^▸ 3 · THE RED LEDGER · ON THE GUILD DISPATCH$/.test(u.chains.accord.lines[2]) && u.chains.accord.lines[3].includes('RED TALLY HEAT +15 ON TURN-IN'),
    { m0, marks: s.marks, message: u.message, accord: u.chains.accord });
  check('U13. FACTION STANDING shows the consequence at once: Gleaners 50/100 Alert (meter 50), Red Tally untouched', standingMatches(u, s) && u.standing.gleaners.name === 'GLEANERS · HEAT 50/100 · ALERT' && s.heat['red-tally'] === 12, u.standing);
  await launch(p);
  await sleep(600);
  const eased = (await feed(p)).filter((l) => /GLEANERS HEAT/.test(l));
  check('U11b. the turn-in crossing (Pursuit -> Alert) gives exactly one feed notice', eased.length === 1 && /GLEANERS HEAT EASED · ALERT ·/.test(eased[0]), { eased });
  const rec = await saved(p);
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await enter(p);
  await dock(p);
  await missionsTab(p);
  u = await UI(p);
  s = await S(p);
  await sleep(300);
  const again = (await feed(p)).filter((l) => /HEAT/.test(l));
  check('U8, U14. after a reload: marks unchanged (no second reward), Gleaners still 50, chain still at stage 3, no heat notice repeated',
    s.marks === rec.progression.marks && s.heat.gleaners === 50 && u.chains.accord.name === 'GLEANER ACCORD · STAGE 3 OF 3' && again.length === 0 && !s.keys.includes('claim:chain-accord-shares'),
    { marks: s.marks, heat: s.heat, again, name: u.chains.accord.name });
  await close(o, 'U consequence');
}

async function uiPause(browser) {
  const o = await open(browser, pilot({ heat: { cordon: 33, gleaners: 61 } }));
  const { p } = o;
  const P = await openPoint(p);
  await hold(p, P);
  await sleep(300);
  await p.keyboard.press('Escape');
  await until(p, () => window.__galaxiaFreeRoam.panel() === 'pause');
  await p.click('.fr-panel-pause .fr-pause-head:has-text("MISSIONS & PROGRESS")');
  await sleep(450);
  await p.click('.fr-panel-pause .fr-pause-item:text-is("MISSIONS")');
  const opened = await until(p, () => window.__galaxiaFreeRoam.panel() === 'missions', null, 5000);
  const a = { u: await UI(p), s: await S(p) };
  await sleep(3000);
  const b = { u: await UI(p), s: await S(p) };
  check('U15b. the pause-menu log shows the same standing and chains; paused for 3 s nothing moves (values, text, tick)',
    opened && standingMatches(a.u, a.s) && a.u.standing.gleaners.name === 'GLEANERS · HEAT 61/100 · PURSUIT' && JSON.stringify(a.u.standing) === JSON.stringify(b.u.standing) && a.s.tick === b.s.tick && !!a.u.chains.accord,
    { opened, a: a.u.standing, tick: [a.s.tick, b.s.tick] });
  await p.keyboard.press('Escape');
  const back = await until(p, () => window.__galaxiaFreeRoam.panel() === 'pause', null, 3000);
  await p.keyboard.press('Escape');
  const resumed = await until(p, () => window.__galaxiaFreeRoam.panel() === null && window.__galaxiaFreeRoam.state.phase === 'flight', null, 3000);
  check('U15c. Escape returns to the pause menu, Escape again resumes flight', back && resumed, { back, resumed });
  await close(o, 'U pause');
}

async function uiLegacy(browser) {
  for (const [tag, heat] of [['legacy', undefined], ['malformed', { 'red-tally': -4, gleaners: 'x', cordon: 1e9 }]]) {
    const o = await open(browser, pilot(heat === undefined ? {} : { heat }));
    await dock(o.p);
    await missionsTab(o.p);
    const u = await UI(o.p);
    const s = await S(o.p);
    check(`U16. ${tag} save: FACTION STANDING shows four Quiet factions at 0; GUILD CHAINS and the contract board still render`,
      standingMatches(u, s) && Object.values(s.heat).every((v) => v === 0) && !!u.chains.accord && !!u.chains.lanterns && u.heads.includes('STATION BOARD · CONTRACTS') && s.keys.some((k) => k.startsWith('accept:c:')),
      { heads: u.heads, heat: s.heat, keys: s.keys });
    await close(o, `U16 ${tag}`);
  }
}

async function viewports(browser) {
  const sizes = [[1280, 720], [1920, 1080], [320, 568], [360, 640], [390, 844], [568, 320], [667, 375], [844, 390]];
  const { mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const shots = `${tmpdir()}/p092-shots`;
  mkdirSync(shots, { recursive: true });
  const bad = [];
  for (const [w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript(seedOnce, pilot({ m: missions({ completed: [...STORY3, 'chain-accord-claims'], claimed: [...STORY3, 'chain-accord-claims'] }), heat: { gleaners: 45, 'red-tally': 64 } }));
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    await p.goto(PAGE + '?mode=freeroam', { waitUntil: 'load' });
    await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
    await sleep(300);
    await enter(p);
    await dock(p);
    await missionsTab(p);
    const r = await p.evaluate(() => {
      const root = document.querySelector('.fr-panel-missions');
      const vw = innerWidth;
      const over = [root, ...root.querySelectorAll('*')].filter((e) => !e.classList.contains('is-scrollable') && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible' && e.clientWidth > 0) // the station tab strip scrolls by design.map((e) => e.className || e.tagName);
      const cards = [...root.querySelectorAll('li[data-key]')];
      const out = [];
      for (const c of cards) {
        c.scrollIntoView({ block: 'nearest' });
        const b = c.getBoundingClientRect();
        if (b.left < -1 || b.right > vw + 1 || b.width < 100) out.push([c.dataset.key, Math.round(b.left), Math.round(b.right)]);
        for (const t of c.querySelectorAll('.fr-fab-name, .fr-mission-obj > li, .fr-fab-desc')) { const tb = t.getBoundingClientRect(); if (tb.right > b.right + 1) out.push([c.dataset.key, 'text', Math.round(tb.right)]); }
      }
      return { over, out, n: cards.length, focus: root.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON', docW: document.documentElement.scrollWidth, vw };
    });
    await p.evaluate(() => document.querySelector('.fr-panel-missions li[data-key="gleaner-accord"]').scrollIntoView({ block: 'start' }));
    await p.screenshot({ path: `${shots}/${w}x${h}-chains.png` });
    await p.evaluate(() => document.querySelector('.fr-panel-missions li[data-key="gleaners"]').scrollIntoView({ block: 'end' }));
    await p.screenshot({ path: `${shots}/${w}x${h}-standing.png` });
    const ok = r.n === 6 && r.out.length === 0 && r.over.length === 0 && r.focus && r.docW <= r.vw && errs.length === 0;
    if (!ok) bad.push({ w, h, ...r, errs });
    await ctx.close();
  }
  check('V. viewports 1280x720, 1920x1080, 320x568, 360x640, 390x844, 568x320, 667x375, 844x390: the six cards fit the width, no horizontal overflow, focus inside the panel, no page errors', bad.length === 0, bad);
}

const ONLY = (process.env.P09_ONLY ?? '').split(',').filter(Boolean);
const browser = await chromium.launch();
try {
  for (const [name, fn] of Object.entries({ chainFlow, decay, behaviour, consequence, legacy, contracts, abilities, uiBoard, uiConsequence, uiPause, uiLegacy, viewports })) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    try {
      await fn(browser);
    } catch (e) {
      check(`${name}: ran to the end`, false, String(e?.stack ?? e).slice(0, 900));
    }
  }
} finally {
  await browser.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? '; FAILED: ' + failed.map((c) => c.name).join(' | ') : ''}`);
process.exit(failed.length ? 1 : 0);
