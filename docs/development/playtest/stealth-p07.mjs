// P07.1 Gravity Shadow and Silent Running in a real browser (QA build: needs window.__galaxiaFreeRoam).
//   node stealth-p07.mjs [pageUrl]
// The hooks only place ships (test placement, as earlier harnesses do; the watched ship is detached from its
// ambush so the encounter leash does not despawn it): the ambush hostiles are real, every
// decision is the game's own 60 Hz simulation, and Silent Running, FIRE, boost, pause and restart go through
// the real keys. Scenarios (Sirius, the Petrel; its planet, r 116, is the occluder):
//   1. clear space: a real hostile acquires the pilot and opens fire;
//   2. behind the planet: the contact is held for exactly STEALTH.memoryTicks (75) ticks at the frozen
//      last-observed position with no new shot, then dropped (investigate); the drop is not caused by range;
//   3. back in view: reacquired, with the reaction delay starting again;
//   4. Silent Running (Z): no acquisition at 0.6 x detect range; Z off again: acquired;
//   5. silent, close in (0.25 x detect): still acquired (never invisible);
//   6. FIRE while silent: Silent Running ends and exactly one shot is fired; boost: ends it and boosts;
//   7. pause during contact memory: memory, tick and Silent Running freeze; resume continues;
//   8. RESTART FLIGHT clears Silent Running; a reload starts normal; CONTROLS lists SILENT RUNNING (Z).
// P07.2 (the HUD, the touch control, the notices and the guide; each check compares the DOM with the run state):
//   9.  the SILENT control (1280x720): off = quiet, names Z; on / off follow Z, FIRE and boost, with one exact
//       log line each (the automatic ends name their input); shield recharge is really paused while it says so;
//   10. GRAVITY SHADOW shows only while the AI's own result (Agent.shadow) says a body blocks the hostile; the
//       memory window shows ... SEARCHING / LAST KNOWN POSITION and clears on reacquire; hugging the planet with
//       a clear line shows no shadow; pause hides the column and resume shows the same state; restart clears it;
//   11. dock and ship change (Sol, two owned ships): off after docking, after the change and on launch;
//   12. HOW TO PLAY (pause) shows the Silent Running and Gravity Shadow sections with the current key;
//   13. touch at 390x844, 320x568, 568x320 and 844x390: tap on / tap off (its own pointer role, never the stick, never FIRE), FIRE
//       turns it off and the button follows, >= 44 px target, clear of the stick zone, FIRE, BOOST, WPN, LOCK,
//       NEXT TARGET (locked), the top HUD buttons and the ship card; desktop 1920x1080 placement.
// Automated Chromium only: no physical device was used.
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4181/galaxia/';
const SOL = 'milky-way/sol';
const SIRIUS = 'milky-way/sirius';
const DETECT = { raider: 420, picket: 480, lancer: 560, heavy: 520, recon: 760, hauler: 420, elite: 640, capital: 800 };
const MEMORY = 75;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};
const PILOT = {
  version: 10, createdAt: 1, sessions: 5, flightSeconds: 900, beaconsCharted: 3, surveysCompleted: 1, bestSurveyTicks: 5000,
  currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL, SIRIUS], galaxySurveys: { 'milky-way': 1 },
  currentSystem: SIRIUS, visitedSystems: [SOL, SIRIUS], sectors: { [SOL]: { done: [], surveyed: true }, [SIRIUS]: { done: [], surveyed: true } },
  cargo: { scrap: 20, fuel: 8, ice: 4 },
  fleet: { active: 'petrel', owned: ['petrel'], loadouts: {} },
  lostCargo: null, modules: {}, milestones: [],
  progression: { marks: 100, missions: { active: [], completed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], claimed: ['story-first-light', 'story-scrap-and-signal', 'story-silent-hull'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
  savedAt: 1, resume: null,
};
function seedOnce(rec) {
  if (!sessionStorage.getItem('p07-seeded')) {
    sessionStorage.setItem('p07-seeded', '1');
    localStorage.setItem('galaxia:freeroam', JSON.stringify(rec));
    localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
  }
}
const frames = (p, n = 3) => p.evaluate((k) => new Promise((r) => { const step = () => (k-- <= 0 ? r() : requestAnimationFrame(step)); requestAnimationFrame(step); }), n);
const feed = (p) => p.evaluate(() => [...document.querySelectorAll('.fr-feed-line')].map((t) => t.textContent));
/** One snapshot of the run and the watched hostile, plus what the SILENT control and the stealth tag show. */
const snap = (p) => p.evaluate(() => {
  const ui = () => {
    const vis = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const b = document.querySelector('.fr-silent');
    const t = document.querySelector('.fr-stealth');
    return { shown: vis(b), state: b?.dataset.state, pressed: b?.getAttribute('aria-pressed'), text: b?.children[0]?.textContent, hint: vis(b) ? b.children[1].innerText : '', aria: b?.getAttribute('aria-label'), tag: vis(t) ? t.innerText : '' };
  };
  const f = window.__galaxiaFreeRoam;
  const r = f.state;
  const w = window.__p07;
  const h = w ? r.hostiles.find((a) => a.id === w.hid) : null;
  return {
    screen: f.screen(), panel: f.panel(), phase: r.phase, tick: r.tick, silent: r.silent, shotsFired: r.shotsFired, energy: r.energy, boosting: r.boosting,
    ship: { x: r.ship.x, y: r.ship.y },
    h: h ? { id: h.id, family: h.family, target: h.target, lost: h.lost, shadow: h.shadow, state: h.state, reaction: h.reaction, lastSeen: h.lastSeen && { ...h.lastSeen } } : null,
    shield: r.shield,
    ui: ui(),
    hShots: h ? r.enemyShots.filter((s) => s.owner === h.id).map((s) => s.id) : [],
  };
});
/** Pin the watched hostile at H and (unless null) the pilot at P every frame; every other hostile far away. */
const pin = (p, P) => p.evaluate((P) => { window.__p07.P = P; }, P);

async function open() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(seedOnce, PILOT);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  await p.goto(PAGE + '?mode=freeroam', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
  return { browser, ctx, p, errs };
}

/** Spring the Sirius ambush, keep the pilot alive, pick one real hostile and start the pin loop beside the planet. */
async function setup(p) {
  await p.evaluate(() => {
    const r = window.__galaxiaFreeRoam.state;
    const enc = r.layout.sites.find((s) => s.kind === 'ambush');
    Object.assign(r.ship, { x: enc.x, y: enc.y, px: enc.x, py: enc.y, vx: 0, vy: 0 });
    r.grace = 0;
    r.invuln = 1e9;
  });
  // an ambush warp-in (role 'wave'): patrols and guards are leashed to their posts, so they cannot be held beside the planet
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.hostiles.some((h) => h.state !== 'destroyed' && h.role === 'wave' && h.faction !== 'gleaners'), null, { timeout: 15000 });
  await sleep(300);
  return p.evaluate(() => {
    const r = window.__galaxiaFreeRoam.state;
    const B = r.layout.landmarks.find((l) => l.kind === 'body');
    const h = r.hostiles.find((a) => a.state !== 'destroyed' && a.role === 'wave' && a.faction !== 'gleaners');
    const H = { x: B.x - B.r - 140, y: B.y };
    // test placement: the watched ship leaves its ambush (the encounter breaks once the pilot is far from its site,
    // and that despawns its ships); it stays the same real ship with the same AI
    h.source = 'p07-watch';
    window.__p07 = { hid: h.id, H, P: { x: H.x, y: H.y + 2000 } };
    const loop = () => {
      const w = window.__p07;
      if (!w) return;
      const run = window.__galaxiaFreeRoam.state;
      for (const a of run.hostiles) {
        if (a.state === 'destroyed') continue;
        const q = a.id === w.hid ? w.H : { x: w.H.x - 2600, y: w.H.y + 3000 + a.id * 60 };
        Object.assign(a, { x: q.x, y: q.y, px: q.x, py: q.y, vx: 0, vy: 0 });
      }
      if (w.P) Object.assign(run.ship, { x: w.P.x, y: w.P.y, px: w.P.x, py: w.P.y, vx: 0, vy: 0 });
      run.invuln = 1e9;
      run.hull = run.craft.stats.hull;
      requestAnimationFrame(loop);
    };
    loop();
    return { body: { x: B.x, y: B.y, r: B.r }, H, family: h.family, id: h.id };
  });
}

