/**
 * Hidden admin login screen (P04 refinement): a full-screen corrupted-system
 * login that leads into the Admin Access session.
 *
 * Opened only by the hidden activation (activation.ts, wired in
 * freeRoamMode.ts). The operator name is a presentation effect
 * (login.ts createGlitch); the password field is the gate (exactly one ASCII
 * space, login.ts isAdminPassword, validated as received). A correct Enter
 * runs the identity reveal: the frozen name lifts out of its field, is
 * pulled to the centre while compressing, resolves into the owner identity
 * with WELCOME, MASTER above it, then the overlay fades onto the destination
 * the shell has set up underneath (deps.arrive, called once while the
 * overlay is opaque).
 *
 * No timers, animation frames or global listeners: the Free Roam frame loop
 * calls frame(now) while the screen exists, so leaving it (destroy) stops
 * everything. The password is never logged or stored; the field is cleared
 * on every submit.
 */
import { el } from '../progression/ui/common.ts';
import { OWNER_IDENTITY, REVEAL_TIMING, WELCOME_LINE, createGlitch, isAdminPassword, renderSlots, revealOrder, revealSlots, revealTimeline, seededRng, type Slot } from './login.ts';

export interface AdminLoginDeps {
  readonly seed: number;
  /** Fixed for one reveal when it starts (the app setting or the system preference). */
  readonly reducedMotion: () => boolean;
  readonly sound: (cue: 'deny' | 'accept') => void;
  /** Called once, under the opaque overlay: start the admin session and arrive at the destination. Returns '' or an error to show. */
  readonly arrive: () => string;
  /** The reveal has finished: remove the screen (the error from `arrive`, '' when it went well). */
  readonly done: (error: string) => void;
  /** ESC / ABORT before a correct password: leave without any change. */
  readonly abort: () => void;
}

export type AdminLoginPhase = 'login' | 'reveal' | 'done';

export interface AdminLoginStatus {
  readonly phase: AdminLoginPhase;
  readonly attempts: number;
  readonly rejected: number;
  /** Reveals started (never more than one). */
  readonly transitions: number;
  /** Operator-name text changes so far. */
  readonly changes: number;
  readonly user: string;
  readonly mode: string;
  readonly elapsed: number;
  readonly identity: string;
  readonly welcome: number;
  readonly reduced: boolean;
  readonly arrived: boolean;
}

export interface AdminLogin {
  readonly root: HTMLElement;
  /** Show the screen and focus the password field. */
  open(now: number): void;
  /** Called by the shell every frame while the screen exists. */
  frame(now: number): void;
  /** ESC or a gamepad back press: abort before a correct password; ignored during the reveal. */
  back(): void;
  status(): AdminLoginStatus;
  /** Remove the screen (and with it every listener). */
  destroy(): void;
}


