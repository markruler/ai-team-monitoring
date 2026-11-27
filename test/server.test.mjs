/** Regression coverage for parsing, read-only collection, privacy and local HTTP transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { collectState, createServer, parseArgs, publicVersion, resolvePaths, parseJsonl, parsePort, pidAlive, redact, retryFlags, summarize, timestamp, usageFromRows, validHost, workerStatus } from '../server.mjs';

const now = Date.parse('2026-11-25T04:00:00Z');

/** Make an isolated input directory and remove it after each test. */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'agent-monitor-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'local-workers'));
  return base;
}

/** Perform a loopback request with custom headers. */
function request(port, path = '/', headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('JSONL ignores broken, primitive and incomplete rows', () => {
  assert.deepEqual(parseJsonl('{"a":1}\nBAD\nnull\n[]\n{"b":2}'), [{ a: 1 }]);
  assert.deepEqual(parseJsonl('{"a":1}\r\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
});

test('timestamps reject missing and invalid dates', () => {
  assert.equal(timestamp(null), null);
  assert.equal(timestamp('invalid'), null);
  assert.equal(timestamp('2026-11-25T04:00:00Z'), now);
});

test('Codex turns accumulate usage without double-counting cached input', () => {
  assert.deepEqual(usageFromRows([
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } },
    { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } },
    { type: 'item.completed', usage: { input_tokens: 9999 }, text: 'private message' },
  ]), { costUsd: null, newInput: 60, input: 120, cached: 60, cacheWrite: null, output: 15, turns: 2 });
});

test('Claude result keeps cache reads apart from new input', () => {
  assert.deepEqual(usageFromRows([{ type: 'result', result: 'private', num_turns: 3, total_cost_usd: 0.5, usage: {
    input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 30, output_tokens: 5,
  } }]), { costUsd: 0.5, newInput: 40, input: 10, cached: 80, cacheWrite: 30, output: 5, turns: 3 });
});

test('6cjmbx-like Claude usage headlines cost and never exposes the cache-inclusive sum', () => {
  // 118 + 170,830 + 7,788,936 + 46,014 = 8,005,898 was the old headline, about 97% cache reads.
  const usage = usageFromRows([
    { type: 'result', num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 1 } },
    { type: 'result', subtype: 'success', num_turns: 87, total_cost_usd: 6.4213, usage: {
      input_tokens: 118, cache_creation_input_tokens: 170830, cache_read_input_tokens: 7788936, output_tokens: 46014,
    } },
  ]);
  assert.deepEqual(usage, { costUsd: 6.4213, newInput: 118 + 170830, input: 118, cacheWrite: 170830, cached: 7788936, output: 46014, turns: 87 });
  assert.equal(Object.hasOwn(usage, 'total'), false);
  assert.equal(Object.values(usage).includes(8005898), false);
});

test('Claude cost and turns may sit inside the usage block', () => {
  const usage = usageFromRows([{ type: 'result', usage: { input_tokens: 1, output_tokens: 2, total_cost_usd: 0.25, num_turns: 4 } }]);
  assert.equal(usage.costUsd, 0.25);
  assert.equal(usage.turns, 4);
});

test('unreported cost, turns and cache figures stay null instead of a fake zero', () => {
  const empty = { costUsd: null, newInput: null, input: null, cacheWrite: null, cached: null, output: null, turns: null };
  assert.deepEqual(usageFromRows([]), empty);
  assert.deepEqual(usageFromRows([{ type: 'assistant', message: 'private' }, { type: 'grok.done', tokens: 99 }]), empty);
  assert.deepEqual(usageFromRows([{ type: 'result', usage: { input_tokens: 7, output_tokens: 3 } }]),
    { costUsd: null, newInput: 7, input: 7, cacheWrite: null, cached: null, output: 3, turns: null });
  assert.deepEqual(usageFromRows([{ type: 'result', total_cost_usd: 0 }]), { ...empty, costUsd: 0 });
});

test('invalid numeric usage counters are ignored', () => {
  assert.deepEqual(usageFromRows([{ type: 'result', total_cost_usd: '1.5', num_turns: -1, usage: { input_tokens: -10, output_tokens: '500' } }]),
    { costUsd: null, newInput: null, input: null, cacheWrite: null, cached: null, output: null, turns: null });
});

