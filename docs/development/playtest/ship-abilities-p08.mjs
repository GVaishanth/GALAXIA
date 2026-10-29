// P08.1 + P08.2 Ship Signature Abilities in a real browser (QA build: needs window.__galaxiaFreeRoam).
//   node ship-abilities-p08.mjs [pageUrl]
// Every activation goes through the real key (F, the `ability` flight action) or the real touch button and
// the game's own 60 Hz simulation; the hooks only place ships (test placement, as earlier harnesses do) and
// read the run and the ability status snapshot (abilityStatus). The HUD checks compare the ability control
// (.fr-ability) with that snapshot, read in the same frame. Scenarios:
//   1.  Swift (Sol): F starts Vector Burst once (one log line); the effect lasts exactly durationTicks of
//       simulation time and the cooldown counts from the activation (tick + remaining is constant);
//   2.  Vector Burst with thrust held: faster than the normal cap, never above cap x speedMul, back under the
//       cap once it ends (no teleport: the per-frame displacement stays bounded);
//   3.  F again while active: refused "· ACTIVE", the effect is not extended and nothing restarts;
//   4.  F while cooling: refused "· COOLING n s" with n = ceil(remaining / 60), the cooldown unchanged;
//   5.  pause (Escape) during the cooldown: tick and cooldown frozen for 1.5 s, F while paused does nothing;
//       resume continues from the same tick; READY is logged once when it reaches 0;
//   6.  Silent Running: an emitting ability (Vector Burst) ends it ("SILENT RUNNING OFF — ABILITY INPUT");
//       a non-emitting one (Bulwark, Condor) leaves it on;
//   7.  RESTART FLIGHT ends the effect and keeps the cooldown (no free reset); a reload starts fresh and
//       nothing about abilities is saved;
//   8.  Shrike (Sirius): no valid hostile -> "PREDATOR FOCUS · NO TARGET", nothing consumed; with a real
//       hostile ahead it starts, and the lock-on locks in half the ticks (the same missile, the same target;
//       focused first, then again after the focus ends; each launched missile is removed at once because only
//       the lock time is measured and the pinned ship must survive for the second lock);
//   9.  Petrel (Sirius): no detected signal in range -> "· NO SIGNAL"; near the anomaly it starts and a
//       bearing recorded inside the active period has half the spread of one recorded before it; no fix;
//   10. Magpie (Sirius): nowhere near salvage -> "· NO SALVAGE"; near salvage "SALVAGE PULSE ACTIVE · n FOUND"
//       lists only existing salvage / derelicts / pods / the cargo wreck in range; nothing collected or paid;
//       the list clears when it ends;
//   11. Condor (Sol): Bulwark runs exactly durationTicks, logs ACTIVE / ENDED, changes no ship stat;
//   12. Albatross (unsurveyed Sol): Deep Scan reveals only POIs within sensor x rangeMul, lists contacts inside
//       that radius only, logs "· n MARKERS · m HOSTILES" (each contact once), leaves the sensor stat alone and
//       clears its list at the end;
//   13. dock and ship change (Sol): docking ends the effect, the cooldown waits while docked, a ship change
//       carries the same share of the cooldown, and the new ship launches still cooling;
//   14. CONTROLS lists "Ship ability" on F; a binding moved to Y (stored prefs) makes Y the key and F inert;
//   15. touch 390x844: FIRE, BOOST, WPN, SILENT and LOCK at the positions measured on the P08.1 build (within
//       2 px), the ability button is there, a keyboard F still works;
//   P08.2 (HUD, touch button, scan display, guide):
//   16. every ship on a desktop (1280x720): the panel names the ship's ability with its one-line description and
//       "F · READY"; F updates it within two frames (ACTIVE with the seconds of the status, aria-pressed) or, when
//       refused, it stays READY and the log gives the real reason (no stale COOLDOWN); no touch controls;
//   17. touch (390x844, Swift): one tap = one activation (one log line, uses + 1, the button ACTIVE, pressed);
//       a tap while active is refused once and extends nothing; ACTIVE -> COOLDOWN on the status's tick;
//       a tap while cooling is refused ("· COOLING n s"), the cooldown not restarted, aria-disabled; FIRE, WPN and
//       SILENT still work beside it;
//   18. one tap = one request at the event level: pointerdown, pointerup, pointercancel, lostpointercapture and a
//       click on the button activate once (Condor), and a second finger while one holds it adds nothing;
//   19. pause freeze (Condor, during the effect): the button text and the status stay frozen for 1.2 s, and the
//       countdown resumes from the same point; Bulwark's ACTIVE lasts exactly its interval, then COOLDOWN, never
//       ACTIVE while inactive;
//   20. lifecycle: RESTART FLIGHT (Swift) shows COOLDOWN, not ACTIVE; docking hides the control; after a ship change
//       the control names the new ship's ability still cooling; leaving the sector (pause -> map) clears the scan
//       list and the control, and the next visit starts READY; READY returns to the panel with the key;
//   21. scan display (Albatross in Sirius, the anomaly sector): the Deep Scan line counts markers and hostiles
//       (each contact once) = the result list; every result is an existing in-sector object (the anomaly only at
//       its public marker; no other point), nothing is revealed beyond the radius; no marks, cargo, finished POI
//       or signal track is granted by the scan (the P06 reward stays with the investigation); on screen, the
//       highlight is drawn at a result's position while active and gone after it ends (canvas pixels);
//   22. Silent Running and the HUD (Swift / Condor): the SILENT control turns off with exactly one
//       "SILENT RUNNING OFF — ABILITY INPUT" line for an emitting ability, and stays on for a non-emitting one;
//   23. layout: 1280x720, 1920x1080, 320x568, 360x640, 390x844, 568x320, 667x375, 844x390, in NORMAL and
//       REALISTIC flight, with Silent Running off and on and the ability active: the control is inside the view,
//       not clipped, at least the size of SILENT when off (>= 44 px), readable (>= 9 px text), and clear of FIRE, BOOST,
//       WPN, LOCK, NEXT TARGET, STOP, SILENT, the mode tag, MAP / CARGO / II, the ship card, the location line,
//       the log, the nearby line, the tallest crew advice strip and the ship; desktop views show no touch controls;
//   24. HOW TO PLAY at 320x568 (touch, from the pause menu): "SHIP SIGNATURE ABILITIES" straight after Silent
//       Running, six ships with their abilities, no element wider than the card or the view; no page errors.
// P08_ONLY=name,name runs a subset while iterating; the full run is the record.
// Automated Chromium only: no physical device was used.
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SOL = 'milky-way/sol';
const SIRIUS = 'milky-way/sirius';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};
function pilot(system, active, owned = [active], surveyed = true) {
  return {
    version: 10, createdAt: 1, sessions: 5, flightSeconds: 900, beaconsCharted: 3, surveysCompleted: 1, bestSurveyTicks: 5000,
    currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL, SIRIUS], galaxySurveys: { 'milky-way': 1 },
    currentSystem: system, visitedSystems: [SOL, SIRIUS], sectors: { [SOL]: { done: [], surveyed }, [SIRIUS]: { done: [], surveyed } },
    cargo: { scrap: 20, fuel: 8, ice: 4 },
    fleet: { active, owned, loadouts: {} },
    lostCargo: null, modules: {}, milestones: [],
    progression: { marks: 100, missions: { active: [], completed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], claimed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
    savedAt: 1, resume: null,
  };
}
function seedOnce(rec) {
  if (!sessionStorage.getItem('p08-seeded')) {
    sessionStorage.setItem('p08-seeded', '1');
    localStorage.setItem('galaxia:freeroam', JSON.stringify(rec));
    localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
  }
}
const frames = (p, n = 3) => p.evaluate((k) => new Promise((r) => { const step = () => (k-- <= 0 ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); }), n);
/** Every corner-log line since the page loaded, in order (the feed itself drops old lines, so it is observed). */
function watchFeed() {
  window.__p08lines = [];
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) for (const e of [n, ...n.querySelectorAll('.fr-feed-line')]) if (e.classList?.contains('fr-feed-line')) window.__p08lines.push(e.textContent);
  }).observe(document, { childList: true, subtree: true });
}
const feed = (p) => p.evaluate(() => window.__p08lines.slice());
/** The run and the ability status snapshot (the read-only abilityStatus hook). */
const S = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  const r = f.state;
  return {
    a: f.ability(), tick: r.tick, phase: r.phase, panel: f.panel(), silent: r.silent, docked: r.docked, ship: r.craft.ship,
    speed: Math.hypot(r.ship.vx, r.ship.vy), cap: r.tune.maxSpeed, x: r.ship.x, y: r.ship.y,
    sensor: r.craft.stats.sensor, stats: JSON.stringify(r.craft.stats), revealed: r.revealed.size, done: [...r.done].sort().join(), cargo: JSON.stringify(f.profile().cargo),
  };
});
/** Hold the ship at P every frame (null releases it); also keeps it alive (test placement). */
const hold = (p, P) => p.evaluate((P) => {
  window.__p08hold = P;
  if (window.__p08holdLoop) return;
  window.__p08holdLoop = true;
  const loop = () => {
    const f = window.__galaxiaFreeRoam;
    const run = f?.state;
    const w = window.__p08hold;
    if (run?.craft && w) Object.assign(run.ship, { x: w.x, y: w.y, px: w.x, py: w.y, vx: 0, vy: 0 });
    if (run?.craft) { run.invuln = 1e9; run.hull = run.craft.stats.hull; if (window.__p08calm !== false) run.grace = 1e9; }
    requestAnimationFrame(loop);
  };
  loop();
}, P);
/** Record the ability state every frame until stop(). */
const record = (p) => p.evaluate(() => {
  window.__p08rec = [];
  window.__p08recOn = true;
  const loop = () => {
    if (!window.__p08recOn) return;
    const f = window.__galaxiaFreeRoam;
    const r = f.state;
    const a = f.ability();
    window.__p08rec.push({ tick: r.tick, phase: r.phase, active: a?.activeTicks ?? 0, cd: a?.cooldownTicks ?? 0, speed: Math.hypot(r.ship.vx, r.ship.vy), cap: r.tune.maxSpeed, x: r.ship.x, y: r.ship.y, ml: r.missile.state, lock: r.missile.lock, launches: r.missile.launches, nt: r.missile.notice });
    requestAnimationFrame(loop);
  };
  loop();
});
const stopRecord = (p) => p.evaluate(() => { window.__p08recOn = false; return window.__p08rec; });
const until = async (p, js, ms = 5000) => {
  try { await p.waitForFunction(js, null, { timeout: ms }); return true; } catch { return false; }
};
const errsAll = [];

