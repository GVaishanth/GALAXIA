/**
 * First-run tutorial and HOW TO PLAY guide: the content (pure, P04.2 guide).
 *
 * Every line describes what the game does today, read from the code that
 * does it:
 *  - Free Roam keys come from the player's saved bindings (bindings.ts), so a
 *    rebound key shows as rebound; Classic keys are fixed (input/keyboard.ts).
 *  - Gamepad and touch rows mirror input.ts / app.ts / touchControls.ts and the
 *    Free Roam touch buttons (FIRE, BOOST, WPN above FIRE, LOCK on the left,
 *    NEXT TARGET beside LOCK while locked).
 *  - Weapon fit comes from the armory rules (shipsFor) and the weapon
 *    catalogue; the Classic weapon switch follows the Wave 20 gate.
 *  - Guild marks: only the sources and uses that exist (FR-TD-91,
 *    docs/freeroam/ECONOMY.md). No prices are invented here.
 *
 * Nothing here mentions developer-only tools. tests/guide.test.ts checks the
 * rows against the bindings, the gate and the economy texts.
 */
import { PRIMARY_WEAPON, WEAPONS, type WeaponId } from '../../config/weapons.ts';
import { ACTION_LABEL, DEFAULT_BINDINGS, keyLabel, type Bindings, type FlightAction } from '../freeroam/bindings.ts';
import { shipsFor } from '../freeroam/ships/armory.ts';
import { SHIP_BY_ID } from '../freeroam/ships/roster.ts';

export type GuideMode = 'classic' | 'freeroam';
export type GuideInput = 'keyboard' | 'touch' | 'controller';
export const GUIDE_MODES: readonly GuideMode[] = ['classic', 'freeroam'];
export const GUIDE_INPUTS: readonly GuideInput[] = ['keyboard', 'touch', 'controller'];
export const MODE_LABEL: Readonly<Record<GuideMode, string>> = { classic: 'CLASSIC', freeroam: 'FREE ROAM' };
export const INPUT_LABEL: Readonly<Record<GuideInput, string>> = { keyboard: 'KEYBOARD', touch: 'TOUCH', controller: 'CONTROLLER' };

export const GUIDE_STEPS = ['welcome', 'ships', 'weapons', 'controls', 'marks', 'start'] as const;
export type GuideStepId = (typeof GUIDE_STEPS)[number];
/** Short names for the progress indicator. */
export const STEP_LABEL: Readonly<Record<GuideStepId, string>> = { welcome: 'Welcome', ships: 'Ships', weapons: 'Weapons', controls: 'Controls', marks: 'Guild marks', start: 'Start' };

/** The Guild marks glyph (the same as progression/ledger.ts MARKS.glyph; checked by the tests). */
export const MARKS_GLYPH = '◈';

export interface GuideContext {
  readonly mode: GuideMode;
  readonly input: GuideInput;
  /** Free Roam bindings as saved (defaults when none). */
  readonly bindings: Bindings;
  /** Free Roam mouse aim (CONTROLS menu; off by default). */
  readonly mouseAim: boolean;
  /** Classic Wave 20 has been completed (weapon switching and roster ships open in Classic). */
  readonly classicGate: boolean;
}

export const DEFAULT_GUIDE_CONTEXT: GuideContext = Object.freeze({ mode: 'freeroam', input: 'keyboard', bindings: DEFAULT_BINDINGS, mouseAim: false, classicGate: false });

/** One control: alternative inputs (each a group of keycaps shown together), the action and what it does. */
export interface ControlRow {
  readonly id: string;
  readonly keys: readonly (readonly string[])[];
  readonly action: string;
  readonly text: string;
}

export interface GuidePoint {
  readonly label: string;
  readonly text: string;
}

export type GuideBlock =
  | { readonly kind: 'lead'; readonly text: string }
  | { readonly kind: 'points'; readonly items: readonly GuidePoint[] }
  | { readonly kind: 'controls'; readonly rows: readonly ControlRow[] }
  | { readonly kind: 'diagram'; readonly layout: 'freeroam' | 'classic'; readonly gate: boolean }
  /** Lines shown exactly as the game prints them (sample readouts). */
  | { readonly kind: 'sample'; readonly caption: string; readonly lines: readonly string[] }
  | { readonly kind: 'note'; readonly text: string };

