/** Today's lane history: per-lane succeeded/failed counts, reason breakdown, ungrouped row and hidden view. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { collectState, laneHistory } from '../server.mjs';
import { pageSource } from './helpers/page-source.mjs';

const source = await pageSource();

const now = Date.parse('2026-11-25T04:00:00Z');
const minute = 60000;
const hour = 60 * minute;
const noProcesses = async () => [];
const iso = (ms) => new Date(ms).toISOString();
const SCHEMA = 'ai-team-monitoring.lanes/v1';
const LANES = JSON.stringify({ schema: SCHEMA, lanes: [
  { name: 'monitoring', match: { repo: ['ai-team-monitoring'], issuePrefix: [] } },
  { name: 'web', match: { repo: [], issuePrefix: ['WEB-'] } },
] });

/** Make an isolated harness state directory. */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'agent-lane-history-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'local-workers'));
  return base;
}

/** Write one finished worker record started `startedAgo` ms before now. */
async function worker(base, id, fields, startedAgo = hour) {
  const dir = join(base, 'local-workers', id);
  await mkdir(dir);
  await writeFile(join(dir, 'record.json'), JSON.stringify({ id, branch: id, agent: 'claude',
    startedAt: iso(now - startedAgo), finishedAt: iso(now - startedAgo + 10 * minute), ...fields }));
}

/** Write a fixture day: two lanes, an ungrouped worker and one attempt older than 24h. */
async function fixtureDay(base) {
  await worker(base, 'm-ok', { repo: 'ai-team-monitoring', issue: 'AIMON-1', status: 'succeeded' });
  await worker(base, 'm-none', { repo: 'ai-team-monitoring', issue: 'AIMON-2', status: 'no-changes' });
  await worker(base, 'm-ro', { repo: 'ai-team-monitoring', issue: 'AIMON-3', status: 'failed', mode: 'read-only', reason: 'post-check: no-commits' });
  await worker(base, 'm-id', { repo: 'ai-team-monitoring', issue: 'AIMON-4', status: 'failed',
    postCheck: { decision: 'fail', reasons: ['foreign-identity', 'dirty-worktree'] } });
  await worker(base, 'm-dirty', { repo: 'ai-team-monitoring', issue: 'AIMON-5', status: 'failed', reason: 'dirty-worktree' });
  await worker(base, 'm-old', { repo: 'ai-team-monitoring', issue: 'AIMON-6', status: 'failed', reason: 'from-ref' }, 25 * hour);
  await worker(base, 'w-ok', { repo: 'example-web', issue: 'WEB-1', status: 'succeeded' });
  await worker(base, 'w-ref', { repo: 'example-web', issue: 'WEB-2', status: 'failed', reason: 'from-ref' });
  await worker(base, 'w-killed', { repo: 'example-web', issue: 'WEB-3', status: 'killed', signal: 'SIGTERM' });
  await worker(base, 'x-fail', { repo: 'other-repo', issue: 'OTHER-1', status: 'failed', reason: 'no-commits' });
}

test('missing lanes file hides the history view without an error', async (t) => {
  const base = await fixture(t);
  await fixtureDay(base);
  const state = await collectState({ base, now, processes: noProcesses, lanesPath: '' });
  assert.equal(state.laneHistory, null);
  assert.equal(state.sources.lanesMissing, true);
  assert.equal(state.sources.lanesInvalid, false);
});

test('a fixture day counts succeeded and failed workers per lane within the 24h window', async (t) => {
  const base = await fixture(t);
  await fixtureDay(base);
  await writeFile(join(base, 'lanes.json'), LANES);
  const state = await collectState({ base, now, processes: noProcesses, lanesPath: '' });
  const history = state.laneHistory;
  assert.equal(history.windowStart, now - 86400000);
  const counts = history.lanes.map(({ name, succeeded, failed }) => ({ name, succeeded, failed }));
  // Read-only no-commits and no-changes count as success; the 25h-old attempt is outside the window.
  assert.deepEqual(counts, [
    { name: 'monitoring', succeeded: 3, failed: 2 },
    { name: 'web', succeeded: 1, failed: 2 },
  ]);
  const day = state.summary.day;
  const total = history.lanes.reduce((sum, lane) => sum + lane.failed, 0) + history.ungrouped.failed;
  assert.equal(total, day.failed);
});

