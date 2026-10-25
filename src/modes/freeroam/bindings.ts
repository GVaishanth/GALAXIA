/**
 * Free Roam key bindings (pure data and rules, no imports, so the profile in
 * the main bundle can sanitize them). Classic never imports this; its controls
 * are unchanged (left/right only, Stage 8). Pointer roles are in pointers.ts.
 *
 * Bindings (FR-TD-43): every flight action has two key slots. Rebinding a key
 * that another action uses moves it; if that would leave the other action
 * with no key, the two actions swap keys instead. An action can never end up
 * with no key ("release" clears only a second key). Escape is reserved: it
 * always pauses or goes back, so a player can never lock themselves out.
 * Menu navigation inside panels uses fixed keys (arrows, WASD, Enter, Space,
 * Escape), independent of the flight bindings.
 */

/**
 * `missile` is NEXT WEAPON since Combat P03C (it fired the lock-on missile in
 * P03). The id is kept so bindings saved by earlier versions stay valid.
 * `lock` (P04.1) toggles the ship target lock (X): the nose faces the locked
 * ship; it never moves, thrusts or fires. `target` (P04.1 polish) moves the
 * lock to the next eligible ship (C), only while a lock holds.
 */
export const FLIGHT_ACTIONS = ['up', 'down', 'left', 'right', 'fire', 'boost', 'missile', 'lock', 'target', 'stop', 'interact', 'map', 'cargo', 'pause'] as const;
export type FlightAction = (typeof FLIGHT_ACTIONS)[number];

/** Two key slots per action; slot 0 is always filled. */
export type KeySlots = readonly [string, string | null];
export type Bindings = Readonly<Record<FlightAction, KeySlots>>;

export const DEFAULT_BINDINGS: Bindings = Object.freeze({
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  fire: ['Space', 'KeyJ'],
  boost: ['ShiftLeft', 'ShiftRight'],
  missile: ['KeyQ', 'KeyK'],
  lock: ['KeyX', null],
  target: ['KeyC', null],
  stop: ['KeyB', null],
  interact: ['KeyE', 'Enter'],
  map: ['KeyM', null],
  cargo: ['KeyI', null],
  pause: ['KeyP', null],
});

export const ACTION_LABEL: Readonly<Record<FlightAction, string>> = Object.freeze({
  up: 'Move up',
  down: 'Move down',
  left: 'Move left',
  right: 'Move right',
  fire: 'Fire',
  boost: 'Boost',
  missile: 'Next weapon',
  lock: 'Lock target',
  target: 'Next target',
  stop: 'Stop / hold (Realistic)',
  interact: 'Interact',
  map: 'Sector map',
  cargo: 'Cargo',
  pause: 'Pause',
});

/** Always active, never rebindable: Escape = pause / back. */
export const RESERVED_KEYS = Object.freeze({ back: 'Escape' });

/** Fixed panel keys (menus work whatever the flight bindings are). */
export const PANEL_KEYS = Object.freeze({
  prev: ['ArrowUp', 'ArrowLeft', 'KeyW', 'KeyA'],
  next: ['ArrowDown', 'ArrowRight', 'KeyS', 'KeyD'],
  confirm: ['Enter', 'Space'],
  restart: ['KeyR'],
  /** Prompt 12: station tabs (also PageUp / PageDown). */
  tabPrev: ['BracketLeft', 'PageUp'],
  tabNext: ['BracketRight', 'PageDown'],
});

/** Fixed zoom keys (not rebindable). */
export const ZOOM_KEYS = Object.freeze({ in: ['Equal', 'NumpadAdd'], out: ['Minus', 'NumpadSubtract'] });

/** Keys a player may bind: letters, digits, arrows, Space, Enter, Shift and common punctuation. */
const BINDABLE = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Arrow(Up|Down|Left|Right)|Space|Enter|Shift(Left|Right)|Semicolon|Quote|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Backquote)$/;

export function isBindable(code: string): boolean {
  return BINDABLE.test(code);
}

export type RebindResult =
  | { readonly ok: true; readonly bindings: Bindings; readonly displaced: FlightAction | null }
  | { readonly ok: false; readonly reason: 'not-bindable' | 'last-key' };

const freeze = (b: Record<FlightAction, KeySlots>): Bindings => Object.freeze({ ...b });
const normal = (s: readonly [string | null, string | null]): KeySlots | null => {
  const keys = [s[0], s[1]].filter((k): k is string => k !== null);
  if (keys.length === 0) return null;
  return [keys[0]!, keys[1] ?? null];
};

/** Which action and slot use `code`, if any. */
export function findBinding(b: Bindings, code: string): { action: FlightAction; slot: 0 | 1 } | null {
  for (const a of FLIGHT_ACTIONS) {
    if (b[a][0] === code) return { action: a, slot: 0 };
    if (b[a][1] === code) return { action: a, slot: 1 };
  }
  return null;
}

