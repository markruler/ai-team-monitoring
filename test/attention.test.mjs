/** Needs-attention panel and header tooltip: CSS contract, auto-positioning at narrow widths and theme contrast. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

/** Build a DOMRect-like object from top, left, width and height. */
function rect(top, left, width, height) {
  return { top, left, width, height, bottom: top + height, right: left + width };
}

/** Load the real app with element doubles whose viewport rectangles come from `layout`. */
function loadApp({ layout = {}, width = 1280, height = 800 } = {}) {
  const nodes = new Map();
  const listeners = new Map();
  /** Create an element double; laid-out selectors report their fixture rectangle. */
  function node(selector) {
    return {
      textContent: '', children: [], attributes: {}, handlers: {}, style: {}, hidden: false,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      getBoundingClientRect: () => layout[selector] ?? rect(0, 0, 0, 0),
    };
  }
  const document = {
    createElement: () => node(),
    createElementNS: () => node(),
    documentElement: { dataset: {} },
    addEventListener: (name, callback) => listeners.set(name, callback),
    querySelector: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, node(selector));
      return nodes.get(selector);
    },
  };
  const context = {
    document, innerWidth: width, innerHeight: height, URL, EventSource: class {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
    location: { href: 'http://127.0.0.1:4317/' },
    history: { state: null, replaceState() {} },
  };
  runInNewContext(source, context);
  return { nodes, context, listeners };
}

/** True when two rectangles share any area. */
function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Collect the declarations of every rule whose selector list contains `selector` exactly. */
function rules(selector) {
  const found = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((item) => item.trim());
    if (selectors.includes(selector)) found.push(match[2]);
  }
  return found.join(';');
}

/** Narrow (420px) layout per the max-width:700px breakpoint: stacked header, tall intro, wrapped toolbar, 2-column cards. */
const narrow = {
  header: rect(0, 0, 420, 168),
  '#alert-trigger': rect(70, 360, 44, 26),
  '.toolbar': rect(330, 18, 384, 110),
  '#lanes': rect(0, 0, 0, 0),
  '#metrics': rect(450, 18, 384, 520),
};

test('tooltip is hidden until hover or focus and has a max height with internal scroll', () => {
  const tooltip = rules('.alert-tooltip');
  assert.match(tooltip, /display:none/);
  assert.match(tooltip, /max-height:240px/);
  assert.match(tooltip, /overflow:auto/);
  assert.match(tooltip, /position:fixed/);
  assert.match(tooltip, /max-width:calc\(100vw - 16px\)/);
  assert.match(rules('.alert-status:hover .alert-tooltip'), /display:block/);
  assert.match(rules('.alert-status:focus-within .alert-tooltip'), /display:block/);
  assert.match(rules('.alert-tooltip[hidden]'), /display:none/);
  assert.doesNotMatch(css, /\.alert-badge/);
  assert.match(html, /<button id="alert-trigger"[^>]*aria-describedby="alert-tooltip">/);
  assert.match(html, /<span id="alert-tooltip" class="alert-tooltip" role="tooltip">/);
});

