/**
 * Build flags (Stage 7, TD-49).
 *
 * DEV_TOOLS is true in `npm run dev`, in tests and in `npm run build:qa`
 * (`vite build --mode qa`), and false in the release build (`npm run build`).
 * vite.config.ts defines __GALAXIA_DEV_TOOLS__ as a literal; main.ts tests that
 * literal directly so the release build removes the Hangar branch and chunk.
 *
 * Gated: the Hangar (?view=...; its reward bench writes to the real save),
 * the hitbox overlay (?debug=1) and stage skipping (?stage=N).
 * Always available: ?seed=N (deterministic replay) and ?controls=touch|keyboard
 * (layout override), which do not affect scoring or saved results.
 */
declare const __GALAXIA_DEV_TOOLS__: boolean; // vite.config.ts `define`

export const DEV_TOOLS: boolean = __GALAXIA_DEV_TOOLS__;

/**
 * Automation hooks (TD-78): globalThis.__galaxia (host), globalThis.__galaxiaGame
 * (Classic) and globalThis.__galaxiaFreeRoam (Free Roam) are read-only status
 * objects for the browser harnesses. They exist in `npm run dev`, unit tests,
 * `npm run build:qa` and `npm run build:e2e` (the release build plus the hooks,
 * written to dist-e2e/), and are absent from the release build. Each site tests
 * the `__GALAXIA_TEST_HOOKS__` literal itself so the minifier removes the
 * assignment and the identifiers; scripts/lib/distCheck.ts fails a release
 * folder that still contains one. Hiding them is not a security measure (the
 * game has no secrets); it keeps internals off the public page.
 */
declare const __GALAXIA_TEST_HOOKS__: boolean; // vite.config.ts `define`

export const TEST_HOOKS: boolean = __GALAXIA_TEST_HOOKS__;

/**
 * Gravity Flight prototype P01 (FR-TD-83): the experimental gravity test sector
 * in Sol (System Map button, ?lab=gravity), its tuning panel and diagnostics.
 * Same builds as DEV_TOOLS: dev, tests and `npm run build:qa`; absent from the
 * release and e2e builds. The Free Roam shell loads the lab with a dynamic
 * import inside a branch on the literal, so release builds contain neither the
 * branch nor the chunk; scripts/lib/distCheck.ts fails a release folder with either.
 */
declare const __GALAXIA_GRAVITY_LAB__: boolean; // vite.config.ts `define`

export const GRAVITY_LAB: boolean = __GALAXIA_GRAVITY_LAB__;
