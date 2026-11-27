/** Awaiting-next-stage, read-only success and open asks: collection and rendering without a browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { collectState, readOnlySucceeded } from '../server.mjs';
import { pageSource } from './helpers/page-source.mjs';

const source = await pageSource();

const now = Date.parse('2026-11-25T04:00:00Z');
const minute = 60000;
const noProcesses = async () => [];
const iso = (ms) => new Date(ms).toISOString();

/** Make an isolated harness state directory. */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'agent-awaiting-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'local-workers'));
  return base;
}

/** Write one worker record. */
async function worker(base, record) {
  const dir = join(base, 'local-workers', record.id);
  await mkdir(dir);
  await writeFile(join(dir, 'record.json'), JSON.stringify(record));
}

/** Write JSONL rows (with a malformed line) to a path under base. */
async function jsonl(base, path, rows) {
  await mkdir(join(base, path, '..'), { recursive: true });
  await writeFile(join(base, path), [...rows.map((row) => JSON.stringify(row)), 'BAD{'].join('\n') + '\n');
}

/** Build an ended worker record finished `ageMin` minutes ago. */
function ended(id, { issue = id, ageMin = 12, status = 'failed', ...rest } = {}) {
  return { id, repo: 'ai-team-monitoring', issue, branch: id, agent: 'claude', status,
    startedAt: iso(now - (ageMin + 5) * minute), finishedAt: iso(now - ageMin * minute), ...rest };
}

/** Build an inbox row matching the shared contract. */
function inboxRow(record, owner = 'grok-bot') {
  return { schema: 'agent-orchestration.inbox/v1', workerId: record.id, repo: record.repo, issue: record.issue, owner,
    status: record.status, reason: 'x', finishedAt: record.finishedAt, branch: record.branch, mode: 'write' };
}

const byId = (state) => Object.fromEntries(state.workers.map((item) => [item.id, item]));

test('dry-run and unrecognized statuses remain unknown, never awaiting, legacy or open items', async (t) => {
  for (const status of ['dry-run', 'unrecognized-status']) {
    for (const hasInbox of [true, false]) {
      for (const ageMin of [10, 12]) {
        await t.test(`${status}, inbox=${hasInbox}, age=${ageMin} minutes`, async (t) => {
          const base = await fixture(t);
          const record = ended('unknown-worker', { status, ageMin });
          await worker(base, record);
          if (hasInbox) await jsonl(base, 'inbox/grok-bot.jsonl', [inboxRow(record)]);

          const state = await collectState({ base, now, processes: noProcesses });
          const item = byId(state)[record.id];
          assert.equal(item.status, 'unknown');
          assert.equal(item.awaiting, null);
          assert.equal(item.legacy, false);
          assert.equal(item.resolved, false);
          assert.equal(item.failure, null);
          for (const summary of [state.summary.all, state.summary.day]) {
            assert.equal(summary.counts.unknown, 1);
            assert.equal(summary.awaiting, 0);
            assert.equal(summary.finished, 0);
            assert.equal(summary.failed, 0);
          }
          assert.equal(state.inbox.pending.length, hasInbox ? 1 : 0);
          if (hasInbox) {
            assert.equal(state.inbox.pending[0].status, 'unknown');
            assert.equal(state.inbox.pending[0].awaiting, false);
          }

          const app = loadApp();
          runInNewContext(`state = ${JSON.stringify(state)};`, app.context);
          assert.equal(runInNewContext('workerAlert(state.workers[0])', app.context), null);
          assert.equal(runInNewContext('currentAlerts(state).length', app.context), 0);
          assert.equal(runInNewContext('alertSummary(state)', app.context), '');
          assert.equal(runInNewContext('faviconColor(state)', app.context), 'green');
        });
      }
    }
  }
});

