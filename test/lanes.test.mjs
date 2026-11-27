/** Lane coverage: config parsing, lane matching, lanes at 0 and the hidden panel, on the server and in the UI. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { collectState, laneCoverage, laneMatches, laneTimeline, parseLanes, seoulDayStart } from '../server.mjs';
import { pageSource } from './helpers/page-source.mjs';

const source = await pageSource();

const now = Date.parse('2026-11-25T04:00:00Z');
const minute = 60000;
const noProcesses = async () => [];
const iso = (ms) => new Date(ms).toISOString();
const SCHEMA = 'ai-team-monitoring.lanes/v1';

/** Make an isolated harness state directory. */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'agent-lanes-'));
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

const config = (lanes) => JSON.stringify({ schema: SCHEMA, lanes });
const withoutTimeline = (lanes) => lanes.map(({ timeline, ...rest }) => rest);

test('example config parses and uses only generic lane names', async () => {
  const text = await readFile(new URL('../examples/lanes.example.json', import.meta.url), 'utf8');
  const lanes = parseLanes(text);
  assert.deepEqual(lanes.map((lane) => lane.name), ['monitoring', 'web', 'platform']);
  assert.deepEqual(lanes[0], { name: 'monitoring', repos: ['ai-team-monitoring'], issuePrefixes: [] });
});

test('parseLanes rejects a wrong schema or malformed JSON and drops unnamed lanes and non-string patterns', () => {
  assert.equal(parseLanes('{'), null);
  assert.equal(parseLanes(JSON.stringify({ schema: 'other/v1', lanes: [] })), null);
  assert.equal(parseLanes(JSON.stringify({ schema: SCHEMA })), null);
  const lanes = parseLanes(config([{ name: '' }, { match: {} }, { name: 'a', match: { repo: ['r', 1, ''], issuePrefix: 'X-' } }]));
  assert.deepEqual(lanes, [{ name: 'a', repos: ['r'], issuePrefixes: [] }]);
});

test('a worker belongs to a lane by exact repo or issue prefix', () => {
  const lane = { name: 'web', repos: ['example-web'], issuePrefixes: ['WEB-', 'UI-'] };
  assert.equal(laneMatches(lane, { repo: 'example-web', issue: 'OTHER-1' }), true);
  assert.equal(laneMatches(lane, { repo: '', issue: 'WEB-12' }), true);
  assert.equal(laneMatches(lane, { repo: 'x', issue: 'UI-3' }), true);
  assert.equal(laneMatches(lane, { repo: 'example-web-old', issue: 'XWEB-1' }), false);
  assert.equal(laneMatches(lane, { repo: '', issue: '' }), false);
  assert.equal(laneMatches({ name: 'empty', repos: [], issuePrefixes: [] }, { repo: 'example-web', issue: 'WEB-1' }), false);
});

test('laneCoverage counts running workers; a lane at 0 reports time since the latest finish or unknown', () => {
  const lanes = [
    { name: 'busy', repos: ['a'], issuePrefixes: [] },
    { name: 'idle', repos: [], issuePrefixes: ['B-'] },
    { name: 'never', repos: ['c'], issuePrefixes: [] },
  ];
  const workers = [
    { repo: 'a', issue: 'A-1', status: 'running', finishedAt: null },
    { repo: 'a', issue: 'A-2', status: 'succeeded', finishedAt: now - 5 * minute },
    { repo: 'x', issue: 'B-1', status: 'failed', finishedAt: now - 30 * minute },
    { repo: 'x', issue: 'B-2', status: 'succeeded', finishedAt: now - 12 * minute },
    { repo: 'c', issue: 'C-1', status: 'dead', finishedAt: null },
  ];
  assert.deepEqual(laneCoverage(lanes, workers, now), [
    { name: 'busy', running: 1, zero: false, lastFinishedAt: now - 5 * minute, zeroSec: null },
    { name: 'idle', running: 0, zero: true, lastFinishedAt: now - 12 * minute, zeroSec: 12 * 60 },
    { name: 'never', running: 0, zero: true, lastFinishedAt: null, zeroSec: null },
  ]);
});

