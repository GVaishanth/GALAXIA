// Finale P2: the home-page theme, Music Volume and Mute Music in a real browser
// (QA build: needs window.__galaxia, window.__galaxiaFreeRoam and window.__galaxiaMusicProbe).
//   node music-theme-f2.mjs [pageUrl] [chromium]
// Automated Chromium (Playwright) only. Headless Chromium runs the AudioContext with no speakers: this
// proves states, scheduling, levels and lifecycle, never how the music sounds to a person.
//   A  desktop, the browser's own autoplay rule (no context before a gesture): PLAY MUSIC starts the theme;
//      slider (keyboard, pointer), volume 0, MUTE MUSIC via Classic SETTINGS (music bus only: effects still
//      play; it is no longer a home-page control), volume while muted, reload persistence, gameplay stops
//      the theme, returning home restarts it from the top,
//      rapid navigation, a hidden tab (simulated visibilitychange), Classic SETTINGS, offline render levels;
//   B  autoplay refused (simulated: every resume() rejected): truthful BLOCKED state, no retry loop,
//      gameplay unaffected, PLAY MUSIC works once the browser allows it;
//   C  deep links and a muted profile never download the music chunk;
//   D  phone 320x568, touch, reduced motion: fit, 44 px targets, touch start and slider, inert under the guide;
//   E  a browser that allows autoplay (--autoplay-policy flag + getAutoplayPolicy): plays with no gesture;
//   K  keyboard: Enter / Space on PLAY MUSIC (music only, never a mute), MUTE MUSIC, the Tab order and focus rings,
//      HOW TO PLAY opens the guide from the keyboard, Enter with nothing focused still starts a mode;
//   F  Free Roam: the SOUND panel's MUTE MUSIC (the same galaxia:prefs preference); flight works with the theme gone;
//   +  no page errors, no AudioContext console warnings.
import { chromium } from 'playwright';