async function open(browser, { system = SOL, ship = 'swift', owned, surveyed = true, viewport = { width: 1280, height: 720 }, touch = false, prefsFn = null } = {}) {
  const ctx = await browser.newContext({ viewport, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.addInitScript(seedOnce, pilot(system, ship, owned ?? [ship], surveyed));
  await ctx.addInitScript(watchFeed);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  const url = PAGE + '?mode=freeroam' + (touch ? '&controls=touch' : '');
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  if (prefsFn) {
    const current = await p.evaluate(() => window.__galaxiaFreeRoam.controls());
    await p.goto(PAGE + 'favicon.svg');
    await p.evaluate(prefsFn, current);
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  }
  await sleep(300);
  const go = touch ? (q) => p.tap(q) : (q) => p.click(q);
  await go('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await go('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
  return { ctx, p, errs };
}
async function close(o, tag) {
  check(`${tag}: no page errors`, o.errs.length === 0, o.errs);
  errsAll.push(...o.errs);
  await o.ctx.close();
}
async function pauseAction(p, label) {
  const head = '#fr-pause-settings';
  await p.waitForSelector(head);
  if ((await p.getAttribute(head, 'aria-expanded')) !== 'true') { await p.click(head); await sleep(400); }
  await p.click(`.fr-panel-pause .fr-pause-item:text-is("${label}")`);
  await sleep(150);
}
/** A point of the sector at least `gap` px from every listed thing (grid search, inside the bounds). */
const clearPoint = (p, kinds, gap) => p.evaluate(([kinds, gap]) => {
  const r = window.__galaxiaFreeRoam.state;
  const L = r.layout;
  const things = [...L.pois.filter((q) => kinds.includes(q.kind)), ...r.pickups, ...L.landmarks.map((l) => ({ x: l.x, y: l.y, pad: (l.r ?? 0) + 200 })), ...(kinds.includes('rock') ? [...L.rocks.map((k) => ({ x: k.x, y: k.y, pad: k.r - gap + 500 })), ...L.hazards.map((z) => ({ x: z.x, y: z.y, pad: z.r - gap + 500 }))] : [])];
  for (let gy = 400; gy < L.height - 400; gy += 150) {
    for (let gx = 400; gx < L.width - 400; gx += 150) {
      if (things.every((t) => Math.hypot(t.x - gx, t.y - gy) > gap + (t.pad ?? 0))) return { x: gx, y: gy };
    }
  }
  return null;
}, [kinds, gap]);

/** P08.2: the ability control and the status snapshot, read in the same frame. */
const AB = (p) => p.evaluate(() => {
  const f = window.__galaxiaFreeRoam;
  const b = document.querySelector('.fr-ability');
  const q = b.getBoundingClientRect();
  const sb = document.querySelector('.fr-silent');
  return {
    a: f.ability(), tick: f.state.tick, uses: f.state.ability.uses, silent: f.state.silent,
    vis: !b.hidden && b.getClientRects().length > 0 && !b.closest('[hidden]'), state: b.dataset.state, pressed: b.getAttribute('aria-pressed'), disabled: b.getAttribute('aria-disabled'),
    aria: b.getAttribute('aria-label') ?? '', label: b.children[0].textContent, hint: b.children[1].innerText, rect: [q.x, q.y, q.width, q.height],
    silentUi: sb.dataset.state ?? 'off', silentPressed: sb.getAttribute('aria-pressed'),
  };
});
/** What the control must say for this status (the oracle: P08.2 hudModel abilityHud's contract). */
function hudOk(u, key, touch) {
  const a = u.a;
  const st = a.active ? 'on' : a.cooldownTicks > 0 ? 'cooling' : 'ready';
  const first = u.hint.split('\n')[0];
  let ok = u.vis && u.state === st && u.pressed === String(st === 'on') && u.disabled === String(st === 'cooling') && u.label === (touch ? a.tag : a.name.toUpperCase()) && !/NaN|Infinity|-\d/.test(u.hint + u.aria);
  if (st === 'on') {
    const m = first.match(/^ACTIVE · (\d+\.\d) s$/);
    ok &&= !!m && Math.abs(Number(m[1]) - a.activeTicks / 60) <= 0.11;
  } else if (st === 'cooling') ok &&= first === `COOLDOWN · ${Math.ceil(a.cooldownTicks / 60)} s`;
  else ok &&= first === (touch ? 'READY' : `${key} · READY`);
  if (!touch) ok &&= u.hint.replace(/\s+/g, ' ').includes(a.summary) && u.aria.includes(`${a.name}, ship ability, key ${key}`);
  return ok;
}
const realisticPrefs = (c) => { localStorage.setItem('galaxia:freeroam:prefs', JSON.stringify({ version: 1, controls: { ...c, flightMode: 'realistic' } })); };
const tapAbility = (p) => p.tap('.fr-ability', { force: true });

/* ------------------------------------------------------------- 1 - 7: Swift and Condor in Sol */
async function swift(browser) {
  const o = await open(browser, { system: SOL, ship: 'swift' });
  const { p } = o;
  await hold(p, null);
  let s = await S(p);
  check('1a. Swift flies with Vector Burst available (status: id, name, tag, ready, durations from the table)', s.a?.id === 'vector-burst' && s.a.name === 'Vector Burst' && s.a.tag === 'BURST' && s.a.available && !s.a.active && s.a.cooldownTicks === 0 && s.a.durationTicks === 105 && s.a.cooldownMax === 1500, s.a);
  const D = s.a.durationTicks;
  const C = s.a.cooldownMax;
  // 2: thrust right for a second (at the normal cap), then F with the thrust held
  const open0 = await clearPoint(p, ['station', 'gate', 'exit', 'salvage', 'derelict', 'cache', 'survey'], 1300);
  await hold(p, open0);
  await frames(p, 2);
  await hold(p, null);
  await p.keyboard.down('KeyD');
  await sleep(1200);
  const f0 = (await feed(p)).length;
  await record(p);
  await p.keyboard.press('KeyF');
  await sleep(700);
  // 3: F again while active
  await p.keyboard.press('KeyF');
  await sleep(1700);
  await p.keyboard.up('KeyD');
  const rec = await stopRecord(p);
  const lines = (await feed(p)).slice(Math.max(0, f0 - 1));
  const act = rec.filter((q) => q.active > 0);
  const starts = new Set(act.map((q) => q.tick - (D - q.active)));
  const endSample = rec.find((q, i) => i > 0 && q.active === 0 && rec[i - 1].active > 0);
  const startTick = [...starts][0];
  check('1b. one F = one activation: one "VECTOR BURST ACTIVE" line; the effect counts down on simulation ticks only (tick + remaining constant)', lines.filter((t) => t === 'VECTOR BURST ACTIVE').length === 1 && starts.size === 1 && act.length > 20, { lines, starts: [...starts], n: act.length });
  check('1c. the effect ends exactly durationTicks (105) after it started; one "VECTOR BURST ENDED" line', endSample && endSample.tick - startTick >= D && endSample.tick - startTick <= D + 2 && lines.filter((t) => t === 'VECTOR BURST ENDED').length === 1, { start: startTick, end: endSample?.tick, lines });
  const cdFrom = new Set(rec.filter((q) => q.cd > 0).map((q) => q.tick + q.cd));
  check('1d. the cooldown counts from the activation on simulation ticks (tick + cooldown = start + 1500 throughout)', cdFrom.size === 1 && [...cdFrom][0] === startTick + C, { cdFrom: [...cdFrom], want: startTick + C });
  const cap = rec[0].cap;
  const top = Math.max(...act.map((q) => q.speed));
  const steps = rec.slice(1).map((q, i) => Math.hypot(q.x - rec[i].x, q.y - rec[i].y) / Math.max(1, q.tick - rec[i].tick));
  const after = rec.filter((q) => q.active === 0 && endSample && q.tick > endSample.tick + 2);
  check('2a. with thrust held the ship goes faster than its normal cap and never above cap x 1.35', top > cap * 1.15 && top <= cap * 1.35 + 0.5, { cap, top });
  check('2b. no teleport: the per-tick displacement never exceeds the boosted cap / 60', Math.max(...steps) <= (cap * 1.35) / 60 + 1, { max: Math.max(...steps) });
  check('2c. after it ends the speed is back under the normal cap', after.length > 3 && after.every((q) => q.speed <= cap + 0.5), { after: after.slice(0, 3) });
  check('3. F again while active: refused "VECTOR BURST · ACTIVE" (warn line), the effect not extended (same start, same end)', lines.includes('VECTOR BURST · ACTIVE') && starts.size === 1, { lines });
  // 4: F while cooling
  s = await S(p);
  const f1 = (await feed(p)).length;
  await p.keyboard.press('KeyF');
  await frames(p, 2);
  const s2 = await S(p);
  const l4 = (await feed(p)).slice(Math.max(0, f1 - 1));
  const coolLine = l4.find((t) => /^VECTOR BURST · COOLING \d+ s$/.test(t));
  const n = coolLine ? Number(coolLine.match(/(\d+) s$/)[1]) : -1;
  check('4. F while cooling: refused "VECTOR BURST · COOLING n s" (n = whole seconds left), the cooldown not restarted', !!coolLine && Math.abs(n - Math.ceil(s.a.cooldownTicks / 60)) <= 1 && s2.a.cooldownTicks < s.a.cooldownTicks && s2.tick + s2.a.cooldownTicks === startTick + C && !s2.a.active, { coolLine, s: s.a.cooldownTicks, s2: s2.a.cooldownTicks });
  // 5: pause during the cooldown
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  const p0 = await S(p);
  const h0 = await AB(p);
  await p.keyboard.press('KeyF');
  await sleep(1500);
  const p1 = await S(p);
  const h1 = await AB(p);
  check('19a. paused while cooling: the control text is frozen with the status (no browser timer)', h0.hint === h1.hint && h1.a.cooldownTicks === h0.a.cooldownTicks && h1.state === 'cooling', { h0: h0.hint, h1: h1.hint });
  check('5a. paused: tick and cooldown frozen for 1.5 s, F does nothing (status reason "paused")', p0.tick === p1.tick && p0.a.cooldownTicks === p1.a.cooldownTicks && p1.a.reason === 'paused' && !p1.a.active, { p0: [p0.tick, p0.a.cooldownTicks], p1: [p1.tick, p1.a.cooldownTicks, p1.a.reason] });
  await sleep(300);
  await p.click('.fr-pause-resume');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === null && window.__galaxiaFreeRoam.state.phase === 'flight');
  await frames(p, 6);
  const p2 = await S(p);
  check('5b. resumed: the cooldown continues from the same point (tick + cooldown still constant)', p2.a.cooldownTicks < p1.a.cooldownTicks && p2.tick + p2.a.cooldownTicks === p1.tick + p1.a.cooldownTicks, { p1: [p1.tick, p1.a.cooldownTicks], p2: [p2.tick, p2.a.cooldownTicks] });
  const f2 = (await feed(p)).length;
  await hold(p, open0);
  const readyOk = await until(p, () => window.__galaxiaFreeRoam.ability().cooldownTicks === 0, (p2.a.cooldownTicks / 60) * 1000 + 6000);
  await frames(p, 3);
  const l5 = (await feed(p)).slice(Math.max(0, f2 - 1));
  s = await S(p);
  check('5c. READY is logged once when the cooldown reaches 0, and the status is available again', readyOk && l5.filter((t) => t === 'VECTOR BURST READY').length === 1 && s.a.available && s.a.reason === null, { readyOk, l5, a: s.a });
  const hr = await AB(p);
  check('20a. COOLDOWN -> READY: the panel shows "F · READY" again with the description (state ready, not pressed, not disabled)', hudOk(hr, 'F', false) && hr.state === 'ready', hr);
  // 6: Silent Running and an emitting ability
  await p.keyboard.press('KeyZ');
  await frames(p, 3);
  const z = await S(p);
  const f3 = (await feed(p)).length;
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  s = await S(p);
  const l6 = (await feed(p)).slice(Math.max(0, f3 - 1));
  check('6a. Silent Running on, then F (Swift): Vector Burst emits, so Silent Running ends with its own log line', z.silent && !s.silent && s.a.active && l6.includes('SILENT RUNNING OFF — ABILITY INPUT') && l6.includes('VECTOR BURST ACTIVE'), { z: z.silent, s: s.silent, l6 });
  const h6 = await AB(p);
  check('22a. the SILENT control follows at once (off, not pressed) and the off line appears exactly once; the panel is ACTIVE', h6.silentUi !== 'on' && h6.silentPressed === 'false' && l6.filter((t) => /^SILENT RUNNING OFF/.test(t)).length === 1 && hudOk(h6, 'F', false) && h6.state === 'on', { h6, l6 });
  // 7: restart during the effect
  const before = await S(p);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(400);
  await p.keyboard.press('KeyR');
  await sleep(150);
  await p.keyboard.press('KeyR');
  const restarted = await until(p, () => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, 5000);
  s = await S(p);
  check('7a. RESTART FLIGHT ends the effect and keeps the cooldown (no free reset)', restarted && before.a.active && !s.a.active && s.a.cooldownTicks > 0 && s.a.cooldownTicks <= before.a.cooldownTicks && s.a.reason === 'cooling', { restarted, before: before.a, after: s.a });
  await frames(p, 2);
  const hR = await AB(p);
  check('20b. after RESTART FLIGHT the panel shows COOLDOWN with the status\'s seconds, never ACTIVE', hudOk(hR, 'F', false) && hR.state === 'cooling' && !/ACTIVE/.test(hR.hint), hR);
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  const keys = await p.evaluate(() => {
    const out = [];
    const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); walk(x); } };
    walk(JSON.parse(localStorage.getItem('galaxia:freeroam') ?? '{}'));
    return { bad: out.filter((k) => /abilit|cooldown|burst|bulwark/i.test(k)), raw: /vector-burst|deep-scan|bulwark/.test(localStorage.getItem('galaxia:freeroam') ?? '') };
  });
  await sleep(300);
  await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight');
  s = await S(p);
  check('7b. nothing about abilities is saved; a reload (a new sector visit) starts ready', keys.bad.length === 0 && !keys.raw && s.a.available && s.a.cooldownTicks === 0 && !s.a.active, { keys, a: s.a });
  await close(o, '1-7 Swift');
}

