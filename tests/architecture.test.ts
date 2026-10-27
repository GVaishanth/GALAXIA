import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the one-way layer rule from ARCHITECTURE_PRINCIPLES.md:
 *   config <- assets <- render <- showcase <- main ; core stays independent.
 *   Stage 2: core/rewards (pure), persistence (storage + save format), ui (HUD models + DOM HUD).
 *   Stage 3: core/game + core/systems (pure engine), input (keys -> InputFrame), game (browser shell).
 *   Stage 4: audio (synth + cues + Web Audio wrapper); render/fx + transitions (presentation only).
 *   Free Roam P2: shared (mode-neutral services), modes (host, controller, classic adapter, freeroam).
 */
const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function layerOf(file: string): string {
  return relative(src, file).split(/[\\/]/)[0]!.replace(/\.ts$/, '');
}

const ALLOWED: Record<string, readonly string[]> = {
  config: ['config'],
  core: ['core', 'config'],
  assets: ['assets', 'config'],
  render: ['render', 'assets', 'config', 'core'],
  persistence: ['persistence', 'config'],
  // Stage 4: ui reads the prefs types from persistence (settings screen).
  // Stage 5: ui may use pure input helpers (isEditableTarget for menu keys).
  ui: ['ui', 'core', 'config', 'persistence', 'input'],
  showcase: ['showcase', 'ui', 'persistence', 'render', 'assets', 'config', 'core'],
  // Stage 3: platform input and the browser game shell.
  input: ['input', 'core', 'config'],
  // Free Roam P2: the Classic shell receives page-wide services and its lifecycle scope from shared/.
  game: ['game', 'ui', 'input', 'render', 'persistence', 'core', 'config', 'assets', 'audio', 'shared'],
  // Stage 4: audio reads config, event/reward types and the prefs type only.
  audio: ['audio', 'config', 'core', 'persistence'],
  // Stage 7: the composition root also reads build flags (config) and shows the boot-failure panel (ui).
  // Free Roam P2: main mounts the mode host instead of the Classic shell directly.
  main: ['showcase', 'modes', 'config', 'ui', 'styles.css'],
  // Free Roam P2: mode-neutral services (lifecycle, persistence namespaces, input devices, canvas, menus).
  shared: ['shared', 'config', 'assets', 'render', 'input', 'audio', 'persistence', 'core'],
  // Free Roam P2: mode host, controller, the Classic adapter and Free Roam.
  modes: ['modes', 'shared', 'game', 'ui', 'input', 'render', 'persistence', 'core', 'config', 'assets', 'audio'],
};

const rel = (f: string): string => relative(src, f).replace(/\\/g, '/');
const importSpecs = (f: string): string[] =>
  [...readFileSync(f, 'utf8').matchAll(/from\s+'(\.[^']+)'|import\s*\(\s*'(\.[^']+)'\s*\)/g)].map((m) => rel(resolve(dirname(f), (m[1] ?? m[2])!)));

