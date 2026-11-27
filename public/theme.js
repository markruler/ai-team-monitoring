/** Toggle between light and dark themes and follow the system preference. */
import { $ } from './lib/dom.js';

/** Wire the theme toggle; theme-boot.js already applied the saved or system theme before the first paint. */
export function initTheme() {
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  let savedTheme = null;
  try { savedTheme = localStorage.getItem('theme'); } catch { /* System preference remains available without storage. */ }
  if (!['light', 'dark'].includes(savedTheme)) savedTheme = null;
  applyTheme(document.documentElement.dataset.theme);
  $('#theme-toggle').addEventListener('click', () => {
    savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(savedTheme);
    try { localStorage.setItem('theme', savedTheme); } catch { /* Keep the choice for this page when storage is unavailable. */ }
  });
  systemTheme.addEventListener('change', (event) => {
    if (!savedTheme) applyTheme(event.matches ? 'dark' : 'light');
  });
}

/** Synchronize the root theme and accessible toggle state. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
}