test('PID probe uses signal zero and recognizes EPERM', () => {
  assert.equal(pidAlive(42, (pid, signal) => { assert.equal(pid, 42); assert.equal(signal, 0); }), true);
  assert.equal(pidAlive(42, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), true);
  assert.equal(pidAlive(42, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive('42'), false);
});

test('pidAlive ignores Array.some style extra arguments instead of reporting a live PID dead', () => {
  assert.equal(pidAlive(process.pid, 0), true);
  assert.equal(pidAlive(process.pid, 1), true);
  assert.equal([process.pid].some(pidAlive), true);
});

test('completed-no-changes maps to no-changes regardless of mode or live PID', () => {
  for (const mode of [undefined, 'write', 'read-only']) {
    const record = { status: 'completed-no-changes', mode, agentPid: process.pid, heartbeatAt: now };
    assert.equal(workerStatus(record, now), 'no-changes');
    assert.equal(record.status, 'completed-no-changes');
  }
});

test('dry-run, missing and unrecognized statuses stay unknown despite completion metadata', () => {
  // Local dry-run records stop before agent execution; finishedAt does not imply a successful run.
  for (const status of ['dry-run', undefined, null, '', 'unknown', 'unrecognized-result']) {
    for (const mode of ['installed', 'read-only']) {
      const record = { status, mode, finishedAt: now, exitCode: 0, agentPid: process.pid, heartbeatAt: now };
      assert.equal(workerStatus(record, now), 'unknown');
      assert.equal(record.status, status);
    }
  }
});

test('workerStatus calls the liveness probe with exactly one PID', () => {
  const strict = (...args) => {
    if (args.length !== 1) throw new Error(`alive called with ${args.length} arguments`);
    return args[0] === 101;
  };
  assert.equal(workerStatus({ status: 'running', launcherPid: 100, agentPid: 101 }, now, strict), 'running');
  // Default probe on this live test process: the 2026-11-25 regression reported it dead.
  assert.equal(workerStatus({ status: 'running', pid: null, launcherPid: process.pid, agentPid: process.pid }, now), 'running');
});

test('any live launcher, agent or legacy PID keeps an active worker running', () => {
  const only = (target) => (pid) => pid === target;
  assert.equal(workerStatus({ status: 'running', launcherPid: 100, heartbeatAt: now - 3600000 }, now, only(100)), 'running');
  assert.equal(workerStatus({ status: 'starting', agentPid: 101, heartbeatAt: now - 3600000 }, now, only(101)), 'running');
  assert.equal(workerStatus({ status: 'running', pid: 102, heartbeatAt: now - 3600000 }, now, only(102)), 'running');
});

test('a heartbeat within 60 seconds keeps a worker running even when PIDs look dead', () => {
  const dead = () => false;
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(workerStatus({ status: 'running', pid: null, launcherPid: 100, agentPid: 101, heartbeatAt: iso(now - 15000) }, now, dead), 'running');
  assert.equal(workerStatus({ status: 'running', pid: null, heartbeatAt: iso(now - 60000) }, now, dead), 'running');
  assert.equal(workerStatus({ status: 'running', pid: 100, heartbeatAt: now - 60000 }, now, dead), 'running');
  assert.equal(workerStatus({ status: 'running', pid: null, heartbeatAt: iso(now - 60001) }, now, dead), 'dead');
  assert.equal(workerStatus({ status: 'running', launcherPid: 100, agentPid: 101, heartbeatAt: now - 60001 }, now, dead), 'dead');
  assert.equal(workerStatus({ status: 'running', pid: 100 }, now, dead), 'dead');
  const record = { status: 'running', launcherPid: 100, heartbeatAt: now - 120000, startedAt: now };
  assert.equal(workerStatus(record, now, dead), 'dead');
  assert.equal(record.status, 'running');
});

test('PID-free liveness uses newest timestamp and 15 minute boundary', () => {
  assert.equal(workerStatus({ status: 'starting', startedAt: now - 900000 }, now), 'running');
  assert.equal(workerStatus({ status: 'starting', startedAt: now - 900001 }, now), 'dead');
  assert.equal(workerStatus({ status: 'running', startedAt: now - 9999999, steps: [{ at: now - 1 }] }, now), 'running');
  assert.equal(workerStatus({ status: 'running' }, now), 'dead');
  assert.equal(workerStatus({ status: 'succeeded', agentPid: 42 }, now, () => false), 'succeeded');
  assert.equal(workerStatus({ status: 'killed', agentPid: 42, heartbeatAt: now }, now, () => true), 'killed');
});

test('retry detection uses repo+issue+branch and chronological order', () => {
  const records = [
    { repo: 'r', issue: 1, branch: 'a', startedAt: now + 1 },
    { repo: 'r', issue: 1, branch: 'a', startedAt: now },
    { repo: 'r', issue: 1, branch: 'b', startedAt: now + 2 },
    { repo: 'other', issue: 1, branch: 'a', startedAt: now + 3 },
    { repo: 'r', issue: 1, startedAt: now + 4 },
  ];
  assert.deepEqual(records.map((record) => retryFlags(records).get(record)), [true, false, false, false, null]);
});

test('summary uses finished attempts for failure and identifiable attempts for retry', () => {
  const result = summarize([{ status: 'failed', retry: false }, { status: 'dead', retry: true }, { status: 'succeeded', retry: true }, { status: 'running', retry: null }]);
  assert.equal(result.failureRate, 2 / 3);
  assert.equal(result.retryRate, 2 / 3);
  assert.equal(result.retryUnknown, 1);
  assert.equal(summarize([]).failureRate, 0);
});

test('Host allows exact loopback names and ports only', () => {
  for (const host of ['localhost', 'LOCALHOST:4317', '127.0.0.1:4317']) assert.equal(validHost(host), true, host);
  for (const host of [undefined, '', 'evil.test', 'localhost.evil.test', '127.0.0.1.evil', 'localhost@evil', '[::1]', 'localhost:0', 'localhost:65536', 'localhost:abc', 'localhost,evil', 'localhost\n']) assert.equal(validHost(host), false, host);
});

test('credentials, emails, long secrets and controls are redacted', () => {
  const result = redact('user@example.com password=hunter2 token=abc Bearer xyz sk-abcdef1234 ghp_abc123 \x1b[31mred\x00 ' + 'A'.repeat(40));
  for (const secret of ['user@example.com', 'hunter2', 'abc123', 'xyz', 'abcdef1234', 'A'.repeat(40), '\x00', '\x1b']) assert.equal(result.includes(secret), false);
});

test('port parsing rejects unknown arguments and invalid ranges', () => {
  assert.equal(parsePort([]), 4317);
  assert.equal(parsePort(['--port', '4321']), 4321);
  for (const args of [['--port', '0'], ['--port', '65536'], ['--host', '0.0.0.0'], ['--port', '1.5']]) assert.throws(() => parsePort(args));
});

test('absent inputs return an empty working state', async (t) => {
  const base = await fixture(t);
  const state = await collectState({ base, now });
  assert.equal(state.workers.length, 0);
  assert.equal(state.sources.eventsMissing, true);
  assert.equal(state.sources.handoffsMissing, true);
});

test('all three observed installed dry-runs remain unknown without changing source files', async (t) => {
  const base = await fixture(t);
  // AIMON-28: only status, mode, times and step names from the three local records are retained.
  const observations = [
    { startedAt: '2026-11-24T09:28:14.543Z', finishedAt: '2026-11-24T09:28:14.953Z',
      names: ['preflight', 'worktree', 'spec', 'dry-run'] },
    { startedAt: '2026-11-25T02:39:48.485Z', finishedAt: '2026-11-25T02:39:51.873Z',
      names: ['preflight', 'worktree', 'spec', 'dry-run'] },
    { startedAt: '2026-11-25T03:57:59.074Z', finishedAt: '2026-11-25T03:57:59.658Z',
      names: ['gates', 'preflight', 'worktree', 'spec', 'dry-run'] },
  ];
  const originals = new Map();
  for (const [index, observation] of observations.entries()) {
    const id = `dry-run-${index}`;
    const dir = join(base, 'local-workers', id);
    await mkdir(dir);
    const record = { id, mode: 'installed', status: 'dry-run',
      startedAt: observation.startedAt, finishedAt: observation.finishedAt,
      steps: observation.names.map((name) => ({ name, at: observation.finishedAt })) };
    const path = join(dir, 'record.json');
    const original = JSON.stringify(record);
    originals.set(path, original);
    await writeFile(path, original);
  }

  const state = await collectState({ base, now, processes: async () => [] });
  assert.equal(state.workers.length, 3);
  for (const worker of state.workers) {
    assert.equal(worker.status, 'unknown');
    assert.equal(worker.failure, null);
    assert.equal(worker.readOnly, false);
    assert.equal(worker.awaiting, null);
  }
  for (const summary of [state.summary.all, state.summary.day]) {
    assert.equal(summary.attempts, 3);
    assert.equal(summary.counts.unknown, 3);
    assert.equal(summary.finished, 0);
    for (const status of ['running', 'succeeded', 'no-changes', 'failed', 'killed', 'dead', 'canceled']) {
      assert.equal(summary.counts[status], 0);
    }
  }
  for (const [path, original] of originals) {
    assert.equal(await readFile(path, 'utf8'), original);
  }
});

test('collection tolerates partial records, computes durations, and never returns messages', async (t) => {
  const base = await fixture(t);
  const dir = join(base, 'local-workers', 'w1');
  await mkdir(dir);
  const record = { id: 'w1', repo: 'repo user@example.com', issue: 7, branch: 'feature', agent: 'codex',
    status: 'succeeded', startedAt: now - 120000, finishedAt: now, error: 'PRIVATE_CHAT',
    steps: [{ name: 'preflight', at: now - 120000 }, { name: 'PRIVATE_CHAT', at: now - 110000 }, { name: 'agent-exit', at: now - 10000 }],
    postCheck: { decision: 'pass', reasons: ['clean_tree', 'PRIVATE_CHAT from a user'] } };
  const original = JSON.stringify(record);
  await writeFile(join(dir, 'record.json'), original);
  await writeFile(join(dir, 'stdout.log'), '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5},"text":"PRIVATE_CHAT"}\n{"type":');
  await mkdir(join(base, 'local-workers', 'broken'));
  await writeFile(join(base, 'local-workers', 'broken', 'record.json'), '{');
  await writeFile(join(base, 'events.jsonl'), JSON.stringify({ ts: now, type: 'worker.done', workerId: 'w1', reason: 'PRIVATE_CHAT', tokens: 15 }) + '\n{');
  await writeFile(join(base, 'handoffs.jsonl'), JSON.stringify({ ts: now, from: 'codex', to: 'claude', waitSec: 12, taskKey: 'issue-7', text: 'PRIVATE_CHAT' }) + '\n');
  await writeFile(join(base, 'alerts.jsonl'), '{"reason":"PRIVATE_CHAT"}\n');
  const state = await collectState({ base, now });
  assert.equal(state.workers.length, 1);
  assert.equal(state.sources.invalidRecords, 1);
  assert.deepEqual(state.workers[0].steps.map((step) => step.durationSec), [10, 100, 10]);
  assert.deepEqual(state.workers[0].tokens, { costUsd: null, newInput: 10, input: 10, cacheWrite: null, cached: null, output: 5, turns: 1 });
  assert.deepEqual(state.byCli.codex, state.workers[0].tokens);
  assert.equal(state.handoffs[0].waitSec, 12);
  assert.equal(state.alerts.count, 1);
  assert.deepEqual(state.workers[0].postCheck.reasons, ['clean_tree']);
  assert.equal(JSON.stringify(state).includes('PRIVATE_CHAT'), false);
  assert.equal(JSON.stringify(state).includes('user@example.com'), false);
  assert.equal(await readFile(join(dir, 'record.json'), 'utf8'), original);
});

test('24h retry recognizes an earlier attempt outside its window', async (t) => {
  const base = await fixture(t);
  for (const [id, startedAt] of [['old', now - 90000000], ['new', now - 10000]]) {
    const dir = join(base, 'local-workers', id);
    await mkdir(dir);
    await writeFile(join(dir, 'record.json'), JSON.stringify({ id, repo: 'r', issue: 1, branch: 'b', status: 'failed', startedAt, finishedAt: startedAt + 1000 }));
  }
  const state = await collectState({ base, now });
  assert.equal(state.summary.day.attempts, 1);
  assert.equal(state.summary.day.retries, 1);
  assert.equal(state.summary.all.retries, 1);
});

test('dead duration ends at last observed update rather than growing forever', async (t) => {
  const base = await fixture(t);
  const dir = join(base, 'local-workers', 'dead');
  await mkdir(dir);
  await writeFile(join(dir, 'record.json'), JSON.stringify({ id: 'dead', status: 'running', startedAt: now - 3600000, heartbeatAt: now - 3000000 }));
  const state = await collectState({ base, now });
  assert.equal(state.workers[0].status, 'dead');
  assert.equal(state.workers[0].elapsedSec, 600);
  assert.equal(state.workers[0].elapsedEstimated, true);
});

test('custom event path overrides default and partial trailing rows are ignored', async (t) => {
  const base = await fixture(t);
  const eventsPath = join(base, 'custom.jsonl');
  await writeFile(eventsPath, '{"type":"started","ts":1}\n{"type":"partial"}');
  const state = await collectState({ base, eventsPath, now });
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, 'started');
});