/** Bind `code` to `action` slot `slot`, moving or swapping a conflicting key (see module doc). */
export function rebind(b: Bindings, action: FlightAction, slot: 0 | 1, code: string): RebindResult {
  if (!isBindable(code)) return { ok: false, reason: 'not-bindable' };
  const next: Record<FlightAction, [string | null, string | null]> = {} as never;
  for (const a of FLIGHT_ACTIONS) next[a] = [b[a][0], b[a][1]];
  const old = next[action][slot];
  if (old === code) return { ok: true, bindings: b, displaced: null };
  const hit = findBinding(b, code);
  let displaced: FlightAction | null = null;
  if (hit && hit.action === action) {
    // same action, other slot: swap the two slots
    next[action][hit.slot] = old;
  } else if (hit) {
    next[hit.action][hit.slot] = null;
    if (normal(next[hit.action]) === null) {
      if (old === null) return { ok: false, reason: 'last-key' };
      next[hit.action][hit.slot] = old; // swap: the other action takes over the replaced key
    }
    displaced = hit.action;
  }
  next[action][slot] = code;
  const out = {} as Record<FlightAction, KeySlots>;
  for (const a of FLIGHT_ACTIONS) out[a] = normal(next[a])!;
  return { ok: true, bindings: freeze(out), displaced };
}

/** Release (unbind) one slot; refused when it is the action's only key. */
export function clearBinding(b: Bindings, action: FlightAction, slot: 0 | 1): RebindResult {
  const s: [string | null, string | null] = [b[action][0], b[action][1]];
  s[slot] = null;
  const n = normal(s);
  if (!n) return { ok: false, reason: 'last-key' };
  return { ok: true, bindings: freeze({ ...b, [action]: n }), displaced: null };
}

/** Actions added after bindings were first saved; a save without them gets free keys (not a repair). */
const ADDED_ACTIONS: readonly FlightAction[] = ['boost', 'missile', 'lock', 'target', 'stop'];
/**
 * Spare keys for an added action whose default keys a player already uses
 * (so an old save is never reset just because Q and K were taken). They avoid
 * the panel, zoom and gravity-lab hotkeys.
 */
const ADDED_FALLBACK: readonly string[] = ['KeyF', 'KeyX', 'KeyC', 'KeyZ', 'KeyB', 'KeyN', 'KeyH', 'KeyL', 'KeyU', 'KeyO', 'KeyY', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash'];

/** Accept a stored bindings object; anything malformed falls back to defaults (reported as repaired). */
export function sanitizeBindings(raw: unknown): { bindings: Bindings; repaired: boolean } {
  if (raw === undefined) return { bindings: DEFAULT_BINDINGS, repaired: false };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { bindings: DEFAULT_BINDINGS, repaired: true };
  const doc = raw as Record<string, unknown>;
  const used = new Set<string>();
  const out = {} as Record<FlightAction, KeySlots>;
  let repaired = false;
  // actions missing from an older save are filled last, from keys no saved action uses
  const added = FLIGHT_ACTIONS.filter((a) => doc[a] === undefined && (ADDED_ACTIONS as readonly string[]).includes(a));
  for (const a of FLIGHT_ACTIONS) {
    if (added.includes(a)) continue;
    const v = doc[a];
    const keys: string[] = [];
    if (Array.isArray(v)) {
      for (const k of v.slice(0, 2)) {
        if (typeof k === 'string' && isBindable(k) && !used.has(k) && !keys.includes(k)) keys.push(k);
        else if (k !== null) repaired = true;
      }
      if (v.length > 2) repaired = true;
    } else repaired = true;
    if (keys.length === 0) return { bindings: DEFAULT_BINDINGS, repaired: true };
    for (const k of keys) used.add(k);
    out[a] = [keys[0]!, keys[1] ?? null];
  }
  for (const a of added) {
    // an action added after the save was written (boost, Prompt 8; missile, Combat P03; lock, P04.1; target, P04.1 polish; stop, P04.3): its default keys if free, else a spare key
    const keys: string[] = [];
    for (const k of DEFAULT_BINDINGS[a]) if (k !== null && !used.has(k)) keys.push(k);
    if (keys.length === 0) {
      const spare = ADDED_FALLBACK.find((k) => !used.has(k));
      if (!spare) return { bindings: DEFAULT_BINDINGS, repaired: true };
      keys.push(spare);
    }
    for (const k of keys) used.add(k);
    out[a] = [keys[0]!, keys[1] ?? null];
  }
  for (const k of Object.keys(doc)) if (!(FLIGHT_ACTIONS as readonly string[]).includes(k)) repaired = true;
  return { bindings: freeze(out), repaired };
}

/** Short on-screen name of a key code ("KeyW" -> "W", "ArrowUp" -> "↑"). */
export function keyLabel(code: string | null): string {
  if (code === null) return '—';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `NUM ${code.slice(6)}`;
  const named: Record<string, string> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'SPACE', Enter: 'ENTER', Escape: 'ESC',
    ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backslash: '\\', BracketLeft: '[', BracketRight: ']', Backquote: '`',
  };
  return named[code] ?? code.toUpperCase();
}

/** "W / ↑" for an action. */
export function actionKeys(b: Bindings, a: FlightAction): string {
  return b[a][1] ? `${keyLabel(b[a][0])} / ${keyLabel(b[a][1])}` : keyLabel(b[a][0]);
}

/** Every key code Free Roam must track for these bindings (flight + panels + zoom + Escape). */
export function trackedCodes(b: Bindings): string[] {
  const set = new Set<string>([RESERVED_KEYS.back, ...PANEL_KEYS.prev, ...PANEL_KEYS.next, ...PANEL_KEYS.confirm, ...PANEL_KEYS.restart, ...PANEL_KEYS.tabPrev, ...PANEL_KEYS.tabNext, ...ZOOM_KEYS.in, ...ZOOM_KEYS.out]);
  for (const a of FLIGHT_ACTIONS) for (const k of b[a]) if (k) set.add(k);
  return [...set];
}

