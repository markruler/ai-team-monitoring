/** Read-only local dashboard server; sources expose only the shared state model. */
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { lstatSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectHarnessState, validHost } from './adapters/harness.mjs';
import { collectJsonlEvents } from './adapters/jsonl-events.mjs';
import { ToolUsageCollector, defaultUsageCachePath, parseUsageTools } from './adapters/tool-usage.mjs';

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
  for (const bot of activity) {
    const row = state.botActivity.find((item) => item.name === bot.name);
    if (!row) continue;
    row.lastActivityAt = Math.max(row.lastActivityAt ?? 0, bot.lastActivityAt);
    // An open heartbeat start stays current work even when another source reports newer activity.
    for (const open of bot.tasks) {
      row.startedAt = row.startedAt === null ? open.startedAt : Math.min(row.startedAt, open.startedAt);
      const task = row.tasks.find((item) => item.issue === open.issue);
      if (open.issue && !task) row.tasks.push({ issue: open.issue, taskSummary: open.taskSummary });
      else if (task && !task.taskSummary && open.taskSummary) task.taskSummary = open.taskSummary;
    }
  }
  // Tool usage comes from a long-lived background collector; callers without one get null.
  state.toolUsage = options.toolUsage?.snapshot(now) ?? null;
  return state;
}

/** Hash every file under the page directory, so a page can tell when the server now serves different files. */
export async function publicVersion(dir) {
  const hash = createHash('sha256');
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? entry.path, entry.name)).sort();
  for (const file of files) {
    hash.update(file.slice(dir.length));
    hash.update(await readFile(file));
  }
  return hash.digest('hex').slice(0, 16);
}

/** Serve fixed static assets, JSON and a shared two-second SSE stream on IPv4 loopback. */
export function createServer(options = {}) {
  const clients = new Set();
  // Each SSE client names the tools it shows; the collector reads only the union of open requests.
  const usageRequests = new Map();
  const syncUsage = () => options.toolUsage?.setEnabled(new Set([...usageRequests.values()].flat()));
  const publicDir = options.publicDir ?? join(ROOT, 'public');
  // Pages reload themselves when this changes; `watchPublic` recomputes it as soon as a page file is saved.
  let assetVersion = publicVersion(publicDir).catch(() => null);
  let watcher = null;
  if (options.watchPublic) {
    let pending = null;
    watcher = watch(publicDir, { recursive: true }, () => {
      clearTimeout(pending);
      pending = setTimeout(() => { assetVersion = publicVersion(publicDir).catch(() => null); }, 100);
    });
    watcher.on('error', () => {});
  }
  let state;
  let updating = false;
  const refresh = async () => {
    if (updating) return;
    updating = true;
    try {
      state = await collectState(options);
      state.assetVersion = await assetVersion;
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
    const [path, query = ''] = (req.url ?? '').split('?');
    try {
      await ready;
      if (path === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(state)); return; }
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        clients.add(res);
        const params = new URLSearchParams(query);
        usageRequests.set(res, parseUsageTools(params.get('usage')));
        syncUsage();
        // Answer with this page's tools applied, so it shows saved usage at once instead of a stale pre-connect state.
        const usage = options.toolUsage ? options.toolUsage.snapshot() : state.toolUsage;
        res.write(`retry: 2000\ndata: ${JSON.stringify({ ...state, toolUsage: usage })}\n\n`);
        // A forced refresh (`1` for all, or tool names) calls remote APIs, so only this page may ask; other sites' requests are ignored.
        const sameSite = [undefined, 'same-origin', 'none'].includes(req.headers['sec-fetch-site']);
        const refresh = params.get('refresh');
        if (refresh && sameSite) options.toolUsage?.requestRefresh?.(Date.now(), refresh === '1' ? null : parseUsageTools(refresh));
        req.on('close', () => {
          clients.delete(res);
          usageRequests.delete(res);
          syncUsage();
        });
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
  server.on('close', () => { clearInterval(timer); watcher?.close(); for (const client of clients) client.end(); });
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
    const server = createServer({ base, jobsRoot, toolUsage: new ToolUsageCollector({ cachePath: defaultUsageCachePath() }), watchPublic: true });
    server.on('error', (error) => { console.error(`Server error: ${error.code ?? 'unknown'}`); process.exitCode = 1; server.close(); });
    server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port} (pid ${process.pid})`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