/* ------------------------------------------------------------- 8 - 10: Sirius (Shrike, Petrel, Magpie) */
async function springAmbush(p) {
  const enc = await p.evaluate(() => { const e = window.__galaxiaFreeRoam.state.layout.sites.find((s) => s.kind === 'ambush'); return { x: e.x, y: e.y }; });
  await p.evaluate(() => { window.__p08calm = false; window.__galaxiaFreeRoam.state.grace = 0; }); // let the ambush warp in
  await hold(p, enc);
  const ok = await until(p, () => window.__galaxiaFreeRoam.state.hostiles.some((h) => h.state !== 'destroyed' && h.role === 'wave' && h.faction !== 'gleaners'), 15000);
  await p.evaluate(() => { window.__p08calm = true; });
  return ok;
}
async function shrike(browser) {
  const o = await open(browser, { system: SIRIUS, ship: 'shrike' });
  const { p } = o;
  // 8a: nowhere near a hostile
  const quiet = await clearPoint(p, ['station', 'gate'], 600);
  await hold(p, quiet);
  await frames(p, 3);
  const nearest = await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; return Math.min(1e9, ...r.hostiles.filter((h) => h.state !== 'destroyed').map((h) => Math.hypot(h.x - r.ship.x, h.y - r.ship.y))); });
  const f0 = (await feed(p)).length;
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  let s = await S(p);
  const l0 = (await feed(p)).slice(Math.max(0, f0 - 1));
  check('8a. Shrike with no valid hostile in lock range: "PREDATOR FOCUS · NO TARGET", nothing consumed, no target created', nearest > 900 && l0.includes('PREDATOR FOCUS · NO TARGET') && !s.a.active && s.a.cooldownTicks === 0 && s.a.available, { nearest, l0, a: s.a });
  // 8b: a real ambush hostile pinned 380 px ahead (nose up); the lock-on selected with Q
  const sprung = await springAmbush(p);
  const hid = await p.evaluate(() => {
    const r = window.__galaxiaFreeRoam.state;
    const h = r.hostiles.find((a) => a.state !== 'destroyed' && a.role === 'wave' && a.faction !== 'gleaners');
    h.source = 'p08-watch';
    window.__p08h = h.id;
    const loop = () => {
      const run = window.__galaxiaFreeRoam.state;
      for (const a of run.hostiles) {
        if (a.state === 'destroyed') continue;
        const q = a.id === window.__p08h ? { x: run.ship.x, y: run.ship.y - 380 } : { x: run.ship.x - 2600, y: run.ship.y + 2600 + a.id * 60 };
        Object.assign(a, { x: q.x, y: q.y, px: q.x, py: q.y, vx: 0, vy: 0, hull: a.maxHull ?? a.hull });
      }
      run.ship.heading = 0;
      run.grace = 1e9;
      run.enemyShots.length = 0;
      requestAnimationFrame(loop);
    };
    loop();
    return h.id;
  });
  // test placement: the watched ship has left its ambush (detached, as in stealth-p07); both move to open space, clear of rocks
  await hold(p, await clearPoint(p, ['station', 'gate', 'rock'], 900));
  await frames(p, 3);
  for (let i = 0; i < 6 && (await p.evaluate(() => window.__galaxiaFreeRoam.state.arsenal.selected)) !== 'lock-missile'; i++) { await p.keyboard.press('KeyQ'); await frames(p, 3); }
  const sel = await p.evaluate(() => window.__galaxiaFreeRoam.state.arsenal.selected);
  const lockTime = async () => {
    await until(p, () => (window.__galaxiaFreeRoam.state.arsenal.cooldown['lock-missile'] ?? 0) === 0 && window.__galaxiaFreeRoam.state.missiles.length === 0, 15000);
    // the earlier missile may have destroyed the pinned ship (or its encounter ended): pin another live hostile ahead instead
    const pinned = await p.evaluate(() => {
      const r = window.__galaxiaFreeRoam.state;
      const cur = r.hostiles.find((a) => a.id === window.__p08h);
      if (!cur || cur.state === 'destroyed' || cur.hull <= 0) {
        const next = r.hostiles.find((a) => a.state !== 'destroyed' && a.hull > 0 && a.faction !== 'gleaners');
        if (next) { next.source = 'p08-watch'; window.__p08h = next.id; }
      }
      return window.__p08h;
    });
    await frames(p, 3);
    await record(p);
    await p.keyboard.press('Space');
    await until(p, () => window.__p08rec.some((q, i) => i > 0 && q.launches > window.__p08rec[0].launches), 3000);
    await frames(p, 2);
    const rec = await stopRecord(p);
    const acq = rec.filter((q) => q.ml === 'acquiring');
    const lockStart = acq.length ? acq[0].tick - acq[0].lock : -1;
    const launch = rec.find((q) => q.launches > rec[0].launches);
    // this scenario measures the lock time only: the launched missile is removed before it can destroy the pinned ship
    const target = await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; const t = r.missiles[0]?.target ?? null; r.missiles.length = 0; return t; });
    return { pinned, ticks: launch && lockStart >= 0 ? launch.tick - lockStart : -1, target };
  };
  // the focused lock first (the focus lasts 5 s), then the same lock-on once the focus has ended
  await p.keyboard.press('KeyF');
  await frames(p, 2);
  s = await S(p);
  const focusOn = s.a.active && s.a.id === 'predator-focus';
  const focused = await lockTime();
  await until(p, () => !window.__galaxiaFreeRoam.ability().active, 8000);
  const base = await lockTime();
  const hid2 = base.pinned;
  check('8b. a real hostile ahead in lock range: Predator Focus starts (one press)', sprung && focusOn, { sprung, a: s.a });
  check('8c. the same lock-on locks in about half the ticks inside the focus (baseline ~18, focused ~9), on the same hostile', sel === 'lock-missile' && base.ticks >= 18 && base.ticks <= 21 && focused.ticks >= 9 && focused.ticks <= 12 && base.target === hid2 && focused.target === hid, { sel, base, focused, hid, hid2 });
  await p.evaluate(() => { window.__p08h = -1; });
  await close(o, '8 Shrike');
}

