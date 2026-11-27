/** Build DOM text nodes and inline SVG without parsing HTML. */

export const $ = (selector) => document.querySelector(selector);
const NS = 'http://www.w3.org/2000/svg';

/** Create a safe text-only DOM element. */
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Create an SVG node with explicit attributes. */
export function svg(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