/** Sample every frame until pred(snapshot) or timeout; returns all samples. */
async function until(p, pred, ms) {
  const out = [];
  const t0 = Date.now();
  for (;;) {
    const s = await snap(p);
    out.push(s);
    if (pred(s) || Date.now() - t0 > ms) return out;
    await frames(p, 1);
  }
}

async function main() {
  const { browser, p, errs } = await open();
  const g = await setup(p);
  const D = DETECT[g.family];
  const { H, body } = g;
  const clear = { x: H.x, y: H.y + 300 };
  const hidden = { x: body.x + body.r + 140, y: body.y };
  const far = { x: H.x, y: H.y + Math.round(D * 1.3) + 400 };
  const away = Math.hypot(hidden.x - H.x, hidden.y - H.y);
  console.log(`hostile #${g.id} ${g.family} (detect ${D}); planet r ${body.r}; hidden distance ${Math.round(away)}`);

  // 1. clear space: acquired, and it fires
  await pin(p, clear);
  let s = (await until(p, (q) => q.h?.target === 'player' && q.hShots.length > 0, 6000)).at(-1);
  check('1. clear space: the real hostile acquires the pilot and opens fire', s.h?.target === 'player' && s.hShots.length > 0, s);

  // 2. behind the planet: held for exactly 75 ticks, no new shot, then dropped
  const shotsBefore = new Set(s.hShots);
  await pin(p, hidden);
  const seq = await until(p, (q) => q.h?.target === null, 5000);
  const mem = seq.filter((q) => q.h?.target === 'player' && q.h.lost > 0);
  const lastObs = new Set(mem.map((q) => q.tick - q.h.lost));
  const dropped = seq.at(-1);
  const maxLost = Math.max(0, ...mem.map((q) => q.h.lost));
  const frozen = new Set(mem.map((q) => JSON.stringify(q.h.lastSeen))).size === 1;
  const newShots = seq.flatMap((q) => q.hShots).filter((id) => !shotsBefore.has(id));
  check('2a. behind the planet the contact is held as memory (lost counts up) at one frozen last-observed position', mem.length > 3 && frozen && lastObs.size === 1, { n: mem.length, frozen, lastObs: [...lastObs] });
  check(`2b. memory boundary: at most ${MEMORY} ticks, then dropped ${MEMORY + 1} ticks after the last sight (investigate)`, maxLost <= MEMORY && maxLost >= MEMORY - 6 && dropped.h?.target === null && dropped.tick - [...lastObs][0] >= MEMORY + 1 && dropped.h.state === 'investigate', { maxLost, dropTick: dropped.tick, lastObs: [...lastObs], state: dropped.h?.state });
  check('2c. no new shot from it while the planet hides the pilot', newShots.length === 0, { newShots });
  check(`2d. the loss is the planet, not range (${Math.round(away)} px is inside its held range ${Math.round(D * 1.3)})`, away < D * 1.3, { away, D });
  const tagOk = seq.slice(2).every((q) => (q.h?.shadow ? /GRAVITY SHADOW\s+HIDDEN FROM 1 HOSTILE/.test(q.ui.tag) : !/GRAVITY SHADOW/.test(q.ui.tag)));
  const shadowSeen = seq.filter((q) => q.h?.shadow && /GRAVITY SHADOW/.test(q.ui.tag)).length;
  const searchOk = seq.slice(2).every((q) => (q.h?.lost > 1 ? /1 HOSTILE SEARCHING\s+LAST KNOWN POSITION/.test(q.ui.tag) : q.h?.lost === 0 ? !/SEARCHING/.test(q.ui.tag) : true));
  check('10a. GRAVITY SHADOW shows exactly while the AI reports the planet blocking the hostile (frame by frame), never before', tagOk && shadowSeen > 10 && !/GRAVITY SHADOW/.test(seq[0].ui.tag), { shadowSeen, first: seq[0].ui.tag, bad: seq.slice(2).find((q) => (q.h?.shadow ? !/GRAVITY SHADOW/.test(q.ui.tag) : /GRAVITY SHADOW/.test(q.ui.tag))) });
  // when the memory expires the held range (x1.3) goes too: at 512 px the raider is then out of range, so the AI
  // no longer counts a shadow either (range, not the planet, hides the pilot) and the tag empties with it
  check('10b. the contact memory shows "1 HOSTILE SEARCHING / LAST KNOWN POSITION" while lost > 0, and it clears when the memory expires', searchOk && /SEARCHING/.test(mem.at(-1)?.ui.tag ?? '') && !/SEARCHING/.test(dropped.ui.tag) && /GRAVITY SHADOW/.test(dropped.ui.tag) === !!dropped.h.shadow, { last: mem.at(-1)?.ui.tag, dropped: dropped.ui.tag, shadow: dropped.h.shadow });
  check('10c. the tag never shows coordinates, distances or protection claims', seq.every((q) => !/\d{3,}|INVULN|IMMUNE|CLOAK|INVISIBLE|SAFE/.test(q.ui.tag)), { tag: dropped.ui.tag });

  // 3. back in view: reacquired with a fresh reaction delay
  await pin(p, clear);
  s = (await until(p, (q) => q.h?.target === 'player', 3000)).at(-1);
  check('3. back in view: reacquired, the reaction delay starting again', s.h?.target === 'player' && s.h.reaction > 0, s.h);
  await frames(p, 2);
  s = await snap(p);
  check('10d. reacquired in clear view: the stealth tag is gone (no shadow, no search)', s.h?.target === 'player' && !s.h.shadow && s.ui.tag === '', { tag: s.ui.tag, h: s.h });

  // 10e. proximity alone is not a shadow: the pilot 25 px off the planet's surface, the hostile's line passing beside it
  await p.evaluate((b) => { window.__p07.H = { x: b.x - 260, y: b.y + b.r + 25 }; }, body);
  await pin(p, { x: body.x + 40, y: body.y + body.r + 25 });
  const hug = await until(p, (q) => q.h?.target === 'player' && q.tick > s.tick + 30, 3000);
  const hl = hug.at(-1);
  check('10e. hugging the planet (25 px off its surface) with a clear line: no GRAVITY SHADOW, the hostile tracks the pilot', hl.h?.target === 'player' && hug.slice(3).every((q) => !q.h.shadow && !/GRAVITY SHADOW/.test(q.ui.tag)), { tag: hl.ui.tag, h: hl.h });
  await p.evaluate((H) => { window.__p07.H = H; }, H);
  await pin(p, clear);
  await until(p, (q) => q.h?.target === 'player', 2000);

  // 4. Silent Running: no acquisition at 0.6 x detect; Z off again: acquired
  await pin(p, far);
  await until(p, (q) => q.h?.target === null, 4000);
  s = await snap(p);
  check('9a. off: the SILENT control is on screen, quiet and names the key (SILENT · Z · LOW SIGNATURE, aria-pressed false)', s.ui.shown && s.ui.state === 'off' && s.ui.pressed === 'false' && s.ui.text === 'SILENT' && /^Z · LOW SIGNATURE$/.test(s.ui.hint) && /\(Z\): off/.test(s.ui.aria), s.ui);
  const f0 = (await feed(p)).length;
  await p.keyboard.press('KeyZ');
  await frames(p, 4);
  s = await snap(p);
  const lines = (await feed(p)).slice(f0 > 0 ? f0 - 1 : 0);
  check('4a. Z turns Silent Running on (the run state; one SILENT RUNNING log line)', s.silent === true && lines.some((t) => /SILENT RUNNING/.test(t)), { silent: s.silent, lines });
  check('9b. Z on: the control reads SILENT RUNNING / LOW SIGNATURE / SHIELD RECHARGE PAUSED / FIRE OR BOOST ENDS IT, aria-pressed true; one "SILENT RUNNING ON" line', s.ui.state === 'on' && s.ui.pressed === 'true' && s.ui.text === 'SILENT RUNNING' && s.ui.hint === 'LOW SIGNATURE\nSHIELD RECHARGE PAUSED\nFIRE OR BOOST ENDS IT' && lines.filter((t) => t === 'SILENT RUNNING ON').length === 1, { ui: s.ui, lines });
  await pin(p, { x: H.x, y: H.y + Math.round(D * 0.6) });
  const quiet = await until(p, (q) => q.h?.target === 'player', 2000);
  check('4b. silent at 0.6 x detect range: no acquisition for 2 s', quiet.every((q) => q.h?.target !== 'player') && quiet.at(-1).silent, { last: quiet.at(-1).h });
  await p.keyboard.press('KeyZ');
  s = (await until(p, (q) => q.h?.target === 'player', 2000)).at(-1);
  check('4c. Z again: normal signature, acquired at the same distance', s.silent === false && s.h?.target === 'player', s);
  await frames(p, 2);
  s = await snap(p);
  const offLines = (await feed(p)).filter((t) => /^SILENT RUNNING OFF/.test(t));
  check('9c. Z off: the control is back to SILENT (aria-pressed false); the log says "SILENT RUNNING OFF" (no cause)', s.ui.state === 'off' && s.ui.pressed === 'false' && s.ui.text === 'SILENT' && offLines.at(-1) === 'SILENT RUNNING OFF', { ui: s.ui, offLines });

  // 5. silent close in: still seen
  await pin(p, far);
  await until(p, (q) => q.h?.target === null, 4000);
  await p.keyboard.press('KeyZ');
  await pin(p, { x: H.x, y: H.y + Math.round(D * 0.25) });
  s = (await until(p, (q) => q.h?.target === 'player', 2000)).at(-1);
  check('5. silent at 0.25 x detect: still acquired (not invisible)', s.silent === true && s.h?.target === 'player', s);
  check('9d. silent and detected close in: the control still says SILENT RUNNING and no shadow is claimed', s.ui.state === 'on' && !/GRAVITY SHADOW/.test(s.ui.tag), s.ui);

  // 6. FIRE and boost while silent: each ends Silent Running and runs once
  let a = await snap(p);
  await p.keyboard.press('Space');
  await frames(p, 6);
  let b = await snap(p);
  check('6a. FIRE while silent: Silent Running ends and exactly one shot is fired', a.silent && !b.silent && b.shotsFired - a.shotsFired === 1, { a: a.shotsFired, b: b.shotsFired, silent: b.silent });
  const fl = (await feed(p)).filter((t) => /^SILENT RUNNING OFF/.test(t));
  check('9e. FIRE: the control turns off on its own and the log names the cause once ("SILENT RUNNING OFF — FIRE INPUT")', a.ui.state === 'on' && b.ui.state === 'off' && b.ui.pressed === 'false' && fl.at(-1) === 'SILENT RUNNING OFF — FIRE INPUT' && fl.filter((t) => t.endsWith('FIRE INPUT')).length === 1, { a: a.ui.state, b: b.ui.state, fl });
  await sleep(800); // past the plasma cooldown: a tap during the cooldown fires nothing, silent or not
  a = await snap(p);
  await p.keyboard.press('Space');
  await frames(p, 6);
  b = await snap(p);
  check('6b. the same press at normal signature also fires exactly one shot (no duplicate, nothing discarded)', b.shotsFired - a.shotsFired === 1, { a: a.shotsFired, b: b.shotsFired });
  await p.keyboard.press('KeyZ');
  await frames(p, 3);
  await pin(p, null);
  a = await snap(p);
  await p.keyboard.down('KeyD');
  await p.keyboard.down('ShiftLeft');
  const boost = await until(p, (q) => q.boosting, 1500);
  await p.keyboard.up('ShiftLeft');
  await p.keyboard.up('KeyD');
  b = boost.at(-1);
  check('6c. boost while silent: Silent Running ends and the boost runs through its normal path', a.silent && !b.silent && b.boosting && b.energy < a.energy, { a: { s: a.silent, e: a.energy }, b: { s: b.silent, e: b.energy, boosting: b.boosting } });
  await frames(p, 2);
  const bl = (await feed(p)).filter((t) => /^SILENT RUNNING OFF/.test(t));
  const bu = await snap(p);
  check('9f. boost: the control turns off and the log names the cause once ("SILENT RUNNING OFF — BOOST INPUT")', a.ui.state === 'on' && bu.ui.state === 'off' && bl.at(-1) === 'SILENT RUNNING OFF — BOOST INPUT' && bl.filter((t) => t.endsWith('BOOST INPUT')).length === 1, { ui: bu.ui.state, bl });

  // 9g. the shield claim is the run's rule: no recharge while silent, recharge once off (behind the planet:
  // out of the raider's sight and clear of the hazard drain that lies at the far point)
  await pin(p, hidden);
  await until(p, (q) => q.h?.target === null, 4000);
  await p.keyboard.press('KeyZ');
  await frames(p, 3);
  await p.evaluate(() => { const r = window.__galaxiaFreeRoam.state; r.shield = Math.round(r.craft.stats.shield * 0.4); });
  const sh0 = await snap(p);
  await sleep(1500);
  const sh1 = await snap(p);
  await p.keyboard.press('KeyZ');
  await sleep(2500);
  const sh2 = await snap(p);
  check('9g. while the control says SHIELD RECHARGE PAUSED the shield does not recharge (1.5 s); off, it recharges', sh0.silent && /SHIELD RECHARGE PAUSED/.test(sh1.ui.hint) && sh1.shield <= sh0.shield && !sh2.silent && sh2.shield > sh1.shield && !/SHIELD/.test(sh2.ui.hint), { s0: sh0.shield, s1: sh1.shield, s2: sh2.shield, hint: sh1.ui.hint });

  // 7. pause during contact memory
  await pin(p, clear);
  await until(p, (q) => q.h?.target === 'player', 3000);
  await p.keyboard.press('KeyZ');
  await pin(p, hidden);
  await until(p, (q) => (q.h?.lost ?? 0) >= 10, 3000);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  const p0 = await snap(p);
  await sleep(1500);
  const p1 = await snap(p);
  check('7a. paused mid-memory: tick, contact memory and Silent Running are frozen for 1.5 s', p0.phase === 'paused' && p0.tick === p1.tick && p0.h.lost === p1.h.lost && p0.h.lost > 0 && p1.silent, { p0: [p0.tick, p0.h?.lost, p0.silent], p1: [p1.tick, p1.h?.lost, p1.silent] });
  check('10f. paused: the SILENT control and the stealth tag step back with the rest of the flight controls', !p1.ui.shown && p1.ui.tag === '', p1.ui);
  await sleep(400);
  await p.click('.fr-pause-resume');
  const r1 = (await until(p, (q) => q.phase === 'flight' && (q.h?.lost ?? 0) > p1.h.lost, 2000)).at(-1);
  check('7b. resumed: the memory carries on from where it stopped (Silent Running kept)', r1.phase === 'flight' && (r1.h.lost > p1.h.lost || r1.h.target === null) && r1.silent, { lost: r1.h?.lost, silent: r1.silent });
  check('10g. resumed: the control shows the same state (SILENT RUNNING) and the tag follows the memory', r1.ui.shown && r1.ui.state === 'on' && (r1.h.lost > 1 ? /SEARCHING/.test(r1.ui.tag) : true), r1.ui);

  // 8. restart and reload: no stale state; the binding is listed
  await p.evaluate(() => { window.__p07 = null; });
  s = await snap(p);
  if (!s.silent) {
    await p.keyboard.press('KeyZ');
    await frames(p, 3);
  }
  const preRestart = (await snap(p)).silent;
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(400);
  await p.keyboard.press('KeyR');
  await sleep(150);
  await p.keyboard.press('KeyR');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, null, { timeout: 5000 });
  s = await snap(p);
  check('8a. RESTART FLIGHT clears Silent Running', preRestart === true && s.silent === false, { preRestart, after: s.silent });
  await frames(p, 2);
  s = await snap(p);
  check('10h. after RESTART FLIGHT the control reads SILENT (off), never a stale SILENT RUNNING', s.ui.shown && s.ui.state === 'off' && s.ui.text === 'SILENT' && s.ui.tag === '', s.ui);
  await p.keyboard.press('KeyZ');
  await frames(p, 3);
  const before = (await snap(p)).silent;
  await p.reload({ waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight');
  s = await snap(p);
  // no saved key names it (the mission id 'story-silent-hull' is a value, not stealth state)
  const keys = await p.evaluate(() => {
    const out = [];
    const walk = (v) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); walk(x); } };
    walk(JSON.parse(localStorage.getItem('galaxia:freeroam') ?? '{}'));
    walk(JSON.parse(localStorage.getItem('galaxia:freeroam:prefs') ?? '{}'));
    return out.filter((k) => /silent|stealth|signature/i.test(k));
  });
  check('8b. a reload starts at normal signature; nothing about it is saved', before === true && s.silent === false && keys.length === 0, { before, after: s.silent, keys });
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
  await sleep(400);
  await p.click('#fr-pause-settings');
  await sleep(400);
  await p.click('.fr-panel-pause .fr-pause-item:text-is("CONTROLS")');
  await sleep(300);
  const row = await p.evaluate(() => {
    const r = [...document.querySelectorAll('.fr-controls-row')].find((x) => /Silent running/i.test(x.textContent));
    return r ? [...r.children].map((c) => c.textContent.trim()) : [];
  });
  check('8c. CONTROLS lists Silent running on Z (rebindable like every flight action)', /Silent running/i.test(row[0] ?? '') && row.includes('Z'), { row });

  // 12. HOW TO PLAY from the pause menu: the controls step carries the row and both sections
  await p.keyboard.press('Escape');
  await sleep(300);
  if ((await p.evaluate(() => window.__galaxiaFreeRoam.panel())) !== 'pause') {
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause');
    await sleep(300);
  }
  if (!(await p.isVisible('.fr-panel-pause .fr-pause-item:text-is("HOW TO PLAY")'))) await p.click('#fr-pause-settings');
  await sleep(300);
  await p.click('.fr-panel-pause .fr-pause-item:text-is("HOW TO PLAY")');
  await p.waitForSelector('.guide-dot');
  await p.locator('.guide-dot').nth(3).click();
  await sleep(300);
  const gk = await p.evaluate(() => document.querySelector('.guide-body').innerText);
  await p.click('.guide-seg-opt[data-value="touch"]');
  await sleep(300);
  const gt = await p.evaluate(() => document.querySelector('.guide-body').innerText);
  const both = (t) => ['SILENT RUNNING', 'NOT INVISIBLE', 'Hostiles close by still detect you', 'does not recharge', 'fire or boost ends it', 'GRAVITY SHADOW', 'PER HOSTILE', 'LAST KNOWN', 'NOT A SHIELD'].every((w) => t.includes(w));
  check('12a. HOW TO PLAY (keyboard): the SILENT RUNNING row on Z and the Silent Running / Gravity Shadow sections', both(gk) && /Press Z to cut your signature/.test(gk) && !/admin|password|invulnerab|cloak/i.test(gk), { len: gk.length });
  check('12b. HOW TO PLAY (touch): the SILENT button row and the same sections', both(gt) && /Tap SILENT/.test(gt) && /Above the weapon button/.test(gt), { len: gt.length });

  check('no page errors', errs.length === 0, errs);
  await browser.close();

  await dockAndShip();
  for (const [w, h] of [[390, 844], [320, 568], [568, 320], [844, 390]]) await touchRun(w, h);
  await wideDesktop();
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