async function petrel(browser) {
  const o = await open(browser, { system: SIRIUS, ship: 'petrel' });
  const { p } = o;
  const an = await p.evaluate(() => { const a = window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'anomaly'); return { id: a.id, x: a.x, y: a.y }; });
  const far = await clearPoint(p, ['anomaly'], 1400);
  await hold(p, far);
  await frames(p, 3);
  const f0 = (await feed(p)).length;
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  let s = await S(p);
  const l0 = (await feed(p)).slice(Math.max(0, f0 - 1));
  check('9a. Petrel with no detected signal in sensor range: "SIGNAL CALIBRATION · NO SIGNAL", nothing consumed', l0.includes('SIGNAL CALIBRATION · NO SIGNAL') && !s.a.active && s.a.cooldownTicks === 0, { l0, a: s.a });
  const at = (deg, d) => ({ x: an.x + Math.cos((deg * Math.PI) / 180) * d, y: an.y + Math.sin((deg * Math.PI) / 180) * d });
  const bearing = async (deg) => {
    await hold(p, at(deg, 300));
    await sleep(250);
    await p.keyboard.press('KeyE');
    await sleep(1400);
    return p.evaluate((id) => { const t = window.__galaxiaFreeRoam.state.signal.tracks.get(id); return { n: t?.bearings.length ?? 0, spread: t?.bearings.at(-1)?.spread ?? null, fix: t?.fix ?? null }; }, an.id);
  };
  const b1 = await bearing(0);
  await hold(p, at(90, 300));
  await sleep(200);
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  s = await S(p);
  const on = s.a.active && s.a.id === 'signal-calibration';
  const b2 = await bearing(90);
  s = await S(p);
  check('9b. near the anomaly Signal Calibration starts; its status lists no contact (the source never appears)', on && s.a.contacts.length === 0, s.a);
  check('9c. a bearing recorded inside the active period has half the spread of the one before it; no extra resolution', b1.n === 1 && b2.n === 2 && Math.abs(b2.spread - b1.spread * 0.5) < 1e-9, { b1, b2 });
  await close(o, '9 Petrel');
}

async function magpie(browser) {
  const o = await open(browser, { system: SIRIUS, ship: 'magpie' });
  const { p } = o;
  const far = await clearPoint(p, ['salvage', 'derelict'], 1700);
  if (far) {
    await hold(p, far);
    await frames(p, 3);
    const f0 = (await feed(p)).length;
    await p.keyboard.press('KeyF');
    await frames(p, 3);
    const s = await S(p);
    const l0 = (await feed(p)).slice(Math.max(0, f0 - 1));
    check('10a. Magpie with no salvage in reach: "SALVAGE PULSE · NO SALVAGE", nothing consumed', l0.includes('SALVAGE PULSE · NO SALVAGE') && !s.a.active && s.a.cooldownTicks === 0, { l0, a: s.a });
  } else check('10a. Magpie: a point clear of salvage exists in Sirius', false, { far });
  const sv = await p.evaluate(() => { const a = window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'salvage'); return { x: a.x + 500, y: a.y }; });
  await hold(p, sv);
  await frames(p, 3);
  const before = await S(p);
  const f1 = (await feed(p)).length;
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  const s = await S(p);
  const l1 = (await feed(p)).slice(Math.max(0, f1 - 1));
  const audit = await p.evaluate(() => {
    const f = window.__galaxiaFreeRoam;
    const r = f.state;
    const R = r.craft.stats.sensor * 1.75;
    const a = f.ability();
    const ids = new Set([...r.layout.pois.map((q) => q.id), ...r.pickups.map((q) => q.id), 'wreck']);
    return {
      n: a.contacts.length,
      kinds: [...new Set(a.contacts.map((c) => c.kind))],
      allReal: a.contacts.every((c) => ids.has(c.id)),
      inRange: a.contacts.every((c) => Math.hypot(c.x - r.ship.x, c.y - r.ship.y) <= R + 1),
      notDone: a.contacts.every((c) => !r.done.has(c.id)),
    };
  });
  const found = Number((l1.find((t) => /^SALVAGE PULSE ACTIVE · \d+ FOUND$/.test(t)) ?? '').match(/(\d+) FOUND/)?.[1] ?? -1);
  check('10b. near salvage: "SALVAGE PULSE ACTIVE · n FOUND" with n = the contacts listed', s.a.active && found === audit.n && audit.n > 0, { l1, audit });
  check('10c. the list holds only existing, unfinished salvage / derelicts / pods / the wreck, all within sensor x 1.75', audit.allReal && audit.inRange && audit.notDone && audit.kinds.every((k) => ['salvage', 'derelict', 'pod', 'wreck'].includes(k)), audit);
  await sleep(1000);
  const mid = await S(p);
  check('10d. nothing collected, finished or paid by the pulse (done set and cargo unchanged)', mid.done === before.done && mid.cargo === before.cargo, { before: [before.done, before.cargo], mid: [mid.done, mid.cargo] });
  await until(p, () => !window.__galaxiaFreeRoam.ability().active, 9000);
  const end = await S(p);
  check('10e. when the pulse ends its list clears', !end.a.active && end.a.contacts.length === 0, end.a);
  await close(o, '10 Magpie');
}

