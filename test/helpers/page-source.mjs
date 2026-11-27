/** Join the page's scripts into one classic script so tests can run it in a vm context and reach every binding. */
import { readFile } from 'node:fs/promises';

const PUBLIC = new URL('../../public/', import.meta.url);
const IMPORT = /^import\s*\{[^}]*\}\s*from\s*'([^']+)';\n/gm;

/** Read a page module and the relative paths of the modules it imports. */
async function readModule(path) {
  const text = await readFile(new URL(path, PUBLIC), 'utf8');
  const deps = [...text.matchAll(IMPORT)].map((match) => new URL(match[1], new URL(path, PUBLIC)).href.slice(PUBLIC.href.length));
  return { text, deps };
}

/**
 * Return theme-boot.js followed by every module reachable from app.js, dependencies first, with `import` lines and
 * `export` keywords removed. Module names are unique across files, so one shared scope behaves like the module graph.
 */
export async function pageSource() {
  const ordered = [];
  const seen = new Set();
  const visit = async (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const { text, deps } = await readModule(path);
    for (const dep of deps) await visit(dep);
    ordered.push(text.replace(IMPORT, '').replace(/^export /gm, ''));
  };
  await visit('app.js');
  return [await readFile(new URL('theme-boot.js', PUBLIC), 'utf8'), ...ordered].join('\n');
}
