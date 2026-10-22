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
    const pure = ['modes/controller.ts', 'modes/types.ts', 'modes/freeroam/sim.ts', 'modes/freeroam/camera.ts', 'modes/freeroam/input.ts', 'modes/freeroam/profile.ts', 'shared/persistence/namespaces.ts', 'shared/persistence/record.ts', 'shared/persistence/preferences.ts', 'shared/input/pointerStick.ts', 'shared/input/keyTracker.ts', 'modes/freeroam/galaxy/graph.ts', 'modes/freeroam/galaxy/progress.ts', 'modes/freeroam/galaxy/layout.ts', 'modes/freeroam/galaxy/systems.ts', 'modes/freeroam/galaxy/systemLayout.ts'];
    for (const r of pure) {
      const code = readFileSync(join(src, r), 'utf8');
      expect(code, r).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now)\b/);
    }
  });

  it('keeps the local sector world model and runtime pure; only the sector renderer touches the DOM (Prompt 6)', () => {
    const dir = join(src, 'modes/freeroam/sector');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(['collect.ts', 'combatRender.ts', 'context.ts', 'features.ts', 'generate.ts', 'grid.ts', 'lootRender.ts', 'model.ts', 'render.ts', 'resume.ts', 'run.ts', 'validate.ts']);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8');
      // no storage access: persistent changes leave the sector code only as events
      expect(code, f).not.toMatch(/from '[./]*(?:\.\.\/)*(?:profile|persistence|shared\/persistence)[^']*'/);
      expect(code, f).not.toMatch(/https?:\/\//); // no external art or data at runtime
      if (f === 'render.ts' || f === 'combatRender.ts' || f === 'lootRender.ts') continue;
      expect(code, f).not.toMatch(/\b(document|window|Math\.random|Date\.now|performance\.now|localStorage|fetch)\b/);
      expect(code, f).not.toMatch(/from '\.\/(?:combatR|lootR|r)ender\.ts'/);
    }
  });

  it('keeps Free Roam combat pure and independent of Classic (Prompt 9)', () => {
    const dir = join(src, 'modes/freeroam/combat');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.sort()).toEqual(['ai.ts', 'difficulty.ts', 'encounters.ts', 'factions.ts', 'families.ts', 'hazards.ts', 'hudModel.ts', 'projectiles.ts', 'state.ts', 'weapons.ts', 'world.ts']);
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
    expect(files.sort()).toEqual(['contracts.ts', 'discovery.ts', 'economy.ts', 'events.ts', 'fromSector.ts', 'fuel.ts', 'missionData.ts', 'missionTypes.ts', 'missionWorld.ts', 'missions.ts', 'persistence.ts', 'station.ts', 'view.ts']);
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
});
