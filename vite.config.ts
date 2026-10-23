import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Base path (TD-14, revised in Stage 7 as TD-50). One setting, three hosting cases:
 *
 *   npm run dev                          -> "/"            local dev server at the root
 *   BASE_PATH=/galaxia/ npm run build    -> "/galaxia/"    project page https://<user>.github.io/galaxia/
 *   BASE_PATH=/galaxia/ npm run preview  -> "/galaxia/"    preview must use the SAME BASE_PATH as the build
 *   BASE_PATH=/ npm run build            -> "/"            user/org page or custom domain
 *   npm run build   (BASE_PATH unset)    -> "./"           relative URLs: works from any folder
 *
 * The GitHub Actions workflow sets BASE_PATH from actions/configure-pages
 * (`base_path` output), so the deployed build always matches the repository's
 * real Pages URL, including after a rename or a custom domain.
 */
export function resolveBase(target: 'dev' | 'build' | 'preview', raw: string | undefined): string {
  if (target === 'dev') return '/'; // note: `vite preview` also reports command 'serve'; it is 'preview' here
  const value = raw?.trim();
  if (!value) return './';
  if (value === '.' || value === './') return './';
  if (/^[a-z]+:\/\//i.test(value)) return value.endsWith('/') ? value : `${value}/`; // full CDN URL
  const path = `/${value.replace(/^\/+|\/+$/g, '')}/`.replace(/\/{2,}/g, '/');
  return path;
}

/**
 * GitHub Pages serves 404.html for unknown paths. The game has no client-side
 * routes, so the page simply sends visitors back to the game's base URL.
 */
function notFoundPage(base: string): Plugin {
  const target = base === './' ? null : base;
  // Absolute base: redirect there (it always serves index.html, so no loop).
  // Relative build: the base is unknown, so only offer a link (an automatic
  // guess could redirect to another missing page and loop).
  const script = target ? `<script>location.replace(${JSON.stringify(target)});</script>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>GALAXIA · Not found</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-content:center;text-align:center;background:#030409;color:#f3efe4;font:14px system-ui,sans-serif">
<h1 style="color:#ff3b4e;letter-spacing:.18em;font-size:20px">GALAXIA</h1><p>That page does not exist.${target ? ' Taking you to the game…' : ''}</p>
<p><a style="color:#5cefff" href="${target ?? '/'}">Play GALAXIA</a></p>${script}</body></html>
`;
  return {
    name: 'galaxia-404',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '404.html', source: html });
    },
  };
}

export default defineConfig(({ command, mode, isPreview }) => {
  const target = isPreview ? 'preview' : command === 'serve' ? 'dev' : 'build';
  const base = resolveBase(target, process.env['BASE_PATH']);
  // TD-49: developer tools only in dev, tests and `--mode qa`; a literal, so
  // release builds drop the gated branches (and the Hangar chunk) entirely.
  const devTools = target === 'dev' || mode === 'qa' || mode === 'test';
  // TD-78: the automation hooks (window.__galaxia, __galaxiaGame, __galaxiaFreeRoam)
  // exist in dev, unit tests, `--mode qa` and `--mode e2e` (the release build plus
  // the hooks, for the browser harnesses). The release build (`npm run build`)
  // has none: the literal lets the minifier drop every assignment.
  const testHooks = devTools || mode === 'e2e';
  // FR-TD-83: the Gravity Flight prototype (an experimental test sector with its
  // tuning panel and diagnostics) exists only where the developer tools do; the
  // release and e2e builds drop it and its chunk. Set false here to remove it everywhere.
  const gravityLab = devTools;
  return {
    base,
    define: { __GALAXIA_DEV_TOOLS__: JSON.stringify(devTools), __GALAXIA_TEST_HOOKS__: JSON.stringify(testHooks), __GALAXIA_GRAVITY_LAB__: JSON.stringify(gravityLab) },
    plugins: [notFoundPage(base)],
    build: {
      target: 'es2022',
      // the e2e build never lands in dist/, so it cannot be uploaded by mistake
      outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
      assetsInlineLimit: 0,
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
