/** Verify per-tool usage collection from fake Claude/Codex logs and stubbed Antigravity/Cursor responses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LogUsageTracker, ToolUsageCollector, USAGE_FORCE_MIN_MS, defaultUsageCachePath, USAGE_REFRESH_MS, antigravityQuota, claudeLimits, fetchClaudeLimits, parseUsageTools, codexDelta, fetchAntigravity, fetchCursor,
  parseClaudeRows, parseCodexRows, readAppendedLines, tokenExpiry,
} from '../adapters/tool-usage.mjs';

const now = Date.parse('2026-11-27T03:30:00Z');
const iso = (value) => new Date(value).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;

/** Make a throwaway directory removed after the test. */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'aimon-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Build a Claude assistant row with the given message id and usage. */
function claudeRow(id, at, usage) {
  return { type: 'assistant', timestamp: iso(at), message: { id, usage }, cwd: '/private/path', sessionId: 'PRIVATE_SESSION' };
}

/** Build a Codex token_count row with cumulative totals and optional rate limits. */
function codexRow(at, total, rateLimits = null) {
  return {
    timestamp: iso(at), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total }, rate_limits: rateLimits },
  };
}

/** Make an unsigned JWT-shaped token with the given expiry. */
function fakeToken(expSeconds) {
  return `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`;
}

test('readAppendedLines keeps an unfinished row for the next read and filters by marker', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'a.jsonl');
  await writeFile(path, 'skip\n{"usage":1}\n{"usage":2');
  const first = await readAppendedLines(path, 0, 27, '"usage"');
  assert.deepEqual(first.lines, ['{"usage":1}']);
  assert.equal(first.offset, 17);
  await appendFile(path, '}\n');
  const second = await readAppendedLines(path, first.offset, 29, '"usage"');
  assert.deepEqual(second.lines, ['{"usage":2}']);
  assert.equal(second.offset, 29);
});

test('Claude tracker counts each streamed message once and reads only appended rows', async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, 'project', 'session', 'subagents'), { recursive: true });
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 };
  const main = join(root, 'project', 'main.jsonl');
  await writeFile(main, line(claudeRow('m1', now - 60000, usage)) + line(claudeRow('m1', now - 60000, usage)) + line({ type: 'user', message: { content: 'PRIVATE_PROMPT' } }));
  await writeFile(join(root, 'project', 'session', 'subagents', 'agent.jsonl'), line(claudeRow('m2', now - 7200000, usage)));
  const tracker = new LogUsageTracker({ root, depth: 3, marker: '"usage"', parse: parseClaudeRows });
  await tracker.refresh(now);
  const total = () => tracker.hourly().reduce((sum, bucket) => ({
    newInput: sum.newInput + bucket.newInput, cached: sum.cached + bucket.cached, output: sum.output + bucket.output, messages: sum.messages + bucket.messages,
  }), { newInput: 0, cached: 0, output: 0, messages: 0 });
  assert.deepEqual(total(), { newInput: 30, cached: 200, output: 14, messages: 2 });
  assert.equal(tracker.hourly().length, 2);
  await appendFile(main, line(claudeRow('m3', now, { ...usage, output_tokens: 1 })));
  await tracker.refresh(now);
  assert.equal(total().messages, 3);
  assert.equal(JSON.stringify(tracker.hourly()).includes('PRIVATE'), false);
});

test('Claude tracker drops rows outside the retention window and reports a missing root', async (t) => {
  const root = await tempDir(t);
  await writeFile(join(root, 'old.jsonl'), line(claudeRow('old', now - 8 * 86400000, { output_tokens: 9 })));
  const tracker = new LogUsageTracker({ root, depth: 3, marker: '"usage"', parse: parseClaudeRows });
  await tracker.refresh(now);
  assert.deepEqual(tracker.hourly(), []);
  const missing = new LogUsageTracker({ root: join(root, 'nope'), depth: 3, marker: '"usage"', parse: parseClaudeRows });
  await missing.refresh(now);
  assert.equal(missing.missing, true);
});

test('codexDelta turns cumulative totals into per-event usage and restarts on a smaller total', () => {
  const first = { input: 100, cached: 60, cacheWrite: 0, output: 10 };
  assert.deepEqual(codexDelta(null, first), { newInput: 40, cacheWrite: 0, cached: 60, output: 10, messages: 1 });
  assert.deepEqual(codexDelta(first, { input: 150, cached: 100, cacheWrite: 0, output: 12 }), { newInput: 10, cacheWrite: 0, cached: 40, output: 2, messages: 1 });
  assert.equal(codexDelta(first, first), null);
  assert.deepEqual(codexDelta(first, { input: 20, cached: 0, cacheWrite: 0, output: 1 }), { newInput: 20, cacheWrite: 0, cached: 0, output: 1, messages: 1 });
});

