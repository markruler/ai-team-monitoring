/** Completion and blocker regressions use only synthetic repositories and isolated state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { completionFlags, completionEvidence } from '../tools/completion.mjs';
import { collectState, readOnlySucceeded, awaitingFlags, inboxView } from '../server.mjs';

const head = 'a'.repeat(40);
const target = 'b'.repeat(40);
const now = Date.parse('2026-11-25T06:00:00Z');
const record = { id: 'worker', repo: 'synthetic', repoDir: '/fake/personal', issue: 'AIMON-36', status: 'succeeded',
  _status: 'succeeded', startedAt: now - 2400000, finishedAt: now - 1860000, postCheck: { head } };

/** Assert the normal awaiting and inbox builders both discard completed workers without acknowledgments. */
function assertGone(records, completed) {
  const inbox = new Map(records.map((row) => [row.id, { ...row, workerId: row.id, owner: 'Owner' }]));
  const awaiting = awaitingFlags(records, { completed, inbox, now });
  assert.equal([...awaiting.values()].filter(Boolean).length, 0);
  assert.equal(inboxView(records, { completed, inbox, awaiting, now }).pending.length, 0);
}

test('reachable worker commit without ack disappears and target lookup is cached per repository', async () => {
  const calls = [];
  const git = async (repo, args) => {
    calls.push(args);
    return args[0] === 'rev-parse' ? target : args[0] === 'merge-base' ? '' : null;
  };
  const records = [record, { ...record, id: 'other', issue: 'AIMON-37' }];
  assertGone(records, await completionFlags(records, { git }));
  assert.equal(calls.filter(([command]) => command === 'rev-parse').length, 1);
  assert.equal(calls.filter(([command]) => command === 'merge-base').length, 1);
});

test('equivalent patch completes a worker; company ref falls back to origin/main', async () => {
  const refs = [];
  const git = async (repo, args, input) => {
    if (args[0] === 'rev-parse') {
      refs.push(args[2]);
      return args[2].includes('develop') ? null : target;
    }
    if (args[0] === 'merge-base') return null;
    if (args[0] === 'show') return 'worker diff';
    if (args[0] === 'log') return 'target diff';
    if (args[0] === 'patch-id') return `same-patch ${input.includes('worker') ? head : target}`;
    return null;
  };
  const records = [{ ...record, repoDir: '/fake/work/synthetic' }];
  assertGone(records, await completionFlags(records, { git, home: '/fake' }));
  assert.deepEqual(refs, ['refs/remotes/origin/develop^{commit}', 'refs/remotes/origin/main^{commit}']);
});

test('company develop is preferred; unrelated patches and missing refs remain pending', async () => {
  const refs = [];
  const git = async (repo, args, input) => {
    if (args[0] === 'rev-parse') { refs.push(args[2]); return target; }
    if (args[0] === 'merge-base') return null;
    if (args[0] === 'show') return 'worker';
    if (args[0] === 'log') return 'target';
    return input;
  };
  const records = [{ ...record, repoDir: '/fake/work/synthetic' }];
  assert.equal((await completionFlags(records, { git, home: '/fake' })).get(record.id), false);
  assert.deepEqual(refs, ['refs/remotes/origin/develop^{commit}']);
  assert.equal((await completionFlags(records, { git: async () => null })).get(record.id), false);
});

test('read-only success, a successful rerun and harness doneBy need no git query', async () => {
  const git = async () => assert.fail('completion evidence must precede git');
  const ro = { ...record, mode: 'read-only' };
  assertGone([ro], await completionFlags([ro], { git, readOnlySucceeded }));
  const failed = { ...record, status: 'failed', _status: 'failed' };
  const next = { ...record, id: 'next', startedAt: now - 10000, status: 'done', _status: 'done' };
  const evidence = new Map([['next', { doneBy: 'read-only' }]]);
  assertGone([failed, next], await completionFlags([failed, next], { git, evidence }));
  assertGone([record], await completionFlags([record], { git, evidence: new Map([[record.id, { doneBy: 'merged' }]]) }));
});

test('waiting file accepts all three shapes, ignores broken data and escalation takes precedence', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'completion-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const value of [
    { workers: { worker: { blocker: 'conflict', detail: '충돌 해결 필요' } } },
    { worker: { blocker: 'conflict', detail: '충돌 해결 필요' } },
    [{ workerId: 'worker', blocker: 'conflict', detail: '충돌 해결 필요' }],
  ]) {
    await writeFile(join(base, 'waiting.json'), JSON.stringify(value));
    assert.deepEqual((await completionEvidence(base)).get('worker'), { blocker: 'conflict', detail: '충돌 해결 필요' });
  }
  await writeFile(join(base, 'escalations.json'), JSON.stringify({ entries: [{ key: 'worker', doneBy: 'merged', blocker: 'user-approval', detail: '승인 필요' }] }));
  assert.equal((await completionEvidence(base)).get('worker').doneBy, 'merged');
  assert.equal((await completionEvidence(base)).get('worker').detail, '승인 필요');
  await writeFile(join(base, 'waiting.json'), '{broken');
  await writeFile(join(base, 'escalations.json'), 'null');
  assert.equal((await completionEvidence(base)).size, 0);
});