export interface GuideStep {
  readonly id: GuideStepId;
  readonly kicker: string;
  readonly title: string;
  /** Whether the CLASSIC / FREE ROAM switch changes this step. */
  readonly byMode: boolean;
  /** Whether the KEYBOARD / TOUCH / CONTROLLER switch changes this step. */
  readonly byInput: boolean;
  readonly blocks: readonly GuideBlock[];
}

/* ------------------------------------------------------------------ helpers */

const slots = (b: Bindings, a: FlightAction): string[] => b[a].filter((k): k is string => k !== null).map(keyLabel);
/** Each key of an action as its own alternative ("SPACE" / "J"). */
const alts = (b: Bindings, a: FlightAction): string[][] => slots(b, a).map((k) => [k]);

/** Movement keys as up to two groups: first slots (W A S D), then second slots (↑ ← ↓ →) when all four have one. */
function moveKeys(b: Bindings): string[][] {
  const order: FlightAction[] = ['up', 'left', 'down', 'right'];
  const first = order.map((a) => keyLabel(b[a][0]));
  const second = order.map((a) => b[a][1]);
  return second.every((k) => k !== null) ? [first, second.map((k) => keyLabel(k))] : [first];
}

const shipNames = (weapon: WeaponId): string[] => shipsFor(weapon).map((id) => SHIP_BY_ID.get(id)?.name ?? id);
const list = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** True when the bindings differ from the defaults (the controls step says "your keys"). */
export function customBindings(b: Bindings): boolean {
  return (Object.keys(DEFAULT_BINDINGS) as FlightAction[]).some((a) => b[a][0] !== DEFAULT_BINDINGS[a][0] || b[a][1] !== DEFAULT_BINDINGS[a][1]);
}

/* ------------------------------------------------------------ control rows */

/** Free Roam on a keyboard, from the player's bindings. */
export function freeRoamKeyboard(b: Bindings, mouseAim: boolean): ControlRow[] {
  return [
    { id: 'move', keys: moveKeys(b), action: 'MOVE', text: mouseAim ? 'Fly in any direction. Mouse aim is on: the nose and guns follow the cursor.' : 'Fly in any direction. The ship drifts a little; its nose and guns follow your direction of travel.' },
    { id: 'fire', keys: alts(b, 'fire'), action: 'FIRE · HOLD', text: 'Fire the selected weapon. Holding builds heat; an overheated gun pauses for a moment.' },
    { id: 'boost', keys: alts(b, 'boost'), action: 'BOOST · HOLD', text: 'A burst of speed that uses energy.' },
    { id: 'weapon', keys: alts(b, 'missile'), action: ACTION_LABEL.missile.toUpperCase(), text: 'Switch to the next weapon in your cycle. The ship card shows the one selected.' },
    { id: 'lock', keys: alts(b, 'lock'), action: 'LOCK TARGET', text: 'Lock the hostile nearest your nose that is in range and in sight. Your nose turns to face it; you still steer, thrust and fire yourself. Press again to release.' },
    { id: 'target', keys: alts(b, 'target'), action: ACTION_LABEL.target.toUpperCase(), text: 'Only while locked: move the lock to the next target.' },
    { id: 'stop', keys: alts(b, 'stop'), action: 'STOP · REALISTIC', text: 'Realistic flight only: brake, then hold position against momentum and gravity. Active thrust, not paused physics. Press again, thrust or brake to release.' },
    { id: 'silent', keys: alts(b, 'silent'), action: 'SILENT RUNNING', text: 'Toggle a low signature: hostiles must come much closer to spot you, and your shield stops recharging. Firing or boosting ends it. The SILENT control (right side) shows its state.' },
    { id: 'zoom', keys: [['WHEEL'], ['+', '−']], action: 'ZOOM', text: 'Zoom the camera in or out. The mouse wheel only zooms; it never switches weapons.' },
    { id: 'interact', keys: alts(b, 'interact'), action: 'INTERACT', text: 'Dock, open, inspect, take a signal bearing or use a gate when a prompt shows.' },
    { id: 'map', keys: alts(b, 'map'), action: 'SECTOR MAP', text: 'The map of this sector.' },
    { id: 'cargo', keys: alts(b, 'cargo'), action: 'CARGO', text: 'Your hold and equipment.' },
    { id: 'pause', keys: [...alts(b, 'pause'), ['ESC']], action: 'PAUSE', text: 'Pause: missions, record, saves, controls and HOW TO PLAY.' },
  ];
}