test('Codex tracker sums session deltas and keeps the newest rate limits across files', async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, '2026', '11', '27'), { recursive: true });
  const limits = (percent, plan) => ({ primary: { used_percent: percent, window_minutes: 10080, resets_at: 1796341257 }, secondary: null, plan_type: plan });
  await writeFile(join(root, '2026', '11', '27', 'a.jsonl'),
    line(codexRow(now - 600000, { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 }, limits(40, 'pro')))
    + line(codexRow(now - 500000, { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 }, limits(41, 'pro')))
    + line(codexRow(now - 400000, { input_tokens: 150, cached_input_tokens: 100, output_tokens: 12 }, null)));
  await writeFile(join(root, '2026', '11', '27', 'b.jsonl'),
    line(codexRow(now - 100000, { input_tokens: 30, cached_input_tokens: 0, output_tokens: 3 }, limits(55, 'pro'))));
  const tracker = new LogUsageTracker({ root, depth: 3, marker: '"token_count"', parse: parseCodexRows });
  await tracker.refresh(now);
  const [bucket] = tracker.hourly();
  assert.deepEqual({ newInput: bucket.newInput, cached: bucket.cached, output: bucket.output, messages: bucket.messages }, { newInput: 80, cached: 100, output: 15, messages: 3 });
  const latest = tracker.latestLimits();
  assert.equal(latest.plan, 'pro');
  assert.equal(latest.windows[0].usedPercent, 55);
  assert.equal(latest.windows[0].resetsAt, 1796341257000);
});

test('antigravityQuota keeps plan, credits and model quota but never names or emails', () => {
  const quota = antigravityQuota({ userStatus: {
    name: 'PRIVATE_NAME', email: 'private@example.com',
    planStatus: { planInfo: { planName: 'Pro', monthlyPromptCredits: 50000, monthlyFlowCredits: 0 }, availablePromptCredits: 500, availableFlowCredits: 100 },
    cascadeModelConfigData: { clientModelConfigs: [
      { label: 'Model A', quotaInfo: { remainingFraction: 0.25, resetTime: '2026-12-03T23:48:33Z' } },
      { label: 'Model B', quotaInfo: {} },
    ] },
  } });
  assert.deepEqual(quota, {
    plan: 'Pro',
    credits: { prompt: { available: 500, monthly: 50000 }, flow: null },
    models: [{ label: 'Model A', remainingFraction: 0.25, resetAt: Date.parse('2026-12-03T23:48:33Z') }],
  });
  assert.equal(antigravityQuota({}), null);
});

test('fetchAntigravity calls only a live loopback server with its CSRF token', async (t) => {
  const root = await tempDir(t);
  await mkdir(join(root, 'daemon'));
  await writeFile(join(root, 'daemon', 'hub_1.json'), JSON.stringify({ pid: 1, httpPort: 1111, csrfToken: 'dead-token' }));
  await writeFile(join(root, 'daemon', 'hub_2.json'), JSON.stringify({ pid: 2, httpPort: 2222, csrfToken: 'live-token' }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, token: init.headers['X-Codeium-Csrf-Token'] });
    return { ok: true, json: async () => ({ userStatus: { planStatus: { planInfo: { planName: 'Pro' } }, cascadeModelConfigData: { clientModelConfigs: [] } } }) };
  };
  const result = await fetchAntigravity(root, { fetchImpl, isAlive: (pid) => pid === 2 });
  assert.equal(result.status, 'ok');
  assert.equal(result.plan, 'Pro');
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:2222/exa.language_server_pb.LanguageServerService/GetUserStatus', token: 'live-token' }]);
  assert.equal(JSON.stringify(result).includes('live-token'), false);
  assert.deepEqual(await fetchAntigravity(join(root, 'nope')), { status: 'unavailable', reason: 'no-daemon' });
});

