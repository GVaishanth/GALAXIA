/**
 * Free Roam Mode shell (lazy chunk). Owns, for its lifetime only:
 *  - state: the active local sector (sector/run.ts on a generated sector/generate.ts
 *    layout) + profile/progression (profile.ts, `galaxia:freeroam`);
 *  - update: a fixed 60 Hz loop (FixedStepClock) inside one scope frame loop;
 *  - rendering setup: its own full-bleed CanvasSurface + follow camera;
 *  - input interpretation (Prompt 7, docs/freeroam/FLIGHT_CONTROLS.md): analog
 *    2-D flight, aim and fire from rebindable keys, gamepad, touch (stick + FIRE,
 *    multi-pointer) and optional mouse aim, combined into one SectorInput per tick;
 *  - pause / restart: its own panels (briefing, pause, survey complete, sector
 *    map, cargo, controls);
 *  - listeners, loop, canvas memory and DOM: all released by dispose().
 *
 * Screens: the Galaxy Map (galaxy/galaxyMapScreen.ts, the hub, shown first), the
 * System Map of a galaxy (galaxy/systemMapScreen.ts) and the local sector of the
 * system the pilot is at (Prompt 6). Recording every survey mark of a sector
 * charts its system once (galaxy/progress.ts), which drives the unlocks on both
 * maps. Jump gates move the pilot to a neighbouring system's sector; the exit
 * beacon returns to the map the sector was entered from.
 *
 * Only the active sector exists: entering one generates its layout from the
 * catalogue seed and builds its art cache; leaving (map, exit, gate, quit)
 * disposes the run's temporary entities and the art cache. Completed
 * interactions, cargo and the survey flag are written to the profile the
 * moment they happen (sector/run.ts events), so rewards cannot repeat.
 *
 * Shared, never recreated: sound (one AudioContext), sprite cache, prefs, storage.
 * This is the extension point for docs/freeroam/ROADMAP.md stages FR-2+.
 */
import { FixedStepClock } from '../../core/clock.ts';
import { ENGINE } from '../../config/engine.ts';
import { KeyTracker } from '../../shared/input/keyTracker.ts';
import { anyPadConnected, GamepadReader } from '../../shared/input/gamepadReader.ts';
import { DisposableScope } from '../../shared/lifecycle/scope.ts';
import { AppShell } from '../../shared/rendering/appShell.ts';
import { fullscreenSupported, isFullscreen, onFullscreenChange, setFullscreen } from '../../shared/ui/fullscreen.ts';
import type { RenderScaleStats } from '../../shared/rendering/renderScale.ts';
import { CanvasSurface } from '../../shared/rendering/canvasSurface.ts';
import { MenuList } from '../../shared/ui/menuList.ts';
import type { GameMode, ModeContext, ModeDebug, ModeLifecycle, PauseReason } from '../types.ts';
import type { GalaxyId } from './catalogue/types.ts';
import { ACTION_LABEL, actionKeys, clearBinding, DEFAULT_BINDINGS, FLIGHT_ACTIONS, keyLabel, rebind, RESERVED_KEYS, trackedCodes, type Bindings, type FlightAction } from './bindings.ts';
import { cameraView, cameraZoom, clampCamera, clientToDevice, screenToWorld, snapCamera, stepCamera, stepFraming, stepZoom, worldToScreen, type CameraState, type CameraView } from './camera.ts';
import { SIMULATION_NOTE } from './catalogue/index.ts';
import { createGalaxyMap, type GalaxyMapScreen, type MapStatus } from './galaxy/galaxyMapScreen.ts';
import { buildNavGraph, type NavGraph } from './galaxy/graph.ts';
import { applySurvey, applyTravel, deriveView, describeRequirement, progressDiff, progressFromSaved, type ExplorationProgress, type SurveyResult } from './galaxy/progress.ts';
import { createSystemMap, type FuelRefusal, type SystemMapScreen, type SystemMapStatus } from './galaxy/systemMapScreen.ts';
import { applySystemTravel, deriveSystemView, HAZARD_LABEL, type SystemTravelResult } from './galaxy/systems.ts';
import { combineFlight, flightKeyCommands, flightPadCommands, keyboardBoost, keyboardFire, keyboardMissile, keyboardVector, MAP_KEYS, mapKeyCommands, mapPadCommands, padAim, padBoost, padFire, padMissile, padVector, panelKeyCommands, panelPadCommands, type FlightCommand, type MapCommand, type PanelCommand } from './input.ts';
import { FlightPointers } from './pointers.ts';
import { addFlight, dropCargo, formatTicks, lostCargoUnits, recordSurvey, startSession, withCargo, withFleet, withMilestone, withModules, withNavigation, withProgression, withResume, withSectorProgress, type FlightControls, type FreeRoamProfile, type ResumePoint } from './profile.ts';
import { activeSlot, AUTOSAVE_SECONDS, loadFreeRoamPrefs, loadSlot, readSlots, saveFreeRoamPrefs, saveSlot, setActiveSlot, deleteSlot, slotKey, type SlotNo } from './saveSlots.ts';
import { auditProfile, auditText } from './saveAudit.ts';
import { createSavesPanel, type SavesCommand, type SavesDeps, type SavesPanel, type SlotNames } from './ui/savesPanel.ts';
import { backupKey } from '../../shared/persistence/namespaces.ts';
import { planSwap, removeLoot, lootUnits } from './inventory/inventory.ts';
import { applyCollection } from './inventory/persistence.ts';
import { resourceName } from './inventory/resources.ts';
import { createFabricatorPanel, type FabricatorPanel } from './inventory/ui/fabricatorPanel.ts';
import { createLootFeed, createOfferPrompt, type LootFeed, type OfferView } from './inventory/ui/flightUi.ts';
import { lootIconKey } from './inventory/ui/iconImages.ts';
import { createInventoryPanel, type InventoryPanel } from './inventory/ui/inventoryPanel.ts';
import { COMBAT } from './combat/difficulty.ts';
import { FACTIONS } from './combat/factions.ts';
import { combatHud, type CombatHudModel } from './combat/hudModel.ts';
import { MISSILE } from './combat/playerMissile.ts';
import { spawnAgent } from './combat/ai.ts';
import type { FamilyId } from './combat/families.ts';
import { createCombatHud, type CombatHudView } from './combatHud.ts';
import { sectorContext } from './sector/context.ts';
import { generateSector } from './sector/generate.ts';
import { stackFlightHud } from './ui/hudStack.ts';
import { EMPTY_SECTOR_SAVE, POI_RULES, RARE_RESOURCES, type LootEntry, type SectorLayout } from './sector/model.ts';
import { BURST_MS, drawSector, drawSectorMap, SectorArt, SHAKE, WRECK_MS, type Burst, type Wreck } from './sector/render.ts';
import type { LabShell, LabStatus } from './gravity/labShell.ts';
import { applyShip, canSwitchShip, createSectorRun, disposeSectorRun, inCombat, interact, isDone, jettison, leaveOffer, marksLeft, pauseSector, restartSector, resumeSector, setCargoWreck, stepSector, takeOffer, type CargoWreck, type GateInfo, type LootOffer, type SectorEvent, type SectorInput, type SectorRun } from './sector/run.ts';
import { upgradedShip, cleanLevels, type UpgradeLevels } from './ships/upgrades.ts';
import { createEventBus, type GameEvent } from './progression/events.ts';
import { sectorGameEvents } from './progression/fromSector.ts';
import { abandonMission, acceptMission, consumeEvent, galaxyOf, type MissionWorld, type PrereqContext } from './progression/missions.ts';
import { STORY_BY_ID } from './progression/missionData.ts';
import type { ContractSpec, MissionDef } from './progression/missionTypes.ts';
import { stationBoard } from './progression/contracts.ts';
import { buildMissionWorld } from './progression/missionWorld.ts';
import type { Wallet } from './progression/economy.ts';
import { burnCells, cellsHeld, emergencyCells, emergencyJumpTarget, FUEL, galaxyJumpCells, homeJumpDue, hopCells, routeCells } from './progression/fuel.ts';
import { discoveryEntries, explorationStats, recordEvent } from './progression/discovery.ts';
import { progressionFromSaved, progressionToSaved, type ProgressionState } from './progression/persistence.ts';
import { claimReward, deliver, grantCells, rewardChartTargets } from './progression/station.ts';
import { missionsModel, missionTargets, trackedObjective } from './progression/view.ts';
import { createMissionsPanel, type MissionsPanel } from './progression/ui/missionsPanel.ts';
import { createExchangePanel, type ExchangePanel } from './progression/ui/exchangePanel.ts';
import { createUpgradesPanel, type UpgradesPanel } from './progression/ui/upgradesPanel.ts';
import { createRecordPanel, type RecordPanel } from './progression/ui/recordPanel.ts';
import { cargoUsed, fleetFromSaved, fleetToSaved, loadoutOf, type FleetState } from './ships/hangar.ts';
import { createHangarPanel, type HangarPanel, type HangarStatus } from './ships/hangarPanel.ts';
import { SHIP_BY_ID } from './ships/roster.ts';
import type { DerivedShip, ShipId } from './ships/types.ts';
import { freshShip, type FreeRoamPhase, type ShipState } from './sim.ts';
import { EQUIPMENT_BY_ID } from './ships/equipment.ts';
import { ENGINE_LOOP, FR_SOUNDS, type FrSoundId } from './audio/frSounds.ts';
import { engineLevel, momentCue, sectorCue, type HitContext, type MomentCue } from './audio/frCues.ts';
import type { VolumeBus } from './audio/audioSettings.ts';
import { createFlightHud, type FlightHud } from './ui/flightHud.ts';
import { cargoText, hudView, nearestPoi, NO_ATTENTION, shipCard, stepAttention, type HudAttention, type PoiCandidate } from './ui/hudModel.ts';
import { clearNotices, EMPTY_NOTICES, flushNotices, noticeLine, pushNotice, tickNotices, type Notice, type NoticeKind, type NoticeState } from './ui/notices.ts';
import { browserAnimate, createMotion, type Motion } from './ui/motion.ts';
import { createStationPanel, type StationPanel as StationHub } from './ui/stationPanel.ts';
import { isStationTab, stepTab, type StationTab } from './ui/stationModel.ts';
import { createEquipmentPanel, type EquipmentPanel } from './ui/equipmentPanel.ts';
import { createRecoveryPanel, type RecoveryPanel } from './ui/recoveryPanel.ts';
import { armingDelayMs, InputArming } from './ui/panelArming.ts';
import { createSoundPanel, type SoundPanel } from './ui/soundPanel.ts';

type Panel = 'briefing' | 'pause' | 'complete' | 'gate' | 'sectormap' | 'cargo' | 'controls' | 'hangar' | 'fabricator' | 'missions' | 'exchange' | 'upgrades' | 'record' | 'station' | 'equipment' | 'sound' | 'recovery' | null;
/** Prompt 11 panels opened from the hangar (docked) or the pause menu (log only). */
type Screen = 'map' | 'systems' | 'flight';
/** Where "back to the map" goes after a survey run: the map the run was started from. */
type MapReturn = 'galaxy' | 'system';

/** Read-only view of the active sector for diagnostics (Playwright). */
export interface SectorStatus {
  readonly systemId: string | null;
  readonly phase: FreeRoamPhase;
  readonly pois: readonly { readonly id: string; readonly kind: string; readonly x: number; readonly y: number; readonly r: number; readonly done: boolean }[];
  readonly marksLeft: number;
  readonly focus: string | null;
  readonly hostiles: number;
  readonly shield: number;
  readonly surveyed: boolean;
  readonly recalls: number;
  readonly gates: Readonly<Record<string, GateInfo>>;
  /** Sectors generated / disposed in this Free Roam session, and art resources currently held. */
  readonly generated: number;
  readonly disposed: number;
  readonly artResources: number;
  readonly spawn: string | null;
  /* Prompt 7: combat */
  readonly shots: number;
  /** Weapon heat 0..1, the overheat lock, and phone vibrations requested on overheat (FR-TD-79). */
  readonly heat: number;
  readonly overheated: boolean;
  readonly vibrations: number;
  readonly shaking: boolean;
  readonly kills: number;
  /** Combat P03: the missile skill (state, lock, cooldown ticks, notice, launches / hits this visit) and missiles in flight. */
  readonly missile: { readonly state: string; readonly target: number | null; readonly lock: number; readonly cooldown: number; readonly notice: string | null; readonly launches: number; readonly hits: number; readonly inFlight: number };
  readonly hostileList: readonly {
    readonly id: number;
    readonly family: string;
    readonly faction: string;
    readonly state: string;
    readonly role: string;
    readonly x: number;
    readonly y: number;
    readonly hull: number;
    readonly shield: number;
    readonly source: string;
  }[];
  /* Prompt 8: the ship flown */
  readonly ship: ShipId | null;
  readonly hull: number;
  readonly hullMax: number;
  readonly shieldMax: number;
  readonly energy: number;
  readonly energyMax: number;
  readonly boosting: boolean;
  readonly radius: number;
  readonly cargoSpace: number;
  readonly revealed: readonly string[];
  readonly docked: string | null;
  readonly inCombat: boolean;
  /* Prompt 9: combat */
  readonly combat: string;
  readonly grace: number;
  readonly encounters: readonly { readonly id: string; readonly kind: string; readonly state: string; readonly integrity: number; readonly holdLeft: number }[];
  readonly enemyShots: number;
  readonly mines: number;
  readonly pending: number;
  readonly provoked: readonly string[];
  readonly cargoWreck: { readonly x: number; readonly y: number; readonly units: number } | null;
  /* Prompt 10: collection */
  readonly pickups: readonly { readonly id: string; readonly kind: string; readonly x: number; readonly y: number; readonly units: number; readonly life: number; readonly armed: boolean }[];
  readonly offer: { readonly id: string; readonly kind: string; readonly need: number; readonly space: number; readonly x: number; readonly y: number } | null;
  readonly veins: readonly { readonly id: string; readonly x: number; readonly y: number; readonly r: number; readonly chips: number; readonly left: number; readonly uncollected: number }[];
  readonly left: Readonly<Record<string, number>>;
  readonly dropBudget: number;
  readonly feed: readonly string[];
  readonly banner: string | null;
  readonly objective: string | null;
  readonly boss: string | null;
}

/** The combined flight intent of the last frame (diagnostics). */
export interface InputStatus {
  readonly moveX: number;
  readonly moveY: number;
  readonly aim: { readonly x: number; readonly y: number } | null;
  readonly fire: boolean;
  readonly boost: boolean;
  /** Missile key / R3 / MSL held (Combat P03). */
  readonly missile: boolean;
  readonly stickActive: boolean;
  readonly fireTouches: number;
  readonly boostTouches: number;
  readonly missileTouches: number;
  readonly mouseFire: boolean;
  readonly keys: readonly string[];
}

/** Camera and canvas sizes (diagnostics): world view, device (backing) px and CSS px. */
export interface CameraStatus extends CameraView {
  readonly ratio: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly orientation: 'landscape' | 'portrait';
}

export interface FreeRoamStatus {
  /** The flight phase and ship of the active sector (an idle placeholder outside sectors). */
  readonly state: { readonly phase: FreeRoamPhase; readonly ship: ShipState };
  readonly sector: () => SectorStatus;
  readonly profile: () => FreeRoamProfile;
  readonly panel: () => Panel;
  readonly screen: () => Screen;
  readonly progress: () => ExplorationProgress;
  readonly map: () => MapStatus;
  readonly systems: () => SystemMapStatus;
  readonly mapReturn: () => MapReturn;
  readonly input: () => InputStatus;
  readonly camera: () => CameraStatus;
  readonly controls: () => FlightControls;
  /** FR-TD-83: the Gravity Flight test sector while it is active (dev / QA builds), else null. */
  readonly lab: () => LabStatus | null;
  /** Prompt 13: save slots panel and save state. */
  readonly saves: () => Readonly<Record<string, unknown>>;
  /** Client (CSS) px -> world, through the current camera (pointer mapping checks). */
  readonly toWorld: (clientX: number, clientY: number) => { x: number; y: number };
  /** World -> client (CSS) px. */
  readonly toClient: (x: number, y: number) => { x: number; y: number };
  /** Rocks and stars within `radius` of the ship (collision checks). */
  readonly solids: (radius: number) => readonly { readonly kind: string; readonly x: number; readonly y: number; readonly r: number }[];
  /* Prompt 8 */
  readonly fleet: () => FleetState;
  readonly craft: () => DerivedShip;
  readonly hangar: () => HangarStatus;
  /* Prompt 10 */
  readonly inventory: () => ReturnType<InventoryPanel['status']>;
  readonly fabricator: () => ReturnType<FabricatorPanel['status']>;
  /* Prompt 11 */
  readonly progression: () => ProgressionState;
  readonly missions: () => ReturnType<MissionsPanel['status']>;
  readonly exchange: () => ReturnType<ExchangePanel['status']>;
  readonly upgrades: () => ReturnType<UpgradesPanel['status']>;
  readonly record: () => ReturnType<RecordPanel['status']>;
  readonly tracked: () => string | null;
  /** Prompt 12: presentation state (HUD, notices, motion, station hub, sound). */
  readonly ui: () => Readonly<Record<string, unknown>>;
  readonly fuel: () => { readonly held: number; readonly emergency: number; readonly homeDue: boolean; readonly emergencyJump: string | null };
  /** Orientation changes seen (each one pauses flight and releases every input). */
  orientationChanges: number;
  /** The shared viewport owner's state (TD-72 / FR-TD-73: same object type as Classic's `shell`). */
  readonly viewport: () => ReturnType<AppShell['state']>;
  frames: number;
  ticks: number;
  draws: number;
  /** Adaptive render resolution (TD-79) of the flight canvas. */
  readonly renderScale: () => (RenderScaleStats & { ratio: number; backing: string }) | null;
  /**
   * Combat P03 QA only: put one hostile ship at (dx, dy) art px from the pilot (browser checks of the missile).
   * Part of the test hook object, so it exists only in builds with __GALAXIA_TEST_HOOKS__ (never in a release).
   */
  readonly qaSpawn: (family: FamilyId, dx: number, dy: number) => number | null;
  /** FR-TD-86: the planet / star pull on the ship this tick and the sector's wells (read only). */
  readonly gravity: () => {
    readonly x: number;
    readonly y: number;
    readonly g: number;
    readonly source: string | null;
    readonly wells: readonly { readonly id: string; readonly kind: string; readonly x: number; readonly y: number; readonly solid: number; readonly ref: number; readonly felt: number; readonly range: number }[];
  } | null;
}

declare const __GALAXIA_TEST_HOOKS__: boolean; // vite.config.ts `define` (TD-78: automation hooks, absent from release builds)
declare const __GALAXIA_GRAVITY_LAB__: boolean; // vite.config.ts `define` (FR-TD-83: the Gravity Flight prototype, dev / QA builds only)