/* ------------------------------------------------------------- 11 - 13: Condor, Albatross, dock */
async function condor(browser) {
  const o = await open(browser, { system: SOL, ship: 'condor' });
  const { p } = o;
  const spot = await clearPoint(p, ['station', 'gate', 'exit'], 900);
  await hold(p, spot);
  await p.keyboard.press('KeyZ');
  await frames(p, 3);
  const z = await S(p);
  const f0 = (await feed(p)).length;
  await record(p);
  await p.keyboard.press('KeyF');
  await frames(p, 4);
  const s = await S(p);
  check('6b. Silent Running on, then F (Condor): Bulwark does not emit, Silent Running stays on', z.silent && s.silent && s.a.active && s.a.id === 'bulwark', { z: z.silent, s: s.silent, a: s.a });
  const hb = await AB(p);
  check('22b. the SILENT control stays SILENT RUNNING (pressed) and no SILENT RUNNING OFF line; the panel is ACTIVE', hb.silentUi === 'on' && hb.silentPressed === 'true' && !(await feed(p)).slice(f0).some((t) => /^SILENT RUNNING OFF/.test(t)) && hudOk(hb, 'F', false) && hb.state === 'on', hb);
  // 19b: pause during the effect
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  const q0 = await AB(p);
  await sleep(1200);
  const q1 = await AB(p);
  await sleep(300);
  await p.click('.fr-pause-resume');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === null && window.__galaxiaFreeRoam.state.phase === 'flight');
  await frames(p, 6);
  const q2 = await AB(p);
  check('19b. paused during Bulwark: ACTIVE text and activeTicks frozen for 1.2 s; after resume it counts down from the same point', q0.hint === q1.hint && q0.a.activeTicks === q1.a.activeTicks && q0.tick === q1.tick && q2.a.activeTicks < q1.a.activeTicks && q2.tick + q2.a.activeTicks === q1.tick + q1.a.activeTicks && hudOk(q2, 'F', false), { q0: [q0.tick, q0.a.activeTicks, q0.hint], q1: [q1.tick, q1.a.activeTicks, q1.hint], q2: [q2.tick, q2.a.activeTicks] });
  // 19c: the panel over the whole interval (sampled every frame)
  await p.evaluate(() => {
    window.__p08hud = [];
    const loop = () => {
      const f = window.__galaxiaFreeRoam;
      const a = f.ability();
      const b = document.querySelector('.fr-ability');
      window.__p08hud.push({ t: f.state.tick, act: a.active, ticks: a.activeTicks, state: b.dataset.state, hint: b.children[1].innerText.split('\n')[0] });
      if (window.__p08hud.length < 400) requestAnimationFrame(loop);
    };
    loop();
  });
  await until(p, () => !window.__galaxiaFreeRoam.ability().active, 7000);
  await frames(p, 3);
  const rec = await stopRecord(p);
  const lines = (await feed(p)).slice(Math.max(0, f0 - 1));
  const act = rec.filter((q) => q.active > 0);
  const start = new Set(act.map((q) => q.tick - (240 - q.active)));
  const end = rec.find((q, i) => i > 0 && q.active === 0 && rec[i - 1].active > 0);
  const e = await S(p);
  check('11. Bulwark: "BULWARK ACTIVE" then "BULWARK ENDED" after exactly 240 ticks; no ship stat changed', lines.includes('BULWARK ACTIVE') && lines.includes('BULWARK ENDED') && start.size === 1 && end && end.tick - [...start][0] >= 240 && end.tick - [...start][0] <= 242 && e.stats === z.stats, { lines, start: [...start], end: end?.tick });
  await sleep(300);
  const hs = await p.evaluate(() => window.__p08hud);
  const wrong = hs.filter((q) => (q.act ? q.state !== 'on' || !/^ACTIVE/.test(q.hint) : q.state === 'on' || /ACTIVE/.test(q.hint)));
  check('19c. Bulwark on the panel: ACTIVE on exactly the frames the status is active, then COOLDOWN (never ACTIVE while inactive)', hs.length > 20 && hs.some((q) => q.act) && hs.some((q) => !q.act && q.state === 'cooling') && wrong.length === 0, { n: hs.length, wrong: wrong.slice(0, 4) });
  await close(o, '6b/11 Condor');
}

async function albatross(browser) {
  const o = await open(browser, { system: SOL, ship: 'albatross', surveyed: false });
  const { p } = o;
  const spot = await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; return { x: r.ship.x, y: r.ship.y }; });
  await hold(p, spot);
  await sleep(400); // the regular sensor sweep (every 6 ticks) has run
  const before = await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; return { revealed: [...r.revealed], sensor: r.craft.stats.sensor }; });
  const f0 = (await feed(p)).length;
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  const l0 = (await feed(p)).slice(Math.max(0, f0 - 1));
  const after = await p.evaluate((prev) => {
    const f = window.__galaxiaFreeRoam;
    const r = f.state;
    const R = r.craft.stats.sensor * 1.5;
    const a = f.ability();
    const added = [...r.revealed].filter((id) => !prev.includes(id)).map((id) => r.layout.pois.find((q) => q.id === id));
    return {
      active: a.active, n: a.contacts.length, sensor: r.craft.stats.sensor,
      addedIn: added.every((q) => q && Math.hypot(q.x - r.ship.x, q.y - r.ship.y) <= R + 1), added: added.length,
      contactsIn: a.contacts.every((c) => Math.hypot(c.x - r.ship.x, c.y - r.ship.y) <= R + 1),
      beyond: r.layout.pois.filter((q) => Math.hypot(q.x - r.ship.x, q.y - r.ship.y) > R + 1 && !prev.includes(q.id) && r.revealed.has(q.id)).length,
    };
  }, before.revealed);
  const dm = (l0.find((t) => /^DEEP SCAN ACTIVE · \d+ MARKERS? · \d+ HOSTILES?$/.test(t)) ?? '').match(/· (\d+) MARKERS? · (\d+) HOSTILES?$/);
  const found = dm ? Number(dm[1]) + Number(dm[2]) : -1;
  check('12a. Deep Scan: "DEEP SCAN ACTIVE · n MARKERS · m HOSTILES" with n + m = the contacts listed; it reveals POIs only within sensor x 1.5', after.active && found === after.n && after.added > 0 && after.addedIn && after.beyond === 0 && after.contactsIn, { l0, after });
  check('12b. the sensor stat is unchanged by the scan', after.sensor === before.sensor, { before: before.sensor, after: after.sensor });
  await until(p, () => !window.__galaxiaFreeRoam.ability().active, 9000);
  const end = await S(p);
  check('12c. when the scan ends its list clears (what was revealed stays revealed, as the regular sweep would)', !end.a.active && end.a.contacts.length === 0 && end.revealed >= before.revealed.length + after.added, end.a);
  await close(o, '12 Albatross');
}

async function dockAndShip(browser) {
  const o = await open(browser, { system: SOL, ship: 'condor', owned: ['condor', 'swift'] });
  const { p } = o;
  await hold(p, null);
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  const on = (await S(p)).a.active;
  await p.evaluate(() => { const f = window.__galaxiaFreeRoam; const stn = f.sector().pois.find((q) => q.kind === 'station'); Object.assign(f.state.ship, { x: stn.x, y: stn.y + 70, px: stn.x, py: stn.y + 70, vx: 0, vy: 0 }); });
  await p.waitForFunction(() => { const f = window.__galaxiaFreeRoam; return f.sector().focus === f.sector().pois.find((q) => q.kind === 'station').id; }, null, { timeout: 4000 });
  await p.keyboard.press('KeyE');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'station');
  const d0 = await S(p);
  const hd = await AB(p);
  await sleep(1200);
  const d1 = await S(p);
  check('13a. docking ends the effect; the cooldown waits while docked (1.2 s, unchanged; reason "docked")', on && !d0.a.active && d0.a.cooldownTicks > 0 && d1.a.cooldownTicks === d0.a.cooldownTicks && d1.a.reason === 'docked', { on, d0: d0.a, d1: d1.a });
  check('20c. docked: the ability control is not shown (the flight controls are hidden with the panel open)', !hd.vis, { vis: hd.vis });
  await p.click('.fr-tab-hangar');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'hangar');
  await p.click('.fr-hangar-ship[data-ship="swift"]');
  await p.click('.fr-hangar-action');
  await p.click('.fr-hangar-action');
  await sleep(200);
  const c = await S(p);
  const want = Math.ceil((d1.a.cooldownTicks / 2400) * 1500);
  check('13b. ship change (Condor -> Swift): the status follows the new ship and carries the same share of the cooldown', c.ship === 'swift' && c.a.id === 'vector-burst' && Math.abs(c.a.cooldownTicks - want) <= 1 && !c.a.active, { ship: c.ship, a: c.a, want });
  await p.click('.fr-hangar-launch');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, null, { timeout: 5000 });
  await frames(p, 3);
  const hn = await AB(p);
  check('20d. launched in the Swift: the control names Vector Burst and shows COOLDOWN with the carried seconds', hudOk(hn, 'F', false) && hn.label === 'VECTOR BURST' && hn.state === 'cooling', hn);
  const f0 = (await feed(p)).length;
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  const l = (await feed(p)).slice(Math.max(0, f0 - 1));
  const s = await S(p);
  check('13c. launched in the Swift still cooling: F is refused ("VECTOR BURST · COOLING n s"), no free reset', !s.a.active && s.a.cooldownTicks > 0 && l.some((t) => /^VECTOR BURST · COOLING \d+ s$/.test(t)), { a: s.a, l });
  await close(o, '13 dock / ship change');
}