test('inbox+acks: ended, unacked, unfollowed, >=10 minutes is counted with owner and age; others are not', async (t) => {
  const base = await fixture(t);
  const records = {
    awaiting: ended('awaiting', { ageMin: 12 }),
    succeeded: ended('succeeded', { ageMin: 10, status: 'succeeded' }),
    acked: ended('acked'),
    autoAcked: ended('auto-acked'),
    superseded: ended('superseded', { issue: 'AIMON-9', ageMin: 30 }),
    follower: ended('follower', { issue: 'AIMON-9', ageMin: 3, status: 'succeeded' }),
    fresh: ended('fresh', { ageMin: 9 }),
    running: { id: 'running', repo: 'ai-team-monitoring', issue: 'run', branch: 'run', status: 'running', startedAt: iso(now - 20 * minute), heartbeatAt: iso(now - 1000) },
  };
  for (const record of Object.values(records)) await worker(base, record);
  await jsonl(base, 'inbox/grok-bot.jsonl', Object.values(records).filter((record) => record.finishedAt).map((record) => inboxRow(record)));
  await jsonl(base, 'inbox/acks.jsonl', [
    { workerId: 'acked', ackedAt: iso(now), by: 'grok-bot', note: 'n' },
    { workerId: 'auto-acked', ackedAt: iso(now), by: 'launcher', note: 'n', nextWorkerId: 'next' },
  ]);
  const state = await collectState({ base, now, processes: noProcesses });
  const workers = byId(state);
  assert.deepEqual(workers.awaiting.awaiting, { owner: 'grok-bot', finishedAt: now - 12 * minute, ageSec: 720, blocker: null, detail: '이유 없음' });
  assert.equal(workers.succeeded.awaiting.ageSec, 600);
  for (const id of ['acked', 'auto-acked', 'superseded', 'fresh', 'running', 'follower']) assert.equal(workers[id].awaiting, null, id);
  assert.equal(state.summary.all.awaiting, 2);
  assert.equal(state.summary.day.awaiting, 2);
  assert.equal(state.sources.inboxMissing, false);
});

test('missing inbox and acks: finished workers without an inbox line are never awaiting; failures remain current', async (t) => {
  const base = await fixture(t);
  await worker(base, ended('lonely', { ageMin: 10 }));
  await worker(base, ended('old', { issue: 'AIMON-7', ageMin: 40 }));
  await worker(base, ended('new', { issue: 'AIMON-7', ageMin: 2 }));
  const state = await collectState({ base, now, processes: noProcesses });
  const workers = byId(state);
  for (const id of ['lonely', 'old', 'new']) {
    assert.equal(workers[id].awaiting, null, id);
    assert.equal(workers[id].legacy, false, id);
  }
  assert.equal(state.summary.all.awaiting, 0);
  assert.equal(state.sources.inboxMissing, true);
  assert.equal(state.sources.acksMissing, true);
});

test('legacy cutoff: a successful worker with no inbox line is historical, failures remain current; one with a line still awaits', async (t) => {
  const base = await fixture(t);
  const records = {
    legacy: ended('legacy-done', { issue: 'AIMON-70', ageMin: 600, status: 'succeeded' }),
    legacyFailed: ended('legacy-failed', { issue: 'AIMON-71', ageMin: 600 }),
    current: ended('current', { issue: 'AIMON-72', ageMin: 10, status: 'succeeded' }),
    dead: { id: 'dead-no-line', repo: 'ai-team-monitoring', issue: 'AIMON-73', branch: 'd', agent: 'claude', status: 'running',
      startedAt: iso(now - 60 * minute), heartbeatAt: iso(now - 59 * minute) },
  };
  for (const record of Object.values(records)) await worker(base, record);
  await jsonl(base, 'inbox/grok-bot.jsonl', [inboxRow(records.current)]);
  const state = await collectState({ base, now, processes: noProcesses });
  const workers = byId(state);
  for (const [id, expectedLegacy] of [['legacy-done', true], ['legacy-failed', false]]) {
    assert.equal(workers[id].legacy, expectedLegacy, id);
    assert.equal(workers[id].awaiting, null, id);
  }
  assert.equal(workers.current.legacy, false);
  assert.deepEqual(workers.current.awaiting, { owner: 'grok-bot', finishedAt: now - 10 * minute, ageSec: 600, blocker: null, detail: '이유 없음' });
  assert.equal(workers['dead-no-line'].status, 'dead');
  assert.equal(workers['dead-no-line'].legacy, false);
  assert.equal(state.summary.all.awaiting, 1);
});