test('reason breakdown lists foreign-identity and dirty-worktree codes; unknown codes stay raw', async (t) => {
  const base = await fixture(t);
  await fixtureDay(base);
  await writeFile(join(base, 'lanes.json'), LANES);
  const state = await collectState({ base, now, processes: noProcesses, lanesPath: '' });
  const [monitoring, web] = state.laneHistory.lanes;
  assert.deepEqual(monitoring.reasons, [
    { code: 'dirty-worktree', label: '작업 트리 미정리', count: 2 },
    { code: 'foreign-identity', label: 'foreign-identity', count: 1 },
  ]);
  assert.deepEqual(web.reasons.map(({ code, count }) => ({ code, count })), [
    { code: 'from-ref', count: 1 },
    { code: 'killed', count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(state.laneHistory), /post-check:/);
});

test('workers matching no lane form one ungrouped row, null when every worker has a lane', async (t) => {
  const base = await fixture(t);
  await fixtureDay(base);
  await writeFile(join(base, 'lanes.json'), LANES);
  const state = await collectState({ base, now, processes: noProcesses, lanesPath: '' });
  assert.deepEqual(state.laneHistory.ungrouped, { succeeded: 0, failed: 1, reasons: [{ code: 'no-commits', label: '커밋 없음', count: 1 }] });
  const lanes = [{ name: 'all', repos: ['a'], issuePrefixes: [] }];
  const grouped = laneHistory(lanes, [{ repo: 'a', issue: 'A-1', status: 'succeeded', startedAt: now - minute, postCheck: { reasons: [] }, failure: null }], now);
  assert.equal(grouped.ungrouped, null);
  assert.deepEqual(grouped.lanes, [{ name: 'all', succeeded: 1, failed: 0, reasons: [] }]);
});

test('a failure without a usable code is counted as unknown, never as prose', () => {
  const lanes = [{ name: 'a', repos: ['a'], issuePrefixes: [] }];
  const workers = [
    { repo: 'a', status: 'failed', startedAt: now - minute, postCheck: { reasons: [] }, failure: { code: 'Some prose text' } },
    { repo: 'a', status: 'dead', startedAt: now - minute, postCheck: { reasons: [] }, failure: null },
    { repo: 'a', status: 'running', startedAt: now - minute, postCheck: { reasons: [] }, failure: null },
  ];
  assert.deepEqual(laneHistory(lanes, workers, now).lanes[0], {
    name: 'a', succeeded: 0, failed: 2, reasons: [{ code: 'unknown', label: '사유 기록 없음', count: 2 }] });
});

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

/** Execute app.js with a tiny DOM double and return its context and nodes. */
function loadApp() {
  const nodes = new Map();
  /** Create a text-node DOM double. */
  function node() {
    return { textContent: '', children: [], attributes: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {},
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } };
  }
  const document = { createElement: node, createElementNS: node, documentElement: { dataset: {} }, addEventListener() {},
    querySelector: (selector) => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); } };
  const context = { document, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null, setItem() {} }, EventSource: class {} };
  runInNewContext(source, context);
  return { context, nodes };
}

/** Read every rendered text node. */
function renderedText(node) {
  return [node.textContent, ...(node.children ?? []).map(renderedText)].join(' ');
}

test('history view is hidden by default and when the snapshot has no lane history', () => {
  assert.match(html, /<section id="lane-history"[^>]*\bhidden\b/);
  const app = loadApp();
  for (const laneHistory of [null, undefined, { windowStart: 0, lanes: [], ungrouped: null }]) {
    runInNewContext(`state = ${JSON.stringify({ generatedAt: now, workers: [], laneHistory })}; renderLaneHistory();`, app.context);
    assert.equal(app.nodes.get('#lane-history').hidden, true, JSON.stringify(laneHistory));
    assert.equal(app.nodes.get('#lane-history-body').children.length, 0);
  }
});

test('history view renders per-lane counts, reasons and the ungrouped row; privacy hides lane names', () => {
  const app = loadApp();
  const laneHistory = { windowStart: now - 86400000, ungrouped: { succeeded: 1, failed: 0, reasons: [] }, lanes: [
    { name: 'monitoring', succeeded: 3, failed: 2, reasons: [
      { code: 'dirty-worktree', label: '작업 트리 미정리', count: 2 }, { code: 'foreign-identity', label: 'foreign-identity', count: 1 }] },
    { name: 'web', succeeded: 1, failed: 0, reasons: [] },
  ] };
  runInNewContext(`state = ${JSON.stringify({ generatedAt: now, workers: [], laneHistory })}; renderLaneHistory();`, app.context);
  const body = app.nodes.get('#lane-history-body');
  assert.equal(app.nodes.get('#lane-history').hidden, false);
  assert.deepEqual(body.children.map((row) => row.className), ['event lane-history lane-history-failed', 'event lane-history', 'event lane-history']);
  assert.match(renderedText(body.children[0]), /monitoring 성공 3 · 실패 2 작업 트리 미정리 2 · foreign-identity 1/);
  assert.match(renderedText(body.children[2]), /기타 \(레인 없음\) 성공 1 · 실패 0/);
  runInNewContext('privacy = true; renderLaneHistory();', app.context);
  assert.doesNotMatch(renderedText(body), /monitoring|web/);
  assert.match(renderedText(body), /레인 01.*레인 02/);
});