/** Classic on a keyboard (fixed keys, input/keyboard.ts). */
export function classicKeyboard(gate: boolean): ControlRow[] {
  return [
    { id: 'move', keys: [['←', '→'], ['A', 'D']], action: 'MOVE', text: 'Slide left and right along the bottom of the screen.' },
    { id: 'fire', keys: [['SPACE'], ['Z'], ['X']], action: 'FIRE · HOLD', text: 'Hold to keep shooting. Hold too long and the gun overheats for a moment.' },
    { id: 'weapon', keys: [['Q']], action: 'NEXT WEAPON', text: gate ? 'Wave 20 is complete: fly a roster ship (SHIP on the Classic title) and Q cycles its weapons.' : 'Opens after you complete Wave 20, when you fly a roster ship.' },
    { id: 'pause', keys: [['P'], ['ESC']], action: 'PAUSE', text: 'Pause, with HOW TO PLAY and SETTINGS.' },
    { id: 'mute', keys: [['M']], action: 'MUTE', text: 'Sound on or off.' },
    { id: 'menu', keys: [['↑', '↓'], ['ENTER']], action: 'MENUS', text: 'Move and choose in menus.' },
  ];
}

/** Free Roam on a touch screen (the flight buttons). */
export function freeRoamTouch(): ControlRow[] {
  return [
    { id: 'move', keys: [['DRAG']], action: 'MOVE', text: 'Your first finger on open space becomes a floating stick: drag to fly.' },
    { id: 'fire', keys: [['FIRE']], action: 'FIRE · HOLD', text: 'Fire the selected weapon while held (bottom right).' },
    { id: 'boost', keys: [['BOOST']], action: 'BOOST · HOLD', text: 'A burst of speed that uses energy (beside FIRE).' },
    { id: 'weapon', keys: [['WPN']], action: 'NEXT WEAPON', text: 'The button above FIRE shows your weapon. Tap it to select the next one; it never fires.' },
    { id: 'lock', keys: [['LOCK']], action: 'LOCK TARGET', text: 'On the left. Tap to lock the hostile nearest your nose, tap again to cancel. Your nose faces the target; you still fly and fire.' },
    { id: 'target', keys: [['»']], action: 'NEXT TARGET', text: 'Appears beside LOCK while locked: tap for the next target.' },
    { id: 'stop', keys: [['STOP']], action: 'STOP · REALISTIC', text: 'Realistic flight only, above the weapon button: brake, then hold position. Tap again, or steer, to release.' },
    { id: 'silent', keys: [['SILENT']], action: 'SILENT RUNNING', text: 'Above the weapon button (top centre on a landscape phone; next to STOP in Realistic flight): tap to toggle a low signature. It reads SILENT RUNNING while on; firing or boosting ends it.' },
    { id: 'interact', keys: [['PROMPT']], action: 'INTERACT', text: 'A button appears near things you can use, for example DOCK · or USE GATE ·. Tap it.' },
    { id: 'hud', keys: [['MAP'], ['CARGO'], ['II']], action: 'TOP RIGHT', text: 'Sector map, cargo hold and pause.' },
    { id: 'zoom', keys: [['II', 'CONTROLS']], action: 'ZOOM', text: 'Pause, then CONTROLS: ZOOM − and ZOOM +.' },
  ];
}

/** Classic on a touch screen (touchControls.ts). */
export function classicTouch(gate: boolean): ControlRow[] {
  return [
    { id: 'move', keys: [['◀', '▶']], action: 'MOVE', text: 'Slide your finger along the pad below the playfield.' },
    { id: 'fire', keys: [['FIRE']], action: 'FIRE · HOLD', text: 'Tap or hold. Holding too long overheats the gun for a moment.' },
    { id: 'weapon', keys: [['WPN']], action: 'NEXT WEAPON', text: gate ? 'With a roster ship, a weapon button sits directly above FIRE: tap it for the next weapon.' : 'After Wave 20, with a roster ship, a weapon button appears directly above FIRE.' },
    { id: 'pause', keys: [['II']], action: 'PAUSE', text: 'Pause, with HOW TO PLAY and SETTINGS.' },
    { id: 'info', keys: [['i']], action: 'INFO', text: 'Controls and scoring at a glance.' },
  ];
}