test('fetchCursor skips the network for a missing or expired token and maps 401 to auth-expired', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 401 }; };
  assert.deepEqual(await fetchCursor({ readToken: async () => null, fetchImpl, now }), { status: 'auth-missing' });
  const expired = fakeToken(now / 1000 - 60);
  assert.equal((await fetchCursor({ readToken: async () => expired, fetchImpl, now })).status, 'auth-expired');
  assert.equal(calls, 0);
  const valid = fakeToken(now / 1000 + 3600);
  assert.equal(tokenExpiry(valid), now + 3600000);
  assert.equal((await fetchCursor({ readToken: async () => valid, fetchImpl, now })).status, 'auth-expired');
  assert.equal(calls, 1);
});

test('fetchCursor combines period usage, plan info and prepaid credits without payment history', async () => {
  const token = fakeToken(now / 1000 + 3600);
  const auth = [];
  const bodies = {
    GetCurrentPeriodUsage: {
      billingCycleStart: '1795415341767', billingCycleEnd: '1796020141767',
      planUsage: { autoPercentUsed: 100, totalPercentUsed: 100, remainingBonus: false },
      displayMessage: "You've hit your usage limit", email: 'x@example.com',
    },
    GetPlanInfo: { planInfo: { planName: 'Ultra', price: '', includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY', includedUsageResetsAt: '1796020141767' } },
    GetUserPrepaidBilling: { billingMode: 'PREPAID_BILLING_MODE_PREPAID', availableCents: '163791', fundedCents: '220000', spentCents: '56209', spentThisMonthCents: '56212', topUps: [{ ticket: 'PRIVATE_TICKET', amountCents: '220000' }] },
  };
  const fetchImpl = async (url, init) => {
    auth.push(init.headers.Authorization);
    return { ok: true, status: 200, json: async () => bodies[url.split('/').at(-1)] };
  };
  const result = await fetchCursor({ readToken: async () => token, fetchImpl, now });
  assert.deepEqual(result, {
    status: 'ok', totalPercent: 100, autoPercent: 100, apiPercent: null,
    spentCents: null, limitCents: null, remainingCents: null,
    cycleEndAt: 1796020141767, message: "You've hit your usage limit",
    plan: { name: 'Ultra', includedPeriod: 'weekly', includedResetsAt: 1796020141767 },
    credits: { availableCents: 163791, fundedCents: 220000, spentCents: 56209, spentThisMonthCents: 56212, monthlyLimitCents: null },
  });
  assert.equal(JSON.stringify(result).includes('PRIVATE_TICKET'), false);
  assert.deepEqual(auth, [`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`]);
});

test('fetchCursor keeps period usage when plan info or credits fail', async () => {
  const token = fakeToken(now / 1000 + 3600);
  const fetchImpl = async (url) => (url.endsWith('GetCurrentPeriodUsage')
    ? { ok: true, status: 200, json: async () => ({ planUsage: { totalPercentUsed: 40 } }) }
    : { ok: false, status: 500 });
  const result = await fetchCursor({ readToken: async () => token, fetchImpl, now });
  assert.equal(result.status, 'ok');
  assert.equal(result.totalPercent, 40);
  assert.equal(result.plan, null);
  assert.equal(result.credits, null);
});

test('ToolUsageCollector reads nothing until a tool is enabled and forgets a tool once disabled', async (t) => {
  const home = await tempDir(t);
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', 's.jsonl'), line(claudeRow('m1', now, { output_tokens: 4 })));
  let remote = 0;
  const stub = async () => { remote += 1; return { status: 'ok' }; };
  const collector = new ToolUsageCollector({ home, env: {}, fetchAntigravityImpl: stub, fetchCursorImpl: stub, fetchClaudeLimitsImpl: async () => ({ status: 'auth-expired' }) });
  await collector.refresh(now);
  const off = collector.snapshot(now);
  assert.equal(remote, 0);
  for (const tool of ['claude', 'codex', 'antigravity', 'cursor']) assert.equal(off[tool].status, 'disabled');
  collector.setEnabled(['claude', 'antigravity', 'cursor', 'unknown']);
  assert.equal(collector.snapshot(now).claude.status, 'loading');
  await collector.refresh(now);
  const on = collector.snapshot(now + 1000);
  assert.equal(remote, 2);
  assert.equal(on.claude.status, 'ok');
  assert.equal(on.claude.limitsStatus, 'auth-expired');
  assert.equal(on.refreshedAt, now);
  assert.equal(on.nextRefreshAt, now + USAGE_REFRESH_MS);
  assert.equal(on.claude.hourly[0].output, 4);
  assert.equal(on.antigravity.status, 'ok');
  assert.equal(on.codex.status, 'disabled');
  collector.setEnabled(['antigravity']);
  assert.equal(collector.snapshot(now + 2000).claude.status, 'disabled');
  assert.equal(collector.snapshot(now + 2000).cursor.status, 'disabled');
  // 끄면 조회만 멈추고 데이터는 남겨 두어, 새로고침 등으로 다시 켤 때 로딩 없이 바로 보인다.
  assert.equal(collector.trackers.claude.files.size, 1);
  collector.setEnabled(['antigravity', 'claude']);
  assert.equal(collector.snapshot(now + 3000).claude.status, 'ok');
  assert.equal(collector.running, null);
  assert.equal(remote, 2);
});

test('parseUsageTools keeps known tools in canonical order', () => {
  assert.deepEqual(parseUsageTools('cursor,claude,evil,claude'), ['claude', 'cursor']);
  assert.deepEqual(parseUsageTools(null), []);
});

/** Load the real dashboard script with a minimal DOM and render only the tool usage card. */
async function renderCard(toolUsage, timeWindow = '3h', checked = ['claude', 'codex', 'antigravity', 'cursor'], detailTool = null) {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const element = () => ({
    textContent: '', children: [], classList: { toggle() {} }, attributes: {},
    setAttribute(key, value) { this.attributes[key] = String(value); }, addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  const document = {
    documentElement: { dataset: {} }, createElement: element, createElementNS: element, addEventListener() {},
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
  };
  const context = { document, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null } };
  runInNewContext(source, context);
  runInNewContext(`state = ${JSON.stringify({ generatedAt: now, toolUsage })}; timeWindow = ${JSON.stringify(timeWindow)}; usageTools = new Set(${JSON.stringify(checked)}); usageDetailTool = ${JSON.stringify(detailTool)}; renderToolUsage();`, context);
  const text = (node) => (node ? [node.textContent, ...(node.children ?? []).map(text)].join(' ') : '');
  const names = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', cursor: 'Cursor' };
  const chips = Object.entries(names).map(([tool, name]) => `${name} ${text(nodes.get(`#tool-headline-${tool}`))} ${text(nodes.get(`#tool-body-${tool}`))} [${nodes.get(`#tool-open-${tool}`)?.attributes.title ?? ''}]`);
  return { detail: text(nodes.get('#usage-detail')), detailHidden: nodes.get('#usage-detail')?.hidden, card: nodes.get('#tool-usage'), text: chips.join(' | '), pill: nodes.get('#tool-usage-window')?.textContent, refreshed: nodes.get('#usage-refreshed')?.textContent };
}

test('footer usage chips sum the selected window and shows limits, credits and opt-in states', async () => {
  const bucket = (hour, output) => ({ hour, newInput: 100, cacheWrite: 0, cached: 1000, output, messages: 1 });
  const hour = Math.floor(now / 3600000) * 3600000;
  const { card, text, pill, refreshed } = await renderCard({
    retentionHours: 168,
    refreshing: false, refreshedAt: now, nextRefreshAt: now + 600000,
    claude: { status: 'ok', hourly: [bucket(hour - 10 * 3600000, 5), bucket(hour, 7)], limits: { plan: 'team', observedAt: now, limitReached: false, windows: [{ name: 'five_hour', usedPercent: 4, windowMinutes: 300, resetsAt: now + 3600000 }, { name: 'seven_day', usedPercent: 36, windowMinutes: 10080, resetsAt: now + 86400000 }] }, limitsStatus: 'ok' },
    codex: { status: 'ok', hourly: [bucket(hour, 3)], limits: { plan: 'pro', observedAt: now, limitReached: false, windows: [{ name: 'primary', usedPercent: 53, windowMinutes: 10080, resetsAt: now + 86400000 }] } },
    antigravity: { status: 'ok', plan: 'Pro', credits: { prompt: { available: 500, monthly: 50000 }, flow: null }, models: [{ label: 'Model A', remainingFraction: 0.4, resetAt: now + 3600000 }], observedAt: now },
    cursor: { status: 'auth-expired' },
  });
  const cursor = await renderCard({ retentionHours: 168, claude: { status: 'disabled' }, codex: { status: 'disabled' }, antigravity: { status: 'disabled' }, cursor: { status: 'ok', totalPercent: 100, autoPercent: 100, apiPercent: null, spentCents: null, limitCents: null, remainingCents: null, cycleEndAt: now + 86400000, message: "You've hit your usage limit", observedAt: now } });
  assert.match(cursor.text, /Cursor\s+포함 100%\s+한도 도달.*You've hit your usage limit/s);
  assert.equal(card.hidden, false);
  assert.equal(pill, '3H');
  assert.equal(refreshed, '12:30 조회');
  assert.match(text, /Claude Code\s+5시간 4%/);
  assert.match(text, /\[107\n/);
  assert.match(text, /출력 7 · 응답 1/);
  assert.match(text, /Codex\s+주간 53%/);
  // Claude는 5시간·주간 한도를 모두 게이지로 나란히 표시한다.
  assert.match(text, /Claude Code\s+5시간 4%\s+주간 36%/);
  assert.match(text, /team 요금제/);
  assert.match(text, /모델 한도 60%.*최소 잔여 Model A/s);
  assert.match(text, /프롬프트 크레딧 500 \/ 50,000/);
  assert.match(text, /Cursor —\s+인증 만료 · cursor-agent login/);
  // 체크하지 않은 도구는 서버 값과 무관하게 꺼짐, 체크했지만 서버가 아직 켜지 않았으면 시작 중으로 표시한다.
  const all = await renderCard({ retentionHours: 168, claude: { status: 'loading' }, codex: { status: 'disabled' }, antigravity: { status: 'ok', models: [] }, cursor: { status: 'disabled' } }, 'all', ['claude', 'codex']);
  assert.equal(all.pill, '최근 7일');
  assert.match(all.text, /Claude Code —\s+조회 중/);
  assert.match(all.text, /Codex —\s+조회 시작 중/);
  assert.match(all.text, /Antigravity —\s+조회 꺼짐/);
  assert.match(all.text, /Cursor —\s+조회 꺼짐/);
  const hidden = await renderCard(null);
  assert.equal(hidden.card.hidden, true);
});

test('SSE clients enable the union of requested tools and release them on disconnect', { timeout: 8000 }, async (t) => {
  const http = await import('node:http');
  const { createServer } = await import('../server.mjs');
  const base = await tempDir(t);
  const calls = [];
  const toolUsage = { setEnabled: (tools) => calls.push([...tools].sort()), snapshot: () => ({ retentionHours: 168 }) };
  const server = createServer({ base, toolUsage, processes: async () => [] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const open = (path) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path }, (res) => res.once('data', () => resolve(req)));
    req.on('error', reject);
  });
  const first = await open('/api/events?usage=claude,evil');
  const second = await open('/api/events?usage=cursor,claude');
  assert.deepEqual(calls.slice(0, 2), [['claude'], ['claude', 'cursor']]);
  const until = (length) => new Promise((resolve) => { const wait = () => (calls.length >= length ? resolve() : setTimeout(wait, 20)); wait(); });
  second.destroy();
  await until(3);
  assert.deepEqual(calls[2], ['claude']);
  first.destroy();
  await until(4);
  assert.deepEqual(calls[3], []);
});

test('collector refreshes every ten minutes and limits forced refreshes to one per 30 seconds', async (t) => {
  const home = await tempDir(t);
  let calls = 0;
  const stub = async () => { calls += 1; return { status: 'ok' }; };
  const collector = new ToolUsageCollector({ home, env: {}, fetchAntigravityImpl: stub, fetchCursorImpl: stub, fetchClaudeLimitsImpl: stub });
  collector.setEnabled(['cursor']);
  collector.snapshot(now);
  await collector.running;
  assert.equal(calls, 1);
  collector.snapshot(now + USAGE_REFRESH_MS - 1);
  assert.equal(collector.running, null);
  assert.equal(collector.requestRefresh(now + 1000), true);
  await collector.running;
  assert.equal(calls, 2);
  assert.equal(collector.requestRefresh(now + 1000 + USAGE_FORCE_MIN_MS - 1), false);
  assert.equal(collector.requestRefresh(now + 1000 + USAGE_FORCE_MIN_MS), true);
  await collector.running;
  assert.equal(calls, 3);
  collector.setEnabled([]);
  assert.equal(collector.requestRefresh(now + 10 * USAGE_FORCE_MIN_MS), false);
});

test('claudeLimits keeps 5-hour and weekly windows and drops empty ones', () => {
  const limits = claudeLimits({
    five_hour: { utilization: 4, resets_at: '2026-11-27T04:39:59.976068+00:00', used_dollars: null },
    seven_day: { utilization: 36, resets_at: '2026-11-27T00:59:59Z' },
    seven_day_opus: null,
    extra_usage: { is_enabled: false },
    limits: [
      { kind: 'session', percent: 4, resets_at: '2026-11-27T04:39:59Z', scope: null },
      { kind: 'weekly_scoped', percent: 1, resets_at: '2026-11-27T01:00:00Z', scope: { model: { id: null, display_name: 'Fable' } } },
      { kind: 'weekly_scoped', percent: 9, scope: null },
    ],
  }, { plan: 'team', observedAt: now });
  assert.deepEqual(limits, {
    plan: 'team', observedAt: now, limitReached: false,
    windows: [
      { name: 'five_hour', usedPercent: 4, windowMinutes: 300, resetsAt: Date.parse('2026-11-27T04:39:59.976Z') },
      { name: 'seven_day', usedPercent: 36, windowMinutes: 10080, resetsAt: Date.parse('2026-11-27T00:59:59Z') },
      { name: 'weekly_scoped', scope: 'Fable', usedPercent: 1, windowMinutes: 10080, resetsAt: Date.parse('2026-11-27T01:00:00Z') },
    ],
  });
  assert.equal(claudeLimits({}), null);
});

test('fetchClaudeLimits never calls the API with a missing or expired login and keeps the token out of results', async () => {
  let calls = 0;
  let headers = null;
  const fetchImpl = async (url, init) => {
    calls += 1;
    headers = init.headers;
    return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 10, resets_at: '2026-11-27T05:00:00Z' } }) };
  };
  assert.deepEqual(await fetchClaudeLimits({ readCredentials: async () => null, fetchImpl, now }), { status: 'auth-missing' });
  assert.deepEqual(await fetchClaudeLimits({ readCredentials: async () => ({ accessToken: 'SECRET', expiresAt: now - 1 }), fetchImpl, now }), { status: 'auth-expired' });
  assert.equal(calls, 0);
  const result = await fetchClaudeLimits({ readCredentials: async () => ({ accessToken: 'SECRET', expiresAt: now + 60000, subscriptionType: 'team' }), fetchImpl, now });
  assert.equal(result.status, 'ok');
  assert.equal(result.limits.windows[0].usedPercent, 10);
  assert.equal(headers.Authorization, 'Bearer SECRET');
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  const denied = await fetchClaudeLimits({ readCredentials: async () => ({ accessToken: 'SECRET' }), fetchImpl: async () => ({ ok: false, status: 401 }), now });
  assert.deepEqual(denied, { status: 'auth-expired' });
});

