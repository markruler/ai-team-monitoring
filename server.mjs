/** Read-only local dashboard server; sources expose only the shared state model. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectHarnessState, validHost } from './adapters/harness.mjs';
import { collectJsonlEvents } from './adapters/jsonl-events.mjs';

// Preserve the existing helper exports used by callers and regression tests.
export * from './adapters/harness.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Resolve explicit paths before environment settings and compatible installation defaults. */
export function resolvePaths({ base, jobsRoot } = {}, { env = process.env, home = homedir(), exists = (path) => {
  try { lstatSync(path); return true; } catch { return false; }
} } = {}) {
  const legacy = join(home, '.local/state/agent-outer-loop');
  return {
    base: base ?? (env.AI_TEAM_MONITORING_STATE_DIR || (env.XDG_STATE_HOME
      ? join(env.XDG_STATE_HOME, 'agent-orchestration')
      : exists(legacy) ? legacy : join(home, '.local/state/agent-orchestration'))),
    jobsRoot: jobsRoot ?? (env.AI_TEAM_MONITORING_JOBS_ROOT || join(home, 'agent-orchestration-jobs')),
  };
}

/** Merge common bot activity evidence without changing worker or attention projections. */
export async function collectState(options = {}) {
  const { base, jobsRoot } = resolvePaths(options);
  const now = options.now ?? Date.now();
  const state = await collectHarnessState({ ...options, base, jobsRoot, now });
  const activity = await collectJsonlEvents({ base, eventsJsonlPath: options.eventsJsonlPath });
  for (const event of activity) {
    const row = state.botActivity.find((item) => item.name === event.name);
    if (!row) continue;
    const previousActivityAt = row.lastActivityAt;
    row.lastActivityAt = Math.max(previousActivityAt ?? 0, event.lastActivityAt);
    if (event.lastActivityAt <= (previousActivityAt ?? -Infinity)
      || (event.phase === 'end' && now - event.lastActivityAt > 30 * 60 * 1000)) continue;
    row.startedAt = row.startedAt === null ? event.startedAt : Math.min(row.startedAt, event.startedAt);
    const task = row.tasks.find((item) => item.issue === event.issue);
    if (event.issue && !task) row.tasks.push({ issue: event.issue, taskSummary: event.taskSummary });
    else if (task && !task.taskSummary && event.taskSummary) task.taskSummary = event.taskSummary;
  }
  return state;
}

/** Serve fixed static assets, JSON and a shared two-second SSE stream on IPv4 loopback. */
export function createServer(options = {}) {
  const clients = new Set();
  let state;
  let updating = false;
  const refresh = async () => {
    if (updating) return;
    updating = true;
    try {
      state = await collectState(options);
      const message = `data: ${JSON.stringify(state)}\n\n`;
      for (const client of clients) {
        if (client.writableLength > 1024 * 1024) { client.destroy(); clients.delete(client); }
        else client.write(message);
      }
    } finally { updating = false; }
  };
  const ready = refresh();
  const timer = setInterval(() => { refresh().catch(() => {}); }, 2000);
  timer.unref();
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (!validHost(req.headers.host)) { res.writeHead(403); res.end('Forbidden host'); return; }
    if (req.headers.origin && ![ `http://${req.headers.host}` ].includes(req.headers.origin)) { res.writeHead(403); res.end('Forbidden origin'); return; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    const path = req.url?.split('?')[0];
    try {
      await ready;
      if (path === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(state)); return; }
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(`retry: 2000\ndata: ${JSON.stringify(state)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (Object.hasOwn(assets, path)) {
        const [file, type] = assets[path];
        const content = await readFile(join(ROOT, 'public', file));
        res.writeHead(200, { 'Content-Type': type }); res.end(content); return;
      }
      res.writeHead(404); res.end('Not found');
    } catch { res.writeHead(500); res.end('State unavailable'); }
  });
  server.on('close', () => { clearInterval(timer); for (const client of clients) client.end(); });
  return server;
}

/** Validate the deliberately small command line interface. */
export function parsePort(args) {
  if (!args.length) return 4317;
  if (args.length !== 2 || args[0] !== '--port' || !/^[0-9]+$/.test(args[1]) || +args[1] < 1 || +args[1] > 65535) throw new Error('Usage: node server.mjs [--port 4317]');
  return +args[1];
}

/** Parse supported startup options while keeping parsePort's narrow public contract. */
export function parseArgs(args, context) {
  const values = {};
  const keys = new Map([['--port', 'port'], ['--state-dir', 'base'], ['--jobs-root', 'jobsRoot']]);
  for (let index = 0; index < args.length; index += 2) {
    const key = keys.get(args[index]);
    const value = args[index + 1];
    if (!key || Object.hasOwn(values, key) || !value || value.startsWith('--')) {
      throw new Error('Usage: node server.mjs [--port 4317] [--state-dir DIR] [--jobs-root DIR]');
    }
    values[key] = value;
  }
  const port = parsePort(values.port === undefined ? [] : ['--port', values.port]);
  return { port, ...resolvePaths(values, context) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { port, base, jobsRoot } = parseArgs(process.argv.slice(2));
    const server = createServer({ base, jobsRoot });
    server.on('error', (error) => { console.error(`Server error: ${error.code ?? 'unknown'}`); process.exitCode = 1; server.close(); });
    server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port} (pid ${process.pid})`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
