/** Verify Cursor hook metadata extraction, privacy filtering, server folding and UI rendering. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { appendCursorEvent, cursorEventFromPayload, hookOutput, validateCursorEvent } from '../tools/cursor-hook.mjs';
import { agentCommand, collectState, cursorWorkers } from '../server.mjs';

const at = '2026-11-25T07:20:00.000Z';
const now = Date.parse('2026-11-25T07:25:00.000Z');
const conv = '34e91c7e-2586-40c4-84fd-d1f3302c654b';
const gen = '11223344-5566-7788-99aa-bbccddeeff00';

test('cursor hook extracts only allowlisted metadata and drops prompts, emails and tool payloads', () => {
  const start = cursorEventFromPayload({
    hook_event_name: 'beforeSubmitPrompt',
    conversation_id: conv,
    generation_id: gen,
    model: 'gemini-4-neon-high',
    workspace_roots: ['/Users/example/ai-team-monitoring'],
    prompt: 'SECRET_PROMPT_TEXT token=sk-secret123',
    user_email: 'private@example.com',
    transcript_path: '/Users/example/transcript.jsonl',
  }, at);
  assert.deepEqual(start, {
    v: 1,
    id: '34e91c7e-11223344',
    event: 'start',
    at,
    model: 'gemini-4-neon-high',
    repo: 'ai-team-monitoring',
    conversationId: conv,
  });
  assert.equal(hookOutput({ hook_event_name: 'beforeSubmitPrompt' }), '{"continue":true}');
  assert.equal(hookOutput({ hook_event_name: 'stop' }), '{}');
  assert.equal(cursorEventFromPayload({ hook_event_name: 'preToolUse', conversation_id: conv }, at), null);
  assert.equal(cursorEventFromPayload({
    hook_event_name: 'postToolUse',
    conversation_id: conv,
    generation_id: gen,
    model_id: 'gemini-4-neon-high',
    tool_input: { command: 'SECRET_CMD' },
    tool_output: 'SECRET_OUT',
  }, at).event, 'heartbeat');
  assert.equal(cursorEventFromPayload({ hook_event_name: 'stop', conversation_id: conv, generation_id: gen, status: 'completed' }, at).status, 'succeeded');
  assert.equal(cursorEventFromPayload({ hook_event_name: 'stop', conversation_id: conv, generation_id: gen, status: 'aborted' }, at).status, 'canceled');
  assert.equal(cursorEventFromPayload({ hook_event_name: 'stop', conversation_id: conv, generation_id: gen, status: 'error' }, at).status, 'failed');
  assert.equal(cursorEventFromPayload({ hook_event_name: 'sessionEnd', session_id: conv, reason: 'window_close' }, at).status, 'canceled');
  assert.throws(() => validateCursorEvent({ ...start, prompt: 'forbidden' }));
  assert.throws(() => validateCursorEvent({ ...start, status: 'succeeded' }));
  assert.throws(() => validateCursorEvent({ v: 1, id: 'x', event: 'finish', at, status: 'running' }));
});

test('cursor hook CLI writes JSONL via CURSOR_RUNS_JSONL and always fails open on malformed stdin', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'cursor-hook-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, 'cursor-runs.jsonl');
  const env = { ...process.env, CURSOR_RUNS_JSONL: path };
  const runHook = (input) => execFileSync(process.execPath, ['tools/cursor-hook.mjs'], { env, input, encoding: 'utf8' });

  assert.equal(runHook(JSON.stringify({
    hook_event_name: 'beforeSubmitPrompt', conversation_id: conv, generation_id: gen,
    model: 'gemini-4-neon-high', workspace_roots: ['/tmp/ai-team-monitoring'], prompt: 'PRIVATE_PROMPT',
  })).trim(), '{"continue":true}');
  assert.equal(runHook(JSON.stringify({
    hook_event_name: 'stop', conversation_id: conv, generation_id: gen, status: 'completed',
  })).trim(), '{}');
  assert.equal(runHook('{broken json').trim(), '{}');

  const text = await readFile(path, 'utf8');
  assert.doesNotMatch(text, /PRIVATE_PROMPT/);
  const rows = text.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event, 'start');
  assert.equal(rows[0].model, 'gemini-4-neon-high');
  assert.equal(rows[1].event, 'finish');
  assert.equal(rows[1].status, 'succeeded');
});

test('cursor runs fold into live workers, expire when stale, resolve on newer conversation turns and match lanes by repo', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'cursor-state-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cursorPath = join(base, 'cursor-runs.jsonl');
  const lanesPath = join(base, 'lanes.json');
  await writeFile(lanesPath, JSON.stringify({
    schema: 'ai-team-monitoring.lanes/v1',
    lanes: [{ name: 'monitoring', match: { repo: ['ai-team-monitoring'], issuePrefix: [] } }],
  }));
  await appendCursorEvent({
    hook_event_name: 'beforeSubmitPrompt', conversation_id: conv, generation_id: 'gen-old',
    model: 'gemini-4-neon-high', workspace_roots: ['/work/ai-team-monitoring'],
  }, { path: cursorPath, at: '2026-11-25T07:10:00.000Z' });
  await appendCursorEvent({
    hook_event_name: 'stop', conversation_id: conv, generation_id: 'gen-old', status: 'error',
  }, { path: cursorPath, at: '2026-11-25T07:11:00.000Z' });
  await appendCursorEvent({
    hook_event_name: 'beforeSubmitPrompt', conversation_id: conv, generation_id: 'gen-live',
    model: 'gemini-4-neon-high', workspace_roots: ['/work/ai-team-monitoring'],
  }, { path: cursorPath, at: '2026-11-25T07:20:00.000Z' });
  await appendCursorEvent({
    hook_event_name: 'postToolUse', conversation_id: conv, generation_id: 'gen-live',
    model: 'gemini-4-neon-high', workspace_roots: ['/work/ai-team-monitoring'],
  }, { path: cursorPath, at: '2026-11-25T07:24:00.000Z' });
  await appendCursorEvent({
    hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv-stale', generation_id: 'gen-stale',
    model: 'gemini-4-neon-high', workspace_roots: ['/work/other'],
  }, { path: cursorPath, at: '2026-11-25T06:00:00.000Z' });

  const state = await collectState({ base, cursorPath, lanesPath, now, processes: async () => [] });
  assert.equal(state.sources.cursorMissing, false);
  const byId = Object.fromEntries(state.workers.map((worker) => [worker.id, worker]));
  const live = byId['cursor:34e91c7e-gen-live'];
  const old = byId['cursor:34e91c7e-gen-old'];
  const stale = byId['cursor:conv-stale-gen-stale'];
  assert.equal(live.status, 'running');
  assert.equal(live.agent, 'cursor');
  assert.equal(live.title, 'gemini-4-neon-high');
  assert.equal(live.repo, 'ai-team-monitoring');
  assert.equal(live.taskSummary, 'ai-team-monitoring · gemini-4-neon-high');
  assert.equal(old.status, 'failed');
  assert.equal(old.resolved, true);
  assert.equal(stale.status, 'dead');
  assert.equal(stale.elapsedEstimated, true);
  assert.equal(state.lanes[0].running, 1);
  assert.equal(state.lanes[0].zero, false);
  assert.equal(Object.hasOwn(live, '_conversationId'), false);

  // sessionEnd closes an open turn in the same conversation without needing generation_id.
  const closed = cursorWorkers([
    cursorEventFromPayload({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv-end', generation_id: 'g1', model: 'gemini-4-neon-high' }, '2026-11-25T07:20:00.000Z'),
    cursorEventFromPayload({ hook_event_name: 'sessionEnd', session_id: 'conv-end', reason: 'user_close' }, '2026-11-25T07:22:00.000Z'),
  ], now);
  assert.equal(closed[0].status, 'canceled');
  assert.equal(closed[0].elapsedSec, 120);
  assert.deepEqual(agentCommand('/usr/local/bin/cursor-agent -p fix'), { binary: 'cursor-agent', subcommand: '-p' });
});

test('UI renders running Cursor Gemini Neon turn in live work, inventory, tokens and detail with privacy protection', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const nodes = new Map();
  const node = () => ({
    textContent: '', children: [], attributes: {}, handlers: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.handlers[name] = callback; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    showModal() { this.open = true; },
    close() { this.open = false; },
  });
  const document = {
    createElement: node, createElementNS: node, documentElement: { dataset: {} }, addEventListener() {},
    querySelector: (selector) => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
  };
  const context = { document, matchMedia: () => ({ matches: false, addEventListener() {} }), localStorage: { getItem: () => null }, EventSource: class {} };
  runInNewContext(source, context);
  const text = (target) => [target.textContent, ...(target.children ?? []).map(text)].join(' ');
  const worker = {
    id: 'cursor:34e91c7e-gen-live', repo: 'ai-team-monitoring', issue: '', branch: '',
    title: 'gemini-4-neon-high', taskSummary: 'ai-team-monitoring · gemini-4-neon-high',
    bot: 'Cursor', task: 'gemini-4-neon-high', cli: 'cursor', agent: 'cursor', kind: 'task',
    status: 'running', startedAt: now - 120000, finishedAt: null, lastUpdateAt: now,
    heartbeatAt: null, heartbeatAgeSec: null, heartbeatStale: false, signal: null, failure: null,
    elapsedSec: 120, elapsedEstimated: false, exitCode: null, steps: [], retry: null,
    launcherPid: null, agentPid: null, handoff: { owner: 'Cursor', nextStep: 'merge' },
    postCheck: { decision: 'unavailable', reasons: [], omittedReasons: 0 },
    tokens: null, usageTruncated: false, logUnreadable: false, resolved: false, awaiting: null,
  };
  runInNewContext(`state = { generatedAt: ${now}, workers: [${JSON.stringify(worker)}], untracked: [] }; renderLiveWork(); renderWorkers(state.workers); showDetail(state.workers[0].id);`, context);
  assert.match(text(nodes.get('#running-list')), /cursor:34e91c7e-gen-live.*실행 중.*Cursor.*ai-team-monitoring · gemini-4-neon-high/);
  assert.match(text(nodes.get('#workers')), /cursor:34e91c7e-gen-live.*Cursor \/ gemini-4-neon-high.*cursor/);
  assert.match(text(nodes.get('#tokens')), /cursor.*—.*토큰 미수집/);
  assert.match(text(nodes.get('#detail-body')), /Cursor \/ gemini-4-neon-high/);
  runInNewContext('privacy = true; renderLiveWork(); renderWorkers(state.workers); showDetail(state.workers[0].id);', context);
  for (const selector of ['#running-list', '#workers', '#detail-body']) {
    assert.doesNotMatch(text(nodes.get(selector)), /34e91c7e|gemini-4-neon-high|ai-team-monitoring/);
  }
});