describe('layer dependencies', () => {
  const all = files(src);
  it.each(all.map((f) => [relative(src, f), f]))('%s respects the layer rule', (_name, file) => {
    const layer = layerOf(file);
    const allowed = ALLOWED[layer];
    expect(allowed, `unknown layer ${layer}`).toBeDefined();
    const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']+)'|import\s+'(\.[^']+)'/g)].map((m) => m[1] ?? m[2]!);
    for (const spec of imports) {
      const target = layerOf(resolve(dirname(file), spec));
      expect(allowed, `${relative(src, file)} imports ${spec}`).toContain(target);
    }
  });

  it('keeps persistence and HUD presentation models free of DOM globals and wall-clock access', () => {
    const pure = all.filter((p) => layerOf(p) === 'persistence' || relative(src, p).replace(/\\/g, '/') === 'ui/presentation.ts');
    expect(pure.length).toBeGreaterThanOrEqual(3);
    for (const f of pure) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now)\b/);
    }
  });

  it('keeps score values out of everything except the scoring config', () => {
    // Enemy/sprite/scene code must not carry point values; the reward manager reads config.
    const suspects = all.filter((p) => ['assets', 'render', 'core'].includes(layerOf(p)) || relative(src, p).includes('scene'));
    for (const f of suspects) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/\b(1600|10000|10_000)\b/);
    }
  });

  it('keeps presentation (render, audio, ui) away from the simulation internals', () => {
    // Presentation may read event/world/phase types, but never engine systems or the engine itself,
    // so no visual or audio callback can produce a gameplay outcome.
    const presentation = all.filter((p) => ['render', 'audio', 'ui'].includes(layerOf(p)));
    for (const f of presentation) {
      const code = readFileSync(f, 'utf8');
      // type-only imports carry no behaviour and are allowed
      const specs = [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => resolve(dirname(f), m[1]!).replace(/\\/g, '/'));
      for (const s of specs) {
        expect(s, `${relative(src, f)} imports ${s}`).not.toMatch(/core\/systems\//);
        expect(s, `${relative(src, f)} imports ${s}`).not.toMatch(/core\/game\/engine\.ts$/);
        expect(s, `${relative(src, f)} imports ${s}`).not.toMatch(/core\/rewards\/rewardManager\.ts$/);
      }
    }
    expect(presentation.length).toBeGreaterThan(10);
  });

  it('keeps pure presentation models free of DOM globals and wall-clock access', () => {
    const pure = ['render/transitions.ts', 'render/fx/fxDirector.ts', 'render/fx/particles.ts', 'render/fx/effects.ts', 'audio/synth.ts', 'audio/cues.ts', 'audio/soundSystem.ts', 'ui/screenModel.ts', 'game/presenter.ts', 'game/menuActions.ts'];
    for (const rel of pure) {
      const code = readFileSync(join(src, rel), 'utf8');
      expect(code, rel).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now)\b/);
    }
  });

  it('keeps the Stage 5 input and layout models pure (testable without a browser)', () => {
    const pure = ['input/inputHub.ts', 'input/touchPad.ts', 'input/keyboard.ts', 'ui/layout.ts', 'render/viewport.ts', 'config/devices.ts'];
    for (const rel of pure) {
      const code = readFileSync(join(src, rel), 'utf8');
      expect(code, rel).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now)\b/);
    }
  });

  it('never couples gameplay to devices: core imports no input code or device config', () => {
    const core = all.filter((p) => layerOf(p) === 'core');
    expect(core.length).toBeGreaterThan(10);
    for (const f of core) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/from '[^']*(\/input\/|config\/devices)[^']*'/);
      expect(code, f).not.toMatch(/\b(touch|pointer|keyboard)\w*\s*[:=(]/i);
    }
  });

  it('keeps simulation-side modules free of DOM and wall-clock access', () => {
    for (const f of all.filter((p) => ['core', 'config'].includes(layerOf(p)))) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now)\b/);
    }
  });
});

