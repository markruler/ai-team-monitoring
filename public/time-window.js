/** Pick, persist and apply the time window that limits which workers are shown. */
import { $ } from './lib/dom.js';
import { rerender, state } from './store.js';
import { ALWAYS_SHOWN_STATUSES } from './worker-text.js';

export const HOUR_MS = 3600000;
const WINDOW_PRESETS = ['1h', '3h', '6h', '12h', '24h', 'all'];
const DEFAULT_WINDOW = '3h';
const WINDOW_STORAGE_KEY = 'window';
export let timeWindow = DEFAULT_WINDOW;

/** Normalize `all` or a positive integer hour count like `5h`/`5`; anything else is null. */
function parseWindow(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'all') return 'all';
  const match = /^(\d+)h?$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  return Number.isSafeInteger(hours) && hours > 0 ? `${hours}h` : null;
}

/** Window length in milliseconds, or null for the full period. */
export function windowMs(key) {
  return key === 'all' ? null : Number.parseInt(key, 10) * HOUR_MS;
}

/** Summary card prefix, e.g. `3H` or `ALL`. */
export function windowPrefix(key) {
  return key === 'all' ? 'ALL' : key.toUpperCase();
}

/** True when a timestamp falls inside the selected window ending at the snapshot time. */
export function inWindow(timestamp) {
  const span = windowMs(timeWindow);
  if (span === null) return true;
  return timestamp !== null && timestamp !== undefined && timestamp >= state.generatedAt - span;
}

/** Running and awaiting workers stay visible in every window; others follow their start time. */
export function visibleWorkers() {
  return state.workers.filter((worker) => ALWAYS_SHOWN_STATUSES.has(worker.status) || Boolean(worker.awaiting) || Boolean(worker.mergeWait) || inWindow(worker.startedAt));
}

/** Read the stored window, tolerating unavailable storage. */
function storedWindow() {
  try { return localStorage.getItem(WINDOW_STORAGE_KEY); } catch { return null; }
}

/** Persist the window in storage and the URL query without adding history entries. */
function persistWindow(key) {
  try { localStorage.setItem(WINDOW_STORAGE_KEY, key); } catch { /* The URL still carries the choice. */ }
  try {
    const url = new URL(location.href);
    url.searchParams.set('window', key);
    history.replaceState(history.state, '', url);
  } catch { /* Storage still carries the choice. */ }
}

/** Pick the URL window, then the stored one, then the default; a valid URL value is also stored. */
function initialWindow() {
  let fromUrl = null;
  try { fromUrl = parseWindow(new URL(location.href).searchParams.get('window')); } catch { /* Fall back to storage. */ }
  if (fromUrl) {
    persistWindow(fromUrl);
    return fromUrl;
  }
  return parseWindow(storedWindow()) ?? DEFAULT_WINDOW;
}

/** Mark the active preset and mirror a custom hour count in the input. */
function syncWindowControls() {
  for (const preset of WINDOW_PRESETS) {
    const button = $(`#window-${preset}`);
    button.classList.toggle('active', preset === timeWindow);
    button.setAttribute('aria-pressed', String(preset === timeWindow));
  }
  const input = $('#window-hours');
  input.value = WINDOW_PRESETS.includes(timeWindow) ? '' : String(windowMs(timeWindow) / HOUR_MS);
  input.setAttribute('aria-invalid', 'false');
}

/** Switch to a valid window, persist it and re-render; invalid input keeps the last valid window. */
function selectWindow(value) {
  const key = parseWindow(value);
  if (!key) return false;
  timeWindow = key;
  persistWindow(key);
  syncWindowControls();
  rerender();
  return true;
}

/** Restore the window from the URL or storage and wire the preset buttons and custom-hours form. */
export function initWindowControls() {
  timeWindow = initialWindow();
  syncWindowControls();
  for (const preset of WINDOW_PRESETS) $(`#window-${preset}`).addEventListener('click', () => selectWindow(preset));
  $('#window-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#window-hours');
    const text = String(input.value ?? '').trim();
    if (!/^\d+$/.test(text) || !selectWindow(text)) input.setAttribute('aria-invalid', 'true');
  });
}