/** Free Roam on a standard gamepad (input.ts PAD and flightPadCommands). */
export function freeRoamController(): ControlRow[] {
  return [
    { id: 'move', keys: [['L-STICK'], ['D-PAD']], action: 'MOVE', text: 'Fly in any direction.' },
    { id: 'aim', keys: [['R-STICK']], action: 'AIM', text: 'Point the nose and guns (optional).' },
    { id: 'fire', keys: [['RT'], ['RB'], ['X']], action: 'FIRE · HOLD', text: 'Fire the selected weapon.' },
    { id: 'boost', keys: [['LB'], ['LT']], action: 'BOOST · HOLD', text: 'A burst of speed that uses energy.' },
    { id: 'weapon', keys: [['R3']], action: 'NEXT WEAPON', text: 'Press the right stick for the next weapon.' },
    { id: 'silent', keys: [['L3']], action: 'SILENT RUNNING', text: 'Press the left stick to toggle a low signature.' },
    { id: 'interact', keys: [['A']], action: 'INTERACT', text: 'Dock, open, inspect or use a gate.' },
    { id: 'back', keys: [['B']], action: 'BACK', text: 'Close a panel or go back.' },
    { id: 'map', keys: [['SELECT']], action: 'SECTOR MAP', text: 'The map of this sector.' },
    { id: 'cargo', keys: [['Y']], action: 'CARGO', text: 'Your hold and equipment.' },
    { id: 'pause', keys: [['START']], action: 'PAUSE', text: 'Pause menu.' },
  ];
}

/** Classic on a standard gamepad (app.ts). */
export function classicController(gate: boolean): ControlRow[] {
  return [
    { id: 'move', keys: [['L-STICK'], ['D-PAD']], action: 'MOVE', text: 'Slide left and right.' },
    { id: 'fire', keys: [['A'], ['X']], action: 'FIRE · HOLD', text: 'Hold to keep shooting; too long overheats the gun.' },
    { id: 'weapon', keys: [['Y']], action: 'NEXT WEAPON', text: gate ? 'With a roster ship: the next weapon.' : 'Opens after you complete Wave 20, with a roster ship.' },
    { id: 'pause', keys: [['START']], action: 'PAUSE', text: 'Pause menu.' },
    { id: 'menu', keys: [['D-PAD', 'A'], ['B']], action: 'MENUS', text: 'Move and choose; B goes back.' },
  ];
}

export function controlRows(ctx: GuideContext): ControlRow[] {
  if (ctx.mode === 'classic') return ctx.input === 'touch' ? classicTouch(ctx.classicGate) : ctx.input === 'controller' ? classicController(ctx.classicGate) : classicKeyboard(ctx.classicGate);
  return ctx.input === 'touch' ? freeRoamTouch() : ctx.input === 'controller' ? freeRoamController() : freeRoamKeyboard(ctx.bindings, ctx.mouseAim);
}

/* ------------------------------------------------------------------- steps */

function welcome(): GuideBlock[] {
  return [
    { kind: 'lead', text: 'GALAXIA has two ways to play. Each keeps its own progress.' },
    {
      kind: 'points',
      items: [
        { label: 'CLASSIC · ARCADE', text: 'One fixed screen. Slide left and right, clear waves of diving formations and chase a high score. Shoot down a commander to free a captured fighter and fly a twin fighter.' },
        { label: 'FREE ROAM · EXPLORE', text: 'Fly in any direction across 10 galaxies and 170 systems. Dock at stations, take missions, salvage and trade, earn Guild marks, and change ships and weapons. Three save slots.' },
      ],
    },
    { kind: 'note', text: 'Complete Wave 20 in Classic to open weapon switching there and fly the ships you unlocked.' },
  ];
}