test('HTTP serves state with CSP and blocks Host, foreign Origin, mutation and traversal', async (t) => {
  const base = await fixture(t);
  const server = createServer({ base, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port, address } = server.address();
  assert.equal(address, '127.0.0.1');
  const home = await request(port);
  assert.equal(home.status, 200);
  assert.match(home.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(home.headers['access-control-allow-origin'], undefined);
  assert.equal((await request(port, '/api/state')).status, 200);
  assert.equal((await request(port, '/api/state', { Host: 'evil.test' })).status, 403);
  assert.equal((await request(port, '/api/state', { Origin: 'http://evil.test' })).status, 403);
  assert.equal((await request(port, '/api/state', {}, 'POST')).status, 405);
  assert.equal((await request(port, '/../server.mjs')).status, 404);
  const module = await request(port, '/lib/dom.js');
  assert.equal(module.status, 200);
  assert.equal(module.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await request(port, '/lib/missing.js')).status, 404);
  assert.equal((await request(port, '/lib.js')).status, 404);
  assert.equal((await request(port, '/constructor')).status, 404);
});

test('SSE sends an immediate snapshot and a second live update', { timeout: 8000 }, async (t) => {
  const base = await fixture(t);
  const server = createServer({ base });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const frames = await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/api/events' }, (res) => {
      let buffer = '';
      const snapshots = [];
      res.on('data', (chunk) => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) snapshots.push(JSON.parse(data.slice(6)));
          if (snapshots.length >= 2) { req.destroy(); resolve(snapshots); return; }
        }
      });
    });
    req.on('error', reject);
    t.after(() => req.destroy());
  });
  assert.ok(frames[1].generatedAt > frames[0].generatedAt);
});

