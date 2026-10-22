// GALAXIA FR Prompt 16: release check of BOTH modes in a production build, served the way
// GitHub Pages serves a project site.
//
// Usage (folder with `playwright` installed):
//   BASE_PATH=/any-repo-name/ npx vite build --outDir /tmp/rel/dist     # in the project
//   node release-p16.mjs /tmp/rel/dist /any-repo-name/ [chromium,firefox,webkit] [shotDir]
//
// The server mimics Pages: files only under the base path, a folder serves its index.html,
// anything else gets dist/404.html with HTTP 404 (no SPA fallback). It logs every request and
// its byte count, so the check can prove what each screen downloads.
// Devices are EMULATED (viewport, DPR, touch); nothing here is a physical-device result.
//
//  A. first load: only the entry JS, CSS and icons download; Free Roam's chunk does not;
//  B. Classic plays (start, move, hold-to-fire heat) and still no Free Roam download;
//  C. Free Roam: the chunk downloads once on demand; enter Sol; thrust moves the ship; firing
//     spends shots and heats the weapon; flying through salvage fills the hold; SAVE NOW;
//  D. reload: Free Roam's save, Classic's high score and shared prefs all survive;
//  E. URLs under the base: ?mode=freeroam deep link and its refresh, index.html, an unknown
//     deep path (404 -> back to the title), a path outside the base;
//  F. sizes (phone portrait/landscape with touch, tablet, desktop): both modes fit with no
//     page scroll, and touch can start a flight;
//  every page: no page errors, console errors or failed requests (console warnings listed).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const DIST = process.argv[2] ?? 'dist';
const BASE = process.argv[3] ?? '/galaxia/';
const ENGINES = (process.argv[4] ?? 'chromium,firefox,webkit').split(',');
const SHOTS = process.argv[5] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const BT = { chromium, firefox, webkit };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOL = 'milky-way/sol';
const CLASSIC = JSON.stringify({ version: 1, highScore: 4242, bestStage: 3, totalGames: 5 });

