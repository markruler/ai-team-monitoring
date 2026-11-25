/** Cover Claude/Codex CLI hook metadata extraction, privacy filtering, folding and collectState integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliEventFromPayload, parseHookArgs, validateCliEvent } from '../tools/cli-hook.mjs';
import { cliWorkers, collectState } from '../server.mjs';

const hookScript = fileURLToPath(new URL('../tools/cli-hook.mjs', import.meta.url));
const noProcesses = async () => [];

function runHook({ stdin = '', args = [], env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [hookScript, ...args], { env: { ...process.env, ...env }, timeout: 5000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

test('cli hook extracts allowlisted metadata for Claude Code and Codex notify while dropping prompts and messages', () => {
  const start = cliEventFromPayload({
    hook_event_name: 'UserPromptSubmit',
    session_id: '12345678-1111-2222-3333-444444444444',
    cwd: '/Users/dev/ai-team-monitoring',
    model: 'claude-opus-4',
    prompt: 'TOP_SECRET_PROMPT_TEXT',
    transcript_path: '/Users/dev/.claude/secret.jsonl',
  }, { at: '2026-11-25T07:00:00Z' });
  assert.deepEqual(start, {
    v: 1,
    agent: 'claude',
    id: '12345678',
    event: 'start',
    at: '2026-11-25T07:00:00Z',
    model: 'claude-opus-4',
    repo: 'ai-team-monitoring',
    sessionId: '12345678-1111-2222-3333-444444444444',
  });
  assert.doesNotMatch(JSON.stringify(start), /TOP_SECRET|transcript/);

  const codexNotify = cliEventFromPayload({
    type: 'agent-turn-complete',
    'thread-id': 'abcdef12-0000-0000-0000-000000000000',
    'turn-id': 'turn-9',
    cwd: '/Users/dev/my-repo',
    'input-messages': ['PRIVATE_USER_MSG'],
    'last-assistant-message': 'PRIVATE_ASSISTANT_MSG',
  }, { at: '2026-11-25T07:05:00Z' });
  assert.deepEqual(codexNotify, {
    v: 1,
    agent: 'codex',
    id: 'abcdef12-turn-9',
    event: 'finish',
    at: '2026-11-25T07:05:00Z',
    repo: 'my-repo',
    sessionId: 'abcdef12-0000-0000-0000-000000000000',
    status: 'succeeded',
  });
  assert.doesNotMatch(JSON.stringify(codexNotify), /PRIVATE_USER|PRIVATE_ASSISTANT/);
  assert.throws(() => validateCliEvent({ ...start, extra: 'nope' }));
  assert.deepEqual(parseHookArgs(['--agent', 'codex', '{"type":"agent-turn-complete"}']), {
    agent: 'codex',
    inlineJson: '{"type":"agent-turn-complete"}',
  });
});

test('cli hook CLI writes JSONL from stdin or Codex inline arg and always fails open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-hook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'cli-runs.jsonl');

  const res1 = await runHook({
    stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: '/tmp/proj', prompt: 'SECRET_1' }),
    env: { CLI_RUNS_JSONL: logPath },
  });
  assert.equal(res1.stdout.trim(), '{}');

  const res2 = await runHook({
    args: [JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'thr-1', 'turn-id': 't1', cwd: '/tmp/codex-proj', 'input-messages': ['SECRET_2'] })],
    env: { CLI_RUNS_JSONL: logPath },
  });
  assert.equal(res2.stdout.trim(), '{}');

  const bad = await runHook({ stdin: 'not-json', env: { CLI_RUNS_JSONL: logPath } });
  assert.equal(bad.stdout.trim(), '{}');

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].agent, 'claude');
  assert.equal(lines[0].event, 'start');
  assert.equal(lines[1].agent, 'codex');
  assert.equal(lines[1].event, 'finish');
  assert.doesNotMatch(JSON.stringify(lines), /SECRET_1|SECRET_2/);
});

test('cliWorkers segments sequential turns per session, expires stale turns, and integrates into collectState', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-11-25T08:00:00Z');
  const rows = [
    { v: 1, agent: 'claude', id: 's1', event: 'start', at: '2026-11-25T07:00:00Z', repo: 'app', model: 'claude-opus', sessionId: 's1' },
    { v: 1, agent: 'claude', id: 's1', event: 'heartbeat', at: '2026-11-25T07:01:00Z', repo: 'app', sessionId: 's1' },
    { v: 1, agent: 'claude', id: 's1', event: 'finish', at: '2026-11-25T07:02:00Z', status: 'failed', sessionId: 's1' },
    { v: 1, agent: 'claude', id: 's1', event: 'start', at: '2026-11-25T07:55:00Z', repo: 'app', model: 'claude-opus', sessionId: 's1' },
    { v: 1, agent: 'codex', id: 'c-stale', event: 'start', at: '2026-11-25T07:00:00Z', repo: 'app', sessionId: 'c-stale' },
    { v: 1, agent: 'codex', id: 'c-notify-t1', event: 'finish', at: '2026-11-25T07:58:00Z', repo: 'app', status: 'succeeded', sessionId: 'c-notify' },
  ];
  const workers = cliWorkers(rows, now);
  const byId = Object.fromEntries(workers.map((w) => [w.id, w]));
  assert.equal(byId['claude:s1#1'].status, 'failed');
  assert.equal(byId['claude:s1#1'].elapsedSec, 120);
  assert.equal(byId['claude:s1#2'].status, 'running');
  assert.equal(byId['claude:s1#2'].elapsedSec, 300);
  assert.equal(byId['codex:c-stale'].status, 'dead');
  assert.equal(byId['codex:c-notify-t1'].status, 'succeeded');

  const cliPath = join(dir, 'cli-runs.jsonl');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(cliPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`));
  const state = await collectState({ base: dir, cliPath, now, processes: noProcesses });
  const collected = Object.fromEntries(state.workers.map((w) => [w.id, w]));
  assert.equal(collected['claude:s1#1'].resolved, true);
  assert.equal(collected['claude:s1#2'].resolved, false);
  assert.equal(collected['claude:s1#2'].status, 'running');
  assert.equal(state.sources.cliMissing, false);
});