test('harness steps retain the fixed vocabulary and both interval endpoints', async (t) => {
  const base = await fixture(t);
  const dir = join(base, 'local-workers', 'steps');
  await mkdir(dir);
  const names = ['preflight', 'worktree', 'spec', 'agent-exit', 'post-check', 'launcher-commit', 'launcher-tests', 'failed', 'dry-run', 'PRIVATE'];
  await writeFile(join(dir, 'record.json'), JSON.stringify({ status: 'succeeded', startedAt: now - 10000, finishedAt: now,
    steps: names.map((name, index) => ({ name, at: now - 10000 + index * 1000 })) }));
  const state = await collectState({ base, now, processes: async () => [] });
  const steps = state.workers[0].steps;
  assert.deepEqual(steps.map((step) => step.name), [...names.slice(0, -1), 'unrecognized']);
  assert.deepEqual(steps.map((step) => step.to), [...names.slice(1, -1), 'unrecognized', 'finish']);
  assert.ok(steps.every((step) => step.durationSec === 1));
  assert.ok(state.bottlenecks.every((step) => step.to));
});

test('Grok lifecycle joins are idempotent, timestamp-based, private and included with local workers', async (t) => {
  const base = await fixture(t);
  const grokPath = join(base, 'override.jsonl');
  const start = (id, age) => ({ v: 1, id, event: 'start', at: new Date(now - age).toISOString(), bot: 'Engineering Owner user@example.com', task: 'Fix token=secretvalue', issue: 'ISSUE-7' });
  const finish = (id, status, age = 0) => ({ v: 1, id, event: 'finish', at: new Date(now - age).toISOString(), status });
  const rows = [finish('success', 'succeeded'), start('success', 10000), start('success', 5000), finish('success', 'failed'),
    start('running', 10000), start('boundary', 21600000), start('dead', 21600001),
    start('failed', 10000), finish('failed', 'failed', 5000), start('canceled', 10000), finish('canceled', 'canceled'),
    finish('orphan', 'failed'), { ...start('invalid', 10000), message: 'PRIVATE_CHAT' },
    start('early-finish', 10000), finish('early-finish', 'failed', 20000)];
  await writeFile(grokPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\nBAD\n{"v":1');
  const dir = join(base, 'local-workers', 'local');
  await mkdir(dir);
  await writeFile(join(dir, 'record.json'), JSON.stringify({ id: 'local', agent: 'codex', status: 'succeeded', startedAt: now - 1000, finishedAt: now }));
  const before = await readFile(grokPath, 'utf8');
  const state = await collectState({ base, grokPath, now });
  assert.equal(state.workers.length, 8);
  const byId = Object.fromEntries(state.workers.map((worker) => [worker.id, worker]));
  assert.equal(byId['grok:success'].elapsedSec, 10);
  assert.equal(byId['grok:success'].status, 'succeeded');
  assert.equal(byId['grok:failed'].elapsedSec, 5);
  assert.equal(byId['grok:canceled'].status, 'canceled');
  assert.equal(byId['grok:boundary'].status, 'running');
  assert.equal(byId['grok:dead'].status, 'dead');
  assert.equal(byId['grok:dead'].elapsedSec, 21600);
  assert.equal(byId['grok:dead'].elapsedEstimated, true);
  assert.equal(byId['grok:early-finish'].status, 'running');
  assert.equal(byId['grok:running'].cli, 'grok');
  assert.equal(byId['grok:running'].agent, 'grok');
  assert.equal(byId['grok:running'].tokens, null);
  assert.equal(state.byCli.grok, null);
  assert.equal(state.summary.all.attempts, 8);
  assert.equal(state.summary.day.counts.running, 3);
  assert.equal(state.summary.all.counts.canceled, 1);
  assert.equal(state.summary.all.finished, 5);
  assert.equal(state.summary.all.failed, 2);
  for (const text of ['PRIVATE_CHAT', 'user@example.com', 'secretvalue']) assert.equal(JSON.stringify(state).includes(text), false);
  assert.equal(await readFile(grokPath, 'utf8'), before);
});

test('default Grok source accepts complete rows and missing files remain optional', async (t) => {
  const base = await fixture(t);
  assert.equal((await collectState({ base, now })).sources.grokMissing, true);
  const row = { v: 1, id: 'r', event: 'start', at: new Date(now).toISOString(), bot: 'Owner', task: 'Task' };
  await writeFile(join(base, 'grok-runs.jsonl'), JSON.stringify(row) + '\n' + JSON.stringify({ ...row, id: 'partial' }));
  const state = await collectState({ base, now });
  assert.equal(state.sources.grokMissing, false);
  assert.equal(state.workers.length, 1);
});

test('path defaults preserve legacy symlinks and honor XDG, environment and explicit precedence', async (t) => {
  const home = await fixture(t);
  const context = { home, env: {} };
  const current = join(home, '.local/state/agent-orchestration');
  const legacy = join(home, '.local/state/agent-outer-loop');
  const jobsRoot = join(home, 'agent-orchestration-jobs');
  assert.deepEqual(resolvePaths({}, context), { base: current, jobsRoot });
  await mkdir(join(home, '.local/state'), { recursive: true });
  await symlink(current, legacy);
  assert.equal(resolvePaths({}, context).base, legacy);
  await mkdir(current);
  assert.equal(resolvePaths({}, context).base, legacy);
  context.env = { XDG_STATE_HOME: join(home, 'xdg') };
  assert.equal(resolvePaths({}, context).base, join(home, 'xdg/agent-orchestration'));
  context.env.AI_TEAM_MONITORING_STATE_DIR = join(home, 'state-env');
  context.env.AI_TEAM_MONITORING_JOBS_ROOT = join(home, 'jobs-env');
  assert.deepEqual(parseArgs([], context), { port: 4317, base: join(home, 'state-env'), jobsRoot: join(home, 'jobs-env') });
  assert.deepEqual(parseArgs(['--state-dir', current, '--port', '4321', '--jobs-root', jobsRoot], context), { port: 4321, base: current, jobsRoot });
  assert.deepEqual(resolvePaths({ base: current, jobsRoot }, context), { base: current, jobsRoot });
  for (const args of [['--host', '0.0.0.0'], ['toString', 'x'], ['--state-dir'], ['--jobs-root', ''], ['--port', '0'], ['--state-dir', 'a', '--state-dir', 'b']]) {
    assert.throws(() => parseArgs(args, context));
  }
});

test('common JSONL adapter ignores invalid rows, clips summaries and merges file clocks per issue', async (t) => {
  const base = await fixture(t);
  const extra = join(base, 'extra.jsonl');
  const row = { ts: new Date(now - 1000).toISOString(), bot: 'Engineering Owner', issue: 'ISSUE-1', summary: 'short summary', phase: 'start' };
  const invalid = { ...row, issue: 'ISSUE-9' };
  await writeFile(join(base, 'bot-heartbeats.jsonl'), JSON.stringify({ ...row, issue: 'ISSUE-2', ts: new Date(now).toISOString() }) + '\n');
  await writeFile(extra, [
    JSON.stringify({ ...row, summary: '요약'.repeat(125), ignored: 'PRIVATE_UNKNOWN_FIELD' }),
    'BAD', 'null', '[]',
    JSON.stringify({ ...invalid, bot: '' }),
    JSON.stringify({ ...invalid, bot: undefined }),
    JSON.stringify({ ...invalid, ts: '2026-13-26T09:29:28Z' }),
    JSON.stringify({ ...invalid, ts: 'not-a-time' }),
    JSON.stringify({ ...invalid, ts: '2026-11-26' }),
    JSON.stringify({ ...invalid, ts: now }),
    JSON.stringify({ ...invalid, phase: 'invalid' }),
    JSON.stringify({ ...invalid, ts: undefined }),
    JSON.stringify({ ...row, issue: 'ISSUE-2', phase: 'end', ts: new Date(now + 1000).toISOString() }),
    JSON.stringify(invalid),
  ].join('\n'));
  const state = await collectState({ base, jobsRoot: base, eventsJsonlPath: extra, now, processes: () => [] });
  const activity = state.botActivity.find((item) => item.name === row.bot);
  assert.equal(activity.lastActivityAt, now + 1000);
  assert.equal(activity.startedAt, now - 1000);
  assert.deepEqual(activity.tasks, [{ issue: 'ISSUE-1', taskSummary: '요약'.repeat(100) }]);
  assert.equal(JSON.stringify(state).includes('PRIVATE_UNKNOWN_FIELD'), false);
  const fallback = await collectState({ base, jobsRoot: base, eventsJsonlPath: join(base, 'missing.jsonl'), now, processes: () => [] });
  const only = fallback.botActivity.find((item) => item.name === row.bot);
  assert.deepEqual(only.tasks, [{ issue: 'ISSUE-2', taskSummary: 'short summary' }]);
  assert.equal(only.startedAt, now);
});

test('common activity keeps open starts current regardless of newer harness activity and leaves other state unchanged', async (t) => {
  const base = await fixture(t);
  const dir = join(base, 'local-workers', 'worker');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'record.json'), JSON.stringify({ id: 'worker', issue: 'ISSUE-1', owner: 'Engineering Owner', status: 'succeeded', startedAt: now - 4000000, finishedAt: now - 3600000 }));
  const options = { base, jobsRoot: base, now, processes: () => [] };
  const baseline = await collectState(options);
  for (const [at, phase, active] of [
    [now - 3600001, 'start', true],
    [now - 3600000, 'start', true],
    [now - 1800001, 'end', false],
    [now - 1800000, 'end', false],
    [now - 1000, undefined, true],
  ]) {
    await writeFile(join(base, 'bot-heartbeats.jsonl'), JSON.stringify({ ts: new Date(at).toISOString(), bot: 'Engineering Owner', issue: 'ISSUE-2', summary: 42, phase }) + '\n');
    const state = await collectState(options);
    const activity = state.botActivity.find((item) => item.name === 'Engineering Owner');
    assert.equal(activity.lastActivityAt, Math.max(now - 3600000, at));
    assert.deepEqual(activity.tasks, active ? [{ issue: 'ISSUE-2', taskSummary: '' }] : []);
    assert.equal(activity.startedAt, active ? at : null);
    for (const key of Object.keys(baseline).filter((key) => key !== 'botActivity')) assert.deepEqual(state[key], baseline[key], key);
  }
});