test('collection removes doneBy workers and exposes sanitized one-line blocker detail', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'completion-state-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rows = [record, { ...record, id: 'done', issue: 'AIMON-37' }];
  for (const row of rows) {
    const dir = join(base, 'local-workers', row.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'record.json'), JSON.stringify({ ...row, repoDir: undefined, postCheck: undefined }));
  }
  await mkdir(join(base, 'inbox'));
  await writeFile(join(base, 'inbox/owner.jsonl'), rows.map((row) => JSON.stringify({ ...row, schema: 'agent-orchestration.inbox/v1', workerId: row.id })).join('\n') + '\n');
  await writeFile(join(base, 'waiting.json'), JSON.stringify({ workers: { worker: { blocker: 'test-failure', detail: '테스트\n실패 token=synthetic' }, done: { doneBy: 'merged' } } }));
  const state = await collectState({ base, now, processes: async () => [] });
  assert.deepEqual(state.inbox.pending.map((row) => row.workerId), ['worker']);
  const awaiting = state.workers.find((row) => row.id === 'worker').awaiting;
  assert.equal(awaiting.blocker, 'test-failure');
  assert.match(awaiting.detail, /테스트실패/);
  assert.doesNotMatch(awaiting.detail, /synthetic|\n/);
  assert.equal(state.workers.find((row) => row.id === 'done').resolved, true);
});

test('unknown reasons are orange after 11 minutes, red after 31, and failures count once', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const context = { matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null },
    document: { documentElement: { dataset: {} }, addEventListener() {}, createElement: () => ({ setAttribute() {} }) } };
  runInNewContext(source, context);
  for (const [minutes, status, expectedClass, count] of [[11, 'succeeded', 'orange', 0], [31, 'succeeded', 'red', 1], [31, 'failed', 'red', 1]]) {
    const worker = { id: 'worker', status, awaiting: { ageSec: minutes * 60, detail: '이유 없음', owner: 'Owner' } };
    context.worker = worker;
    const text = runInNewContext('pendingHandoffText(worker)', context);
    assert.match(text, /이유 없음/);
    context.text = text;
    assert.match(runInNewContext('attentionItem(text, worker).className', context), new RegExp(`attention-${expectedClass}`));
    assert.equal(runInNewContext('currentAlerts({ workers: [worker] }).length', context), count);
    assert.equal(runInNewContext('attentionItems({ workers: [worker] }).length', context), 1);
  }
});

test('a new snapshot observes a changed target SHA instead of reusing stale completion', async () => {
  let ref = target;
  const git = async (repo, args) => {
    if (args[0] === 'rev-parse') return ref;
    if (args[0] === 'merge-base') return args.at(-1) === target ? '' : null;
    return null;
  };
  assert.equal((await completionFlags([record], { git })).get(record.id), true);
  ref = 'c'.repeat(40);
  assert.equal((await completionFlags([record], { git })).get(record.id), false);
});

test('missing or corrupt waiting state is ignored; valid blocker codes survive escalation output', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'completion-evidence-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.equal((await completionEvidence(base)).size, 0);
  await writeFile(join(base, 'waiting.json'), '{broken');
  assert.equal((await completionEvidence(base)).size, 0);
  await writeFile(join(base, 'waiting.json'), JSON.stringify({ worker: { blocker: 'conflict', detail: '이전 이유' } }));
  const codes = ['prerequisite-branch', 'user-approval', 'conflict', 'test-failure', 'failure'];
  await writeFile(join(base, 'escalations.jsonl'), [
    JSON.stringify({ key: 'worker', blocker: 'user-approval', detail: '승인 필요', doneBy: 'successor' }),
    ...codes.map((blocker) => JSON.stringify({ workerId: blocker, blocker, detail: '대기 이유' })),
    JSON.stringify({ workerId: 'unknown', blocker: 'arbitrary' }), '{broken', '',
  ].join('\n'));
  const evidence = await completionEvidence(base);
  assert.deepEqual(evidence.get('worker'), { blocker: 'user-approval', detail: '승인 필요', doneBy: 'successor' });
  for (const code of codes) assert.equal(evidence.get(code).blocker, code);
  assert.equal(evidence.get('unknown').blocker, undefined);
});