/* ------------------------------------------------------------- 14 - 15: controls, rebinding, touch */
async function controls(browser) {
  let o = await open(browser, { system: SOL, ship: 'condor' });
  let p = o.p;
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(400);
  await pauseAction(p, 'CONTROLS');
  await sleep(300);
  const row = await p.evaluate(() => {
    const r = [...document.querySelectorAll('.fr-controls-row')].find((x) => /Ship ability/i.test(x.textContent));
    return r ? [...r.children].map((c) => c.textContent.trim()) : [];
  });
  check('14a. CONTROLS lists "Ship ability" on F (rebindable like every flight action)', /Ship ability/i.test(row[0] ?? '') && row.includes('F'), { row });
  await close(o, '14a controls');
  o = await open(browser, {
    system: SOL, ship: 'condor',
    prefsFn: (c) => { localStorage.setItem('galaxia:freeroam:prefs', JSON.stringify({ version: 1, controls: { ...c, bindings: { ...c.bindings, ability: ['KeyY', null] } } })); },
  });
  p = o.p;
  await hold(p, null);
  await frames(p, 3);
  const a0 = await AB(p);
  await p.keyboard.press('KeyF');
  await frames(p, 4);
  const a = await S(p);
  await p.keyboard.press('KeyY');
  await frames(p, 4);
  const b = await S(p);
  check('14b. with the action moved to Y (stored prefs): F does nothing, Y activates Bulwark', !a.a.active && a.a.cooldownTicks === 0 && b.a.active && b.a.id === 'bulwark', { a: a.a, b: b.a });
  check('14c. the panel shows the bound key, not a hardcoded F ("Y · READY" before, aria "key Y")', a0.hint.startsWith('Y · READY') && a0.aria.includes('key Y') && !/\bF\b/.test(a0.hint), a0);
  await close(o, '14b rebinding');
}

async function touch(browser) {
  const o = await open(browser, { system: SOL, ship: 'swift', touch: true, viewport: { width: 390, height: 844 } });
  const { p } = o;
  await hold(p, null);
  const ui = await p.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const has = (q) => vis(document.querySelector(q));
    const txt = [...document.querySelectorAll('.fr-touch, .fr-fire, .fr-boost, .fr-wpn, .fr-lock, .fr-silent, .fr-stop')].filter(vis).map((e) => e.textContent).join(' ');
    const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(); };
    return { fire: has('.fr-fire'), boost: has('.fr-boost'), wpn: has('.fr-wpn'), silent: has('.fr-silent'), ability: has('.fr-ability'), at: { fire: r('.fr-fire'), boost: r('.fr-boost'), wpn: r('.fr-wpn'), silent: r('.fr-silent'), lock: r('.fr-lock') } };
  });
  // the positions at 390x844 measured on the P08.1 build (357a8c5): the new button moved none of them
  const was = { fire: '292,724,84,84', boost: '216,736,64,64', wpn: '294,568,56,56', silent: '251,510,124,46', lock: '26,337,56,56' };
  const near = Object.keys(was).every((k) => was[k].split(',').every((v, i) => Math.abs(Number(v) - Number(ui.at[k].split(',')[i])) <= 2));
  check('15a. touch 390x844: FIRE, BOOST, WPN, SILENT and LOCK are where they were (within 2 px of sub-pixel rounding); the ability button is shown (P08.2)', ui.fire && ui.boost && ui.wpn && ui.silent && ui.ability && near, ui);
  await p.keyboard.press('KeyF');
  await frames(p, 4);
  const s = await S(p);
  check('15b. a keyboard F in the touch layout still activates the ability (the same action)', s.a.active && s.a.id === 'vector-burst', s.a);
  await close(o, '15 touch');
}

/* ------------------------------------------------------------- P08.2: 16 - 24 */
const ABILITY_IDS = { swift: 'vector-burst', shrike: 'predator-focus', petrel: 'signal-calibration', magpie: 'salvage-pulse', condor: 'bulwark', albatross: 'deep-scan' };
const REFUSAL_WORDS = { noTarget: 'NO TARGET', noSignal: 'NO SIGNAL', noSalvage: 'NO SALVAGE', jammed: 'JAMMED', docked: 'DOCKED' };

async function everyShip(browser) {
  for (const ship of Object.keys(ABILITY_IDS)) {
    const o = await open(browser, { system: SOL, ship });
    const { p } = o;
    await hold(p, null);
    await frames(p, 3);
    const h0 = await AB(p);
    const touchUi = await p.evaluate(() => ['.fr-fire', '.fr-boost', '.fr-wpn', '.fr-lock'].filter((q) => { const e = document.querySelector(q); return e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; }));
    check(`16a. ${ship}: the panel names ${h0.a?.name} with its description and "F · READY" (status: ${ABILITY_IDS[ship]}); no touch controls on the desktop`, h0.a?.id === ABILITY_IDS[ship] && hudOk(h0, 'F', false) && h0.state === 'ready' && touchUi.length === 0, { h0, touchUi });
    const f0 = (await feed(p)).length;
    await p.keyboard.press('KeyF');
    await frames(p, 2);
    const h1 = await AB(p);
    const lines = (await feed(p)).slice(f0);
    const name = h0.a.name.toUpperCase();
    if (h1.a.active) {
      check(`16b. ${ship}: F -> within two frames the panel reads ACTIVE with the status's seconds (pressed), one "${name} ACTIVE…" line`, hudOk(h1, 'F', false) && h1.state === 'on' && lines.filter((t) => t.startsWith(`${name} ACTIVE`)).length === 1 && h1.uses === 1, { h1, lines });
    } else {
      const why = h1.a.reason ? REFUSAL_WORDS[h1.a.reason] : null;
      const refused = lines.filter((t) => t.startsWith(`${name} · `));
      check(`16b. ${ship}: F refused in this spot -> the panel stays READY (no stale COOLDOWN), one line naming the real reason (${why}), nothing used`, hudOk(h1, 'F', false) && h1.state === 'ready' && h1.uses === 0 && h1.a.cooldownTicks === 0 && refused.length === 1 && !!why && refused[0] === `${name} · ${why}`, { h1, lines, reason: h1.a.reason });
    }
    await close(o, `16 ${ship}`);
  }
}

async function touchButton(browser) {
  const o = await open(browser, { system: SOL, ship: 'swift', touch: true, viewport: { width: 390, height: 844 } });
  const { p } = o;
  await hold(p, await clearPoint(p, ['station', 'gate', 'exit', 'salvage', 'derelict', 'cache', 'survey'], 1300));
  await frames(p, 3);
  const h0 = await AB(p);
  check('17a. touch: the button carries the ship tag (BURST) and READY, with an accessible name and pressed / disabled state', hudOk(h0, 'F', true) && h0.label === 'BURST' && h0.state === 'ready' && /Vector Burst, ship ability: ready\./.test(h0.aria) && h0.pressed === 'false' && h0.disabled === 'false', h0);
  const f0 = (await feed(p)).length;
  await tapAbility(p);
  await frames(p, 2);
  const h1 = await AB(p);
  check('17b. one tap = one activation: uses 1, one "VECTOR BURST ACTIVE" line, the button ACTIVE (aria-pressed true) within two frames', h1.uses === 1 && h1.a.active && hudOk(h1, 'F', true) && h1.state === 'on' && (await feed(p)).slice(f0).filter((t) => t === 'VECTOR BURST ACTIVE').length === 1, { h1, lines: (await feed(p)).slice(f0) });
  const end0 = h1.tick + h1.a.activeTicks;
  await tapAbility(p);
  await frames(p, 2);
  const h2 = await AB(p);
  const l2 = (await feed(p)).slice(f0);
  check('17c. a tap while active: refused once ("VECTOR BURST · ACTIVE"), uses still 1, the effect not extended', h2.uses === 1 && l2.filter((t) => t === 'VECTOR BURST · ACTIVE').length === 1 && (!h2.a.active || h2.tick + h2.a.activeTicks === end0), { l2, h2: [h2.uses, h2.tick, h2.a.activeTicks, end0] });
  await until(p, () => !window.__galaxiaFreeRoam.ability().active, 4000);
  await frames(p, 2);
  const h3 = await AB(p);
  check('17d. ACTIVE -> COOLDOWN on the status\'s own tick: the button reads COOLDOWN · n s (n = whole seconds left), aria-disabled true', hudOk(h3, 'F', true) && h3.state === 'cooling' && h3.disabled === 'true', h3);
  const f1 = (await feed(p)).length;
  const c0 = h3.tick + h3.a.cooldownTicks;
  await tapAbility(p);
  await frames(p, 2);
  const h4 = await AB(p);
  const l4 = (await feed(p)).slice(f1);
  check('17e. a tap while cooling: one "VECTOR BURST · COOLING n s" line, uses still 1, the cooldown not restarted', h4.uses === 1 && l4.filter((t) => /^VECTOR BURST · COOLING \d+ s$/.test(t)).length === 1 && h4.tick + h4.a.cooldownTicks === c0, { l4, h4: [h4.uses, h4.tick, h4.a.cooldownTicks, c0] });
  // the existing controls beside it (plasma selected: FIRE fires a bolt; WPN last)
  await p.tap('.fr-silent');
  await frames(p, 3);
  const sOn = await p.evaluate(() => window.__galaxiaFreeRoam.state.silent);
  const shots0 = await p.evaluate(() => window.__galaxiaFreeRoam.state.shotsFired);
  const fb = await p.locator('.fr-fire').boundingBox();
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fb.x + fb.width / 2, y: fb.y + fb.height / 2, id: 1 }] });
  await sleep(300);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await frames(p, 3);
  const after = await p.evaluate(() => ({ shots: window.__galaxiaFreeRoam.state.shotsFired, silent: window.__galaxiaFreeRoam.state.silent, uses: window.__galaxiaFreeRoam.state.ability.uses }));
  const w0 = await p.evaluate(() => window.__galaxiaFreeRoam.state.arsenal.selected);
  await p.tap('.fr-wpn');
  await frames(p, 3);
  const w1 = await p.evaluate(() => window.__galaxiaFreeRoam.state.arsenal.selected);
  check('17f. the existing controls still work beside it: WPN changes the weapon, SILENT turns Silent Running on, FIRE fires (and ends it); no ability use from them', w1 !== w0 && sOn && after.shots > shots0 && !after.silent && after.uses === 1, { w0, w1, sOn, shots0, after });
  await close(o, '17 touch button');
}

