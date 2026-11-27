/** Keep the "hide names" choice and mirror it in the URL. */
import { $ } from './lib/dom.js';
import { rerender } from './store.js';

export let privacy = false;

/** Parse a privacy query param (?privacy=1 or ?privacy=true). */
function parsePrivacyParam(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** Read initial privacy state from the URL query parameter. */
function initialPrivacy() {
  try { return parsePrivacyParam(new URL(location.href).searchParams.get('privacy')); } catch { return false; }
}

/** Mirror the privacy checkbox in the URL query (?privacy=1) without adding history entries. */
function persistPrivacy(enabled) {
  try {
    const url = new URL(location.href);
    if (enabled) url.searchParams.set('privacy', '1');
    else url.searchParams.delete('privacy');
    history.replaceState(history.state, '', url);
  } catch { /* Keep in-memory choice if URL mutation is unavailable. */ }
}

/** Restore the choice from the URL and redraw whenever the checkbox changes. */
export function initPrivacy() {
  privacy = initialPrivacy();
  $('#privacy').checked = privacy;
  $('#privacy').addEventListener('change', (event) => {
    privacy = Boolean(event.target.checked);
    persistPrivacy(privacy);
    rerender();
  });
}
