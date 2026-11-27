/** Collect per-tool token usage and plan limits for Claude Code, Codex, Antigravity and Cursor. */
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const USAGE_RETENTION_MS = 7 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
export const USAGE_REFRESH_MS = 10 * 60 * 1000;
export const USAGE_FORCE_MIN_MS = 30 * 1000;
const CHUNK_BYTES = 1024 * 1024;
const BUCKET_KEYS = ['newInput', 'cacheWrite', 'cached', 'output', 'messages'];
const CURSOR_DASHBOARD_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService';

/** Return a nonnegative finite number, or 0 for anything else. */
function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Floor an epoch millisecond time to the start of its hour. */
export function hourOf(at) {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/** Add one usage sample into an hour → bucket map. */
function addSample(buckets, at, sample) {
  const hour = hourOf(at);
  const bucket = buckets.get(hour) ?? Object.fromEntries(BUCKET_KEYS.map((key) => [key, 0]));
  for (const key of BUCKET_KEYS) bucket[key] += count(sample[key]);
  buckets.set(hour, bucket);
}

/**
 * Read one Claude Code transcript row into a usage sample, or null when it carries none.
 * New input follows the worker convention: input + cache write; cache reads stay separate.
 */
export function claudeSample(row) {
  if (row?.type !== 'assistant' || !row.message?.usage || typeof row.timestamp !== 'string') return null;
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return null;
  const usage = row.message.usage;
  return {
    at,
    id: row.message.id || row.requestId || row.uuid || null,
    newInput: count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    cached: count(usage.cache_read_input_tokens),
    output: count(usage.output_tokens),
    messages: 1,
  };
}

/** Read a Codex `token_count` event, or null; totals are cumulative per session file. */
export function codexEvent(row) {
  if (row?.type !== 'event_msg' || row.payload?.type !== 'token_count' || typeof row.timestamp !== 'string') return null;
  const at = Date.parse(row.timestamp);
  if (!Number.isFinite(at)) return null;
  const total = row.payload.info?.total_token_usage;
  return {
    at,
    total: total && typeof total === 'object' ? {
      input: count(total.input_tokens),
      cached: count(total.cached_input_tokens),
      cacheWrite: count(total.cache_write_input_tokens),
      output: count(total.output_tokens),
    } : null,
    limits: codexLimits(row.payload.rate_limits, at),
  };
}

/** Keep only the plan and limit windows from a Codex `rate_limits` object. */
export function codexLimits(value, observedAt) {
  if (!value || typeof value !== 'object') return null;
  const windows = ['primary', 'secondary'].flatMap((name) => {
    const item = value[name];
    if (!item || !Number.isFinite(item.used_percent)) return [];
    return [{
      name,
      usedPercent: Math.min(100, Math.max(0, item.used_percent)),
      windowMinutes: Number.isFinite(item.window_minutes) ? item.window_minutes : null,
      resetsAt: Number.isFinite(item.resets_at) ? item.resets_at * 1000 : null,
    }];
  });
  if (!windows.length) return null;
  const plan = typeof value.plan_type === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value.plan_type) ? value.plan_type : null;
  return { plan, windows, observedAt, limitReached: Boolean(value.rate_limit_reached_type) };
}

/** Turn consecutive cumulative Codex totals into a per-event delta; a smaller total restarts the counter. */
export function codexDelta(previous, current) {
  const restarted = previous && ['input', 'output'].some((key) => current[key] < previous[key]);
  const base = !previous || restarted ? { input: 0, cached: 0, cacheWrite: 0, output: 0 } : previous;
  const input = Math.max(0, current.input - base.input);
  const cached = Math.max(0, current.cached - base.cached);
  const output = Math.max(0, current.output - base.output);
  if (!input && !output && !cached) return null;
  return {
    newInput: Math.max(0, input - cached),
    cacheWrite: Math.max(0, current.cacheWrite - base.cacheWrite),
    cached,
    output,
    messages: 1,
  };
}

/**
 * Push the lines of `data` that contain `needle` (all lines when it is empty) and return the bytes consumed,
 * which end just after the last newline; the remainder is an unfinished row.
 */