async function oneTapOneRequest(browser) {
  const o = await open(browser, { system: SOL, ship: 'condor', touch: true, viewport: { width: 390, height: 844 } });
  const { p } = o;
  await hold(p, null);
  await frames(p, 3);
  const f0 = (await feed(p)).length;
  // a full touch sequence with every follow-up event a browser may send for one tap
  await p.evaluate(() => {
    const b = document.querySelector('.fr-ability');
    const r = b.getBoundingClientRect();
    const o = { pointerId: 41, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    b.dispatchEvent(new PointerEvent('pointerdown', o));
    b.dispatchEvent(new PointerEvent('pointerup', o));
    b.dispatchEvent(new PointerEvent('pointercancel', o));
    b.dispatchEvent(new PointerEvent('lostpointercapture', o));
    window.dispatchEvent(new PointerEvent('pointerup', o));
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
  await frames(p, 8);
  const a = await AB(p);
  const l = (await feed(p)).slice(f0);
  check('18a. pointerdown + pointerup + pointercancel + lostpointercapture + click on the button = exactly one activation (uses 1, one BULWARK ACTIVE line, no refusal)', a.uses === 1 && a.a.active && l.filter((t) => t === 'BULWARK ACTIVE').length === 1 && !l.some((t) => t.startsWith('BULWARK · ')), { uses: a.uses, l });
  // a second finger while the first holds the button: nothing more
  const f1 = (await feed(p)).length;
  await p.evaluate(() => {
    const b = document.querySelector('.fr-ability');
    const mk = (id) => ({ pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true });
    b.dispatchEvent(new PointerEvent('pointerdown', mk(51)));
    b.dispatchEvent(new PointerEvent('pointerdown', mk(52)));
    window.dispatchEvent(new PointerEvent('pointerup', mk(52)));
    window.dispatchEvent(new PointerEvent('pointerup', mk(51)));
  });
  await frames(p, 6);
  const b = await AB(p);
  const l1 = (await feed(p)).slice(f1);
  check('18b. two fingers on the button at once count as one press (one refusal "· ACTIVE" while active, uses still 1)', b.uses === 1 && l1.filter((t) => t === 'BULWARK · ACTIVE').length === 1, { uses: b.uses, l1 });
  await close(o, '18 one tap');
}

async function sectorExit(browser) {
  const o = await open(browser, { system: SOL, ship: 'albatross', surveyed: false });
  const { p } = o;
  await hold(p, null);
  await p.keyboard.press('KeyF');
  await frames(p, 3);
  const on = await AB(p);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(400);
  const nav = '#fr-pause-navigation';
  if ((await p.getAttribute(nav, 'aria-expanded')) !== 'true') { await p.click(nav); await sleep(400); }
  await p.click('.fr-panel-pause .fr-pause-item:text-matches("^(GALAXY|SYSTEM) MAP$")');
  const left = await until(p, () => window.__galaxiaFreeRoam.screen() === 'map', 6000);
  await sleep(300);
  const gone = await p.evaluate(() => { const b = document.querySelector('.fr-ability'); const a = window.__galaxiaFreeRoam.ability(); return { vis: !!b && b.getClientRects().length > 0 && !b.closest('[hidden]'), contacts: a?.contacts?.length ?? 0, active: a?.active ?? false }; });
  check('20e. leaving the sector during Deep Scan (pause -> map): the scan list is empty and the control is gone', on.a.active && on.a.contacts.length > 0 && left && !gone.vis && gone.contacts === 0 && !gone.active, { on: on.a.contacts.length, left, gone });
  if (await p.locator('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR').isVisible()) {
    await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
    await p.click('.fr-panel-briefing >> text=START FLIGHT');
    await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
    await frames(p, 3);
    const h = await AB(p);
    check('20f. the next sector visit starts with the ability READY (panel "F · READY", empty scan list)', hudOk(h, 'F', false) && h.state === 'ready' && h.a.contacts.length === 0, h);
  } else check('20f. the map offers ENTER SECTOR after leaving', false, {});
  await close(o, '20 sector exit');
}

async function scanDisplay(browser) {
  const o = await open(browser, { system: SIRIUS, ship: 'albatross', touch: true, viewport: { width: 390, height: 844 } });
  const { p } = o;
  const an = await p.evaluate(() => { const a = window.__galaxiaFreeRoam.state.layout.pois.find((q) => q.kind === 'anomaly'); return { id: a.id, x: a.x, y: a.y }; });
  await hold(p, { x: an.x + 600, y: an.y });
  await sleep(500);
  const before = await p.evaluate(() => { const f = window.__galaxiaFreeRoam; const r = f.state; return { marks: f.profile().progression.marks, cargo: JSON.stringify(f.profile().cargo), done: [...r.done].sort().join(), tracks: r.signal.tracks.size, revealed: [...r.revealed] }; });
  // a result on screen to look at: the anomaly marker (inside the scan radius, near the ship)
  const at = await p.evaluate(([x, y]) => window.__galaxiaFreeRoam.toClient(x, y), [an.x, an.y]);
  const R = 40;
  const clip = { x: Math.max(0, Math.round(at.x - R)), y: Math.max(0, Math.round(at.y - R)), width: 2 * R, height: 2 * R };
  const cyan = async () => {
    const png = await p.screenshot({ clip });
    return p.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 140 && d[i + 1] > 170 && d[i + 2] > 190) n++; // the highlight cyan (#5cefff)
      return n;
    }, png.toString('base64'));
  };
  const c0 = await cyan();
  const f0 = (await feed(p)).length;
  await tapAbility(p);
  await frames(p, 4);
  const c1 = await cyan();
  const res = await p.evaluate(([prev, an]) => {
    const f = window.__galaxiaFreeRoam;
    const r = f.state;
    const a = f.ability();
    const L = r.layout;
    const R = r.craft.stats.sensor * 1.5;
    const pois = new Map(L.pois.map((q) => [q.id, q]));
    const hostiles = new Map(r.hostiles.map((h) => [`hostile:${h.id}`, h]));
    const real = a.contacts.every((c) => (c.kind === 'hostile' ? hostiles.has(c.id) : pois.has(c.id) && pois.get(c.id).kind === c.kind && pois.get(c.id).x === c.x && pois.get(c.id).y === c.y));
    return {
      n: a.contacts.length, hostiles: a.contacts.filter((c) => c.kind === 'hostile').length, real,
      inside: a.contacts.every((c) => c.x >= 0 && c.y >= 0 && c.x <= L.width && c.y <= L.height && Math.hypot(c.x - r.ship.x, c.y - r.ship.y) <= R + 1),
      anomaly: a.contacts.filter((c) => c.kind === 'anomaly').map((c) => [c.x === an.x && c.y === an.y]),
      kinds: [...new Set(a.contacts.map((c) => c.kind))],
      beyond: [...r.revealed].filter((id) => !prev.includes(id)).some((id) => { const q = pois.get(id); return !q || Math.hypot(q.x - r.ship.x, q.y - r.ship.y) > R + 1; }),
    };
  }, [before.revealed, an]);
  const l = (await feed(p)).slice(f0);
  const m = (l.find((t) => /^DEEP SCAN ACTIVE · \d+ MARKERS? · \d+ HOSTILES?$/.test(t)) ?? '').match(/· (\d+) MARKERS? · (\d+) HOSTILES?$/);
  check('21a. Deep Scan line: markers + hostiles = the result list, hostiles counted once and apart', !!m && Number(m[1]) + Number(m[2]) === res.n && Number(m[2]) === res.hostiles && res.n > 0, { l, res });
  check('21b. every result is an existing in-sector object inside the scan radius; the anomaly only at its public marker; nothing revealed beyond the radius', res.real && res.inside && res.anomaly.length === 1 && res.anomaly[0][0] && !res.beyond && res.kinds.every((k) => ['anomaly', 'salvage', 'survey', 'derelict', 'gate', 'exit', 'station', 'cache', 'hostile'].includes(k)), res);
  await sleep(800);
  const mid = await p.evaluate(() => { const f = window.__galaxiaFreeRoam; const r = f.state; return { marks: f.profile().progression.marks, cargo: JSON.stringify(f.profile().cargo), done: [...r.done].sort().join(), tracks: r.signal.tracks.size }; });
  check('21c. the scan grants nothing: Guild marks, cargo, finished POIs and signal tracks unchanged (the P06 reward stays with the investigation)', mid.marks === before.marks && mid.cargo === before.cargo && mid.done === before.done && mid.tracks === before.tracks, { before: { ...before, revealed: undefined }, mid });
  await until(p, () => !window.__galaxiaFreeRoam.ability().active, 9000);
  await frames(p, 4);
  const c2 = await cyan();
  check('21d. on screen: the highlight is drawn at the anomaly marker while the scan is active and gone once it ends (cyan pixels around the result)', c1 > c0 + 20 && c2 <= c0 + 5, { c0, c1, c2, clip });
  await close(o, '21 scan display');
}

