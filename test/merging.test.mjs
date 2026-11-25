/** Verify merge lifecycle lists and counts using isolated worker records and DOM doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { collectState } from '../server.mjs';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const now = Date.parse('2026-11-25T04:00:00Z');
const iso = (value) => new Date(value).toISOString();

/** Load the real rendering functions with a minimal DOM. */
function loadApp(snapshot) {
  const nodes = new Map();
  const element = () => ({
    textContent: '', children: [],
    setAttribute() {},
    addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  const document = {
    documentElement: { dataset: {} },
    createElement: element,
    createElementNS: element,
    addEventListener() {},
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
  };
  const context = {
    document,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: { getItem: () => null },
  };
  runInNewContext(source, context);
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderLiveWork(); renderAttention();`, context);
  return { nodes, context };
}

/** Collect a fake merge record with an old failed attempt and an optional ack. */
async function snapshot(t, status, { ack = false, workerStatus = 'failed', startedAt = iso(now - 125000) } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'aimon-merging-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = join(base, 'local-workers', 'merge-worker');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'record.json'), JSON.stringify({
    id: 'merge-worker', repo: 'fake-repo', issue: 'AIMON-37', status: workerStatus,
    startedAt: iso(now - 7200000), finishedAt: iso(now - 3600000),
    merging: {
      status, startedAt, finishedAt: iso(now), reason: '충돌 token=fake-sensitive-value',
      by: 'PRIVATE_ACTOR', sha: 'PRIVATE_SHA', extra: 'PRIVATE_EXTRA',
    },
  }));
  await mkdir(join(base, 'inbox'));
  await writeFile(join(base, 'inbox', 'owner.jsonl'), JSON.stringify({
    schema: 'agent-orchestration.inbox/v1', workerId: 'merge-worker',
    repo: 'fake-repo', issue: 'AIMON-37', status: workerStatus,
    finishedAt: iso(now - 3600000), owner: 'owner',
  }) + '\n');
  if (ack) await writeFile(join(base, 'inbox', 'acks.jsonl'), JSON.stringify({ workerId: 'merge-worker', ackedAt: iso(now) }) + '\n');
  return collectState({ base, now, processes: async () => [] });
}

test('merging moves an old failed worker into running with merge elapsed time and no red count', async (t) => {
  const state = await snapshot(t, 'merging');
  const app = loadApp(state);
  assert.equal(app.nodes.get('#running-count').textContent, '1건');
  assert.match(app.nodes.get('#running-list').children[0].textContent, /병합 중 · 12:57:55 시작 · 2분/);
  assert.equal(app.nodes.get('#attention-count').textContent, '0건');
  assert.equal(runInNewContext('runningCount(state)', app.context), 1);
  assert.equal(runInNewContext('currentAlerts(state).length', app.context), 0);
  assert.equal(runInNewContext('faviconColor(state)', app.context), 'blue');
  assert.equal(state.workers[0].merging.startedAt, now - 125000);
  for (const text of ['PRIVATE_ACTOR', 'PRIVATE_SHA', 'PRIVATE_EXTRA', 'fake-sensitive-value']) {
    assert.equal(JSON.stringify(state).includes(text), false);
  }
});

test('failed merge returns to attention once with its redacted reason, even if the attempt was acked', async (t) => {
  const app = loadApp(await snapshot(t, 'failed', { ack: true, workerStatus: 'running' }));
  assert.equal(app.nodes.get('#running-count').textContent, '0건');
  assert.equal(app.nodes.get('#attention-count').textContent, '1건');
  assert.match(app.nodes.get('#attention-list').children[0].textContent, /병합 실패: 충돌/);
  assert.equal(runInNewContext('runningCount(state)', app.context), 0);
  assert.equal(runInNewContext('currentAlerts(state).length', app.context), 1);
});

test('merged and acked worker disappears from both lists and counts', async (t) => {
  const app = loadApp(await snapshot(t, 'merged', { ack: true }));
  assert.equal(app.nodes.get('#running-count').textContent, '0건');
  assert.equal(app.nodes.get('#attention-count').textContent, '0건');
  assert.equal(runInNewContext('runningCount(state)', app.context), 0);
  assert.equal(runInNewContext('currentAlerts(state).length', app.context), 0);
});

test('merge elapsed time handles missing and future start times without NaN or negative ages', async (t) => {
  for (const startedAt of ['invalid', iso(now + 60000)]) {
    const app = loadApp(await snapshot(t, 'merging', { startedAt }));
    assert.match(app.nodes.get('#running-list').children[0].textContent, /병합 중 · (시작 시각 없음|13:01:00 시작 · 0분)/);
  }
});

test('merge conflicts show files immediately from record or waiting evidence without an inbox', async (t) => {
  for (const [recordFields, evidence, expected] of [
    [{ status: 'merge-conflict', files: ['public/app.js', 'server.mjs'] }, null, 'public/app.js, server.mjs'],
    [{ status: 'succeeded' }, { status: 'merge-conflict', conflictFiles: ['one.js', 'two.js'] }, 'one.js, two.js'],
    [{ status: 'running' }, { blocker: 'conflict', detail: 'detail.js' }, 'detail.js'],
  ]) {
    const base = await mkdtemp(join(tmpdir(), 'aimon-conflict-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const dir = join(base, 'local-workers', 'worker');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'record.json'), JSON.stringify({
      id: 'worker', repo: 'fake-repo', issue: 'AIMON-39', startedAt: iso(now - 60000), ...recordFields,
    }));
    if (evidence) await writeFile(join(base, 'waiting.json'), JSON.stringify({ worker: evidence }));
    const state = await collectState({ base, now, processes: async () => [] });
    const app = loadApp(state);
    assert.equal(app.nodes.get('#running-count').textContent, '0건');
    assert.equal(app.nodes.get('#attention-count').textContent, '1건');
    assert.ok(app.nodes.get('#attention-list').children[0].textContent.includes(`병합 충돌 · ${expected}`));
    assert.equal(runInNewContext('mergeWaitText(state.workers[0])', app.context), `병합 충돌 · ${expected}`);
    runInNewContext('renderWorkers(state.workers)', app.context);
    assert.equal(app.nodes.get('#workers').children[0].children[2].children[0].textContent, `병합 충돌 · ${expected}`);
    assert.equal(runInNewContext('privacy = true; mergeWaitText(state.workers[0])', app.context), '병합 충돌 · 파일 숨김');
    assert.equal(state.workers[0].awaiting, null);
  }
});

test('file-overlap queue labels appear immediately and never count as running', async (t) => {
  const detail = 'waiting for preceding-worker merge (file conflict)';
  for (const [recordFields, evidence] of [
    [{ status: 'queued', detail }, null],
    [{ status: 'waiting', detail }, null],
    [{ status: 'running' }, { status: 'queued', detail }],
    [{ status: 'running' }, { blocker: detail }],
    [{ status: 'running' }, { blocker: 'conflict', detail }],
  ]) {
    const base = await mkdtemp(join(tmpdir(), 'aimon-queue-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const dir = join(base, 'local-workers', 'worker');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'record.json'), JSON.stringify({
      id: 'worker', repo: 'fake-repo', issue: 'AIMON-39', startedAt: iso(now - 60000), ...recordFields,
    }));
    await mkdir(join(base, 'inbox'));
    await writeFile(join(base, 'inbox', 'owner.jsonl'), JSON.stringify({
      schema: 'agent-orchestration.inbox/v1', workerId: 'worker', repo: 'fake-repo', issue: 'AIMON-39',
      status: 'succeeded', finishedAt: iso(now - 1000), owner: 'owner',
    }) + '\n');
    if (evidence) await writeFile(join(base, 'waiting.json'), JSON.stringify({ worker: evidence }));
    const state = await collectState({ base, now, processes: async () => [] });
    const app = loadApp(state);
    assert.equal(app.nodes.get('#running-count').textContent, '0건');
    assert.equal(runInNewContext('runningCount(state)', app.context), 0);
    assert.equal(state.summary.all.counts.running, 0);
    assert.equal(app.nodes.get('#attention-count').textContent, '1건');
    assert.ok(app.nodes.get('#attention-list').children[0].textContent.includes(detail));
    assert.equal(runInNewContext('mergeWaitText(state.inbox.pending[0])', app.context), detail);
    runInNewContext('renderWorkers(state.workers)', app.context);
    assert.equal(app.nodes.get('#workers').children[0].children[2].children[0].textContent, detail);
    assert.ok(runInNewContext('pendingInboxRow(state.inbox.pending[0]).children[1].textContent', app.context).includes(detail));
    assert.equal(runInNewContext('privacy = true; mergeWaitText(state.workers[0])', app.context), '파일 겹침 병합 대기');
  }
});
