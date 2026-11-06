import { $$ } from '../ui.js';

/** Show/hide password buttons: <button data-reveal="inputId">. */
export function wireRevealButtons(root = document) {
  $$('[data-reveal]', root).forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.reveal);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  });
}