// 한 담당의 열린 이슈 A와 닫힌 이슈 B: A만 현재 작업이고, 다른 레코드의 더 새로운 활동 시각에도 A가 남는다.
test('heartbeat start stays current per issue until a newer end for the same issue', async (t) => {
  const base = await fixture(t);
  const dir = join(base, 'local-workers', 'newer');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'record.json'), JSON.stringify({ id: 'newer', issue: 'ISSUE-3', owner: 'Engineering Owner', status: 'succeeded', startedAt: now - 20000, finishedAt: now - 1000 }));
  const line = (offset, issue, phase, summary) => JSON.stringify({ ts: new Date(now - offset).toISOString(), bot: 'Engineering-Owner', issue, summary, phase });
  await writeFile(join(base, 'bot-heartbeats.jsonl'), [
    line(70000, 'ISSUE-1', 'end', 'previous run'),
    line(60000, 'ISSUE-1', 'start', '열린 작업 A'),
    line(50000, 'ISSUE-2', 'start', '닫힌 작업 B'),
    line(40000, 'ISSUE-2', 'end', '닫힌 작업 B'),
  ].join('\n') + '\n');
  const state = await collectState({ base, jobsRoot: base, eventsJsonlPath: join(base, 'missing.jsonl'), now, processes: () => [] });
  const activity = state.botActivity.find((item) => item.name === 'Engineering Owner');
  assert.deepEqual(activity.tasks, [{ issue: 'ISSUE-1', taskSummary: '열린 작업 A' }]);
  assert.equal(activity.startedAt, now - 60000);
  assert.equal(activity.lastActivityAt, now - 1000);
});

