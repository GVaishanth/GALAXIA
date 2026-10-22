/**
 * One SoundSystem (one AudioContext) for the whole page, shared by every mode.
 * Browsers allow only a few AudioContexts and each costs resources, so modes
 * never create their own: they receive this instance and, on dispose, only
 * stop their own loops (`stopLoops`). The context itself is created lazily
 * inside the first user gesture (no audio before interaction).
 */
import { SoundSystem, type AudioContextLike } from '../../audio/soundSystem.ts';
import type { AudioPrefs } from '../../persistence/saveData.ts';
import type { DisposableScope } from '../lifecycle/scope.ts';

export function createAudioContext(): AudioContextLike | null {
  const w = globalThis as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

export function createSharedSound(prefs: AudioPrefs): SoundSystem {
  return new SoundSystem(createAudioContext, prefs);
}

/** Unlock audio on the first pointer or key gesture, for the lifetime of `scope` (the host's). */
export function installAudioUnlock(scope: DisposableScope, target: Parameters<DisposableScope['on']>[0], sound: SoundSystem): void {
  const unlock = (): void => sound.unlock();
  scope.on(target, 'pointerdown', unlock, { capture: true });
  scope.on(target, 'keydown', unlock, { capture: true });
}