test('SSE refresh=1 forces a refresh only for same-origin or direct requests', { timeout: 8000 }, async (t) => {
  const http = await import('node:http');
  const { createServer } = await import('../server.mjs');
  const base = await tempDir(t);
  let forced = 0;
  const toolUsage = { setEnabled() {}, requestRefresh: () => { forced += 1; return true; }, snapshot: () => ({ retentionHours: 168 }) };
  const server = createServer({ base, toolUsage, processes: async () => [] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const open = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path, headers }, (res) => res.once('data', () => { req.destroy(); resolve(); }));
    req.on('error', reject);
  });
  await open('/api/events?usage=claude&refresh=1', { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(forced, 0);
  await open('/api/events?usage=claude&refresh=1', { 'Sec-Fetch-Site': 'same-origin' });
  await open('/api/events?usage=claude&refresh=1');
  await open('/api/events?usage=claude');
  assert.equal(forced, 2);
});

test('usage detail panel lists every limit window with resets, scoped models and token breakdown', async () => {
  const hour = Math.floor(now / 3600000) * 3600000;
  const usage = {
    retentionHours: 168,
    claude: { status: 'ok', limitsStatus: 'ok', hourly: [{ hour, newInput: 120, cacheWrite: 20, cached: 900, output: 30, messages: 2 }], limits: { plan: 'team', observedAt: now, limitReached: false, windows: [
      { name: 'five_hour', usedPercent: 5, windowMinutes: 300, resetsAt: now + 46 * 60000 },
      { name: 'seven_day', usedPercent: 37, windowMinutes: 10080, resetsAt: now + 3 * 3600000 },
      { name: 'weekly_scoped', scope: 'Fable', usedPercent: 1, windowMinutes: 10080, resetsAt: now + 3 * 3600000 },
    ] } },
    codex: { status: 'disabled' }, antigravity: { status: 'disabled' },
    cursor: { status: 'ok', totalPercent: 100, autoPercent: 100, apiPercent: null, spentCents: null, limitCents: null, remainingCents: null, cycleEndAt: now + 86400000, message: "You've hit your usage limit", observedAt: now,
      plan: { name: 'Ultra', includedPeriod: 'weekly', includedResetsAt: now + 86400000 },
      credits: { availableCents: 163791, fundedCents: 220000, spentCents: 56209, spentThisMonthCents: 56212, monthlyLimitCents: null } },
  };
  const closed = await renderCard(usage);
  assert.equal(closed.detailHidden, true);
  // 하단 바에는 모델별(scoped) 한도를 넣지 않아 한 줄을 유지한다.
  assert.doesNotMatch(closed.text, /Fable/);
  const claude = await renderCard(usage, '3h', ['claude', 'cursor'], 'claude');
  assert.equal(claude.detailHidden, false);
  assert.match(claude.detail, /Claude Code\s+team 요금제/);
  assert.match(claude.detail, /5시간\s+5%\s+11\/27 13:16 초기화 · 46분 후/);
  assert.match(claude.detail, /주간 · Fable\s+1%/);
  assert.match(claude.detail, /토큰 \(3H\).*새 입력\s+120.*캐시 쓰기\s+20.*캐시 읽기\s+900.*출력\s+30.*응답\s+2/s);
  const cursor = await renderCard(usage, '3h', ['claude', 'cursor'], 'cursor');
  assert.match(cursor.detail, /Cursor\s+Ultra 요금제/);
  assert.match(cursor.detail, /주간 포함 사용량\s+100%\s+11\/28 12:30 초기화 · 1일 후/);
  assert.match(cursor.detail, /남은 크레딧\s+\$1,637\.91.*이번 달 추가 사용\s+\$562\.12.*월 추가 사용 한도\s+미설정.*충전 합계\s+\$2,200\.00.*Auto 사용률\s+100%/s);
  assert.match(cursor.detail, /추가 크레딧으로 사용 중/);
  assert.doesNotMatch(cursor.detail, /API 사용률|사용 금액/);
  // 하단 바: 포함 사용량을 다 써도 크레딧이 남아 있으면 경고 대신 잔액을 보여 준다.
  assert.match(closed.text, /Cursor\s+주간 100%\s+크레딧 \$1,638/);
  const off = await renderCard(usage, '3h', ['claude'], 'codex');
  assert.match(off.detail, /Codex\s+.*조회 꺼짐/s);
});