// 워커 레코드: starting/queued/running은 이름 변형(공백·하이픈·대소문자)과 설정 표시 이름으로도 해당 행의 현재 작업이다.
test('starting, queued and running worker records count as current work under owner name variants', async (t) => {
  const base = await fixture(t);
  await writeFile(join(base, 'ai-team-monitoring.json'), JSON.stringify({ ownerByIssuePrefix: [{ prefix: 'CFG', owner: 'release-owner' }] }));
  const records = [
    { id: 'w-starting', issue: 'ISSUE-1', owner: 'EngineeringOwner', status: 'starting' },
    { id: 'w-queued', issue: 'ISSUE-2', owner: 'Engineering-Owner', status: 'queued' },
    { id: 'w-running', issue: 'ISSUE-3', owner: 'engineering owner', status: 'running' },
    { id: 'w-tooling', issue: 'ISSUE-4', owner: 'Tooling-Owner', status: 'running' },
    { id: 'w-config', issue: 'CFG-5', status: 'queued' },
    { id: 'w-succeeded', issue: 'ISSUE-6', owner: 'Tooling Owner', status: 'succeeded', finishedAt: now - 1000 },
    { id: 'w-failed', issue: 'ISSUE-7', owner: 'ENGINEERING OWNER', status: 'failed', finishedAt: now - 1000 },
  ];
  for (const [index, record] of records.entries()) {
    const dir = join(base, 'local-workers', record.id);
    await mkdir(dir);
    await writeFile(join(dir, 'record.json'), JSON.stringify({ startedAt: now - 60000 + index * 1000, ...record }));
  }
  const state = await collectState({ base, jobsRoot: base, eventsJsonlPath: join(base, 'missing.jsonl'), now, processes: () => [] });
  const row = (name) => state.botActivity.find((item) => item.name === name);
  assert.deepEqual(row('Engineering Owner').tasks.map((task) => task.issue).sort(), ['ISSUE-1', 'ISSUE-2', 'ISSUE-3']);
  assert.equal(row('Engineering Owner').startedAt, now - 60000);
  assert.equal(row('Engineering Owner').lastActivityAt, now - 1000);
  assert.deepEqual(row('Tooling Owner').tasks.map((task) => task.issue), ['ISSUE-4']);
  assert.equal(row('Tooling Owner').startedAt, now - 57000);
  assert.deepEqual(row('Release Owner').tasks.map((task) => task.issue), ['CFG-5']);
});

