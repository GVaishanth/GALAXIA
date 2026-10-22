/**
 * Fatal error panel (Stage 7): shown when the game cannot start (e.g. no
 * Canvas 2D) or when the frame loop halts after repeated errors (TD-46/B-2).
 * Saved data is untouched: a reload records nothing new and loses only the
 * current run (a mid-game score is still recorded on pagehide).
 */
export function showFatal(root: HTMLElement, message: string): void {
  if (root.querySelector('.fatal')) return;
  const panel = document.createElement('div');
  panel.className = 'fatal';
  panel.setAttribute('role', 'alert');
  const title = document.createElement('h2');
  title.textContent = 'GALAXIA STOPPED';
  const text = document.createElement('p');
  text.textContent = message;
  const hint = document.createElement('p');
  hint.className = 'fatal-hint';
  hint.textContent = 'Your saved high score and settings are kept. Reloading usually fixes this.';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fatal-btn';
  button.textContent = 'RELOAD';
  button.addEventListener('click', () => location.reload());
  panel.append(title, text, hint, button);
  root.append(panel);
  button.focus();
}