function collectLines(data, needle, lines) {
  let start = 0;
  let nextHit = needle.length ? data.indexOf(needle) : 0;
  for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
    // Search for the marker once per occurrence, not once per line, so sparse markers stay linear.
    if (nextHit !== -1 && nextHit < start) nextHit = data.indexOf(needle, start);
    if (nextHit !== -1 && nextHit < end) lines.push(data.toString('utf8', start, end));
    start = end + 1;
  }
  return start;
}

/**
 * Read complete lines appended after `offset`, decoding only lines that contain `marker`;
 * returns those lines and the offset just after the last newline, so a partly written row is retried later.
 */
export async function readAppendedLines(path, offset, size, marker = '') {
  const needle = Buffer.from(marker);
  const handle = await open(path, 'r');
  const lines = [];
  let position = offset;
  let consumed = offset;
  let pending = Buffer.alloc(0);
  try {
    while (position < size) {
      const length = Math.min(CHUNK_BYTES, size - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      const used = collectLines(data, needle, lines);
      consumed += used;
      pending = Buffer.from(data.subarray(used));
    }
  } finally {
    await handle.close();
  }
  return { lines, offset: consumed };
}

/** List `.jsonl` files under `root` up to `depth` levels whose mtime is inside the retention window. */
async function recentJsonl(root, depth, since) {
  const found = [];
  const walk = async (dir, level) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && level < depth) return walk(path, level + 1);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return;
      try {
        const info = await stat(path);
        if (info.mtimeMs >= since) found.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      } catch { /* A file removed mid-scan is simply skipped. */ }
    }));
  };
  await walk(root, 0);
  return found;
}

/**
 * Track one tool's session logs incrementally: each file keeps its byte offset and hour buckets,
 * so a refresh only parses appended rows. `parse(lines, fileState)` adds samples to fileState.buckets.
 */
export class LogUsageTracker {
  /** Create a tracker for `root`, scanning `depth` directory levels and parsing rows with `parse`. */
  constructor({ root, depth, marker, parse }) {
    this.root = root;
    this.depth = depth;
    this.marker = marker;
    this.parse = parse;
    this.files = new Map();
    this.missing = false;
  }

  /** Read new rows from every recent file and drop files and buckets older than the retention window. */
  async refresh(now) {
    const since = now - USAGE_RETENTION_MS;
    try {
      await stat(this.root);
      this.missing = false;
    } catch {
      this.missing = true;
      this.files.clear();
      return;
    }
    const recent = await recentJsonl(this.root, this.depth, since);
    // Files are read one after another to bound memory; each read is already chunked.
    for (const file of recent) await this.#readFile(file);
    this.#prune(new Set(recent.map((file) => file.path)), hourOf(since));
  }

  /** Parse rows appended to one file since its stored offset; a shrunken file is read again from the start. */
  async #readFile(file) {
    let state = this.files.get(file.path);
    if (!state || file.size < state.offset) {
      state = { offset: 0, buckets: new Map(), ids: new Set(), previous: null, limits: null };
      this.files.set(file.path, state);
    }
    if (file.size === state.offset) return;
    try {
      const { lines, offset } = await readAppendedLines(file.path, state.offset, file.size, this.marker);
      state.offset = offset;
      this.parse(lines.flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }), state);
    } catch (error) {
      // An unreadable file keeps its previous contribution.
      console.error(`tool usage read failed: ${error.code ?? 'unknown'}`);
    }
  }

  /** Forget files that left the window and hour buckets older than `oldestHour`. */
  #prune(recentPaths, oldestHour) {
    for (const path of this.files.keys()) {
      if (!recentPaths.has(path)) this.files.delete(path);
    }
    for (const state of this.files.values()) {
      for (const hour of state.buckets.keys()) {
        if (hour < oldestHour) state.buckets.delete(hour);
      }
    }
  }

  /** Sum hour buckets across files, oldest first. */
  hourly() {
    const total = new Map();
    for (const state of this.files.values()) {
      for (const [hour, bucket] of state.buckets) addSample(total, hour, bucket);
    }
    return [...total].sort((a, b) => a[0] - b[0]).map(([hour, bucket]) => ({ hour, ...bucket }));
  }

  /** Return the newest limits snapshot any file reported. */
  latestLimits() {
    let latest = null;
    for (const state of this.files.values()) {
      if (state.limits && (!latest || state.limits.observedAt > latest.observedAt)) latest = state.limits;
    }
    return latest;
  }
}