test('taskSummary asks git every time when an executor is injected, even for finished workers', async () => {
  const { taskSummary } = await import('../adapters/harness.mjs');
  let calls = 0;
  const exec = async () => { calls += 1; return 'X-1 fix things\n'; };
  const record = { issue: 'X-1', worktree: '/wt', worktreeBase: 'base', status: 'succeeded' };
  assert.equal(await taskSummary(record, { exec, cacheable: true }), 'X-1 fix things');
  assert.equal(await taskSummary(record, { exec, cacheable: true }), 'X-1 fix things');
  assert.equal(calls, 2);
});

test('publicVersion changes with any page file, including nested ones', async (t) => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'lib'));
  await writeFile(join(dir, 'app.js'), 'one');
  const first = await publicVersion(dir);
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(await publicVersion(dir), first);
  await writeFile(join(dir, 'lib', 'dom.js'), 'two');
  assert.notEqual(await publicVersion(dir), first);
});

test('a watched page directory updates the version sent to open pages', { timeout: 10000 }, async (t) => {
  const base = await fixture(t);
  const publicDir = join(base, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'app.js'), 'before');
  const server = createServer({ base, publicDir, watchPublic: true, processes: async () => [] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const version = async () => JSON.parse((await request(server.address().port, '/api/state')).body).assetVersion;
  const before = await version();
  assert.equal(before, await publicVersion(publicDir));
  await writeFile(join(publicDir, 'app.js'), 'after');
  const expected = await publicVersion(publicDir);
  const deadline = Date.now() + 8000;
  while (await version() !== expected) {
    assert.ok(Date.now() < deadline, 'version did not follow the saved file');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});