function ships(ctx: GuideContext): GuideBlock[] {
  if (ctx.mode === 'classic') {
    return [
      { kind: 'lead', text: 'Classic starts with the GALAXIA fighter.' },
      {
        kind: 'points',
        items: [
          { label: 'AFTER WAVE 20', text: 'Completing Wave 20 adds a SHIP choice to the Classic title. It lists the roster ships you have unlocked, in Classic or in Free Roam.' },
          { label: ctx.classicGate ? 'YOUR STATUS' : 'NOT YET', text: ctx.classicGate ? 'Wave 20 is complete: SHIP is on the Classic title.' : 'Wave 20 is not complete yet, so Classic flies the GALAXIA fighter.' },
          { label: 'HANGAR', text: 'Buying and inspecting ships happens in Free Roam, in a station HANGAR.' },
        ],
      },
    ];
  }
  return [
    { kind: 'lead', text: 'You start in the Petrel. Other ships wait in station hangars.' },
    {
      kind: 'points',
      items: [
        { label: 'OPEN', text: 'Fly close to a station, DOCK, then open the HANGAR tab.' },
        { label: 'INSPECT', text: 'Select a ship card to see its speed, handling, hull, shield, hold and weapons. Inspecting never changes your ship.' },
        { label: 'OWNED', text: 'SELECT SHIP, then CONFIRM. You switch ships while docked.' },
        { label: 'AVAILABLE', text: 'ACQUIRE pays cargo materials from your hold, not Guild marks. NEED CARGO means your hold is short.' },
        { label: 'LOCKED', text: 'A locked ship shows the licence it needs (for example a system to reach or surveys to complete) and your progress.' },
      ],
    },
  ];
}

function weapons(ctx: GuideContext): GuideBlock[] {
  const fit = WEAPONS.filter((w) => w.id !== PRIMARY_WEAPON).map((w) => ({ label: w.short, text: `${w.role} Fits the ${list(shipNames(w.id))}.` }));
  const primary = WEAPONS.find((w) => w.id === PRIMARY_WEAPON);
  if (ctx.mode === 'classic') {
    return [
      { kind: 'lead', text: 'Classic has no armory screen.' },
      {
        kind: 'points',
        items: [
          { label: 'BEFORE WAVE 20', text: 'The GALAXIA fighter has one gun. Hold fire, and watch the heat.' },
          { label: 'AFTER WAVE 20', text: 'A roster ship brings the start weapon and cycle set in Free Roam\'s ARMORY. Its ammunition refills at the start of every stage.' },
        ],
      },
    ];
  }
  return [
    { kind: 'lead', text: 'Set up what you launch with in the station ARMORY.' },
    {
      kind: 'points',
      items: [
        { label: 'OPEN', text: 'The ARMORY tab of a docked station, or ARMORY ▸ in the hangar.' },
        { label: 'INSPECT', text: 'Each card shows the weapon\'s role, ammunition and which ships can mount it. Weapons your ship cannot mount stay visible with the reason.' },
        { label: 'SET AS START', text: 'The weapon selected when you launch.' },
        { label: 'CYCLE', text: `ADD / REMOVE FROM CYCLE chooses what NEXT WEAPON steps through. ${primary ? `The ${primary.name} is always in the cycle.` : ''}`.trim() },
        { label: 'AMMUNITION', text: 'Heavy missiles and nukes carry limited rounds, refilled free when you dock. The lock-on missile uses energy and has a cooldown.' },
      ],
    },
    { kind: 'points', items: fit },
  ];
}

function controls(ctx: GuideContext): GuideBlock[] {
  const out: GuideBlock[] = [];
  if (ctx.input === 'touch') out.push({ kind: 'diagram', layout: ctx.mode, gate: ctx.classicGate });
  out.push({ kind: 'controls', rows: controlRows(ctx) });
  if (ctx.mode === 'freeroam' && ctx.input === 'keyboard') {
    out.push({ kind: 'note', text: `${customBindings(ctx.bindings) ? 'These are your keys. ' : ''}Change keys in PAUSE → SETTINGS & HELP → CONTROLS. Mouse aim (off by default) is there too: the cursor aims and the left button fires. FLIGHT MODE there switches NORMAL (the standard controls) and REALISTIC (momentum flight: left / right rotate, up thrusts, down reverses, plus STOP).` });
  } else if (ctx.mode === 'freeroam' && ctx.input === 'controller') {
    out.push({ kind: 'note', text: 'Target lock and next target are on the keyboard (X, C) and the touch LOCK button.' });
  } else if (ctx.mode === 'classic') {
    out.push({ kind: 'note', text: ctx.input === 'keyboard' ? 'Classic keys are fixed. In Classic, X fires; Classic has no boost, zoom or target lock.' : 'Classic has no boost, zoom or target lock.' });
  }
  if (ctx.mode === 'freeroam') out.push(signals(ctx), ...stealth(ctx));
  return out;
}