const checks = [];
const notes = {};
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 1400)}`);
};

/* ---------- Pages-like static server with a request log ---------- */
let log = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = async (file, status = 200) => {
    const body = await readFile(file);
    res.writeHead(status, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
    log.push({ path: url.pathname, status, bytes: body.length });
  };
  const notFound = () => send(join(DIST, '404.html'), 404).catch(() => { res.writeHead(404); res.end('404'); });
  if (!url.pathname.startsWith(BASE)) return notFound();
  let rel = decodeURIComponent(url.pathname.slice(BASE.length));
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    await send(file);
  } catch {
    notFound();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const PAGE = ORIGIN + BASE;
const frChunk = () => log.filter((l) => /\/assets\/freeRoamMode-[^/]+\.js$/.test(l.path));
const kb = (n) => `${(n / 1000).toFixed(1)} kB`;

/* ---------- page helpers ---------- */
function seedOnce(recs) {
  if (!localStorage.getItem('p16-seeded')) {
    localStorage.setItem('p16-seeded', '1');
    for (const [k, v] of Object.entries(recs)) localStorage.setItem(k, v);
  }
}
const fr = (p) =>
  p.evaluate(() => {
    const f = window.__galaxiaFreeRoam;
    if (!f) return null;
    const s = f.sector();
    const r = f.state;
    return {
      screen: f.screen(), panel: f.panel(), phase: r?.phase, tick: r?.tick, system: s.systemId,
      ship: r?.ship ? { x: r.ship.x, y: r.ship.y } : null, pois: s.pois, shotsFired: r?.shotsFired ?? 0, heat: r?.heat ?? 0,
      cargo: f.profile().cargo, done: f.profile().sectors?.['milky-way/sol']?.done ?? [], saves: f.saves(),
    };
  });
const waitFr = async (p, pred, ms = 12000) => {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < ms) {
    try { s = await fr(p); } catch { s = null; }
    if (s && pred(s)) return s;
    await sleep(60);
  }
  return s;
};
const host = (p) => p.evaluate(() => window.__galaxia?.debug().state ?? null);
const waitHost = (p, state, ms = 12000) => p.waitForFunction((st) => window.__galaxia?.debug().state === st, state, { timeout: ms }).then(() => true, () => false);
const scroll = (p) => p.evaluate(() => ({ w: document.scrollingElement.scrollWidth, h: document.scrollingElement.scrollHeight, iw: innerWidth, ih: innerHeight, y: scrollY, x: scrollX }));
const fits = (s) => s.w <= s.iw + 1 && s.h <= s.ih + 1 && s.x === 0 && s.y === 0;
const held = (c) => Object.values(c).reduce((a, b) => a + b, 0);
const shot = async (p, name) => {
  if (!SHOTS) return;
  await sleep(name.startsWith('webkit') ? 800 : 250);
  await p.screenshot({ path: join(SHOTS, `p16-${name}.png`) });
};

async function launch(bname, { w = 1366, h = 768, touch = false, dpr = 1 } = {}) {
  const browser = await BT[bname].launch();
  const opts = { viewport: { width: w, height: h }, hasTouch: touch, deviceScaleFactor: dpr };
  if (touch && bname !== 'firefox') opts.isMobile = true;
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(seedOnce, { 'galaxia:save': CLASSIC });
  const p = await ctx.newPage();
  const errs = [];
  const warns = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => {
    if (m.type() === 'error') errs.push('console: ' + m.text());
    else if (m.type() === 'warning') warns.push(m.text());
  });
  p.on('requestfailed', (r) => errs.push(`requestfailed ${r.url()} ${r.failure()?.errorText ?? ''}`));
  p.on('response', (r) => r.status() >= 400 && errs.push(`${r.status()} ${r.url()}`));
  return { browser, ctx, p, errs, warns };
}
async function enterSol(p, touch = false) {
  const sel = '.fr-map:not(.fr-sysmap) .fr-det-actions >> text=ENTER SECTOR';
  if (touch) await p.tap(sel);
  else await p.click(sel);
  await waitFr(p, (s) => s.screen === 'flight' && s.panel === 'briefing');
  if (touch) await p.tap('.fr-panel-briefing >> text=START FLIGHT');
  else await p.keyboard.press('Enter');
  return waitFr(p, (s) => s.phase === 'flight' && s.panel === null);
}

/* ---------- A-E desktop ---------- */
async function desktop(bname) {
  const { browser, p, errs, warns } = await launch(bname);
  try {
    /* A. first load */
    log = [];
    await p.goto(PAGE, { waitUntil: 'load' });
    const menu = await waitHost(p, 'menu');
    await sleep(1200); // idle: anything prefetched would show up now
    const first = log.slice();
    const firstBytes = first.reduce((n, l) => n + l.bytes, 0);
    notes[`${bname} first load`] = `${first.length} requests, ${kb(firstBytes)} (${first.map((l) => l.path.slice(BASE.length) || '/').join(', ')})`;
    check(`${bname}: A title loads at ${BASE}; every request is under the base and succeeds`, menu && first.every((l) => l.path.startsWith(BASE) && l.status === 200), { first });
    check(`${bname}: A first load fetches only HTML, the entry JS, CSS and icons; Free Roam is not downloaded`, frChunk().length === 0 && first.every((l) => /(\/|\.html|\/assets\/index-[^/]+\.(js|css)|\.(png|svg))$/.test(l.path)), { first });

    /* B. Classic */
    await p.click('.mode-card-classic');
    await p.waitForFunction(() => window.__galaxiaGame?.engine, null, { timeout: 10000 });
    await sleep(300);
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => ['playing', 'challenge'].includes(window.__galaxiaGame.engine.phase), null, { timeout: 10000 });
    const x0 = await p.evaluate(() => window.__galaxiaGame.engine.world.player.x);
    await p.keyboard.down('ArrowLeft');
    await sleep(500);
    await p.keyboard.up('ArrowLeft');
    const x1 = await p.evaluate(() => window.__galaxiaGame.engine.world.player.x);
    await p.keyboard.down('Space');
    await sleep(1200);
    const heat = await p.evaluate(() => window.__galaxiaGame.engine.world.heat.level);
    await p.keyboard.up('Space');
    await shot(p, `${bname}-classic`);
    check(`${bname}: B Classic starts, the fighter moves, held fire heats the weapon`, x1 < x0 - 10 && heat > 0, { x0, x1, heat });
    check(`${bname}: B playing Classic still downloads nothing from Free Roam`, frChunk().length === 0, { fr: frChunk() });
    await p.keyboard.press('Escape');
    await p.click('.screen-pause [data-action=quit]');
    await p.click('.mode-exit');
    check(`${bname}: B Classic -> pause -> QUIT -> ◀ MENU returns to the title`, await waitHost(p, 'menu'));

    /* C. Free Roam */
    await p.click('.mode-card-freeroam');
    let s = await waitFr(p, (x) => x.screen === 'map', 15000);
    check(`${bname}: C Free Roam opens (fresh pilot on the map) and its chunk downloads exactly once`, s?.screen === 'map' && frChunk().length === 1 && frChunk()[0].status === 200, { s: s?.screen, fr: frChunk() });
    notes[`${bname} Free Roam chunk`] = kb(frChunk()[0]?.bytes ?? 0);
    s = await enterSol(p);
    check(`${bname}: C enters the Sol sector`, s?.phase === 'flight' && s.system === SOL, { phase: s?.phase, sys: s?.system });
    await p.evaluate(() => { window.__galaxiaFreeRoam.state.grace = 1e9; }); // no ambush during the scripted checks
    const p0 = s.ship;
    await p.keyboard.down('ArrowUp');
    await sleep(700);
    await p.keyboard.up('ArrowUp');
    s = await fr(p);
    const moved = Math.hypot(s.ship.x - p0.x, s.ship.y - p0.y);
    check(`${bname}: C thrust (ArrowUp) moves the ship`, moved > 20, { moved });
    const f0 = s.shotsFired;
    await p.keyboard.down('Space');
    await sleep(900);
    s = await fr(p);
    await p.keyboard.up('Space');
    check(`${bname}: C holding fire spends shots and heats the weapon`, s.shotsFired > f0 + 2 && s.heat > 0, { fired: s.shotsFired - f0, heat: s.heat });
    const salvage = s.pois.filter((q) => q.kind === 'salvage' && !q.done).sort((a, b) => Math.hypot(a.x - s.ship.x, a.y - s.ship.y) - Math.hypot(b.x - s.ship.x, b.y - s.ship.y))[0];
    const before = held(s.cargo);
    await p.evaluate(([x, y]) => Object.assign(window.__galaxiaFreeRoam.state.ship, { x, y, px: x, py: y, vx: 0, vy: 0 }), [salvage.x - 90, salvage.y]);
    await p.keyboard.down('ArrowRight');
    s = await waitFr(p, (x) => x.pois.find((q) => q.id === salvage.id)?.done, 5000);
    await p.keyboard.up('ArrowRight');
    const cargoAfter = held(s.cargo);
    check(`${bname}: C flying through salvage fills the hold`, s.pois.find((q) => q.id === salvage.id)?.done && cargoAfter > before, { before, after: cargoAfter });
    await shot(p, `${bname}-freeroam-flight`);
    await p.keyboard.press('KeyP');
    await waitFr(p, (x) => x.panel === 'pause');
    await p.click('.fr-panel-pause >> text=SAVES');
    await waitFr(p, (x) => x.saves.open);
    await p.click('.fr-saves [data-key="save"]');
    s = await waitFr(p, (x) => /Saved to slot 1\./.test(x.saves.message ?? ''), 4000);
    const stored = await p.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith('galaxia:freeroam') && (localStorage.getItem(k) ?? '').includes(id)), salvage.id);
    check(`${bname}: C pause > SAVES > SAVE NOW saves slot 1 to localStorage`, /Saved to slot 1\./.test(s?.saves.message ?? '') && stored.length > 0, { msg: s?.saves.message, stored });

    /* D. reload keeps everything */
    log = [];
    await p.reload({ waitUntil: 'load' });
    // a reload returns to the mode the player was in (Free Roam); from the title, open it by its card
    await p.waitForFunction(() => window.__galaxia?.debug().state === 'menu' || window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 15000 });
    const reopened = (await host(p)) !== 'menu';
    if (!reopened) await p.click('.mode-card-freeroam');
    s = await waitFr(p, (x) => x.screen === 'map', 15000);
    notes[`${bname} reload lands on`] = reopened ? 'Free Roam map (last mode)' : 'title';
    const classicSave = await p.evaluate(() => localStorage.getItem('galaxia:save'));
    check(`${bname}: D after a reload Free Roam keeps the salvage find and the hold`, s?.done.includes(salvage.id) && held(s.cargo) === cargoAfter, { done: s?.done, cargo: s && held(s.cargo), want: cargoAfter });
    check(`${bname}: D Classic's high score record is untouched by Free Roam`, JSON.parse(classicSave).highScore === 4242, { classicSave });

    /* E. URLs under the base */
    log = [];
    await p.goto(`${PAGE}?mode=freeroam`, { waitUntil: 'load' });
    s = await waitFr(p, (x) => x.screen === 'map', 15000);
    await p.reload({ waitUntil: 'load' });
    const s2 = await waitFr(p, (x) => x.screen === 'map', 15000);
    check(`${bname}: E ${BASE}?mode=freeroam opens Free Roam directly, and a refresh reopens it`, s?.screen === 'map' && s2?.screen === 'map');
    await p.goto(`${PAGE}index.html`, { waitUntil: 'load' });
    check(`${bname}: E ${BASE}index.html serves the game`, await waitHost(p, 'menu'));
    // status from the server log: Firefox's goto() can return null when the 404 page redirects at once
    const statusOf = (path) => log.filter((l) => l.path === path).map((l) => l.status)[0] ?? null;
    await p.goto(`${PAGE}sector/milky-way/sol`, { waitUntil: 'load' });
    const ok404 = await waitHost(p, 'menu');
    const deep = statusOf(`${BASE}sector/milky-way/sol`);
    check(`${bname}: E an unknown deep path answers 404 and returns to the title at ${BASE}`, deep === 404 && ok404 && new URL(p.url()).pathname === BASE, { status: deep, url: p.url() });
    await p.goto(`${ORIGIN}/elsewhere/`, { waitUntil: 'load' });
    const back = await waitHost(p, 'menu');
    const out = statusOf('/elsewhere/');
    check(`${bname}: E a path outside the base also lands on the game (404 page redirect)`, out === 404 && back && new URL(p.url()).pathname === BASE, { status: out, url: p.url() });

    const real = errs.filter((e) => !/^404 .*\/(sector\/milky-way\/sol|elsewhere\/)$/.test(e) && !/status of 404/.test(e));
    check(`${bname}: desktop: no page errors, console errors or failed requests`, real.length === 0, { errs: real.slice(0, 8) });
    notes[`${bname} desktop console warnings`] = warns.length ? warns.slice(0, 5) : 'none';
  } finally {
    await browser.close();
  }
}