test('collector saves the last snapshot and a restarted collector shows it without calling remote sources', async (t) => {
  const { readFile, stat } = await import('node:fs/promises');
  const home = await tempDir(t);
  const cachePath = join(home, 'cache', 'tool-usage.json');
  let calls = 0;
  const cursor = async () => { calls += 1; return { status: 'ok', totalPercent: 42, credits: { availableCents: 100 } }; };
  const claude = async () => { calls += 1; return { status: 'ok', limits: { plan: 'team', windows: [], observedAt: now } }; };
  const options = { home, env: {}, cachePath, fetchCursorImpl: cursor, fetchClaudeLimitsImpl: claude, fetchAntigravityImpl: cursor };
  const first = new ToolUsageCollector(options);
  first.setEnabled(['cursor']);
  first.snapshot(now);
  await first.running;
  assert.equal(calls, 1);
  const saved = JSON.parse(await readFile(cachePath, 'utf8'));
  assert.equal(saved.tools.cursor.refreshedAt, now);
  assert.equal(saved.tools.cursor.data.totalPercent, 42);
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600);

  const restarted = new ToolUsageCollector(options);
  await restarted.ready;
  restarted.setEnabled(['cursor']);
  const shown = restarted.snapshot(now + 60000);
  assert.equal(shown.cursor.status, 'ok');
  assert.equal(shown.cursor.totalPercent, 42);
  assert.equal(shown.cursor.cached, true);
  assert.equal(shown.refreshedAt, now);
  assert.equal(restarted.running, null);
  assert.equal(calls, 1);
  // 10분이 지나면 캐시를 보여 주면서 백그라운드에서 다시 조회한다.
  const due = restarted.snapshot(now + USAGE_REFRESH_MS);
  assert.equal(due.cursor.totalPercent, 42);
  await restarted.running;
  assert.equal(calls, 2);
  assert.equal(restarted.snapshot(now + USAGE_REFRESH_MS).cursor.cached, undefined);
});

