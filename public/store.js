/** Hold the latest server snapshot and the hook that redraws the whole page. */

export let state;

/** Replace the snapshot every section renders from. */
export function setState(next) {
  state = next;
}

let renderer = () => {};

/** Register the function that redraws the whole page. */
export function setRenderer(next) {
  renderer = next;
}

/** Redraw the whole page; sections call this after a control changes what they show. */
export function rerender() {
  renderer();
}
