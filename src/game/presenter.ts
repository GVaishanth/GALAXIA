/**
 * Presentation coordinator (DOM-free, so it is integration-tested with the
 * real engine). One-way data flow:
 *
 *   engine.step() -> drainEvents() --+--> FxDirector      (visual effects)
 *   RewardManager events ------------+--> SoundSystem     (via pure cue map)
 *                                    +--> TransitionDirector (phase changes)
 *
 * Nothing flows back: the presenter only reads the world and never calls
 * engine or reward-manager methods. Pausing freezes effects, backdrop and
 * audio (the context is suspended).
 */
import { cuesForGameEvent, cuesForRewardEvent } from '../audio/cues.ts';
import type { SoundSystem } from '../audio/soundSystem.ts';
import type { GameEvent } from '../core/game/events.ts';
import type { PhaseClock } from '../core/game/stateMachine.ts';
import type { World } from '../core/game/types.ts';
import type { RewardEvent } from '../core/rewards/types.ts';
import type { SpaceBackdrop } from '../render/backdrop.ts';
import type { FxDirector } from '../render/fx/fxDirector.ts';
import type { TransitionDirector, TransitionFrame } from '../render/transitions.ts';

export interface PresenterDeps {
  readonly fx: FxDirector;
  readonly transitions: TransitionDirector;
  readonly backdrop?: SpaceBackdrop;
  readonly sound?: SoundSystem | null;
}

export class Presenter {
  readonly fx: FxDirector;
  readonly transitions: TransitionDirector;
  readonly backdrop: SpaceBackdrop | undefined;
  readonly sound: SoundSystem | null;
  private reducedMotion = false;
  private last: TransitionFrame | null = null;
  /** Events seen, by type (diagnostics for automated checks). */
  readonly counts = new Map<string, number>();

  constructor(deps: PresenterDeps) {
    this.fx = deps.fx;
    this.transitions = deps.transitions;
    this.backdrop = deps.backdrop;
    this.sound = deps.sound ?? null;
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.fx.reducedMotion = on;
    if (this.backdrop) this.backdrop.reducedMotion = on;
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /** Engine events drained after the ticks of one frame (in order). */
  handleGameEvents(events: readonly GameEvent[], world: Readonly<World>, uiMs: number): void {
    for (const e of events) {
      this.counts.set(e.type, (this.counts.get(e.type) ?? 0) + 1);
      if (e.type === 'phaseChanged') {
        this.transitions.onPhaseChanged(e.from, e.to, uiMs);
        if (e.to === 'paused') this.sound?.pause();
        else if (e.from === 'paused') this.sound?.resume();
      }
      this.fx.handleGameEvent(e, world);
      if (this.sound) for (const c of cuesForGameEvent(e)) this.sound.handle(c);
    }
  }

  handleRewardEvent(e: RewardEvent): void {
    this.fx.handleRewardEvent(e);
    if (this.sound) for (const c of cuesForRewardEvent(e)) this.sound.handle(c);
  }

  /**
   * Advance presentation by one rendered frame. `dtMs` is real frame time;
   * nothing advances while paused (the transition frame is still computed so
   * the pause dim can fade in).
   */
  frame(dtMs: number, uiMs: number, world: Readonly<World>, clock: PhaseClock, stageIntro: boolean): TransitionFrame {
    const tr = this.transitions.frame(uiMs, clock, { reducedMotion: this.reducedMotion, stageIntro });
    if (!clock.paused) {
      this.fx.update(dtMs, world);
      this.backdrop?.update(dtMs, tr.warp);
    }
    this.last = tr;
    return tr;
  }

  get lastFrame(): TransitionFrame | null {
    return this.last;
  }
}