test('collector ignores a corrupt cache and defaults the cache to the user cache directory', async (t) => {
  const { writeFile: write } = await import('node:fs/promises');
  const home = await tempDir(t);
  const cachePath = join(home, 'tool-usage.json');
  await write(cachePath, '{not json');
  const collector = new ToolUsageCollector({ home, env: {}, cachePath });
  await collector.ready;
  collector.setEnabled(['cursor']);
  assert.equal(collector.snapshot(now).cursor.status, 'loading');
  assert.equal(defaultUsageCachePath({ env: {}, home: '/h', platform: 'darwin' }), '/h/Library/Caches/ai-team-monitoring/tool-usage.json');
  assert.equal(defaultUsageCachePath({ env: { XDG_CACHE_HOME: '/x' }, home: '/h', platform: 'linux' }), '/x/ai-team-monitoring/tool-usage.json');
  assert.equal(defaultUsageCachePath({ env: { AI_TEAM_MONITORING_USAGE_CACHE: '/c.json' }, home: '/h' }), '/c.json');
});

test('requestRefresh can target one tool and rate-limits each tool separately', async (t) => {
  const home = await tempDir(t);
  const calls = [];
  const stub = (name) => async () => { calls.push(name); return { status: 'ok' }; };
  const collector = new ToolUsageCollector({ home, env: {}, fetchAntigravityImpl: stub('antigravity'), fetchCursorImpl: stub('cursor'), fetchClaudeLimitsImpl: stub('claude') });
  collector.setEnabled(['cursor', 'antigravity']);
  assert.equal(collector.requestRefresh(now, ['cursor', 'claude']), true);
  assert.deepEqual([...collector.runningTools], ['cursor']);
  await collector.running;
  assert.deepEqual(calls, ['cursor']);
  // 같은 도구는 30초 안에 다시 강제할 수 없지만, 다른 도구는 바로 가능하다.
  assert.equal(collector.requestRefresh(now + 1000, ['cursor']), false);
  assert.equal(collector.requestRefresh(now + 1000, ['antigravity']), true);
  await collector.running;
  assert.deepEqual(calls, ['cursor', 'antigravity']);
  const snapshot = collector.snapshot(now + 2000);
  assert.deepEqual(snapshot.refreshedAtByTool, { antigravity: now + 1000, cursor: now });
  assert.deepEqual(snapshot.refreshingTools, []);
  assert.equal(collector.requestRefresh(now + 2000, ['claude']), false);
});

