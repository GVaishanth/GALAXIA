/**
 * Fullscreen where the browser supports it (TD-72), shared by Classic and
 * Free Roam. The whole page (document element) goes fullscreen, not a mode
 * container, so switching modes from the title screen stays fullscreen and
 * both modes get exactly the same display area. Entering or leaving changes
 * the shell size, which the shared AppShell turns into one ordinary resize.
 *
 * Browsers without element fullscreen (iPhone Safari) report unsupported and
 * the modes hide their toggle. A request needs a user gesture (click, tap,
 * key press); a refused request leaves the page as it was.
 */
import type { DisposableScope } from '../lifecycle/scope.ts';

interface FsDocument {
  readonly fullscreenEnabled?: boolean;
  readonly webkitFullscreenEnabled?: boolean;
  readonly fullscreenElement?: Element | null;
  readonly webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
}

interface FsElement {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => void;
}

const doc = (): FsDocument | null => (typeof document === 'undefined' ? null : (document as unknown as FsDocument));

export function fullscreenSupported(d: FsDocument | null = doc()): boolean {
  return !!d && (d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true);
}

export function isFullscreen(d: FsDocument | null = doc()): boolean {
  return !!d && !!(d.fullscreenElement ?? d.webkitFullscreenElement);
}

/** Enter or leave fullscreen. Resolves to the resulting state; never throws. */
export async function setFullscreen(on: boolean, target: Element | null = typeof document === 'undefined' ? null : document.documentElement, d: FsDocument | null = doc()): Promise<boolean> {
  if (!d || !fullscreenSupported(d) || on === isFullscreen(d)) return isFullscreen(d);
  try {
    if (on) {
      const el = target as unknown as FsElement | null;
      if (el?.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else el?.webkitRequestFullscreen?.();
    } else if (d.exitFullscreen) {
      await d.exitFullscreen();
    } else {
      d.webkitExitFullscreen?.();
    }
  } catch {
    // refused (no user gesture, permissions policy, iframe without allowfullscreen): keep the current state
  }
  return isFullscreen(d);
}

/** Call `fn(isFullscreen)` whenever the page enters or leaves fullscreen (Esc, browser UI, our toggle). */
export function onFullscreenChange(scope: DisposableScope, fn: (on: boolean) => void): void {
  if (typeof document === 'undefined') return;
  const handler = (): void => fn(isFullscreen());
  scope.on(document, 'fullscreenchange', handler);
  scope.on(document, 'webkitfullscreenchange', handler);
}