/** P07.2: Silent Running and Gravity Shadow (the run's rules, combat/stealth.ts; no extra screen). */
function stealth(ctx: GuideContext): GuideBlock[] {
  const press = ctx.input === 'touch' ? 'Tap SILENT' : ctx.input === 'controller' ? 'Press L3' : `Press ${keyLabel(ctx.bindings.silent[0])}`;
  return [
    {
      kind: 'points',
      items: [
        { label: 'SILENT RUNNING', text: `${press} to cut your signature to about a third: each hostile has to come much closer before it spots you. Press again to turn it off.` },
        { label: 'NOT INVISIBLE', text: 'Hostiles close by still detect you, and one already chasing you holds on a little further out.' },
        { label: 'SHIELD', text: 'Your shield does not recharge while Silent Running is on.' },
        { label: 'FIRE OR BOOST', text: 'Pressing fire or boost ends it at once, even if the weapon is still cooling down; the log names the input.' },
        { label: 'ENDS ON', text: 'Docking, a recall, RESTART FLIGHT and a ship change also turn it off. It is never saved.' },
        { label: 'HUD', text: 'The SILENT control (next to STOP in Realistic flight) reads SILENT RUNNING while on, with LOW SIGNATURE and SHIELD RECHARGE PAUSED.' },
      ],
    },
    {
      kind: 'points',
      items: [
        { label: 'GRAVITY SHADOW', text: 'A star, planet or moon directly between you and a hostile blocks its line of sight.' },
        { label: 'PER HOSTILE', text: 'It hides you only from hostiles on the far side of the body. Any with a clear line still see you.' },
        { label: 'HUD', text: 'GRAVITY SHADOW shows only while a body really blocks a hostile close enough to see you, and says how many still track you.' },
        { label: 'LAST KNOWN', text: 'A hostile that loses sight heads for where it last saw you for a moment, then searches there (… SEARCHING · LAST KNOWN POSITION).' },
        { label: 'NOT A SHIELD', text: 'Hiding is not protection: you can still be hit, and a hostile that rounds the body sees you again.' },
      ],
    },
  ];
}

/** P06.2: tracing an anomaly's faint signal with the INTERACT control (no extra button). */
function signals(ctx: GuideContext): GuideBlock {
  const press = ctx.input === 'touch' ? 'tap the TAKE BEARING prompt' : ctx.input === 'controller' ? 'press A (TAKE BEARING)' : 'press INTERACT (TAKE BEARING)';
  return {
    kind: 'points',
    items: [
      { label: 'FAINT SIGNAL', text: 'An anomaly hides its source somewhere inside the dashed ring around its marker. Find it with bearings.' },
      { label: 'BEARING', text: `Within sensor range and below 60 speed, ${press}, then hold steady for a moment while the ring around your ship fills.` },
      { label: 'NEW ANGLE', text: 'Fly well around the marker before the next bearing: lines at least 35° apart fix the source. Pressing again from the same spot does nothing; the fifth bearing always resolves.' },
      { label: 'REFUSED?', text: 'The log says why: too fast, out of range, a planet or star in the line, the same spot, or interference widening the error.' },
      { label: 'RESOLVED', text: 'The marker moves to the source. Fly there and INVESTIGATE for the usual reward, once.' },
      { label: 'SIMPLE SIGNALS', text: 'PAUSE → SETTINGS & HELP → CONTROLS → SIGNALS: SIMPLE makes one valid bearing enough.' },
    ],
  };
}