/** Add Claude transcript rows, counting each assistant message once even when streamed in several rows. */
export function parseClaudeRows(rows, state) {
  for (const row of rows) {
    const sample = claudeSample(row);
    if (!sample) continue;
    if (sample.id) {
      if (state.ids.has(sample.id)) continue;
      state.ids.add(sample.id);
    }
    addSample(state.buckets, sample.at, sample);
  }
}

/** Add Codex session rows as deltas of the cumulative totals and remember the newest rate limits. */
export function parseCodexRows(rows, state) {
  for (const row of rows) {
    const event = codexEvent(row);
    if (!event) continue;
    if (event.limits && (!state.limits || event.limits.observedAt >= state.limits.observedAt)) state.limits = event.limits;
    if (!event.total) continue;
    const delta = codexDelta(state.previous, event.total);
    state.previous = event.total;
    if (delta) addSample(state.buckets, event.at, delta);
  }
}

/** Keep only the Antigravity plan, credits and per-model quota; names and emails are dropped. */
export function antigravityQuota(body) {
  const status = body?.userStatus;
  if (!status || typeof status !== 'object') return null;
  const plan = status.planStatus?.planInfo ?? {};
  const credit = (available, monthly) => (Number.isFinite(available) && Number.isFinite(monthly) && monthly > 0
    ? { available, monthly } : null);
  const models = (status.cascadeModelConfigData?.clientModelConfigs ?? []).flatMap((config) => {
    const quota = config?.quotaInfo;
    if (typeof config?.label !== 'string' || !quota || !Number.isFinite(quota.remainingFraction)) return [];
    const resetAt = Date.parse(quota.resetTime);
    return [{
      label: config.label.slice(0, 80),
      remainingFraction: Math.min(1, Math.max(0, quota.remainingFraction)),
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
    }];
  });
  return {
    plan: typeof plan.planName === 'string' ? plan.planName.slice(0, 40) : null,
    credits: {
      prompt: credit(status.planStatus?.availablePromptCredits, plan.monthlyPromptCredits),
      flow: credit(status.planStatus?.availableFlowCredits, plan.monthlyFlowCredits),
    },
    models,
  };
}

/** Return true when a process with this PID exists. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** Ask a live local Antigravity language server for quota; only loopback is contacted. */
export async function fetchAntigravity(root, { fetchImpl = fetch, isAlive = alive } = {}) {
  let names;
  try { names = await readdir(join(root, 'daemon')); } catch { return { status: 'unavailable', reason: 'no-daemon' }; }
  for (const name of names.filter((item) => /^hub_\d+\.json$/.test(item))) {
    let hub;
    try { hub = JSON.parse(await readFile(join(root, 'daemon', name), 'utf8')); } catch { continue; }
    if (!Number.isSafeInteger(hub?.pid) || !isAlive(hub.pid)) continue;
    if (!Number.isSafeInteger(hub.httpPort) || hub.httpPort < 1 || hub.httpPort > 65535 || typeof hub.csrfToken !== 'string') continue;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${hub.httpPort}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': hub.csrfToken },
        body: '{}',
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) continue;
      const quota = antigravityQuota(await response.json());
      if (quota) return { status: 'ok', ...quota };
    } catch { /* Try the next live server. */ }
  }
  return { status: 'unavailable', reason: 'no-live-server' };
}

