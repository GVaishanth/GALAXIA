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
import { cameraView, cameraZoom, clampCamera, clientToDevice, easeZoom, screenToWorld, snapCamera, stepCamera, stepFraming, stepZoom, wheelZoom, worldToScreen, type CameraState, type CameraView } from './camera.ts';
import { SIMULATION_NOTE } from './catalogue/index.ts';
import { createGalaxyMap, type GalaxyMapScreen, type MapStatus } from './galaxy/galaxyMapScreen.ts';
import { buildNavGraph, type NavGraph } from './galaxy/graph.ts';
import { applySurvey, applyTravel, deriveView, describeRequirement, progressDiff, progressFromSaved, type ExplorationProgress, type SurveyResult } from './galaxy/progress.ts';
import { createSystemMap, type FuelRefusal, type SystemMapScreen, type SystemMapStatus } from './galaxy/systemMapScreen.ts';
import { applySystemTravel, deriveSystemView, HAZARD_LABEL, systemGraph, type SystemTravelResult } from './galaxy/systems.ts';
import { combineFlight, flightKeyCommands, flightPadCommands, keyboardBoost, keyboardFire, keyboardWeapon, keyboardVector, MAP_KEYS, mapKeyCommands, mapPadCommands, padAim, padBoost, padFire, padSilent, padWeapon, padVector, panelKeyCommands, panelPadCommands, type FlightCommand, type MapCommand, type PanelCommand } from './input.ts';
import { FlightPointers } from './pointers.ts';
import { addFlight, dropCargo, formatTicks, lostCargoUnits, recordSurvey, startSession, withCargo, withCrew, withFleet, withMilestone, withModules, withNavigation, withOrdnance, withProgression, withResume, withSectorProgress, type FlightControls, type FreeRoamProfile, type ResumePoint, withSimpleSignals } from './profile.ts';
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
import { gateOf, MISSILE } from './combat/playerMissile.ts';
import { spawnAgent } from './combat/ai.ts';
import type { FamilyId } from './combat/families.ts';
import { createCombatHud, type CombatHudView } from './combatHud.ts';
import { sectorContext } from './sector/context.ts';
import { generateSector } from './sector/generate.ts';
import { stackFlightHud } from './ui/hudStack.ts';
import { shipLockLine } from './combat/shipLock.ts';
import { EMPTY_SECTOR_SAVE, POI_RULES, RARE_RESOURCES, type LootEntry, type SectorLayout } from './sector/model.ts';
import { BURST_MS, drawSector, drawSectorMap, SectorArt, SHAKE, WRECK_MS, type Burst, type Shockwave, type Wreck } from './sector/render.ts';
import type { LabShell, LabStatus } from './gravity/labShell.ts';
import { applyShip, canSwitchShip, createSectorRun, setRunFlightMode, dockIfInRange, setRunLoadout, setRunOrdnance, setRunUnlimitedAmmo, disposeSectorRun, inCombat, interact, isDone, jettison, leaveOffer, marksLeft, pauseSector, restartSector, resumeSector, setCargoWreck, stepSector, takeOffer, type CargoWreck, type GateInfo, type LootOffer, type SectorEvent, type SectorInput, type SectorRun } from './sector/run.ts';
import { FLIGHT_MODE_TEXT, realisticInput, stopDisplay, type FlightMode, type StopDisplay } from './sector/realisticFlight.ts';
import { upgradedShip, cleanLevels, LEVEL_NAME, UPGRADE_BY_TRACK, type UpgradeLevels, type UpgradeTrack } from './ships/upgrades.ts';
import { createEventBus, type GameEvent } from './progression/events.ts';
import { sectorGameEvents } from './progression/fromSector.ts';
import { abandonMission, acceptMission, consumeEvent, galaxyOf, type MissionWorld, type PrereqContext } from './progression/missions.ts';
import { STORY_BY_ID } from './progression/missionData.ts';
import type { ContractSpec, MissionDef } from './progression/missionTypes.ts';
import { stationBoard } from './progression/contracts.ts';
import { buildMissionWorld } from './progression/missionWorld.ts';
import type { Wallet } from './progression/economy.ts';
import { burnCells, cellsHeld, emergencyCells, emergencyJumpTarget, FUEL, galaxyJumpCells, homeJumpDue, hopCells, hopRange, routeCells } from './progression/fuel.ts';
import { discoveryEntries, explorationStats, recordEvent, type ExplorationLog } from './progression/discovery.ts';
import { ledgerOf, progressionFromSaved, progressionToSaved, withLedger, type ProgressionState } from './progression/persistence.ts';
import { award, formatDelta, formatMarks, groupDigits, MARKS, record, spokenMarks, tickerValue, type EntryKind } from './progression/ledger.ts';
import { bountyClaim, bountyLeft, bountyRefillIn, eventClaim, REWARDS, type MarksClaim } from './progression/marksRewards.ts';
import { claimReward, deliver, grantCells, rewardChartTargets } from './progression/station.ts';
import { missionsModel, missionTargets, trackedObjective } from './progression/view.ts';
import { createMissionsPanel, type MissionsPanel } from './progression/ui/missionsPanel.ts';
import { createExchangePanel, type ExchangePanel } from './progression/ui/exchangePanel.ts';
import { createUpgradesPanel, type UpgradesPanel } from './progression/ui/upgradesPanel.ts';
import { createRecordPanel, type RecordPanel } from './progression/ui/recordPanel.ts';
import { classicRecordShowsGate, FLEET_SPEC, mergeOwned, recordOwned } from '../crossMode.ts';
import type { GuideInput } from '../guide/guideContent.ts';
import { GuideDialog } from '../guide/guideDialog.ts';
import { parseRecord } from '../../shared/persistence/record.ts';
import { cargoUsed, fleetFromSaved, fleetToSaved, formatStat, loadoutOf, type FleetState } from './ships/hangar.ts';
import { createHangarPanel, type HangarPanel, type HangarStatus } from './ships/hangarPanel.ts';
import { bridgeModel, seatRefusalText, hireRefusalText, type BridgeContext } from './crew/bridgeView.ts';
import { CREW_BY_ID } from './crew/data.ts';
import { crewFromSaved, crewToSaved } from './crew/persistence.ts';
import { distressBeaconsCleared, feeDue, signOn } from './crew/recruit.ts';
import { assign as assignCrew, dismiss as dismissCrew, EMPTY_CREW, reconcileCrew, setDoctrine, unassign as unassignCrew } from './crew/state.ts';
import type { CrewState, CrewWorld } from './crew/types.ts';
import type { BridgeAct } from './crew/ui/bridgeSection.ts';
import { ADVISOR, advisorCrew, advisorView, EMPTY_ADVISOR, evaluateAdvice, parkAdvisor, quietAdvisor, type AdvisorCrew, type AdvisorState, type AdvisorView } from './crew/advisor.ts';
import type { Observation } from './crew/observation.ts';
import { SHIP_MIND, surveyorSpreadFactor } from './crew/traits.ts';
import { createAdvisorStrip, type AdvisorStrip } from './crew/ui/advisorStrip.ts';
import { DOCTRINE_LABEL } from './crew/bridgeView.ts';
import { createForecaster } from './advisor/forecast.ts';
import { observe } from './advisor/observe.ts';
import { memberWithRole, shipCrewView, type ShipCrewView } from './crew/view.ts';
import { cleanFix, poiVerb, setSignalOptions, signalPoint, signalView, SIGNAL } from './sector/signal.ts';
import { repeatsLast, signalNotice, type SignalNoticeMemo } from './ui/signalNotice.ts';
import { createArmoryPanel, type ArmoryPanel, type ArmoryStatus } from './ships/armoryPanel.ts';
import { armedLoadout, compatibleWeapons, type ArmedLoadout } from './ships/armory.ts';
import { restockOrdnance, WEAPON_BY_ID, type WeaponId as PilotWeaponId } from '../../config/weapons.ts';
import { SHIP_BY_ID, SHIPS } from './ships/roster.ts';
import type { DerivedShip, ShipId } from './ships/types.ts';
import { freshShip, type FreeRoamPhase, type ShipState } from './sim.ts';
import { EQUIPMENT_BY_ID } from './ships/equipment.ts';
import { ENGINE_LOOP, FR_SOUNDS, type FrSoundId } from './audio/frSounds.ts';
import { engineLevel, momentCue, sectorCue, type HitContext, type MomentCue } from './audio/frCues.ts';
import type { VolumeBus } from './audio/audioSettings.ts';
import { createFlightHud, type FlightHud, type MarksReadout } from './ui/flightHud.ts';
import { stealthStatus } from './combat/stealth.ts';
import { abilityLine, abilityStatus, type AbilityStatus } from './combat/shipAbilities.ts';
import { abilityHud, cargoText, stealthHud, hudView, missileGauge as missileGaugeOf, nearestPoi, NO_ATTENTION, shipCard, stepAttention, type HudAttention, type MissileCardInput, type PoiCandidate } from './ui/hudModel.ts';
import { clearNotices, EMPTY_NOTICES, flushNotices, noticeLine, pushNotice, tickNotices, type Notice, type NoticeKind, type NoticeState } from './ui/notices.ts';
import { browserAnimate, createMotion, type Motion } from './ui/motion.ts';
import { createStationPanel, type StationPanel as StationHub } from './ui/stationPanel.ts';
import { isStationTab, stepTab, type StationTab } from './ui/stationModel.ts';
import { createEquipmentPanel, type EquipmentPanel } from './ui/equipmentPanel.ts';
import { createRecoveryPanel, type RecoveryPanel } from './ui/recoveryPanel.ts';
import { armingDelayMs, InputArming } from './ui/panelArming.ts';
import { createSoundPanel, type SoundPanel } from './ui/soundPanel.ts';
import { isEditableTarget } from '../../input/keyboard.ts';
import type { ResumeAt } from './sector/resume.ts';
import { createSequenceDetector, takeAdminRequest } from './admin/activation.ts';
import { createAdminPanel, type AdminPanel, type AdminPanelDeps } from './admin/adminPanel.ts';
import { createAdminLogin, type AdminLogin, type AdminLoginStatus } from './admin/loginScreen.ts';
import { navigatorGalaxies, navigatorSystems } from './admin/navigator.ts';
import { ADMIN_HOME, adminArrive, adminFleet, adminOnlyShips, adminSelectShip, beginAdmin, DESTINATION_TEXT, isAdmin, mayPersist, resolveDestination, stationApproach, travelCost, unlimitedAmmo, type AdminSession, type DestinationRef } from './admin/session.ts';
import { el } from './progression/ui/common.ts';

/** Pause menu groups (pause menu refinement). */
type PauseGroup = 'progress' | 'settings' | 'navigation';
type Panel = 'briefing' | 'pause' | 'complete' | 'gate' | 'sectormap' | 'cargo' | 'controls' | 'hangar' | 'armory' | 'fabricator' | 'missions' | 'exchange' | 'upgrades' | 'record' | 'station' | 'equipment' | 'sound' | 'recovery' | null;
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
  /** Combat P03: the lock-on acquisition (state, lock, the lock-on cooldown ticks, notice, launches / hits this visit) and missiles in flight. */
  /** P04.1 ship target lock: the locked hostile id, the last notice, locks this visit. */
  readonly shipLock: { readonly target: number | null; readonly notice: string | null; readonly acquired: number; readonly switched: number };
  readonly missile: { readonly state: string; readonly target: number | null; readonly lock: number; readonly cooldown: number; readonly notice: string | null; readonly launches: number; readonly hits: number; readonly inFlight: number };
  /** Combat P03C: the arsenal (selection, rotation, per-weapon cooldown ticks, stocked ammunition, fire check of the selection), dilation zones and slowed ships. */
  readonly weapons: {
    readonly selected: string;
    readonly rotation: readonly string[];
    readonly compatible: readonly string[];
    readonly cooldowns: Readonly<Record<string, number>>;
    readonly ammo: Readonly<Record<string, number>>;
    readonly gate: string;
    readonly inFlight: readonly string[];
    readonly zones: number;
    readonly slowed: number;
  } | null;
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
  /** NEXT WEAPON key / R3 / WPN held (Combat P03C; the MISSILE key of P03). */
  readonly weaponKey: boolean;
  readonly stickActive: boolean;
  readonly fireTouches: number;
  readonly boostTouches: number;
  readonly weaponTouches: number;
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
  /** P08.1: the flown ship's ability status (read only; null outside a sector). */
  readonly ability: () => AbilityStatus | null;
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
  /* Combat P03B */
  readonly armory: () => ArmoryStatus;
  /** P05.1: the crew state and the read-only crew view of the ship flown. */
  readonly crew: () => { readonly state: CrewState; readonly view: ShipCrewView };
  /** P05.2: the advisory state, what the strip shows and the last observation the advisors read. */
  readonly advisor: () => { readonly state: AdvisorState; readonly view: AdvisorView | null; readonly strip: ReturnType<AdvisorStrip['status']> | null; readonly observation: Observation | null; readonly crew: AdvisorCrew };
  /** The flown ship's weapons as combat will read them (compatible, cycle, start). */
  readonly loadout: () => ArmedLoadout;
  /** Saved ammunition counts. */
  readonly ordnance: () => Readonly<Record<string, number>>;
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
  /** P04: the Admin Access session (read only; null when inactive). There is deliberately no way to start one from here. */
  readonly admin: () => { readonly from: string; readonly owned: readonly string[]; readonly panel: ReturnType<AdminPanel['status']> | null } | null;
  /** P04: the hidden login screen while it exists (null otherwise). */
  readonly adminLogin: () => AdminLoginStatus | null;
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
  /** Economy pass: the wallet as stored (read only): balance, recent history, duplicate-id count, bounty book, lane hops. */
  readonly economy: () => { readonly marks: number; readonly history: readonly { readonly kind: string; readonly label: string; readonly delta: number; readonly balance: number; readonly refunded?: boolean }[]; readonly recent: number; readonly bounty: Readonly<Record<string, { readonly paid: number; readonly since: number }>>; readonly jumps: number; readonly fx: number };
  /**
   * Economy QA only: stage a balance (browser checks of affordable / insufficient states) or publish one gameplay
   * event through the normal bus (reward hooks end to end). Test hook object only: absent from release builds.
   */
  readonly qaMarks: (n: number) => boolean;
  readonly qaEvent: (e: GameEvent) => void;
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