function marks(ctx: GuideContext): GuideBlock[] {
  if (ctx.mode === 'classic') {
    return [
      { kind: 'lead', text: 'Classic keeps score and your high score. It has no currency.' },
      { kind: 'note', text: 'GALAXIA\'s credits are Guild marks, used in Free Roam. Switch to FREE ROAM above to see how they work.' },
    ];
  }
  return [
    { kind: 'lead', text: 'GALAXIA\'s credits are Guild marks.' },
    { kind: 'sample', caption: 'On the ship card in flight and on every station screen', lines: [`${MARKS_GLYPH} 1,240 MARKS`] },
    {
      kind: 'points',
      items: [
        { label: 'EARN', text: 'Mission and contract rewards, selling cargo at a station EXCHANGE, clearing an encounter (once each), first discoveries, and small bounties for hostiles you destroy (limited per system).' },
        { label: 'SPEND', text: 'Reactor cells, equipment modules and ship upgrades, at stations.' },
        { label: 'NOT MARKS', text: 'Ships cost cargo materials and a licence. Travel burns reactor cells; its marks fee shows as FREE (0 MARKS).' },
        { label: 'BUY SAFELY', text: 'The first press shows the price, your balance and the balance after. CONFIRM pays; BACK cancels.' },
        { label: 'SHORT?', text: 'The button stays visible but disabled, with what is missing:' },
      ],
    },
    { kind: 'sample', caption: 'Example', lines: [`INSUFFICIENT MARKS · Required ${MARKS_GLYPH} 40 MARKS · Available ${MARKS_GLYPH} 3 MARKS · Shortfall ${MARKS_GLYPH} 37 MARKS`] },
  ];
}

function start(ctx: GuideContext, canPlay: boolean): GuideBlock[] {
  const how: GuidePoint[] =
    ctx.mode === 'classic'
      ? [
          { label: 'CLASSIC', text: 'START GAME on the Classic title. Clear each wave; the pause menu keeps HOW TO PLAY.' },
          { label: 'FREE ROAM', text: 'Opens on the map: ENTER SECTOR, read the briefing, then START FLIGHT.' },
        ]
      : [
          { label: 'FREE ROAM', text: 'Opens on the map: ENTER SECTOR, read the briefing, then START FLIGHT. Dock at a station to repair, trade and visit the hangar.' },
          { label: 'CLASSIC', text: 'START GAME on the Classic title.' },
        ];
  return [
    { kind: 'lead', text: canPlay ? 'Choose a mode to start.' : 'You are ready.' },
    { kind: 'points', items: how },
    { kind: 'note', text: 'HOW TO PLAY is always on the title screen and in the pause menu.' },
  ];
}

/** One step of the guide for this context. `canPlay`: the last step offers the PLAY buttons (title screen). */
export function guideStep(id: GuideStepId, ctx: GuideContext, canPlay = true): GuideStep {
  switch (id) {
    case 'welcome':
      return { id, kicker: 'TWO WAYS TO PLAY', title: 'WELCOME TO GALAXIA', byMode: false, byInput: false, blocks: welcome() };
    case 'ships':
      return { id, kicker: ctx.mode === 'classic' ? 'CLASSIC' : 'FREE ROAM · HANGAR', title: 'CHOOSE YOUR SHIP', byMode: true, byInput: false, blocks: ships(ctx) };
    case 'weapons':
      return { id, kicker: ctx.mode === 'classic' ? 'CLASSIC' : 'FREE ROAM · ARMORY', title: 'CONFIGURE WEAPONS', byMode: true, byInput: false, blocks: weapons(ctx) };
    case 'controls':
      return { id, kicker: `${MODE_LABEL[ctx.mode]} · ${INPUT_LABEL[ctx.input]}`, title: 'LEARN THE CONTROLS', byMode: true, byInput: true, blocks: controls(ctx) };
    case 'marks':
      return { id, kicker: ctx.mode === 'classic' ? 'CLASSIC' : 'FREE ROAM', title: 'CREDITS: GUILD MARKS', byMode: true, byInput: false, blocks: marks(ctx) };
    case 'start':
      return { id, kicker: 'READY', title: 'START PLAYING', byMode: true, byInput: false, blocks: start(ctx, canPlay) };
  }
}

/** All the text of a step (tests: accuracy and the no-developer-tools rule). */
export function stepText(step: GuideStep): string {
  const parts: string[] = [step.kicker, step.title];
  for (const b of step.blocks) {
    if (b.kind === 'lead' || b.kind === 'note') parts.push(b.text);
    else if (b.kind === 'points') for (const p of b.items) parts.push(p.label, p.text);
    else if (b.kind === 'controls') for (const r of b.rows) parts.push(r.action, r.keys.map((g) => g.join(' ')).join(' / '), r.text);
    else if (b.kind === 'sample') parts.push(b.caption, ...b.lines);
    else parts.push(`diagram:${b.layout}`);
  }
  return parts.join('\n');
}