/** 11. dock and ship change in Sol (it has a station): Silent Running on, dock, change ship, launch. */
async function dockAndShip() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const rec = { ...PILOT, currentSystem: SOL, fleet: { active: 'petrel', owned: ['petrel', 'swift'], loadouts: {} } };
  await ctx.addInitScript(seedOnce, rec);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  await p.goto(PAGE + '?mode=freeroam', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
  await p.keyboard.press('KeyZ');
  await frames(p, 3);
  let s = await snap(p);
  const on = s.silent && s.ui.state === 'on';
  await p.evaluate(() => { const f = window.__galaxiaFreeRoam; const stn = f.sector().pois.find((q) => q.kind === 'station'); Object.assign(f.state.ship, { x: stn.x, y: stn.y + 70, px: stn.x, py: stn.y + 70, vx: 0, vy: 0 }); });
  await p.waitForFunction(() => { const f = window.__galaxiaFreeRoam; return f.sector().focus === f.sector().pois.find((q) => q.kind === 'station').id; }, null, { timeout: 4000 });
  await p.keyboard.press('KeyE');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'station');
  s = await snap(p);
  check('11a. docking ends Silent Running (the run) and the flight controls step back', on && s.silent === false && !s.ui.shown, { on, silent: s.silent, ui: s.ui });
  await p.click('.fr-tab-hangar');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'hangar');
  await p.click('.fr-hangar-ship[data-ship="swift"]');
  await p.click('.fr-hangar-action');
  await p.click('.fr-hangar-action');
  await sleep(200);
  const ship = await p.evaluate(() => window.__galaxiaFreeRoam.state.craft?.ship ?? window.__galaxiaFreeRoam.profile().fleet.active);
  await p.click('.fr-hangar-launch');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, null, { timeout: 5000 });
  await frames(p, 3);
  s = await snap(p);
  check('11b. ship change (Swift) and launch: normal signature, the control reads SILENT (off)', ship === 'swift' && s.silent === false && s.ui.shown && s.ui.state === 'off' && s.ui.text === 'SILENT', { ship, silent: s.silent, ui: s.ui });
  await p.keyboard.press('KeyZ');
  await frames(p, 3);
  s = await snap(p);
  check('11c. in the new ship Z works the same way (SILENT RUNNING)', s.silent && s.ui.state === 'on', s.ui);
  check('11d. no page errors (dock / ship change)', errs.length === 0, errs);
  await browser.close();
}