test('laneCoverage does not count a running or starting worker whose heartbeat is older than 60 seconds', () => {
  const lanes = [{ name: 'monitoring', repos: ['ai-team-monitoring'], issuePrefixes: [] }];
  const only = (fields) => [{ repo: 'ai-team-monitoring', issue: 'AIMON-13', finishedAt: null, ...fields }];
  assert.equal(laneCoverage(lanes, only({ status: 'running', heartbeatAt: now - 1000 }), now)[0].running, 1);
  assert.equal(laneCoverage(lanes, only({ status: 'running', heartbeatAt: now - minute }), now)[0].running, 1);
  assert.equal(laneCoverage(lanes, only({ status: 'running', heartbeatAt: null }), now)[0].running, 1);
  assert.deepEqual(laneCoverage(lanes, only({ status: 'running', heartbeatAt: now - minute - 1 }), now), [
    { name: 'monitoring', running: 0, zero: true, lastFinishedAt: null, zeroSec: null },
  ]);
  assert.equal(laneCoverage(lanes, only({ status: 'starting', heartbeatAt: now - 5 * minute }), now)[0].zero, true);
  assert.equal(laneCoverage(lanes, only({ status: 'starting', heartbeatAt: now - 1000 }), now)[0].running, 1);
});

test('collectState puts a lane at 0 when its only running worker has a stale heartbeat but a live PID', async (t) => {
  const base = await fixture(t);
  await writeFile(join(base, 'lanes.json'), config([{ name: 'monitoring', match: { repo: ['ai-team-monitoring'], issuePrefix: [] } }]));
  const record = { id: 'run', repo: 'ai-team-monitoring', issue: 'AIMON-13', branch: 'b', agent: 'claude', status: 'running',
    startedAt: iso(now - 10 * minute), launcherPid: process.pid };
  await worker(base, { ...record, heartbeatAt: iso(now - 1000) });
  const fresh = await collectState({ base, now, processes: noProcesses, lanesPath: '' });
  assert.equal(fresh.workers[0].status, 'running');
  assert.deepEqual(withoutTimeline(fresh.lanes), [{ name: 'monitoring', running: 1, zero: false, lastFinishedAt: null, zeroSec: null }]);
  await writeFile(join(base, 'local-workers', 'run', 'record.json'), JSON.stringify({ ...record, heartbeatAt: iso(now - 2 * minute) }));
  const stale = await collectState({ base, now, processes: noProcesses, lanesPath: '' });
  assert.equal(stale.workers[0].status, 'running');
  assert.deepEqual(withoutTimeline(stale.lanes), [{ name: 'monitoring', running: 0, zero: true, lastFinishedAt: null, zeroSec: null }]);
  await rm(join(base, 'lanes.json'));
  const missing = await collectState({ base, now, processes: noProcesses, lanesPath: '' });
  assert.equal(missing.lanes, null);
  assert.equal(missing.sources.lanesMissing, true);
});