test('resolved marks acked or superseded workers so retried failures and dead workers are not current problems', async (t) => {
  const base = await fixture(t);
  const lost = (id, issue, ageMin) => ({ id, repo: 'ai-team-monitoring', issue, branch: id, agent: 'claude', status: 'running',
    startedAt: iso(now - ageMin * minute), heartbeatAt: iso(now - (ageMin - 1) * minute) });
  await worker(base, lost('dead-retried', 'AIMON-40', 60));
  await worker(base, lost('retry', 'AIMON-40', 30));
  await worker(base, lost('dead-acked', 'AIMON-41', 60));
  await worker(base, lost('dead-current', 'AIMON-42', 60));
  await worker(base, ended('failed-retried', { issue: 'AIMON-43', ageMin: 40 }));
  await worker(base, ended('succeeded-next', { issue: 'AIMON-43', ageMin: 20, status: 'succeeded' }));
  await worker(base, ended('succeeded-acked', { issue: 'AIMON-44', ageMin: 20, status: 'succeeded' }));
  await jsonl(base, 'inbox/grok-bot.jsonl', [inboxRow(ended('succeeded-next', { issue: 'AIMON-43', ageMin: 20, status: 'succeeded' }))]);
  await jsonl(base, 'inbox/acks.jsonl', [
    { workerId: 'dead-acked', ackedAt: iso(now), by: 'bot' },
    { workerId: 'succeeded-acked', ackedAt: iso(now), by: 'bot' },
  ]);
  const workers = byId(await collectState({ base, now, processes: noProcesses }));
  assert.equal(workers['dead-current'].status, 'dead');
  assert.equal(workers['dead-current'].heartbeatStale, true);
  for (const id of ['dead-retried', 'dead-acked', 'failed-retried', 'succeeded-acked']) assert.equal(workers[id].resolved, true, id);
  for (const id of ['dead-current', 'retry', 'succeeded-next']) assert.equal(workers[id].resolved, false, id);
  for (const id of ['failed-retried', 'succeeded-acked']) assert.equal(workers[id].awaiting, null, id);
  assert.equal(workers['succeeded-next'].awaiting.ageSec, 1200);
});

test('a failure nobody retried, superseded or acked stays unresolved; a retried or acked one is resolved', async (t) => {
  const base = await fixture(t);
  await worker(base, ended('failed-open', { issue: 'AIMON-50', ageMin: 2 }));
  await worker(base, ended('killed-open', { issue: 'AIMON-51', ageMin: 2, status: 'killed' }));
  await worker(base, ended('failed-acked', { issue: 'AIMON-52', ageMin: 2 }));
  await worker(base, ended('killed-superseded', { issue: 'AIMON-53', ageMin: 30, status: 'killed' }));
  await worker(base, { ...ended('next-running', { issue: 'AIMON-53', ageMin: 0 }), status: 'running', finishedAt: undefined, startedAt: iso(now - minute) });
  await jsonl(base, 'inbox/acks.jsonl', [{ workerId: 'failed-acked', ackedAt: iso(now), by: 'bot' }]);
  const workers = byId(await collectState({ base, now, processes: noProcesses }));
  for (const id of ['failed-open', 'killed-open']) assert.equal(workers[id].resolved, false, id);
  for (const id of ['failed-acked', 'killed-superseded']) assert.equal(workers[id].resolved, true, id);
  assert.equal(workers['killed-open'].status, 'killed');
});