export function createAdminLogin(d: AdminLoginDeps): AdminLogin {
  const root = el('section', 'adm-login');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'adm-login-title');

  const fx = el('div', 'adm-fx');
  fx.setAttribute('aria-hidden', 'true');
  fx.append(el('div', 'adm-scan'), el('div', 'adm-band'), el('div', 'adm-vignette'));

  const form = el('form', 'adm-card');
  form.noValidate = true;
  form.setAttribute('autocomplete', 'off');
  const kicker = el('p', 'adm-kicker', 'RESTRICTED NODE \u00b7 CORE ACCESS');
  const title = el('h2', 'adm-title', 'OPERATOR AUTHENTICATION');
  title.id = 'adm-login-title';

  const userField = el('div', 'adm-field');
  const userLabel = el('span', 'adm-label', 'OPERATOR');
  const user = el('div', 'adm-user');
  user.setAttribute('role', 'img');
  user.setAttribute('aria-label', 'Operator identity: unresolved');
  const userText = el('span', 'adm-user-text adm-mono');
  userText.setAttribute('aria-hidden', 'true');
  user.append(userText);
  userField.append(userLabel, user);

  const passField = el('label', 'adm-field adm-pass-field');
  const passLabel = el('span', 'adm-label', 'PASSKEY');
  const input = el('input', 'adm-pass');
  input.type = 'password';
  input.name = 'adm-passkey';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('enterkeyhint', 'go');
  input.setAttribute('aria-describedby', 'adm-login-msg');
  // password managers: nothing to fill or save here
  input.setAttribute('data-lpignore', 'true');
  input.setAttribute('data-1p-ignore', '');
  input.setAttribute('data-bwignore', '');
  passField.append(passLabel, input);

  const msg = el('p', 'adm-msg');
  msg.id = 'adm-login-msg';
  msg.setAttribute('role', 'status');
  msg.setAttribute('aria-live', 'polite');
  const foot = el('div', 'adm-foot');
  const hint = el('p', 'adm-hint', 'ENTER \u00b7 AUTHENTICATE');
  const abortBtn = el('button', 'adm-abort', 'ESC \u00b7 ABORT');
  abortBtn.type = 'button';
  foot.append(hint, abortBtn);
  form.append(kicker, title, userField, passField, msg, foot);

  // the reveal: the central identity (real text) and the welcome line above it
  const reveal = el('div', 'adm-reveal');
  const welcome = el('p', 'adm-welcome', WELCOME_LINE);
  const name = el('p', 'adm-name');
  name.setAttribute('aria-hidden', 'true');
  const nameText = el('span', 'adm-name-text');
  name.append(nameText);
  const announce = el('p', 'adm-sr');
  announce.setAttribute('aria-live', 'assertive');
  reveal.append(welcome, name, announce);
  reveal.hidden = true;

  const stage = el('div', 'adm-stage');
  stage.append(form);
  root.append(fx, stage, reveal);

  /* ---------------------------------------------------------------- state */
  const glitch = createGlitch(d.seed);
  const rng = seededRng(d.seed ^ 0x5bd1e995);
  let phase: AdminLoginPhase = 'login';
  let attempts = 0;
  let rejected = 0;
  let transitions = 0;
  let t0 = 0;
  let last = 0;
  let reduced = false;
  let arrived = false;
  let error = '';
  let shakeUntil = 0;
  let msgUntil = 0;
  let frozen: Slot[] = [];
  let order: number[] = [];
  let start: { cx: number; cy: number; left: number; top: number; width: number; height: number; font: string } | null = null;
  let flyer: HTMLElement | null = null;
  let flyerNext = 0;
  let nameNext = 0;
  let resolved = false;
  let welcomeShown = 0;

  const paint = (): void => {
    userText.textContent = glitch.text;
    user.style.setProperty('--gi', glitch.intensity.toFixed(2));
    user.dataset['mode'] = glitch.mode;
  };
  paint();

  /** Root-local coordinates of a viewport rect (an ancestor may be scaled). */
  const local = (r: DOMRect): { x: number; y: number; k: number } => {
    const rr = root.getBoundingClientRect();
    const k = root.offsetWidth > 0 ? rr.width / root.offsetWidth : 1;
    return { x: (r.left - rr.left) / k, y: (r.top - rr.top) / k, k };
  };

  const reject = (now: number): void => {
    rejected += 1;
    input.value = '';
    glitch.burst(now);
    form.classList.remove('is-denied');
    void form.offsetWidth; // restart the CSS shake
    form.classList.add('is-denied');
    shakeUntil = now + 450;
    msg.textContent = 'ACCESS DENIED \u00b7 IDENTITY NOT CONFIRMED';
    msgUntil = now + 2600;
    d.sound('deny');
    input.focus({ preventScroll: true });
  };

  const beginReveal = (now: number): void => {
    phase = 'reveal';
    transitions += 1;
    t0 = now;
    reduced = d.reducedMotion();
    root.classList.toggle('is-reduced', reduced);
    root.dataset['phase'] = 'reveal';
    input.value = ''; // the accepted value is not kept anywhere
    input.disabled = true;
    abortBtn.disabled = true;
    input.blur();
    frozen = [...glitch.slots];
    order = revealOrder(d.seed);
    const r = userText.getBoundingClientRect();
    const p = local(r);
    start = { cx: p.x + r.width / p.k / 2, cy: p.y + r.height / p.k / 2, left: p.x, top: p.y, width: r.width / p.k, height: r.height / p.k, font: getComputedStyle(userText).fontSize };
    msg.textContent = 'IDENTITY CONFIRMED';
    reveal.hidden = false;
    nameText.textContent = renderSlots(frozen);
  };

  const onSubmit = (e: Event): void => {
    e.preventDefault(); // never a page submission
    if (phase !== 'login') return; // a second Enter during the reveal does nothing
    attempts += 1;
    const now = last || performance.now();
    if (isAdminPassword(input.value)) beginReveal(now);
    else reject(now);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && phase === 'login') {
      e.preventDefault();
      e.stopPropagation();
      d.abort();
    }
  };
  const onAbort = (): void => {
    if (phase === 'login') d.abort();
  };
  form.addEventListener('submit', onSubmit);
  root.addEventListener('keydown', onKey);
  abortBtn.addEventListener('click', onAbort);
  // keep focus inside the screen (the rest of Free Roam is inert underneath)
  const onPointer = (e: PointerEvent): void => {
    if (phase === 'login' && e.target === root) input.focus({ preventScroll: true });
  };
  root.addEventListener('pointerdown', onPointer);

  /* ---------------------------------------------------------------- frames */
  const frameLogin = (now: number): void => {
    if (glitch.step(now)) paint();
    if (shakeUntil && now >= shakeUntil) {
      form.classList.remove('is-denied');
      shakeUntil = 0;
    }
    if (msgUntil && now >= msgUntil) {
      msg.textContent = '';
      msgUntil = 0;
    }
  };

  const corrupt = (slots: readonly Slot[], p: number): Slot[] =>
    slots.map((s) => (rng() < 0.15 + 0.55 * p ? { ch: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-.#'[Math.floor(rng() * 41)]!, mark: rng() < 0.5 ? '\u0337\u0338\u0335\u0334\u0336\u035F\u035E'[Math.floor(rng() * 7)]! : '' } : s));

  const frameReveal = (now: number): void => {
    const ms = now - t0;
    const f = revealTimeline(ms, reduced);
    form.style.opacity = f.card.toFixed(3);
    // A: the identity is locked: the frozen name shivers in its field
    if (f.lockShake > 0 && !reduced) userText.style.transform = `translate(${((rng() - 0.5) * 3 * f.lockShake).toFixed(2)}px, ${((rng() - 0.5) * 1.5 * f.lockShake).toFixed(2)}px)`;
    // B: it lifts out and is pulled toward the centre, compressing
    if (!flyer && start && ms >= (reduced ? 0 : REVEAL_TIMING.full.moveStart)) {
      flyer = el('div', 'adm-flyer adm-mono');
      flyer.setAttribute('aria-hidden', 'true');
      flyer.textContent = renderSlots(frozen);
      Object.assign(flyer.style, { left: `${start.left}px`, top: `${start.top}px`, width: `${start.width}px`, height: `${start.height}px`, lineHeight: `${start.height}px`, fontSize: start.font });
      root.append(flyer);
      userText.style.visibility = 'hidden';
    }
    if (flyer && start) {
      const nr = nameText.getBoundingClientRect();
      const q = local(nr);
      const tx = q.x + nr.width / q.k / 2 - start.cx;
      const ty = q.y + nr.height / q.k / 2 - start.cy;
      const fl = f.flyer;
      flyer.style.transform = `translate(${(tx * fl.p).toFixed(1)}px, ${(ty * fl.p).toFixed(1)}px) scale(${fl.scale.toFixed(3)})`;
      flyer.style.opacity = fl.opacity.toFixed(3);
      flyer.style.filter = fl.blur > 0.05 ? `blur(${fl.blur.toFixed(2)}px)` : '';
      flyer.style.letterSpacing = `${fl.spacing.toFixed(3)}em`;
      if (now >= flyerNext && fl.opacity > 0) {
        flyer.textContent = renderSlots(corrupt(frozen, fl.p));
        flyerNext = now + 50;
      }
      if (fl.opacity <= 0 && ms > 0) flyer.hidden = true;
    }
    // C: the central identity resolves glyph by glyph
    name.style.opacity = f.name.opacity.toFixed(3);
    name.style.transform = `scale(${f.name.scale.toFixed(3)})`;
    name.style.filter = f.name.blur > 0.05 ? `blur(${f.name.blur.toFixed(2)}px)` : '';
    name.style.letterSpacing = `${f.name.spacing.toFixed(3)}em`;
    root.style.setProperty('--rv', f.name.opacity.toFixed(3));
    if (!resolved) {
      if (f.name.resolve >= 1) {
        resolved = true;
        nameText.textContent = OWNER_IDENTITY;
        name.dataset['resolved'] = 'true';
        user.setAttribute('aria-label', `Operator identity: ${OWNER_IDENTITY}`);
        announce.textContent = `${WELCOME_LINE}. ${OWNER_IDENTITY}.`;
        d.sound('accept');
      } else if (now >= nameNext && f.name.opacity > 0) {
        nameText.textContent = renderSlots(revealSlots(frozen, OWNER_IDENTITY, f.name.resolve, order, rng));
        nameNext = now + 55;
      }
    }
    // D: WELCOME, MASTER above it
    welcome.style.opacity = f.welcome.opacity.toFixed(3);
    welcome.style.transform = `translateY(${f.welcome.dy.toFixed(1)}px)`;
    welcome.style.letterSpacing = `${f.welcome.spacing.toFixed(3)}em`;
    welcomeShown = f.welcome.opacity;
    // E: the destination is set up underneath while the overlay is opaque, then the overlay fades onto it
    if (f.arrive && !arrived) {
      arrived = true;
      try {
        error = d.arrive();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    root.style.opacity = f.overlay.toFixed(3);
    if (f.done) {
      phase = 'done';
      root.dataset['phase'] = 'done';
      d.done(error);
    }
  };

  return {
    root,
    open(now) {
      last = now;
      root.dataset['phase'] = 'login';
      input.focus({ preventScroll: true });
    },
    frame(now) {
      last = now;
      if (phase === 'login') frameLogin(now);
      else if (phase === 'reveal') frameReveal(now);
    },
    back() {
      if (phase === 'login') d.abort();
    },
    status() {
      return {
        phase,
        attempts,
        rejected,
        transitions,
        changes: glitch.changes,
        user: glitch.text,
        mode: glitch.mode,
        elapsed: phase === 'reveal' ? last - t0 : 0,
        identity: nameText.textContent ?? '',
        welcome: welcomeShown,
        reduced,
        arrived,
      };
    },
    destroy() {
      form.removeEventListener('submit', onSubmit);
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('pointerdown', onPointer);
      abortBtn.removeEventListener('click', onAbort);
      root.remove();
    },
  };
}
