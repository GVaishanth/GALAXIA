/**
 * Roving focus over the buttons of one container, for keyboard and gamepad
 * menus outside Classic (title screen, Free Roam panels). Buttons stay native
 * <button>s, so mouse, touch, screen readers and Tab keep working; this class
 * only adds arrow / D-pad movement and "activate the focused item".
 * Buttons inside an element marked `data-menu-skip` (e.g. a tab strip that
 * has its own shortcuts) are not part of the roving list.
 */
export class MenuList {
  private readonly root: HTMLElement;
  private readonly onMove: (() => void) | undefined;
  private last = 0;

  constructor(root: HTMLElement, onMove?: () => void) {
    this.root = root;
    this.onMove = onMove;
  }

  buttons(): HTMLButtonElement[] {
    return [...this.root.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.disabled && !b.closest('[hidden]') && !b.closest('[data-menu-skip]'));
  }

  /** Index of the focused button, or -1 when focus is elsewhere. */
  focusedIndex(): number {
    const active = document.activeElement;
    return this.buttons().findIndex((b) => b === active);
  }

  focus(index = this.last): void {
    const items = this.buttons();
    if (items.length === 0) return;
    const i = Math.max(0, Math.min(items.length - 1, index));
    this.last = i;
    items[i]!.focus({ preventScroll: true });
  }

  move(delta: number): void {
    const items = this.buttons();
    if (items.length === 0) return;
    const cur = this.focusedIndex();
    const from = cur >= 0 ? cur : this.last;
    const next = (from + delta + items.length) % items.length;
    this.focus(next);
    if (next !== from || cur < 0) this.onMove?.();
  }

  /** Click the focused button (or the last focused one when focus left the menu). */
  activate(): void {
    const items = this.buttons();
    const cur = this.focusedIndex();
    const target = items[cur >= 0 ? cur : Math.min(this.last, items.length - 1)];
    target?.click();
  }
}