test('collectState reads <base>/lanes.json on each poll and hides lanes when the file is missing', async (t) => {
  const base = await fixture(t);
  await worker(base, { id: 'run', repo: 'ai-team-monitoring', issue: 'AIMON-8', branch: 'b', agent: 'claude', status: 'running',
    startedAt: iso(now - minute), heartbeatAt: iso(now - 1000) });
  await worker(base, { id: 'done', repo: 'example-web', issue: 'WEB-1', branch: 'b', agent: 'codex', status: 'succeeded',
    startedAt: iso(now - 40 * minute), finishedAt: iso(now - 20 * minute) });
  const options = { base, now, processes: noProcesses, lanesPath: '' };
  const missing = await collectState(options);
  assert.equal(missing.lanes, null);
  assert.equal(missing.sources.lanesMissing, true);
  assert.equal(missing.sources.lanesInvalid, false);
  await writeFile(join(base, 'lanes.json'), config([
    { name: 'monitoring', match: { repo: ['ai-team-monitoring'], issuePrefix: [] } },
    { name: 'web', match: { repo: [], issuePrefix: ['WEB-'] } },
  ]));
  const state = await collectState(options);
  assert.deepEqual(state.lanes.map(({ name, running, zero, zeroSec }) => ({ name, running, zero, zeroSec })), [
    { name: 'monitoring', running: 1, zero: false, zeroSec: null },
    { name: 'web', running: 0, zero: true, zeroSec: 20 * 60 },
  ]);
  await writeFile(join(base, 'lanes.json'), 'not json');
  const invalid = await collectState(options);
  assert.equal(invalid.lanes, null);
  assert.equal(invalid.sources.lanesInvalid, true);
});

test('lanesPath (AI_TEAM_MONITORING_LANES) overrides the default location', async (t) => {
  const base = await fixture(t);
  const path = join(base, 'custom-lanes.json');
  await writeFile(path, config([{ name: 'solo', match: { repo: ['nothing'], issuePrefix: [] } }]));
  const state = await collectState({ base, now, processes: noProcesses, lanesPath: path });
  const dayStart = seoulDayStart(now);
  assert.deepEqual(state.lanes, [{ name: 'solo', running: 0, zero: true, lastFinishedAt: null, zeroSec: null,
    timeline: { from: dayStart, to: now, current: 0, max: 0, segments: [{ from: dayStart, to: now, count: 0 }] } }]);
});

test('seoulDayStart returns the Asia/Seoul midnight before now', () => {
  assert.equal(seoulDayStart(now), Date.parse('2026-11-25T00:00:00+09:00'));
  assert.equal(seoulDayStart(Date.parse('2026-11-25T14:59:59Z')), Date.parse('2026-11-25T00:00:00+09:00'));
  assert.equal(seoulDayStart(Date.parse('2026-11-25T15:00:00Z')), Date.parse('2026-11-26T00:00:00+09:00'));
});

test('a worker that ran healthy today counts 1 in its window and 0 after it finished', () => {
  const lane = { name: 'web', repos: ['web'], issuePrefixes: [] };
  const dayStart = seoulDayStart(now);
  const startedAt = now - 90 * minute;
  const finishedAt = now - 30 * minute;
  const workers = [{ repo: 'web', issue: 'W-1', status: 'succeeded', startedAt, finishedAt, heartbeatAt: finishedAt - 1000 }];
  const timeline = laneTimeline(lane, workers, now);
  assert.deepEqual(timeline.segments, [
    { from: dayStart, to: startedAt, count: 0 },
    { from: startedAt, to: finishedAt, count: 1 },
    { from: finishedAt, to: now, count: 0 },
  ]);
  assert.equal(timeline.current, 0);
  assert.equal(timeline.max, 1);
});

test('a still-running worker with a heartbeat older than 60 seconds does not raise the count', () => {
  const lane = { name: 'web', repos: ['web'], issuePrefixes: [] };
  const dayStart = seoulDayStart(now);
  const staleSinceYesterday = { repo: 'web', issue: 'W-1', status: 'running', startedAt: dayStart - 120 * minute,
    finishedAt: null, heartbeatAt: dayStart - 30 * minute };
  assert.deepEqual(laneTimeline(lane, [staleSinceYesterday], now), { from: dayStart, to: now, current: 0, max: 0,
    segments: [{ from: dayStart, to: now, count: 0 }] });
  const heartbeatAt = now - 10 * minute;
  const staleToday = { repo: 'web', issue: 'W-2', status: 'running', startedAt: now - 20 * minute, finishedAt: null, heartbeatAt };
  const timeline = laneTimeline(lane, [staleToday], now);
  assert.equal(timeline.current, 0);
  assert.deepEqual(timeline.segments.at(-1), { from: heartbeatAt + minute, to: now, count: 0 });
  const fresh = { ...staleToday, heartbeatAt: now - 5000 };
  assert.equal(laneTimeline(lane, [fresh], now).current, 1);
});