test('a Grok run is resolved when acked or followed by a newer Grok run for the same issue', async (t) => {
  const base = await fixture(t);
  const grokPath = join(base, 'grok.jsonl');
  const start = (id, ageMin, issue) => ({ v: 1, id, event: 'start', at: iso(now - ageMin * minute), bot: 'Owner', task: 'Task', issue });
  const finish = (id, ageMin, status = 'failed') => ({ v: 1, id, event: 'finish', at: iso(now - ageMin * minute), status });
  await writeFile(grokPath, [
    start('old', 30, 'AIMON-60'), finish('old', 25), start('new', 10, 'AIMON-60'), finish('new', 5),
    start('acked', 30, 'AIMON-61'), finish('acked', 25), start('alone', 30), finish('alone', 25),
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
  await jsonl(base, 'inbox/acks.jsonl', [{ workerId: 'grok:acked', ackedAt: iso(now), by: 'bot' }]);
  const workers = byId(await collectState({ base, grokPath, now, processes: noProcesses }));
  for (const id of ['grok:old', 'grok:acked']) assert.equal(workers[id].resolved, true, id);
  for (const id of ['grok:new', 'grok:alone']) assert.equal(workers[id].resolved, false, id);
});

test('acks without an inbox leave no awaiting flag; inbox without acks still flags', async (t) => {
  const base = await fixture(t);
  await worker(base, ended('a', { ageMin: 20 }));
  await worker(base, ended('b', { ageMin: 20 }));
  await jsonl(base, 'inbox/acks.jsonl', [{ workerId: 'a', ackedAt: iso(now), by: 'bot', note: 'n' }]);
  let workers = byId(await collectState({ base, now, processes: noProcesses }));
  assert.equal(workers.a.awaiting, null);
  assert.equal(workers.b.awaiting, null);
  assert.equal(workers.b.legacy, false);
  await rm(join(base, 'inbox', 'acks.jsonl'));
  await jsonl(base, 'inbox/eo-bot.jsonl', [{ ...inboxRow(ended('a', { ageMin: 20 })), owner: undefined }]);
  workers = byId(await collectState({ base, now, processes: noProcesses }));
  assert.equal(workers.a.awaiting.owner, 'eo-bot');
});

test('completed-no-changes counts as finished success and participates in awaiting and inbox handling', async (t) => {
  const base = await fixture(t);
  const records = [
    ended('no-mode', { status: 'completed-no-changes' }),
    ended('read-only', { status: 'completed-no-changes', mode: 'read-only' }),
    ended('acked', { status: 'completed-no-changes' }),
  ];
  for (const record of records) await worker(base, record);
  await jsonl(base, 'inbox/grok-bot.jsonl', [
    ...records.map((record) => ({ ...inboxRow(record), mode: record.mode })),
    inboxRow(ended('inbox-only', { status: 'completed-no-changes' })),
  ]);
  await jsonl(base, 'inbox/acks.jsonl', [{ workerId: 'acked', ackedAt: iso(now), by: 'eo-bot' }]);
  const state = await collectState({ base, now, processes: noProcesses });
  const workers = byId(state);
  for (const record of records) {
    assert.equal(workers[record.id].status, 'no-changes');
    assert.equal(workers[record.id].failure, null);
  }
  for (const summary of [state.summary.all, state.summary.day]) {
    assert.equal(summary.counts['no-changes'], 3);
    assert.equal(summary.counts.unknown ?? 0, 0);
    assert.equal(summary.finished, 3);
    assert.equal(summary.failed, 0);
    assert.equal(summary.failureRate, 0);
    assert.equal(summary.awaiting, 1);
  }
  assert.equal(workers['no-mode'].awaiting.ageSec, 720);
  assert.equal(workers['read-only'].awaiting, null);
  assert.equal(workers.acked.awaiting, null);
  assert.equal(state.inbox.pending.length, 2);
  for (const item of state.inbox.pending) {
    assert.equal(item.status, 'no-changes');
    assert.equal(item.awaiting, true);
  }
  assert.equal(state.inbox.acked[0].status, 'no-changes');
});

test('read-only no-commits results are success; a real read-only failure stays failed', async (t) => {
  for (const [record, expected] of [
    [{ mode: 'read-only', status: 'completed-no-changes' }, true],
    [{ mode: 'read-only', status: 'no-changes' }, true],
    [{ mode: 'read-only', status: 'failed', reason: 'no-commits' }, true],
    [{ mode: 'read-only', status: 'failed', reason: 'post-check: no-commits' }, true],
    [{ mode: 'read-only', status: 'failed', reason: 'timeout' }, false],
    [{ status: 'failed', reason: 'no-commits' }, false],
  ]) assert.equal(readOnlySucceeded(record), expected, JSON.stringify(record));
  const base = await fixture(t);
  await worker(base, ended('ro-ok', { mode: 'read-only', reason: 'post-check: no-commits', ageMin: 1 }));
  await worker(base, ended('ro-done', { mode: 'read-only', status: 'completed-no-changes', ageMin: 1 }));
  await worker(base, ended('ro-bad', { mode: 'read-only', reason: 'timeout', ageMin: 1 }));
  await worker(base, ended('rw', { reason: 'no-commits', ageMin: 1 }));
  const state = await collectState({ base, now, processes: noProcesses });
  const workers = byId(state);
  assert.equal(workers['ro-ok'].status, 'succeeded');
  assert.equal(workers['ro-ok'].failure, null);
  assert.equal(workers['ro-ok'].readOnly, true);
  assert.equal(workers['ro-done'].status, 'no-changes');
  assert.equal(workers['ro-bad'].status, 'failed');
  assert.equal(workers['ro-bad'].readOnly, true);
  assert.equal(workers.rw.status, 'failed');
  assert.equal(workers.rw.readOnly, false);
  assert.equal(state.summary.all.counts.succeeded, 1);
  assert.equal(state.summary.all.counts['no-changes'], 1);
  assert.equal(state.summary.all.failed, 2);
});

test('asks: missing file is empty; only open asks are listed; red unless a listed worker is running', async (t) => {
  const base = await fixture(t);
  let state = await collectState({ base, now, processes: noProcesses });
  assert.deepEqual(state.asks, []);
  assert.equal(state.sources.asksMissing, true);
  await worker(base, { id: 'live', repo: 'r', issue: 'i', status: 'running', startedAt: iso(now - minute), heartbeatAt: iso(now - 1000) });
  await worker(base, ended('gone'));
  const ask = (id, extra) => ({ schema: 'agent-orchestration.asks/v1', id, title: `Ask ${id}`, owner: 'eo-bot', status: 'open', createdAt: iso(now - 15 * minute), workerIds: [], ...extra });
  await jsonl(base, 'asks.jsonl', [
    ask('staffed', { workerIds: ['gone', 'live'] }), ask('ended-only', { workerIds: ['gone'] }), ask('empty'),
    ask('closed', { status: 'done' }), { ...ask('other'), schema: 'other/v1' },
  ]);
  state = await collectState({ base, now, processes: noProcesses });
  assert.deepEqual(state.asks.map((item) => [item.id, item.unstaffed]), [['staffed', false], ['ended-only', true], ['empty', true]]);
  assert.deepEqual(Object.keys(state.asks[0]).sort(), ['ageSec', 'createdAt', 'id', 'owner', 'title', 'unstaffed']);
  assert.equal(state.asks[0].ageSec, 900);
});

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

/** Run app.js against a tiny DOM double and return its context and nodes. */
function loadApp() {
  const nodes = new Map();
  const node = () => ({ textContent: '', className: '', children: [], attributes: {}, handlers: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, callback) { this.handlers[name] = callback; },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    showModal() { this.open = true; }, close() { this.open = false; } });
  const document = { createElement: node, createElementNS: node, documentElement: { dataset: {} }, addEventListener() {},
    querySelector: (selector) => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); } };
  const context = { document, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {} }, EventSource: class {} };
  runInNewContext(source, context);
  return { context, nodes };
}