/* ---------- F. sizes ---------- */
const SIZES = [
  { name: 'phone-portrait', w: 390, h: 844, touch: true, dpr: 3 },
  { name: 'phone-landscape', w: 844, h: 390, touch: true, dpr: 3 },
  { name: 'tablet', w: 1024, h: 768, touch: true, dpr: 2 },
  { name: 'desktop-fhd', w: 1920, h: 1080, touch: false, dpr: 1 },
];
async function sizes(bname) {
  for (const z of SIZES) {
    const { browser, p, errs } = await launch(bname, z);
    try {
      await p.goto(`${PAGE}?mode=classic`, { waitUntil: 'load' });
      await p.waitForFunction(() => window.__galaxiaGame?.engine, null, { timeout: 10000 });
      await sleep(400);
      const cl = await scroll(p);
      const canvas = await p.evaluate(() => {
        const r = document.querySelector('canvas')?.getBoundingClientRect();
        return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
      });
      check(`${bname} ${z.name}: F Classic fits with no page scroll`, fits(cl) && canvas && canvas.r <= cl.iw + 1 && canvas.b <= cl.ih + 1, { cl, canvas });
      await shot(p, `${bname}-${z.name}-classic`);
      await p.goto(`${PAGE}?mode=freeroam`, { waitUntil: 'load' });
      let s = await waitFr(p, (x) => x.screen === 'map', 15000);
      const map = await scroll(p);
      s = await enterSol(p, z.touch);
      await sleep(300);
      const fl = await scroll(p);
      check(`${bname} ${z.name}: F Free Roam map and flight fit with no page scroll${z.touch ? '; touch taps start the flight' : ''}`, s?.phase === 'flight' && fits(map) && fits(fl), { phase: s?.phase, map, fl });
      await shot(p, `${bname}-${z.name}-freeroam`);
      check(`${bname} ${z.name}: F no page errors or failed requests`, errs.length === 0, { errs: errs.slice(0, 5) });
    } finally {
      await browser.close();
    }
  }
}

try {
  for (const b of ENGINES) {
    try {
      await desktop(b);
    } catch (e) {
      check(`${b}: desktop run completed`, false, { error: String(e).slice(0, 600) });
    }
    try {
      await sizes(b);
    } catch (e) {
      check(`${b}: size run completed`, false, { error: String(e).slice(0, 600) });
    }
  }
} finally {
  server.close();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(JSON.stringify({ base: BASE, notes }, null, 1));
console.log(`SUMMARY ${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