test('a starting worker without heartbeat counts until now; an inactive one without finishedAt stops at its last update', () => {
  const lane = { name: 'web', repos: ['web'], issuePrefixes: [] };
  const starting = { repo: 'web', issue: 'W-1', status: 'starting', startedAt: now - 5 * minute, finishedAt: null, heartbeatAt: null };
  assert.equal(laneTimeline(lane, [starting], now).current, 1);
  const dead = { ...starting, status: 'dead', lastUpdateAt: now - 2 * minute };
  const timeline = laneTimeline(lane, [dead], now);
  assert.equal(timeline.current, 0);
  assert.deepEqual(timeline.segments.at(-2), { from: now - 5 * minute, to: now - 2 * minute, count: 1 });
});

test('overlapping workers stack and only workers of the lane count', () => {
  const lane = { name: 'web', repos: [], issuePrefixes: ['W-'] };
  const a = { repo: 'x', issue: 'W-1', status: 'succeeded', startedAt: now - 60 * minute, finishedAt: now - 20 * minute, heartbeatAt: null };
  const b = { repo: 'x', issue: 'W-2', status: 'running', startedAt: now - 40 * minute, finishedAt: null, heartbeatAt: now - 1000 };
  const other = { repo: 'x', issue: 'Z-1', status: 'running', startedAt: now - 50 * minute, finishedAt: null, heartbeatAt: now - 1000 };
  const timeline = laneTimeline(lane, [a, b, other], now);
  assert.deepEqual(timeline.segments.slice(1).map(({ count }) => count), [1, 2, 1]);
  assert.equal(timeline.current, 1);
  assert.equal(timeline.max, 2);
});