/** Collect all nodes in a rendered tree. */
function flatten(node) {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

/** Read every rendered text node. */
function text(node) {
  return flatten(node).map((item) => item.textContent).join(' ');
}

test('UI renders the awaiting count, awaiting badge with owner and age, and read-only label', () => {
  const app = loadApp();
  const base = { repo: 'r', issue: 'AIMON-5', branch: 'b', agent: 'claude', kind: null, startedAt: 1000, finishedAt: 2000, lastUpdateAt: 2000,
    heartbeatAt: null, elapsedSec: 1, elapsedEstimated: false, exitCode: 0, signal: null, tokens: null, retry: null,
    launcherPid: null, agentPid: null, steps: [], postCheck: { decision: 'unavailable', reasons: [] } };
  const workers = [
    { ...base, id: 'w-await', status: 'failed', readOnly: false, failure: { code: 'x', label: '실패', logTail: [] }, awaiting: { owner: 'grok-bot', finishedAt: 2000, ageSec: 725 } },
    { ...base, id: 'w-ro', status: 'succeeded', readOnly: true, failure: null, awaiting: null },
  ];
  const summary = { counts: {}, failureRate: 0, failed: 0, finished: 0, retryRate: 0, retries: 0, retryEligible: 0, retryUnknown: 0, attempts: 2, awaiting: 1 };
  const snapshot = { generatedAt: 3000, workers, untracked: [], summary: { day: summary, all: summary }, asks: [] };
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderMetrics(); renderLiveWork(); renderAttention(); renderWorkers(state.workers); showDetail('w-await');`, app.context);
  assert.doesNotMatch(text(app.nodes.get('#metrics')), /다음 단계 대기/);
  assert.equal(app.nodes.get('#attention-count').textContent, '1건');
  const rows = flatten(app.nodes.get('#workers'));
  const badge = rows.find((item) => item.className === 'awaiting-badge');
  assert.equal(badge.textContent, '다음 단계 대기 · grok-bot · 12분');
  assert.notEqual(badge.className, 'status failed');
  assert.ok(rows.some((item) => item.className === 'read-only-badge' && item.textContent === '읽기 전용'));
  assert.ok(flatten(app.nodes.get('#detail-body')).some((item) => item.className === 'awaiting-badge'));
  runInNewContext("showDetail('w-ro');", app.context);
  assert.ok(flatten(app.nodes.get('#detail-body')).some((item) => item.className === 'read-only-badge'));
  assert.match(text(app.nodes.get('#workers')), /성공.*읽기 전용/);
});

test('UI asks panel exists, stays empty without asks and marks unstaffed asks red', () => {
  assert.match(html, /<h2>열린 질문<\/h2>[\s\S]*id="asks"/);
  const app = loadApp();
  runInNewContext('state = { asks: [] }; renderAsks();', app.context);
  assert.deepEqual(app.nodes.get('#asks').children, []);
  const asks = [
    { id: 'a1', title: '배포 승인', owner: 'eo-bot', createdAt: 0, ageSec: 1500, unstaffed: true },
    { id: 'a2', title: '리뷰 대기', owner: 'verifier', createdAt: 0, ageSec: 60, unstaffed: false },
  ];
  runInNewContext(`state = { asks: ${JSON.stringify(asks)} }; renderAsks();`, app.context);
  const [red, normal] = app.nodes.get('#asks').children;
  assert.match(red.className, /ask-unstaffed/);
  assert.match(text(red), /배포 승인.*eo-bot · 25분 전/);
  assert.doesNotMatch(normal.className, /ask-unstaffed/);
});

test('inbox view: missing inbox/acks files give an empty inbox and no record-only awaiting', async (t) => {
  const base = await fixture(t);
  await worker(base, ended('lonely', { ageMin: 15 }));
  const state = await collectState({ base, now, processes: noProcesses });
  assert.deepEqual(state.inbox, { pending: [], acked: [] });
  assert.equal(byId(state).lonely.awaiting, null);
  assert.equal(byId(state).lonely.legacy, false);
  assert.equal(state.summary.all.awaiting, 0);
});

test('inbox view: pending first with owner/repo/issue/status/age; acked, auto-acked and superseded are not pending', async (t) => {
  const base = await fixture(t);
  const records = {
    pending: ended('pending', { issue: 'AIMON-1', ageMin: 3 }),
    awaiting: ended('awaiting', { issue: 'AIMON-2', ageMin: 25 }),
    acked: ended('acked', { issue: 'AIMON-3' }),
    autoAcked: ended('auto-acked', { issue: 'AIMON-4' }),
    superseded: ended('superseded', { issue: 'AIMON-5', ageMin: 30 }),
    follower: { id: 'follower', repo: 'ai-team-monitoring', issue: 'AIMON-5', branch: 'f', status: 'running',
      startedAt: iso(now - minute), heartbeatAt: iso(now - 1000) },
  };
  for (const record of Object.values(records)) await worker(base, record);
  const inboxOnlyOld = { ...inboxRow(ended('inbox-only-old', { issue: 'AIMON-8', ageMin: 40 })), owner: undefined };
  const inboxOnlyNew = { ...inboxRow(ended('inbox-only-new', { issue: 'AIMON-8', ageMin: 11 })), owner: undefined };
  await jsonl(base, 'inbox/grok-bot.jsonl', [
    ...Object.values(records).filter((record) => record.finishedAt).map((record) => inboxRow(record)),
    { ...inboxRow(records.pending), schema: 'other/v1', workerId: 'other-schema' },
  ]);
  await jsonl(base, 'inbox/eo-bot.jsonl', [inboxOnlyOld, inboxOnlyNew]);
  await jsonl(base, 'inbox/acks.jsonl', [
    { workerId: 'acked', ackedAt: iso(now - minute), by: 'grok-bot', note: 'private note' },
    { workerId: 'auto-acked', ackedAt: iso(now), by: 'launcher', note: 'private note', nextWorkerId: 'next-1' },
  ]);
  const state = await collectState({ base, now, processes: noProcesses });
  const pending = Object.fromEntries(state.inbox.pending.map((item) => [item.workerId, item]));
  assert.deepEqual(Object.keys(pending).sort(), ['awaiting', 'inbox-only-new', 'pending']);
  assert.deepEqual(pending.pending, { workerId: 'pending', repo: 'ai-team-monitoring', issue: 'AIMON-1', owner: 'grok-bot',
    status: 'failed', reason: 'x', finishedAt: now - 3 * minute, ageSec: 180, awaiting: false, blocker: null, detail: '이유 없음' });
  assert.equal(pending['inbox-only-new'].owner, 'eo-bot');
  assert.equal(pending['inbox-only-new'].awaiting, true);
  assert.equal(state.inbox.pending[0].workerId, 'pending');
  assert.deepEqual(state.inbox.acked.map((item) => [item.workerId, item.by, item.nextWorkerId, item.ackedAt]),
    [['auto-acked', 'launcher', 'next-1', now], ['acked', 'grok-bot', '', now - minute]]);
  assert.doesNotMatch(JSON.stringify(state.inbox), /private note/);
  // The awaiting item is counted and badged exactly as in AIMON-5 and is also visible in the inbox.
  assert.equal(pending.awaiting.awaiting, true);
  assert.deepEqual(byId(state).awaiting.awaiting, { owner: 'grok-bot', finishedAt: now - 25 * minute, ageSec: 1500, blocker: null, detail: '이유 없음' });
  assert.equal(state.summary.all.awaiting, 1);
});

test('UI inbox panel: empty without items; pending rows with awaiting badge; acked rows folded; owners hidden in privacy', () => {
  assert.match(html, /<h2>수신함<\/h2>[\s\S]*id="inbox"/);
  const app = loadApp();
  runInNewContext('state = { inbox: { pending: [], acked: [] } }; renderInbox();', app.context);
  assert.deepEqual(app.nodes.get('#inbox').children, []);
  runInNewContext('state = {}; renderInbox();', app.context);
  assert.deepEqual(app.nodes.get('#inbox').children, []);
  const inbox = {
    pending: [
      { workerId: 'w1', repo: 'r', issue: 'AIMON-6', owner: 'grok-bot', status: 'failed', reason: '시간 초과', finishedAt: 0, ageSec: 900, awaiting: true },
      { workerId: 'w2', repo: 'r', issue: 'AIMON-7', owner: 'eo-bot', status: 'succeeded', reason: '', finishedAt: 0, ageSec: 120, awaiting: false },
    ],
    acked: [{ workerId: 'w0', repo: 'r', issue: 'AIMON-5', owner: 'grok-bot', status: 'succeeded', reason: '', finishedAt: 0, ageSec: 0,
      ackedAt: 0, by: 'launcher', nextWorkerId: 'w9' }],
  };
  runInNewContext(`state = { inbox: ${JSON.stringify(inbox)} }; renderInbox();`, app.context);
  const [awaitingRow, pendingRow, folded] = app.nodes.get('#inbox').children;
  assert.match(awaitingRow.className, /inbox-awaiting/);
  assert.equal(flatten(awaitingRow).find((item) => item.className === 'awaiting-badge').textContent, '다음 단계 대기 · grok-bot · 15분');
  assert.match(text(awaitingRow), /w1 · r AIMON-6.*grok-bot · 실패 · 시간 초과 · 15분 전/);
  assert.ok(!flatten(pendingRow).some((item) => item.className === 'awaiting-badge'));
  assert.match(text(pendingRow), /eo-bot · 성공 · 2분 전/);
  assert.equal(folded.className, 'inbox-acked-list');
  assert.match(text(folded), /처리됨 1건.*w0 · r AIMON-5.*launcher · 다음 w9/);
  assert.ok(!flatten(folded).some((item) => item.className === 'awaiting-badge'));
  runInNewContext('privacy = true; renderInbox();', app.context);
  const hidden = text(app.nodes.get('#inbox'));
  assert.doesNotMatch(hidden, /grok-bot|eo-bot|launcher|w9/);
  assert.match(hidden, /담당 숨김/);
});

test('next-stage metadata routes issue owners and honors explicit release/verifier inbox owners', async (t) => {
  const base = await fixture(t);
  await writeFile(join(base, 'ai-team-monitoring.json'), JSON.stringify({
    ownerByIssuePrefix: [
      ...['HARNESS', 'AIMON', 'SECRET', 'AWSDEV'].map((prefix) => ({ prefix, owner: 'Tooling Owner' })),
      { prefix: 'ISSUE', owner: 'Engineering Owner' },
    ],
  }));
  const cases = [
    ['HARNESS-1', 'grok-bot', 'Tooling Owner', 'merge'],
    ['AIMON-1', 'eo-bot', 'Tooling Owner', 'merge'],
    ['SECRET-1', 'grok-bot', 'Tooling Owner', 'merge'],
    ['AWSDEV-1', 'grok-bot', 'Tooling Owner', 'merge'],
    ['ISSUE-1', 'grok-bot', 'Engineering Owner', 'merge'],
    ['AIMON-2', 'Release Owner', 'Release Owner', 'deploy'],
    ['AIMON-3', 'Verifier', 'Verifier', 'verify'],
  ];
  for (const [issue, owner] of cases) {
    const record = ended(issue, { issue, status: 'succeeded', ageMin: 12 });
    await worker(base, record);
    await jsonl(base, `inbox/${issue}.jsonl`, [inboxRow(record, owner)]);
  }
  const workers = byId(await collectState({ base, now, processes: noProcesses }));
  for (const [issue, , owner, nextStep] of cases) {
    assert.deepEqual(workers[issue].handoff, { owner, nextStep });
  }
});

test('explicit inbox next step wins over the owner default and invalid steps are ignored', async (t) => {
  const base = await fixture(t);
  const rows = [];
  for (const [id, nextStep] of [['verify', 'verify'], ['deploy', 'deploy'], ['invalid', '<script>secret</script>']]) {
    const record = ended(id, { issue: `AIMON-${id}`, status: 'succeeded', ageMin: 12 });
    await worker(base, record);
    rows.push({ ...inboxRow(record), nextStep });
  }
  await jsonl(base, 'inbox/grok-bot.jsonl', rows);
  const workers = byId(await collectState({ base, now, processes: noProcesses }));
  assert.equal(workers.verify.handoff.nextStep, 'verify');
  assert.equal(workers.deploy.handoff.nextStep, 'deploy');
  assert.equal(workers.invalid.handoff.nextStep, 'merge');
});