declare global {
  interface Window {
    /** Free Roam status (read-only diagnostics for Playwright) while Free Roam is active. */
    __galaxiaFreeRoam?: FreeRoamStatus;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

export function createFreeRoamMode(ctx: ModeContext): GameMode {
  const { services, container } = ctx;
  const scope = new DisposableScope();
  let lifecycle: ModeLifecycle = 'created';
  let profile: FreeRoamProfile;
  /** The active sector visit; null outside sectors. */
  let run: SectorRun | null = null;
  let art: SectorArt | null = null;
  let layout: SectorLayout | null = null;
  const idle = { phase: 'briefing' as FreeRoamPhase, ship: freshShip(0, 0) };
  const counters = { generated: 0, disposed: 0 };
  /** Target system of the gate panel. */
  let gateTarget: string | null = null;
  let surface: CanvasSurface;
  /** Shared viewport owner (TD-72 / FR-TD-73): created at init with the canvas. */
  let shell: AppShell;
  let panel: Panel = null;
  let screen: Screen = 'map';
  let graph: NavGraph;
  let progress: ExplorationProgress;
  let map: GalaxyMapScreen;
  let systems: SystemMapScreen;
  let mapReturn: MapReturn = 'galaxy';
  /** Panel buttons that lead back to a map; their label follows `mapReturn`. */
  let returnButtons: HTMLButtonElement[] = [];
  let flightRoot: HTMLElement;
  /** FR-TD-83: the HUD button row (the gravity test adds its LAB button there). */
  let hudButtons: HTMLElement;
  /** FR-TD-83: the active Gravity Flight test sector (dev / QA builds only), or null. */
  let lab: LabShell | null = null;
  let lastPersistTick = 0;
  /** False when a newer build wrote the profile: play session-only, never overwrite it. */
  let writable = true;
  /* Prompt 13: save slots. The slot is fixed for this mode instance (another slot = a restart). */
  let saveSlotNo: SlotNo = 1;
  /** Free Roam controls (shared by every slot, `galaxia:freeroam:prefs`). */
  let controls: FlightControls;
  let prefsWritable = true;
  /** Last successful save of this instance (ms; 0 = none yet) and whether the latest attempt failed. */
  let lastSaveAt = 0;
  let lastSaveFailed = false;
  let saveFailNoted = false;
  /** Sector tick of the last timed autosave (one every AUTOSAVE_SECONDS of active flight). */
  let lastAutosaveTick = 0;
  /** The saved resume point, used by the first entry into its system this session. */
  let pendingResume: ResumePoint | null = null;
  /** The active sector started at a saved resume point (the briefing says so). */
  let resumedAt = false;
  let saves: SavesPanel;
  let savesBtn: HTMLButtonElement;
  let savesReturn: HTMLElement | null = null;
  let status: FreeRoamStatus;

  /** Map / panel / flight keys; the flight part follows the player's bindings (setCodes on rebind). */
  /** Full-hold choice shortcuts (only while a choice is open, and only when the key is not bound to a flight action). */
  const OFFER_KEYS = Object.freeze({ take: 'Digit1', swap: 'Digit2', leave: 'Digit3' });
  const allCodes = (b: Bindings): string[] => [...new Set([...trackedCodes(b), ...Object.values(MAP_KEYS).flat(), ...Object.values(OFFER_KEYS)])];
  const keys = new KeyTracker(allCodes(DEFAULT_BINDINGS));
  const pad = new GamepadReader();
  const pointers = new FlightPointers(56);
  const stick = pointers.stick;
  const clock = new FixedStepClock({ hz: ENGINE.tickHz, maxFrameMs: ENGINE.maxFrameMs });
  const cam: CameraState = { x: 0, y: 0 };
  /** The view of the last drawn frame: screen <-> world for pointers. */
  let view: CameraView = { x: 0, y: 0, zoom: 1, width: 1, height: 1 };
  let viewRatio = 1;
  const bursts: Burst[] = [];
  const wrecks: Wreck[] = [];
  const NO_INPUT: InputStatus = { moveX: 0, moveY: 0, aim: null, fire: false, boost: false, missile: false, stickActive: false, fireTouches: 0, boostTouches: 0, missileTouches: 0, mouseFire: false, keys: [] };
  /** Owned ships and loadouts (validated against the roster), and the derived ship flown. */
  let fleet: FleetState;
  let craft: DerivedShip;
  let lastInput: InputStatus = NO_INPUT;
  /** Overheat rattle start (performance.now ms), or null; phone vibrations requested (FR-TD-79). */
  let shakeStart: number | null = null;
  let vibrations = 0;
  let wheelAcc = 0;
  /** Controls panel: the slot waiting for a key, and the panel to return to. */
  let capture: { action: FlightAction; slot: 0 | 1 } | null = null;
  let controlsReturn: Panel = 'pause';
  let mapCanvasKey = '';

  /* DOM (built in init) */
  let interactBtn: HTMLButtonElement;
  let lastFrameTs = 0;
  /* Prompt 12: presentation (contextual HUD, notices, motion, station hub, recovery, sound) */
  let flightHud: FlightHud;
  let motion: Motion;
  let notices: NoticeState = EMPTY_NOTICES;
  let attention: HudAttention = NO_ATTENTION;
  /** Bumped on every sector entry (the HUD's change timers restart). */
  let sectorEntries = 0;
  let stationHub: StationHub;
  let equipment: EquipmentPanel;
  let recovery: RecoveryPanel;
  /** FR-TD-82: panels the game opens mid-flight ignore input until they have settled on screen. */
  const arming = new InputArming();
  let armedNode: HTMLElement | null = null;
  let soundPanel: SoundPanel;
  let soundReturn: Panel = 'pause';
  let pauseInfo: HTMLElement;
  let pauseKicker: HTMLElement;
  /** Frame-clock ms of the last arrival (canvas ring), or null. */
  let arrivalMs: number | null = null;
  /** Docking facts for the station overview (what docking just did). */
  let dockFirst = false;
  let dockEmergency = 0;
  /** Shield before the current batch of sector events (a shield hit vs a hull hit). */
  let batchShield: number | null = null;
  /** The tracked objective (shown contextually by the HUD). */
  let tracked: { readonly text: string; readonly here: boolean } | null = null;
  /** The location line: system and galaxy names. */
  let hereName = '';
  let galaxyShort = '';
  let cellsShortCache: { readonly key: string; readonly short: boolean } | null = null;
  let weaponCache: { readonly key: string; readonly name: string } | null = null;
  let combatView: CombatHudView;
  /** The combat HUD of the last drawn frame (also read by the diagnostics status). */
  let hudModel: CombatHudModel | null = null;
  /** Combat framing zoom multiplier (camera.ts stepFraming); 1 outside a fight. */
  let framing = 1;
  let gateTitle: HTMLElement;
  let gateText: HTMLElement;
  let gateJump: HTMLButtonElement;
  let briefingSector: HTMLElement;
  let briefingNote: HTMLElement;
  let completeCargo: HTMLElement;
  let panels: Record<Exclude<Panel, null>, HTMLElement>;
  let menus: Record<Exclude<Panel, null>, MenuList>;
  let completeTime: HTMLElement;
  let completeBest: HTMLElement;
  let completeCharted: HTMLElement;
  let completeNews: HTMLElement;
  let briefingStats: HTMLElement;
  let briefingKicker: HTMLElement;
  let briefingTitle: HTMLElement;
  let briefingTarget: HTMLElement;
  let hintKeys: HTMLElement;
  let fireBtn: HTMLButtonElement;
  let fireHeatKey = '';
  /** Weapon heat on the touch FIRE button (FR-TD-79): a rising fill, and HOT while locked. DOM only on change. */
  const paintFireHeat = (level: number, overheated: boolean): void => {
    const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
    const key = `${pct}|${overheated}`;
    if (key === fireHeatKey) return;
    fireHeatKey = key;
    fireBtn.style.setProperty('--heat', `${pct}%`);
    fireBtn.classList.toggle('is-overheated', overheated);
    const label = overheated ? 'HOT' : 'FIRE';
    if (fireBtn.textContent !== label) fireBtn.textContent = label;
  };
  let boostBtn: HTMLButtonElement;
  /* missile skill (Combat P03): the MSL touch button, and a press waiting for the next simulated tick */
  let missileBtn: HTMLButtonElement;
  let missilePending = false;
  let padMissileWas = false;
  const paintMissileBtn = (r: SectorRun, touches: number): void => {
    const m = r.missile;
    const state = m.state === 'acquiring' ? 'acquiring' : m.state === 'cooldown' ? (r.missiles.length > 0 ? 'launching' : m.notice === 'cooling' ? 'refused' : 'cooldown') : m.notice === 'noTarget' || m.notice === 'lowEnergy' || m.notice === 'lockLost' ? 'refused' : 'ready';
    const label = state === 'acquiring' ? 'LOCK' : m.state === 'cooldown' && state !== 'launching' ? `${Math.ceil(m.cooldown / 60)}s` : 'MSL';
    if (missileBtn.dataset['state'] !== state) missileBtn.dataset['state'] = state;
    if (missileBtn.textContent !== label) missileBtn.textContent = label;
    const pct = m.state === 'cooldown' ? Math.round((100 * m.cooldown) / MISSILE.cooldownTicks) : 0;
    missileBtn.style.setProperty('--cool', `${pct}%`);
    missileBtn.classList.toggle('is-active', touches > 0);
  };
  let hangar: HangarPanel;
  let inventory: InventoryPanel;
  let fabricator: FabricatorPanel;
  let feed: LootFeed;
  let offerView: OfferView;
  /** The station docked at (labels the hangar and the fabricator). */
  let dockLabel = 'Station';
  /* Prompt 11: progression (marks, missions, upgrades, licences, log, fuel book) and its panels */
  let prog: ProgressionState;
  const bus = createEventBus();
  let missionsPanel: MissionsPanel;
  let exchangePanel: ExchangePanel;
  let upgradesPanel: UpgradesPanel;
  let recordPanel: RecordPanel;
  /** Where a Prompt 11 panel returns: the hangar (docked) or the pause menu. */
  let stationReturn: 'hangar' | 'pause' = 'hangar';
  let worldCache: { readonly key: string; readonly world: MissionWorld } | null = null;
  /** Mission notices raised while a map is shown wait for the flight view. */
  const heldNotes: string[] = [];
  let mapCanvas: HTMLCanvasElement;
  let controlsGrid: HTMLElement;
  let controlsStatus: HTMLElement;
  let mouseAimBtn: HTMLButtonElement;
  let zoomLabel: HTMLElement;

  const reducedMotion = (): boolean => {
    const pref = services.prefs.get().display.reducedMotion;
    return pref === 'on' || (pref === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  };

  /* --------------------------------- sound --------------------------------- */
  const sfx = (id: FrSoundId): void => {
    services.sound.play(id);
  };
  const moment = (m: MomentCue): void => sfx(momentCue(m));
  /** Panel sound callbacks: a gained thing ('bonus') plays the Free Roam install sound. */
  const panelSound = (cue: 'uiMove' | 'uiSelect' | 'bonus' | 'pause'): void => {
    if (cue === 'bonus') moment('upgrade');
    else services.sound.play(cue);
  };

  /* ------------------------------ persistence ------------------------------ */
  /** Write the slot in use (never every frame: milestones, the timed flight autosave, SAVE NOW,
   *  hidden tab / pagehide and leaving). A failed write keeps the game running; it is retried at
   *  the next save and reported once per failure streak. */
  const save = (): boolean => {
    if (!writable) return false;
    const next = { ...profile, savedAt: Date.now() };
    const ok = saveSlot(services.store, saveSlotNo, next);
    if (ok) {
      profile = next;
      lastSaveAt = next.savedAt;
      lastSaveFailed = false;
      saveFailNoted = false;
    } else {
      lastSaveFailed = true;
      services.reportStorageProblem('write-failed');
      if (!saveFailNoted) {
        saveFailNoted = true;
        missionNote('SAVE FAILED · browser storage is full or blocked; progress may not persist', 'warn');
      }
    }
    refreshSavesBadge();
    return ok;
  };
  /** Where the pilot is, when it is safe to come back there (in flight or docked, no hostile engaged). */
  const resumeHere = (): void => {
    const r = run;
    // in flight, or paused over it (pause menu, docked at a station); never in a briefing / fight
    if (!r || r.disposed || (r.phase !== 'flight' && r.phase !== 'paused') || inCombat(r)) return; // keep the last safe point
    const round = (n: number, k: number): number => Math.round(n * k) / k;
    profile = withResume(profile, { systemId: r.layout.systemId, x: round(r.ship.x, 10), y: round(r.ship.y, 10), heading: round(r.ship.heading, 1000) });
  };
  /** Credit whole seconds flown in the active sector, note a safe resume point, then save. */
  const persist = (): boolean => {
    // FR-TD-83: the gravity test sector writes nothing (no flight time, no resume point, no save)
    if (__GALAXIA_GRAVITY_LAB__ && lab) return true;
    if (run) {
      const seconds = Math.floor((run.tick - lastPersistTick) / 60);
      if (seconds > 0) {
        profile = addFlight(profile, seconds, 0);
        lastPersistTick += seconds * 60;
      }
      resumeHere();
    }
    return save();
  };
  const resetRunCounters = (): void => {
    lastPersistTick = 0;
    lastAutosaveTick = 0;
  };
  /** Hold capacity of the ship flown, and the free space (never negative; old saves may be over capacity). */
  const holdCap = (): number => craft.stats.cargo;
  const holdFree = (): number => Math.max(0, holdCap() - cargoUsed(profile.cargo));
  const setFleet = (f: FleetState): void => {
    fleet = f;
    craft = upgradedShip(f.active, loadoutOf(f, f.active), levelsOf(f.active));
    profile = withFleet(profile, fleetToSaved(f));
  };
  /* ------------------------------ progression ------------------------------ */
  /** Upgrade levels of a ship, cleaned against its caps (never invalid stats). */
  const levelsOf = (id: ShipId): UpgradeLevels => cleanLevels(id, prog.upgrades[id]);
  const saveProg = (): void => {
    profile = withProgression(profile, progressionToSaved(prog));
  };
  const held = (): number => cellsHeld(profile.cargo);
  const wallet = (): Wallet => ({ marks: prog.marks, hold: profile.cargo, holdCap: holdCap(), modules: profile.modules });
  /** Apply a confirmed transaction (marks, hold, stored modules) with one save. */
  const commitWallet = (w: Wallet): void => {
    prog = { ...prog, marks: w.marks };
    profile = withModules(withCargo(profile, w.hold), w.modules);
    saveProg();
    if (run) run.cargoSpace = holdFree();
    save();
  };
  const galaxyName = (id: string): string => graph.node(id as GalaxyId)?.galaxy.shortName ?? id;
  const missionWorld = (): MissionWorld => {
    const done = Object.values(profile.sectors).reduce((n, x) => n + x.done.length, 0);
    const key = `${progress.current}|${progress.system}|${progress.visitedSystems.length}|${progress.charted.length}|${progress.visited.length}|${done}`;
    if (!worldCache || worldCache.key !== key) worldCache = { key, world: buildMissionWorld(graph, progress, profile.sectors) };
    return worldCache.world;
  };
  const prereqCtx = (): PrereqContext => ({ visitedGalaxies: progress.visited, charted: progress.charted.length });
  /** Mission notices: on the flight view now, otherwise when it is next shown. */
  const missionNote = (text: string, tone: 'gain' | 'warn' | 'info'): void => {
    if (screen === 'flight' && feed) notify(text, undefined, tone);
    else if (heldNotes.length < 6) heldNotes.push(`${tone}|${text}`);
  };
  const refreshMissionHud = (): void => {
    const here = run ? run.layout.systemId : progress.system;
    const t = trackedObjective(prog.missions, here, { name: (id) => graph.system(id)?.name ?? id }, galaxyName);
    tracked = t ? { text: t.text, here: !!t.here } : null;
  };
  /** The mission manager and the exploration log consume every gameplay event. */
  const onGameEvent = (e: GameEvent): void => {
    const res = consumeEvent(prog.missions, e);
    const log = recordEvent(prog.log, e, graph);
    if (res.state === prog.missions && log === prog.log) return;
    prog = { ...prog, missions: res.state, log };
    saveProg();
    for (const u of res.updates) {
      if (u.kind === 'progress') missionNote(`MISSION · ${u.title.toUpperCase()} · ${u.value}/${u.count}`, 'info');
      else if (u.kind === 'completed') {
        moment('missionComplete');
        if (screen === 'flight' && run) showNotice('mission', 'MISSION COMPLETE', `${u.title.toUpperCase()} · TURN IN AT ANY STATION`);
        else missionNote(`MISSION COMPLETE · ${u.title.toUpperCase()} · TURN IN AT ANY STATION`, 'gain');
      } else if (u.why !== 'abandoned') {
        moment('missionFailed');
        if (screen === 'flight' && run) showNotice('warn', 'MISSION FAILED', `${u.title.toUpperCase()} · ${u.why === 'deadline' ? 'OUT OF TIME' : 'TARGET LOST'}`);
        else missionNote(`MISSION FAILED · ${u.title.toUpperCase()} · ${u.why === 'deadline' ? 'OUT OF TIME' : 'TARGET LOST'}`, 'warn');
      }
    }
    if (res.updates.length) refreshMissionHud();
  };
  /** Publish gameplay events; one save when anything changed. */
  const publish = (events: readonly GameEvent[]): void => {
    if (events.length === 0) return;
    const before = prog;
    bus.publishAll(events);
    if (prog !== before) save();
  };
  const routeEvents = (ids: readonly string[]): GameEvent[] => ids.map((routeId) => ({ type: 'route-opened', routeId }));
  /** Arrival bookkeeping after any flown route (fuel book arrivals + events). */
  const arrived = (path: readonly string[], before: ExplorationProgress, hops: number, extra: readonly GameEvent[] = []): void => {
    prog = { ...prog, fuel: { ...prog.fuel, arrivals: prog.fuel.arrivals + 1 } };
    saveProg();
    const ev: GameEvent[] = [{ type: 'jumped', hops }];
    for (const id of path) ev.push({ type: 'system-visited', systemId: id, galaxyId: galaxyOf(id), first: !before.visitedSystems.includes(id) });
    publish([...ev, ...extra]);
  };
  const burn = (n: number): boolean => {
    if (n <= 0) return true;
    const next = burnCells(profile.cargo, n);
    if (!next) return false;
    profile = withCargo(profile, next);
    if (run) run.cargoSpace = holdFree();
    return true;
  };
  const isStation = (id: string): boolean => !!graph.system(id)?.sector.station;
  /** System-map travel: burns the route's cells (free for the R2 emergency jump). */
  const systemTravel = (to: string, free: boolean): SystemTravelResult | FuelRefusal => {
    const before = progress;
    const r = applySystemTravel(graph, progress, to);
    if (!r.ok) return r;
    const need = free ? 0 : routeCells(r.plan.lanes, craft.stats.travel);
    if (!burn(need)) return { ok: false, reason: 'fuel', need, have: held() };
    commitProgress(r.progress);
    arrived(r.plan.path.slice(1), before, r.plan.jumps, routeEvents(r.newRoutes));
    persist();
    return r;
  };
  const emergencyTarget = (): string | null => {
    const sv = deriveSystemView(deriveView(graph, progress), currentGalaxy().id);
    return emergencyJumpTarget(sv, held(), craft.stats.travel, isStation);
  };
  const homeDue = (): boolean => {
    const view = deriveView(graph, progress);
    return homeJumpDue(progress.current, graph.start, held(), graph.edgesOf(progress.current).filter((e) => view.routeOpen(e)), craft.stats.travel);
  };
  /** R3: the free return to the start galaxy's gateway. */
  const goHome = (): boolean => {
    if (!homeDue()) return false;
    const before = progress;
    const gateway = deriveSystemView(deriveView(graph, progress), graph.start).graph.gateway;
    const next: ExplorationProgress = { ...progress, current: graph.start, system: gateway, visitedSystems: progress.visitedSystems.includes(gateway) ? progress.visitedSystems : [...progress.visitedSystems, gateway] };
    const diff = progressDiff(graph, deriveView(graph, before), next);
    commitProgress(next);
    arrived([gateway], before, 1, [{ type: 'galaxy-reached', galaxyId: graph.start, first: false }, ...routeEvents(diff.newRoutes)]);
    persist();
    return true;
  };
  /** Docked: the station system id (null in flight or when opened from the pause menu). */
  const dockedAt = (): string | null => (run?.docked && stationReturn === 'hangar' ? run.layout.systemId : null);
  /** R1: free emergency cells due at this station (0 = enough for a jump, or already given since the last arrival). */
  const emergencyDue = (): number => {
    if (!run?.docked) return 0;
    const sys = run.layout.systemId;
    const sv = deriveSystemView(deriveView(graph, progress), galaxyOf(sys) as GalaxyId);
    return emergencyCells(held(), sv.graph, sys, craft.stats.travel, prog.fuel.aidAt === prog.fuel.arrivals);
  };
  const claimEmergency = (): string => {
    const n = emergencyDue();
    if (n <= 0) return 'No emergency cells due: you have enough for a jump from here.';
    const g = grantCells(profile.cargo, holdCap(), n);
    if (g.added <= 0) return 'No room for cells: sell or jettison some cargo, then take them.';
    profile = withCargo(profile, g.hold);
    // given in full: none again until the next arrival (a partial grant can be completed after making room)
    if (g.added >= n) prog = { ...prog, fuel: { ...prog.fuel, aidAt: prog.fuel.arrivals } };
    saveProg();
    if (run) run.cargoSpace = holdFree();
    save();
    return `The Guild loaded ${g.added} free emergency reactor cell${g.added === 1 ? '' : 's'}.`;
  };
  const ACCEPT_TEXT: Readonly<Record<string, string>> = {
    unknown: 'That offer is no longer posted.',
    active: 'Already accepted.',
    completed: 'Already completed.',
    failed: 'That mission failed and cannot be taken again.',
    prerequisites: 'Not available yet: finish what it builds on first.',
    limit: 'Mission log full (6 active): finish or abandon one first.',
  };
  const acceptOffer = (id: string): string => {
    const at = dockedAt();
    if (!at) return 'Missions are accepted at a station.';
    const world = missionWorld();
    let def: MissionDef | undefined = STORY_BY_ID.get(id);
    let spec: ContractSpec | undefined;
    if (!def) {
      const offer = stationBoard(prog.missions, at, world).offers.find((o) => o.def.id === id);
      def = offer?.def;
      spec = offer?.spec;
    }
    const res = acceptMission(prog.missions, def, world, prereqCtx(), spec);
    if (!res.ok) return ACCEPT_TEXT[res.reason] ?? 'Cannot accept that now.';
    prog = { ...prog, missions: res.state };
    saveProg();
    save();
    worldCache = null;
    refreshMissionHud();
    return `Accepted: ${def!.title}. Targets are marked on the system map.`;
  };
  const abandonOffer = (id: string): string => {
    const res = abandonMission(prog.missions, id);
    if (!res.update) return 'Not an active mission.';
    prog = { ...prog, missions: res.state };
    saveProg();
    save();
    refreshMissionHud();
    return `Abandoned: ${res.update.title}. ${id.startsWith('c:') ? 'The contract is closed.' : 'The Guild dispatch can offer it again.'}`;
  };
  const claimMission = (id: string): { readonly ok: boolean; readonly text: string } => {
    const res = claimReward(prog, id, wallet(), (galaxy, n) => rewardChartTargets(graph, progress, galaxy, n));
    if (!res.ok) return { ok: false, text: res.text };
    prog = res.progression;
    let news = '';
    const fresh = res.charted.filter((c) => !progress.charted.includes(c));
    if (fresh.length) {
      const next: ExplorationProgress = { ...progress, charted: [...progress.charted, ...fresh] };
      const diff = progressDiff(graph, deriveView(graph, progress), next);
      commitProgress(next);
      if (run) run.gates = gateInfos(run.layout);
      news = [
        `Charted ${fresh.map((c) => graph.system(c)?.name ?? c).join(', ')}.`,
        ...diff.newRoutes.map((rid) => `Route open: ${graph.edges.find((e) => e.id === rid)?.route.name ?? rid}.`),
        ...diff.newGalaxies.map((g) => `Unlocked: ${graph.node(g)!.galaxy.name}.`),
      ].join(' ');
      publish(routeEvents(diff.newRoutes));
    }
    commitWallet(res.wallet);
    setFleet(fleet); // licences change nothing fitted; re-derive anyway so stats are always current
    refreshMissionHud();
    return { ok: true, text: `Reward claimed: ${res.lines.join(' · ')}.${news ? ` ${news}` : ''}` };
  };
  const deliverMission = (id: string): string => {
    const at = dockedAt();
    if (!at) return 'Deliveries are handed over while docked at the named station.';
    const res = deliver(prog, id, at, profile.cargo);
    if (!res.ok) return res.text;
    profile = withCargo(profile, res.hold);
    saveProg();
    if (run) run.cargoSpace = holdFree();
    save();
    publish([res.event]);
    refreshMissionHud();
    return `Handed over ${res.amount}.`;
  };
  const shipName = (): string => SHIP_BY_ID.get(fleet.active)!.name;

  /* ------------------------------- sectors -------------------------------- */
  const label = (id: string): string => id.replace(/-/g, ' ').toUpperCase();
  const lootText = (loot: readonly LootEntry[]): string => loot.map((e) => `+${e.amount} ${resourceName(e.resource).toUpperCase()}`).join(' · ');
  const unitsText = (loot: readonly LootEntry[]): string => `${lootUnits(loot)} ${lootUnits(loot) === 1 ? 'UNIT' : 'UNITS'}`;
  /** Collection notices go to the corner log, never over the play area. */
  const notify = (text: string, loot?: readonly LootEntry[], tone: 'gain' | 'warn' | 'info' = 'gain'): void => {
    feed.push(text, loot && loot.length ? lootIconKey(loot) : undefined, tone);
  };
  /** While a combat banner is up, notices go to the corner log (they never compete with it). */
  const combatBusy = (): boolean => !!hudModel?.banner;
  const toLog = (list: readonly Notice[]): void => {
    if (!feed) return;
    for (const n of list) feed.push(noticeLine(n), undefined, n.kind === 'danger' || n.kind === 'warn' ? 'warn' : 'info');
  };
  /** One notice card (ui/notices.ts decides whether it shows now, waits or goes to the log;
   *  with a panel over the flight view it goes to the log, so it cannot expire unseen). */
  const showNotice = (kind: NoticeKind, title: string, detail?: string, ms?: number): void => {
    const r = pushNotice(notices, { kind, title, detail, ms }, lastFrameTs, combatBusy() || panel !== null);
    notices = r.state;
    toLog(r.toLog);
  };
  /** Gate states from the system map's knowledge: dormant (hidden), sealed (locked) or open. */
  const gateInfos = (L: SectorLayout): Record<string, GateInfo> => {
    const view = deriveView(graph, progress);
    const sv = deriveSystemView(view, currentGalaxy().id);
    const out: Record<string, GateInfo> = {};
    for (const p of L.pois) {
      if (p.kind !== 'gate' || !p.target) continue;
      const t = graph.system(p.target);
      const k = sv.knowledge(p.target);
      if (!t || k === 'hidden') out[p.id] = { state: 'dormant', label: 'Dormant gate', detail: 'No signal answers from the far side.' };
      else if (!sv.unlocked(p.target)) {
        const reqs = t.unlock.map((r) => describeRequirement(view, r)).filter((r) => !r.met);
        out[p.id] = { state: 'sealed', label: 'Sealed gate', detail: reqs.length ? `Sealed. To open: ${reqs.map((r) => r.detail).join(' ')}` : 'Sealed.' };
      } else {
        const name = k === 'signal' ? 'unknown signal' : t.name;
        out[p.id] = { state: 'open', label: `Gate to ${name}`, detail: `Jump to ${name}${sv.view.charted.has(t.id) ? ' (charted)' : ''}.` };
      }
    }
    return out;
  };
  /** The saved cargo wreck, when it lies in `systemId`. */
  const wreckFor = (systemId: string): CargoWreck | null => {
    const w = profile.lostCargo;
    return w && w.systemId === systemId ? { x: w.x, y: w.y, units: lostCargoUnits(profile), loot: Object.entries(w.cargo).map(([resource, amount]) => ({ resource, amount }) as LootEntry) } : null;
  };
  /** Generate and enter the sector of `systemId`. Any active sector is torn down first. */
  const enterSector = (systemId: string, spawn: string | undefined, phase: FreeRoamPhase): void => {
    leaveSector();
    const sys = graph.system(systemId);
    if (!sys) throw new Error(`unknown system ${systemId}`);
    layout = generateSector(sys, sectorContext(graph, systemId));
    art = new SectorArt(layout);
    // Prompt 13: the first entry into the saved system resumes at the saved point (checked
    // against the layout; an unsafe point starts at the arrival); any other entry starts fresh
    const at = pendingResume && pendingResume.systemId === systemId && spawn === undefined ? pendingResume : null;
    pendingResume = null;
    run = createSectorRun(layout, profile.sectors[systemId] ?? EMPTY_SECTOR_SAVE, { spawn, gates: gateInfos(layout), seed: randomSeed(), phase, ship: craft, cargoSpace: holdFree(), cargoWreck: wreckFor(systemId), at });
    resumedAt = at !== null && (run.ship.x !== layout.spawns[0]!.x || run.ship.y !== layout.spawns[0]!.y);
    if (!resumedAt) profile = withResume(profile, null);
    counters.generated += 1;
    resetRunCounters();
    snapCamera(cam, run.ship.x, run.ship.y); // a new sector: no glide from the old camera position
    bursts.length = 0;
    wrecks.length = 0;
    lastKey = '';
    sectorEntries += 1;
    arrivalMs = null;
  };
  /** Dispose the active sector's temporary entities and rendering resources (progress is already saved). */
  const leaveSector = (): void => {
    if (!run) return;
    persist();
    if (__GALAXIA_GRAVITY_LAB__ && lab) {
      lab.dispose();
      lab = null;
      keys.setCodes(allCodes(controls.bindings));
    }
    disposeSectorRun(run);
    art?.dispose();
    run = null;
    art = null;
    layout = null;
    counters.disposed += 1;
    gateTarget = null;
    bursts.length = 0;
    wrecks.length = 0;
    pointers.reset();
    hudModel = null;
    framing = 1;
    combatView.render(null);
    notices = clearNotices(notices);
    arrivalMs = null;
    if (feed) feed.clear();
    if (offerView) offerView.render(null, false, { take: '', swap: '', leave: '' }, () => ['', '']);
  };
  /**
   * FR-TD-83: enter the Gravity Flight test sector (an experimental region of
   * Sol; dev / QA builds only). The lab module loads on demand; the active
   * sector is left first (and saved as usual). Nothing in the test writes the
   * profile; leaving returns to the system map.
   */
  const enterGravityLab = async (): Promise<void> => {
    if (!__GALAXIA_GRAVITY_LAB__) return;
    const m = await import('./gravity/labShell.ts');
    if (lifecycle === 'disposed') return;
    leaveSector();
    const shell = m.createLabShell({
      graph,
      craft,
      seed: randomSeed(),
      root: flightRoot,
      hudButtons,
      pause: () => (run ? pauseSector(run).length > 0 : false),
      resume: () => {
        if (run) resumeSector(run);
        clock.resetTiming();
      },
      exit: () => actions.openMap(),
      notice: (title, detail) => showNotice('info', title, detail, 4200),
      sound: (id) => services.sound.play(id),
      onReset: () => {
        if (!run) return;
        snapCamera(cam, run.ship.x, run.ship.y);
        bursts.length = 0;
        wrecks.length = 0;
        clock.resetTiming();
      },
    });
    lab = shell;
    layout = shell.layout;
    art = new SectorArt(layout);
    run = shell.run;
    resumedAt = false;
    mapReturn = 'system';
    counters.generated += 1;
    resetRunCounters();
    snapCamera(cam, run.ship.x, run.ship.y);
    bursts.length = 0;
    wrecks.length = 0;
    lastKey = '';
    arrivalMs = null;
    keys.setCodes([...allCodes(controls.bindings), ...shell.codes]);
    refreshBriefing();
    hereName = 'GRAVITY TEST';
    refreshHint();
    showScreen('flight');
    showPanel(null);
    clock.resetTiming();
    arrivalMs = lastFrameTs;
    const s = shell.status();
    showNotice('info', `GRAVITY TEST · SCENARIO ${s.scenario}`, 'Experimental. Nothing here is saved. LAB (or T) opens scenarios, Flight Assist and tuning.', 5200);
  };
  const surveyText = (r: SectorRun): string => {
    const total = r.layout.pois.filter((p) => p.kind === 'survey').length;
    return r.surveyed ? 'SURVEYED' : `SURVEY ${total - marksLeft(r)}/${total}`;
  };
  const sectorStatus = (): SectorStatus => {
    const r = run;
    return {
      systemId: r ? r.layout.systemId : null,
      phase: r ? r.phase : 'briefing',
      pois: r ? r.layout.pois.map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y, r: p.r, done: p.kind === 'survey' ? r.surveyed || r.done.has(p.id) : r.done.has(p.id) })) : [],
      marksLeft: r ? marksLeft(r) : 0,
      focus: r ? r.focus : null,
      hostiles: r ? r.hostiles.length : 0,
      shield: r ? Math.round(r.shield) : 0,
      surveyed: r ? r.surveyed : false,
      recalls: r ? r.recalls : 0,
      gates: r ? r.gates : {},
      generated: counters.generated,
      disposed: counters.disposed,
      artResources: art ? art.resources : 0,
      spawn: r ? r.spawn : null,
      shots: r ? r.shots.length : 0,
      heat: r ? Math.round(r.heat * 1000) / 1000 : 0,
      overheated: r ? r.overheated : false,
      vibrations,
      shaking: shakeStart !== null,
      kills: r ? r.kills : 0,
      missile: r ? { state: r.missile.state, target: r.missile.target, lock: r.missile.lock, cooldown: r.missile.cooldown, notice: r.missile.notice, launches: r.missile.launches, hits: r.missile.hits, inFlight: r.missiles.length } : { state: 'ready', target: null, lock: 0, cooldown: 0, notice: null, launches: 0, hits: 0, inFlight: 0 },
      hostileList: r ? r.hostiles.map((h) => ({ id: h.id, family: h.family, faction: h.faction, state: h.state, role: h.role, x: Math.round(h.x), y: Math.round(h.y), hull: Math.ceil(h.hull), shield: Math.ceil(h.shield), source: h.source })) : [],
      ship: r ? r.craft.ship : null,
      hull: r ? Math.round(r.hull) : 0,
      hullMax: r ? r.craft.stats.hull : 0,
      shieldMax: r ? r.craft.stats.shield : 0,
      energy: r ? Math.round(r.energy) : 0,
      energyMax: r ? r.craft.stats.energy : 0,
      boosting: r ? r.boosting : false,
      radius: r ? r.tune.radius : 0,
      cargoSpace: r ? (Number.isFinite(r.cargoSpace) ? r.cargoSpace : -1) : 0,
      revealed: r ? [...r.revealed] : [],
      docked: r ? r.docked : null,
      inCombat: r ? inCombat(r) : false,
      combat: hudModel?.level ?? 'calm',
      grace: r ? r.grace : 0,
      encounters: r ? r.encounters.map((e) => ({ id: e.id, kind: e.kind, state: e.state, integrity: Math.ceil(e.integrity), holdLeft: e.holdLeft })) : [],
      enemyShots: r ? r.enemyShots.length : 0,
      mines: r ? r.mines.length : 0,
      pending: r ? r.pending.length : 0,
      provoked: r ? [...r.provoked] : [],
      cargoWreck: r?.cargoWreck ? { x: r.cargoWreck.x, y: r.cargoWreck.y, units: r.cargoWreck.units } : null,
      pickups: r ? r.pickups.map((p) => ({ id: p.id, kind: p.kind, x: Math.round(p.x), y: Math.round(p.y), units: lootUnits(p.loot), life: Number.isFinite(p.life) ? p.life : -1, armed: p.armed })) : [],
      offer: r?.offer ? { id: r.offer.id, kind: r.offer.kind, need: r.offer.need, space: r.offer.space, x: Math.round(r.offer.x), y: Math.round(r.offer.y) } : null,
      veins: r
        ? r.layout.veins.map((v) => {
            const uncollected = v.chips.filter((_, i) => !r.done.has(`${v.id}.${i + 1}`)).length;
            const loose = r.pickups.filter((q) => q.kind === 'ore' && q.id.startsWith(`${v.id}.`)).length;
            // left: still in the rock; uncollected: still in the rock or floating loose
            return { id: v.id, x: v.x, y: v.y, r: v.r, chips: v.chips.length, left: uncollected - loose, uncollected };
          })
        : [],
      left: r ? Object.fromEntries([...r.left].map(([id, l]) => [id, lootUnits(l)])) : {},
      dropBudget: r ? r.dropBudget : 0,
      feed: feed ? feed.lines() : [],
      banner: hudModel?.banner?.text ?? null,
      objective: hudModel?.objective ?? null,
      boss: hudModel?.boss?.name ?? null,
    };
  };

  /* --------------------------------- panels -------------------------------- */
  const showPanel = (p: Panel): void => {
    panel = p;
    arming.clear(); // a panel the player opens is ready at once; game-opened ones re-arm below
    if (armedNode) delete armedNode.dataset['arming'];
    armedNode = null;
    // one overlay at a time: every other panel is hidden and its animations stop
    for (const [id, node] of Object.entries(panels)) {
      if (id !== p && !node.hidden) motion.cancelWithin(node);
      node.hidden = id !== p;
    }
    // the station tabs belong to docked station panels only
    if (!(p && run?.docked && stationReturn === 'hangar' && isStationTab(p))) stationHub.tabs.remove();
    container.dataset['panel'] = p ?? 'none';
    capture = null;
    if (p) {
      // a notice card under the panel steps aside to the log (it would expire unseen)
      const nf = flushNotices(notices);
      notices = nf.state;
      toLog(nf.toLog);
      keys.clear(); // a key that opened the panel must not also steer or activate
      pointers.reset();
      menus[p].focus(0);
    } else if (document.activeElement instanceof HTMLElement && container.contains(document.activeElement)) {
      document.activeElement.blur(); // flight: no focused button may swallow Space / Enter
    }
  };
  /** FR-TD-82: the open panel appeared without a player command (recovery, survey complete). */
  const armPanel = (entranceDelayMs: number, animates: boolean): void => {
    if (!panel) return;
    arming.arm(performance.now(), armingDelayMs(entranceDelayMs, animates));
    armedNode = panels[panel];
    armedNode.dataset['arming'] = ''; // CSS: no pointer input until armed
  };
  /** Open a station section (docked only): the panel, its content, and the tab strip on top. */
  const openStation = (tab: StationTab): void => {
    if (!run?.docked) return;
    if (panel !== null && panel !== tab) services.sound.play('uiSelect');
    stationReturn = 'hangar';
    showPanel(tab);
    stationHub.mountTabs(panels[tab], tab);
    if (tab === 'station') stationHub.open();
    else if (tab === 'hangar') hangar.open(dockLabel);
    else if (tab === 'equipment') equipment.open(dockLabel);
    else if (tab === 'fabricator') fabricator.open(dockLabel);
    else if (tab === 'missions') missionsPanel.open();
    else if (tab === 'exchange') exchangePanel.open();
    else upgradesPanel.open();
  };
  const currentGalaxy = () => graph.node(progress.current)!.galaxy;
  const hereId = (): string => {
    const sv = deriveSystemView(deriveView(graph, progress), currentGalaxy().id);
    return sv.current ?? sv.graph.gateway;
  };
  const refreshBriefing = (): void => {
    const g = currentGalaxy();
    const sv = deriveSystemView(deriveView(graph, progress), g.id);
    const here = run ? graph.system(run.layout.systemId) : sv.current ? graph.system(sv.current) : undefined;
    const best = profile.bestSurveyTicks > 0 ? `BEST SURVEY ${formatTicks(profile.bestSurveyTicks)}` : 'NO SURVEY YET';
    briefingTitle.textContent = (here?.name ?? g.name).toUpperCase();
    briefingKicker.textContent = `LOCAL SECTOR · ${g.shortName.toUpperCase()}`;
    const real = here?.provenance.status === 'verified-object';
    if (run && here) {
      const L = run.layout;
      const threat = ['NONE', 'LOW', 'MODERATE', 'HIGH'][here.encounters.threat] ?? 'HIGH';
      briefingSector.textContent = `${label(L.archetype)} · HAZARD ${HAZARD_LABEL[here.sector.hazard].toUpperCase()} · HOSTILES ${threat}${here.sector.station ? ' · STATION' : ''}`;
      if (run.surveyed) briefingTarget.textContent = `${here.name}'s sector is surveyed. Explore freely: wrecks, caches, anomalies and salvage pay out once; gates lead on; the exit beacon returns to the map.`;
      else {
        const n = marksLeft(run);
        briefingTarget.textContent = `Record the ${n} survey mark${n === 1 ? '' : 's'} (the arrow points to the nearest)${sv.view.charted.has(here.id) ? '' : ` to chart ${here.name}`}. Fly close to wrecks, caches and anomalies and press INTERACT; salvage is collected by flying through it.`;
      }
    } else briefingTarget.textContent = '';
    const resumed = run && resumedAt ? 'RESUMED · you start where your last autosave left you in this sector.' : '';
    briefingNote.textContent = [resumed, real ? SIMULATION_NOTE : ''].filter(Boolean).join(' ');
    briefingNote.hidden = !real && !resumed;
    const back = mapReturn === 'system' ? 'SYSTEM MAP' : 'GALAXY MAP';
    for (const b of returnButtons) b.textContent = back;
    briefingStats.textContent = `FLIGHTS ${profile.sessions} · SURVEYS ${profile.surveysCompleted} · ${best} · MARKS ${profile.beaconsCharted}`;
    hereName = here ? here.name.toUpperCase() : g.shortName.toUpperCase();
    galaxyShort = g.shortName.toUpperCase();
    refreshHint();
  };
  /** Key hint line from the current bindings. */
  const refreshHint = (): void => {
    const b = controls.bindings;
    const order = ['up', 'left', 'down', 'right'] as const; // reads "WASD"
    const move = order.map((a) => keyLabel(b[a][0])).join('');
    const alt = order.map((a) => keyLabel(b[a][1])).join('');
    if (__GALAXIA_GRAVITY_LAB__ && lab) {
      // FR-TD-83: the gravity test flies rotate-and-thrust with the same keys
      hintKeys.textContent = `${keyLabel(b.left[0])}/${keyLabel(b.right[0])} ROTATE · ${keyLabel(b.up[0])} THRUST · ${keyLabel(b.down[0])} BRAKE · ${actionKeys(b, 'fire')} FIRE · G ASSIST · T LAB · ESC PAUSE`;
      container.dataset['aim'] = controls.mouseAim ? 'mouse' : 'travel';
      return;
    }
    hintKeys.textContent = `${move}${alt.includes('—') ? '' : ` / ${alt}`} FLY · ${actionKeys(b, 'fire')} FIRE · ${keyLabel(b.boost[0])} BOOST${controls.mouseAim ? ' · MOUSE AIM' : ''} · ${actionKeys(b, 'interact')} INTERACT · ${keyLabel(b.map[0])} MAP · ${keyLabel(b.cargo[0])} CARGO · ESC PAUSE`;
    container.dataset['aim'] = controls.mouseAim ? 'mouse' : 'travel';
  };
  const describeSurvey = (r: SurveyResult): void => {
    const g = graph.node(r.galaxy)!.galaxy;
    const pct = deriveView(graph, r.progress).exploration(r.galaxy).percent;
    completeCharted.textContent = r.chartedSystem ? `CHARTED ${r.chartedSystem.name.toUpperCase()} · ${g.shortName.toUpperCase()} ${pct}% EXPLORED` : `${g.shortName.toUpperCase()} ${pct}% EXPLORED`;
    const news = [
      ...r.newMilestones.map((m) => `MILESTONE: ${m.name.toUpperCase()}`),
      ...r.newRoutes.map((id) => `ROUTE OPEN: ${graph.edges.find((e) => e.id === id)!.route.name.toUpperCase()}`),
      ...r.newGalaxies.map((id) => `UNLOCKED: ${graph.node(id)!.galaxy.name.toUpperCase()}`),
    ];
    completeNews.textContent = news.join(' · ');
    completeNews.hidden = news.length === 0;
  };
  const commitProgress = (next: ExplorationProgress): void => {
    progress = next;
    profile = withNavigation(profile, progress);
  };
  const showScreen = (s: Screen, galaxy = progress.current): void => {
    screen = s;
    container.dataset['screen'] = s;
    flightRoot.hidden = s !== 'flight';
    keys.clear();
    pointers.reset();
    motion.cancelAll();
    if (s !== 'flight') {
      panel = null;
      for (const node of Object.values(panels)) node.hidden = true;
      container.dataset['panel'] = 'none';
      stationHub.tabs.remove();
      notices = clearNotices(notices);
      services.sound.stopLoop(ENGINE_LOOP); // the engine is heard only in flight
    }
    // a short fade as a screen opens (skipped under reduced motion)
    motion.play(s === 'map' ? map.root : s === 'systems' ? systems.root : flightRoot, 'fade');
    if (s === 'map') {
      systems.hide();
      map.show();
    } else if (s === 'systems') {
      map.hide();
      systems.show(galaxy);
    } else {
      map.hide();
      systems.hide();
      for (const n of heldNotes.splice(0)) {
        const i = n.indexOf('|');
        notify(n.slice(i + 1), undefined, n.slice(0, i) as 'gain' | 'warn' | 'info');
      }
      refreshMissionHud();
    }
  };

  let lastWarnMs = -Infinity;
  const ENCOUNTER_TEXT: Readonly<Record<string, Partial<Record<'warning' | 'start' | 'broken' | 'cleared' | 'failed', string>>>> = {
    outpost: { start: 'HOSTILE OUTPOST · DESTROY THE GARRISON OR HOLD NEARBY', cleared: 'OUTPOST SILENCED', broken: 'OUTPOST · ENGAGEMENT BROKEN OFF' },
    ambush: { warning: 'AMBUSH SPRUNG · BEAT THEM OR BREAK AWAY', cleared: 'AMBUSH BEATEN', broken: 'AMBUSH ESCAPED' },
    defence: { start: 'DISTRESS BEACON · DEFEND THE WRECK FROM CARGO RAIDERS', cleared: 'WRECK DEFENDED', failed: 'WRECK STRIPPED · DEFENCE FAILED', broken: 'WRECK ABANDONED' },
    dispute: { start: 'GLEANER CLAIM · LEAVE ITS SALVAGE OR FIGHT FOR IT', cleared: 'CLAIM SETTLED', broken: 'CLAIM LEFT BEHIND' },
    elite: { start: 'ELITE CONTACT · ENGAGING', cleared: 'ELITE DESTROYED', broken: 'ELITE BROKE OFF' },
    capital: { start: 'CAPITAL SHIP · ENGAGING', cleared: 'CAPITAL SHIP DESTROYED', broken: 'CAPITAL SHIP · DISENGAGED' },
  };
  const encounterToast = (e: Extract<SectorEvent, { type: 'encounter' }>): void => {
    const base = ENCOUNTER_TEXT[e.kind]?.[e.state];
    if (!base) return;
    const named = e.kind === 'elite' || e.kind === 'capital' ? `${base} · ${e.label.toUpperCase()}` : base;
    const kind: NoticeKind = e.state === 'cleared' ? 'discovery' : e.state === 'failed' ? 'warn' : e.state === 'broken' ? 'info' : 'danger';
    showNotice(kind, named, e.state === 'cleared' && e.loot.length ? lootText(e.loot) : undefined, 3200);
  };
  /**
   * Persist one collection (the cargo taken, and the id completed or what is
   * left in it) with one save. applyCollection pays a completed id never
   * again and a partly taken find only for exactly what the save says is in it.
   */
  const collect = (systemId: string, e: Parameters<typeof applyCollection>[2]): boolean => {
    const before = profile;
    profile = applyCollection(profile, systemId, e);
    if (profile === before) return false;
    save();
    if (run) run.cargoSpace = holdFree();
    return true;
  };
  /* ------------------------------ full hold -------------------------------- */
  /** Lead (always shown) and detail (dropped on small screens). */
  const offerText = (o: LootOffer): readonly [string, string] => [`HOLD FULL · NEEDS ${o.need} · ${o.space} FREE`, o.label.toUpperCase()];
  const offerActions = {
    take: (): void => {
      if (!run?.offer || panel) return;
      const ev = takeOffer(run);
      if (ev.length) handleEvents(run, ev);
    },
    /** SWAP: throw the cheaper cargo out as a pod (still collectable), then take the find. */
    swap: (): void => {
      const r = run;
      if (!r?.offer || panel) return;
      const plan = planSwap(profile.cargo, r.offer.loot, holdCap());
      if (!plan) {
        notify('NOTHING CHEAPER TO SWAP OUT', undefined, 'warn');
        return;
      }
      const jet = jettison(r, plan.jettison);
      const rest = jet.length ? removeLoot(profile.cargo, plan.jettison) : null;
      if (!rest) {
        notify('CANNOT JETTISON NOW · TOO MUCH FLOATING NEARBY', undefined, 'warn');
        return;
      }
      profile = withCargo(profile, rest);
      save();
      r.cargoSpace = holdFree();
      notify(`JETTISONED ${unitsText(plan.jettison)} · ${plan.jettison.map((e) => resourceName(e.resource).toUpperCase()).join(' · ')}`, plan.jettison, 'info');
      const ev = takeOffer(r);
      if (ev.length) handleEvents(r, ev);
    },
    leave: (): void => {
      if (!run?.offer || panel) return;
      const label = run.offer.label.toUpperCase();
      leaveOffer(run);
      services.sound.play('uiMove');
      notify(`LEFT AT ${label} · MARKED ON THE SECTOR MAP`, undefined, 'info');
    },
  };
  /** Throw a whole cargo stack out behind the ship (cargo panel); returns the panel message. */
  const jettisonStack = (resource: string): string => {
    const n = profile.cargo[resource] ?? 0;
    if (!run || n <= 0) return 'Nothing to jettison.';
    const ev = jettison(run, [{ resource, amount: n } as LootEntry]);
    if (ev.length === 0) return 'Too much is already floating out there: collect some of it first.';
    const next = { ...profile.cargo };
    delete next[resource];
    profile = withCargo(profile, next);
    run.cargoSpace = holdFree();
    save();
    lastKey = '';
    return `Jettisoned ${n} ${resourceName(resource).toUpperCase()}. It floats behind the ship for a minute and can be picked up again.`;
  };
  /** The sound of a sector event (audio/frCues.ts), with the shield state around its batch. */
  let hitCtx: HitContext = { shieldBefore: 0, shieldAfter: 0 };
  const cue = (e: SectorEvent): void => {
    const id = sectorCue(e, hitCtx);
    if (id) sfx(id);
  };
  const handleEvent = (r: SectorRun, sys: string, e: SectorEvent): void => {
    {
      if (e.type === 'recorded') {
        profile = addFlight(withSectorProgress(profile, sys, [e.id]), 0, 1);
        save();
        cue(e);
        if (e.remaining > 0) showNotice('discovery', 'SURVEY MARK RECORDED', `${e.remaining} LEFT`);
      } else if (e.type === 'collected') {
        if (!collect(sys, e)) return;
        cue(e);
        notify(`SALVAGE ${lootText(e.loot)}${e.left.length ? ` · ${unitsText(e.left)} LEFT` : ''}`, e.loot);
      } else if (e.type === 'looted') {
        if (e.loot.length === 0) {
          collect(sys, e);
          cue(e);
          notify(`${e.label.toUpperCase()} · DISCOVERY RECORDED`, undefined, 'info');
          return;
        }
        if (!collect(sys, e)) return;
        cue(e);
        notify(`${e.label.toUpperCase()} ${lootText(e.loot)}${e.left.length ? ` · ${unitsText(e.left)} LEFT` : ''}`, e.loot);
      } else if (e.type === 'picked') {
        if (!collect(sys, e)) return;
        cue(e);
        notify(`${e.label.toUpperCase()} ${lootText(e.loot)}${e.left.length ? ` · ${unitsText(e.left)} LEFT` : ''}`, e.loot);
      } else if (e.type === 'dropped') {
        notify('SALVAGE POD · FLY OVER IT WITHIN 40 S', undefined, 'info');
      } else if (e.type === 'expired') {
        if (e.kind === 'pod' || e.kind === 'jettison') notify(e.kind === 'pod' ? 'SALVAGE POD DRIFTED OUT OF RANGE' : 'JETTISONED CARGO DRIFTED AWAY', undefined, 'warn');
      } else if (e.type === 'chipped') {
        cue(e);
        notify(`ORE FRAGMENT CHIPPED${e.remaining > 0 ? ` · ${e.remaining} LEFT IN THE VEIN` : ' · VEIN DEPLETED'}`, undefined, 'info');
      } else if (e.type === 'docked') {
        if (e.first) profile = withSectorProgress(profile, sys, [e.id]);
        persist();
        cue(e);
        // docking opens the station overview (Prompt 12); the flight is paused until LAUNCH
        pauseSector(r);
        const station = r.layout.pois.find((p) => p.id === e.id);
        dockLabel = station?.label ?? 'Station';
        stationReturn = 'hangar';
        dockFirst = e.first;
        // R1: short of cells for any jump from here: the Guild tops the hold up for free
        const cellsBefore = held();
        if (emergencyDue() > 0) notify(claimEmergency().toUpperCase(), undefined, 'info');
        dockEmergency = Math.max(0, held() - cellsBefore);
        openStation('station');
      } else if (e.type === 'dockRefused') {
        cue(e);
        showNotice('warn', 'DOCKING REFUSED', 'HOSTILES ENGAGED', 3000);
      } else if (e.type === 'holdFull') {
        // the choice opens low on screen (flight goes on); the log keeps a line
        cue(e);
        notify(`HOLD FULL · NEEDS ${e.need} · ${e.space} FREE`, undefined, 'warn');
      } else if (e.type === 'wrecked') {
        wrecks.push({ x: e.x, y: e.y, heading: e.heading, sprite: r.craft.sprite, startMs: lastFrameTs });
        if (wrecks.length > 4) wrecks.shift(); // bounded presentation effect
        // half of every common stack stays in a wreck here (any older wreck is lost); one save per death
        profile = dropCargo(profile, sys, e.x, e.y, COMBAT.wreckShare, RARE_RESOURCES);
        save();
        setCargoWreck(r, wreckFor(sys));
        r.cargoSpace = holdFree();
      } else if (e.type === 'recovered') {
        collect(sys, e);
        r.cargoSpace = holdFree();
        cue(e);
        notify(`CARGO RECOVERED · ${e.units} UNITS${e.left.length ? ` · ${unitsText(e.left)} STILL IN THE WRECK` : ''}`, e.loot);
      } else if (e.type === 'encounter') {
        encounterToast(e);
        if (e.state === 'cleared') {
          collect(sys, e); // completion pays once: the id is saved with the loot (and any overflow as a reward cache)
          cue(e);
          if (e.left.length) notify(`REWARD CACHE · ${unitsText(e.left)} DID NOT FIT · IT WAITS AT THE SITE`, e.left, 'warn');
        } else if (e.state === 'start' || e.state === 'warning') cue(e);
        else if (e.state === 'failed') cue(e);
      } else if (e.type === 'telegraph') {
        // heavy attacks announce themselves (rate-limited so a fleet does not drown the mix)
        if ((e.weapon === 'missile' || e.weapon === 'beam' || e.weapon === 'broadside' || e.weapon === 'launch') && lastFrameTs - lastWarnMs > 700) {
          lastWarnMs = lastFrameTs;
          cue(e);
        }
      } else if (e.type === 'provoked') {
        showNotice('danger', e.why === 'claim' ? `${FACTIONS[e.faction].name.toUpperCase()} · CLAIM CONTESTED` : `${FACTIONS[e.faction].name.toUpperCase()} TURN HOSTILE`, e.why === 'claim' ? 'THEY OPEN FIRE' : undefined, 3000);
      } else if (e.type === 'reinforcements') {
        if (e.count > 0) showNotice('danger', 'SPOTTED', `${e.count} REINFORCEMENTS INBOUND`, 2800);
      } else if (e.type === 'bossPhase') {
        cue(e);
        showNotice('danger', 'CAPITAL SHIP', 'BEAM ARRAYS ONLINE', 3000);
      } else if (e.type === 'blast') {
        cue(e);
        bursts.push({ x: e.x, y: e.y, startMs: lastFrameTs, size: 2 });
        if (bursts.length > 16) bursts.shift();
      } else if (e.type === 'shotDown') {
        bursts.push({ x: e.x, y: e.y, startMs: lastFrameTs, size: 1 });
        if (bursts.length > 16) bursts.shift();
      } else if (e.type === 'missileLock' || e.type === 'missileLockLost' || e.type === 'missileRefused' || e.type === 'missileLaunched' || e.type === 'missileReady') {
        cue(e); // the HUD missile row and the MSL button carry the text (NO TARGET, LOCK LOST, LOW ENERGY...)
      } else if (e.type === 'missileHit' || e.type === 'missileExpired') {
        if (e.type === 'missileHit') cue(e);
        // a small puff where it ended (a kill also gets the destroyed burst); bounded like every burst
        if (e.type === 'missileExpired' || !e.killed) {
          bursts.push({ x: e.x, y: e.y, startMs: lastFrameTs, size: 1 });
          if (bursts.length > 16) bursts.shift();
        }
      } else if (e.type === 'disabled') {
        showNotice('info', 'TARGET DISABLED', undefined, 1600);
      } else if (e.type === 'hit') {
        cue(e);
      } else if (e.type === 'fired') {
        cue(e);
      } else if (e.type === 'overheated') {
        // FR-TD-79: a fading screen rattle (none with reduced motion) and, while a finger holds FIRE, a short buzz
        cue(e);
        shakeStart = performance.now();
        if (lastInput && lastInput.fireTouches > 0 && !reducedMotion() && typeof navigator.vibrate === 'function') {
          navigator.vibrate([70, 50, 70]);
          vibrations += 1;
        }
      } else if (e.type === 'weaponCooled') {
        cue(e);
      } else if (e.type === 'struck') {
        cue(e);
      } else if (e.type === 'destroyed') {
        cue(e);
        bursts.push({ x: e.x, y: e.y, startMs: lastFrameTs, size: e.size });
        if (bursts.length > 16) bursts.shift(); // bounded presentation effect
      } else if (e.type === 'recalled') {
        // the recall already happened (repaired, back at the arrival zone); the camera stays on the
        // wreck until CONTINUE, and the recovery screen opens after the burst (presentation only)
        cue(e);
        const w = wrecks[wrecks.length - 1];
        if (w) {
          bursts.push({ x: w.x, y: w.y, startMs: lastFrameTs, size: 3 });
          if (bursts.length > 16) bursts.shift();
        }
        pauseSector(r);
        showPanel('recovery'); // any notice card steps aside to the log
        recovery.open({ ship: shipName(), wreckUnits: r.cargoWreck ? r.cargoWreck.units : 0, recalls: r.recalls });
        armPanel(650, motion.play(panels.recovery, 'enter', { delayMs: 650 }));
      } else if (e.type === 'surveyComplete') {
        const rec = recordSurvey(profile, e.ticks);
        profile = withSectorProgress(rec.profile, sys, [], true);
        const survey = applySurvey(graph, progress);
        commitProgress(survey.progress);
        if (survey.chartedSystem) publish([{ type: 'system-charted', systemId: survey.chartedSystem.id, galaxyId: survey.galaxy }, ...routeEvents(survey.newRoutes)]);
        r.gates = gateInfos(r.layout); // charting can reveal or open neighbours
        describeSurvey(survey);
        persist();
        cue(e);
        completeTime.textContent = `TIME ${formatTicks(e.ticks)}`;
        completeBest.textContent = rec.newBest ? 'NEW BEST SURVEY' : `BEST ${formatTicks(profile.bestSurveyTicks)}`;
        completeBest.classList.toggle('is-best', rec.newBest);
        const cargo = Object.entries(profile.cargo);
        completeCargo.textContent = cargo.length ? `CARGO ${cargo.map(([k, n]) => `${resourceName(k).toUpperCase()} ${n}`).join(' · ')}` : '';
        completeCargo.hidden = cargo.length === 0;
        showPanel('complete');
        armPanel(0, false);
      } else if (e.type === 'gate') {
        if (e.gate.state === 'open') {
          gateTarget = e.target;
          gateTitle.textContent = e.gate.label.toUpperCase();
          const lane = deriveSystemView(deriveView(graph, progress), galaxyOf(sys) as GalaxyId).graph.laneBetween(sys, e.target);
          const need = lane ? hopCells(lane.cost, craft.stats.travel) : 0;
          const have = held();
          gateText.textContent = `${e.gate.detail} The jump burns ${need} reactor cell${need === 1 ? '' : 's'} (you have ${have}); you arrive at the matching gate in the other system.${have < need ? ' Not enough cells: dock at a station for free emergency cells, or use the system map\'s free emergency jump.' : ''}`;
          gateJump.textContent = have < need ? `NEED ${need} CELLS` : `JUMP · ${need} CELL${need === 1 ? '' : 'S'}`;
          pauseSector(r);
          showPanel('gate'); // opened by the player's own INTERACT press: ready at once
        } else {
          cue(e);
          showNotice('warn', e.gate.label.toUpperCase(), e.gate.detail.toUpperCase(), 3600);
        }
      } else if (e.type === 'exit') actions.openMap();
    }
  };
  /** Resources that entered the hold (for resource-acquired events). */
  const gainedLoot = (before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>): LootEntry[] =>
    Object.entries(after)
      .filter(([k, n]) => n > (before[k] ?? 0))
      .map(([k, n]) => ({ resource: k, amount: n - (before[k] ?? 0) }) as LootEntry);
  /**
   * Sector events: the shell reacts (saves, sound, notices), then the same
   * event goes to the progression systems as typed gameplay events. `applied`
   * comes from the inventory: a repeat that changed nothing publishes nothing.
   */
  /** FR-TD-83: events the gravity test passes to the shell (combat feedback only; nothing that saves or publishes). */
  const LAB_EVENTS: ReadonlySet<SectorEvent['type']> = new Set(['hit', 'fired', 'overheated', 'weaponCooled', 'struck', 'destroyed', 'telegraph', 'blast', 'shotDown', 'disabled', 'missileLock', 'missileLockLost', 'missileRefused', 'missileLaunched', 'missileHit', 'missileExpired', 'missileReady']);
  const handleEvents = (r: SectorRun, events: readonly SectorEvent[]): void => {
    const sys = r.layout.systemId;
    hitCtx = { shieldBefore: batchShield ?? r.shield, shieldAfter: r.shield };
    batchShield = null;
    if (__GALAXIA_GRAVITY_LAB__ && lab) {
      for (const e of events) {
        if (e.type === 'wrecked') {
          wrecks.push({ x: e.x, y: e.y, heading: e.heading, sprite: r.craft.sprite, startMs: lastFrameTs });
          if (wrecks.length > 4) wrecks.shift();
        } else if (e.type === 'recalled') {
          cue(e);
          showNotice('warn', 'SHIP DESTROYED · SCENARIO RESET', 'Nothing is lost in the gravity test.', 3200);
          snapCamera(cam, r.ship.x, r.ship.y);
        } else if (LAB_EVENTS.has(e.type)) handleEvent(r, sys, e);
      }
      return;
    }
    const kindOf = (id: string) => r.layout.pois.find((p) => p.id === id)?.kind;
    for (const e of events) {
      const before = profile;
      handleEvent(r, sys, e);
      publish(sectorGameEvents(e, { systemId: sys, kindOf, applied: profile.cargo !== before.cargo || profile.sectors !== before.sectors, gained: gainedLoot(before.cargo, profile.cargo) }));
    }
  };

  /* -------------------------------- actions -------------------------------- */
  const actions = {
    start: (): void => {
      if (!run) return;
      services.sound.play('uiSelect');
      resumeSector(run);
      snapCamera(cam, run.ship.x, run.ship.y);
      clock.resetTiming();
      showPanel(null);
      arrivalMs = lastFrameTs;
      moment('arrive');
    },
    pause: (): void => {
      if (!run || pauseSector(run).length === 0) return;
      services.sound.play('pause');
      // TD-81: silence the engine hum now; the frame loop that eases it does not run in a hidden tab
      services.sound.setLoopGain(ENGINE_LOOP, 0);
      persist();
      // the pause card names where you are and carries the survey clock (no longer always on the HUD)
      pauseKicker.textContent = `${hereName} · ${galaxyShort}`;
      pauseInfo.textContent = __GALAXIA_GRAVITY_LAB__ && lab ? `EXPERIMENTAL · NOTHING IS SAVED · TIME ${formatTicks(run.tick)}` : `${surveyText(run)} · TIME ${formatTicks(run.tick)}`;
      showPanel('pause');
    },
    resume: (): void => {
      if (!run || resumeSector(run).length === 0) return;
      services.sound.play('uiSelect');
      clock.resetTiming();
      showPanel(null);
    },
    /** Back to the arrival zone: temporary state resets, completed interactions stay. */
    restart: (): void => {
      if (!run) return;
      if (__GALAXIA_GRAVITY_LAB__ && lab) {
        // FR-TD-83: RESTART FLIGHT restarts the current gravity scenario
        lab.reset();
        resumeSector(run);
        clock.resetTiming();
        showPanel(null);
        return;
      }
      persist();
      restartSector(run);
      resetRunCounters();
      services.sound.play('uiSelect');
      snapCamera(cam, run.ship.x, run.ship.y);
      bursts.length = 0;
      wrecks.length = 0;
      clock.resetTiming();
      showPanel(null);
    },
    interact: (): void => {
      if (!run || panel) return;
      if (run.offer) {
        offerActions.take(); // INTERACT (key, pad A, the button) takes what fits while the choice is open
        return;
      }
      const ev = interact(run);
      if (ev.length) handleEvents(run, ev);
    },
    jump: (): void => {
      if (!run || !gateTarget) return;
      const from = run.layout.systemId;
      const to = gateTarget;
      const before = progress;
      const r = applySystemTravel(graph, progress, to);
      if (!r.ok) {
        showPanel(null);
        resumeSector(run);
        moment('refused');
        showNotice('warn', 'THE GATE DOES NOT RESPOND', undefined, 3000);
        return;
      }
      const need = routeCells(r.plan.lanes, craft.stats.travel);
      if (!burn(need)) {
        showPanel(null);
        resumeSector(run);
        moment('refused');
        showNotice('warn', `JUMP NEEDS ${need} REACTOR CELLS`, `YOU HAVE ${held()} · DOCK FOR FREE CELLS OR USE THE SYSTEM MAP`, 3600);
        return;
      }
      commitProgress(r.progress);
      arrived(r.plan.path.slice(1), before, r.plan.jumps, routeEvents(r.newRoutes));
      moment('jump');
      enterSector(to, `gate:${from}`, 'flight');
      persist();
      refreshBriefing();
      clock.resetTiming();
      showPanel(null);
      arrivalMs = lastFrameTs;
      showNotice('arrival', graph.system(to)!.name.toUpperCase(), galaxyShort);
    },
    stay: (): void => {
      gateTarget = null;
      actions.resume();
    },
    /** Sector map overlay: pauses the flight. */
    sectorMap: (): void => {
      if (!run || pauseSector(run).length === 0) return;
      services.sound.play('pause');
      persist();
      mapCanvasKey = '';
      showPanel('sectormap');
    },
    cargo: (): void => {
      if (__GALAXIA_GRAVITY_LAB__ && lab) {
        showNotice('info', 'CARGO IS CLOSED IN THE GRAVITY TEST', undefined, 2400); // jettison would change the save
        return;
      }
      if (!run || pauseSector(run).length === 0) return;
      services.sound.play('pause');
      persist();
      showPanel('cargo');
      inventory.open();
      menus.cargo.focus(menus.cargo.buttons().length - 1); // RESUME: a quick double press never jettisons
    },
    /** Hangar LAUNCH: undock and fly on. */
    launch: (): void => {
      if (!run || resumeSector(run).length === 0) return;
      moment('launch');
      clock.resetTiming();
      showPanel(null);
      arrivalMs = lastFrameTs;
      showNotice('info', `LAUNCHED · ${shipName().toUpperCase()}`);
    },
    /** Recovery CONTINUE: the camera joins the repaired ship at the arrival zone and the flight resumes. */
    recoveryContinue: (): void => {
      if (!run || panel !== 'recovery') return;
      snapCamera(cam, run.ship.x, run.ship.y);
      arrivalMs = lastFrameTs;
      actions.resume();
    },
    /** Recovery SECTOR MAP: where the wreck lies (the flight stays paused; RESUME continues). */
    recoveryMap: (): void => {
      if (!run || panel !== 'recovery') return;
      services.sound.play('uiSelect');
      snapCamera(cam, run.ship.x, run.ship.y);
      mapCanvasKey = '';
      showPanel('sectormap');
    },
    /** SOUND settings (pause menu or briefing). */
    sound: (): void => {
      if (panel !== 'pause' && panel !== 'briefing') return;
      soundReturn = panel;
      services.sound.play('uiSelect');
      showPanel('sound');
      soundPanel.open();
    },
    closeSound: (): void => {
      services.sound.play('uiMove');
      showPanel(soundReturn);
    },
    /** Pause MISSIONS / RECORD: read-only log views (nothing is traded in flight). */
    log: (p: 'missions' | 'record'): void => {
      if (panel !== 'pause') return;
      services.sound.play('uiSelect');
      stationReturn = 'pause';
      showPanel(p);
      (p === 'missions' ? missionsPanel : recordPanel).open();
    },
    stationBack: (): void => {
      services.sound.play('uiMove');
      if (stationReturn === 'pause' || !run?.docked) showPanel('pause');
      else openStation('station');
    },
    controls: (): void => {
      if (panel !== 'pause' && panel !== 'briefing') return;
      controlsReturn = panel;
      services.sound.play('uiSelect');
      refreshControls('');
      showPanel('controls');
    },
    closeControls: (): void => {
      services.sound.play('uiMove');
      refreshHint();
      showPanel(controlsReturn);
    },
    zoom: (dir: number): void => {
      const z = stepZoom(controls.zoom, dir);
      if (z === controls.zoom) return;
      setControls({ zoom: z });
    },
    exit: (): void => {
      services.sound.play('uiSelect');
      ctx.requestExit();
    },
    openMap: (): void => {
      services.sound.play('uiSelect');
      if (__GALAXIA_GRAVITY_LAB__ && lab) {
        // FR-TD-83: leaving the gravity test touches no resume point; back to the system map
        leaveSector();
        showScreen('systems');
        return;
      }
      leaveSector();
      // leaving the sector on purpose: the next visit starts at the arrival
      if (profile.resume) {
        profile = withResume(profile, null);
        save();
      }
      showScreen(mapReturn === 'system' ? 'systems' : 'map');
    },
    openSystems: (galaxy: GalaxyId): void => {
      services.sound.play('uiSelect');
      showScreen('systems', galaxy);
    },
    galaxyMap: (): void => {
      services.sound.play('uiMove');
      showScreen('map');
    },
    briefing: (from: MapReturn): void => {
      mapReturn = from;
      services.sound.play('uiSelect');
      enterSector(hereId(), undefined, 'briefing');
      refreshBriefing();
      showScreen('flight');
      showPanel('briefing');
    },
  };

  /* ------------------------------ save slots (Prompt 13) ------------------------------ */
  /** Problems found while loading the slot (shown once in the saves panel and in flight). */
  let loadMessage = '';
  const savesWarn = (): boolean => !services.store.persistent || !writable || lastSaveFailed || loadMessage !== '';
  function refreshSavesBadge(): void {
    if (!savesBtn) return;
    const warn = savesWarn();
    const text = warn ? 'SAVES !' : 'SAVES';
    if (savesBtn.textContent !== text) savesBtn.textContent = text;
    savesBtn.classList.toggle('is-warn', warn);
    savesBtn.setAttribute('aria-label', warn ? 'Save slots (attention: progress may not persist)' : 'Save slots');
  }
  const slotNames: SlotNames = {
    galaxy: (id) => galaxyName(id),
    system: (_g, id) => (id ? (graph.system(id)?.name ?? 'Unknown system') : 'Gateway'),
    ship: (id) => SHIP_BY_ID.get(id as ShipId)?.name ?? 'Unknown ship',
  };
  const openSaves = (): void => {
    if (saves.isOpen()) return;
    if (screen === 'flight' && panel !== 'pause') return; // in flight only from the pause menu (the flight is paused)
    services.sound.play('uiSelect');
    savesReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keys.clear();
    pointers.reset();
    for (const n of [map.root, systems.root, flightRoot]) n.inert = true;
    container.dataset['saves'] = 'open';
    saves.open(loadMessage);
    loadMessage = '';
    refreshSavesBadge();
  };
  const closeSaves = (): void => {
    if (!saves.isOpen()) return;
    saves.hide();
    for (const n of [map.root, systems.root, flightRoot]) n.inert = false;
    delete container.dataset['saves'];
    keys.clear();
    clock.resetTiming();
    const back = savesReturn;
    savesReturn = null;
    if (back && back.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll: true });
    else if (panel) menus[panel].focus();
  };
  const savesCommand = (c: PanelCommand): void => {
    const m: SavesCommand | null = c === 'prev' || c === 'next' || c === 'confirm' || c === 'back' ? c : c === 'pause' ? 'back' : null;
    if (m) saves.command(m);
  };
  const BLOCKED = 'browser storage is full or blocked';
  const savesDeps: SavesDeps = {
    view: () => ({ slots: readSlots(services.store), active: saveSlotNo, persistent: services.store.persistent, writable, lastSaveAt, lastSaveFailed }),
    names: slotNames,
    saveNow: () => {
      if (!writable) return 'This slot is read-only here: nothing was saved.';
      if (!persist()) return `Saving FAILED (${BLOCKED}). The game keeps running and tries again at the next save.`;
      return services.store.persistent ? `Saved to slot ${saveSlotNo}.` : `Saved to slot ${saveSlotNo} for this tab only (browser storage is unavailable).`;
    },
    load: (n) => {
      if (n === saveSlotNo) {
        closeSaves();
        return '';
      }
      persist(); // the slot in use first: switching never loses progress
      if (!setActiveSlot(services.store, n)) return `Could not switch slots (${BLOCKED}). Nothing was changed.`;
      writable = false; // this instance is finished with its slot (just saved)
      ctx.requestRestart();
      return '';
    },
    newGame: (n) => {
      const info = readSlots(services.store)[n - 1]!;
      if (n !== saveSlotNo) persist();
      const key = slotKey(n);
      if (info.state === 'damaged') {
        // the card promised it: the unreadable data stays as a backup copy
        const raw = services.store.read(key);
        if (raw !== null && !services.store.write(backupKey(key), raw)) return `Could not keep a backup of the damaged slot (${BLOCKED}). Nothing was changed.`;
      }
      if (info.state !== 'empty' && !services.store.remove(key)) return `Could not clear slot ${n} (${BLOCKED}). Nothing was changed.`;
      if (n === saveSlotNo) writable = false; // never write the erased progress back on the way out
      if (!setActiveSlot(services.store, n)) return `Slot ${n} was cleared but could not be opened (${BLOCKED}).`;
      writable = false;
      ctx.requestRestart();
      return '';
    },
    remove: (n) => {
      if (n === saveSlotNo) return 'The slot in use cannot be deleted: load another slot first.';
      return deleteSlot(services.store, n) ? `Slot ${n} deleted.` : `Could not delete slot ${n} (${BLOCKED}).`;
    },
    close: closeSaves,
    sound: panelSound,
  };

  const buildPanel = (id: Exclude<Panel, null>, kicker: string, title: string, body: readonly HTMLElement[], buttons: readonly [string, () => void][]): HTMLElement => {
    const p = el('section', `fr-panel fr-panel-${id}`);
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', title);
    p.hidden = true;
    const list = el('div', 'fr-menu');
    for (const [label, fn] of buttons) {
      const b = el('button', 'fr-btn', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      list.append(b);
    }
    p.append(el('p', 'fr-kicker', kicker), el('h2', 'fr-title', title), ...body, list);
    menus[id] = new MenuList(list, () => services.sound.play('uiMove'));
    return p;
  };

  /* ------------------------------- commands -------------------------------- */
  const panelCommand = (c: PanelCommand): void => {
    if (!panel || capture) return; // while a key is being captured, the capture listener owns the keyboard
    if (!arming.admit(performance.now())) return; // FR-TD-82: a press from flight must not act on a panel that just appeared
    const m = menus[panel];
    // focus on the station tab strip (reached with Tab): an arrow enters the content at its first item
    const onTabs = document.activeElement instanceof HTMLElement && !!document.activeElement.closest('.fr-tabs');
    if ((c === 'prev' || c === 'next') && onTabs) m.focus(0);
    else if (c === 'prev') m.move(-1);
    else if (c === 'next') m.move(1);
    else if (c === 'confirm') {
      // a focused button outside the menu list (a station tab) is activated directly
      const a = document.activeElement;
      if (a instanceof HTMLButtonElement && panels[panel].contains(a) && !a.disabled && !m.buttons().includes(a)) a.click();
      else m.activate();
    } else if (c === 'tabPrev' || c === 'tabNext') {
      if (run?.docked && stationReturn === 'hangar' && isStationTab(panel)) {
        // the strip shows the new selection; focus starts in the new tab's content
        openStation(stepTab(panel, c === 'tabNext' ? 1 : -1));
      }
    } else if (c === 'back' || c === 'pause') {
      if (panel === 'station') actions.launch();
      else if (panel === 'equipment') equipment.back();
      else if (panel === 'sound') soundPanel.back();
      else if (panel === 'recovery') actions.recoveryContinue();
      else if (panel === 'hangar') hangar.back();
      else if (panel === 'fabricator') fabricator.back();
      else if (panel === 'missions') missionsPanel.back();
      else if (panel === 'exchange') exchangePanel.back();
      else if (panel === 'upgrades') upgradesPanel.back();
      else if (panel === 'record') recordPanel.back();
      else if (panel === 'pause' || panel === 'sectormap' || panel === 'cargo') actions.resume();
      else if (panel === 'gate') actions.stay();
      else if (panel === 'controls') actions.closeControls();
      else if (panel === 'briefing' && c === 'back') actions.openMap();
    } else if (c === 'map' && panel === 'sectormap') actions.resume();
    else if (c === 'cargo' && panel === 'cargo') actions.resume();
    else if (c === 'restart' && (panel === 'pause' || panel === 'complete')) actions.restart();
  };
  const flightCommand = (c: FlightCommand): void => {
    if (panel || run?.phase !== 'flight') return;
    if (c === 'pause' || c === 'back') actions.pause();
    else if (c === 'interact') actions.interact();
    else if (c === 'map') actions.sectorMap();
    else if (c === 'cargo') actions.cargo();
    else if (c === 'zoomIn') actions.zoom(1);
    else if (c === 'zoomOut') actions.zoom(-1);
  };
  /** HUD buttons: same rules as the keys. */
  const hudCommand = (c: FlightCommand): void => {
    if (panel === 'sectormap' && c === 'map') actions.resume();
    else if (panel === 'cargo' && c === 'cargo') actions.resume();
    else flightCommand(c);
  };

  /* ------------------------------- controls -------------------------------- */
  const setControls = (c: Partial<FlightControls>): void => {
    controls = { ...controls, ...c };
    if (c.bindings) keys.setCodes(allCodes(controls.bindings));
    if (prefsWritable && !saveFreeRoamPrefs(services.store, { controls })) services.reportStorageProblem('write-failed');
    if (zoomLabel) zoomLabel.textContent = `ZOOM ${Math.round(controls.zoom * 100)}%`;
  };
  const refreshControls = (message: string): void => {
    const b = controls.bindings;
    for (const btn of controlsGrid.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
      const a = btn.dataset['action'] as FlightAction;
      const slot = Number(btn.dataset['slot']) as 0 | 1;
      const waiting = capture?.action === a && capture.slot === slot;
      btn.textContent = waiting ? 'PRESS A KEY' : keyLabel(b[a][slot]);
      btn.classList.toggle('is-capturing', waiting);
      btn.setAttribute('aria-label', `${ACTION_LABEL[a]} key ${slot + 1}: ${waiting ? 'waiting for a key' : b[a][slot] ? keyLabel(b[a][slot]) : 'none'}`);
    }
    mouseAimBtn.textContent = `MOUSE AIM: ${controls.mouseAim ? 'ON' : 'OFF'}`;
    mouseAimBtn.setAttribute('aria-pressed', String(controls.mouseAim));
    zoomLabel.textContent = `ZOOM ${Math.round(controls.zoom * 100)}%`;
    controlsStatus.textContent = message || 'Select a key to change it. ESC cancels; BACKSPACE clears a second key. Menus always use the arrows, ENTER and ESC.';
  };
  /** Capture-phase keydown while a binding slot waits: the key never reaches flight or menus. */
  const onCaptureKey = (e: KeyboardEvent): void => {
    if (!capture) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    const { action, slot } = capture;
    const btn = controlsGrid.querySelector<HTMLButtonElement>(`button[data-action="${action}"][data-slot="${slot}"]`);
    capture = null;
    if (e.code === RESERVED_KEYS.back) {
      refreshControls('Cancelled.');
    } else if (e.code === 'Backspace' || e.code === 'Delete') {
      const r = clearBinding(controls.bindings, action, slot);
      if (r.ok) {
        setControls({ bindings: r.bindings });
        refreshControls(`${ACTION_LABEL[action]}: second key cleared.`);
      } else refreshControls(`${ACTION_LABEL[action]} needs at least one key.`);
    } else {
      const r = rebind(controls.bindings, action, slot, e.code);
      if (r.ok) {
        setControls({ bindings: r.bindings });
        services.sound.play('uiSelect');
        refreshControls(`${ACTION_LABEL[action]}: ${keyLabel(e.code)}.${r.displaced ? ` ${ACTION_LABEL[r.displaced]} now uses ${actionKeys(r.bindings, r.displaced)}.` : ''}`);
      } else refreshControls(r.reason === 'not-bindable' ? `${keyLabel(e.code)} cannot be bound.` : `${ACTION_LABEL[action]} needs at least one key.`);
    }
    keys.clear(); // the bound key is not also a press
    btn?.focus();
  };
  const drawMapCanvas = (): void => {
    if (!run) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(mapCanvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(mapCanvas.clientHeight * ratio));
    const key = `${w}x${h}|${run.layout.systemId}|${services.prefs.revision}|${run.revealed.size}|${run.tick}`;
    if (key === mapCanvasKey) return;
    mapCanvasKey = key;
    if (mapCanvas.width !== w) mapCanvas.width = w;
    if (mapCanvas.height !== h) mapCanvas.height = h;
    const c2 = mapCanvas.getContext('2d');
    if (c2) drawSectorMap(c2, w, h, run, ratio);
  };
  /** Rotation or a hidden page: release every input so nothing stays held, and pause flight. */
  const interrupt = (why: 'orientation' | 'event' | 'host'): void => {
    keys.clear();
    pointers.reset(true);
    pad.reset();
    wheelAcc = 0;
    clock.resetTiming();
    if (why === 'orientation') status.orientationChanges += 1;
    if (run?.phase === 'flight') actions.pause();
  };

  /* ------------------------------ flight HUD ------------------------------- */
  /** Reactor cells short of any jump from here (the existing emergency rule; memoised). */
  const cellsShort = (r: SectorRun): boolean => {
    const key = `${held()}|${r.layout.systemId}|${craft.stats.travel}|${progress.charted.length}|${progress.visitedSystems.length}`;
    if (cellsShortCache?.key !== key) {
      const sv = deriveSystemView(deriveView(graph, progress), galaxyOf(r.layout.systemId) as GalaxyId);
      cellsShortCache = { key, short: emergencyCells(held(), sv.graph, r.layout.systemId, craft.stats.travel, false) > 0 };
    }
    return cellsShortCache.short;
  };
  const weaponName = (): string => {
    const id = loadoutOf(fleet, fleet.active).weapon[0] ?? '';
    if (weaponCache?.key !== id) weaponCache = { key: id, name: EQUIPMENT_BY_ID.get(id)?.name ?? 'Weapon' };
    return weaponCache.name;
  };
  /** Revealed, unfinished points of interest (the survey marks have the objective arrow). */
  const nearbyCandidates = (r: SectorRun): PoiCandidate[] => {
    const out: PoiCandidate[] = [];
    for (const p of r.layout.pois) {
      if (p.kind === 'survey' || !r.revealed.has(p.id) || isDone(r, p)) continue;
      out.push({ id: p.id, label: p.kind === 'gate' ? r.gates[p.id]?.label ?? p.label : p.label, x: p.x, y: p.y });
    }
    return out;
  };
  const renderHud = (r: SectorRun, ts: number, live: boolean, thrust: number, firing: boolean): void => {
    const cap = holdCap();
    const used = cap - holdFree();
    const cells = held();
    attention = stepAttention(attention, status.ticks, { cargo: `${used}|${cells}`, objective: tracked?.text ?? '', sector: `${r.layout.systemId}|${sectorEntries}` });
    const focus = !panel && r.phase === 'flight' && r.focus !== null;
    const view = hudView(
      {
        tick: status.ticks,
        level: hudModel?.level ?? 'calm',
        hull: r.hull,
        hullMax: r.craft.stats.hull,
        shield: r.shield,
        shieldMax: r.craft.stats.shield,
        holdUsed: used,
        holdCap: cap,
        cellsShort: cellsShort(r),
        hasObjective: tracked !== null,
        focus,
        nearby: r.phase === 'flight' ? nearestPoi(r.ship, nearbyCandidates(r)) : null,
      },
      attention,
    );
    flightHud.render({
      card: shipCard({ ship: SHIP_BY_ID.get(r.craft.ship)!.name, weapon: weaponName(), firing, docked: r.docked !== null, shield: r.shield, shieldMax: r.craft.stats.shield, hull: r.hull, hullMax: r.craft.stats.hull, energy: r.energy, energyMax: r.craft.stats.energy, boosting: r.boosting, heat: r.heat, overheated: r.overheated, missile: { state: r.missile.state, lock: r.missile.lock, lockTicks: MISSILE.lockTicks, cooldown: r.missile.cooldown, cooldownTicks: MISSILE.cooldownTicks, inFlight: r.missiles.length > 0, notice: r.missile.notice } }),
      location: { name: hereName, galaxy: galaxyShort, survey: surveyText(r), surveyed: r.surveyed },
      view,
      objective: tracked?.text ?? null,
      objectiveHere: tracked?.here ?? false,
      cargo: cargoText(used, cap, cells),
      notice: panel ? null : notices.current,
    });
    // the engine hum follows thrust and boost; silent while paused, behind a panel or hidden
    if (services.sound.unlocked && services.sound.loopLevel(ENGINE_LOOP) === null) services.sound.startLoop(ENGINE_LOOP, 'fr.engine', 0);
    services.sound.setLoopGain(ENGINE_LOOP, engineLevel({ live, thrust, boost: r.boost }));
    if (arrivalMs !== null && ts - arrivalMs > 1000) arrivalMs = null;
  };

  /* ---------------------------------- loop --------------------------------- */
  let lastTs: number | null = null;
  let lastKey = '';
  const frame = (ts: number): void => {
    const frameStart = performance.now();
    const { snapshot, update } = pad.poll(ts);
    if (armedNode && arming.ready(performance.now())) {
      delete armedNode.dataset['arming'];
      armedNode = null;
    }
    const motionMode = reducedMotion() ? 'reduced' : 'full';
    if (container.dataset['motion'] !== motionMode) container.dataset['motion'] = motionMode;
    if (saves.isOpen()) {
      // the save slots panel is modal over any screen: it takes every press; the flight stays paused
      for (const c of panelKeyCommands(keys.takePresses(), controls.bindings)) savesCommand(c);
      for (const c of panelPadCommands(update)) savesCommand(c);
      status.frames += 1;
      lastTs = ts;
      surface?.sample(ts, 0, false); // TD-79: no flight frame drawn, not a performance sample
      return;
    }
    if (screen === 'map' || screen === 'systems') {
      // a command may switch screens: route each one to whichever map is showing now
      const active = (): { command(c: MapCommand): void } | null => (screen === 'map' ? map : screen === 'systems' ? systems : null);
      for (const c of mapKeyCommands(keys.takePresses())) active()?.command(c);
      for (const c of mapPadCommands(update)) active()?.command(c);
      status.frames += 1;
      lastTs = ts;
      if (screen === 'map') map.frame(ts);
      else if (screen === 'systems') systems.frame(ts);
      surface?.sample(ts, 0, false); // TD-79: no flight frame drawn, not a performance sample
      return;
    }
    lastFrameTs = ts;
    const binds = controls.bindings;
    // each press goes to whichever context is active when it is handled (a command may open a panel)
    for (const code of keys.takePresses()) {
      if (panel) for (const c of panelKeyCommands([code], binds)) panelCommand(c);
      else if (__GALAXIA_GRAVITY_LAB__ && lab?.drawerOpen) lab.drawerKey(code); // the lab drawer takes every press while open
      else if (__GALAXIA_GRAVITY_LAB__ && lab?.key(code, binds)) continue;
      else {
        const offerKey = run?.offer && run.phase === 'flight' && flightKeyCommands([code], binds).length === 0 && !Object.values(binds).some((k) => k.includes(code));
        if (offerKey && code === OFFER_KEYS.take) offerActions.take();
        else if (offerKey && code === OFFER_KEYS.swap) offerActions.swap();
        else if (offerKey && code === OFFER_KEYS.leave) offerActions.leave();
        else for (const c of flightKeyCommands([code], binds)) flightCommand(c);
        if (run?.phase === 'flight' && (binds.missile[0] === code || binds.missile[1] === code)) missilePending = true; // a tap shorter than a frame still counts
      }
    }
    if (panel) for (const c of panelPadCommands(update)) panelCommand(c);
    else for (const c of flightPadCommands(update)) flightCommand(c);
    if (!panel) {
      const nt = tickNotices(notices, ts, combatBusy());
      notices = nt.state;
      toLog(nt.toLog);
    }
    feed.tick(ts);
    const r = run;
    if (!r || !art) {
      status.frames += 1;
      lastTs = ts;
      surface?.sample(ts, 0, false); // TD-79: no flight frame drawn, not a performance sample
      return;
    }
    const st = stick.state();
    const pv = pointers.snapshot();
    const live = !panel && r.phase === 'flight';
    const move = combineFlight(keyboardVector(keys.heldCodes, binds), padVector(snapshot), live ? pv.stick : { x: 0, y: 0 });
    // aim: right stick first, then the mouse cursor (mouse aim on), else none (nose follows travel)
    let aim: { x: number; y: number } | null = live ? padAim(snapshot) : null;
    let aimPoint: { x: number; y: number } | null = null;
    if (live && !aim && controls.mouseAim && pv.cursor) {
      const rect = surface.canvas.getBoundingClientRect();
      const d = clientToDevice(pv.cursor.x, pv.cursor.y, rect, viewRatio);
      aimPoint = screenToWorld(view, d.x, d.y);
      const dx = aimPoint.x - r.ship.x;
      const dy = aimPoint.y - r.ship.y;
      if (Math.hypot(dx, dy) > 8) aim = { x: dx, y: dy };
    }
    const fire = live && (keyboardFire(keys.heldCodes, binds) || padFire(snapshot) || pointers.firing);
    const boost = live && (keyboardBoost(keys.heldCodes, binds) || padBoost(snapshot) || pointers.boosting);
    // missile (Combat P03): held state for the simulation's press edge, plus a latched press so a quick tap is
    // never lost on a frame that runs no tick; nothing is latched behind a panel or outside flight
    const padM = padMissile(snapshot);
    if (pointers.takeMissilePress() && live) missilePending = true;
    if (padM && !padMissileWas && live) missilePending = true;
    padMissileWas = padM;
    if (!live) missilePending = false;
    const missile = live && (keyboardMissile(keys.heldCodes, binds) || padM || pointers.missileHeld);
    let flight: SectorInput = aim ? { ...move, aimX: aim.x, aimY: aim.y, fire, boost, missile } : { ...move, fire, boost, missile };
    if (__GALAXIA_GRAVITY_LAB__ && lab) {
      // FR-TD-83: rotate-and-thrust in the gravity test only (the same keys, pad and joystick, mapped there)
      const kv = keyboardVector(keys.heldCodes, binds);
      const pv2 = padVector(snapshot);
      const tv = live ? pv.stick : { x: 0, y: 0 };
      const sx = pv2.x + tv.x;
      const sy = pv2.y + tv.y;
      const sl = Math.hypot(sx, sy);
      flight = { ...lab.input({ keys: kv, stick: sl > 1 ? { x: sx / sl, y: sy / sl } : { x: sx, y: sy }, aim, fire, boost }, live), missile };
    }
    lastInput = { moveX: move.moveX, moveY: move.moveY, aim, fire, boost, missile, stickActive: pv.stickActive, fireTouches: pv.fireTouches, boostTouches: pv.boostTouches, missileTouches: pv.missileTouches, mouseFire: pv.mouseFire, keys: [...keys.heldCodes] };
    fireBtn.classList.toggle('is-active', pv.fireTouches > 0);
    paintFireHeat(r.heat, r.overheated);
    boostBtn.classList.toggle('is-active', pv.boostTouches > 0);
    paintMissileBtn(r, pv.missileTouches);
    let events: SectorEvent[] = [];
    batchShield = r.shield;
    const alpha = clock.advance(ts, () => {
      if (r.phase !== 'flight' || run !== r) return;
      const f = missilePending && !flight.missile ? { ...flight, missile: true } : flight;
      missilePending = false;
      events = events.concat(stepSector(r, f));
      status.ticks += 1;
    });
    if (events.length > 0) handleEvents(r, events);
    if (run !== r || !art) return; // an event left the sector (exit beacon)
    // Prompt 13: a timed autosave every AUTOSAVE_SECONDS of flight (with a safe resume point), so an
    // unexpected reload loses at most that much; milestones save on their own as before
    if (r.phase === 'flight' && r.tick - lastAutosaveTick >= AUTOSAVE_SECONDS * 60) {
      lastAutosaveTick = r.tick;
      persist();
    }
    const realDt = lastTs === null ? 0 : Math.min(Math.max(0, ts - lastTs), ENGINE.maxFrameMs) / 1000;
    lastTs = ts;
    status.frames += 1;

    const b = surface.fit();
    const reduced = reducedMotion();
    const moving = r.phase === 'flight';
    // combat framing: ease out while engaged so attackers at stand-off range stay on screen (presentation only)
    if (moving) framing = stepFraming(framing, hudModel?.level === 'engaged', realDt, reduced);
    const zoom = cameraZoom(b.width, b.height, controls.zoom) * framing;
    // the camera reads the ship and never writes it (camera.ts): physics is identical at any zoom or canvas size
    if (moving) stepCamera(cam, r.ship.x, r.ship.y, r.ship.vx, r.ship.vy, realDt, reduced);
    clampCamera(cam, b.width / zoom, b.height / zoom, r.layout.width, r.layout.height);
    view = cameraView(cam, zoom, b.width, b.height);
    // overheat rattle (FR-TD-79): a few device px of jitter fading over SHAKE.ms; presentation only, never with reduced motion
    if (shakeStart !== null) {
      const age = ts - shakeStart;
      if (age >= SHAKE.ms || reduced) shakeStart = null;
      else {
        const amp = (SHAKE.px * b.ratio * (1 - age / SHAKE.ms)) / zoom;
        view = cameraView({ x: cam.x + (Math.random() * 2 - 1) * amp, y: cam.y + (Math.random() * 2 - 1) * amp }, zoom, b.width, b.height);
      }
    }
    viewRatio = b.ratio;
    while (bursts.length > 0 && ts - bursts[0]!.startMs > BURST_MS) bursts.shift();
    while (wrecks.length > 0 && ts - wrecks[0]!.startMs > WRECK_MS) wrecks.shift();
    if (panel === 'sectormap') drawMapCanvas();

    // panels over a still scene: redraw only when something visible changed (no busy redraw while paused)
    const drawKey = `${b.width}x${b.height}|${r.phase}|${services.prefs.revision}|${panel}|${r.layout.systemId}|${zoom}|${r.pickups.length}|${r.offer?.id ?? ''}`;
    if (moving || drawKey !== lastKey || (st.active && !panel) || bursts.length > 0 || wrecks.length > 0) {
      lastKey = drawKey;
      const rect = surface.canvas.getBoundingClientRect();
      const ratio = b.ratio;
      drawSector(surface.ctx, services.sprites, art, r, view, {
        alpha: moving ? alpha : 1,
        timeMs: ts,
        glow: services.prefs.get().display.glow,
        reducedMotion: reduced,
        ratio,
        stick: st.active && !panel ? { active: true, x: (st.originX - rect.left) * ratio, y: (st.originY - rect.top) * ratio, vx: st.vector.x, vy: st.vector.y, radius: stick.radius * ratio } : null,
        aim: live ? aimPoint : null,
        bursts,
        wrecks,
        arrivalMs,
      });
      if (__GALAXIA_GRAVITY_LAB__ && lab) lab.draw(surface.ctx, view, { alpha: moving ? alpha : 1, ratio, reducedMotion: reduced });
      status.draws += 1;
    }
    if (__GALAXIA_GRAVITY_LAB__ && lab) lab.frame(panel !== null);
    hudModel = combatHud(r);
    combatView.render(panel ? null : hudModel);
    renderHud(r, ts, live && !document.hidden, Math.hypot(move.moveX, move.moveY), fire);
    const focus = !panel && r.phase === 'flight' && r.focus ? r.layout.pois.find((p) => p.id === r.focus) : undefined;
    const prompt = focus ? `${POI_RULES[focus.kind].verb.toUpperCase()} · ${(focus.kind === 'gate' ? r.gates[focus.id]?.label ?? focus.label : focus.label).toUpperCase()}` : '';
    if (interactBtn.textContent !== prompt) interactBtn.textContent = prompt;
    if (interactBtn.hidden !== !focus) interactBtn.hidden = !focus;
    // the full-hold choice: low and small, never over the centre of the action
    const o = !panel && r.phase === 'flight' ? r.offer : null;
    const k = binds.interact[0] ? keyLabel(binds.interact[0]) : '';
    offerView.render(o, o ? planSwap(profile.cargo, o.loot, holdCap()) !== null : false, { take: k ? `${k} / 1` : '1', swap: '2', leave: '3' }, offerText);
    // TD-79: adaptive render resolution samples live flight only (paused, panels and hidden tabs excluded)
    surface.sample(ts, performance.now() - frameStart, moving && !panel);
  };

  return {
    id: 'freeroam',
    init() {
      // Prompt 13: the slot in use; the shared Free Roam prefs load first, so a pre-slot
      // profile's controls are carried over before slot 1 is migrated
      saveSlotNo = activeSlot(services.store);
      const fp = loadFreeRoamPrefs(services.store);
      controls = fp.data.controls;
      prefsWritable = fp.writable;
      const loaded = loadSlot(services.store, saveSlotNo);
      const loadNotes: string[] = [];
      if (loaded.status === 'corrupt') {
        services.reportStorageProblem('corrupt-reset');
        loadNotes.push(`Slot ${saveSlotNo} could not be read and starts fresh; the damaged data was kept as a backup copy.`);
      } else if (loaded.status === 'future-version') {
        services.reportStorageProblem('future-version');
        loadNotes.push(`Slot ${saveSlotNo} was saved by a newer version: it is played read-only and never overwritten.`);
      }
      if (loaded.backupFailed) {
        services.reportStorageProblem('backup-failed');
        loadNotes.push(`Slot ${saveSlotNo} needed repair but no backup copy could be made: it is left untouched and progress is not saved.`);
      }
      writable = loaded.writable;
      graph = buildNavGraph();
      // ids checked against this build's game data; anything removed is backed up first (raw copy)
      const audit = auditProfile(graph, loaded.data);
      if (audit.changed > 0) {
        if (writable && loaded.backups.length === 0) {
          const raw = services.store.read(slotKey(saveSlotNo));
          if (raw !== null && !services.store.write(backupKey(slotKey(saveSlotNo)), raw)) {
            writable = false; // no copy: never overwrite the original
            services.reportStorageProblem('backup-failed');
          }
        }
        loadNotes.push(auditText(audit));
      }
      progress = progressFromSaved(graph, audit.profile);
      profile = withNavigation(startSession(audit.profile, Date.now()), progress);
      pendingResume = profile.resume;
      for (const n of loadNotes) heldNotes.push(`warn|${n}`);
      loadMessage = loadNotes.join(' ');
      prog = progressionFromSaved(profile.progression);
      // the record also knows places reached before Prompt 11 (log only: no mission counts them)
      for (const g of progress.visited) prog = { ...prog, log: recordEvent(prog.log, { type: 'galaxy-reached', galaxyId: g, first: false }, graph) };
      for (const id of progress.visitedSystems) prog = { ...prog, log: recordEvent(prog.log, { type: 'system-visited', systemId: id, galaxyId: galaxyOf(id), first: false }, graph) };
      scope.add(bus.subscribe(onGameEvent)); // released with the mode
      // the saved fleet against the roster: unknown ships and invalid loadouts fall back (starter / stock)
      setFleet(fleetFromSaved(profile.fleet));
      // Prompt 11: one-time starter reactor cells (as many as fit)
      if (!prog.fuel.starter) {
        profile = withCargo(profile, grantCells(profile.cargo, holdCap(), FUEL.starterCells).hold);
        prog = { ...prog, fuel: { ...prog.fuel, starter: true } };
      }
      saveProg();
      persist();

      // the shared viewport owner (same as Classic, TD-72): container, safe areas, resize, orientation
      shell = new AppShell(container, scope, 'freeroam-app');
      container.dataset['panel'] = 'none';
      container.dataset['screen'] = 'map';
      flightRoot = el('div', 'fr-flight');
      flightRoot.hidden = true;
      const stage = el('div', 'fr-stage mode-stage');
      flightRoot.append(stage);
      container.append(flightRoot);
      surface = new CanvasSurface(stage, scope, 'Free Roam local sector: stars, bodies, asteroid fields, points of interest and jump gates', 'fr-canvas mode-canvas', { adaptive: true });
      // a rotation (aspect flip of the shell) releases input and pauses flight; counted once per flip
      shell.onChange((c) => {
        if (c.rotated) interrupt('orientation');
      });

      // HUD (Prompt 12: contextual; ui/flightHud.ts renders it, the shell owns the buttons)
      motion = createMotion({ animate: browserAnimate(), reduced: reducedMotion });
      for (const [id, recipe] of Object.entries(FR_SOUNDS)) services.sound.define(id as FrSoundId, recipe);
      const hud = el('div', 'fr-hud');
      const hudBtn = (cls: string, text: string, aria: string, c: FlightCommand): HTMLButtonElement => {
        const btn = el('button', `fr-hudbtn ${cls}`, text);
        btn.type = 'button';
        btn.setAttribute('aria-label', aria);
        btn.addEventListener('click', () => {
          hudCommand(c);
          btn.blur(); // keep Space / Enter for flight
        });
        return btn;
      };
      const buttons = el('div', 'fr-hud-buttons');
      hudButtons = buttons;
      buttons.append(hudBtn('fr-hud-map', 'MAP', 'Sector map', 'map'), hudBtn('fr-hud-cargo', 'CARGO', 'Cargo hold', 'cargo'), hudBtn('fr-pause', 'II', 'Pause', 'pause'));
      hud.append(buttons);
      const hint = el('p', 'fr-hint');
      hintKeys = el('span', 'fr-hint-keys', '');
      hint.append(hintKeys, el('span', 'fr-hint-touch', 'DRAG TO FLY · HOLD FIRE TO SHOOT · HOLD BOOST'));
      fireBtn = el('button', 'fr-fire', 'FIRE');
      fireBtn.type = 'button';
      fireBtn.setAttribute('aria-label', 'Fire (hold)');
      boostBtn = el('button', 'fr-boost', 'BOOST');
      boostBtn.type = 'button';
      boostBtn.setAttribute('aria-label', 'Boost (hold while flying)');
      missileBtn = el('button', 'fr-missile', 'MSL');
      missileBtn.type = 'button';
      missileBtn.setAttribute('aria-label', 'Missile: press to lock the ship ahead and launch');
      interactBtn = el('button', 'fr-interact');
      interactBtn.type = 'button';
      interactBtn.hidden = true;
      interactBtn.addEventListener('click', () => {
        actions.interact();
        interactBtn.blur(); // keep Space / Enter for flight
      });

      // panels
      menus = {} as Record<Exclude<Panel, null>, MenuList>;
      hangar = createHangarPanel({
        sprites: services.sprites,
        fleet: () => fleet,
        cargo: () => profile.cargo,
        licenceMet: (req) => deriveView(graph, progress).requirementMet(req),
        describe: (req) => describeRequirement(deriveView(graph, progress), req),
        safe: () => run !== null && canSwitchShip(run),
        commitAcquire: (f, cargo) => {
          setFleet(f);
          profile = withCargo(profile, cargo);
          if (run) run.cargoSpace = holdFree();
          save();
        },
        commitSelect: (f) => {
          setFleet(f);
          if (run) {
            applyShip(run, craft);
            run.cargoSpace = holdFree();
            lastKey = '';
          }
          save();
        },
        launch: () => actions.launch(),
        back: () => openStation('station'),
        sound: panelSound,
        glow: () => services.prefs.get().display.glow,
      });
      briefingStats = el('p', 'fr-stats');
      briefingTarget = el('p', 'fr-text');
      completeTime = el('p', 'fr-result');
      completeBest = el('p', 'fr-best');
      completeCharted = el('p', 'fr-text fr-charted');
      completeNews = el('p', 'fr-news');
      completeCargo = el('p', 'fr-text fr-text-dim');
      briefingSector = el('p', 'fr-stats fr-sector-line');
      briefingNote = el('p', 'fr-text fr-text-dim fr-sim-note');
      gateText = el('p', 'fr-text');
      inventory = createInventoryPanel({
        cargo: () => profile.cargo,
        capacity: () => holdCap(),
        shipName: () => shipName(),
        modules: () => profile.modules,
        jettison: (res) => jettisonStack(res),
        resume: () => actions.resume(),
        sound: (cue) => services.sound.play(cue),
      });
      fabricator = createFabricatorPanel({
        cargo: () => profile.cargo,
        modules: () => profile.modules,
        capacity: () => holdCap(),
        ship: () => SHIP_BY_ID.get(fleet.active)!,
        loadout: () => loadoutOf(fleet, fleet.active),
        progress: () => ({ surveys: profile.surveysCompleted, charted: profile.chartedSystems.length, galaxies: profile.visitedGalaxies.length }),
        claimed: () => profile.milestones,
        commitFabricate: (h, m) => {
          profile = withModules(withCargo(profile, h), m);
          if (run) run.cargoSpace = holdFree();
          save();
        },
        commitClaim: (id, h) => {
          profile = withMilestone(withCargo(profile, h), id);
          if (run) run.cargoSpace = holdFree();
          save();
        },
        back: () => openStation('station'),
        launch: () => actions.launch(),
        equipment: () => openStation('equipment'),
        sound: panelSound,
      });
      equipment = createEquipmentPanel({
        ship: () => SHIP_BY_ID.get(fleet.active)!,
        loadout: () => loadoutOf(fleet, fleet.active),
        modules: () => profile.modules,
        cargo: () => profile.cargo,
        stats: () => craft.stats,
        // the same commit the fabricator used before Prompt 12
        commitFit: (lo, m) => {
          setFleet({ ...fleet, loadouts: { ...fleet.loadouts, [fleet.active]: lo } });
          profile = withModules(profile, m);
          if (run) {
            applyShip(run, craft);
            run.cargoSpace = holdFree();
            lastKey = '';
          }
          save();
        },
        back: () => openStation('station'),
        sound: panelSound,
        installed: (row) => {
          moment('upgrade');
          motion.play(row, 'pop');
          motion.play(row, 'flash', { channel: 'flash' });
        },
      });
      stationHub = createStationPanel({
        summary: () => {
          const at = dockedAt();
          const board = at ? stationBoard(prog.missions, at, missionWorld()) : null;
          return {
            name: dockLabel,
            first: dockFirst,
            ship: shipName(),
            cells: held(),
            emergency: dockEmergency,
            marks: prog.marks,
            ready: prog.missions.completed.length,
            active: prog.missions.active.length,
            offers: board ? board.offers.length : 0,
            stored: Object.values(profile.modules).reduce((a, n) => a + n, 0),
          };
        },
        open: (tab) => openStation(tab),
        launch: () => actions.launch(),
        sound: panelSound,
      });
      recovery = createRecoveryPanel({ resume: () => actions.recoveryContinue(), sectorMap: () => actions.recoveryMap(), sound: panelSound });
      soundPanel = createSoundPanel({
        get: () => services.prefs.get().audio,
        set: (change) => {
          services.prefs.setAudio(change); // shared galaxia:prefs (Classic shows the same settings)
          services.sound.setPrefs(services.prefs.get().audio);
        },
        preview: (bus: VolumeBus) => sfx(bus === 'music' ? 'fr.clear' : 'fr.collect'),
        back: () => actions.closeSound(),
        sound: panelSound,
        fullscreen: { supported: () => fullscreenSupported(), on: () => isFullscreen(), toggle: () => void setFullscreen(!isFullscreen()) },
      });
      onFullscreenChange(scope, () => soundPanel.syncFullscreen());
      const sound3 = panelSound;
      missionsPanel = createMissionsPanel({
        docked: dockedAt,
        stationName: () => dockLabel,
        model: () => {
          const at = dockedAt();
          const world = missionWorld();
          return missionsModel(prog.missions, prereqCtx(), world, galaxyName, profile.cargo, at, [...STORY_BY_ID.values()], at ? stationBoard(prog.missions, at, world) : null);
        },
        accept: acceptOffer,
        abandon: abandonOffer,
        claim: (id) => (dockedAt() ? claimMission(id) : { ok: false, text: 'Rewards are claimed while docked at a station.' }),
        deliver: deliverMission,
        back: () => actions.stationBack(),
        sound: sound3,
      });
      exchangePanel = createExchangePanel({
        station: () => ({ id: run?.layout.systemId ?? progress.system, name: dockLabel }),
        wallet,
        ship: () => SHIP_BY_ID.get(fleet.active)!,
        fleet: () => fleet,
        licenceMet: (req) => deriveView(graph, progress).requirementMet(req),
        condition: () => ({ hull: run ? run.hull : 0, hullMax: craft.stats.hull, shield: run ? run.shield : 0, shieldMax: craft.stats.shield }),
        emergency: emergencyDue,
        claimEmergency,
        commit: (w) => commitWallet(w),
        commitShip: (f, w) => {
          setFleet(f);
          commitWallet(w);
        },
        back: () => actions.stationBack(),
        sound: sound3,
      });
      upgradesPanel = createUpgradesPanel({
        station: () => dockLabel,
        ship: () => SHIP_BY_ID.get(fleet.active)!,
        loadout: () => loadoutOf(fleet, fleet.active),
        levels: () => levelsOf(fleet.active),
        licences: () => prog.licences,
        wallet,
        commit: (levels, w) => {
          prog = { ...prog, upgrades: { ...prog.upgrades, [fleet.active]: levels } };
          setFleet(fleet); // re-derive: the cargo track changes the hold before the wallet is applied
          if (run) {
            applyShip(run, craft);
            lastKey = '';
          }
          commitWallet(w);
        },
        back: () => actions.stationBack(),
        sound: sound3,
      });
      recordPanel = createRecordPanel({
        stats: () => {
          const view = deriveView(graph, progress);
          return explorationStats(prog.log, { visitedSystems: progress.visitedSystems.length, visitedGalaxies: progress.visited.length, routesOpen: graph.edges.filter((e) => view.routeOpen(e)).length, missionsCompleted: prog.missions.completed.length, charted: progress.charted.length });
        },
        entries: () => discoveryEntries(prog.log, graph),
        progressLine: () => `GUILD MARKS ${prog.marks} · MISSIONS DONE ${prog.missions.claimed.length} · LICENCES ${prog.licences.length ? prog.licences.map((l) => (l === 'mk2' ? 'MK II' : 'MK III')).join(' + ') : 'NONE'}`,
        back: () => actions.stationBack(),
        sound: sound3,
      });
      feed = createLootFeed(() => lastFrameTs);
      offerView = createOfferPrompt(offerActions);
      mapCanvas = el('canvas', 'fr-sectormap-canvas');
      mapCanvas.setAttribute('role', 'img');
      mapCanvas.setAttribute('aria-label', 'Map of the local sector with your ship, points of interest, gates and the exit beacon');
      controlsStatus = el('p', 'fr-text fr-text-dim fr-controls-status');
      controlsStatus.setAttribute('role', 'status');
      controlsGrid = el('div', 'fr-controls-grid');
      for (const a of FLIGHT_ACTIONS) {
        const row = el('div', 'fr-controls-row');
        row.append(el('span', 'fr-controls-action', ACTION_LABEL[a]));
        for (const slot of [0, 1] as const) {
          const btn = el('button', 'fr-btn fr-keybtn', '');
          btn.type = 'button';
          btn.dataset['action'] = a;
          btn.dataset['slot'] = String(slot);
          btn.addEventListener('click', () => {
            capture = { action: a, slot };
            keys.clear();
            refreshControls(`Press a key for ${ACTION_LABEL[a]} · ESC cancels${slot === 1 ? ' · BACKSPACE clears' : ''}.`);
          });
          row.append(btn);
        }
        controlsGrid.append(row);
      }
      panels = {
        briefing: buildPanel(
          'briefing',
          'LOCAL SECTOR',
          'FREE ROAM',
          [
            briefingSector,
            briefingTarget,
            el('p', 'fr-text fr-text-dim', 'Hostile contact drains your shield, then your hull; if the hull fails you are recalled to the arrival zone and repaired, and half your common cargo stays in a marked wreck where you fell. Warnings flash before heavy attacks, mines and eruptions. Your guns fire along the nose: destroying an installation\'s whole wave silences it early. Boost spends energy; dock at a station to repair and open the hangar.'),
            briefingNote,
            briefingStats,
          ],
          [
            ['START FLIGHT', actions.start],
            ['CONTROLS', actions.controls],
            ['SOUND', actions.sound],
            ['GALAXY MAP', actions.openMap],
          ],
        ),
        pause: buildPanel('pause', 'FREE ROAM', 'PAUSED', [(pauseInfo = el('p', 'fr-stats fr-pause-info'))], [
          ['RESUME', actions.resume],
          ['RESTART FLIGHT', actions.restart],
          ['MISSIONS', () => actions.log('missions')],
          ['RECORD', () => actions.log('record')],
          ['SAVES', openSaves],
          ['CONTROLS', actions.controls],
          ['SOUND', actions.sound],
          ['GALAXY MAP', actions.openMap],
          ['MAIN MENU', actions.exit],
        ]),
        sectormap: buildPanel('sectormap', 'LOCAL SECTOR', 'SECTOR MAP', [mapCanvas, el('p', 'fr-text fr-text-dim fr-map-legend', 'Arrow: your ship · dashed ring: sensor range · red: hostiles in range · coloured: points of interest found so far (all once surveyed) · grey: done. Paused while open.')], [
          ['RESUME', actions.resume],
          ['GALAXY MAP', actions.openMap],
        ]),
        cargo: inventory.root,
        hangar: hangar.root,
        fabricator: fabricator.root,
        missions: missionsPanel.root,
        exchange: exchangePanel.root,
        upgrades: upgradesPanel.root,
        record: recordPanel.root,
        station: stationHub.root,
        equipment: equipment.root,
        sound: soundPanel.root,
        recovery: recovery.root,
        controls: buildPanel('controls', 'FREE ROAM', 'CONTROLS', [controlsGrid, controlsStatus], [
          ['MOUSE AIM: OFF', () => {
            setControls({ mouseAim: !controls.mouseAim });
            refreshControls(controls.mouseAim ? 'Mouse aim on: the nose and shots follow the cursor; left button fires.' : 'Mouse aim off: the nose follows your direction of travel.');
          }],
          ['ZOOM −', () => {
            actions.zoom(-1);
            refreshControls('');
          }],
          ['ZOOM +', () => {
            actions.zoom(1);
            refreshControls('');
          }],
          ['RESET DEFAULTS', () => {
            setControls({ bindings: DEFAULT_BINDINGS, mouseAim: false, zoom: 1 });
            refreshControls('Controls reset to the defaults.');
          }],
          ['BACK', actions.closeControls],
        ]),
        complete: buildPanel('complete', 'LOCAL SECTOR', 'SURVEY COMPLETE', [completeTime, completeBest, completeCharted, completeNews, completeCargo], [
          ['CONTINUE FLIGHT', actions.resume],
          ['GALAXY MAP', actions.openMap],
        ]),
        gate: buildPanel('gate', 'JUMP GATE', 'GATE', [gateText], [
          ['JUMP', actions.jump],
          ['STAY', actions.stay],
        ]),
      };
      // the controls grid buttons join the panel's menu (MenuList reads buttons live)
      panels.controls.querySelector('.fr-menu')!.prepend(controlsGrid);
      menus.cargo = inventory.menu;
      menus.hangar = hangar.menu;
      menus.fabricator = fabricator.menu;
      menus.missions = missionsPanel.menu;
      menus.exchange = exchangePanel.menu;
      menus.upgrades = upgradesPanel.menu;
      menus.record = recordPanel.menu;
      menus.station = stationHub.menu;
      menus.equipment = equipment.menu;
      menus.sound = soundPanel.menu;
      menus.recovery = recovery.menu;
      pauseKicker = panels.pause.querySelector('.fr-kicker')!;
      mouseAimBtn = [...panels.controls.querySelectorAll<HTMLButtonElement>('.fr-menu > .fr-btn')].find((x) => x.textContent?.startsWith('MOUSE AIM'))!;
      const zoomRow = el('div', 'fr-controls-zoom');
      zoomLabel = el('span', 'fr-controls-action', 'ZOOM 100%');
      const zoomBtns = [...panels.controls.querySelectorAll<HTMLButtonElement>('.fr-menu > .fr-btn')].filter((x) => x.textContent?.startsWith('ZOOM'));
      zoomRow.append(zoomLabel, ...zoomBtns);
      mouseAimBtn.after(zoomRow);
      gateTitle = panels.gate.querySelector('.fr-title')!;
      gateJump = panels.gate.querySelector('.fr-btn')!;
      briefingKicker = panels.briefing.querySelector('.fr-kicker')!;
      briefingTitle = panels.briefing.querySelector('.fr-title')!;
      returnButtons = [];
      for (const pnl of Object.values(panels)) for (const b of pnl.querySelectorAll<HTMLButtonElement>('.fr-btn')) if (b.textContent === 'GALAXY MAP') returnButtons.push(b);
      const panelLayer = el('div', 'fr-panels');
      panelLayer.append(panels.briefing, panels.pause, panels.complete, panels.gate, panels.sectormap, panels.cargo, panels.controls, panels.hangar, panels.fabricator, panels.missions, panels.exchange, panels.upgrades, panels.record, panels.station, panels.equipment, panels.sound, panels.recovery);
      flightRoot.append(hud);
      flightHud = createFlightHud(flightRoot, motion);
      flightRoot.append(hint, interactBtn, fireBtn, boostBtn, missileBtn, feed.root, offerView.root);
      combatView = createCombatHud(flightRoot);
      // measured HUD stacking under the ship card (FR-TD-80; ui/hudStack.ts)
      stackFlightHud(scope, flightRoot, flightHud.card, feed.root);
      flightRoot.append(panelLayer);
      keys.setCodes(allCodes(controls.bindings));
      map = createGalaxyMap({
        scope,
        parent: container,
        graph,
        services,
        reducedMotion,
        progress: () => progress,
        travel: (to) => {
          const before = progress;
          const r = applyTravel(graph, progress, to);
          if (!r.ok) return r;
          const need = galaxyJumpCells(r.edge, craft.stats.travel);
          if (!burn(need)) return { ok: false, reason: 'fuel', need, have: held() };
          commitProgress(r.progress);
          arrived([r.progress.system], before, 1, [{ type: 'galaxy-reached', galaxyId: to, first: !before.visited.includes(to) }, ...routeEvents(r.newRoutes)]);
          persist();
          return r;
        },
        fuel: {
          held,
          jump: (edge) => galaxyJumpCells(edge, craft.stats.travel),
          homeDue,
          home: goHome,
        },
        startSurvey: () => actions.briefing('galaxy'),
        openSystems: actions.openSystems,
        exit: actions.exit,
      });
      systems = createSystemMap({
        scope,
        parent: container,
        graph,
        services,
        reducedMotion,
        progress: () => progress,
        travel: (to) => systemTravel(to, false),
        fuel: {
          held,
          hop: (cost) => hopCells(cost, craft.stats.travel),
          emergency: emergencyTarget,
          // R2 is free only to the target it offers; anything else is an ordinary (paid) route
          emergencyJump: (to) => {
            const r = systemTravel(to, emergencyTarget() === to);
            return r.ok || r.reason !== 'fuel' ? (r as SystemTravelResult) : applySystemTravel(graph, progress, progress.system);
          },
          missions: () => missionTargets(prog.missions),
          station: isStation,
        },
        startSurvey: () => actions.briefing('system'),
        back: actions.galaxyMap,
        travelFactor: () => ({ factor: craft.stats.travel, ship: shipName() }),
        // FR-TD-83: dev / QA builds only (the literal removes it from release builds); = gravity/config.ts LAB_SYSTEM_ID
        gravityTest: __GALAXIA_GRAVITY_LAB__ ? { systemId: 'milky-way/sol', enter: () => void enterGravityLab() } : undefined,
      });

      // Prompt 13: the save slots panel (modal over any screen) and its galaxy map button
      saves = createSavesPanel(savesDeps);
      container.append(saves.root);
      savesBtn = el('button', 'fr-map-back fr-saves-btn', 'SAVES');
      savesBtn.type = 'button';
      savesBtn.addEventListener('click', openSaves);
      map.head.classList.add('has-saves');
      map.head.append(savesBtn);
      refreshSavesBadge();

      // input: keys on window, touch stick on the canvas (window catches the release)
      // rebinding listens in the capture phase so the key never reaches the tracker or a menu
      scope.on<KeyboardEvent>(window, 'keydown', onCaptureKey, { capture: true });
      keys.attach(scope, window);
      if (anyPadConnected()) pad.reset(); // the A that chose Free Roam may still be held
      // pointers (FR-TD-44): each pointer id has one role; releasing one never cancels another
      scope.on<PointerEvent>(surface.canvas, 'pointerdown', (e) => {
        if (panel || run?.phase !== 'flight') return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.pointerType === 'mouse' && controls.mouseAim) {
          pointers.setCursor(e.clientX, e.clientY);
          pointers.setMouseFire(true);
          e.preventDefault();
          container.dataset['input'] = 'pointer';
          return;
        }
        if (pointers.stickDown(e.pointerId, e.clientX, e.clientY)) {
          e.preventDefault();
          container.dataset['input'] = e.pointerType === 'touch' ? 'touch' : 'pointer';
        }
      });
      scope.on<PointerEvent>(surface.canvas, 'pointermove', (e) => {
        if (e.pointerType === 'mouse') pointers.setCursor(e.clientX, e.clientY);
      });
      scope.on<PointerEvent>(surface.canvas, 'pointerleave', (e) => {
        if (e.pointerType === 'mouse') pointers.clearCursor();
      });
      scope.on<Event>(surface.canvas, 'contextmenu', (e) => e.preventDefault());
      scope.on<WheelEvent>(
        surface.canvas,
        'wheel',
        (e) => {
          if (panel || run?.phase !== 'flight') return;
          e.preventDefault();
          // accumulate so a trackpad's many small deltas make one step per notch-sized gesture
          wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
          if (Math.abs(wheelAcc) >= 60) {
            actions.zoom(wheelAcc < 0 ? 1 : -1);
            wheelAcc = 0;
          }
        },
        { passive: false },
      );
      scope.on<PointerEvent>(fireBtn, 'pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (panel || run?.phase !== 'flight') return;
        try {
          fireBtn.setPointerCapture(e.pointerId); // the finger may slide off the button and keep firing
        } catch {
          /* synthetic pointers cannot be captured; window pointerup still releases them */
        }
        pointers.fireDown(e.pointerId);
        container.dataset['input'] = e.pointerType === 'touch' ? 'touch' : 'pointer';
      });
      scope.on<PointerEvent>(fireBtn, 'lostpointercapture', (e) => pointers.release(e.pointerId));
      scope.on<Event>(fireBtn, 'contextmenu', (e) => e.preventDefault());
      scope.on<PointerEvent>(boostBtn, 'pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (panel || run?.phase !== 'flight') return;
        try {
          boostBtn.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointers cannot be captured; window pointerup still releases them */
        }
        pointers.boostDown(e.pointerId);
        container.dataset['input'] = e.pointerType === 'touch' ? 'touch' : 'pointer';
      });
      scope.on<PointerEvent>(boostBtn, 'lostpointercapture', (e) => pointers.release(e.pointerId));
      scope.on<Event>(boostBtn, 'contextmenu', (e) => e.preventDefault());
      scope.on<PointerEvent>(missileBtn, 'pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (panel || run?.phase !== 'flight') return;
        try {
          missileBtn.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic pointers cannot be captured; window pointerup still releases them */
        }
        pointers.missileDown(e.pointerId);
        container.dataset['input'] = e.pointerType === 'touch' ? 'touch' : 'pointer';
      });
      scope.on<PointerEvent>(missileBtn, 'lostpointercapture', (e) => pointers.release(e.pointerId));
      scope.on<Event>(missileBtn, 'contextmenu', (e) => e.preventDefault());
      scope.on<PointerEvent>(container, 'pointerdown', (e) => {
        container.dataset['input'] = e.pointerType === 'touch' ? 'touch' : 'pointer';
      });
      scope.on<PointerEvent>(window, 'pointermove', (e) => pointers.move(e.pointerId, e.clientX, e.clientY));
      const release = (e: PointerEvent): void => {
        pointers.release(e.pointerId);
        if (e.pointerType === 'mouse') pointers.setMouseFire(false);
      };
      scope.on<PointerEvent>(window, 'pointerup', release);
      scope.on<PointerEvent>(window, 'pointercancel', release);
      scope.on<KeyboardEvent>(window, 'keydown', (e) => {
        if (allCodes(controls.bindings).includes(e.code)) container.dataset['input'] = 'keyboard';
      });
      // rotation started (shared shell signal): release everything and pause; the shell counts the aspect flip
      shell.onRotateStart(() => {
        if (screen === 'flight') interrupt('event');
      });
      scope.on(window, 'pagehide', persist);
      scope.on(window, 'gamepaddisconnected', () => {
        pad.reset();
        if (run?.phase === 'flight') actions.pause();
      });
      refreshHint();

      status = {
        get state() {
          return run ?? idle;
        },
        sector: sectorStatus,
        profile: () => profile,
        panel: () => panel,
        screen: () => screen,
        progress: () => progress,
        map: () => map.status(),
        systems: () => systems.status(),
        mapReturn: () => mapReturn,
        input: () => lastInput,
        camera: () => {
          const rect = surface.canvas.getBoundingClientRect();
          return { ...view, framing, ratio: viewRatio, cssWidth: rect.width, cssHeight: rect.height, orientation: shell.orientation ?? 'landscape' };
        },
        viewport: () => shell.state(),
        controls: () => controls,
        saves: () => ({ ...saves.status(), slot: saveSlotNo, writable, persistent: services.store.persistent, lastSaveAt, lastSaveFailed, resume: profile.resume, resumedAt, badge: savesBtn.textContent }),
        fleet: () => fleet,
        craft: () => craft,
        hangar: () => hangar.status(),
        inventory: () => inventory.status(),
        fabricator: () => fabricator.status(),
        progression: () => prog,
        missions: () => missionsPanel.status(),
        exchange: () => exchangePanel.status(),
        upgrades: () => upgradesPanel.status(),
        record: () => recordPanel.status(),
        tracked: () => (tracked ? `◆ ${tracked.text}` : null),
        ui: () => ({
          hud: flightHud.status(),
          notice: notices.current ? noticeLine(notices.current) : null,
          queued: notices.queue.length,
          motion: { active: motion.active(), started: motion.started(), reduced: reducedMotion() },
          station: stationHub.status(),
          equipment: equipment.status(),
          recovery: recovery.status(),
          panelReady: arming.ready(performance.now()),
          panelDropped: arming.droppedCount,
          sound: services.sound.stats(),
          engine: services.sound.loopLevel(ENGINE_LOOP),
          audio: services.prefs.get().audio,
          overlays: Object.values(panels).filter((n) => !n.hidden).length,
        }),
        fuel: () => ({ held: held(), emergency: emergencyDue(), homeDue: homeDue(), emergencyJump: emergencyTarget() }),
        toWorld: (cx, cy) => {
          const d = clientToDevice(cx, cy, surface.canvas.getBoundingClientRect(), viewRatio);
          return screenToWorld(view, d.x, d.y);
        },
        toClient: (x, y) => {
          const rect = surface.canvas.getBoundingClientRect();
          const d = worldToScreen(view, x, y);
          return { x: rect.left + d.x / viewRatio, y: rect.top + d.y / viewRatio };
        },
        solids: (radius) => {
          if (!run) return [];
          const sh = run.ship;
          const near = (x: number, y: number, r: number): boolean => Math.hypot(x - sh.x, y - sh.y) < radius + r;
          return [
            ...run.layout.rocks.filter((k) => near(k.x, k.y, k.r)).map((k) => ({ kind: 'rock', x: k.x, y: k.y, r: k.r })),
            ...run.layout.landmarks.filter((l) => near(l.x, l.y, l.r)).map((l) => ({ kind: l.kind, x: l.x, y: l.y, r: l.r })),
          ];
        },
        lab: () => (__GALAXIA_GRAVITY_LAB__ && lab ? lab.status() : null),
        gravity: () =>
          run
            ? {
                ...run.gravity,
                wells: run.wells.map((w) => ({ id: w.id, kind: run!.layout.landmarks.find((l) => l.id === w.id)?.kind ?? '?', x: w.x, y: w.y, solid: w.solid, ref: w.ref, felt: w.felt, range: w.field.range })),
              }
            : null,
        orientationChanges: 0,
        renderScale: () => (surface.adaptive ? { ...surface.adaptive.stats, ratio: surface.backing.ratio, backing: `${surface.backing.width}x${surface.backing.height}` } : null),
        // Combat P03 QA: the body is compiled out of release builds (the flag is false there)
        qaSpawn: __GALAXIA_TEST_HOOKS__
          ? (family: FamilyId, dx: number, dy: number): number | null => {
              const r = run;
              if (!r || r.phase !== 'flight') return null;
              const a = spawnAgent(r, family, 'red-tally', 'qa-probe', 'guard', r.ship.x + dx, r.ship.y + dy);
              return a ? a.id : null;
            }
          : () => null,
        frames: 0,
        ticks: 0,
        draws: 0,
      };
      if (__GALAXIA_TEST_HOOKS__) window.__galaxiaFreeRoam = status;
      refreshBriefing();
      showScreen('map');
      lifecycle = 'initialized';
      // FR-TD-83: ?lab=gravity opens the Gravity Flight test directly (dev / QA builds only)
      if (__GALAXIA_GRAVITY_LAB__ && new URLSearchParams(window.location.search).get('lab') === 'gravity') void enterGravityLab();
    },
    activate() {
      if (lifecycle !== 'initialized') return;
      clock.resetTiming();
      scope.frameLoop((ts) => {
        try {
          frame(ts);
        } catch (err) {
          ctx.fail(`Free Roam stopped: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
        return true;
      });
      lifecycle = 'active';
    },
    pause(reason: PauseReason) {
      // blur, hidden tab or host pause: nothing may stay held (keys, stick, FIRE, mouse button)
      if (status) interrupt('host');
      // a hidden tab may be discarded without pagehide (mobile): save now (Prompt 13)
      if (reason === 'hidden' && lifecycle !== 'created' && lifecycle !== 'disposed') persist();
      if (lifecycle === 'active') lifecycle = 'paused';
    },
    resume() {
      // like Classic, the player resumes from the pause panel; only timing is reset here
      clock.resetTiming();
      if (lifecycle === 'paused') lifecycle = 'active';
    },
    dispose() {
      if (lifecycle === 'disposed') return;
      const wasInitialized = lifecycle !== 'created';
      lifecycle = 'disposed';
      if (wasInitialized) leaveSector(); // flight time of an unfinished visit still counts; temporary entities go
      if (wasInitialized) persist();
      services.sound.stopLoops();
      if (motion) motion.cancelAll(); // no UI animation outlives the mode
      scope.dispose(); // listeners, frame loop, ResizeObserver, canvas memory
      keys.clear();
      pointers.reset(true);
      bursts.length = 0;
      wrecks.length = 0;
      if (__GALAXIA_TEST_HOOKS__ && window.__galaxiaFreeRoam === status) delete window.__galaxiaFreeRoam;
      container.replaceChildren(); // html.game-mode and the shell's observer went with scope.dispose()
    },
    debug(): ModeDebug {
      return { lifecycle, listeners: scope.activeListeners, loops: scope.activeLoops, phase: run?.phase ?? 'none', panel, screen };
    },
  };
}