test('collectState attaches a today timeline per lane and none when the lanes file is missing', async (t) => {
  const base = await fixture(t);
  await worker(base, { id: 'done', repo: 'example-web', issue: 'WEB-1', branch: 'b', agent: 'codex', status: 'succeeded',
    startedAt: iso(now - 40 * minute), finishedAt: iso(now - 20 * minute), heartbeatAt: iso(now - 21 * minute) });
  await worker(base, { id: 'stale', repo: 'example-web', issue: 'WEB-2', branch: 'b', agent: 'claude', status: 'running',
    startedAt: iso(now - 15 * minute), heartbeatAt: iso(now - 10 * minute) });
  const options = { base, now, processes: noProcesses, lanesPath: '' };
  const missing = await collectState(options);
  assert.equal(missing.lanes, null);
  assert.equal(missing.sources.lanesMissing, true);
  await writeFile(join(base, 'lanes.json'), config([{ name: 'web', match: { repo: ['example-web'], issuePrefix: [] } }]));
  const [lane] = (await collectState(options)).lanes;
  assert.deepEqual(lane.timeline.segments.map(({ count }) => count), [0, 1, 0, 1, 0]);
  assert.equal(lane.timeline.current, 0);
  assert.equal(lane.timeline.segments.at(-1).from, now - 9 * minute);
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

test('lane panel is hidden by default and when the snapshot has no lanes', () => {
  assert.match(html, /<section id="lanes"[^>]*\bhidden\b/);
  const app = loadApp();
  for (const lanes of [null, undefined, []]) {
    runInNewContext(`state = ${JSON.stringify({ generatedAt: now, workers: [], lanes })}; renderLanes();`, app.context);
    const panel = app.nodes.get('#lanes');
    assert.equal(panel.hidden, true, String(lanes));
    assert.equal(panel.children.length, 0);
  }
});

test('a lane at 0 renders red with its time at 0 or unknown; privacy hides lane names', () => {
  const app = loadApp();
  const lanes = [
    { name: 'monitoring', running: 2, zero: false, lastFinishedAt: null, zeroSec: null },
    { name: 'web', running: 0, zero: true, lastFinishedAt: now - 20 * minute, zeroSec: 20 * 60 },
    { name: 'platform', running: 0, zero: true, lastFinishedAt: null, zeroSec: null },
  ];
  runInNewContext(`state = ${JSON.stringify({ generatedAt: now, workers: [], lanes })}; renderLanes();`, app.context);
  const panel = app.nodes.get('#lanes');
  assert.equal(panel.hidden, false);
  assert.deepEqual(panel.children.map((card) => card.className), ['lane', 'lane lane-zero', 'lane lane-zero']);
  assert.match(renderedText(panel.children[0]), /monitoring 2 실행 중/);
  assert.match(renderedText(panel.children[1]), /web 0 실행 중 워커 없음 · 20분째 0/);
  assert.match(renderedText(panel.children[2]), /platform 0 .*알 수 없음/);
  runInNewContext('privacy = true; renderLanes();', app.context);
  assert.doesNotMatch(renderedText(panel), /monitoring|web|platform/);
  assert.match(renderedText(panel), /레인 01.*레인 02.*레인 03/);
});

test('each lane card draws its today timeline with red 0 segments; no lanes renders no timeline', () => {
  const app = loadApp();
  const from = seoulDayStart(now);
  const timeline = { from, to: now, current: 0, max: 1, segments: [
    { from, to: now - 60 * minute, count: 0 },
    { from: now - 60 * minute, to: now - 30 * minute, count: 1 },
    { from: now - 30 * minute, to: now, count: 0 },
  ] };
  const lanes = [{ name: 'web', running: 0, zero: true, lastFinishedAt: now - 30 * minute, zeroSec: 30 * 60, timeline }];
  runInNewContext(`state = ${JSON.stringify({ generatedAt: now, workers: [], lanes })}; renderLanes();`, app.context);
  const card = app.nodes.get('#lanes').children[0];
  const wrap = card.children.find((child) => child.className === 'lane-timeline');
  assert.ok(wrap);
  const rects = wrap.children[0].children;
  assert.deepEqual(rects.map((rect) => rect.attributes.class), ['lane-idle', 'lane-busy', 'lane-idle']);
  assert.match(renderedText(wrap), /현재 0 · 최대 1 · 0 구간 2개/);
  runInNewContext(`state = ${JSON.stringify({ generatedAt: now, workers: [], lanes: null })}; renderLanes();`, app.context);
  assert.equal(app.nodes.get('#lanes').hidden, true);
  assert.equal(app.nodes.get('#lanes').children.length, 0);
});

test('favicon and title turn red while any lane is at 0', () => {
  const app = loadApp();
  const running = { id: 'w', status: 'running', startedAt: now - minute, awaiting: null };
  const snap = (lanes) => JSON.stringify({ generatedAt: now, workers: [running], untracked: [], lanes });
  const covered = [{ name: 'a', running: 1 }];
  const uncovered = [{ name: 'a', running: 1 }, { name: 'b', running: 0 }];
  assert.equal(runInNewContext(`faviconColor(${snap(covered)})`, app.context), 'blue');
  assert.equal(runInNewContext(`faviconColor(${snap(null)})`, app.context), 'blue');
  assert.equal(runInNewContext(`faviconColor(${snap(uncovered)})`, app.context), 'red');
  assert.equal(runInNewContext(`documentTitle(${snap(covered)})`, app.context), '(1) AI 팀 모니터링');
  assert.equal(runInNewContext(`documentTitle(${snap(uncovered)})`, app.context), '🔴 (1) AI 팀 모니터링 · 열린 항목 1건');
});