const rectOf = (p, sel) => p.evaluate((q) => [...document.querySelectorAll(q)].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map((e) => { const b = e.getBoundingClientRect(); return { sel: q, l: b.left, t: b.top, r: b.right, b: b.bottom }; }), sel);
const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

/** 13. touch layouts: tap on / off through the real pointer path; FIRE ends it; size and overlap. */
async function touchRun(w, h) {
  const tag = `13. touch ${w}x${h}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(seedOnce, PILOT);
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  await p.goto(PAGE + '?mode=freeroam&controls=touch', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await p.tap('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.tap('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(400);
  let s = await snap(p);
  check(`${tag}: off, the SILENT button is shown with touch words (no key), aria-pressed false`, s.ui.shown && s.ui.state === 'off' && s.ui.hint === 'LOW SIGNATURE' && s.ui.pressed === 'false', s.ui);
  const [btn] = await rectOf(p, '.fr-silent');
  await p.touchscreen.tap((btn.l + btn.r) / 2, (btn.t + btn.b) / 2);
  await frames(p, 4);
  s = await snap(p);
  const pv = await p.evaluate(() => window.__galaxiaFreeRoam.input());
  check(`${tag}: tap turns Silent Running on (the run and the button: SILENT RUNNING, aria-pressed true); no stick, no fire`, s.silent && s.ui.state === 'on' && s.ui.pressed === 'true' && s.ui.text === 'SILENT RUNNING' && /SHIELD PAUSED/.test(s.ui.hint) && !pv.stickActive && !pv.fire && s.shotsFired === 0, { ui: s.ui, pv: { stick: pv.stickActive, fire: pv.fire } });
  await p.screenshot({ path: `/tmp/pw/p07-touch-${w}x${h}-on.png` });
  // overlap with the on-state button (the widest); lock a hostile first so NEXT TARGET shows
  await setup(p);
  await pin(p, await p.evaluate(() => ({ x: window.__p07.H.x, y: window.__p07.H.y + 300 })));
  await until(p, (q) => q.h?.target === 'player', 3000);
  await p.evaluate(() => { window.__galaxiaFreeRoam.state.ship.heading = 0; }); // nose up, at the hostile
  await frames(p, 2);
  await p.tap('.fr-lock');
  await sleep(300);
  const [b2] = await rectOf(p, '.fr-silent');
  const others = [];
  for (const q of ['.fr-fire', '.fr-boost', '.fr-wpn', '.fr-lock:not(.fr-silent)', '.fr-target', '.fr-hud-buttons', '.fr-shipcard', '.fr-interact', '.fr-stop:not(.fr-silent)']) others.push(...(await rectOf(p, q)));
  const bad = others.filter((o) => hit(b2, o));
  const target = others.some((o) => o.sel === '.fr-target');
  check(`${tag}: on-state button >= 44 px, on screen, clear of FIRE / BOOST / WPN / LOCK / NEXT TARGET / HUD buttons / ship card`, b2.r - b2.l >= 44 && b2.b - b2.t >= 44 && b2.l >= 0 && b2.t >= 0 && b2.r <= w && b2.b <= h && bad.length === 0 && target, { b2, bad, target });
  check(`${tag}: clear of the stick's lower-left landing zone`, b2.l > w * 0.3 && b2.b < h * 0.75, b2);
  // FIRE ends it: the button follows the run
  await p.evaluate(() => { window.__p07.P = null; });
  // a real press: FIRE is a held control (a tap shorter than one frame is not a press), so hold it for 200 ms
  const [fire] = await rectOf(p, '.fr-fire');
  const pt = [{ x: (fire.l + fire.r) / 2, y: (fire.t + fire.b) / 2, id: 7 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await sleep(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await frames(p, 3);
  s = await snap(p);
  check(`${tag}: FIRE turns it off and the button follows at once (SILENT, aria-pressed false)`, !s.silent && s.ui.state === 'off' && s.ui.pressed === 'false', s.ui);
  await p.touchscreen.tap((b2.l + b2.r) / 2, (b2.t + b2.b) / 2);
  await frames(p, 4);
  const sOn = await snap(p);
  await p.touchscreen.tap((b2.l + b2.r) / 2, (b2.t + b2.b) / 2);
  await frames(p, 4);
  s = await snap(p);
  check(`${tag}: tap on, tap off again (one toggle per tap)`, sOn.silent && sOn.ui.state === 'on' && !s.silent && s.ui.state === 'off', { on: sOn.ui.state, off: s.ui.state });
  check(`${tag}: no page errors`, errs.length === 0, errs);
  await cdp.detach();
  await browser.close();
}

/** 1920x1080: the control sits in the empty lower-right corner, clear of the HUD. */
async function wideDesktop() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(seedOnce, PILOT);
  const p = await ctx.newPage();
  await p.goto(PAGE + '?mode=freeroam', { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
  await sleep(300);
  await p.click('.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR');
  await p.click('.fr-panel-briefing >> text=START FLIGHT');
  await p.waitForFunction(() => window.__galaxiaFreeRoam.state.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null);
  await sleep(300);
  await p.keyboard.press('KeyZ');
  await frames(p, 3);
  const [b] = await rectOf(p, '.fr-silent');
  const others = [];
  for (const q of ['.fr-hud-buttons', '.fr-shipcard', '.fr-top', '.fr-hint', '.fr-nearby']) others.push(...(await rectOf(p, q)));
  const bad = others.filter((o) => hit(b, o));
  await p.screenshot({ path: '/tmp/pw/p07-desktop-1920-on.png' });
  check('13. desktop 1920x1080: SILENT RUNNING in the lower-right corner, on screen, clear of the HUD and the key hint', b && b.r <= 1920 && b.b <= 1080 && b.l > 960 && b.t > 540 && bad.length === 0, { b, bad });
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