test('needs-attention items are single ellipsized lines and the single panel sits beside running work', () => {
  const item = rules('.attention-item');
  for (const declaration of ['overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap']) assert.match(item, new RegExp(declaration));
  assert.equal((html.match(/id="attention"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /id="next-stage-(list|count)"/);
});

test('at 420px the tooltip lands between header and window controls, inside the viewport, covering neither', () => {
  const app = loadApp({ layout: narrow, width: 420, height: 800 });
  runInNewContext('positionAlertTooltip()', app.context);
  const style = app.nodes.get('#alert-tooltip').style;
  const top = Number.parseFloat(style.top);
  const left = Number.parseFloat(style.left);
  const width = Number.parseFloat(style.width);
  const maxHeight = Number.parseFloat(style.maxHeight);
  const box = rect(top, left, width, maxHeight);
  assert.equal(app.nodes.get('#alert-tooltip').hidden, false);
  assert.ok(box.left >= 0 && box.right <= 420 && box.top >= 0 && box.bottom <= 800, JSON.stringify(box));
  for (const selector of ['header', '.toolbar', '#metrics']) assert.ok(!overlaps(box, narrow[selector]), `${selector} ${JSON.stringify(box)}`);
  assert.ok(box.top >= narrow.header.bottom && box.bottom <= narrow['.toolbar'].top);
  assert.ok(maxHeight <= 240 && maxHeight >= 40);
});

test('when the gap above the controls is too small the tooltip moves below the summary cards; scrolling and focus reposition it', () => {
  const tight = { ...narrow, '.toolbar': rect(180, 18, 384, 110), '#metrics': rect(300, 18, 384, 300) };
  const app = loadApp({ layout: tight, width: 420, height: 800 });
  const place = runInNewContext(`tooltipPlacement(${JSON.stringify(tight['#alert-trigger'])}, ${JSON.stringify(Object.values(tight))}, { width: 420, height: 800 })`, app.context);
  const box = rect(place.top, place.left, place.width, place.maxHeight);
  for (const selector of ['header', '.toolbar', '#metrics']) assert.ok(!overlaps(box, tight[selector]), selector);
  assert.ok(box.top >= tight['#metrics'].bottom && box.bottom <= 800);
  const none = runInNewContext(`tooltipPlacement(${JSON.stringify(tight['#alert-trigger'])}, [${JSON.stringify(rect(0, 0, 420, 800))}], { width: 420, height: 800 })`, app.context);
  assert.equal(none, null);
  app.listeners.get('DOMContentLoaded')();
  assert.equal(typeof app.listeners.get('scroll'), 'function');
  const status = app.nodes.get('#alert-status');
  for (const name of ['mouseenter', 'focusin']) assert.equal(status.handlers[name], app.listeners.get('scroll'));
});

/** Read one theme's custom properties from a `selector{...}` block. */
function themeVars(selector) {
  const block = css.match(new RegExp(`${selector.replace(/[[\]"]/g, '\\$&')}\\{([^}]*)\\}`))[1];
  return Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-f]{6})/gi)].map(([, name, value]) => [name, value]));
}

/** WCAG relative-luminance contrast ratio of two #rrggbb colors. */
function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, b2] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test('light and dark themes keep the panel, tooltip and trigger readable', () => {
  assert.match(rules('.alert-tooltip'), /background:var\(--card\)/);
  assert.match(rules('.alert-tooltip'), /color:var\(--text\)/);
  assert.match(rules('.attention-item'), /color:var\(--text\)/);
  assert.match(rules('.alert-trigger'), /color:#fff/);
  assert.match(rules('.alert-trigger'), /background:var\(--bar-failed\)/);
  for (const selector of [':root', '[data-theme="light"]']) {
    const vars = themeVars(selector);
    assert.ok(contrast(vars.text, vars.card) >= 7, `${selector} text`);
    assert.ok(contrast(vars.muted, vars.card) >= 4.5, `${selector} muted`);
    assert.ok(contrast('#ffffff', vars['bar-failed']) >= 4.5, `${selector} trigger`);
  }
});

test('live work uses equal adjacent columns and stacks running before waiting at 420px', () => {
  assert.match(rules('.live-work'), /display:grid/);
  assert.match(rules('.live-work'), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:700px\)\{\.live-work\{grid-template-columns:minmax\(0,1fr\);gap:0\}\}/);
  assert.match(html, /class="live-work">\s*<section[^>]*aria-label="실행 중인 워커"[\s\S]*?<\/section>\s*<section[^>]*aria-label="살펴볼 항목"/);
  assert.match(html, /id="attention-count" class="pill"/);
});

test('bot activity table caps task column width with ellipsis and keeps time columns on one line', () => {
  assert.match(html, /<table class="bot-activity-table">[\s\S]*id="bot-activity"/);
  assert.match(rules('.bot-activity-table th'), /white-space:nowrap/);
  assert.match(rules('.bot-activity-table td'), /white-space:nowrap/);
  const task = rules('.bot-activity-table .bot-activity-task');
  for (const declaration of ['max-width:420px', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap']) {
    assert.match(task, new RegExp(declaration));
  }
  const app = loadApp();
  runInNewContext(`state = { generatedAt: 600000, botActivity: [{ name: 'Tooling Owner', startedAt: 0, lastActivityAt: 60000, tasks: [{ issue: 'AIMON-1', taskSummary: 'AIMON-1 아주 긴 작업 제목' }] }] }; renderBotActivity();`, app.context);
  const taskCell = app.nodes.get('#bot-activity').children[0].children[1];
  assert.equal(taskCell.className, 'bot-activity-task');
  assert.equal(taskCell.attributes.title, 'AIMON-1 아주 긴 작업 제목');
});

test('worker status badge caps long merge-conflict file lists so inventory columns stay visible', () => {
  const status = rules('.status');
  for (const declaration of ['max-width:320px', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap']) {
    assert.match(status, new RegExp(declaration));
  }
});
