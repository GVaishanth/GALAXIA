/**
 * Rewards bench (Hangar view 4): a developer harness for the Stage 2 reward
 * system. Buttons emit the same GameplayFacts the Stage 3 engine will emit;
 * the real RewardManager decides, and the HUD, log, stats and save react to
 * its events independently. The scene behind the HUD is the decorative Stage 1
 * tableau, not gameplay.
 */
import { CLASSIC_MODE } from '../config/gameModes.ts';
import { RewardManager } from '../core/rewards/rewardManager.ts';
import { listExtraLifeThresholds } from '../core/rewards/extraLives.ts';
import { trackStats } from '../core/rewards/stats.ts';
import type { FactResult, GameplayFact, Point, RewardEvent } from '../core/rewards/types.ts';
import type { SaveManager } from '../persistence/saveData.ts';
import { drawFrame } from '../render/sprite/drawSprite.ts';
import type { SpriteCache } from '../render/sprite/spriteCache.ts';
import type { Starfield } from '../render/starfield.ts';
import { fitViewport, syncCanvasSize } from '../render/viewport.ts';
import { Hud } from '../ui/hud.ts';
import { NotificationQueue, hudModel, notificationsFor } from '../ui/presentation.ts';
import { drawScene } from './scene.ts';

export interface BenchRenderOptions {
  readonly glow: boolean;
  readonly pixelPerfect: boolean;
  readonly motion: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const FORMATION_Y = { commander: 84, interceptor: 133, scout: 194 } as const;

export class RewardsBench {
  readonly manager: RewardManager;
  private readonly hud: Hud;
  private readonly queue = new NotificationQueue();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private css = { width: 0, height: 0 };
  private now = 0;
  private readonly log: HTMLOListElement;
  private readonly statsLine: HTMLElement;
  private readonly saveLine: HTMLElement;
  private readonly stats: ReturnType<typeof trackStats>['stats'];
  private readonly save: SaveManager;
  private readonly cache: SpriteCache;
  private readonly stars: Starfield;

  private seq = 0;
  private captureN = 0;
  private lastKill: GameplayFact | null = null;
  private wave = 0;
  private waveHits = 0;

  constructor(view: HTMLElement, deps: { cache: SpriteCache; stars: Starfield; save: SaveManager }) {
    this.cache = deps.cache;
    this.stars = deps.stars;
    this.save = deps.save;
    this.manager = new RewardManager({ mode: CLASSIC_MODE, highScore: this.save.get().highScore });
    this.stats = trackStats(this.manager.events).stats;

    const stage = el('div', 'rewards-stage');
    this.canvas = el('canvas', 'stage-canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Playfield with the score display in its reserved top and bottom bands');
    stage.append(this.canvas);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available in this browser');
    this.ctx = ctx;
    this.hud = new Hud(stage, { reserveIcon: this.makeReserveIconFactory() });

    const panel = el('div', 'rewards-panel');
    this.log = el('ol', 'bench-log');
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-label', 'Reward events');
    this.statsLine = el('p', 'bench-note');
    this.saveLine = el('p', 'bench-note');
    panel.append(...this.buildControls(), this.section('Reward events', this.log), this.section('Stats (event subscriber)', this.statsLine));
    panel.append(this.section('Save (localStorage, versioned)', this.saveLine, this.buttons([['Reset save', () => this.resetSave()]])));
    panel.append(this.section('Classic scoring table (src/config/scoring.ts)', this.scoringTable()));
    view.append(stage, panel);

    new ResizeObserver(([entry]) => {
      if (entry) this.css = { width: entry.contentRect.width, height: entry.contentRect.height };
    }).observe(this.canvas);

    // Independent subscribers: HUD notifications, persistence, panel text.
    this.manager.events.onAny((e) => this.queue.push(notificationsFor(e), this.now));
    this.manager.events.on('gameOver', (e) => {
      this.save.recordGameResult({ score: e.finalScore, stage: e.stage });
      this.refreshSave();
    });
    window.addEventListener('pagehide', () => {
      const s = this.manager.snapshot();
      if (s.status === 'running') this.save.recordGameResult({ score: s.score, stage: s.stage });
    });

    this.newGame();
  }

  render(t: number, dpr: number, opts: BenchRenderOptions): void {
    this.now = t;
    const { width, height } = syncCanvasSize(this.canvas, this.css.width, this.css.height, dpr);
    const v = fitViewport(width, height, { integerScale: opts.pixelPerfect });
    drawScene(this.ctx, this.cache, this.stars, v, t, { glow: opts.glow, motion: opts.motion, titles: false });
    this.hud.setPlayfieldRect({
      left: v.offsetX / dpr,
      top: v.offsetY / dpr,
      width: (v.artWidth * v.scale) / dpr,
      height: (v.artHeight * v.scale) / dpr,
    });
    this.hud.update(hudModel(this.manager.snapshot()));
    this.hud.showNotifications(this.queue.active(t));
  }

