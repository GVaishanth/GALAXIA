import './styles.css';
import { mountHost } from './modes/host.ts';
import { DEV_TOOLS } from './config/buildFlags.ts';
import { showFatal } from './ui/fatal.ts';
import type { HangarStatus } from './showcase/hangar.ts';

declare const __GALAXIA_DEV_TOOLS__: boolean; // vite.config.ts `define` (TD-49)

declare global {
  interface Window {
    /** Exposed for automated checks (Playwright). Read-only status objects, no UI. */
    __galaxiaHangar?: HangarStatus;
    /** Set once the module has started; the inline boot watchdog in index.html reads it. */
    __galaxiaBooted?: boolean;
  }
}

/** ?view=hangar|fleet|formation|scales|rewards opens the Hangar showcase (dev / QA builds only). */
const HANGAR_VIEWS = ['hangar', 'fleet', 'formation', 'scales', 'rewards'];

window.__galaxiaBooted = true;
const root = document.getElementById('app');
if (!root) throw new Error('#app root element missing');
const view = new URLSearchParams(location.search).get('view');
try {
  // the literal (not the re-exported const) lets the bundler drop this branch in release builds
  if (__GALAXIA_DEV_TOOLS__ && DEV_TOOLS && view !== null && HANGAR_VIEWS.includes(view)) {
    document.title = 'GALAXIA · Hangar';
    // dynamic import: the release build drops this branch and never emits the Hangar chunk
    void import('./showcase/hangar.ts').then(({ mountHangar }) => {
      window.__galaxiaHangar = mountHangar(root);
    });
  } else {
    // title screen + mode select; Classic and Free Roam run one at a time (src/modes/host.ts)
    mountHost(root);
  }
} catch (err) {
  // e.g. Canvas 2D unavailable: say so instead of leaving "Loading…" on screen
  console.error(err);
  showFatal(root, err instanceof Error ? err.message : 'GALAXIA could not start.');
}