const PAGE = process.argv[2] ?? 'http://127.0.0.1:4174/galaxia/';
const SOL = 'milky-way/sol';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, info = {}) => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(info).slice(0, 900)}`);
};
const until = async (p, fn, ms = 5000, arg = null) => {
  try {
    await p.waitForFunction(fn, arg, { timeout: ms, polling: 50 });
    return true;
  } catch {
    return false;
  }
};
const dbg = (p) => p.evaluate(() => { const d = window.__galaxia.debug(); return { music: d.music, sound: d.sound, state: d.state, mode: d.mode, title: d.title.visible, host: d.host }; });
const status = async (p) => (await dbg(p)).music.status;
const waitStatus = (p, s, ms = 6000) => until(p, (s) => window.__galaxia?.debug().music.status === s, ms, s);
const ui = (p) => p.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const r = q('.title-music-vol input');
  return {
    playHidden: q('.title-music-play')?.hidden ?? null,
    playVisible: (() => { const b = q('.title-music-play'); if (!b) return null; const cs = getComputedStyle(b); return cs.visibility === 'visible' && cs.display !== 'none'; })(),
    playBoxKept: (q('.title-music-play')?.getBoundingClientRect().height ?? 0) >= 44,
    playText: q('.title-music-play')?.textContent ?? null,
    hasMute: !!q('.title-music-mute'), // post-release: MUTE MUSIC lives in Settings only; the home page has none
    value: r?.value ?? null,
    label: r?.getAttribute('aria-label') ?? null,
    valuetext: r?.getAttribute('aria-valuetext') ?? null,
    out: q('.title-music-vol output')?.textContent ?? null,
    line: q('.title-music-status')?.textContent ?? null,
    focus: document.activeElement?.className || (document.activeElement?.getAttribute('aria-label') ?? null),
  };
});
const prefs = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('galaxia:prefs') ?? 'null')?.audio ?? null);
// Post-release: MUTE MUSIC lives in Settings (Classic SETTINGS / Free Roam SOUND), not on the home page.
// From the home page: enter Classic, open SETTINGS, set aria-pressed to `on`, come back. Every click is a gesture.
const setMuted = async (p, on) => {
  await p.click('.mode-card-classic');
  await p.waitForSelector('.screen-title [data-action=settings]', { state: 'visible', timeout: 10000 });
  await p.click('.screen-title [data-action=settings]');
  await p.waitForSelector('.screen-settings [data-action=back]', { state: 'visible' });
  const cur = await p.evaluate(() => document.querySelector('.screen-settings .screen-toggle[aria-label="MUTE MUSIC"]')?.getAttribute('aria-pressed') === 'true');
  if (cur !== on) await p.click('.screen-settings .screen-toggle[aria-label="MUTE MUSIC"]');
  await sleep(200);
  await p.click('.screen-settings [data-action=back]');
  await p.evaluate(() => window.__galaxia.menu());
};
function guideSkipped() {
  try {
    if (!localStorage.getItem('galaxia:guide')) localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
  } catch { /* storage blocked */ }
}
function watch(p, errs, warns, reqs) {
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
    if (m.type() === 'warning' && /AudioContext|autoplay/i.test(m.text())) warns.push(m.text());
  });
  p.on('request', (r) => reqs.push(r.url()));
}
const themeRequests = (reqs) => reqs.filter((u) => /galaxiaTheme-[^/]*\.js/.test(u)).length;
async function home(p, url = PAGE) {
  // Finale P3: the home page plays its opening cinematic on first sight; the theme waits for its handoff.
  // This harness tests the music on the settled home page, so it bypasses the intro (?intro=skip).
  const u = url === PAGE ? `${PAGE}?intro=skip` : url;
  await p.goto(u, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__galaxia?.debug().title.visible === true, null, { timeout: 15000 });
}
async function settle(p, ms = 400) {
  await sleep(ms);
}

const browser = await chromium.launch();
const allErrs = [];
const allWarns = [];
try {
  /* ================= A: desktop, the browser's own autoplay rule ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(guideSkipped);
    const p = await ctx.newPage();
    const errs = [], warns = [], reqs = [];
    watch(p, errs, warns, reqs);
    await home(p);
    await waitStatus(p, 'locked');
    let d = await dbg(p);
    let u = await ui(p);
    check('A1: fresh home page: LOCKED by the autoplay rule, no AudioContext before a gesture, the chunk prefetched (one request)',
      d.music.status === 'locked' && d.music.context === 'none' && d.sound.unlocked === false && d.music.loaded && themeRequests(reqs) === 1, { d: d.music, sound: d.sound, n: themeRequests(reqs) });
    const names = await p.evaluate(() => ({
      play: document.querySelector('.title-music-play')?.textContent,
      group: document.querySelector('.title-music')?.getAttribute('aria-label'),
      role: document.querySelector('.title-music-status')?.getAttribute('role'),
    }));
    check('A1: accessible controls: PLAY MUSIC shown, no MUTE MUSIC on the home page (it lives in Settings), "Music volume" slider 70 with its value shown, a status line',
      !u.playHidden && /PLAY MUSIC/.test(u.playText) && u.hasMute === false && u.label === 'Music volume' && u.value === '70' && u.out === '70%' && u.valuetext === '70 percent' && names.group === 'Music' && names.role === 'status' && /PLAY MUSIC/.test(u.line),
      { u, names });

    const volBox0 = await p.locator('.title-music-vol input').boundingBox();
    await p.click('.title-music-play');
    const playing = await waitStatus(p, 'playing');
    await sleep(400);
    d = await dbg(p);
    u = await ui(p);
    const volBox1 = await p.locator('.title-music-vol input').boundingBox();
    check('A2: starting the music moves nothing: PLAY MUSIC turns invisible but keeps its box, the volume slider stays where it was',
      u.playVisible === false && u.playBoxKept && Math.abs(volBox1.x - volBox0.x) < 0.5 && Math.abs(volBox1.y - volBox0.y) < 0.5, { u, volBox0, volBox1 });
    check('A2: PLAY MUSIC (a real click) starts the theme: PLAYING, context running, one run scheduling, PLAY hidden, focus moved to the volume slider',
      playing && d.music.context === 'running' && d.music.player?.playing && d.music.player.runs === 1 && d.music.player.timers === 1 && d.music.player.voices > 0 && u.playHidden === true && u.focus === 'Music volume' && /BEYOND THE BEACON/.test(u.line),
      { m: d.music, u });
    check('A2: the music bus sits at the saved music volume (70 %)', Math.abs((d.music.bus ?? -1) - 0.7) < 0.02, { bus: d.music.bus });
    const b0 = d.music.player.beat;
    await sleep(2500);
    d = await dbg(p);
    check('A3: the scheduler advances in steady tempo (84 BPM: about 3.5 beats in 2.5 s), one timer, bounded voices',
      d.music.player.beat - b0 > 2.8 && d.music.player.beat - b0 < 4.2 && d.music.player.timers === 1 && d.music.player.voices < 120 && d.music.player.starts === 1,
      { b0, p: d.music.player });

    // slider: keyboard
    await p.focus('.title-music-vol input');
    await p.keyboard.press('ArrowLeft');
    await p.keyboard.press('ArrowLeft');
    await sleep(350);
    d = await dbg(p);
    u = await ui(p);
    let a = await prefs(p);
    check('A4: keyboard: two steps down -> 60 %, shown and saved; the bus eases to it live; no restart, no new graph',
      u.value === '60' && u.out === '60%' && a?.music === 0.6 && Math.abs(d.music.bus - 0.6) < 0.02 && d.music.player.starts === 1 && d.music.status === 'playing',
      { u, a, m: d.music });
    const mode0 = (await dbg(p)).mode;
    check('A4: arrow keys on the slider stay with the slider (the title menu did not move, nothing launched)', mode0 === null && (await dbg(p)).title, { mode0 });
    // slider: pointer drag to 0, then click in the middle
    const box = await p.locator('.title-music-vol input').boundingBox();
    await p.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 4 });
    await p.mouse.move(box.x - 20, box.y + box.height / 2, { steps: 4 });
    await p.mouse.up();
    await sleep(400);
    d = await dbg(p);
    u = await ui(p);
    a = await prefs(p);
    check('A4: pointer drag to the left end: 0 %, saved; a volume of 0 is SILENT (the theme stops), Mute Music untouched',
      u.value === '0' && a?.music === 0 && a.musicMuted === false && d.music.status === 'silent' && !d.music.player.playing, { u, a, m: d.music });
    await p.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    await waitStatus(p, 'playing');
    await sleep(300);
    d = await dbg(p);
    a = await prefs(p);
    check('A4: a click mid-slider raises it (about 50 %), saved once on release; the theme starts again from the top',
      a?.music >= 0.4 && a.music <= 0.6 && d.music.status === 'playing' && d.music.player.starts === 2 && d.music.player.beat < 2, { a, m: d.music });

    // MUTE MUSIC (in Classic SETTINGS — gone from the home page): music bus only
    const played0 = (await dbg(p)).sound.played;
    await setMuted(p, true);
    await waitStatus(p, 'muted');
    await sleep(400);
    d = await dbg(p);
    u = await ui(p);
    a = await prefs(p);
    check('A5: MUTE MUSIC: saved, MUTED on the home status line (no home button, never unmuted by navigating); the theme stops; the music bus goes to 0; the volume is kept',
      u.hasMute === false && /MUSIC MUTED/.test(u.line) && a?.musicMuted === true && d.music.status === 'muted' && !d.music.player.playing && Math.abs(d.music.bus) < 0.01 && d.sound.musicGain === 0 && a.music >= 0.4,
      { u, a, m: d.music, s: d.sound });
    await p.focus('.mode-card-classic');
    await p.keyboard.press('ArrowRight');
    await sleep(150);
    d = await dbg(p);
    check('A5: effects are untouched: effects gain unchanged and a menu sound still plays while music is muted',
      Math.abs(d.sound.sfxGain - 0.8) < 1e-9 && d.sound.played > played0 && d.mode === null, { s: d.sound, played0 });
    await p.focus('.title-music-vol input');
    await p.keyboard.press('ArrowRight');
    await sleep(300);
    const vMuted = await prefs(p);
    d = await dbg(p);
    check('A5: volume changed while muted is saved and stays silent', vMuted.musicMuted === true && vMuted.music > a.music && d.music.status === 'muted' && Math.abs(d.music.bus) < 0.01, { vMuted, a, bus: d.music.bus });

    // reload: both persist; muted means no download
    const n0 = themeRequests(reqs);
    await home(p);
    await sleep(500);
    d = await dbg(p);
    u = await ui(p);
    a = await prefs(p);
    check('A6: after a reload: still muted (never unmuted by a reload), the volume kept and shown, and no music chunk downloaded',
      u.hasMute === false && d.music.status === 'muted' && /MUSIC MUTED/.test(u.line) && u.value === String(Math.round(vMuted.music * 100)) && a.musicMuted === true && themeRequests(reqs) === n0 && d.music.loads === 0,
      { u, m: d.music, a, n0, n: themeRequests(reqs) });

    await setMuted(p, false); // the Settings clicks are also the gesture
    const unmuted = await waitStatus(p, 'playing');
    await sleep(350);
    d = await dbg(p);
    a = await prefs(p);
    check('A7: unmute from SETTINGS (its clicks are gestures): loads the chunk, plays on return home, and the bus returns to the kept volume',
      unmuted && a.musicMuted === false && Math.abs(d.music.bus - a.music) < 0.02 && themeRequests(reqs) === n0 + 1, { m: d.music, a });

    // gameplay stops it; home restarts from the top
    const startsHome = (await dbg(p)).music.player.starts;
    const t0 = Date.now();
    await p.click('.mode-card-classic');
    d = await dbg(p);
    const statusAtClick = d.music.status;
    await p.waitForFunction(() => window.__galaxia.debug().state === 'active' && window.__galaxia.debug().mode === 'classic', null, { timeout: 10000 });
    const tStart = Date.now() - t0;
    await sleep(1000);
    d = await dbg(p);
    check('A8: choosing Classic stops the theme at once (fade-out), the mode starts without waiting; after the fade nothing runs',
      statusAtClick === 'idle' && tStart < 3000 && d.music.status === 'idle' && d.music.player.runs === 0 && d.music.player.voices === 0 && d.music.player.timers === 0, { statusAtClick, tStart, m: d.music });
    await p.evaluate(() => window.__galaxia.menu());
    await waitStatus(p, 'playing');
    d = await dbg(p);
    check('A8: back on the home page: the theme starts again from its opening (documented policy), the same player',
      d.music.status === 'playing' && d.music.player.beat < 1.5 && d.music.player.starts === startsHome + 1 && d.music.player.runs <= 2, { m: d.music, startsHome });
    const nFr = themeRequests(reqs);
    await p.click('.mode-card-freeroam');
    await p.waitForFunction(() => window.__galaxia.debug().mode === 'freeroam' && window.__galaxia.debug().state === 'active', null, { timeout: 20000 });
    await sleep(900);
    d = await dbg(p);
    check('A8: choosing Free Roam stops it too; Free Roam does not download the music chunk', d.music.status === 'idle' && d.music.player.runs === 0 && themeRequests(reqs) === nFr, { m: d.music });
    await p.evaluate(() => window.__galaxia.menu());
    await waitStatus(p, 'playing');

    // rapid navigation
    const L0 = (await dbg(p)).host.listeners;
    for (let i = 0; i < 8; i++) {
      await p.evaluate(() => window.__galaxia.launch('classic'));
      if (i % 2) await sleep(60);
      await p.evaluate(() => window.__galaxia.menu());
    }
    await waitStatus(p, 'playing');
    await sleep(150); // a fade cut short is silent after 30 ms and released 50 ms later
    d = await dbg(p);
    const runsNow = d.music.player.runs;
    await sleep(900);
    const d2 = await dbg(p);
    check('A9: 8 rapid home -> game -> home trips: playing once, at most one fading run beside it (older fades cut), nothing leaks',
      d.music.status === 'playing' && runsNow <= 2 && d2.music.player.runs === 1 && d2.music.player.timers === 1 && d2.host.listeners === L0 && d2.music.listeners === 1 && d2.music.player.voices < 120,
      { runsNow, m: d2.music, L0, L: d2.host.listeners });

    // hidden tab (simulated)
    const startsBefore = d2.music.player.starts;
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(300);
    d = await dbg(p);
    check('A10: a hidden tab (simulated visibilitychange): PAUSED, the scheduler held, the context suspended', d.music.status === 'paused' && d.music.player.held && d.music.context === 'suspended' && d.sound.paused, { m: d.music });
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await waitStatus(p, 'playing');
    await sleep(200);
    d = await dbg(p);
    check('A10: visible again: continues in place (no restart), the context running', d.music.status === 'playing' && !d.music.player.held && d.music.context === 'running' && d.music.player.starts === startsBefore && !d.sound.paused, { m: d.music });

    // Classic SETTINGS: MUSIC slider + MUTE MUSIC
    await p.click('.mode-card-classic');
    await p.waitForSelector('.screen-title [data-action=settings]', { state: 'visible', timeout: 10000 });
    await p.click('.screen-title [data-action=settings]');
    await p.waitForSelector('.screen-settings [data-action=back]', { state: 'visible' });
    const cs = await p.evaluate(() => ({
      music: !!document.querySelector('.screen-settings input[aria-label="MUSIC volume"]'),
      jingles: /JINGLES/.test(document.querySelector('.screen-settings')?.textContent ?? ''),
      mm: document.querySelector('.screen-settings .screen-toggle[aria-label="MUTE MUSIC"]')?.getAttribute('aria-pressed'),
      sound: document.querySelector('.screen-settings .screen-toggle[aria-label="SOUND"]')?.getAttribute('aria-pressed'),
    }));
    await p.click('.screen-settings .screen-toggle[aria-label="MUTE MUSIC"]');
    await sleep(200);
    const cs2 = await p.evaluate(() => ({ mm: document.querySelector('.screen-settings .screen-toggle[aria-label="MUTE MUSIC"]')?.getAttribute('aria-pressed'), text: document.querySelector('.screen-settings .screen-toggle[aria-label="MUTE MUSIC"]')?.textContent, sound: document.querySelector('.screen-settings .screen-toggle[aria-label="SOUND"]')?.getAttribute('aria-pressed') }));
    a = await prefs(p);
    d = await dbg(p);
    check('A11: Classic SETTINGS: a MUSIC volume slider (was JINGLES) and a MUTE MUSIC toggle; it saves, SOUND untouched, effects gain unchanged',
      cs.music && !cs.jingles && cs.mm === 'false' && cs2.mm === 'true' && cs2.text === 'ON' && cs2.sound === cs.sound && a.musicMuted === true && a.muted === false && d.sound.musicGain === 0 && d.sound.sfxGain > 0, { cs, cs2, a, s: d.sound });
    await p.click('.screen-settings [data-action=back]');
    await p.evaluate(() => window.__galaxia.menu());
    await waitStatus(p, 'muted');
    u = await ui(p);
    check('A11: the home page reflects the same saved setting: MUSIC MUTED on the status line (and still no home mute button)', /MUSIC MUTED/.test(u.line) && u.hasMute === false, u);
    await setMuted(p, false);
    await waitStatus(p, 'playing');

    // offline render: levels, silence after stop, the loop seam
    const pr = (s) => p.evaluate((s) => window.__galaxiaMusicProbe(s), s);
    const secs = [];
    for (const [n, from, to] of [['A', 0, 32], ['B', 32, 64], ['C', 64, 96], ['D', 96, 128]]) {
      const r = await pr({ kind: 'span', from, to, sampleRate: 44100 });
      secs.push({ n, peak: +r.peak.toFixed(3), rmsDb: +(20 * Math.log10(r.rms)).toFixed(1), nonFinite: r.nonFinite });
    }
    console.log('  offline sections', JSON.stringify(secs));
    check('A12: offline render (44.1 kHz): every section peaks under 0.55 (the limiter starts at 0.71) and sits between -30 and -18 dBFS RMS; no NaN',
      secs.every((s) => s.peak < 0.55 && s.peak > 0.1 && s.rmsDb > -30 && s.rmsDb < -18 && s.nonFinite === 0), secs);
    const seam = await pr({ kind: 'span', from: 120, to: 136, sampleRate: 22050, window: 0.25 });
    const spb = 60 / 84;
    const si = Math.round((8 * spb) / 0.25);
    const around = seam.windows.slice(si - 3, si + 3);
    const sorted = [...seam.windows.slice(0, Math.floor((16 * spb) / 0.25))].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    check('A12: the loop seam (bar 32 -> bar 1) has no gap and no jump: the windows around it stay within 0.2x-3x of the span median',
      around.every((w) => w > 0.2 * median && w < 3 * median), { around: around.map((w) => +w.toFixed(4)), median });
    const live = await pr({ kind: 'live', seconds: 9, stopAt: 4, restartAt: 6.5, sampleRate: 22050, window: 0.25 });
    const w = live.windows;
    const at = (t) => w[Math.floor(t / 0.25)];
    const silent = w.slice(Math.ceil(4.8 / 0.25), Math.floor(6.5 / 0.25));
    check('A12: live scheduler render: fades in from silence, falls fully silent after stop() (< -80 dBFS within 0.8 s), restart sounds again; one run left, no leaked timers',
      at(0.05) < at(2.5) && silent.every((x) => x < 1e-4) && at(8.5) > 1e-3 && live.endRuns === 1 && live.endTimers <= 2 && live.maxVoices < 120 && live.nonFinite === 0,
      { first: at(0.05), mid: at(2.5), silentMax: Math.max(...silent), after: at(8.5), runs: live.endRuns, timers: live.endTimers, maxVoices: live.maxVoices });

    check('A: no page errors and no AudioContext console warnings', errs.length === 0 && warns.length === 0, { errs, warns });
    allErrs.push(...errs);
    allWarns.push(...warns);
    await ctx.close();
  }

  /* ================= B: autoplay refused (simulated) ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(guideSkipped);
    await ctx.addInitScript(() => {
      const Orig = window.AudioContext;
      window.__resumeCalls = 0;
      window.__allowAudio = false;
      window.AudioContext = class extends Orig {
        constructor(...a) {
          super(...a);
          if (!window.__allowAudio) void super.suspend();
        }
        resume() {
          window.__resumeCalls += 1;
          return window.__allowAudio ? super.resume() : Promise.reject(new DOMException('refused by the harness', 'NotAllowedError'));
        }
      };
    });
    const p = await ctx.newPage();
    const errs = [], warns = [], reqs = [];
    watch(p, errs, warns, reqs);
    await home(p);
    await waitStatus(p, 'locked');
    await p.click('.title-music-play');
    const blocked = await waitStatus(p, 'blocked');
    await sleep(300);
    let d = await dbg(p);
    let u = await ui(p);
    check('B1: autoplay refused (every resume() rejected): BLOCKED, not muted; PLAY MUSIC stays offered with a plain explanation (and no home mute button appears as a fallback)',
      blocked && d.music.status === 'blocked' && d.music.context === 'suspended' && u.hasMute === false && (await prefs(p))?.musicMuted !== true && u.playHidden === false && /BROWSER/.test(u.line), { m: d.music, u });
    const c1 = await p.evaluate(() => window.__resumeCalls);
    await sleep(2000);
    const c2 = await p.evaluate(() => window.__resumeCalls);
    check('B1: no retry loop: no resume() calls without a new press (2 s idle)', c2 === c1, { c1, c2 });
    await p.click('.mode-card-classic');
    await p.waitForSelector('.screen-title [data-action=start]', { state: 'visible', timeout: 10000 });
    await p.click('.screen-title [data-action=start]');
    const started = await until(p, () => window.__galaxiaGame?.engine.phase === 'playing', 10000);
    check('B2: gameplay never needs music: Classic starts and plays with audio refused', started, {});
    await p.evaluate(() => window.__galaxia.menu());
    await waitStatus(p, 'blocked');
    await p.evaluate(() => { window.__allowAudio = true; });
    await p.click('.title-music-play');
    const ok = await waitStatus(p, 'playing', 6000);
    d = await dbg(p);
    check('B3: once the browser allows it, PLAY MUSIC starts the theme (context running)', ok && d.music.context === 'running' && d.music.player?.playing, { m: d.music });
    check('B: no page errors (the refusals are handled), no AudioContext warnings', errs.length === 0 && warns.length === 0, { errs, warns });
    allErrs.push(...errs);
    await ctx.close();
  }

  /* ================= C: deep links and a muted profile never download the theme ================= */
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(guideSkipped);
    const p = await ctx.newPage();
    const errs = [], warns = [], reqs = [];
    watch(p, errs, warns, reqs);
    await p.goto(`${PAGE}?mode=freeroam`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__galaxia?.debug().mode === 'freeroam' && window.__galaxia.debug().state === 'active', null, { timeout: 20000 });
    await sleep(800);
    let d = await dbg(p);
    check('C1: a Free Roam deep link never shows the home page and never requests the music chunk', themeRequests(reqs) === 0 && d.music.loads === 0 && d.music.status === 'idle', { n: themeRequests(reqs), m: d.music });
    await p.goto(`${PAGE}?mode=classic`, { waitUntil: 'load' });
    await p.waitForFunction(() => window.__galaxia?.debug().mode === 'classic', null, { timeout: 15000 });
    await sleep(500);
    check('C2: the same for a Classic deep link', themeRequests(reqs) === 0, { n: themeRequests(reqs) });
    await p.evaluate(() => localStorage.setItem('galaxia:prefs', JSON.stringify({ version: 1, audio: { muted: false, master: 0.8, sfx: 1, music: 0.7, musicMuted: true }, display: { glow: true, pixelPerfect: false, reducedMotion: 'system', arcadeDisplay: false } })));
    await home(p);
    await p.mouse.click(5, 5);
    await sleep(600);
    d = await dbg(p);
    check('C3: a muted profile on the home page (even after a gesture) downloads nothing', themeRequests(reqs) === 0 && d.music.status === 'muted', { n: themeRequests(reqs), m: d.music });
    check('C: no page errors', errs.length === 0, errs);
    allErrs.push(...errs);
    await ctx.close();
  }

  /* ================= D: phone, touch, reduced motion ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await ctx.addInitScript(guideSkipped);
    const p = await ctx.newPage();
    const errs = [], warns = [], reqs = [];
    watch(p, errs, warns, reqs);
    await home(p);
    await waitStatus(p, 'locked');
    const fit = await p.evaluate(() => {
      const g = document.querySelector('.title-music').getBoundingClientRect();
      const targets = [...document.querySelectorAll('.title-music button:not([hidden]), .title-music input')].map((e) => Math.round(e.getBoundingClientRect().height));
      const sc = document.querySelector('.title-screen');
      return { left: g.left, right: g.right, overflowX: document.documentElement.scrollWidth > window.innerWidth || sc.scrollWidth > sc.clientWidth, targets, anim: getComputedStyle(document.querySelector('.title-music')).animationName };
    });
    check('D1: 320x568: the music controls fit the width (no sideways scroll) and every target is at least 44 px tall',
      fit.left >= 0 && fit.right <= 320 && !fit.overflowX && fit.targets.every((h) => h >= 44), fit);
    await p.locator('.title-music-play').scrollIntoViewIfNeeded();
    const where = () => p.evaluate(() => ({ top: document.querySelector('.title-screen').scrollTop, guideY: Math.round(document.querySelector('.title-guide').getBoundingClientRect().y) }));
    const w0 = await where();
    await p.tap('.title-music-play');
    const ok = await waitStatus(p, 'playing');
    await sleep(400);
    const w1 = await where();
    const guideAfterTap = (await dbg(p)).music && (await p.evaluate(() => window.__galaxia.debug().guide.open));
    check('D2: a tap on PLAY MUSIC starts the theme (touch gesture) and only that: the page does not move and the tap does not open HOW TO PLAY',
      ok && !guideAfterTap && w1.top === w0.top && w1.guideY === w0.guideY && (await ui(p)).playVisible === false, { s: await status(p), w0, w1, guideAfterTap });
    await p.locator('.title-music-vol input').scrollIntoViewIfNeeded();
    const box = await p.locator('.title-music-vol input').boundingBox();
    await p.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height / 2);
    await sleep(300);
    const a = await prefs(p);
    const u = await ui(p);
    check('D3: a tap on the slider sets the volume (about 25 %) and saves it', a && a.music >= 0.15 && a.music <= 0.35 && u.out === `${u.value}%`, { a, u });
    check('D5: reduced motion: the music controls have no animation, and the theme still plays', fit.anim === 'none' && (await status(p)) === 'playing', { anim: fit.anim });
    await p.locator('.title-guide').scrollIntoViewIfNeeded();
    await p.tap('.title-guide');
    const open = await until(p, () => window.__galaxia.debug().guide.open === true, 8000);
    const inert = await p.evaluate(() => !!document.querySelector('.title-music')?.closest('[inert]'));
    await p.keyboard.press('Escape');
    await until(p, () => window.__galaxia.debug().guide.open === false, 5000);
    const inertAfter = await p.evaluate(() => !!document.querySelector('.title-music')?.closest('[inert]'));
    check('D4: while the guide is open the music controls are inert with the rest of the home page; afterwards active again', open && inert && !inertAfter, { open, inert, inertAfter });
    check('D: no page errors, no AudioContext warnings', errs.length === 0 && warns.length === 0, { errs, warns });
    allErrs.push(...errs);
    await ctx.close();
  }

  /* ================= K: keyboard on the home page ================= */
  {
    const kst = (p) => p.evaluate(() => { const d = window.__galaxia.debug(); const el = document.activeElement; return { mode: d.mode, guide: d.guide.open, music: d.music.status, muted: JSON.parse(localStorage.getItem('galaxia:prefs') ?? 'null')?.audio?.musicMuted ?? null, vol: document.querySelector('.title-music-vol input')?.value ?? null, focus: el?.className || (el?.getAttribute('aria-label') ?? null) }; });
    const fresh = async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(guideSkipped);
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(String(e)));
      await home(p);
      await sleep(250);
      return { ctx, p, errs };
    };
    let { ctx, p, errs } = await fresh();
    await p.focus('.title-music-play');
    await p.keyboard.press('Enter');
    await sleep(500);
    let k = await kst(p);
    check('K1: Enter on PLAY MUSIC starts the music and nothing else: not muted, no mode, focus on the volume slider (moved after the key — the next control now that MUTE MUSIC lives in Settings)',
      k.music === 'playing' && k.muted !== true && k.mode === null && k.focus === 'Music volume', k);
    await p.keyboard.press('ArrowLeft');
    await sleep(250);
    const k2 = await kst(p);
    await p.keyboard.press('ArrowRight');
    await sleep(250);
    const k3 = await kst(p);
    check('K2: the volume slider answers the arrow keys (down, then back up); the music keeps playing, nothing is muted, no mode starts',
      Number(k2.vol) < Number(k.vol) && Number(k3.vol) > Number(k2.vol) && k2.music === 'playing' && k3.music === 'playing' && k2.muted === false && k3.muted === false && k3.mode === null, { k, k2, k3 });
    const order = [];
    await p.focus('.mode-card-freeroam');
    for (let i = 0; i < 2; i++) {
      await p.keyboard.press('Tab');
      order.push(await p.evaluate(() => { const a = document.activeElement; const cs = getComputedStyle(a); return { c: a.className || a.getAttribute('aria-label'), ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 }; }));
    }
    check('K3: Tab order after the cards: HOW TO PLAY, then the volume slider (the hidden PLAY MUSIC is skipped, no home MUTE MUSIC anymore); each shows a 2 px focus ring',
      order.map((o) => o.c).join(',') === 'title-guide,Music volume' && order.every((o) => o.ring), order);
    await ctx.close();
    ({ ctx, p, errs } = await fresh());
    await p.focus('.title-music-play');
    await p.keyboard.press('Space');
    await sleep(500);
    k = await kst(p);
    check('K4: Space on PLAY MUSIC starts the music and nothing else (not muted, no mode)', k.music === 'playing' && k.muted !== true && k.mode === null, k);
    await ctx.close();
    for (const key of ['Enter', 'Space']) {
      ({ ctx, p, errs } = await fresh());
      await p.focus('.title-guide');
      await p.keyboard.press(key);
      await sleep(500);
      k = await kst(p);
      check(`K5: ${key} on HOW TO PLAY opens the guide and starts no mode (an inherited defect fixed in this stage)`, k.guide === true && k.mode === null, k);
      await ctx.close();
    }
    ({ ctx, p, errs } = await fresh());
    await p.mouse.click(10, 10);
    await p.keyboard.press('Enter');
    await sleep(600);
    k = await kst(p);
    check('K6: Enter with no button focused still starts the highlighted mode (Classic), as before', k.mode === 'classic', k);
    check('K: no page errors', errs.length === 0, errs);
    await ctx.close();
  }
} catch (e) {
  check('harness ran to the end (A-D, K)', false, { error: String(e?.stack ?? e).slice(0, 800) });
}
await browser.close();

/* ================= E: autoplay allowed by the browser ================= */
{
  const b2 = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const ctx = await b2.newContext();
    await ctx.addInitScript(guideSkipped);
    await ctx.addInitScript(() => { Object.defineProperty(navigator, 'getAutoplayPolicy', { configurable: true, value: (t) => (t === 'audiocontext' ? 'allowed' : 'disallowed') }); });
    const p = await ctx.newPage();
    const errs = [], warns = [], reqs = [];
    watch(p, errs, warns, reqs);
    await home(p);
    const ok = await waitStatus(p, 'playing', 8000);
    const d = await dbg(p);
    const u = await ui(p);
    check('E1: where the browser reports autoplay allowed, the theme plays as soon as the home page shows (no gesture); PLAY MUSIC not shown',
      ok && d.music.context === 'running' && d.music.gesture === false && u.playHidden === true, { m: d.music, u });
    check('E: no page errors', errs.length === 0, errs);
    allErrs.push(...errs);
  } catch (e) {
    check('harness ran to the end (E)', false, { error: String(e) });
  }
  await b2.close();
}

/* ================= F: Free Roam SOUND panel ================= */
{
  const b3 = await chromium.launch();
  try {
    const ctx = await b3.newContext({ viewport: { width: 1280, height: 800 } });
    const rec = {
      version: 10, createdAt: 1, sessions: 5, flightSeconds: 900, beaconsCharted: 1, surveysCompleted: 1, bestSurveyTicks: 5000,
      currentGalaxy: 'milky-way', visitedGalaxies: ['milky-way'], chartedSystems: [SOL], galaxySurveys: { 'milky-way': 1 },
      currentSystem: SOL, visitedSystems: [SOL], sectors: { [SOL]: { done: [], surveyed: true } },
      cargo: { scrap: 10, fuel: 20, alloy: 0, ice: 0 }, fleet: { active: 'petrel', owned: ['petrel'], loadouts: {} },
      lostCargo: null, modules: {}, milestones: [],
      progression: { marks: 100, missions: { active: [], completed: ['story-first-light'], claimed: ['story-first-light'], failed: [], ready: {}, jumps: 0 }, upgrades: {}, licences: [], log: {}, fuel: { starter: true, arrivals: 1, aidAt: -1 } },
      crew: { hired: [], paid: [], seats: {} }, savedAt: 1, resume: null,
    };
    await ctx.addInitScript((r) => {
      if (!sessionStorage.getItem('f2-seeded')) {
        sessionStorage.setItem('f2-seeded', '1');
        localStorage.setItem('galaxia:freeroam', JSON.stringify(r));
        localStorage.setItem('galaxia:guide', JSON.stringify({ version: 1, seen: 1, outcome: 'skipped' }));
      }
    }, rec);
    const p = await ctx.newPage();
    const errs = [], warns = [], reqs = [];
    watch(p, errs, warns, reqs);
    await home(p);
    await p.click('.title-music-play');
    await waitStatus(p, 'playing');
    await p.click('.mode-card-freeroam');
    await p.waitForFunction(() => window.__galaxiaFreeRoam?.screen() === 'map', null, { timeout: 20000 });
    await sleep(300);
    await p.locator('.fr-det-actions >> text=ENTER SECTOR').locator('visible=true').first().click();
    await p.waitForSelector('.fr-panel-briefing >> text=START FLIGHT');
    await p.click('.fr-panel-briefing >> text=START FLIGHT');
    await p.waitForFunction(() => window.__galaxiaFreeRoam.state?.phase === 'flight' && window.__galaxiaFreeRoam.panel() === null, null, { timeout: 15000 });
    let d = await dbg(p);
    const crit = await p.evaluate(() => window.__galaxiaFreeRoam.crit?.() ?? null);
    check('F1: in flight the home theme is gone (no run, no timer); flight and the critical-hit hook work as before',
      d.music.status === 'idle' && d.music.player.runs === 0 && d.music.player.timers === 0 && crit && crit.mode === 'auto', { m: d.music, crit });
    await sleep(400);
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'pause', null, { timeout: 8000 });
    // the pause menu groups its items (P11): open SETTINGS & HELP, then its SOUND item
    await p.click('.fr-panel-pause .fr-pause-head:has-text("SETTINGS & HELP")');
    await sleep(420);
    await p.click('.fr-panel-pause .fr-pause-item:text-is("SOUND")');
    await p.waitForFunction(() => window.__galaxiaFreeRoam.panel() === 'sound', null, { timeout: 8000 });
    const sel = '.fr-panel-sound button[data-key="musicMute"]';
    const s0 = await p.evaluate((s) => ({ t: document.querySelector(s)?.textContent, pr: document.querySelector(s)?.getAttribute('aria-pressed'), sound: document.querySelector('.fr-panel-sound button[data-key="mute"]')?.getAttribute('aria-pressed') }), sel);
    await p.click(sel);
    await sleep(150);
    const s1 = await p.evaluate((s) => ({ t: document.querySelector(s)?.textContent, pr: document.querySelector(s)?.getAttribute('aria-pressed'), sound: document.querySelector('.fr-panel-sound button[data-key="mute"]')?.getAttribute('aria-pressed') }), sel);
    let a = await prefs(p);
    d = await dbg(p);
    check('F2: Free Roam SOUND: MUTE MUSIC toggles (pressed state, text), saves to the shared prefs, leaves SOUND and the effects alone',
      s0.t === 'MUTE MUSIC: OFF' && s0.pr === 'false' && s1.t === 'MUTE MUSIC: ON' && s1.pr === 'true' && s1.sound === s0.sound && a.musicMuted === true && a.muted === false && d.sound.musicGain === 0 && d.sound.sfxGain > 0,
      { s0, s1, a, s: d.sound });
    await p.click(sel);
    await sleep(150);
    a = await prefs(p);
    check('F2: pressed again: unmuted and saved', a.musicMuted === false, a);
    check('F: no page errors', errs.length === 0, errs);
    allErrs.push(...errs);
  } catch (e) {
    check('harness ran to the end (F)', false, { error: String(e?.stack ?? e).slice(0, 800) });
  }
  await b3.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