test('SSE refresh with a tool name forwards only known tools', { timeout: 8000 }, async (t) => {
  const http = await import('node:http');
  const { createServer } = await import('../server.mjs');
  const base = await tempDir(t);
  const requests = [];
  const toolUsage = { setEnabled() {}, requestRefresh: (at, tools) => { requests.push(tools); return true; }, snapshot: () => ({ retentionHours: 168 }) };
  const server = createServer({ base, toolUsage, processes: async () => [] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const open = (path) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path, headers: { 'Sec-Fetch-Site': 'same-origin' } }, (res) => res.once('data', () => { req.destroy(); resolve(); }));
    req.on('error', reject);
  });
  await open('/api/events?usage=cursor&refresh=cursor');
  await open('/api/events?usage=cursor&refresh=evil');
  await open('/api/events?usage=cursor&refresh=1');
  assert.deepEqual(requests, [['cursor'], [], null]);
});

test('detail panel offers a per-tool reload with that tool\'s last read time', async () => {
  const usage = {
    retentionHours: 168, refreshing: false, refreshingTools: [], refreshedAtByTool: { cursor: now - 60000 },
    claude: { status: 'disabled' }, codex: { status: 'disabled' }, antigravity: { status: 'disabled' },
    cursor: { status: 'ok', totalPercent: 10, autoPercent: null, apiPercent: null, spentCents: null, limitCents: null, remainingCents: null, cycleEndAt: null, message: null, observedAt: now - 60000 },
  };
  const { detail } = await renderCard(usage, '3h', ['cursor'], 'cursor');
  assert.match(detail, /12:29 조회\s+↻ 다시 조회\s+닫기 ×/);
  const busy = await renderCard({ ...usage, refreshing: true, refreshingTools: ['cursor'] }, '3h', ['cursor'], 'cursor');
  assert.match(busy.detail, /조회 중…\s+↻ 다시 조회/);
});