/** P04: the ship rows of the admin panel. */
type AdminShipRowList = ReturnType<AdminPanelDeps['ships']>;
/** P04: short stat labels for the admin ship list (the hangar's numbers, formatted by formatStat). */
const STAT_LABEL = Object.freeze({ hull: 'Hull', shield: 'Shield', maxSpeed: 'Top speed', cargo: 'Cargo', travel: 'Drive charge' });

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
  /** P04: the active sector started beside its station (an admin station arrival). */
  let besideStation = false;
  let saves: SavesPanel;
  /** P04.2 guide: HOW TO PLAY from the pause menu (modal over it, like the save slots panel). */
  let guide: GuideDialog | null = null;
  let savesBtn: HTMLButtonElement;
  let savesReturn: HTMLElement | null = null;
  let status: FreeRoamStatus;
  /** P04: the Admin Access session (runtime only, never saved; null = ordinary play) and its panel,
   *  built on the first activation only (ordinary players never have it in the page). */
  let admin: AdminSession | null = null;
  let adminPanel: AdminPanel | null = null;
  let adminReturn: HTMLElement | null = null;
  /** P04: the hidden login screen while it is up (everything else in the mode is inert underneath). */
  let adminLogin: AdminLogin | null = null;
  let loginInert: (readonly [HTMLElement, boolean])[] = [];
  let loginReturn: HTMLElement | null = null;
  const adminKeys = createSequenceDetector();

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
  const waves: Shockwave[] = [];
  const wrecks: Wreck[] = [];
  const NO_INPUT: InputStatus = { moveX: 0, moveY: 0, aim: null, fire: false, boost: false, weaponKey: false, stickActive: false, fireTouches: 0, boostTouches: 0, weaponTouches: 0, mouseFire: false, keys: [] };
  /** Owned ships and loadouts (validated against the roster), and the derived ship flown. */
  let fleet: FleetState;
  let craft: DerivedShip;
  /** P05.1: crew (signed on, fees paid, seats per owned ship) and the frozen view of the flown ship's crew (rebuilt on change, never per frame). */
  let crew: CrewState = EMPTY_CREW;
  let crewView: ShipCrewView = shipCrewView(EMPTY_CREW, 'petrel');
  /* P05.2: Ship Mind and crew advice (crew/advisor.ts). Reads the run, writes nothing but these. */
  let advice: AdvisorState = EMPTY_ADVISOR;
  let advisorStrip: AdvisorStrip | null = null;
  let lastObservation: Observation | null = null;
  let lastAdviceTick = -1;
  let advisorCrewCache: { readonly key: string; readonly crew: AdvisorCrew } | null = null;
  let routeCache: { readonly key: string; readonly route: { readonly cells: number; readonly cheapest: number; readonly dearest: number } | null } | null = null;
  const forecaster = createForecaster();
  const visitIds = new WeakMap<SectorRun, number>();
  let visitCount = 0;
  let lastInput: InputStatus = NO_INPUT;
  /** Overheat rattle start (performance.now ms), or null; phone vibrations requested (FR-TD-79). */
  let shakeStart: number | null = null;
  let vibrations = 0;
  /* P04.1 wheel zoom: the wheel (and a trackpad pinch) moves controls.zoom continuously and the camera's
     displayed zoom eases after it; the + / - keys and the CONTROLS buttons step it at once, as before.
     The saved preference is written once the wheel has been still for ZOOM_SAVE_MS, never per event. */
  let shownZoom = Number.NaN;
  let zoomSaveAt: number | null = null;
  const ZOOM_SAVE_MS = 400;
  /**
   * P04.1 polish: a transition (new sector, restart, recovery) shows the pilot's saved zoom at once: a
   * wheel change still waiting is saved, its easing is finished and the combat framing of the last fight
   * is dropped (the next fight eases out again). Called at those transitions only, never per frame.
   */
  const settleZoom = (): void => {
    if (zoomSaveAt !== null) setControls({ zoom: controls.zoom });
    shownZoom = controls.zoom;
    framing = 1;
  };
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
  /* Pause menu groups: RESUME / RESTART FLIGHT on top, the rest in three disclosure groups (one open at a time). */
  let pauseOpen: PauseGroup | null = null;
  /** When the open group opened (performance.now): a pointer click on its actions this soon is the tail of a double click. */
  let pauseOpenedAt = -Infinity;
  /** The group action that opened a submenu: focus returns to it when the submenu closes. */
  let pauseReturn: HTMLButtonElement | null = null;
  let pauseGroups: readonly { readonly id: PauseGroup; readonly box: HTMLElement; readonly head: HTMLButtonElement; readonly body: HTMLElement }[] = [];
  let restartBtn: HTMLButtonElement;
  let restartAsk: HTMLElement;
  let restartNo: HTMLButtonElement;
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
  /* weapons (Combat P03C): the WPN touch button above FIRE (tap = next weapon, never fires), and edge
     commands waiting for the next simulated tick: one weapon step, and a FIRE press shorter than a frame */
  let missileBtn: HTMLButtonElement;
  /* P04.1: the LOCK touch button (left side; tap = toggle the ship target lock) and its latched press */
  let lockBtn: HTMLButtonElement;
  let lockPending = false;
  /** P04.1 polish: NEXT TARGET (C / the touch button beside LOCK), one step per press, only while locked. */
  let targetBtn: HTMLButtonElement;
  let targetPending = false;
  /** P04.3: REALISTIC flight's STOP control (HUD button + mode tag) and its latched press (B / the button). */
  let flightCtl: HTMLElement;
  let stopBtn: HTMLButtonElement;
  let stopState: HTMLElement;
  let stopRelease: HTMLElement;
  /** P07.2: the SILENT control (HUD indicator + button) and the stealth status tag, in the same column as STOP. */
  let modeTag: HTMLElement;
  let silentBtn: HTMLButtonElement;
  let stealthTag: HTMLElement;
  let silentKey = '';
  /** P08.2: the ship ability control (HUD panel + touch button, the same column), painted from abilityStatus only. */
  let abilityBtn: HTMLButtonElement;
  let abilityKey = '';
  let stopPending = false;
  let silentPending = false;
  let abilityPending = false; // P08.1: one ship-ability try per press
  /** P07.2: the hints name the tap until a flight pointer event says otherwise when the primary pointer is coarse (read once). */
  const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const touchHints = (): boolean => (container.dataset['input'] ? container.dataset['input'] === 'touch' : coarsePointer);
  let cyclePending: 1 | -1 | 0 = 0;
  let firePending = false;
  let padWeaponWas = false;
  let padSilentWas = false;
  let padFireWas = false;
  const paintMissileBtn = (r: SectorRun, touches: number): void => {
    const c = weaponCard(r);
    const g = missileGaugeOf(c, r.docked !== null);
    const state = g.state;
    const short = c.label === 'LOCK-ON' ? 'LOCK' : c.label;
    // the weapon, and its ammunition or readiness, on two lines: never colour alone
    const second = g.gauge.text; // the same words as the HUD weapon row
    const label = `${short}\n${second}`;
    if (missileBtn.dataset['state'] !== state) missileBtn.dataset['state'] = state;
    if (missileBtn.dataset['weapon'] !== r.arsenal.selected) missileBtn.dataset['weapon'] = r.arsenal.selected;
    if (missileBtn.textContent !== label) {
      missileBtn.textContent = label;
      missileBtn.setAttribute('aria-label', `Next weapon. Selected: ${c.label.toLowerCase()}, ${second === '\u221e' ? 'unlimited' : second.toLowerCase()}`);
    }
    const pct = c.state === 'cooldown' ? Math.round((100 * c.cooldown) / Math.max(1, c.cooldownTicks)) : 0;
    missileBtn.style.setProperty('--cool', `${pct}%`);
    missileBtn.classList.toggle('is-active', touches > 0);
  };
  /** The LOCK button mirrors the simulation's lock (on / off) and its last notice (NO TARGET...), never its own guess. */
  const paintLockBtn = (r: SectorRun, touches: number): void => {
    // the Gravity Flight test flies rotate-and-thrust (the nose steers there): no lock, so no button
    const hide = r.flight !== null;
    if (lockBtn.hidden !== hide) lockBtn.hidden = hide;
    const on = r.shipLock.target !== null;
    const n = r.shipLock.notice;
    const state = on ? 'on' : n === 'noTarget' || n === 'unavailable' || n === 'range' ? 'refused' : 'off';
    if (lockBtn.dataset['state'] !== state) lockBtn.dataset['state'] = state;
    const pressed = on ? 'true' : 'false';
    if (lockBtn.getAttribute('aria-pressed') !== pressed) lockBtn.setAttribute('aria-pressed', pressed);
    const text = on ? 'LOCKED' : state === 'refused' ? (n === 'range' ? 'LOST' : 'NONE') : 'LOCK';
    const label = lockBtn.querySelector<HTMLElement>('.fr-lock-text');
    if (label && label.textContent !== text) label.textContent = text;
    lockBtn.classList.toggle('is-active', touches > 0);
  };
  /** NEXT TARGET (touch): shown only while a lock holds (it does nothing without one); the brief ONLY state after a press with no other ship. */
  const paintTargetBtn = (r: SectorRun, touches: number): void => {
    const hide = r.flight !== null || r.shipLock.target === null;
    if (targetBtn.hidden !== hide) targetBtn.hidden = hide;
    const state = r.shipLock.notice === 'onlyTarget' ? 'refused' : 'off';
    if (targetBtn.dataset['state'] !== state) targetBtn.dataset['state'] = state;
    targetBtn.classList.toggle('is-active', touches > 0);
  };
  /** P04.3: the STOP control mirrors the simulation (STOP / STOPPING / HOLDING POSITION / CAN'T HOLD); shown in REALISTIC flight only. */
  const STOP_TEXT: Readonly<Record<StopDisplay, string>> = { off: 'STOP', stopping: 'STOPPING', holding: 'HOLDING POSITION', cannot: "CAN'T HOLD" };
  /** P07.2: the SILENT control and the stealth tag mirror the run every frame (stealthStatus: the simulation's own counts), never a local guess. */
  const paintSilent = (r: SectorRun, touches: number): void => {
    const m = stealthHud(stealthStatus(r), keyLabel(controls.bindings.silent[0]), touchHints());
    const tag = m.tag.join('\n');
    const k = `${m.hint}|${m.aria}|${tag}`;
    if (k !== silentKey) {
      silentKey = k;
      silentBtn.dataset['state'] = m.on ? 'on' : 'off';
      silentBtn.setAttribute('aria-pressed', `${m.on}`);
      silentBtn.setAttribute('aria-label', m.aria);
      const [st, hint] = silentBtn.children as unknown as [HTMLElement, HTMLElement];
      st.textContent = m.state;
      hint.innerText = m.hint; // line breaks become <br>
      stealthTag.innerText = tag;
      stealthTag.hidden = !tag;
    }
    silentBtn.classList.toggle('is-active', touches > 0);
  };
  /** P08.2: the ability control mirrors the run's own status every frame (its ticks: frozen while paused), never a local timer. */
  const paintAbility = (r: SectorRun, touches: number): void => {
    const m = abilityHud(abilityStatus(r), keyLabel(controls.bindings.ability[0]), touchHints());
    const k = `${m.label}|${m.hint}|${m.aria}`;
    if (k !== abilityKey) {
      abilityKey = k;
      abilityBtn.hidden = !m.show;
      abilityBtn.dataset['state'] = m.state;
      abilityBtn.setAttribute('aria-pressed', `${m.state === 'on'}`);
      abilityBtn.setAttribute('aria-disabled', `${m.state === 'cooling'}`);
      abilityBtn.setAttribute('aria-label', m.aria);
      const [st, hint] = abilityBtn.children as unknown as [HTMLElement, HTMLElement];
      st.textContent = m.label;
      hint.innerText = m.hint;
    }
    abilityBtn.classList.toggle('is-active', touches > 0);
  };
  const paintStopCtl = (r: SectorRun, touches: number, silentTouches: number, abilityTouches: number): void => {
    const show = r.flight === null;
    if (flightCtl.hidden === show) flightCtl.hidden = !show;
    if (!show) return;
    paintSilent(r, silentTouches);
    paintAbility(r, abilityTouches);
    const real = r.flightMode === 'realistic';
    if (stopBtn.hidden === real) stopBtn.hidden = modeTag.hidden = !real;
    if (!real) return;
    const d = stopDisplay(r.stop);
    if (stopBtn.dataset['state'] !== d) {
      stopBtn.dataset['state'] = d;
      stopState.textContent = STOP_TEXT[d];
      stopBtn.setAttribute('aria-pressed', d === 'off' ? 'false' : 'true');
      const key = keyLabel(controls.bindings.stop[0]);
      stopBtn.setAttribute(
        'aria-label',
        d === 'off'
          ? `Stop (${key}): brake, then hold position`
          : d === 'cannot'
            ? `Stop is on but cannot hold: the pull is stronger than the ship's thrust. Press to release (${key})`
            : `${STOP_TEXT[d].toLowerCase()}. Press to release (${key})`,
      );
    }
    if (d !== 'off') {
      const rel = touchHints() ? 'TAP TO RELEASE' : `${keyLabel(controls.bindings.stop[0])} OR CLICK TO RELEASE`;
      if (stopRelease.textContent !== rel) stopRelease.textContent = rel;
    }
    stopBtn.classList.toggle('is-active', touches > 0);
  };
  let hangar: HangarPanel;
  let armory: ArmoryPanel;
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
  /** P04.3: the FLIGHT MODE selector (CONTROLS panel). */
  let modeBtns: Record<FlightMode, HTMLButtonElement>;
  let modeDesc: HTMLElement;
  /** P05.2: SHIP MIND advice (ALL / CRITICAL ONLY), CONTROLS panel. */
  let adviceBtns: Record<'all' | 'critical', HTMLButtonElement>;
  let adviceDesc: HTMLElement;
  /** P06.2: SIGNALS (STANDARD / SIMPLE), CONTROLS panel: the Simple Signals accessibility preference. */
  let signalBtns: Record<'standard' | 'simple', HTMLButtonElement>;
  let signalDesc: HTMLElement;
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
    // P04: the admin sandbox is never written (the single save gateway; exiting reloads the untouched slot)
    if (!mayPersist(admin)) return true;
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
    // the first call (slot load) has no previous fleet yet
    const prev = fleet as FleetState | undefined;
    const shipChanged = prev !== undefined && f.active !== prev.active;
    // P03C: a new acquisition joins the cross-mode registry (after the Classic Wave 20 milestone only; merge, never remove)
    // P04: never from an admin session (its fleet is a sandbox, not ownership)
    if (mayPersist(admin) && prev && f.owned.length > prev.owned.length) recordOwned(services.store, f.owned);
    fleet = f;
    craft = upgradedShip(f.active, loadoutOf(f, f.active), levelsOf(f.active));
    profile = withFleet(profile, fleetToSaved(f));
    // P05.1: seats follow the fleet (a ship no longer flown by this save releases its crew to the roster, never deletes them)
    const rc = reconcileCrew(crew, f.owned);
    if (rc.changes > 0) {
      crew = rc.state;
      profile = withCrew(profile, crewToSaved(crew));
    }
    crewView = shipCrewView(crew, f.active);
    // P03C: the flown run follows every hangar / armory change at once (an illegal weapon never stays selectable)
    if (run) setRunLoadout(run, armedLoadout(f), shipChanged);
  };
  /* ------------------------------ progression ------------------------------ */
  /** Upgrade levels of a ship, cleaned against its caps (never invalid stats). */
  const levelsOf = (id: ShipId): UpgradeLevels => cleanLevels(id, prog.upgrades[id]);
  const saveProg = (): void => {
    profile = withProgression(profile, progressionToSaved(prog));
  };
  const held = (): number => cellsHeld(profile.cargo);
  const wallet = (): Wallet => ({ marks: prog.marks, hold: profile.cargo, holdCap: holdCap(), modules: profile.modules });
  /** Economy pass: transient HUD feedback for the last balance change (never saved). */
  let marksFx = { serial: 0, delta: 0, at: -Infinity };
  /** One history step through the ledger (the balance and its history change together). */
  const applyMarks = (r: ReturnType<typeof record>): boolean => {
    if (!r.ok) return false;
    prog = withLedger(prog, r.ledger);
    marksFx = { serial: marksFx.serial + 1, delta: r.entry.delta, at: lastFrameTs };
    return true;
  };
  /**
   * Apply a confirmed transaction (marks, hold, stored modules) with one save. The marks change is
   * recorded once in the ledger (history label, optional claim id). Refused, with nothing changed,
   * when the ledger refuses the step (a duplicate id) or when an Admin Access session would change
   * the balance (the sandbox never does).
   */
  const commitWallet = (w: Wallet, label = 'Exchange trade', kind?: EntryKind, id: string | null = null): boolean => {
    if (w.marks !== prog.marks) {
      if (isAdmin(admin)) return false;
      if (!applyMarks(record(ledgerOf(prog), w.marks, kind ?? (w.marks > prog.marks ? 'sale' : 'purchase'), label, id))) return false;
    }
    profile = withModules(withCargo(profile, w.hold), w.modules);
    saveProg();
    if (run) run.cargoSpace = holdFree();
    save();
    return true;
  };
  /** Pay a once-only reward claim (bounty, encounter, discovery). Never during Admin Access. */
  const payClaim = (c: MarksClaim | null): boolean => {
    if (!c || isAdmin(admin)) return false;
    if (!applyMarks(award(ledgerOf(prog), c.amount, c.kind, c.label, c.id))) return false;
    missionNote(`${formatDelta(prog.ledger.history[prog.ledger.history.length - 1]?.delta ?? c.amount)} MARKS · ${c.label.toUpperCase()}`, 'gain');
    return true;
  };
  /* ---------------------------------- crew ---------------------------------- */
  /** P05.1: what the crew rules read. Seats change only docked with no hostile engaged (the ship-switch rule). */
  const crewWorld = (): CrewWorld => {
    const view = deriveView(graph, progress);
    return {
      docked: dockedAt(),
      safe: run !== null && dockedAt() !== null && canSwitchShip(run),
      owned: fleet.owned,
      requirementMet: (req) => view.requirementMet(req),
      missionDone: (id) => prog.missions.completed.includes(id),
      rescues: distressBeaconsCleared(profile.sectors),
    };
  };
  /** Store a crew change (and the ledger of a paid hire) with one save. */
  const commitCrew = (next: CrewState): void => {
    crew = next;
    crewView = shipCrewView(crew, fleet.active);
    profile = withCrew(profile, crewToSaved(crew));
    saveProg();
    save();
  };
  /** Everything the Bridge shows about `ship` (read only: building it never changes state). */
  const bridgeCtx = (ship: ShipId): BridgeContext => {
    const view = deriveView(graph, progress);
    return { ship, flown: fleet.active, crew, world: crewWorld(), balance: prog.marks, free: isAdmin(admin), describe: (req) => describeRequirement(view, req), stationName: (id) => graph.system(id)?.name ?? id };
  };
  const crewName = (id: string): string => CREW_BY_ID.get(id)?.name ?? id;
  const crewShipName = (id: ShipId): string => SHIP_BY_ID.get(id)?.name ?? id;
  /** One Bridge action: the crew rules decide, this commits and says what happened. */
  const crewAct = (a: BridgeAct): { ok: boolean; text: string } => {
    if (a.kind === 'doctrine') {
      // P05.2: an advisory preference only (never seats, fees, flight or progress)
      commitCrew(setDoctrine(crew, a.doctrine));
      return { ok: true, text: `Navigator doctrine: ${DOCTRINE_LABEL[a.doctrine].toLowerCase()}. ${a.doctrine === 'safety' ? 'Earlier hazard warnings, widest-margin escape burns first, no optional route notes.' : 'Concise advice; momentum-keeping escape burns first.'}` };
    }
    const w = crewWorld();
    const name = crewName(a.id);
    if (a.kind === 'hire') {
      const def = CREW_BY_ID.get(a.id);
      const free = isAdmin(admin);
      const fee = def ? feeDue(def, crew, free) : 0;
      const r = signOn(crew, ledgerOf(prog), a.id, w, free);
      if (!r.ok) {
        if (r.refunded) {
          prog = withLedger(prog, r.ledger); // the charge and its refund both stay in the history
          commitCrew(crew);
        }
        return { ok: false, text: def ? hireRefusalText(r.reason, def, bridgeCtx(fleet.active), fee) : 'Unknown recruit.' };
      }
      if (r.charged > 0) {
        prog = withLedger(prog, r.ledger);
        marksFx = { serial: marksFx.serial + 1, delta: -r.charged, at: lastFrameTs };
      }
      commitCrew(r.state);
      return { ok: true, text: `${name} signed on${r.charged > 0 ? ` for ${formatMarks(r.charged)}` : ''}${free && def && def.fee > 0 ? ' (Admin Access: no fee, not saved)' : ''}. They wait on your roster until you give them a seat.` };
    }
    if (a.kind === 'assign') {
      const r = assignCrew(crew, a.id, a.ship, w);
      if (!r.ok) return { ok: false, text: seatRefusalText(r.reason, a.ship) };
      commitCrew(r.state);
      return { ok: true, text: r.moved ? `${name} moved from the ${crewShipName(r.moved)} to the ${crewShipName(a.ship)}.` : `${name} takes a seat on the ${crewShipName(a.ship)}.` };
    }
    if (a.kind === 'unassign') {
      const r = unassignCrew(crew, a.id, w);
      if (!r.ok) return { ok: false, text: seatRefusalText(r.reason, fleet.active) };
      commitCrew(r.state);
      return { ok: true, text: `${name} left the ${r.moved ? crewShipName(r.moved) : 'ship'} and waits on your roster.` };
    }
    const r = dismissCrew(crew, a.id, w);
    if (!r.ok) return { ok: false, text: r.reason === 'unsafe' ? 'Contracts end only while docked with no hostiles engaged.' : 'Not on your roster.' };
    commitCrew(r.state);
    const src = CREW_BY_ID.get(a.id)?.source;
    return { ok: true, text: `${name}'s contract ended. ${src?.kind === 'station' ? `They return to ${graph.system(src.systemId)?.name ?? src.systemId} station` : 'They can sign on again at any station'}, with no second fee.` };
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
  /**
   * Economy pass: the marks a gameplay event earns (marksRewards.ts), paid once through the ledger.
   * Bounties come out of the system's pool (shown once when it runs dry); encounters and discoveries
   * pay once by claim id. Nothing is paid during Admin Access.
   */
  let bountyDryNoted = '';
  const earnMarks = (e: GameEvent, log: ExplorationLog): boolean => {
    if (isAdmin(admin)) return false;
    if (e.type === 'hostile-destroyed') {
      const b = bountyClaim(prog.bounty, e, prog.missions.jumps, String(log.kills));
      const bookChanged = b.book !== prog.bounty;
      if (bookChanged) prog = { ...prog, bounty: b.book };
      const ok = payClaim(b.claim);
      if (b.limited && bountyDryNoted !== `${e.systemId}|${prog.bounty[e.systemId]?.since ?? 0}` && bountyLeft(prog.bounty, e.systemId, prog.missions.jumps) === 0) {
        bountyDryNoted = `${e.systemId}|${prog.bounty[e.systemId]?.since ?? 0}`;
        const hops = bountyRefillIn(prog.bounty, e.systemId, prog.missions.jumps);
        missionNote(`BOUNTIES PAID OUT HERE · ${graph.system(e.systemId)?.name.toUpperCase() ?? 'THIS SYSTEM'} PAYS AGAIN IN ${hops} LANE HOP${hops === 1 ? '' : 'S'}`, 'info');
      }
      return ok || bookChanged;
    }
    return payClaim(eventClaim(e, { newEntry: log !== prog.log, systemName: (id) => graph.system(id)?.name ?? id, galaxyName }));
  };
  /** Bounty pool here, for the record panel. */
  const bountyNote = (): string => {
    const here = run ? run.layout.systemId : progress.system;
    const left = bountyLeft(prog.bounty, here, prog.missions.jumps);
    const name = graph.system(here)?.name ?? here;
    const refill = bountyRefillIn(prog.bounty, here, prog.missions.jumps);
    return `Bounties in ${name}: ${formatMarks(left)} of ${formatMarks(REWARDS.bountyPool)} left${left < REWARDS.bountyPool ? ` · the pool refills ${refill} lane hop${refill === 1 ? '' : 's'} after it opened` : ''}. Cleared encounters and first discoveries pay once.`;
  };
  /** The mission manager and the exploration log consume every gameplay event. */
  const onGameEvent = (e: GameEvent): void => {
    const res = consumeEvent(prog.missions, e);
    const log = recordEvent(prog.log, e, graph);
    const paid = earnMarks(e, log);
    if (res.state === prog.missions && log === prog.log && !paid) return;
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
    const need = free ? 0 : travelCost(admin, routeCells(r.plan.lanes, craft.stats.travel)); // P04: bypassed (0) in an admin session
    if (!burn(need)) return { ok: false, reason: 'fuel', need, have: held() };
    commitProgress(r.progress);
    arrived(r.plan.path.slice(1), before, r.plan.jumps, routeEvents(r.newRoutes));
    persist();
    return r;
  };
  /** Economy pass: travel costs reactor cells only; the confirmation says so with the marks balance (unchanged by travel). */
  const travelFee = (): string => `TRAVEL FEE ${isAdmin(admin) ? 'ADMIN ACCESS — FREE' : 'FREE'} (0 MARKS) · BALANCE ${formatMarks(prog.marks)} · AFTER ${formatMarks(prog.marks)}`;
  const emergencyTarget = (): string | null => {
    if (isAdmin(admin)) return null; // P04: travel is free in the sandbox, no emergency jump is needed
    const sv = deriveSystemView(deriveView(graph, progress), currentGalaxy().id);
    return emergencyJumpTarget(sv, held(), craft.stats.travel, isStation);
  };
  const homeDue = (): boolean => {
    if (isAdmin(admin)) return false;
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
    if (!run?.docked || isAdmin(admin)) return 0;
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
    // Economy pass: the sandbox pays no rewards (the balance never changes during Admin Access)
    if (isAdmin(admin)) return { ok: false, text: 'Exit Admin Access to turn in missions: the sandbox pays no rewards.' };
    const res = claimReward(prog, id, wallet(), (galaxy, n) => rewardChartTargets(graph, progress, galaxy, n));
    if (!res.ok) return { ok: false, text: res.text };
    const before = prog;
    // the reward's marks go through the ledger (recorded once by mission id) in commitWallet below
    prog = { ...res.progression, marks: before.marks };
    if (res.wallet.marks !== before.marks && !record(ledgerOf(prog), res.wallet.marks, 'mission', `Mission · ${res.title}`, `mission:${id}`).ok) {
      prog = before;
      return { ok: false, text: 'This reward was already paid.' };
    }
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
    commitWallet(res.wallet, `Mission · ${res.title}`, 'mission', `mission:${id}`);
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
  const enterSector = (systemId: string, spawn: string | undefined, phase: FreeRoamPhase, place?: (L: SectorLayout) => ResumeAt | null): void => {
    leaveSector();
    const sys = graph.system(systemId);
    if (!sys) throw new Error(`unknown system ${systemId}`);
    layout = generateSector(sys, sectorContext(graph, systemId));
    art = new SectorArt(layout);
    // Prompt 13: the first entry into the saved system resumes at the saved point (checked
    // against the layout; an unsafe point starts at the arrival); any other entry starts fresh
    // P04: an admin arrival may start beside the station (a point checked like a resume point)
    const at = place ? place(layout) : pendingResume && pendingResume.systemId === systemId && spawn === undefined ? pendingResume : null;
    pendingResume = null;
    run = createSectorRun(layout, profile.sectors[systemId] ?? EMPTY_SECTOR_SAVE, { spawn, gates: gateInfos(layout), seed: randomSeed(), phase, ship: craft, cargoSpace: holdFree(), cargoWreck: wreckFor(systemId), at, loadout: armedLoadout(fleet), ordnance: profile.ordnance, unlimitedAmmo: unlimitedAmmo(admin), flightMode: controls.flightMode });
    resumedAt = !place && at !== null && (run.ship.x !== layout.spawns[0]!.x || run.ship.y !== layout.spawns[0]!.y);
    besideStation = !!place && at !== null && (run.ship.x !== layout.spawns[0]!.x || run.ship.y !== layout.spawns[0]!.y);
    if (!resumedAt) profile = withResume(profile, null);
    counters.generated += 1;
    resetRunCounters();
    snapCamera(cam, run.ship.x, run.ship.y); // a new sector: no glide from the old camera position
    settleZoom(); // and no zoom carried over half-eased, or still framed for the last sector's fight
    bursts.length = 0;
    waves.length = 0;
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
    waves.length = 0;
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
    waves.length = 0;
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
    settleZoom();
    bursts.length = 0;
    waves.length = 0;
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
      weapons: r
        ? {
            selected: r.arsenal.selected,
            rotation: [...r.arsenal.rotation],
            compatible: [...r.arsenal.compatible],
            cooldowns: { ...r.arsenal.cooldown },
            ammo: { ...r.ammo },
            gate: gateOf(r, r.arsenal.selected),
            inFlight: r.missiles.map((m) => m.weapon),
            zones: r.dilation.length,
            slowed: r.hostiles.filter((h) => (h.tscale ?? 1) < 1).length,
          }
        : null,
      shipLock: r ? { target: r.shipLock.target, notice: r.shipLock.notice, acquired: r.shipLock.acquired, switched: r.shipLock.switched } : { target: null, notice: null, acquired: 0, switched: 0 },
      missile: r ? { state: r.missile.state, target: r.missile.target, lock: r.missile.lock, cooldown: r.arsenal.cooldown['lock-missile'], notice: r.missile.notice, launches: r.missile.launches, hits: r.missile.hits, inFlight: r.missiles.length } : { state: 'ready', target: null, lock: 0, cooldown: 0, notice: null, launches: 0, hits: 0, inFlight: 0 },
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
    if (p !== 'pause') closeRestartAsk(false); // a restart question never survives leaving the pause menu
    if (p) {
      // a notice card under the panel steps aside to the log (it would expire unseen)
      const nf = flushNotices(notices);
      notices = nf.state;
      toLog(nf.toLog);
      keys.clear(); // a key that opened the panel must not also steer or activate
      pointers.reset();
      // back from a submenu opened from a pause group: focus the action that opened it (its group is still open)
      if (p === 'pause' && pauseReturn && pauseReturn.isConnected && !pauseReturn.closest('[hidden]')) pauseReturn.focus({ preventScroll: true });
      else menus[p].focus(0);
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
    else if (tab === 'armory') armory.open(dockLabel);
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
    // P04: only during an admin session (ordinary briefings never mention it)
    const adminNote = isAdmin(admin) ? `ADMIN ACCESS · sandbox: nothing in this session is saved.${run && besideStation ? ' You start beside the station: INTERACT docks.' : ''}` : '';
    briefingNote.textContent = [adminNote, resumed, real ? SIMULATION_NOTE : ''].filter(Boolean).join(' ');
    briefingNote.hidden = !real && !resumed && !adminNote;
    const back = mapReturn === 'system' ? 'SYSTEM MAP' : 'GALAXY MAP';
    for (const b of returnButtons) b.textContent = back;
    // the NAVIGATION group row lists its actions: keep it in step with the relabelled map button
    for (const g of pauseGroups) if (g.id === 'navigation') g.head.querySelector('.fr-pause-head-sum')!.textContent = `${back} · MAIN MENU`;
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
    if (controls.flightMode === 'realistic') {
      // P04.3: REALISTIC flies rotate-and-thrust with the same keys, plus STOP
      hintKeys.textContent = `${keyLabel(b.left[0])}/${keyLabel(b.right[0])} ROTATE · ${keyLabel(b.up[0])} THRUST · ${keyLabel(b.down[0])} REVERSE · ${keyLabel(b.stop[0])} STOP · ${actionKeys(b, 'fire')} FIRE · ${keyLabel(b.boost[0])} BOOST · ${keyLabel(b.missile[0])} WEAPON · ${keyLabel(b.lock[0])} LOCK · ${keyLabel(b.target[0])} NEXT TARGET${controls.mouseAim ? ' · MOUSE AIM' : ''} · ${actionKeys(b, 'interact')} INTERACT · ${keyLabel(b.map[0])} MAP · ESC PAUSE`;
      container.dataset['aim'] = controls.mouseAim ? 'mouse' : 'travel';
      return;
    }
    hintKeys.textContent = `${move}${alt.includes('—') ? '' : ` / ${alt}`} FLY · ${actionKeys(b, 'fire')} FIRE · ${keyLabel(b.boost[0])} BOOST · ${keyLabel(b.missile[0])} WEAPON · ${keyLabel(b.lock[0])} LOCK · ${keyLabel(b.target[0])} NEXT TARGET${controls.mouseAim ? ' · MOUSE AIM' : ''} · ${actionKeys(b, 'interact')} INTERACT · ${keyLabel(b.map[0])} MAP · ${keyLabel(b.cargo[0])} CARGO · ESC PAUSE`;
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
  /** P06.2 signal feedback in the notice feed (ui/signalNotice.ts); a repeat within 1.5 s of sim time is not stacked. */
  const signalMemo: SignalNoticeMemo = { text: '', tick: -1 };
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
        // P06.1: a two-bearing fix earns a cosmetic tag in the log line, nothing more
        const clean = cleanFix(r, e.id) ? ' · CLEAN FIX' : '';
        if (e.loot.length === 0) {
          collect(sys, e);
          cue(e);
          notify(`${e.label.toUpperCase()} · DISCOVERY RECORDED${clean}`, undefined, 'info');
          return;
        }
        if (!collect(sys, e)) return;
        cue(e);
        notify(`${e.label.toUpperCase()} ${lootText(e.loot)}${e.left.length ? ` · ${unitsText(e.left)} LEFT` : ''}${clean}`, e.loot);
      } else if (e.type === 'picked') {
        if (!collect(sys, e)) return;
        cue(e);
        notify(`${e.label.toUpperCase()} ${lootText(e.loot)}${e.left.length ? ` · ${unitsText(e.left)} LEFT` : ''}`, e.loot);
      } else if (e.type === 'signal') {
        const sp = r.layout.pois.find((q) => q.id === e.id);
        const n = signalNotice(e.label, e.result, sp ? signalView(r, sp)?.jammed === true : false, SIGNAL.minSeparationDeg);
        if (!repeatsLast(signalMemo, n.text, r.tick)) notify(n.text, undefined, n.tone);
      } else if (e.type === 'dropped') {
        notify('SALVAGE POD · FLY OVER IT WITHIN 40 S', undefined, 'info');
      } else if (e.type === 'expired') {
        if (e.kind === 'pod' || e.kind === 'jettison') notify(e.kind === 'pod' ? 'SALVAGE POD DRIFTED OUT OF RANGE' : 'JETTISONED CARGO DRIFTED AWAY', undefined, 'warn');
      } else if (e.type === 'chipped') {
        cue(e);
        notify(`ORE FRAGMENT CHIPPED${e.remaining > 0 ? ` · ${e.remaining} LEFT IN THE VEIN` : ' · VEIN DEPLETED'}`, undefined, 'info');
      } else if (e.type === 'docked') {
        if (e.first) profile = withSectorProgress(profile, sys, [e.id]);
        // P03B: docked and repaired includes the magazines (heavy missiles, nuke) back to capacity; saved below
        const restocked = restockOrdnance(profile.ordnance);
        const topped = Object.keys(restocked).some((k) => restocked[k] !== profile.ordnance[k]);
        if (topped) profile = withOrdnance(profile, restocked);
        setRunOrdnance(r, profile.ordnance); // the run fires from the same counts
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
      } else if (e.type === 'shipLocked' || e.type === 'shipLockRefused' || e.type === 'shipLockEnded') {
        // P04.1: one short line in the corner log (never a card over the play area); the target carries the marker
        cue(e);
        const line = shipLockLine(e);
        if (line) notify(line.text, undefined, line.tone);
      } else if (e.type === 'stop') {
        // P04.3: one short corner-log line where the button alone would not explain it (never a card over the play area)
        if (e.change === 'unavailable') notify('STOP · REALISTIC FLIGHT ONLY (PAUSE · CONTROLS)', undefined, 'info');
        else if (e.change === 'cancelled') notify('STOP RELEASED · MANUAL CONTROL', undefined, 'info');
      } else if (e.type === 'silent') {
        // P07.1 / P07.2: one corner-log line per change; an automatic end names its input (the request, not a claim that it fired or boosted)
        notify(e.change === 'on' ? 'SILENT RUNNING ON' : `SILENT RUNNING OFF${e.change === 'off' ? '' : ` — ${e.change.toUpperCase()} INPUT`}`, undefined, 'info');
      } else if (e.type === 'ability') {
        notify(abilityLine(e), undefined, e.change === 'refused' ? 'warn' : 'info'); // one corner-log line per real change (the control shows the state)
      } else if (e.type === 'missileLock' || e.type === 'missileLockLost' || e.type === 'missileRefused' || e.type === 'missileLaunched' || e.type === 'missileReady' || e.type === 'weaponSwitched') {
        cue(e); // the HUD weapon row and the WPN button carry the text (NO TARGET, LOCK LOST, EMPTY...)
      } else if (e.type === 'ordnanceSpent') {
        // P03C: one round spent = the saved count, saved at once (an event, never per frame); a reload never refills it
        profile = withOrdnance(profile, { ...profile.ordnance, [e.weapon]: e.left });
        save();
      } else if (e.type === 'detonation') {
        cue(e);
        const fx = WEAPON_BY_ID.get(e.weapon);
        const ms = fx && fx.fire === 'ordnance' ? Math.max(260, (fx.effect.ringTicks * 1000) / 60) : 300;
        if (e.r > 0) waves.push({ x: e.x, y: e.y, r: e.r, startMs: lastFrameTs, ms, double: e.weapon === 'nuke' });
        if (waves.length > 8) waves.shift(); // bounded presentation effect
        bursts.push({ x: e.x, y: e.y, startMs: lastFrameTs, size: e.weapon === 'nuke' ? 4 : e.weapon === 'heavy-missile' ? 3 : 2 });
        if (bursts.length > 16) bursts.shift();
      } else if (e.type === 'dilation') {
        if (e.state === 'start') showNotice('info', 'TIME DILATION', 'HOSTILES NEAR THE BLAST AT HALF SPEED · 2 s', 1800);
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
          const need = lane ? travelCost(admin, hopCells(lane.cost, craft.stats.travel)) : 0;
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
  const LAB_EVENTS: ReadonlySet<SectorEvent['type']> = new Set(['hit', 'fired', 'overheated', 'weaponCooled', 'struck', 'destroyed', 'telegraph', 'blast', 'shotDown', 'disabled', 'missileLock', 'missileLockLost', 'missileRefused', 'missileLaunched', 'missileHit', 'missileExpired', 'missileReady', 'weaponSwitched', 'detonation', 'dilation']); // never ordnanceSpent: the lab saves nothing
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
      // every pause starts compact: groups closed, focus on RESUME
      pauseOpen = null;
      pauseReturn = null;
      paintPauseGroups();
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
      settleZoom();
      bursts.length = 0;
    waves.length = 0;
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
      const need = travelCost(admin, routeCells(r.plan.lanes, craft.stats.travel));
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
      settleZoom();
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
    /** P04.2 guide: the HOW TO PLAY guide over the pause menu, opened on the controls for the input in use (live bindings). */
    howTo: (): void => {
      if (panel !== 'pause' || !guide || guide.isOpen()) return;
      services.sound.play('uiSelect');
      const used = container.dataset['input'];
      const input: GuideInput = used === 'touch' ? 'touch' : pad.connected > 0 && used !== 'keyboard' ? 'controller' : 'keyboard';
      const classicGate = parseRecord(services.store.read(FLEET_SPEC.key), FLEET_SPEC).data.classicComplete || classicRecordShowsGate(services.store);
      guide.open({
        kind: 'reference',
        context: { mode: 'freeroam', input, bindings: controls.bindings, mouseAim: controls.mouseAim, classicGate },
        step: 'controls',
        canPlay: false,
        // the Guild marks step points at the live balance on the ship card (measured; skipped if hidden or covered)
        highlight: (step) => (step === 'marks' ? container.querySelector('.fr-marks') : null),
      });
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
  const adminCommand = (c: PanelCommand): void => {
    const m = c === 'prev' || c === 'next' || c === 'confirm' || c === 'back' ? c : c === 'pause' ? 'back' : null;
    if (m) adminPanel?.command(m);
  };
  const savesCommand = (c: PanelCommand): void => {
    const m: SavesCommand | null = c === 'prev' || c === 'next' || c === 'confirm' || c === 'back' ? c : c === 'pause' ? 'back' : null;
    if (m) saves.command(m);
  };
  const BLOCKED = 'browser storage is full or blocked';
  const ADMIN_SAVES = 'Admin Access is active: this sandbox is never saved. Exit Admin Access to return to your normal save.';
  const ADMIN_SLOTS = 'Exit Admin Access first: save slots do not change during an admin session.';
  const savesDeps: SavesDeps = {
    view: () => ({ slots: readSlots(services.store), active: saveSlotNo, persistent: services.store.persistent, writable, lastSaveAt, lastSaveFailed }),
    names: slotNames,
    saveNow: () => {
      if (isAdmin(admin)) return ADMIN_SAVES;
      if (!writable) return 'This slot is read-only here: nothing was saved.';
      if (!persist()) return `Saving FAILED (${BLOCKED}). The game keeps running and tries again at the next save.`;
      return services.store.persistent ? `Saved to slot ${saveSlotNo}.` : `Saved to slot ${saveSlotNo} for this tab only (browser storage is unavailable).`;
    },
    load: (n) => {
      if (isAdmin(admin) && n !== saveSlotNo) return ADMIN_SLOTS;
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
      if (isAdmin(admin)) return ADMIN_SLOTS;
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
      if (isAdmin(admin)) return ADMIN_SLOTS;
      if (n === saveSlotNo) return 'The slot in use cannot be deleted: load another slot first.';
      return deleteSlot(services.store, n) ? `Slot ${n} deleted.` : `Could not delete slot ${n} (${BLOCKED}).`;
    },
    close: closeSaves,
    sound: panelSound,
  };

  /* ------------------------------ Admin Access (P04) ------------------------------ */
  /*
   * A hidden owner sandbox (docs/development/ADMIN_ACCESS.md). The rules are in admin/session.ts;
   * this shell only applies them at the points where the normal rules live: the save gateway
   * (save), the cross-mode registry (setFleet), the cell costs (travelCost), ship switching and
   * the Admin Navigator's travel. Exiting restarts Free Roam from the untouched slot.
   */
  /** Where the hidden sequence is accepted: the galaxy / system maps and the docked station screens (never in flight). */
  const adminContext = (): boolean => {
    if (lifecycle === 'created' || lifecycle === 'disposed') return false;
    if (saves.isOpen() || capture || adminLogin) return false;
    if (screen === 'map' || screen === 'systems') return true;
    return screen === 'flight' && run !== null && run.docked !== null && (panel === 'station' || panel === 'hangar' || panel === 'armory');
  };
  /** Capture-phase keydown: observes only; it consumes nothing but the key that completes the sequence (and F8 during a session). */
  const onAdminKey = (e: KeyboardEvent): void => {
    if (isAdmin(admin)) {
      // F8: open / close the admin panel (a session control; not the activation)
      if (e.code === 'F8' && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !isEditableTarget(e.target)) {
        e.preventDefault();
        if (adminPanel?.isOpen()) closeAdmin();
        else openAdmin('');
      }
      return;
    }
    if (e.isComposing || isEditableTarget(e.target) || !adminContext()) {
      adminKeys.reset();
      return;
    }
    if (adminKeys.feed({ code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat, t: e.timeStamp })) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openLogin(screen === 'flight' ? 'station' : screen === 'systems' ? 'systems' : 'map');
    }
  };
  const ADMIN_UNSAFE = 'Ships switch at a safe place, as in normal play: dock at a station (HANGAR below takes you to one), open a map, or pick one during a sector briefing.';
  const adminShipSafe = (): { readonly ok: boolean; readonly why: string } => {
    if (__GALAXIA_GRAVITY_LAB__ && lab) return { ok: false, why: 'Leave the gravity test first.' };
    if (!run || canSwitchShip(run) || run.phase === 'briefing') return { ok: true, why: '' };
    return { ok: false, why: ADMIN_UNSAFE };
  };
  const placeName = (galaxy: string, system: string): string => `${graph.system(system)?.name ?? system} · ${galaxyName(galaxy)}`;
  const adminShipRows = (): AdminShipRowList => {
    const only = adminOnlyShips(admin);
    return SHIPS.map((ship) => {
      const st = upgradedShip(ship.id, loadoutOf(fleet, ship.id), levelsOf(ship.id)).stats;
      const stats = (['hull', 'shield', 'maxSpeed', 'cargo', 'travel'] as const).map((k) => `${STAT_LABEL[k]} ${formatStat(k, st[k])}`).join(' · ');
      return {
        id: ship.id,
        name: ship.name,
        role: ship.role,
        access: ship.id === fleet.active ? 'flying' : only.has(ship.id) ? 'admin' : 'owned',
        stats,
        weapons: compatibleWeapons(ship.id).map((w) => WEAPON_BY_ID.get(w)!.name).join(', '),
      } as const;
    });
  };
  /** Travel straight to a catalogue destination (no unlock, route or fuel requirement), through the normal sector entry. */
  const adminTravel = (ref: DestinationRef): string => {
    const d = resolveDestination(admin, graph, ref);
    if (!d.ok) return DESTINATION_TEXT[d.reason];
    const before = progress;
    try {
      commitProgress(adminArrive(progress, d));
      mapReturn = 'system';
      pendingResume = null;
      moment('jump');
      enterSector(d.system.id, undefined, 'briefing', d.arrival === 'station' ? stationApproach : undefined);
      refreshBriefing();
      showScreen('flight');
      showPanel('briefing');
    } catch (err) {
      // never half-way: no sector, the previous position, a map on screen
      leaveSector();
      commitProgress(before);
      showScreen('systems');
      return `Could not load ${d.system.name}: ${err instanceof Error ? err.message : String(err)}. You are back on the system map.`;
    }
    closeAdmin();
    return '';
  };
  const adminSelect = (id: string): string => {
    const safe = adminShipSafe();
    const r = adminSelectShip(admin, fleet, id, safe.ok);
    if (!r.ok) return r.reason === 'unsafe' ? safe.why : r.reason === 'active' ? 'Already flying that ship.' : 'That ship does not exist in this build.';
    setFleet(r.fleet);
    if (run) {
      applyShip(run, craft);
      run.cargoSpace = holdFree();
      lastKey = '';
      if (run.phase === 'briefing') refreshBriefing();
    }
    return `Now flying the ${shipName()}${adminOnlyShips(admin).has(fleet.active) ? ' (admin access: not owned, not saved)' : ''}. Its weapon mounts are its own.`;
  };
  /** HANGAR: the real hangar when docked; otherwise straight to the nearest station (dock there with INTERACT). */
  const adminHangar = (): string => {
    if (run?.docked && !(__GALAXIA_GRAVITY_LAB__ && lab)) {
      closeAdmin();
      openStation('hangar');
      return '';
    }
    const hops = systemGraph(graph, progress.current).hops(progress.system);
    const far = (id: string): number => hops.get(id) ?? Number.MAX_SAFE_INTEGER;
    const near = graph
      .systemsIn(progress.current)
      .filter((x) => x.sector.station)
      .sort((a, b) => far(a.id) - far(b.id) || (a.id < b.id ? -1 : 1))[0];
    const target = near ?? graph.systemsIn(graph.start).find((x) => x.sector.station);
    if (!target) return 'No station exists in the game data.';
    return adminTravel({ galaxy: target.galaxyId, system: target.id, arrival: 'station' });
  };
  const adminDeps: AdminPanelDeps = {
    view: () => ({
      origin: admin ? `${SHIP_BY_ID.get(admin.origin.ship)!.name} at ${placeName(admin.origin.galaxy, admin.origin.system)}` : '',
      here: `${shipName()} · ${placeName(progress.current, run ? run.layout.systemId : progress.system)}`,
      hereGalaxy: progress.current,
      shipSwitch: adminShipSafe(),
    }),
    galaxies: () => navigatorGalaxies(deriveView(graph, admin ? admin.normalProgress : progress)),
    systems: (galaxy, query) => navigatorSystems(deriveView(graph, admin ? admin.normalProgress : progress), galaxy, query),
    ships: adminShipRows,
    travel: adminTravel,
    selectShip: adminSelect,
    hangar: adminHangar,
    exit: () => exitAdmin(),
    close: () => closeAdmin(),
    sound: (cue) => services.sound.play(cue),
  };
  const buildAdminUi = (): void => {
    if (adminPanel) return;
    adminPanel = createAdminPanel(adminDeps);
    container.append(adminPanel.root);
    // a small ADMIN chip on each screen while the session lasts (created only now: never in ordinary play)
    const chip = (): HTMLButtonElement => {
      const b = el('button', 'fr-admin-chip', 'ADMIN');
      b.type = 'button';
      b.setAttribute('aria-label', 'Admin Access panel (sandbox session active)');
      b.addEventListener('click', () => {
        b.blur(); // keep Space / Enter for flight
        openAdmin('');
      });
      return b;
    };
    // the map titles give way to the chip on narrow screens (ellipsis instead of running under it)
    for (const head of [map.head, systems.root.querySelector<HTMLElement>('.fr-map-head')]) {
      head?.classList.add('has-admin');
      head?.append(chip());
    }
    hudButtons.prepend(chip());
  };
  const openAdmin = (message: string): void => {
    if (!isAdmin(admin) || !adminPanel || saves.isOpen() || adminLogin) return;
    if (adminPanel.isOpen()) {
      adminPanel.refresh();
      return;
    }
    if (screen === 'flight' && run?.phase === 'flight' && !panel) actions.pause(); // the flight pauses under the panel
    adminReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keys.clear();
    pointers.reset();
    for (const n of [map.root, systems.root, flightRoot]) n.inert = true;
    container.dataset['adminPanel'] = 'open';
    adminPanel.open(message);
  };
  const closeAdmin = (): void => {
    if (!adminPanel?.isOpen()) return;
    adminPanel.hide();
    for (const n of [map.root, systems.root, flightRoot]) n.inert = false;
    delete container.dataset['adminPanel'];
    keys.clear();
    clock.resetTiming();
    const back = adminReturn;
    adminReturn = null;
    // the hangar re-reads the fleet (a ship chosen in the admin panel, ADMIN labels)
    if (panel === 'hangar' && run?.docked) hangar.open(dockLabel);
    else if (back && back.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll: true });
    else if (panel) menus[panel].focus();
  };
  /**
   * Start the session (after a correct login): the normal state is saved
   * first, then nothing is written until the session ends.
   */
  const beginSession = (from: AdminSession['from']): void => {
    if (isAdmin(admin)) return;
    persist(); // the slot now holds exactly what exiting restores
    admin = beginAdmin(fleet, progress, from);
    setFleet(adminFleet(fleet)); // every roster ship usable in the sandbox (the save is not touched)
    // sandbox ammunition: launches spend no round and no energy (the counts themselves are untouched)
    if (run) setRunUnlimitedAmmo(run, true);
    container.dataset['admin'] = 'on';
    buildAdminUi();
    refreshBriefing();
  };
  /**
   * The login's destination: Sol (milky-way/sol), beside its Haven Guild
   * station, docked, HANGAR tab. Catalogue-resolved like any admin trip; the
   * arrival is START FLIGHT (without its sound: the reveal is the moment)
   * followed by the normal docking. Returns '' or what went wrong (the
   * session stays on and the admin panel opens with the message).
   */
  const adminHomeHangar = (): string => {
    const d = resolveDestination(admin, graph, ADMIN_HOME);
    if (!d.ok) return `Could not open the Sol hangar: ${DESTINATION_TEXT[d.reason]} Admin Access is active; use the navigator.`;
    const before = progress;
    try {
      commitProgress(adminArrive(progress, d));
      mapReturn = 'system';
      pendingResume = null;
      enterSector(d.system.id, undefined, 'briefing', stationApproach);
      const r = run as SectorRun | null;
      if (!r) throw new Error('the sector did not start');
      refreshBriefing();
      showScreen('flight');
      resumeSector(r);
      snapCamera(cam, r.ship.x, r.ship.y);
      clock.resetTiming();
      showPanel(null);
      arrivalMs = lastFrameTs;
      const ev = dockIfInRange(r);
      if (!ev.some((e) => e.type === 'docked')) throw new Error('the station was out of docking range');
      handleEvents(r, ev); // the normal docking: repairs, magazines, station overview, flight paused
      openStation('hangar');
      return '';
    } catch (err) {
      if (run) leaveSector();
      commitProgress(before);
      refreshBriefing();
      showScreen('map');
      return `Could not open the Sol hangar: ${err instanceof Error ? err.message : String(err)}. Admin Access is active; use the navigator.`;
    }
  };
  /** The hidden activation opens the login screen; only a correct password starts the session. */
  const openLogin = (from: AdminSession['from']): void => {
    if (isAdmin(admin) || adminLogin || saves.isOpen() || lifecycle === 'disposed') return;
    loginReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const login = createAdminLogin({
      seed: randomSeed(),
      reducedMotion,
      sound: (cue) => moment(cue === 'deny' ? 'refused' : 'upgrade'),
      arrive: () => {
        beginSession(from);
        return adminHomeHangar();
      },
      done: (error) => closeLogin(error, true),
      abort: () => closeLogin('', false),
    });
    adminLogin = login;
    adminKeys.reset();
    loginInert = [...container.children].filter((n): n is HTMLElement => n instanceof HTMLElement).map((n) => [n, n.inert] as const);
    for (const [n] of loginInert) n.inert = true;
    container.append(login.root);
    container.dataset['adminLogin'] = 'open';
    keys.clear();
    pointers.reset();
    login.open(performance.now());
  };
  const closeLogin = (error: string, success: boolean): void => {
    const login = adminLogin;
    if (!login) return;
    adminLogin = null;
    login.destroy();
    for (const [n, was] of loginInert) n.inert = was;
    loginInert = [];
    delete container.dataset['adminLogin'];
    keys.clear();
    pointers.reset();
    clock.resetTiming();
    const back = loginReturn;
    loginReturn = null;
    if (success && error) openAdmin(error);
    else if (success && panel === 'hangar' && run?.docked) hangar.open(dockLabel); // focus could not land while the screen was up
    else if (!success && back && back.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll: true });
    else if (panel) menus[panel].focus();
  };
  /** End the session: discard the sandbox and restart Free Roam from the untouched normal save. */
  const exitAdmin = (): void => {
    if (!isAdmin(admin)) return;
    adminPanel?.hide();
    adminKeys.reset();
    writable = false; // this instance never writes again (the session also blocks every write until it is gone)
    ctx.requestRestart(); // the fresh instance re-reads the slot: normal ship, place, ownership and rules
  };

  /* ---------------------------- pause menu groups --------------------------- */
  const PAUSE_REVEAL_GUARD_MS = 350;
  const PAUSE_ICON: Record<PauseGroup, string> = {
    progress: '<path d="M6 21V4M6 4h11l-2.5 4L17 12H6"/>',
    settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    navigation: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2.2 4.8-4.8 2.2 2.2-4.8z"/>',
  };
  const svgIcon = (cls: string, paths: string): string =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const paintPauseGroups = (): void => {
    for (const g of pauseGroups) {
      const open = g.id === pauseOpen;
      g.head.setAttribute('aria-expanded', String(open));
      g.box.classList.toggle('is-open', open);
      g.body.hidden = !open;
    }
  };
  /** Open a group (closing the others) or close it again; focus stays on the group row. */
  const togglePauseGroup = (id: PauseGroup): void => {
    if (panel !== 'pause') return;
    closeRestartAsk(false);
    pauseOpen = pauseOpen === id ? null : id;
    pauseOpenedAt = pauseOpen ? performance.now() : -Infinity;
    paintPauseGroups();
    services.sound.play(pauseOpen ? 'uiSelect' : 'uiMove');
    const g = pauseGroups.find((x) => x.id === pauseOpen);
    // a short screen: bring the opened actions into the panel's scroll view (no-op when they already fit)
    if (g) g.box.scrollIntoView({ block: 'nearest' });
  };
  function openRestartAsk(): void {
    if (panel !== 'pause' || !run) return;
    services.sound.play('uiSelect');
    restartBtn.hidden = true;
    restartAsk.hidden = false;
    restartNo.focus({ preventScroll: true }); // the safe choice is under the cursor
  }
  function closeRestartAsk(refocus: boolean): void {
    if (!restartAsk || restartAsk.hidden) return;
    restartAsk.hidden = true;
    restartBtn.hidden = false;
    if (refocus) {
      services.sound.play('uiMove');
      restartBtn.focus({ preventScroll: true });
    }
  }
  function confirmRestart(): void {
    if (panel !== 'pause' || restartAsk.hidden) return;
    closeRestartAsk(false);
    actions.restart(); // the existing restart path, unchanged
  }
  const pauseButton = (cls: string, label: string, fn: () => void): HTMLButtonElement => {
    const b = el('button', `fr-btn ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };
  /** Fill the pause panel's menu list (its MenuList already roves over every visible button inside). */
  const fillPauseMenu = (list: HTMLElement): void => {
    list.classList.add('fr-pause-menu');
    const top = el('div', 'fr-pause-top');
    const resume = pauseButton('fr-pause-resume', 'RESUME', actions.resume);
    restartBtn = pauseButton('fr-pause-restart', 'RESTART FLIGHT', openRestartAsk);
    restartAsk = el('div', 'fr-pause-ask');
    restartAsk.setAttribute('role', 'group');
    restartAsk.hidden = true;
    const askText = el('p', 'fr-pause-ask-text', 'Restart from the arrival zone? Shields and hull are restored; the flight clock and this sector\'s hostiles reset. Cargo and completed work are kept.');
    askText.id = 'fr-pause-ask-text';
    restartAsk.setAttribute('aria-labelledby', askText.id);
    const askRow = el('div', 'fr-pause-ask-row');
    restartNo = pauseButton('fr-pause-ask-no', 'CANCEL', () => closeRestartAsk(true));
    askRow.append(pauseButton('fr-pause-ask-yes', 'RESTART', confirmRestart), restartNo);
    restartAsk.append(askText, askRow);
    top.append(resume, restartBtn, restartAsk);
    const groupsBox = el('div', 'fr-pause-groups');
    const defs: readonly { id: PauseGroup; label: string; items: readonly [string, () => void][] }[] = [
      { id: 'progress', label: 'MISSIONS & PROGRESS', items: [['MISSIONS', () => actions.log('missions')], ['RECORD', () => actions.log('record')], ['SAVES', openSaves]] },
      { id: 'settings', label: 'SETTINGS & HELP', items: [['CONTROLS', actions.controls], ['HOW TO PLAY', actions.howTo], ['SOUND', actions.sound]] },
      { id: 'navigation', label: 'NAVIGATION', items: [['GALAXY MAP', actions.openMap], ['MAIN MENU', actions.exit]] },
    ];
    const built: { id: PauseGroup; box: HTMLElement; head: HTMLButtonElement; body: HTMLElement }[] = [];
    for (const d of defs) {
      const box = el('div', 'fr-pause-group');
      box.dataset['group'] = d.id;
      const head = el('button', 'fr-btn fr-pause-head');
      head.type = 'button';
      head.id = `fr-pause-${d.id}`;
      head.setAttribute('aria-expanded', 'false');
      head.setAttribute('aria-controls', `fr-pause-${d.id}-items`);
      head.innerHTML = `${svgIcon('fr-pause-icon', PAUSE_ICON[d.id])}<span class="fr-pause-head-text"><span class="fr-pause-head-label"></span><span class="fr-pause-head-sum"></span></span>${svgIcon('fr-pause-chev', '<path d="M9 6l6 6-6 6"/>')}`;
      head.querySelector('.fr-pause-head-label')!.textContent = d.label;
      head.querySelector('.fr-pause-head-sum')!.textContent = d.items.map(([l]) => l).join(' · ');
      head.addEventListener('click', () => togglePauseGroup(d.id));
      const body = el('div', 'fr-pause-items');
      body.id = `fr-pause-${d.id}-items`;
      body.setAttribute('role', 'group');
      body.setAttribute('aria-labelledby', head.id);
      body.hidden = true;
      for (const [label, fn] of d.items) {
        const b = el('button', 'fr-btn fr-pause-item', label);
        b.type = 'button';
        b.addEventListener('click', (e) => {
          // the second click of a double click on the group row must not land on an action it just revealed
          // (pointer clicks only: keyboard / pad activation has detail 0 and is never delayed)
          if (e.detail > 0 && performance.now() - pauseOpenedAt < PAUSE_REVEAL_GUARD_MS) return;
          pauseReturn = b;
          fn();
        });
        body.append(b);
      }
      box.append(head, body);
      groupsBox.append(box);
      built.push({ id: d.id, box, head, body });
    }
    pauseGroups = built;
    list.append(top, groupsBox);
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
      else if (panel === 'armory') armory.back();
      else if (panel === 'fabricator') fabricator.back();
      else if (panel === 'missions') missionsPanel.back();
      else if (panel === 'exchange') exchangePanel.back();
      else if (panel === 'upgrades') upgradesPanel.back();
      else if (panel === 'record') recordPanel.back();
      else if (panel === 'pause' && !restartAsk.hidden) closeRestartAsk(true);
      else if (panel === 'pause' || panel === 'sectormap' || panel === 'cargo') actions.resume();
      else if (panel === 'gate') actions.stay();
      else if (panel === 'controls') actions.closeControls();
      else if (panel === 'briefing' && c === 'back') actions.openMap();
    } else if (c === 'map' && panel === 'sectormap') actions.resume();
    else if (c === 'cargo' && panel === 'cargo') actions.resume();
    else if (c === 'restart' && panel === 'pause') {
      // R in the pause menu asks first (as the button does); R again, or RESTART, confirms
      if (restartAsk.hidden) openRestartAsk();
      else confirmRestart();
    } else if (c === 'restart' && panel === 'complete') actions.restart();
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
    // P04.3: a mode change applies to the run at once (pose, velocity, lock and weapons carry over; STOP is cleared)
    if (c.flightMode !== undefined && run) {
      setRunFlightMode(run, controls.flightMode);
      stopPending = false;
      refreshHint();
    }
    if (c.bindings) keys.setCodes(allCodes(controls.bindings));
    if (prefsWritable && !saveFreeRoamPrefs(services.store, { controls })) services.reportStorageProblem('write-failed');
    if (c.zoom !== undefined) {
      // a key, a button, a reset or the deferred wheel write: the view shows exactly the saved zoom
      shownZoom = controls.zoom;
      zoomSaveAt = null;
    }
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
    for (const m of ['normal', 'realistic'] as const) {
      const on = controls.flightMode === m;
      modeBtns[m].setAttribute('aria-pressed', String(on));
      modeBtns[m].classList.toggle('is-selected', on);
    }
    modeDesc.textContent = controls.flightMode === 'realistic' ? `${FLIGHT_MODE_TEXT.realistic} ${FLIGHT_MODE_TEXT.stop} (${keyLabel(controls.bindings.stop[0])} or the STOP button.)` : `${FLIGHT_MODE_TEXT.normal} ${FLIGHT_MODE_TEXT.stopNormal}`;
    const adv = controls.advice === 'critical' ? 'critical' : 'all';
    for (const m of ['all', 'critical'] as const) {
      adviceBtns[m].setAttribute('aria-pressed', String(adv === m));
      adviceBtns[m].classList.toggle('is-selected', adv === m);
    }
    adviceDesc.textContent = adv === 'critical' ? 'Ship Mind and crew speak only for critical warnings (low hull, an imminent collision).' : 'Ship Mind and crew advise in flight: hazards, gravity, contacts and sensor finds. Critical warnings always show.';
    const simple = controls.simpleSignals === true;
    for (const m of ['standard', 'simple'] as const) {
      signalBtns[m].setAttribute('aria-pressed', String(simple === (m === 'simple')));
      signalBtns[m].classList.toggle('is-selected', simple === (m === 'simple'));
    }
    signalDesc.textContent = simple
      ? 'Simple Signals: one valid bearing resolves an anomaly. You still need sensor range, under 60 speed, a steady 0.8 s hold and a clear line.'
      : 'Anomaly signals need bearings from two angles at least 35° apart (the fifth bearing always resolves).';
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
    lockPending = false;
    targetPending = false;
    if (zoomSaveAt !== null) setControls({ zoom: controls.zoom }); // a wheel zoom still waiting to be saved
    clock.resetTiming();
    if (why === 'orientation') status.orientationChanges += 1;
    if (run?.phase === 'flight') actions.pause();
  };

  /* ------------------------------ flight HUD ------------------------------- */
  /** Reactor cells short of any jump from here (the existing emergency rule; memoised). */
  const cellsShort = (r: SectorRun): boolean => {
    if (isAdmin(admin)) return false;
    const key = `${held()}|${r.layout.systemId}|${craft.stats.travel}|${progress.charted.length}|${progress.visitedSystems.length}`;
    if (cellsShortCache?.key !== key) {
      const sv = deriveSystemView(deriveView(graph, progress), galaxyOf(r.layout.systemId) as GalaxyId);
      cellsShortCache = { key, short: emergencyCells(held(), sv.graph, r.layout.systemId, craft.stats.travel, false) > 0 };
    }
    return cellsShortCache.short;
  };
  /* ---------------------------- P05.2 advisory ----------------------------- */
  /** Identity of one sector visit (a new run is a new visit). */
  const visitKey = (r: SectorRun): string => {
    let n = visitIds.get(r);
    if (n === undefined) {
      n = ++visitCount;
      visitIds.set(r, n);
    }
    return `${r.layout.systemId}#${n}`;
  };
  /** The specialists on duty: read from the frozen crew view of the flown ship (memoised). */
  const advisorCrewNow = (): AdvisorCrew => {
    const doctrine = crew.doctrine ?? 'balanced';
    const key = `${crewView.ship}|${crewView.members.map((m) => m.id).join(',')}|${doctrine}`;
    if (advisorCrewCache?.key !== key) advisorCrewCache = { key, crew: advisorCrew(crewView, doctrine) };
    return advisorCrewCache.crew;
  };
  /** Reactor cells and the cheapest / dearest lane out of this system (memoised; none under Admin Access). */
  const routeInfo = (r: SectorRun): { readonly cells: number; readonly cheapest: number; readonly dearest: number } | null => {
    if (isAdmin(admin)) return null;
    const key = `${held()}|${r.layout.systemId}|${craft.stats.travel}|${progress.charted.length}|${progress.visitedSystems.length}`;
    if (routeCache?.key !== key) {
      const sv = deriveSystemView(deriveView(graph, progress), galaxyOf(r.layout.systemId) as GalaxyId);
      const h = hopRange(sv.graph, r.layout.systemId, craft.stats.travel);
      routeCache = { key, route: h.max > 0 ? { cells: held(), cheapest: h.min, dearest: h.max } : null };
    }
    return routeCache.route;
  };
  /** One advisory pass on the simulation's cadence (every ADVISOR.everyTicks ticks of flight). Reads the run only. */
  const adviseTick = (r: SectorRun): void => {
    const visit = visitKey(r);
    if (advice.sector === visit && r.tick >= lastAdviceTick && r.tick - lastAdviceTick < ADVISOR.everyTicks) return;
    lastAdviceTick = r.tick;
    const ac = advisorCrewNow();
    const nav = ac.navigator?.traits ?? null;
    lastObservation = observe(r, forecaster, {
      visit,
      horizonS: Math.max(SHIP_MIND.impactHorizonS, nav?.horizonS ?? 0),
      escape: nav ? { candidates: nav.escapeCandidates, doctrine: nav.doctrine } : null,
      route: routeInfo(r),
    });
    advice = evaluateAdvice(advice, lastObservation, ac, controls.advice === 'critical' ? 'critical' : 'all');
  };
  /**
   * Show the advice. Nothing while paused or under a panel (map, controls): the message on screen is parked and
   * re-evaluated once when flight resumes (parkAdvisor). Docked, wrecked or outside flight: cleared, and
   * not repeated while its condition holds (quietAdvisor).
   */
  const renderAdvice = (r: SectorRun | null): void => {
    if (!advisorStrip) return;
    if (!r || (r.phase !== 'flight' && r.phase !== 'paused') || r.docked !== null) {
      advice = quietAdvisor(advice); // unchanged (same object) when nothing is shown, queued or parked
      advisorStrip.render(null);
      return;
    }
    if (panel || r.phase === 'paused' || screen !== 'flight') {
      advice = parkAdvisor(advice); // unchanged (same object) when nothing is shown or queued
      advisorStrip.render(null);
      return;
    }
    advisorStrip.render(advisorView(advice));
  };
  const weaponName = (): string => {
    const id = loadoutOf(fleet, fleet.active).weapon[0] ?? '';
    if (weaponCache?.key !== id) weaponCache = { key: id, name: EQUIPMENT_BY_ID.get(id)?.name ?? 'Weapon' };
    return weaponCache.name;
  };
  /** P03C: the selected weapon as the HUD card and the WPN button show it (the gun keeps its module name in the header). */
  const weaponCard = (r: SectorRun): MissileCardInput => {
    const id: PilotWeaponId = r.arsenal.selected;
    const w = WEAPON_BY_ID.get(id)!;
    const ord = w.fire === 'ordnance' ? w : null;
    const lockTicks = ord && ord.guidance.kind === 'lock' ? ord.guidance.acquire.lockTicks : MISSILE.lockTicks;
    return {
      label: w.short,
      feed: w.ammo.kind === 'unlimited' ? 'gun' : w.ammo.kind,
      stock: r.ammo[id] ?? 0,
      capacity: w.ammo.kind === 'stock' ? w.ammo.capacity : 0,
      state: r.missile.state === 'acquiring' ? 'acquiring' : r.arsenal.cooldown[id] > 0 ? 'cooldown' : 'ready',
      lock: r.missile.lock,
      lockTicks,
      cooldown: r.arsenal.cooldown[id],
      cooldownTicks: ord ? ord.cooldownTicks : 1,
      inFlight: r.missiles.some((m) => m.weapon === id),
      gate: gateOf(r, id),
      notice: r.missile.noticeWeapon === id || r.missile.noticeWeapon === null ? r.missile.notice : null,
      unlimited: r.unlimitedAmmo,
    };
  };
  /** Revealed, unfinished points of interest (the survey marks have the objective arrow). */
  const nearbyCandidates = (r: SectorRun): PoiCandidate[] => {
    const out: PoiCandidate[] = [];
    for (const p of r.layout.pois) {
      if (p.kind === 'survey' || !r.revealed.has(p.id) || isDone(r, p)) continue;
      const at = p.kind === 'anomaly' ? signalPoint(r, p) : p; // P06.1: a resolved signal points at its fix
      out.push({ id: p.id, label: p.kind === 'gate' ? r.gates[p.id]?.label ?? p.label : p.label, x: at.x, y: at.y });
    }
    return out;
  };
  /** Economy pass: the HUD balance, from the wallet (a small change counts up; the +N / −N tag fades). */
  const marksReadout = (ts: number): MarksReadout => {
    const t = tickerValue(prog.marks, marksFx.delta, ts - marksFx.at, reducedMotion());
    return { value: `${MARKS.glyph} ${groupDigits(t.shown)}`, tag: t.tag ? formatDelta(marksFx.delta) : '', sign: !t.tag ? '' : marksFx.delta > 0 ? 'gain' : 'loss', serial: marksFx.serial, spoken: spokenMarks(prog.marks) };
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
      card: shipCard({ ship: SHIP_BY_ID.get(r.craft.ship)!.name, weapon: r.arsenal.selected === 'plasma' ? weaponName() : WEAPON_BY_ID.get(r.arsenal.selected)!.short, firing, docked: r.docked !== null, shield: r.shield, shieldMax: r.craft.stats.shield, hull: r.hull, hullMax: r.craft.stats.hull, energy: r.energy, energyMax: r.craft.stats.energy, boosting: r.boosting, heat: r.heat, overheated: r.overheated, missile: weaponCard(r) }),
      location: { name: hereName, galaxy: galaxyShort, survey: surveyText(r), surveyed: r.surveyed },
      view,
      objective: tracked?.text ?? null,
      objectiveHere: tracked?.here ?? false,
      cargo: cargoText(used, cap, cells),
      notice: panel ? null : notices.current,
      marks: marksReadout(ts),
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
    if (adminLogin) {
      // P04: the hidden login is modal over everything: it reads its own field; the game takes no press
      keys.takePresses();
      const login = adminLogin;
      const arrivedBefore = login.status().arrived;
      for (const c of panelPadCommands(update)) if (c === 'back') login.back();
      login.frame(ts);
      if (!arrivedBefore) {
        if (panel === 'hangar') hangar.frame(ts);
        status.frames += 1;
        lastTs = ts;
        surface?.sample(ts, 0, false);
        return;
      }
      // the fade onto the arrival: the docked station draws underneath (input stays with the screen until it goes)
    }
    if (guide?.isOpen()) {
      // P04.2 guide: the HOW TO PLAY guide is modal over the pause menu: it reads its own keys and pad; the game takes no press
      keys.takePresses();
      status.frames += 1;
      lastTs = ts;
      surface?.sample(ts, 0, false);
      return;
    }
    if (adminPanel?.isOpen()) {
      // P04: the admin panel is modal like the save slots panel: it takes every press; the flight stays paused
      for (const c of panelKeyCommands(keys.takePresses(), controls.bindings)) adminCommand(c);
      for (const c of panelPadCommands(update)) adminCommand(c);
      status.frames += 1;
      lastTs = ts;
      surface?.sample(ts, 0, false);
      return;
    }
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
        // P03C: NEXT WEAPON is one step per press; a FIRE tap shorter than a frame still reaches the trigger
        if (run?.phase === 'flight' && (binds.missile[0] === code || binds.missile[1] === code)) cyclePending = 1;
        // P04.1: LOCK TARGET (X) is one toggle per press (key repeat never reaches takePresses)
        if (run?.phase === 'flight' && (binds.lock[0] === code || binds.lock[1] === code)) lockPending = !lockPending;
        // P04.1 polish: NEXT TARGET (C) is one step per press (key repeat never reaches takePresses; two presses in one frame = one step)
        if (run?.phase === 'flight' && (binds.target[0] === code || binds.target[1] === code)) targetPending = true;
        // P04.3: STOP is one toggle per press (REALISTIC flight; in NORMAL the run only reports it unavailable)
        if (run?.phase === 'flight' && (binds.stop[0] === code || binds.stop[1] === code)) stopPending = !stopPending;
        // P07.1: SILENT RUNNING is one toggle per press
        if (run?.phase === 'flight' && binds.silent.includes(code)) silentPending = !silentPending;
        if (run?.phase === 'flight' && binds.ability.includes(code)) abilityPending = true;
        if (run?.phase === 'flight' && (binds.fire[0] === code || binds.fire[1] === code)) firePending = true;
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
    if (panel === 'hangar') hangar.frame(ts); // P03A: the bay preview animates on this loop (no timer of its own)
    else if (panel === 'armory') armory.frame(ts); // P03B: the plot redraws after a change or resize only
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
    // weapons (Combat P03C): NEXT WEAPON (key, R3, WPN) is an edge command, one step per press, latched so a
    // quick tap is never lost on a frame that runs no tick; nothing is latched behind a panel or outside flight
    const padW = padWeapon(snapshot);
    if (pointers.takeWeaponPress() && live) cyclePending = 1;
    if (pointers.takeLockPress() && live) lockPending = !lockPending;
    if (pointers.takeTargetPress() && live) targetPending = true;
    if (pointers.takeStopPress() && live) stopPending = !stopPending;
    if (pointers.takeSilentPress() && live) silentPending = !silentPending;
    if (pointers.takeAbilityPress() && live) abilityPending = true;
    const padS = padSilent(snapshot);
    if (padS && !padSilentWas && live) silentPending = !silentPending;
    padSilentWas = padS;
    if (padW && !padWeaponWas && live) cyclePending = 1;
    padWeaponWas = padW;
    const padF = padFire(snapshot);
    if (padF && !padFireWas && live) firePending = true;
    padFireWas = padF;
    if (!live) {
      cyclePending = 0;
      firePending = false;
      lockPending = false;
      targetPending = false;
      stopPending = false;
      silentPending = false;
      abilityPending = false;
    }
    const weaponKey = live && (keyboardWeapon(keys.heldCodes, binds) || padW || pointers.weaponHeld);
    let flight: SectorInput = aim ? { ...move, aimX: aim.x, aimY: aim.y, fire, boost } : { ...move, fire, boost };
    if (r.flightMode === 'realistic' && r.flight === null && live) {
      // P04.3 REALISTIC: rotate-and-thrust from the same keys, pad and joystick (sector/realisticFlight.ts realisticInput)
      const pv2 = padVector(snapshot);
      const tv = pv.stick;
      const sx = pv2.x + tv.x;
      const sy = pv2.y + tv.y;
      const sl = Math.hypot(sx, sy);
      flight = { ...realisticInput(keyboardVector(keys.heldCodes, binds), sl > 1 ? { x: sx / sl, y: sy / sl } : { x: sx, y: sy }, aim), fire, boost };
    }
    if (__GALAXIA_GRAVITY_LAB__ && lab) {
      // FR-TD-83: rotate-and-thrust in the gravity test only (the same keys, pad and joystick, mapped there)
      const kv = keyboardVector(keys.heldCodes, binds);
      const pv2 = padVector(snapshot);
      const tv = live ? pv.stick : { x: 0, y: 0 };
      const sx = pv2.x + tv.x;
      const sy = pv2.y + tv.y;
      const sl = Math.hypot(sx, sy);
      flight = lab.input({ keys: kv, stick: sl > 1 ? { x: sx / sl, y: sy / sl } : { x: sx, y: sy }, aim, fire, boost }, live);
    }
    lastInput = { moveX: move.moveX, moveY: move.moveY, aim, fire, boost, weaponKey, stickActive: pv.stickActive, fireTouches: pv.fireTouches, boostTouches: pv.boostTouches, weaponTouches: pv.weaponTouches, mouseFire: pv.mouseFire, keys: [...keys.heldCodes] };
    fireBtn.classList.toggle('is-active', pv.fireTouches > 0);
    paintFireHeat(r.heat, r.overheated);
    boostBtn.classList.toggle('is-active', pv.boostTouches > 0);
    paintMissileBtn(r, pv.weaponTouches);
    paintLockBtn(r, pv.lockTouches);
    paintTargetBtn(r, pv.targetTouches);
    let events: SectorEvent[] = [];
    batchShield = r.shield;
    // P06.1: Simple Signals (a pref) and the Surveyor on duty shape signal bearings; the pilot still takes each one
    const surveyor = memberWithRole(crewView, 'surveyor');
    setSignalOptions(r, { simple: controls.simpleSignals === true, assist: surveyor ? surveyorSpreadFactor(surveyor.attributes) : 1 });
    const alpha = clock.advance(ts, () => {
      if (r.phase !== 'flight' || run !== r) return;
      // one weapon step and a latched FIRE press go to the first tick of the frame only
      let f: SectorInput = cyclePending !== 0 ? { ...flight, cycle: cyclePending } : flight;
      if (firePending && !f.fire) f = { ...f, fire: true };
      if (lockPending) f = { ...f, lockToggle: true };
      if (targetPending) f = { ...f, targetCycle: true };
      if (stopPending) f = { ...f, stopToggle: true };
      if (silentPending) f = { ...f, silentToggle: true };
      if (abilityPending) f = { ...f, ability: true };
      stopPending = false;
      silentPending = false;
      abilityPending = false;
      cyclePending = 0;
      firePending = false;
      lockPending = false;
      targetPending = false;
      events = events.concat(stepSector(r, f));
      status.ticks += 1;
    });
    if (events.length > 0) handleEvents(r, events);
    if (run !== r || !art) return; // an event left the sector (exit beacon)
    // P07.2: STOP / SILENT and the stealth tag after this frame's ticks, so a FIRE or boost that ended Silent Running shows the same frame
    paintStopCtl(r, pv.stopTouches, pv.silentTouches, pv.abilityTouches);
    // P05.2: Ship Mind and crew advice on the simulation's own cadence (reads the run, never writes it)
    if (r.phase === 'flight' && !panel && r.docked === null) adviseTick(r);
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
    // P04.1: the displayed player zoom catches up with a wheel change (presentation only; bounded like controls.zoom)
    shownZoom = easeZoom(shownZoom, controls.zoom, realDt, reduced);
    if (zoomSaveAt !== null && ts - zoomSaveAt >= ZOOM_SAVE_MS) setControls({ zoom: controls.zoom });
    const zoom = cameraZoom(b.width, b.height, shownZoom) * framing;
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
    while (waves.length > 0 && ts - waves[0]!.startMs > waves[0]!.ms) waves.shift();
    while (wrecks.length > 0 && ts - wrecks[0]!.startMs > WRECK_MS) wrecks.shift();
    if (panel === 'sectormap') drawMapCanvas();

    // panels over a still scene: redraw only when something visible changed (no busy redraw while paused)
    const drawKey = `${b.width}x${b.height}|${r.phase}|${services.prefs.revision}|${panel}|${r.layout.systemId}|${zoom}|${r.pickups.length}|${r.offer?.id ?? ''}`;
    if (moving || drawKey !== lastKey || (st.active && !panel) || bursts.length > 0 || waves.length > 0 || wrecks.length > 0) {
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
        waves,
        wrecks,
        arrivalMs,
      });
      if (__GALAXIA_GRAVITY_LAB__ && lab) lab.draw(surface.ctx, view, { alpha: moving ? alpha : 1, ratio, reducedMotion: reduced });
      status.draws += 1;
    }
    if (__GALAXIA_GRAVITY_LAB__ && lab) lab.frame(panel !== null);
    hudModel = combatHud(r);
    combatView.render(panel ? null : hudModel);
    renderAdvice(r);
    renderHud(r, ts, live && !document.hidden, Math.hypot(move.moveX, move.moveY), fire);
    const focus = !panel && r.phase === 'flight' && r.focus ? r.layout.pois.find((p) => p.id === r.focus) : undefined;
    const prompt = focus ? `${poiVerb(r, focus, POI_RULES[focus.kind].verb).toUpperCase()} · ${(focus.kind === 'gate' ? r.gates[focus.id]?.label ?? focus.label : focus.label).toUpperCase()}` : '';
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
      // P03C: after the Classic Wave 20 milestone every slot flies the merged cross-mode fleet (modes/crossMode.ts)
      const savedFleet = fleetFromSaved(profile.fleet);
      const owned = mergeOwned(services.store, savedFleet.owned);
      setFleet(owned.length !== savedFleet.owned.length ? { ...savedFleet, owned: [...owned] } : savedFleet);
      // P05.1: the saved crew against the roster and the fleet (absent = no crew; loading never adds anyone)
      crew = crewFromSaved(profile.crew, fleet.owned).state;
      profile = withCrew(profile, crewToSaved(crew));
      crewView = shipCrewView(crew, fleet.active);
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
      missileBtn = el('button', 'fr-wpn', 'PLASMA');
      missileBtn.type = 'button';
      missileBtn.setAttribute('aria-label', 'Next weapon');
      // P04.1: LOCK (left side): a crosshair and one word; aria-pressed follows the real lock
      lockBtn = el('button', 'fr-lock');
      lockBtn.type = 'button';
      lockBtn.setAttribute('aria-label', 'Lock target (toggle)');
      lockBtn.setAttribute('aria-pressed', 'false');
      lockBtn.dataset['state'] = 'off';
      lockBtn.innerHTML = '<svg class="fr-lock-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg><span class="fr-lock-text">LOCK</span>';
      // P04.1 polish: NEXT TARGET, a compact chevron button beside LOCK, shown only while a lock holds
      targetBtn = el('button', 'fr-target');
      targetBtn.type = 'button';
      targetBtn.hidden = true;
      targetBtn.setAttribute('aria-label', 'Next target');
      targetBtn.dataset['state'] = 'off';
      targetBtn.innerHTML = '<svg class="fr-target-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 5l7 7-7 7M13 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      // P04.3: REALISTIC flight's mode tag and STOP button (hidden in NORMAL); the button names its state and how to release it
      flightCtl = el('div', 'fr-flightctl');
      flightCtl.hidden = true;
      stopBtn = el('button', 'fr-stop');
      stopBtn.type = 'button';
      stopBtn.dataset['state'] = 'off';
      stopBtn.setAttribute('aria-pressed', 'false');
      stopBtn.setAttribute('aria-label', 'Stop: brake, then hold position');
      stopState = el('span', 'fr-stop-state', 'STOP');
      const stopHint = el('span', 'fr-stop-hint');
      stopRelease = el('span', 'fr-stop-on', 'TAP TO RELEASE');
      stopHint.append(stopRelease, el('span', 'fr-stop-off', 'BRAKE · HOLD'));
      stopBtn.append(stopState, stopHint);
      // P07.2: SILENT (every flight mode) and the stealth tag stack above (the column runs bottom-up), so STOP never moves
      modeTag = el('span', 'fr-flightmode-tag', 'REALISTIC FLIGHT');
      silentBtn = el('button', 'fr-stop fr-silent');
      silentBtn.type = 'button';
      silentBtn.append(el('span', 'fr-stop-state'), el('span', 'fr-stop-hint'));
      stealthTag = el('span', 'fr-flightmode-tag fr-stealth');
      stealthTag.hidden = true;
      abilityBtn = el('button', 'fr-stop fr-ability');
      abilityBtn.type = 'button';
      abilityBtn.append(el('span', 'fr-stop-state'), el('span', 'fr-stop-hint'));
      flightCtl.append(stopBtn, modeTag, silentBtn, abilityBtn, stealthTag);
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
        levels: (id) => levelsOf(id),
        safe: () => run !== null && canSwitchShip(run),
        adminOnly: () => adminOnlyShips(admin),
        balance: () => formatMarks(prog.marks),
        bridge: {
          model: (ship) => bridgeModel(bridgeCtx(ship)),
          act: crewAct,
          sound: panelSound,
        },
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
        armory: () => openStation('armory'),
        sound: panelSound,
        glow: () => services.prefs.get().display.glow,
        reducedMotion,
      });
      armory = createArmoryPanel({
        sprites: services.sprites,
        fleet: () => fleet,
        ordnance: () => profile.ordnance,
        craft: () => craft,
        // the start weapon and cycle are fleet data: stored in the profile and saved at once
        commit: (f) => {
          setFleet(f);
          save();
        },
        back: () => openStation('hangar'),
        sound: panelSound,
        glow: () => services.prefs.get().display.glow,
        balance: () => formatMarks(prog.marks),
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
        commit: (w, what) => {
          commitWallet(w, what);
        },
        commitShip: (f, w) => {
          setFleet(f);
          commitWallet(w, 'Ship acquired', 'ship');
        },
        free: () => isAdmin(admin),
        sellBlocked: () => (isAdmin(admin) ? 'Selling is off during Admin Access: marks never change in the sandbox.' : null),
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
        commit: (levels, w, track) => {
          // atomic: the levels and the payment land together, or neither does
          const beforeProg = prog;
          const beforeProfile = profile;
          prog = { ...prog, upgrades: { ...prog.upgrades, [fleet.active]: levels } };
          setFleet(fleet); // re-derive: the cargo track changes the hold before the wallet is applied
          const def = UPGRADE_BY_TRACK.get(track as UpgradeTrack);
          if (!commitWallet(w, `Upgrade · ${def ? `${def.name} ${LEVEL_NAME(levels[def.id] ?? 0)}` : track} · ${SHIP_BY_ID.get(fleet.active)!.name}`, 'upgrade')) {
            prog = beforeProg;
            profile = beforeProfile;
            setFleet(fleet);
            return;
          }
          if (run) {
            applyShip(run, craft);
            lastKey = '';
          }
        },
        free: () => isAdmin(admin),
        back: () => actions.stationBack(),
        sound: sound3,
      });
      recordPanel = createRecordPanel({
        stats: () => {
          const view = deriveView(graph, progress);
          return explorationStats(prog.log, { visitedSystems: progress.visitedSystems.length, visitedGalaxies: progress.visited.length, routesOpen: graph.edges.filter((e) => view.routeOpen(e)).length, missionsCompleted: prog.missions.completed.length, charted: progress.charted.length });
        },
        entries: () => discoveryEntries(prog.log, graph),
        marks: () => ({
          balance: prog.marks,
          history: prog.ledger.history,
          note: isAdmin(admin) ? 'ADMIN ACCESS: prices are free and nothing is paid or charged; the balance is unchanged.' : bountyNote(),
        }),
        progressLine: () => `${formatMarks(prog.marks)} · MISSIONS DONE ${prog.missions.claimed.length} · LICENCES ${prog.licences.length ? prog.licences.map((l) => (l === 'mk2' ? 'MK II' : 'MK III')).join(' + ') : 'NONE'}`,
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
        pause: buildPanel('pause', 'FREE ROAM', 'PAUSED', [(pauseInfo = el('p', 'fr-stats fr-pause-info'))], []),
        sectormap: buildPanel('sectormap', 'LOCAL SECTOR', 'SECTOR MAP', [mapCanvas, el('p', 'fr-text fr-text-dim fr-map-legend', 'Arrow: your ship · dashed ring: sensor range · red: hostiles in range · coloured: points of interest found so far (all once surveyed) · grey: done. Paused while open.')], [
          ['RESUME', actions.resume],
          ['GALAXY MAP', actions.openMap],
        ]),
        cargo: inventory.root,
        hangar: hangar.root,
        armory: armory.root,
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
      menus.armory = armory.menu;
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
      fillPauseMenu(panels.pause.querySelector('.fr-menu')!);
      mouseAimBtn = [...panels.controls.querySelectorAll<HTMLButtonElement>('.fr-menu > .fr-btn')].find((x) => x.textContent?.startsWith('MOUSE AIM'))!;
      const zoomRow = el('div', 'fr-controls-zoom');
      zoomLabel = el('span', 'fr-controls-action', 'ZOOM 100%');
      const zoomBtns = [...panels.controls.querySelectorAll<HTMLButtonElement>('.fr-menu > .fr-btn')].filter((x) => x.textContent?.startsWith('ZOOM'));
      zoomRow.append(zoomLabel, ...zoomBtns);
      mouseAimBtn.after(zoomRow);
      // P04.3: FLIGHT MODE (NORMAL / REALISTIC): a saved preference, applied at once (never touches loadouts, marks or progress)
      const modeRow = el('div', 'fr-controls-mode');
      modeRow.setAttribute('role', 'group');
      modeRow.setAttribute('aria-label', 'Flight mode');
      const pickMode = (m: FlightMode): void => {
        if (controls.flightMode !== m) setControls({ flightMode: m });
        refreshControls(m === 'realistic' ? 'Realistic flight: the ship keeps drifting; use STOP to brake and hold.' : 'Normal flight: GALAXIA\'s standard controls.');
      };
      const modeBtn = (m: FlightMode, text: string): HTMLButtonElement => {
        const b = el('button', 'fr-btn fr-mode-btn', text);
        b.type = 'button';
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => pickMode(m));
        return b;
      };
      modeBtns = { normal: modeBtn('normal', 'NORMAL'), realistic: modeBtn('realistic', 'REALISTIC') };
      modeRow.append(el('span', 'fr-controls-action', 'FLIGHT MODE'), modeBtns.normal, modeBtns.realistic);
      modeDesc = el('p', 'fr-text fr-text-dim fr-controls-mode-desc', '');
      modeDesc.setAttribute('aria-live', 'polite');
      zoomRow.after(modeRow, modeDesc);
      // P05.2: SHIP MIND advice: all, or critical only (critical warnings cannot be switched off)
      const adviceRow = el('div', 'fr-controls-mode fr-controls-advice');
      adviceRow.setAttribute('role', 'group');
      adviceRow.setAttribute('aria-label', 'Ship Mind advice');
      const pickAdvice = (m: 'all' | 'critical'): void => {
        if ((controls.advice === 'critical' ? 'critical' : 'all') !== m) {
          controls = m === 'critical' ? { ...controls, advice: 'critical' } : { bindings: controls.bindings, mouseAim: controls.mouseAim, zoom: controls.zoom, flightMode: controls.flightMode, ...(controls.simpleSignals ? { simpleSignals: true as const } : {}) };
          setControls({});
        }
        refreshControls(m === 'critical' ? 'Ship Mind: critical warnings only.' : 'Ship Mind: all advice.');
      };
      const adviceBtn = (m: 'all' | 'critical', text: string): HTMLButtonElement => {
        const b = el('button', 'fr-btn fr-advice-btn', text); // not fr-mode-btn: that hook names the flight-mode pair
        b.type = 'button';
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => pickAdvice(m));
        return b;
      };
      adviceBtns = { all: adviceBtn('all', 'ALL ADVICE'), critical: adviceBtn('critical', 'CRITICAL ONLY') };
      adviceRow.append(el('span', 'fr-controls-action', 'SHIP MIND'), adviceBtns.all, adviceBtns.critical);
      adviceDesc = el('p', 'fr-text fr-text-dim fr-controls-mode-desc', '');
      modeDesc.after(adviceRow, adviceDesc);
      // P06.2: SIGNALS: STANDARD (two angled bearings) or SIMPLE (one valid bearing); off by default, saved in the prefs
      const signalRow = el('div', 'fr-controls-mode fr-controls-signals');
      signalRow.setAttribute('role', 'group');
      signalRow.setAttribute('aria-label', 'Simple Signals');
      const signalBtn = (m: 'standard' | 'simple', text: string): HTMLButtonElement => {
        const b = el('button', 'fr-btn fr-advice-btn', text);
        b.type = 'button';
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => {
          controls = withSimpleSignals(controls, m === 'simple');
          setControls({});
          refreshControls(m === 'simple' ? 'Simple Signals on.' : 'Simple Signals off.');
        });
        return b;
      };
      signalBtns = { standard: signalBtn('standard', 'STANDARD'), simple: signalBtn('simple', 'SIMPLE') };
      signalRow.append(el('span', 'fr-controls-action', 'SIGNALS'), signalBtns.standard, signalBtns.simple);
      signalDesc = el('p', 'fr-text fr-text-dim fr-controls-mode-desc', '');
      adviceDesc.after(signalRow, signalDesc);
      gateTitle = panels.gate.querySelector('.fr-title')!;
      gateJump = panels.gate.querySelector('.fr-btn')!;
      briefingKicker = panels.briefing.querySelector('.fr-kicker')!;
      briefingTitle = panels.briefing.querySelector('.fr-title')!;
      returnButtons = [];
      for (const pnl of Object.values(panels)) for (const b of pnl.querySelectorAll<HTMLButtonElement>('.fr-btn')) if (b.textContent === 'GALAXY MAP') returnButtons.push(b);
      const panelLayer = el('div', 'fr-panels');
      panelLayer.append(panels.briefing, panels.pause, panels.complete, panels.gate, panels.sectormap, panels.cargo, panels.controls, panels.hangar, panels.armory, panels.fabricator, panels.missions, panels.exchange, panels.upgrades, panels.record, panels.station, panels.equipment, panels.sound, panels.recovery);
      flightRoot.append(hud);
      flightHud = createFlightHud(flightRoot, motion);
      flightRoot.append(hint, interactBtn, fireBtn, boostBtn, missileBtn, lockBtn, targetBtn, flightCtl, feed.root, offerView.root);
      combatView = createCombatHud(flightRoot);
      advisorStrip = createAdvisorStrip(flightRoot);
      // measured HUD stacking under the ship card (FR-TD-80; ui/hudStack.ts)
      stackFlightHud(scope, flightRoot, flightHud.card, feed.root, flightCtl);
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
          const need = travelCost(admin, galaxyJumpCells(r.edge, craft.stats.travel));
          if (!burn(need)) return { ok: false, reason: 'fuel', need, have: held() };
          commitProgress(r.progress);
          arrived([r.progress.system], before, 1, [{ type: 'galaxy-reached', galaxyId: to, first: !before.visited.includes(to) }, ...routeEvents(r.newRoutes)]);
          persist();
          return r;
        },
        fuel: {
          held,
          jump: (edge) => travelCost(admin, galaxyJumpCells(edge, craft.stats.travel)),
          homeDue,
          fee: travelFee,
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
          hop: (cost) => travelCost(admin, hopCells(cost, craft.stats.travel)),
          emergency: emergencyTarget,
          fee: travelFee,
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
      // P04.2 guide: the guide (one instance; released with the mode)
      const guideDialog = new GuideDialog(container, { onEnd: () => services.sound.play('uiMove'), onMove: () => services.sound.play('uiMove'), reducedMotion });
      guide = guideDialog;
      scope.add(() => {
        guideDialog.dispose();
        guide = null;
      });
      savesBtn = el('button', 'fr-map-back fr-saves-btn', 'SAVES');
      savesBtn.type = 'button';
      savesBtn.addEventListener('click', openSaves);
      map.head.classList.add('has-saves');
      map.head.append(savesBtn);
      refreshSavesBadge();

      // input: keys on window, touch stick on the canvas (window catches the release)
      // rebinding listens in the capture phase so the key never reaches the tracker or a menu
      scope.on<KeyboardEvent>(window, 'keydown', onCaptureKey, { capture: true });
      // P04: the hidden Admin Access sequence (observes only; after the rebinding capture, which stops a captured key)
      scope.on<KeyboardEvent>(window, 'keydown', onAdminKey, { capture: true });
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
          // P04.1: the wheel zooms the flight camera only (forward = in, back = out; a trackpad pinch, sent as
          // Ctrl + wheel, zooms too). It never switches weapons (Q / R3 / WPN do). It is listened to on the
          // flight canvas alone, so menus, panels, the hangar, the armory and text fields keep their own
          // scrolling, and the page is only kept from scrolling or zooming while this zoom is in use.
          if (panel || run?.phase !== 'flight') return;
          e.preventDefault();
          const z = wheelZoom(controls.zoom, e.deltaY, e.deltaMode, e.ctrlKey || e.metaKey);
          if (z === controls.zoom) return;
          if (!Number.isFinite(shownZoom)) shownZoom = controls.zoom;
          controls = { ...controls, zoom: z };
          zoomSaveAt = e.timeStamp;
          if (zoomLabel) zoomLabel.textContent = `ZOOM ${Math.round(controls.zoom * 100)}%`;
        },
        { passive: false },
      );
      // the flight buttons share one pointer pattern: each press is its own pointer role (pointers.ts), so a finger on a
      // button never takes or drags the stick; the pointer is captured (it may slide off and keep its role; synthetic
      // pointers cannot be captured, and the window pointerup still releases them). `key`: keyboard activation of the
      // focused button (assistive tech; a pointer press already acted on pointerdown), then the focus goes back to flight
      const flightButton = (b: HTMLButtonElement, down: (id: number) => void, key?: () => void): void => {
        scope.on<PointerEvent>(b, 'pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (panel || run?.phase !== 'flight') return;
          try {
            b.setPointerCapture(e.pointerId);
          } catch {
            /* see above */
          }
          down(e.pointerId);
          container.dataset['input'] = e.pointerType === 'touch' ? 'touch' : 'pointer';
        });
        scope.on<PointerEvent>(b, 'lostpointercapture', (e) => pointers.release(e.pointerId));
        scope.on<Event>(b, 'contextmenu', (e) => e.preventDefault());
        if (key)
          scope.on<MouseEvent>(b, 'click', (e) => {
            if (e.detail === 0 && !panel && run?.phase === 'flight') key();
            b.blur(); // keep Space / Enter for flight
          });
      };
      flightButton(fireBtn, (id) => pointers.fireDown(id));
      flightButton(boostBtn, (id) => pointers.boostDown(id));
      flightButton(missileBtn, (id) => pointers.weaponDown(id));
      flightButton(lockBtn, (id) => pointers.lockDown(id)); // P04.1 LOCK
      flightButton(targetBtn, (id) => pointers.targetDown(id)); // P04.1 polish NEXT TARGET
      flightButton(stopBtn, (id) => pointers.stopDown(id), () => (stopPending = !stopPending)); // P04.3 STOP
      flightButton(silentBtn, (id) => pointers.silentDown(id), () => (silentPending = !silentPending)); // P07.2 SILENT: the same latch as its key
      flightButton(abilityBtn, (id) => pointers.abilityDown(id), () => (abilityPending = true)); // P08.2: the same request as the ability key
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

      // P07.2 (TD-78): the diagnostics readers exist only with the test hooks; a release keeps the four counters the loop updates
      status = !__GALAXIA_TEST_HOOKS__ ? ({ frames: 0, ticks: 0, draws: 0, orientationChanges: 0 } as unknown as FreeRoamStatus) : {
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
        armory: () => armory.status(),
        crew: () => ({ state: crew, view: crewView }),
        advisor: () => ({ state: advice, view: advisorView(advice), strip: advisorStrip?.status() ?? null, observation: lastObservation, crew: advisorCrewNow() }),
        loadout: () => armedLoadout(fleet),
        ordnance: () => profile.ordnance,
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
          pauseMenu: { open: pauseOpen, restartAsk: !!restartAsk && !restartAsk.hidden },
          panelDropped: arming.droppedCount,
          sound: services.sound.stats(),
          engine: services.sound.loopLevel(ENGINE_LOOP),
          audio: services.prefs.get().audio,
          overlays: Object.values(panels).filter((n) => !n.hidden).length,
        }),
        fuel: () => ({ held: held(), emergency: emergencyDue(), homeDue: homeDue(), emergencyJump: emergencyTarget() }),
        adminLogin: () => (adminLogin ? adminLogin.status() : null),
        admin: () => (admin ? { from: admin.from, owned: [...admin.owned], panel: adminPanel ? adminPanel.status() : null } : null),
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
        ability: () => (run ? abilityStatus(run) : null),
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
        economy: () => ({ marks: prog.marks, history: prog.ledger.history.map((e) => ({ ...e })), recent: prog.ledger.recent.length, bounty: { ...prog.bounty }, jumps: prog.missions.jumps, fx: marksFx.serial }),
        qaMarks: __GALAXIA_TEST_HOOKS__
          ? (n: number): boolean => {
              if (!(Number.isSafeInteger(n) && n >= 0 && n <= MARKS.max) || isAdmin(admin)) return false;
              prog = { ...prog, marks: n };
              saveProg();
              save();
              return true;
            }
          : () => false,
        qaEvent: __GALAXIA_TEST_HOOKS__ ? (e: GameEvent): void => publish([e]) : () => undefined,
        frames: 0,
        ticks: 0,
        draws: 0,
      };
      if (__GALAXIA_TEST_HOOKS__) window.__galaxiaFreeRoam = status;
      refreshBriefing();
      showScreen('map');
      lifecycle = 'initialized';
      // P04: the title screen recognised the hidden gesture / sequence just before this start
      if (takeAdminRequest(performance.now())) openLogin('title');
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
      adminLogin?.destroy();
      adminLogin = null;
      scope.dispose(); // listeners, frame loop, ResizeObserver, canvas memory
      keys.clear();
      pointers.reset(true);
      bursts.length = 0;
    waves.length = 0;
      wrecks.length = 0;
      if (__GALAXIA_TEST_HOOKS__ && window.__galaxiaFreeRoam === status) delete window.__galaxiaFreeRoam;
      container.replaceChildren(); // html.game-mode and the shell's observer went with scope.dispose()
    },
    debug(): ModeDebug {
      return { lifecycle, listeners: scope.activeListeners, loops: scope.activeLoops, phase: run?.phase ?? 'none', panel, screen };
    },
  };
}
