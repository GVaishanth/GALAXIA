/** Recursively freeze plain data so shared configuration can never be mutated at runtime. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Merge `overrides` onto `base`. Arrays and primitives are replaced wholesale. */
export function deepMerge<T>(base: T, overrides: DeepPartial<T> | undefined): T {
  if (overrides === undefined) return base;
  if (Array.isArray(base) || base === null || typeof base !== 'object') return overrides as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] =
      current !== null && typeof current === 'object' && !Array.isArray(current) && value !== null && typeof value === 'object' && !Array.isArray(value)
        ? deepMerge(current, value as DeepPartial<typeof current>)
        : value;
  }
  return out as T;
}