  /* ------------------------------------------------------------------------ */

  private send(...facts: GameplayFact[]): void {
    for (const fact of facts) {
      const result = this.manager.handle(fact);
      this.logResult(fact, result);
      if (fact.type === 'enemyDestroyed' && result.accepted) this.lastKill = fact;
      if (!result.accepted) break;
    }
    this.refreshPanel();
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  private at(x: number, y: number): Point {
    return { x, y };
  }

  private newGame(): void {
    this.queue.clear();
    this.hud.clearNotifications();
    const r = this.manager.startGame();
    this.logResult(null, r);
    this.wave = 0;
    this.waveHits = 0;
    this.send({ type: 'stageStarted', stage: 1 });
  }

  private nextStage(): void {
    this.wave = 0;
    this.waveHits = 0;
    this.send({ type: 'stageStarted', stage: this.manager.snapshot().stage + 1 });
  }

  private challengeKills(count: number): GameplayFact[] {
    const kinds = ['scout', 'interceptor', 'challengeSpecial'] as const;
    const facts: GameplayFact[] = [];
    for (let i = 0; i < count && this.wave < 5; i++) {
      facts.push({
        type: 'enemyDestroyed',
        enemyId: this.id('c'),
        kind: kinds[this.waveHits % 3]!,
        phase: 'attacking',
        wave: this.wave,
        position: this.at(120 + this.waveHits * 26, 240),
      });
      this.waveHits += 1;
      if (this.waveHits === 8) {
        this.wave += 1;
        this.waveHits = 0;
      }
    }
    return facts;
  }

  private buildControls(): HTMLElement[] {
    const capturedId = (): string => `f${this.captureN}`;
    const captorId = (): string => `w${this.captureN}`;
    return [
      this.section(
        'Game',
        el('p', 'bench-note', 'Buttons send engine facts (what happened); the reward manager decides the points. Challenging Stages are game stages 3, 7, 11, … (use Next stage).'),
        this.buttons([
          ['New game', () => this.newGame()],
          ['Next stage', () => this.nextStage()],
          ['Lose fighter', () => this.send({ type: 'playerFighterDestroyed', dualHalf: false })],
          ['Game over', () => this.send({ type: 'gameOver' })],
        ]),
      ),
      this.section(
        'Kills',
        this.buttons([
          ['Mite · formation', () => this.send({ type: 'enemyDestroyed', enemyId: this.id('e'), kind: 'scout', phase: 'formation', position: this.at(200, FORMATION_Y.scout) })],
          ['Mite · diving', () => this.send({ type: 'enemyDestroyed', enemyId: this.id('e'), kind: 'scout', phase: 'attacking', position: this.at(150, 380) })],
          ['Razorwing · entering', () => this.send({ type: 'enemyDestroyed', enemyId: this.id('e'), kind: 'interceptor', phase: 'entering', position: this.at(300, 300) })],
          ['Warden · formation', () => this.send({ type: 'enemyDestroyed', enemyId: this.id('e'), kind: 'commander', phase: 'formation', position: this.at(224, FORMATION_Y.commander) })],
          ['Warden · dives alone', () => this.send({ type: 'enemyDestroyed', enemyId: this.id('e'), kind: 'commander', phase: 'attacking', escortsAtDiveStart: 0, position: this.at(260, 360) })],
          [
            'Warden + 2 escorts (escorts shot first)',
            () =>
              this.send(
                { type: 'enemyDestroyed', enemyId: this.id('e'), kind: 'interceptor', phase: 'attacking', position: this.at(200, 330) },
                { type: 'enemyDestroyed', enemyId: this.id('e'), kind: 'interceptor', phase: 'attacking', position: this.at(250, 330) },
                { type: 'enemyDestroyed', enemyId: this.id('e'), kind: 'commander', phase: 'attacking', escortsAtDiveStart: 2, escortsAlive: 0, position: this.at(225, 300) },
              ),
          ],
          [
            'Barbtail set ×3',
            () => {
              const groupId = this.id('g');
              this.send(
                ...[0, 1, 2].map(
                  (i): GameplayFact => ({ type: 'enemyDestroyed', enemyId: this.id('t'), kind: 'transform', transformKind: 'stinger', groupId, phase: 'attacking', position: this.at(180 + i * 44, 320) }),
                ),
              );
            },
          ],
          ['Repeat last kill', () => (this.lastKill ? this.send(this.lastKill) : this.logLine('No kill to repeat yet', 'dim'))],
        ]),
      ),
      this.section(
        'Capture and rescue',
        el('p', 'bench-note', 'A Warden death never grants the Twin by itself. The rescue only completes when the freed fighter docks.'),
        this.buttons([
          [
            'Capture fighter',
            () => {
              this.captureN += 1;
              this.send({ type: 'fighterCaptured', fighterId: capturedId(), captorId: captorId() });
            },
          ],
          [
            'Kill diving captor',
            () =>
              this.send(
                { type: 'enemyDestroyed', enemyId: captorId(), kind: 'commander', phase: 'attacking', escortsAtDiveStart: 0, holdingFighterId: capturedId(), position: this.at(224, 300) },
                { type: 'captiveFreed', fighterId: capturedId(), captorId: captorId() },
              ),
          ],
          ['Dock freed fighter', () => this.send({ type: 'captiveDocked', fighterId: capturedId() })],
          [
            'Kill captor in formation',
            () =>
              this.send(
                { type: 'enemyDestroyed', enemyId: captorId(), kind: 'commander', phase: 'formation', holdingFighterId: capturedId(), position: this.at(224, FORMATION_Y.commander) },
                { type: 'captiveTurnedHostile', fighterId: capturedId(), captorId: captorId() },
              ),
          ],
          ['Shoot the captive', () => this.send({ type: 'enemyDestroyed', enemyId: `cap-${capturedId()}`, kind: 'capturedFighter', fighterId: capturedId(), phase: 'attacking', position: this.at(224, 280) })],
          ['Lose twin half', () => this.send({ type: 'playerFighterDestroyed', dualHalf: true })],
        ]),
      ),
      this.section(
        'Challenging stage',
        this.buttons([
          ['Hit 1 target', () => this.send(...this.challengeKills(1))],
          ['Clear wave', () => this.send(...this.challengeKills(8 - this.waveHits))],
          ['End stage', () => this.send({ type: 'challengeStageEnded' })],
          ['Perfect run', () => this.send(...this.challengeKills(40), { type: 'challengeStageEnded' })],
        ]),
      ),
    ];
  }

  private section(title: string, ...children: HTMLElement[]): HTMLElement {
    const s = el('section', 'bench-section');
    s.append(el('h2', undefined, title), ...children);
    return s;
  }

  private buttons(items: [string, () => void][]): HTMLElement {
    const wrap = el('div', 'bench-buttons');
    for (const [label, run] of items) {
      const b = el('button', 'toggle', label);
      b.type = 'button';
      b.addEventListener('click', run);
      wrap.append(b);
    }
    return wrap;
  }

  /* ------------------------------------------------------------------------ */

  private describe(e: RewardEvent): string | null {
    switch (e.type) {
      case 'pointsAwarded': {
        const detail = [e.enemyKind, e.phase, e.escorts !== undefined ? `${e.escorts} escort${e.escorts === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · ');
        return `+${e.amount} ${e.source}${detail ? ` (${detail})` : ''} → ${e.scoreAfter}`;
      }
      case 'extraLifeAwarded':
        return `EXTRA FIGHTER at ${e.threshold} → reserves ${e.reserves}; next ${e.nextThreshold ?? 'none'}`;
      case 'rescue': {
        const o = e.outcome.status === 'failed' ? `failed: ${e.outcome.reason}` : e.outcome.status;
        return `rescue ${e.fighterId}: ${o} · second fighter ${e.secondFighterAvailable ? 'yes' : 'no'} · twin ${e.dualFighterActive ? 'ON' : 'off'} · bonus ${e.bonus}`;
      }
      case 'challengeStageResult':
        return `challenge #${e.challengeNumber}: ${e.hits}/${e.total}${e.perfect ? ' PERFECT' : ''} → bonus ${e.bonus}`;
      case 'challengeWaveCleared':
        return `wave ${e.wave + 1} cleared → bonus ${e.bonus}`;
      case 'transformGroupCleared':
        return `${e.transformKind} set cleared → bonus ${e.bonus}`;
      case 'stageChanged':
        return `stage ${e.stage} (${e.kind}${e.challengeNumber ? ` #${e.challengeNumber}` : ''})`;
      case 'fighterCaptured':
        return `fighter ${e.fighterId} captured by ${e.captorId} → reserves ${e.reserves}`;
      case 'dualFighterChanged':
        return `twin fighter ${e.active ? 'ON' : 'off'}`;
      case 'reservesChanged':
        return null;
      case 'scoreChanged':
        return null;
      case 'highScoreBeaten':
        return `new high score (was ${e.previous})`;
      case 'gameStarted':
        return `game started (${e.modeId}) · reserves ${e.reserves} · high ${e.highScore}`;
      case 'gameOver':
        return `GAME OVER · ${e.finalScore}${e.newHighScore ? ' · NEW HIGH SCORE' : ''} · stage ${e.stage}`;
      case 'powerUpCollected':
        return `power-up ${e.kind}`;
    }
  }

  private logResult(fact: GameplayFact | null, result: FactResult): void {
    if (!result.accepted) {
      this.logLine(`✗ ${fact?.type ?? 'fact'} rejected: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`, 'rejected');
      return;
    }
    const lines = result.events.map((e) => this.describe(e)).filter((l): l is string => l !== null);
    if (lines.length === 0 && fact) this.logLine(`${fact.type} (no reward)`, 'dim');
    for (const l of lines) this.logLine(l);
  }

  private logLine(text: string, cls?: string): void {
    const li = el('li', cls, text);
    this.log.prepend(li);
    while (this.log.childElementCount > 60) this.log.lastElementChild?.remove();
  }

  private refreshPanel(): void {
    const s = this.stats;
    this.statsLine.textContent = `kills ${s.kills} (attacking ${s.attackKills}) · best award ${s.bestSingleAward} · sets ${s.transformGroupsCleared} · waves ${s.challengeWavesCleared} · perfects ${s.challengePerfects} · rescues ${s.rescues} · captives lost ${s.captivesLost} · extra fighters ${s.extraLives}`;
    this.refreshSave();
  }

  private refreshSave(): void {
    const d = this.save.get();
    this.saveLine.textContent = `${this.save.persistent ? 'persistent' : 'memory only (storage unavailable)'} · load: ${this.save.loadStatus} · v${d.version} · high score ${d.highScore} · best stage ${d.bestStage} · glow ${d.display.glow ? 'on' : 'off'} · pixel-perfect ${d.display.pixelPerfect ? 'on' : 'off'}`;
  }

  private resetSave(): void {
    this.save.reset();
    this.logLine('save reset (takes effect for the next game high score)', 'dim');
    this.refreshSave();
  }

  private scoringTable(): HTMLElement {
    const s = CLASSIC_MODE.scoring;
    const e = s.enemies;
    const t = el('table', 'bench-table');
    const head = el('tr');
    head.append(el('th', undefined, 'Target'), el('th', undefined, 'Formation'), el('th', undefined, 'Attacking'));
    t.append(head);
    const rows: [string, string, string][] = [
      ['Mite (bee-type)', String(e.scout.formation), String(e.scout.attack)],
      ['Razorwing (butterfly-type)', String(e.interceptor.formation), String(e.interceptor.attack)],
      ['Warden (boss-type)', String(e.commander.formation), e.commander.attackByEscorts.join(' / ')],
      ['Captured fighter', String(e.capturedFighter.formation), String(e.capturedFighter.attack)],
      ['Transforms (each)', 'n/a', String(s.transforms.kinds.stinger.each)],
      ['Transform set bonus', 'n/a', `${s.transforms.kinds.stinger.groupBonus} / ${s.transforms.kinds.phantom.groupBonus} / ${s.transforms.kinds.sovereign.groupBonus}`],
      ['Challenge wave bonus', 'n/a', s.challenge.waveBonusByChallenge.join(' ')],
      ['Challenge result', `${s.challenge.perHitBonus}/hit`, `${s.challenge.perfectBonus} perfect`],
      ['Rescue bonus', 'n/a', String(s.rescue.bonus)],
      ['Extra fighters at', 'n/a', `${listExtraLifeThresholds(s.extraLives, 4).map((n) => `${n / 1000}K`).join(', ')}…`],
    ];
    for (const r of rows) {
      const tr = el('tr');
      tr.append(...r.map((c) => el('td', undefined, c)));
      t.append(tr);
    }
    return t;
  }

  /** Reserve-ship icon: the Aster sprite rendered once, cloned per icon. */
  private makeReserveIconFactory(): () => HTMLElement {
    const size = 32;
    const source = document.createElement('canvas');
    source.width = size;
    source.height = size;
    const ctx = source.getContext('2d');
    if (ctx) {
      const frame = this.cache.frame('player.fighter', 'idle', 0);
      const v = fitViewport(size, size, { artWidth: 28, artHeight: 28 });
      drawFrame(ctx, this.cache, frame, v, 14, 14, { glow: false });
    }
    return () => {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      c.getContext('2d')?.drawImage(source, 0, 0);
      return c;
    };
  }
}