/** Decode a JWT's `exp` claim in milliseconds without verifying it; null when absent. */
export function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Read the cursor-agent access token from the macOS keychain; null when absent or not on macOS. */
function cursorToken({ platform = process.platform } = {}) {
  if (platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', 'cursor-access-token', '-w'], { timeout: 3000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

/**
 * Keep the plan percentages, optional dollar figures and the billing cycle from Cursor's current-period usage.
 * Percent fields are what Cursor's own UI shows; dollar fields appear only on some plans.
 */
export function cursorUsage(body) {
  const usage = body?.planUsage;
  if (!usage || typeof usage !== 'object') return null;
  const finite = (value) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
  const percent = (value) => (finite(value) === null ? null : Math.min(100, Math.max(0, finite(value))));
  const cycleEnd = finite(body.billingCycleEnd);
  return {
    totalPercent: percent(usage.totalPercentUsed),
    autoPercent: percent(usage.autoPercentUsed),
    apiPercent: percent(usage.apiPercentUsed),
    spentCents: finite(usage.totalSpend),
    limitCents: finite(usage.limit),
    remainingCents: finite(usage.remaining),
    cycleEndAt: cycleEnd && cycleEnd > 0 ? cycleEnd : null,
    message: typeof body.displayMessage === 'string' ? body.displayMessage.slice(0, 160) : null,
  };
}

/** Keep the plan name and how often included usage resets from Cursor's plan info. */
export function cursorPlan(body) {
  const info = body?.planInfo;
  if (!info || typeof info !== 'object') return null;
  const period = { INCLUDED_USAGE_PERIOD_WEEKLY: 'weekly', INCLUDED_USAGE_PERIOD_MONTHLY: 'monthly' }[info.includedUsagePeriod] ?? null;
  const resetsAt = Number(info.includedUsageResetsAt);
  return {
    name: typeof info.planName === 'string' && info.planName.trim() ? info.planName.trim().slice(0, 40) : null,
    includedPeriod: period,
    includedResetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

/** Keep prepaid credit totals in cents; top-up history and payment details are dropped. */
export function cursorCredits(body) {
  const cents = (value) => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
  const available = cents(body?.availableCents);
  if (available === null) return null;
  return {
    availableCents: available,
    fundedCents: cents(body.fundedCents),
    spentCents: cents(body.spentCents),
    spentThisMonthCents: cents(body.spentThisMonthCents),
    monthlyLimitCents: cents(body.monthlySpendLimitCents ?? body.monthlyLimitCents),
  };
}

/** Call one read-only Cursor dashboard RPC; resolves to the parsed body or rejects with the HTTP status. */
async function cursorRpc(method, token, fetchImpl) {
  const response = await fetchImpl(`${CURSOR_DASHBOARD_URL}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: '{}',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Object.assign(new Error(`http-${response.status}`), { status: response.status });
  return response.json();
}

/**
 * Query Cursor's own dashboard RPCs with the cursor-agent login: period usage is required, while plan info and
 * prepaid credits are best effort. Skips the network when the token is missing or expired.
 */
export async function fetchCursor({ readToken = cursorToken, fetchImpl = fetch, now = Date.now() } = {}) {
  const token = await readToken();
  if (!token) return { status: 'auth-missing' };
  const expiry = tokenExpiry(token);
  if (expiry !== null && expiry <= now) return { status: 'auth-expired', expiredAt: expiry };
  let body;
  try {
    body = await cursorRpc('GetCurrentPeriodUsage', token, fetchImpl);
  } catch (error) {
    if (error.status === 401 || error.status === 403) return { status: 'auth-expired', expiredAt: expiry };
    return { status: 'error', reason: error.status ? `http-${error.status}` : 'network' };
  }
  const usage = cursorUsage(body);
  if (!usage) return { status: 'error', reason: 'unexpected-response' };
  const [plan, prepaid] = await Promise.all([
    cursorRpc('GetPlanInfo', token, fetchImpl).catch(() => null),
    cursorRpc('GetUserPrepaidBilling', token, fetchImpl).catch(() => null),
  ]);
  return { status: 'ok', ...usage, plan: cursorPlan(plan), credits: cursorCredits(prepaid) };
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_WINDOWS = [['five_hour', 300], ['seven_day', 10080], ['seven_day_opus', 10080], ['seven_day_sonnet', 10080]];

/** Read Claude Code's stored OAuth credentials: the macOS keychain, else `~/.claude/.credentials.json`. */
async function claudeCredentials({ platform = process.platform, home = homedir() } = {}) {
  const text = platform === 'darwin'
    ? await new Promise((resolve) => {
      execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout));
    })
    : await readFile(join(home, '.claude', '.credentials.json'), 'utf8').catch(() => null);
  try {
    return text ? JSON.parse(text).claudeAiOauth ?? null : null;
  } catch {
    return null;
  }
}

/** Read model-scoped weekly limits (e.g. Fable) from the `limits` array; the scope is a short model display name. */
function claudeScopedWindows(limits) {
  if (!Array.isArray(limits)) return [];
  return limits.flatMap((limit) => {
    const scope = limit?.scope?.model?.display_name;
    if (limit?.kind !== 'weekly_scoped' || typeof scope !== 'string' || !scope.trim() || !Number.isFinite(limit.percent)) return [];
    const resetsAt = Date.parse(limit.resets_at);
    return [{
      name: 'weekly_scoped',
      scope: scope.trim().slice(0, 40),
      usedPercent: Math.min(100, Math.max(0, limit.percent)),
      windowMinutes: 10080,
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
    }];
  });
}

/** Keep the plan-limit windows from Claude's OAuth usage response as percent used and reset time. */
export function claudeLimits(body, { plan = null, observedAt = Date.now() } = {}) {
  if (!body || typeof body !== 'object') return null;
  const windows = CLAUDE_WINDOWS.flatMap(([name, windowMinutes]) => {
    const item = body[name];
    if (!item || !Number.isFinite(item.utilization)) return [];
    const resetsAt = Date.parse(item.resets_at);
    return [{ name, usedPercent: Math.min(100, Math.max(0, item.utilization)), windowMinutes, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }];
  });
  windows.push(...claudeScopedWindows(body.limits));
  if (!windows.length) return null;
  const safePlan = typeof plan === 'string' && /^[a-z0-9_-]{1,32}$/i.test(plan) ? plan : null;
  return { plan: safePlan, windows, observedAt, limitReached: windows.some((window) => window.usedPercent >= 100) };
}

/**
 * Ask Anthropic for the Claude plan limits with Claude Code's own login. An expired token is never refreshed here,
 * because rotating it would sign Claude Code out; Claude Code refreshes it on its next use.
 */
export async function fetchClaudeLimits({ readCredentials = claudeCredentials, fetchImpl = fetch, now = Date.now() } = {}) {
  const oauth = await readCredentials();
  if (!oauth?.accessToken) return { status: 'auth-missing' };
  if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= now) return { status: 'auth-expired' };
  try {
    const response = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) return { status: 'auth-expired' };
    if (!response.ok) return { status: 'error', reason: `http-${response.status}` };
    const limits = claudeLimits(await response.json(), { plan: oauth.subscriptionType, observedAt: now });
    return limits ? { status: 'ok', limits } : { status: 'error', reason: 'unexpected-response' };
  } catch {
    return { status: 'error', reason: 'network' };
  }
}

export const USAGE_TOOLS = ['claude', 'codex', 'antigravity', 'cursor'];

/** Parse a comma-separated tool list from a request query, keeping only known tools in canonical order. */
export function parseUsageTools(value) {
  const requested = new Set(String(value ?? '').split(',').map((item) => item.trim()));
  return USAGE_TOOLS.filter((tool) => requested.has(tool));
}

/** Default cache file for the last usage snapshot: the user cache directory, never the read-only state inputs. */
export function defaultUsageCachePath({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (env.AI_TEAM_MONITORING_USAGE_CACHE) return env.AI_TEAM_MONITORING_USAGE_CACHE;
  const base = env.XDG_CACHE_HOME || (platform === 'darwin' ? join(home, 'Library', 'Caches') : join(home, '.cache'));
  return join(base, 'ai-team-monitoring', 'tool-usage.json');
}

const CACHE_VERSION = 1;

/**
 * Keep a background snapshot of each tool's usage so the two-second dashboard refresh never waits on log scans
 * or remote calls. Every tool starts disabled; only tools passed to setEnabled are read or contacted. With a
 * cachePath, the last snapshot per tool survives restarts and is shown until that tool is due again.
 */
export class ToolUsageCollector {
  /** Configure roots from the user's home and path overrides; nothing is collected until a tool is enabled. */
  constructor({
    home = homedir(),
    env = process.env,
    cachePath = null,
    fetchAntigravityImpl = fetchAntigravity,
    fetchCursorImpl = fetchCursor,
    fetchClaudeLimitsImpl = fetchClaudeLimits,
  } = {}) {
    this.trackers = {
      claude: new LogUsageTracker({ root: env.CLAUDE_PROJECTS_DIR || join(home, '.claude', 'projects'), depth: 3, marker: '"usage"', parse: parseClaudeRows }),
      codex: new LogUsageTracker({ root: env.CODEX_SESSIONS_DIR || join(home, '.codex', 'sessions'), depth: 3, marker: '"token_count"', parse: parseCodexRows }),
    };
    const antigravityRoot = env.ANTIGRAVITY_DIR || join(home, '.gemini', 'antigravity');
    this.fetchers = {
      claude: (now) => fetchClaudeLimitsImpl({ now }),
      antigravity: () => fetchAntigravityImpl(antigravityRoot),
      cursor: (now) => fetchCursorImpl({ now }),
    };
    this.cachePath = cachePath;
    this.enabled = new Set();
    this.loaded = new Set();
    this.remote = {};
    this.saved = {};
    this.toolRefreshedAt = {};
    this.lastForced = {};
    this.running = null;
    this.runningTools = new Set();
    this.ready = this.#loadCache();
  }

  /** Restore the last saved snapshot; a missing or unreadable cache just means starting empty. */
  async #loadCache() {
    if (!this.cachePath) return;
    try {
      const cache = JSON.parse(await readFile(this.cachePath, 'utf8'));
      if (cache?.version !== CACHE_VERSION || typeof cache.tools !== 'object') return;
      for (const tool of USAGE_TOOLS) {
        const entry = cache.tools[tool];
        if (!entry || !Number.isFinite(entry.refreshedAt) || typeof entry.data !== 'object') continue;
        this.saved[tool] = entry.data;
        this.toolRefreshedAt[tool] ??= entry.refreshedAt;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`tool usage cache unreadable: ${error.code ?? error.name}`);
    }
  }

  /** Write every tool's latest snapshot atomically with owner-only permissions. */
  async #saveCache() {
    if (!this.cachePath) return;
    const tools = {};
    for (const tool of USAGE_TOOLS) {
      const data = this.loaded.has(tool) ? this.#liveSnapshot(tool) : this.saved[tool];
      if (data && Number.isFinite(this.toolRefreshedAt[tool])) tools[tool] = { refreshedAt: this.toolRefreshedAt[tool], data };
    }
    const temp = `${this.cachePath}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.cachePath), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify({ version: CACHE_VERSION, tools }), { mode: 0o600 });
      await rename(temp, this.cachePath);
    } catch (error) {
      console.error(`tool usage cache write failed: ${error.code ?? error.name}`);
    }
  }

  /** Switch collection to exactly these tools; a disabled tool keeps its last data but is no longer read. */
  setEnabled(tools) {
    this.enabled = new Set(parseUsageTools([...tools].join(',')));
  }

  /** True when an enabled tool has never been read or its last read is older than the refresh interval. */
  #due(now) {
    return [...this.enabled].some((tool) => !(now - (this.toolRefreshedAt[tool] ?? -Infinity) < USAGE_REFRESH_MS));
  }

  /**
   * Refresh now on a user's request: the given enabled tools, or every enabled tool. Each tool is forced at most
   * once per USAGE_FORCE_MIN_MS so repeated clicks cannot flood remote APIs. Returns true when a refresh started.
   */
  requestRefresh(now = Date.now(), tools = null) {
    if (this.running) return false;
    const wanted = tools ? parseUsageTools([...tools].join(',')) : [...this.enabled];
    const targets = wanted.filter((tool) => this.enabled.has(tool) && !(now - (this.lastForced[tool] ?? -Infinity) < USAGE_FORCE_MIN_MS));
    if (!targets.length) return false;
    for (const tool of targets) this.lastForced[tool] = now;
    this.refresh(now, targets).catch(() => {});
    return true;
  }

  /** Refresh the given tools (default: every enabled tool) once; concurrent callers share the same run. */
  refresh(now = Date.now(), tools = [...this.enabled]) {
    if (this.running) return this.running;
    // Mark the tools synchronously so the very next snapshot already reports them as refreshing.
    for (const tool of tools) if (this.enabled.has(tool)) this.runningTools.add(tool);
    this.running = this.#refresh(now, tools).finally(() => {
      this.running = null;
      this.runningTools.clear();
    });
    return this.running;
  }

  /** Run each source independently so one failure does not hide the others, then save the cache. */
  async #refresh(now, requested) {
    await this.ready;
    const tools = requested.filter((tool) => this.enabled.has(tool));
    const results = await Promise.allSettled(tools.map((tool) => this.#refreshTool(tool, now)));
    results.forEach((result, index) => {
      const tool = tools[index];
      if (result.status === 'rejected') {
        console.error(`tool usage refresh failed (${tool}): ${result.reason?.code ?? result.reason?.name ?? 'unknown'}`);
        return;
      }
      this.loaded.add(tool);
      this.toolRefreshedAt[tool] = now;
    });
    await this.#saveCache();
  }

  /** Read a tool's logs and call its remote source; Claude has both. */
  async #refreshTool(tool, now) {
    const fetcher = this.fetchers[tool];
    const [, remote] = await Promise.all([this.trackers[tool]?.refresh(now), fetcher?.(now)]);
    if (fetcher) this.remote[tool] = { ...remote, observedAt: now };
  }

  /** Build a tool's snapshot from what this process has read. */
  #liveSnapshot(tool) {
    const tracker = this.trackers[tool];
    if (!tracker) return this.remote[tool] ?? { status: 'loading' };
    if (tracker.missing) return { status: 'missing' };
    if (tool === 'claude') {
      const remote = this.remote.claude ?? { status: 'loading' };
      return { status: 'ok', hourly: tracker.hourly(), limits: remote.limits ?? null, limitsStatus: remote.status };
    }
    return { status: 'ok', hourly: tracker.hourly(), limits: tracker.latestLimits() };
  }

  /**
   * Report one tool's last known data — read in this process or restored from the cache — even while it is not
   * enabled or is being refreshed, so pages never blank out between reads. Only a tool with no data at all reports
   * `disabled` (nobody asked for it) or `loading` (first read in progress). Each page shows only the tools it checked.
   */
  #toolSnapshot(tool) {
    if (this.loaded.has(tool)) return this.#liveSnapshot(tool);
    if (this.saved[tool]) return { ...this.saved[tool], cached: true };
    return { status: this.enabled.has(tool) ? 'loading' : 'disabled' };
  }

  /** Start the periodic refresh when due and return the latest snapshot immediately. */
  snapshot(now = Date.now()) {
    if (this.enabled.size && !this.running && this.#due(now)) this.refresh(now).catch(() => {});
    const times = [...this.enabled].map((tool) => this.toolRefreshedAt[tool]).filter(Number.isFinite);
    return {
      retentionHours: USAGE_RETENTION_MS / HOUR_MS,
      refreshing: Boolean(this.running),
      refreshingTools: [...this.runningTools],
      refreshedAtByTool: Object.fromEntries(USAGE_TOOLS.filter((tool) => Number.isFinite(this.toolRefreshedAt[tool])).map((tool) => [tool, this.toolRefreshedAt[tool]])),
      refreshedAt: times.length ? Math.min(...times) : null,
      nextRefreshAt: times.length ? Math.min(...times) + USAGE_REFRESH_MS : null,
      ...Object.fromEntries(USAGE_TOOLS.map((tool) => [tool, this.#toolSnapshot(tool)])),
    };
  }
}