const VIEWS = [[1280, 720, false, 'swift'], [1920, 1080, false, 'albatross'], [320, 568, true, 'condor'], [360, 640, true, 'condor'], [390, 844, true, 'albatross'], [568, 320, true, 'condor'], [667, 375, true, 'swift'], [844, 390, true, 'condor']];
async function layout(browser) {
  for (const mode of ['normal', 'realistic']) {
    for (const [w, h, t, ship] of VIEWS) {
      const o = await open(browser, { system: SOL, ship, touch: t, viewport: { width: w, height: h }, prefsFn: mode === 'realistic' ? realisticPrefs : null });
      const { p } = o;
      await hold(p, null);
      await frames(p, 4);
      const measure = (tag) => p.evaluate(([t, tag]) => {
        const f = window.__galaxiaFreeRoam;
        const b = document.querySelector('.fr-ability');
        const vis = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden]') && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
        // NEXT TARGET shows only while locked: measure its place with hidden lifted for this synchronous read
        const nt = document.querySelector('.fr-target');
        const wasHidden = nt?.hidden;
        if (nt && t) nt.hidden = false;
        // 'crew': the crew advice strip at its tallest (the crew-advisor-p05 probe line, ~130 characters, under a
        // CRITICAL head), shown for this synchronous read: the strip and the button share a side on landscape phones
        const st = tag === 'crew' && document.querySelector('.fr-advice');
        if (st) {
          st.hidden = false;
          st.querySelector('.fr-advice-level').textContent = 'CRITICAL · ';
          st.querySelector('.fr-advice-who').textContent = 'ODILE MARCHETTI';
          st.querySelector('.fr-advice-text').textContent = 'Drift puts us into Ceres Test in 2.4 s with engines idle. Burn ↗ (away and along our drift) to clear it with the widest margin.';
        }
        const sels = ['.fr-advice', '.fr-fire', '.fr-boost', '.fr-wpn', '.fr-lock', '.fr-target', '.fr-flightctl > .fr-stop:not(.fr-ability)', '.fr-flightmode-tag', '.fr-interact', '.fr-nearby', '.fr-shipcard', '.fr-top', '.fr-hud-buttons', '.fr-hint', '.fr-feed-line', '.fr-cargochip', '.fr-notice', '.fr-alert'];
        const others = [];
        for (const q of sels) for (const e of document.querySelectorAll(q)) if (vis(e)) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0) others.push({ q: q + (e.className.includes('fr-silent') ? '(silent)' : ''), r: [r.x, r.y, r.right, r.bottom] }); }
        if (nt && t) nt.hidden = wasHidden;
        const r = b.getBoundingClientRect();
        const R = [r.x, r.y, r.right, r.bottom];
        const hit = (o, pad = 0) => R[0] < o[2] + pad && o[0] < R[2] + pad && R[1] < o[3] + pad && o[1] < R[3] + pad;
        const sp = f.toClient(f.state.ship.x, f.state.ship.y);
        const ship = [sp.x - 22, sp.y - 22, sp.x + 22, sp.y + 22];
        const silent = document.querySelector('.fr-silent').getBoundingClientRect();
        const kids = [b, ...b.children];
        const touchVisible = ['.fr-fire', '.fr-boost', '.fr-wpn', '.fr-lock'].filter((q) => vis(document.querySelector(q)));
        return {
          tag, shown: vis(b), rect: R.map(Math.round), inView: R[0] >= 0 && R[1] >= 0 && R[2] <= innerWidth && R[3] <= innerHeight,
          size: [Math.round(r.width), Math.round(r.height)], silentH: Math.round(silent.height),
          clipped: kids.filter((k) => k.scrollWidth > k.clientWidth + 1 || k.scrollHeight > k.clientHeight + 1).map((k) => k.className),
          font: Math.min(...[...b.children].map((k) => parseFloat(getComputedStyle(k).fontSize))),
          overlaps: others.filter((o) => hit(o.r)).map((o) => `${o.q} ${o.r.map(Math.round)}`),
          onShip: hit(ship), touchVisible, text: b.innerText.replace(/\n/g, ' | '),
        };
      }, [t, tag]);
      const out = [];
      out.push(await measure('ready'));
      if (t) await p.tap('.fr-silent'); else await p.keyboard.press('KeyZ');
      await frames(p, 4);
      out.push(await measure('silent'));
      if (t) await tapAbility(p); else await p.keyboard.press('KeyF');
      await frames(p, 6);
      out.push(await measure('active'));
      out.push(await measure('crew'));
      const bad = out.filter((m) => !m.shown || !m.inView || m.clipped.length || m.size[1] < 44 || m.size[1] < out[0].silentH || m.size[0] < 44 || m.font < 9 || m.overlaps.length || m.onShip || (t ? m.touchVisible.length < 4 : m.touchVisible.length > 0));
      check(`23. ${mode} ${w}x${h} (${t ? 'touch' : 'desktop'}, ${ship}): the ability control is in view, unclipped, as tall as SILENT (off) and >= 44 px, readable, clear of every control, the HUD, the tallest crew strip and the ship (ready / silent / active / crew strip)${t ? '' : '; no touch controls'}`, bad.length === 0, { bad, all: out.map((m) => `${m.tag} ${m.rect} ${m.text}`) });
      await o.ctx.close();
      errsAll.push(...o.errs);
      if (o.errs.length) check(`23. ${mode} ${w}x${h}: no page errors`, false, o.errs);
    }
  }
}

async function narrowGuide(browser) {
  const o = await open(browser, { system: SOL, ship: 'petrel', touch: true, viewport: { width: 320, height: 568 } });
  const { p } = o;
  await p.tap('.fr-pause');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(400);
  const head = '#fr-pause-settings';
  if ((await p.getAttribute(head, 'aria-expanded')) !== 'true') { await p.tap(head); await sleep(400); }
  await p.tap('.fr-panel-pause .fr-pause-item:text-is("HOW TO PLAY")');
  await p.waitForSelector('.guide:not([hidden]) .guide-card');
  await p.locator('.guide-dot').nth(3).click({ force: true });
  await sleep(300);
  const g = await p.evaluate(() => {
    const card = document.querySelector('.guide:not([hidden]) .guide-card');
    const t = card.innerText;
    const over = [...card.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).map((e) => e.className).slice(0, 5);
    const cr = card.getBoundingClientRect();
    const wideBy = [...card.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > cr.right + 1).map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`).slice(0, 6);
    return { wideBy, cw: [card.scrollWidth, card.clientWidth], at: t.indexOf('SHIP SIGNATURE ABILITIES'), silent: t.indexOf('SILENT RUNNING'), shield: t.indexOf('NOT A SHIELD'), ships: ['SWIFT · VECTOR BURST', 'SHRIKE · PREDATOR FOCUS', 'PETREL · SIGNAL CALIBRATION', 'MAGPIE · SALVAGE PULSE', 'CONDOR · BULWARK', 'ALBATROSS · DEEP SCAN'].map((s) => t.indexOf(s)), tap: /Tap the ability button/.test(t), wide: card.scrollWidth > card.clientWidth + 1, over };
  });
  // (the card's scrollWidth is 4 px over its clientWidth at 320 px in the P08.1 build too: its padding, not content)
  check('24. HOW TO PLAY at 320x568: Ship Signature Abilities follows Silent Running / Gravity Shadow, all six ships in order, the touch wording, nothing wider than the card or the view', g.at > g.shield && g.shield > g.silent && g.silent >= 0 && g.ships.every((i, k) => i > g.at && (k === 0 || i > g.ships[k - 1])) && g.tap && g.wideBy.length === 0 && g.over.length === 0, g);
  await close(o, '24 guide');
}

async function main() {
  const browser = await chromium.launch();
  try {
    // P08_ONLY=layout,narrowGuide runs a subset while iterating (the full run is the record)
    const only = process.env.P08_ONLY?.split(',') ?? null;
    for (const [name, fn] of Object.entries({ swift, shrike, petrel, magpie, condor, albatross, dockAndShip, controls, touch, everyShip, touchButton, oneTapOneRequest, sectorExit, scanDisplay, layout, narrowGuide })) if (!only || only.includes(name)) await fn(browser);
  } finally {
    await browser.close();
  }
  check('no page errors (all scenarios)', errsAll.length === 0, errsAll);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