describe('mode separation (Free Roam Prompt 2)', () => {
  const all = files(src);
  const inDir = (prefix: string): string[] => all.filter((f) => rel(f).startsWith(prefix));

  it('keeps shared/ mode-neutral: no Classic engine, rules, rewards or shell', () => {
    const shared = inDir('shared/');
    expect(shared.length).toBeGreaterThanOrEqual(12);
    for (const f of shared) {
      for (const t of importSpecs(f)) {
        expect(t, `${rel(f)} imports ${t}`).not.toMatch(/^(core\/game|core\/systems|core\/rewards|game|modes|ui\/screens|ui\/hud)\b/);
      }
    }
  });

  it('keeps Free Roam independent of Classic gameplay code', () => {
    const fr = inDir('modes/freeroam/');
    expect(fr.length).toBeGreaterThanOrEqual(6);
    for (const f of fr) {
      for (const t of importSpecs(f)) {
        expect(t, `${rel(f)} imports ${t}`).not.toMatch(/^(game\/|core\/game|core\/systems|core\/rewards|ui\/screens|ui\/hud|config\/scoring|config\/gameModes|modes\/classic\/)/);
      }
    }
  });

  it('keeps Classic independent of Free Roam', () => {
    // the adapter may use the mode contract (modes/types.ts), never Free Roam code
    for (const f of inDir('modes/classic/')) {
      for (const t of importSpecs(f)) expect(t, `${rel(f)} imports ${t}`).not.toMatch(/^modes\/(freeroam|host|controller)/);
    }
    // the Classic shell, engine and UI know nothing about modes at all
    for (const f of [...inDir('game/'), ...inDir('core/'), ...inDir('ui/')]) {
      for (const t of importSpecs(f)) expect(t, `${rel(f)} imports ${t}`).not.toMatch(/^modes\//);
    }
  });

  it('loads Free Roam lazily: only a dynamic import reaches modes/freeroam/freeRoamMode.ts', () => {
    for (const f of all) {
      const code = readFileSync(f, 'utf8');
      const staticSpecs = [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)].map((m) => rel(resolve(dirname(f), m[1]!)));
      expect(staticSpecs, rel(f)).not.toContain('modes/freeroam/freeRoamMode.ts');
    }
    expect(readFileSync(join(src, 'modes/host.ts'), 'utf8')).toMatch(/import\('\.\/freeroam\/freeRoamMode\.ts'\)/);
  });

  it('keeps the Free Roam catalogue pure, self-contained and data separate from logic (Prompt 3)', () => {
    const cat = all.filter((f) => rel(f).startsWith('modes/freeroam/catalogue/'));
    expect(cat.length).toBeGreaterThanOrEqual(15);
    for (const f of cat) {
      const code = readFileSync(f, 'utf8');
      expect(code, rel(f)).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|fetch|localStorage)\b/);
      for (const spec of importSpecs(f)) expect(spec, `${rel(f)} imports ${spec}`).toMatch(/^modes\/freeroam\/catalogue\//);
      // Data modules hold content only: they may import types and other data, never the builder or validator.
      if (rel(f).startsWith('modes/freeroam/catalogue/data/')) {
        for (const spec of importSpecs(f)) expect(spec, `${rel(f)} imports ${spec}`).toMatch(/^modes\/freeroam\/catalogue\/(types\.ts|data\/)/);
      }
    }
    // Only Free Roam may reach the catalogue (Classic never bundles it).
    for (const f of all.filter((x) => !rel(x).startsWith('modes/freeroam/'))) {
      expect(importSpecs(f).filter((s) => s.startsWith('modes/freeroam/catalogue/')), rel(f)).toEqual([]);
    }
  });

  it('builds the galaxy map from the catalogue API only, and keeps the catalogue out of the main bundle (Prompt 4)', () => {
    const galaxy = all.filter((f) => rel(f).startsWith('modes/freeroam/galaxy/'));
    expect(galaxy.length).toBeGreaterThanOrEqual(6);
    for (const f of galaxy) {
      // never the authored data modules: destinations come from getCatalogue() / buildNavGraph()
      for (const spec of importSpecs(f).filter((x) => x.startsWith('modes/freeroam/catalogue/'))) expect(spec, `${rel(f)} imports ${spec}`).toMatch(/^modes\/freeroam\/catalogue\/(index|types|build)\.ts$/);
    }
    // profile.ts and the host ship in the main bundle: no catalogue, no galaxy code there
    for (const r of ['modes/freeroam/profile.ts', 'modes/host.ts']) {
      const specs = importSpecs(all.find((f) => rel(f) === r)!);
      expect(specs.filter((x) => x.startsWith('modes/freeroam/catalogue/') || x.startsWith('modes/freeroam/galaxy/')), r).toEqual([]);
    }
  });

  it('has one generic system map: no galaxy or system ids hard-coded in the map code (Prompt 5)', () => {
    const galaxy = all.filter((f) => rel(f).startsWith('modes/freeroam/galaxy/'));
    expect(galaxy.map(rel)).toEqual(expect.arrayContaining(['modes/freeroam/galaxy/systems.ts', 'modes/freeroam/galaxy/systemLayout.ts', 'modes/freeroam/galaxy/systemMapScreen.ts', 'modes/freeroam/galaxy/systemMapRender.ts']));
    const ids = /['"`](milky-way|andromeda|triangulum|lmc|smc|whirlpool|pinwheel|sombrero|centaurus-a|cartwheel)\//;
    for (const f of galaxy.filter((x) => /system/i.test(rel(x)))) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(ids);
  });

  it('keeps the controller, Free Roam rules and persistence namespaces pure', () => {
    const pure = ['modes/controller.ts', 'modes/types.ts', 'modes/freeroam/sim.ts', 'modes/freeroam/camera.ts', 'modes/freeroam/input.ts', 'modes/freeroam/profile.ts', 'shared/persistence/namespaces.ts', 'shared/persistence/record.ts', 'shared/persistence/preferences.ts', 'shared/input/pointerStick.ts', 'shared/input/keyTracker.ts', 'modes/freeroam/galaxy/graph.ts', 'modes/freeroam/galaxy/progress.ts', 'modes/freeroam/galaxy/layout.ts', 'modes/freeroam/galaxy/systems.ts', 'modes/freeroam/galaxy/systemLayout.ts', 'config/weapons.ts', 'modes/freeroam/ships/armory.ts', 'modes/freeroam/ships/armoryView.ts'];
    for (const r of pure) {
      const code = readFileSync(join(src, r), 'utf8');
      expect(code, r).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now)\b/);
    }
  });

  it('keeps the local sector world model and runtime pure; only the sector renderer touches the DOM (Prompt 6)', () => {
    const dir = join(src, 'modes/freeroam/sector');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    // P06.1: bearing.ts (pure bearing geometry) and signal.ts (the signal-triangulation state machine)
    expect(files.sort()).toEqual(['bearing.ts', 'collect.ts', 'combatRender.ts', 'context.ts', 'features.ts', 'generate.ts', 'gravityField.ts', 'gravityRender.ts', 'gravityWells.ts', 'grid.ts', 'lootRender.ts', 'model.ts', 'realisticFlight.ts', 'render.ts', 'resume.ts', 'run.ts', 'signal.ts', 'validate.ts', 'vectorFlight.ts']);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8');
      // no storage access: persistent changes leave the sector code only as events
      expect(code, f).not.toMatch(/from '[./]*(?:\.\.\/)*(?:profile|persistence|shared\/persistence)[^']*'/);
      expect(code, f).not.toMatch(/https?:\/\//); // no external art or data at runtime
      if (f === 'render.ts' || f === 'combatRender.ts' || f === 'lootRender.ts') continue;
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|fetch)\b/);
      // gravityRender.ts draws but needs no DOM access, so it stays under the purity rule above
      if (f !== 'gravityRender.ts') expect(code, f).not.toMatch(/from '\.\/(?:combatR|lootR|gravityR|r)ender\.ts'/);
    }
  });

  it('keeps P06.1 signal triangulation pure and its hidden source out of the presentation', () => {
    const dir = join(src, 'modes/freeroam/sector');
    for (const f of ['signal.ts', 'bearing.ts']) {
      const code = readFileSync(join(dir, f), 'utf8');
      // never moves the ship, steers, fires, pays or completes anything: it writes only its own run.signal state
      expect(code, f).not.toMatch(/\b(?:ship|sh)\.(?:x|y|vx|vy|heading|thrusting)\s*[-+*/]?=(?!=)/);
      expect(code, f).not.toMatch(/\brun\.(?:done|claimed|left|cargoSpace|ammo|arsenal|shots|missiles|shipLock|stop|ship|focus|phase|offer|revealed)\s*(?:=(?!=)|\.(?:add|set|delete|push|splice|clear)\()/);
      expect(code, f).not.toMatch(/\b(?:fire|damagePlayer|damageAgent|interactContainer|takeOffer|award|withSectorProgress|setRunOrdnance)\(/);
    }
    // bearing.ts is plain geometry: the Point type only (no sector state, no randomness at all)
    expect(importSpecs(join(dir, 'bearing.ts'))).toEqual(['modes/freeroam/sector/model.ts']);
    // the hidden source and the raw measurement stay in sector logic: no renderer, HUD, shell or advisor reads them
    for (const f of all.filter((x) => !rel(x).startsWith('modes/freeroam/sector/') || /render\.ts$/i.test(x))) {
      const code = readFileSync(f, 'utf8');
      expect(code, rel(f)).not.toMatch(/\b(?:signalSource|measureBearing|signalBlocker|resolveSignal)\b/);
    }
    // nothing about a signal investigation is saved
    for (const f of ['profile.ts', 'saveSlots.ts', 'saveAudit.ts']) expect(readFileSync(join(src, 'modes/freeroam', f), 'utf8'), f).not.toMatch(/bearings|signalTrack|SignalRunState/);
  });

  it('keeps the Gravity Flight prototype contained: pure physics and runtime, DOM only in its overlay and shell, loaded lazily behind its build flag (FR-TD-83)', () => {
    const dir = join(src, 'modes/freeroam/gravity');
    const names = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    expect(names).toEqual(['config.ts', 'lab.ts', 'labShell.ts', 'physics.ts', 'render.ts']);
    for (const f of names) {
      const code = readFileSync(join(dir, f), 'utf8');
      // no storage, no network, no telemetry
      expect(code, f).not.toMatch(/from '[./]*(?:\.\.\/)*(?:profile|persistence|shared\/persistence|saveSlots)[^']*'/);
      expect(code, f).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|fetch|sendBeacon|XMLHttpRequest|WebSocket)\b|https?:\/\//);
      if (f === 'labShell.ts') continue;
      // the overlay draws on the canvas it is given; physics, config and the runtime are pure and deterministic
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now)\b/);
      if (f !== 'render.ts') expect(code, f).not.toMatch(/from '\.\/(?:render|labShell)\.ts'/);
    }
    // outside gravity/: type imports only (sector/run.ts: the hook's input type; the shell: the lab types)
    const staticValue = /^import\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm;
    for (const f of all.filter((x) => !rel(x).startsWith('modes/freeroam/gravity/'))) {
      const code = readFileSync(f, 'utf8');
      const values = [...code.matchAll(staticValue)].map((m) => rel(resolve(dirname(f), m[1]!)));
      expect(values.filter((v) => v.startsWith('modes/freeroam/gravity/')), rel(f)).toEqual([]);
      const dynamic = importSpecs(f).filter((v) => v.startsWith('modes/freeroam/gravity/') && code.includes(`import('./gravity/`));
      if (rel(f) !== 'modes/freeroam/freeRoamMode.ts') expect(dynamic, rel(f)).toEqual([]);
    }
    const shell = readFileSync(join(src, 'modes/freeroam/freeRoamMode.ts'), 'utf8');
    expect(shell).toMatch(/if \(!__GALAXIA_GRAVITY_LAB__\) return;\n\s*const m = await import\('\.\/gravity\/labShell\.ts'\);/);
    expect(shell.match(/import\('\.\/gravity\//g)?.length).toBe(1);
  });

  it('keeps Free Roam combat pure and independent of Classic (Prompt 9)', () => {
    const dir = join(src, 'modes/freeroam/combat');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(['ai.ts', 'difficulty.ts', 'dilation.ts', 'encounters.ts', 'factions.ts', 'families.ts', 'hazards.ts', 'hudModel.ts', 'playerMissile.ts', 'projectiles.ts', 'shipLock.ts', 'state.ts', 'weapons.ts', 'world.ts']);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8');
      // deterministic simulation: no DOM, wall clock, unseeded randomness or storage
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|fetch)\b/);
      expect(code, f).not.toMatch(/https?:\/\//);
      for (const spec of importSpecs(join(dir, f))) {
        // never Classic's fixed-screen game code, the renderers, persistence or the shell
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^(game|systems|entities|render|persistence|shared\/persistence)\//);
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^modes\/freeroam\/(sector\/(render|combatRender)|profile|freeRoamMode|combatHud)\.ts$/);
      }
    }
    // combat modules reach the sector runtime only for its types (no import cycle at runtime)
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8');
      for (const m of code.matchAll(/^import\s+(type\s+)?[^;]*from '\.\.\/sector\/run\.ts'/gm)) expect(m[1], `${f} imports sector/run.ts at runtime`).toBeTruthy();
    }
  });

  it('keeps the inventory rules pure and storage-independent; only inventory/ui touches the DOM (Prompt 10)', () => {
    const dir = join(src, 'modes/freeroam/inventory');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(['fabricator.ts', 'icons.ts', 'inventory.ts', 'lootTables.ts', 'milestones.ts', 'persistence.ts', 'resources.ts']);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8');
      // deterministic rules: no DOM, wall clock, unseeded randomness, direct storage or network
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|fetch|XMLHttpRequest|WebSocket)\b/);
      expect(code, f).not.toMatch(/https?:\/\//);
      for (const spec of importSpecs(join(dir, f))) {
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^(game|systems|entities|render|ui)\//);
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^modes\/freeroam\/(freeRoamMode|sector\/(render|combatRender|lootRender|run|collect))\.ts$/);
        // only the persistence adapter reaches the profile and the storage interface
        if (f !== 'persistence.ts') expect(spec, `${f} imports ${spec}`).not.toMatch(/^(modes\/freeroam\/profile\.ts|persistence\/|shared\/persistence\/)/);
      }
    }
    // nothing in the main bundle pulls the inventory in (it ships in the lazy Free Roam chunk)
    for (const f of all.filter((x) => !rel(x).startsWith('modes/freeroam/'))) expect(importSpecs(f).filter((s2) => s2.startsWith('modes/freeroam/inventory/')), rel(f)).toEqual([]);
    expect(importSpecs(join(src, 'modes/freeroam/profile.ts')).filter((s2) => s2.startsWith('modes/freeroam/inventory/'))).toEqual([]);
  });

  it('keeps missions, economy and progression pure; the panels only display and forward (Prompt 11)', () => {
    const dir = join(src, 'modes/freeroam/progression');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(['contracts.ts', 'discovery.ts', 'economy.ts', 'events.ts', 'fromSector.ts', 'fuel.ts', 'ledger.ts', 'marksRewards.ts', 'missionData.ts', 'missionTypes.ts', 'missionWorld.ts', 'missions.ts', 'persistence.ts', 'station.ts', 'view.ts']);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8');
      // deterministic rules: no DOM, wall clock, unseeded randomness, direct storage, network or payments
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|fetch|XMLHttpRequest|WebSocket|PaymentRequest)\b/);
      expect(code, f).not.toMatch(/https?:\/\//);
      for (const spec of importSpecs(join(dir, f))) {
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^(game|systems|entities|render|ui)\//);
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^modes\/freeroam\/(freeRoamMode|combatHud|sector\/(render|combatRender|lootRender)|galaxy\/(galaxyMapScreen|systemMapScreen)|ships\/hangarPanel)\.ts$/);
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^modes\/freeroam\/(progression|inventory)\/ui\//);
        // only the persistence adapter reaches the profile shapes; nothing reaches storage
        if (f !== 'persistence.ts') expect(spec, `${f} imports ${spec}`).not.toMatch(/^modes\/freeroam\/profile\.ts$/);
        expect(spec, `${f} imports ${spec}`).not.toMatch(/^(persistence|shared\/persistence)\//);
      }
    }
    // the sector runtime is reached for its event types only (no runtime cycle)
    const fromSector = readFileSync(join(dir, 'fromSector.ts'), 'utf8');
    for (const m of fromSector.matchAll(/^import\s+(type\s+)?[^;]*from '\.\.\/sector\/run\.ts'/gm)) expect(m[1], 'fromSector imports sector/run.ts at runtime').toBeTruthy();
    // panels: DOM only. They never run the mission manager, apply rewards, publish events or write the log.
    const uiDir = join(dir, 'ui');
    const ui = readdirSync(uiDir).filter((f) => f.endsWith('.ts'));
    expect(ui.sort()).toEqual(['common.ts', 'exchangePanel.ts', 'missionsPanel.ts', 'recordPanel.ts', 'upgradesPanel.ts']);
    for (const f of ui) {
      const code = readFileSync(join(uiDir, f), 'utf8');
      expect(code, f).not.toMatch(/\b(consumeEvent|acceptMission|abandonMission|markClaimed|claimReward|recordEvent|commitQuote|installUpgrade|createEventBus|publish|localStorage|fetch)\b/);
      expect(code, f).not.toMatch(/https?:\/\//);
    }
    // the shell is the only place panels are wired to the systems that apply results
    for (const f of all.filter((x) => !rel(x).startsWith('modes/freeroam/'))) expect(importSpecs(f).filter((s2) => s2.startsWith('modes/freeroam/progression/')), rel(f)).toEqual([]);
  });

  it('keeps P04 Admin Access contained: pure rules, a DOM panel without timers or storage, entered only through the hidden activation', () => {
    const dir = join(src, 'modes/freeroam/admin');
    const names = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    expect(names).toEqual(['activation.ts', 'adminPanel.ts', 'login.ts', 'loginScreen.ts', 'navigator.ts', 'session.ts']);
    for (const f of ['activation.ts', 'login.ts', 'navigator.ts', 'session.ts']) {
      const code = readFileSync(join(dir, f), 'utf8');
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|sessionStorage|fetch)\b/);
      // the rules never reach storage, the save format or the shell
      for (const spec of importSpecs(join(dir, f))) expect(spec, `${f} imports ${spec}`).not.toMatch(/^(persistence|shared\/persistence)\/|^modes\/(crossMode|freeroam\/(profile|saveSlots|freeRoamMode))\.ts$/);
    }
    // the DOM parts (panel, login screen): no timers or frame loops of their own, no global listeners, no storage
    for (const f of ['adminPanel.ts', 'loginScreen.ts']) {
      const code = readFileSync(join(dir, f), 'utf8');
      expect(code, f).not.toMatch(/\b(requestAnimationFrame|setTimeout|setInterval|localStorage|sessionStorage|fetch|saveSlot|recordOwned|console)\b/);
      expect(code, f).not.toMatch(/(window|document)\.addEventListener/);
    }
    for (const spec of [...importSpecs(join(dir, 'adminPanel.ts')), ...importSpecs(join(dir, 'loginScreen.ts'))]) expect(spec).not.toMatch(/^(persistence|shared\/persistence)\/|^modes\/(crossMode|freeroam\/(profile|saveSlots|freeRoamMode))\.ts$/);
    // outside Free Roam only the title host reaches it, and only the activation detectors
    for (const f of all.filter((x) => !rel(x).startsWith('modes/freeroam/'))) {
      const specs = importSpecs(f).filter((s2) => s2.startsWith('modes/freeroam/admin/'));
      expect(specs, rel(f)).toEqual(rel(f) === 'modes/host.ts' ? ['modes/freeroam/admin/activation.ts'] : []);
    }
    // inside Free Roam only the shell wires it
    for (const f of all.filter((x) => rel(x).startsWith('modes/freeroam/') && !rel(x).startsWith('modes/freeroam/admin/') && rel(x) !== 'modes/freeroam/freeRoamMode.ts')) {
      expect(importSpecs(f).filter((s2) => s2.startsWith('modes/freeroam/admin/')), rel(f)).toEqual([]);
    }
    // no query-parameter bypass and no global activation hook anywhere in the source
    for (const f of all) {
      const code = readFileSync(f, 'utf8');
      expect(code, rel(f)).not.toMatch(/searchParams\.get\(\s*['"]admin['"]|[?&]admin=/);
      expect(code, rel(f)).not.toMatch(/window\.[A-Za-z_$]*admin[A-Za-z_$]*\s*=/i);
    }
  });

  it('keeps P05.1 crew contained: pure rules, one DOM section, wired only by the shell, the hangar and the save audit', () => {
    const dir = join(src, 'modes/freeroam/crew');
    const crewFiles = all.filter((f) => rel(f).startsWith('modes/freeroam/crew/'));
    // P05.2 adds the advisory files: traits (attribute mapping), observation (types), advisor (rules), ui/advisorStrip (DOM)
    expect(crewFiles.map(rel).sort()).toEqual(['advisor.ts', 'bridgeView.ts', 'data.ts', 'observation.ts', 'persistence.ts', 'recruit.ts', 'state.ts', 'traits.ts', 'types.ts', 'ui/advisorStrip.ts', 'ui/bridgeSection.ts', 'view.ts'].map((f) => `modes/freeroam/crew/${f}`));
    for (const f of crewFiles.filter((x) => !rel(x).startsWith('modes/freeroam/crew/ui/'))) {
      const code = readFileSync(f, 'utf8');
      expect(code, rel(f)).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|sessionStorage|fetch)\b/);
    }
    for (const f of crewFiles) for (const spec of importSpecs(f)) expect(spec, `${rel(f)} imports ${spec}`).not.toMatch(/^(persistence|shared\/persistence|input|game|classic)\/|^modes\/freeroam\/(admin|sector|combat|gravity)\/|^modes\/freeroam\/(freeRoamMode|saveSlots)\.ts$/);
    // the main bundle (everything outside Free Roam, plus profile.ts) never pulls crew in
    for (const f of all.filter((x) => !rel(x).startsWith('modes/freeroam/') || rel(x) === 'modes/freeroam/profile.ts')) expect(importSpecs(f).filter((s2) => s2.startsWith('modes/freeroam/crew/')), rel(f)).toEqual([]);
    // inside Free Roam: the shell (rules and commits), the hangar (the Bridge section), the save audit, and (P05.2) the
    // advisor observation builder and forecast, which only build the crew/observation.ts types
    const users = all.filter((x) => !rel(x).startsWith('modes/freeroam/crew/') && importSpecs(x).some((s2) => s2.startsWith('modes/freeroam/crew/'))).map(rel).sort();
    expect(users).toEqual(['modes/freeroam/advisor/forecast.ts', 'modes/freeroam/advisor/observe.ts', 'modes/freeroam/freeRoamMode.ts', 'modes/freeroam/saveAudit.ts', 'modes/freeroam/ships/hangarPanel.ts']);
    for (const f of all.filter((x) => rel(x).startsWith('modes/freeroam/advisor/'))) for (const spec of importSpecs(f).filter((s2) => s2.startsWith('modes/freeroam/crew/'))) expect(spec, rel(f)).toMatch(/^modes\/freeroam\/crew\/(observation|types)\.ts$/);
    expect(readdirSync(dir).includes('ui')).toBe(true);
  });

  it('keeps P05.2 advice read-only: the observation reads the run, the advisor reads only the observation', () => {
    const advisorFiles = all.filter((f) => rel(f).startsWith('modes/freeroam/advisor/'));
    expect(advisorFiles.map(rel).sort()).toEqual(['modes/freeroam/advisor/forecast.ts', 'modes/freeroam/advisor/observe.ts']);
    for (const f of advisorFiles) {
      const code = readFileSync(f, 'utf8');
      expect(code, rel(f)).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|sessionStorage|fetch|requestAnimationFrame|setTimeout|setInterval)\b/);
      // never writes the run (or anything reached through it, or the forecast query's ship / STOP state)
      expect(code, rel(f)).not.toMatch(/\b(run|r|sh|q\.ship|q\.stop|L|stats)(\.[\w$]+|\[[^\]]+\])+\s*(=(?!=)|\+=|-=|\*=|\/=|\+\+|--)/);
      expect(code, rel(f)).not.toMatch(/\brun\.[\w.]+\.(push|pop|shift|unshift|splice|set|add|delete|clear|sort|fill)\(|Object\.assign\(\s*(run|q\.)/);
      for (const spec of importSpecs(f)) {
        expect(spec, `${rel(f)} imports ${spec}`).not.toMatch(/^(input|game|classic|render|audio|persistence|shared\/persistence)\//);
        expect(spec, `${rel(f)} imports ${spec}`).not.toMatch(/^modes\/freeroam\/(input|camera|freeRoamMode|saveSlots|profile|combatHud)\.ts$|^modes\/freeroam\/(progression|admin|gravity|ships|galaxy)\//);
      }
    }
    // the advisor rules see only crew files (the observation, the crew view and traits): no run, sector, combat or flight import
    for (const f of ['advisor.ts', 'traits.ts', 'observation.ts'].map((x) => join(src, 'modes/freeroam/crew', x))) for (const spec of importSpecs(f)) expect(spec, `${rel(f)} imports ${spec}`).toMatch(/^modes\/freeroam\/crew\/(observation|traits|types|view)\.ts$/);
    // the strip renders the advisor view only
    for (const spec of importSpecs(join(src, 'modes/freeroam/crew/ui/advisorStrip.ts'))) expect(spec).toMatch(/^modes\/freeroam\/(progression\/ui\/common|crew\/advisor)\.ts$/);
    // only the shell builds observations and runs the advisor
    const users = all.filter((x) => !rel(x).startsWith('modes/freeroam/advisor/') && importSpecs(x).some((s2) => s2.startsWith('modes/freeroam/advisor/'))).map(rel);
    expect(users).toEqual(['modes/freeroam/freeRoamMode.ts']);
    // the lab's own prediction stays in the gravity lab (never reused by production advice)
    for (const f of advisorFiles) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/predictBallistic|suggestEscape/);
  });
});
