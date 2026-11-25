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
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  const document = {
    documentElement: { dataset: {} },
    createElement: element,
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
  assert.match(app.nodes.get('#running-list').children[0].textContent, /병합 중 · 2분/);
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
    assert.match(app.nodes.get('#running-list').children[0].textContent, /병합 중 · (시작 시각 없음|0분)/);
  }
});
