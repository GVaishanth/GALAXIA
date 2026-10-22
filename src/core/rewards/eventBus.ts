/**
 * Tiny typed publish/subscribe bus. Subscribers (HUD, audio, stats, save) are
 * isolated: one throwing listener never prevents the others from running and
 * never corrupts reward state (state is updated before events are emitted).
 */
export type Listener<E> = (event: E) => void;

export class TypedEventBus<E extends { readonly type: string }> {
  private readonly byType = new Map<E['type'], Set<Listener<E>>>();
  private readonly any = new Set<Listener<E>>();
  private readonly onError: (error: unknown, event: E) => void;
  /** Most recent listener failures (bounded), for diagnostics and tests. */
  readonly errors: { error: unknown; eventType: E['type'] }[] = [];

  constructor(onError?: (error: unknown, event: E) => void) {
    this.onError = onError ?? (() => undefined);
  }

  on<T extends E['type']>(type: T, listener: Listener<Extract<E, { type: T }>>): () => void {
    let set = this.byType.get(type);
    if (!set) {
      set = new Set();
      this.byType.set(type, set);
    }
    const l = listener as Listener<E>;
    set.add(l);
    return () => set.delete(l);
  }

  onAny(listener: Listener<E>): () => void {
    this.any.add(listener);
    return () => this.any.delete(listener);
  }

  emit(event: E): void {
    const targets = [...(this.byType.get(event.type) ?? []), ...this.any];
    for (const listener of targets) {
      try {
        listener(event);
      } catch (error) {
        this.errors.push({ error, eventType: event.type });
        if (this.errors.length > 20) this.errors.shift();
        try {
          this.onError(error, event);
        } catch {
          /* error handler must never break emission */
        }
      }
    }
  }
}
