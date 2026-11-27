/** The page's ES modules link in a real loader and never assign to a binding they import. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { staticAsset } from '../server.mjs';

const PUBLIC = new URL('../public/', import.meta.url);

/** List every page module path relative to public/. */
async function modulePaths() {
  const entries = await readdir(PUBLIC, { recursive: true });
  return entries.filter((path) => path.endsWith('.js') && path !== 'theme-boot.js').sort();
}

test('every page module links in a real ES module loader', async () => {
  // Module top levels only declare; the DOM is touched after DOMContentLoaded, so a stub document is enough.
  const listeners = [];
  globalThis.document = { addEventListener: (name) => listeners.push(name) };
  try {
    await import(new URL('app.js', PUBLIC).href);
  } finally {
    delete globalThis.document;
  }
  assert.deepEqual(listeners, ['DOMContentLoaded']);
});

test('no page module assigns to a name it imports', async () => {
  for (const path of await modulePaths()) {
    const text = await readFile(new URL(path, PUBLIC), 'utf8');
    const names = [...text.matchAll(/^import\s*\{([^}]*)\}/gm)].flatMap((match) => match[1].split(',').map((name) => name.trim()).filter(Boolean));
    for (const name of names) {
      const escaped = name.replace(/\$/g, '\\$');
      const assignment = new RegExp(`(?<![\\w$.])${escaped}\\s*(?:=(?!=)|\\+\\+|--|[-+*/]=)`);
      assert.doesNotMatch(text.replace(/^import[^;]*;$/gm, ''), assignment, `${path} assigns imported ${name}`);
    }
  }
});

test('every page module is reachable through the static file allowlist', async () => {
  for (const path of await modulePaths()) assert.deepEqual(staticAsset(`/${path}`), [path, 'text/javascript; charset=utf-8']);
  assert.deepEqual(staticAsset('/theme-boot.js'), ['theme-boot.js', 'text/javascript; charset=utf-8']);
  assert.deepEqual(staticAsset('/style.css'), ['style.css', 'text/css; charset=utf-8']);
  assert.deepEqual(staticAsset('/'), ['index.html', 'text/html; charset=utf-8']);
  for (const path of ['/../server.mjs', '/lib/../../server.mjs', '/%2e%2e/server.mjs', '/index.html', '/App.js', '/lib//dom.js', '/x.json', '/constructor', '/lib/']) {
    assert.equal(staticAsset(path), null, path);
  }
});
