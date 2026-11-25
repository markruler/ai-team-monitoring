/** Failure classification, task naming, step keys and untracked process parsing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentCommand,
  classifyFailure,
  classifyText,
  collectState,
  etimeSeconds,
  logTail,
  parseLsofCwd,
  parsePs,
  probeProcesses,
  reasonLabel,
  shortPath,
  specTitle,
  taskSummary,
  stepName,
  untrackedFromPs,
} from '../server.mjs';

const now = Date.parse('2026-11-25T04:00:00Z');
const NO_REASON = '사유 기록 없음 (이전 런처 기록)';
const noProcesses = async () => [];

/** Make an isolated worker state directory. */
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'agent-failure-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'local-workers'));
  return base;
}

/** Write one worker record folder with optional extra files. */
async function writeWorker(base, id, record, files = {}) {
  const dir = join(base, 'local-workers', id);
  await mkdir(dir);
  await writeFile(join(dir, 'record.json'), JSON.stringify({ id, ...record }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

test('preflight immediately followed by failed reads as a preflight rejection', () => {
  // lw-20261124T092731-60z7a5: no exitCode, no logs, both steps in the same millisecond.
  const at = '2026-11-24T09:27:31.123Z';
  const result = classifyFailure({ status: 'failed', steps: [{ name: 'preflight', at }, { name: 'failed', at }] });
  assert.equal(result.label, '사전 점검 거부');
  assert.equal(result.code, 'preflight-rejected');
  const withError = classifyFailure({ status: 'failed', error: 'repo-missing: repo', steps: [{ name: 'preflight', at }, { name: 'failed', at }] });
  assert.equal(withError.label, '사전 점검 거부: 저장소 경로 없음: repo');
});

test('recorded reasons win in order: postCheck, reason, failureReason, error, spawnError', () => {
  const steps = [{ name: 'preflight', at: 1 }, { name: 'failed', at: 2 }];
  assert.equal(classifyFailure({ postCheck: { reasons: ['no-commits', 'dirty'] }, reason: 'timeout', steps }).label, '커밋 없음, 작업 트리 미정리');
  assert.equal(classifyFailure({ reason: 'lost-heartbeat', failureReason: 'timeout' }).label, '하트비트 손실 (60초 초과)');
  assert.equal(classifyFailure({ failureReason: 'repeat-failure-blocked', spawnError: 'x' }).label, '동일 사유 재실패로 자동 재실행 차단');
  assert.equal(classifyFailure({ spawnError: 'spawn codex ENOENT' }).label, '파일 또는 명령 없음 (ENOENT): spawn codex ENOENT');
  assert.equal(classifyFailure({ reason: 'custom-launcher-key' }).label, 'custom-launcher-key');
});

test('killed reasons include the signal and who/why when recorded', () => {
  assert.equal(reasonLabel('SIGTERM'), '강제 종료 (SIGTERM)');
  assert.equal(classifyFailure({ status: 'killed', reason: 'SIGTERM', signal: 'SIGTERM', spawnError: 'SIGTERM' }).label, '강제 종료 (SIGTERM)');
  assert.equal(classifyFailure({ reason: 'killed', killedBy: 'coordinator', killReason: 'superseded', signal: 'SIGKILL' }).label,
    '강제 종료 (killedBy=coordinator, killReason=superseded, SIGKILL)');
  assert.equal(classifyFailure({ status: 'killed', signal: 'SIGTERM' }).label, '강제 종료 (SIGTERM)');
  assert.equal(classifyFailure({}, { status: 'killed' }).label, '강제 종료');
});

test('launcher killedBy objects show their classification, never [object Object]', () => {
  const killedBy = { classification: 'parent-session-ended', signal: 'SIGTERM', senderPid: null, ppidAtStart: 10, ppidAtSignal: 1, target: 'agent' };
  const killed = classifyFailure({ status: 'killed', reason: 'killed', signal: 'SIGTERM', killedBy });
  assert.equal(killed.label, '강제 종료 (parent-session-ended, SIGTERM)');
  assert.equal(killed.code, 'killed');
  assert.equal(classifyFailure({ status: 'killed', reason: 'killed', killedBy: { classification: 'interrupted', signal: 'SIGINT' } }).label,
    '강제 종료 (interrupted, SIGINT)');
  assert.equal(classifyFailure({ status: 'killed', signal: 'SIGTERM', killedBy: { classification: 'external-signal' } }).label,
    '강제 종료 (external-signal, SIGTERM)');
  assert.equal(classifyFailure({ status: 'killed', reason: 'killed', signal: 'SIGTERM', killedBy: { senderPid: 5 } }).label, '강제 종료 (SIGTERM)');
  assert.equal(classifyFailure({ status: 'killed', reason: 'SIGTERM', killedBy }).label, '강제 종료 (parent-session-ended, SIGTERM)');
  assert.equal(classifyFailure({ status: 'killed', reason: 'SIGTERM', killedBy: 'coordinator' }).label, '강제 종료 (killedBy=coordinator, SIGTERM)');
});

test('reasonDetail is appended to the recorded label without repeating it', () => {
  assert.equal(classifyFailure({ status: 'failed', reason: 'lost-heartbeat', reasonDetail: 'no heartbeat for 95s' }).label,
    '하트비트 손실 (60초 초과): no heartbeat for 95s');
  assert.equal(classifyFailure({ status: 'failed', reason: 'lost-heartbeat', reasonDetail: '하트비트 손실 (60초 초과)' }).label,
    '하트비트 손실 (60초 초과)');
  assert.equal(classifyFailure({ status: 'killed', reason: 'killed', signal: 'SIGTERM', killedBy: { classification: 'parent-session-ended' },
    reasonDetail: 'parent-session-ended' }).label, '강제 종료 (parent-session-ended, SIGTERM)');
  assert.equal(classifyFailure({ status: 'failed', reasonDetail: 'detail only' }).label, NO_REASON);
});

test('sparse failed record (akrywk style) shows its reconciled reason', () => {
  assert.equal(classifyFailure({ status: 'failed', reason: 'process-dead' }).label, '프로세스 종료 감지 (process-dead)');
  assert.equal(classifyFailure({ status: 'failed', reconciled: { reason: 'process-dead' } }).label, '프로세스 종료 감지 (process-dead)');
  assert.equal(classifyFailure({ status: 'running' }, { status: 'dead' }).label, '프로세스 종료 감지 (process-dead)');
});

test('without any evidence the label says the launcher left no reason', () => {
  assert.equal(classifyFailure({ status: 'failed' }).label, NO_REASON);
  assert.equal(classifyFailure({ status: 'failed', steps: [{ name: 'failed', at: 1 }] }).label, NO_REASON);
});

test('log tail patterns classify known failures', () => {
  for (const [text, label] of [
    ['agent-task-rejected: missing approval', '작업 거부 (agent-task-rejected): missing approval'],
    ['error: missing issue key in commit subject', '이슈 키 누락'],
    ['open /x: EACCES', '권한 거부'],
    ['fatal: Operation not permitted (EPERM)', '권한 거부'],
    ['post-check: no commits on branch', '커밋 없음'],
    ['process received SIGKILL', '강제 종료 (SIGKILL)'],
    ['request timed out after 600s', '시간 초과'],
    ['spawn agy ENOENT', '파일 또는 명령 없음 (ENOENT)'],
    ['Usage: agent-task worker start', '명령 사용법 오류 (usage)'],
  ]) {
    assert.equal(classifyText(text)?.label, label, text);
    assert.equal(classifyFailure({ status: 'failed' }, { stderr: `noise\n${text}\n` }).label, label, text);
  }
  assert.equal(classifyText('all good'), null);
});

test('log tail keeps the last five redacted lines of stderr, else stdout, 200 chars each', () => {
  const stderr = ['1', '2', '', '3', '4', '5', `6 token=abc user@example.com ${'x'.repeat(300)}`].join('\n');
  const tail = logTail(stderr, 'stdout line');
  assert.equal(tail.length, 5);
  assert.equal(tail[0], '2');
  assert.ok(tail.every((line) => line.length <= 200));
  assert.doesNotMatch(tail.join('\n'), /abc|user@example\.com/);
  assert.deepEqual(logTail('', 'a\nb\n'), ['a', 'b']);
  assert.deepEqual(logTail('', ''), []);
});

test('JSONL agent events never leak message text into the tail or the classification', () => {
  const stdout = [
    JSON.stringify({ type: 'assistant', message: { content: 'agent-task-rejected: PRIVATE_CHAT permission denied' } }),
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'PRIVATE_CHAT' }),
    '',
  ].join('\n');
  assert.deepEqual(logTail('', stdout), ['[json] type=assistant', '[json] type=result subtype=error_max_turns is_error=true']);
  assert.equal(classifyFailure({ status: 'failed' }, { stdout }).label, NO_REASON);
  assert.equal(classifyFailure({ status: 'failed' }, { stdout: 'plain: permission denied\n' }).label, '권한 거부');
  // A JSON line cut by the tail window must not be scanned as plain text.
  const cut = `${JSON.stringify({ type: 'assistant', message: `${'x'.repeat(70000)} killed by PRIVATE_CHAT` })}\n`;
  assert.equal(classifyFailure({ status: 'failed' }, { stdout: cut }).label, NO_REASON);
});

test('step keys stay raw unless they are not short lowercase keys', () => {
  assert.equal(stepName('agent-start'), 'agent-start');
  assert.equal(stepName('custom-step'), 'custom-step');
  for (const value of ['PRIVATE_CHAT', 'has space', undefined, null, 42, 'x'.repeat(40)]) assert.equal(stepName(value), 'unrecognized');
});

test('spec title uses the first markdown heading', () => {
  assert.equal(specTitle('intro\n# 대시보드 실패 상세 #\n## Sub'), '대시보드 실패 상세');
  assert.equal(specTitle('no heading'), '');
});

test('task summary prefers record title, worker branch subject, then an issue heading in the spec', async () => {
  const calls = [];
  const record = { title: 'HARNESS-7 기록 작업', issue: 'HARNESS-7', worktreeBase: 'main', worktree: '/removed-worker', repoDir: '/worker-repo', branch: 'worker-branch' };
  const spec = '\n  일반 텍스트 작업\n# HARNESS-7 뒤의 제목';
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    if (options.cwd === record.worktree) throw new Error('removed worktree');
    return 'HARNESS-7 커밋 작업\n';
  };
  assert.equal(await taskSummary(record, { spec, exec }), record.title);
  assert.equal(calls.length, 0);
  assert.equal(await taskSummary({ ...record, title: ' ' }, { spec, exec }), 'HARNESS-7 커밋 작업');
  assert.deepEqual(calls, [
    { file: 'git', args: ['log', '-1', '--format=%s', 'main..HEAD', '--'], options: { cwd: record.worktree } },
    { file: 'git', args: ['log', '-1', '--format=%s', 'main..refs/heads/worker-branch', '--'], options: { cwd: record.repoDir } },
  ]);
  const missing = async () => { throw new Error('no branch'); };
  assert.equal(await taskSummary({ ...record, title: null }, { spec, exec: missing }), 'HARNESS-7 뒤의 제목');
  assert.equal(await taskSummary({}, { spec: '\n  ## HARNESS-7 스펙 작업\n내용' }), 'HARNESS-7 스펙 작업');
  assert.equal(await taskSummary({ worktree: '/worker', worktreeBase: 'main' }, { exec: async (file, args) => {
    assert.equal(args[3], 'main..HEAD');
    return '워크트리 커밋 작업\n';
  } }), '워크트리 커밋 작업');
  assert.equal(await taskSummary({ ...record, title: '', issue: 'HARNESS-7', prompt: 'PRIVATE_CHAT', message: 'PRIVATE_CHAT' },
    { spec: '\n ', exec: missing }), '');
});

test('task summary skips launcher headings and metadata for the first original issue heading', async () => {
  const spec = [
    '# Local worker spec — HARNESS-23 (agent-orchestration)',
    '',
    '- repository: agent-orchestration',
    '- branch: HARNESS-23-worker',
    '- title: HARNESS-23 launcher metadata',
    '',
    '## Task',
    'HARNESS-23 plain text is not a heading',
    '',
    '  ### HARNESS-24 inbox ack가 원본 제목을 쓴다 ###',
    '# HARNESS-25 뒤의 제목',
  ].join('\r\n');
  assert.equal(await taskSummary({ issue: 'HARNESS-23' }, { spec }), 'HARNESS-24 inbox ack가 원본 제목을 쓴다');
  assert.equal(await taskSummary({ title: '기록 제목' }, { spec }), '기록 제목');
  assert.equal(await taskSummary({ worktree: '/worker', worktreeBase: 'main', issue: 'HARNESS-23' }, {
    spec,
    exec: async () => 'HARNESS-23 워커 커밋 제목\n',
  }), 'HARNESS-23 워커 커밋 제목');
});

test('task summary stays empty without an original issue heading', async () => {
  for (const spec of [
    '# Local worker spec — HARNESS-23 (agent-orchestration)\n\n- repository: agent-orchestration\n## Task\n본문',
    '- repository: HARNESS-23\n# 이슈 키 없는 제목\nHARNESS-23 일반 텍스트',
    '일반 텍스트 작업',
    '',
  ]) {
    assert.equal(await taskSummary({}, { spec }), '');
    assert.equal(await taskSummary({ title: null }, { spec }), '');
    assert.equal(await taskSummary({ title: ' ' }, { spec }), '');
    assert.equal(await taskSummary({ title: '기록 제목' }, { spec }), '기록 제목');
  }
});

test('task summary falls back to the spec when the worker has no own commits', async () => {
  for (const source of [
    { worktree: '/worker' },
    { repoDir: '/worker-repo', branch: 'worker-branch' },
  ]) {
    const ref = source.worktree ? 'HEAD' : 'refs/heads/worker-branch';
    const calls = [];
    const summary = await taskSummary({ ...source, issue: 'AIMON-32', worktreeBase: 'main' }, {
      spec: '# AIMON-32 스펙 작업\n내용',
      exec: async (file, args) => {
        calls.push({ file, args });
        return '';
      },
    });
    assert.deepEqual(calls, [{ file: 'git', args: ['log', '-1', '--format=%s', `main..${ref}`, '--'] }]);
    assert.equal(summary, 'AIMON-32 스펙 작업');
  }
});

test('task summary discards a commit subject belonging to another issue', async () => {
  for (const source of [
    { worktree: '/worker' },
    { repoDir: '/worker-repo', branchName: 'worker-branch' },
  ]) {
    const record = { ...source, issue: 'AIMON-32', worktreeBase: 'main' };
    assert.equal(await taskSummary(record, {
      spec: '# AIMON-32 스펙 작업\n내용',
      exec: async () => 'AIMON-30 다른 이슈 작업\n',
    }), 'AIMON-32 스펙 작업');
    assert.equal(await taskSummary(record, {
      spec: '# AIMON-32 스펙 작업\n내용',
      exec: async () => 'AIMON-32 워커 커밋 작업\n',
    }), 'AIMON-32 워커 커밋 작업');
  }
});

test('task summary skips commit lookup without a worker base', async () => {
  let calls = 0;
  assert.equal(await taskSummary({ worktree: '/worker', issue: 'AIMON-32' }, {
    spec: '# AIMON-32 스펙 작업',
    exec: async () => { calls += 1; return 'AIMON-32 커밋 작업'; },
  }), 'AIMON-32 스펙 작업');
  assert.equal(calls, 0);
});

test('collection uses the original issue heading only for the task summary', async (t) => {
  const base = await fixture(t);
  const dir = join(base, 'local-workers', 'wrapped-spec');
  await writeWorker(base, 'wrapped-spec', {
    issue: 'AIMON-33', status: 'succeeded', startedAt: now - 1000, finishedAt: now,
    specFile: join(dir, 'SPEC.md'),
  }, {
    'SPEC.md': '# Local worker spec — AIMON-33 (ai-team-monitoring)\n\n- repository: ai-team-monitoring\n\n## Task\n\n# AIMON-33 원본 작업 제목\n본문',
  });
  const state = await collectState({ base, now, processes: noProcesses });
  const worker = state.workers.find((worker) => worker.id === 'wrapped-spec');
  assert.equal(worker.title, 'Local worker spec — AIMON-33 (ai-team-monitoring)');
  assert.equal(worker.taskSummary, 'AIMON-33 원본 작업 제목');
});

test('collection adds title, failure, log tail, heartbeat and status-ended last step', async (t) => {
  const base = await fixture(t);
  const dir = join(base, 'local-workers', 'failed-run');
  await writeWorker(base, 'failed-run', { issue: 'AIMON-2', branch: 'b', agent: 'codex', status: 'failed', startedAt: now - 5000,
    heartbeatAt: now - 12000, specFile: join(dir, 'SPEC.md'), logDir: '/etc', steps: [{ name: 'spec', at: now - 4000 }] },
  { 'SPEC.md': '# 실패 상세 작업\nbody', 'stderr.log': 'warn\nError: EACCES: permission denied\n' });
  await writeWorker(base, 'issue-only', { issue: 'AIMON-9', status: 'succeeded', startedAt: now - 1000, finishedAt: now, error: 'PRIVATE_CHAT' });
  await writeWorker(base, 'branch-only', { branch: 'feature-x', status: 'running', startedAt: now - 100000000 });
  const state = await collectState({ base, now, processes: noProcesses });
  const byId = Object.fromEntries(state.workers.map((worker) => [worker.id, worker]));
  const failed = byId['failed-run'];
  assert.equal(failed.title, '실패 상세 작업');
  assert.equal(failed.taskSummary, '');
  assert.equal(failed.failure.label, '권한 거부');
  assert.deepEqual(failed.failure.logTail, ['warn', 'Error: EACCES: permission denied']);
  assert.equal(failed.heartbeatAt, now - 12000);
  assert.equal(failed.steps.at(-1).to, 'failed');
  assert.equal(byId['issue-only'].title, 'AIMON-9');
  assert.equal(byId['issue-only'].taskSummary, '');
  assert.equal(byId['issue-only'].failure, null);
  assert.equal(byId['branch-only'].title, 'feature-x');
  assert.equal(byId['branch-only'].taskSummary, '');
  assert.equal(byId['branch-only'].status, 'dead');
  assert.equal(byId['branch-only'].failure.label, '프로세스 종료 감지 (process-dead)');
  assert.equal(JSON.stringify(state).includes('PRIVATE_CHAT'), false);
  assert.deepEqual(state.untracked, []);
});

test('ps rows parse and agent commands detect exec/-p and interactive CLI while dropping prompts and daemons', () => {
  const ps = [
    '  PID  PPID ELAPSED COMMAND',
    '  101     1   05:01 /opt/homebrew/bin/codex exec --json secret prompt words',
    '  102   101   05:00 /opt/homebrew/lib/codex/codex exec --json secret prompt words',
    '  201     1 1-02:03:04 claude -p write the private plan',
    '  202     1   00:07 node /usr/local/bin/codex exec -',
    '  301     1   10:00 grep claude -p',
    '  302     1   10:00 claude --resume',
    '  303     1   10:00 /usr/local/bin/agy exec task',
    '  304     1   02:15 /opt/homebrew/bin/codex --yolo',
    '  305     1   05:00 /Users/me/.codex/bin/codex app-server --listen unix://',
    '  306     1   05:00 /Users/me/.local/bin/claude --chrome-native-host',
    '  307     1   05:00 claude mcp serve',
    '  308     1   05:00 codex --version',
  ].join('\n');
  assert.equal(parsePs(ps).length, 12);
  assert.equal(etimeSeconds('05:01'), 301);
  assert.equal(etimeSeconds('1-02:03:04'), 93784);
  assert.equal(etimeSeconds('bad'), null);
  assert.deepEqual(agentCommand('claude -p write the private plan'), { binary: 'claude', subcommand: '-p' });
  assert.deepEqual(agentCommand('claude --resume'), { binary: 'claude', subcommand: 'cli' });
  assert.deepEqual(agentCommand('/opt/homebrew/bin/codex --yolo'), { binary: 'codex', subcommand: 'cli' });
  assert.equal(agentCommand('grep claude -p'), null);
  assert.equal(agentCommand('/Users/me/.codex/bin/codex app-server --listen unix://'), null);
  assert.equal(agentCommand('/Users/me/.local/bin/claude --chrome-native-host'), null);
  assert.equal(agentCommand('claude mcp serve'), null);
  assert.equal(agentCommand('codex --version'), null);
  const found = untrackedFromPs(ps, [201]);
  assert.deepEqual(found.map((item) => item.pid), [101, 202, 302, 303, 304]);
  assert.deepEqual(untrackedFromPs(ps, [101, 201, 202, 302, 303, 304]), []);
  assert.doesNotMatch(JSON.stringify(found), /secret|prompt|private|--json|--yolo|--resume/);
});

test('cwd comes from lsof and is shortened to ~', () => {
  assert.equal(parseLsofCwd('p101\nfcwd\nn/Users/me/worktrees/x\n'), '/Users/me/worktrees/x');
  assert.equal(parseLsofCwd(''), null);
  assert.equal(shortPath('/Users/me/worktrees/x', '/Users/me'), '~/worktrees/x');
  assert.equal(shortPath('/Users/meow/x', '/Users/me'), '/Users/meow/x');
});

test('process probe uses ps and lsof on macOS and shows nothing when ps fails', async () => {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'ps') return '  PID  PPID ELAPSED COMMAND\n  700     1   01:00 codex exec do private work\n  701     1   01:00 claude -p hi\n';
    return 'p700\nfcwd\nn/Users/me/wt\n';
  };
  const result = await probeProcesses([701], { platform: 'darwin', exec, home: '/Users/me' });
  assert.deepEqual(result, [{ pid: 700, elapsedSec: 60, binary: 'codex', subcommand: 'exec', cwd: '~/wt', status: 'untracked running' }]);
  assert.deepEqual(calls[0], ['ps', '-axo', 'pid,ppid,etime,command']);
  assert.deepEqual(calls[1], ['lsof', '-a', '-d', 'cwd', '-p', '700', '-Fn']);
  assert.deepEqual(await probeProcesses([], { platform: 'darwin', exec: async () => { throw new Error('EPERM'); } }), []);
  assert.deepEqual(await probeProcesses([], { platform: 'linux', exec }), []);
});

test('collection reads new launcher records: heartbeat liveness, killedBy object, recorded last lines', async (t) => {
  const base = await fixture(t);
  const iso = (ms) => new Date(ms).toISOString();
  // pid is null and launcherPid/agentPid are unused positive PIDs; the fresh heartbeat keeps it running.
  await writeWorker(base, 'new-running', { status: 'running', pid: null, launcherPid: 2147483646, agentPid: 2147483645,
    heartbeatAt: iso(now - 15000), startedAt: iso(now - 60000) });
  await writeWorker(base, 'new-stale', { status: 'running', pid: null, heartbeatAt: iso(now - 61000), startedAt: iso(now - 120000) });
  await writeWorker(base, 'new-killed', { status: 'killed', reason: 'killed', signal: 'SIGTERM', startedAt: iso(now - 5000),
    killedBy: { classification: 'parent-session-ended', signal: 'SIGTERM', senderPid: null, ppidAtStart: 10, ppidAtSignal: 1, target: 'agent' },
    lastStderr: ['recorded err token=abc'], lastStdout: ['recorded out'] },
  { 'stderr.log': 'FILE_STDERR\n' });
  await writeWorker(base, 'new-heartbeat', { status: 'failed', reason: 'lost-heartbeat', reasonDetail: 'no heartbeat for 95s', startedAt: iso(now - 5000),
    lastStderr: [], lastStdout: ['o1', 'o2'] },
  { 'stderr.log': 'FILE_STDERR\n' });
  const state = await collectState({ base, now, processes: noProcesses });
  const byId = Object.fromEntries(state.workers.map((worker) => [worker.id, worker]));
  assert.equal(byId['new-running'].status, 'running');
  assert.equal(byId['new-running'].failure, null);
  assert.equal(byId['new-stale'].status, 'dead');
  assert.equal(byId['new-stale'].failure.code, 'lost-heartbeat');
  assert.equal(byId['new-stale'].failure.label, '하트비트 손실 (60초 초과)');
  assert.equal(byId['new-stale'].heartbeatStale, true);
  assert.equal(byId['new-stale'].heartbeatAgeSec, 61);
  assert.equal(byId['new-killed'].failure.label, '강제 종료 (parent-session-ended, SIGTERM)');
  assert.deepEqual(byId['new-killed'].failure.logTail, ['recorded err [secret]']);
  assert.equal(byId['new-heartbeat'].failure.label, '하트비트 손실 (60초 초과): no heartbeat for 95s');
  assert.deepEqual(byId['new-heartbeat'].failure.logTail, ['o1', 'o2']);
  assert.equal(JSON.stringify(state).includes('[object Object]'), false);
  assert.equal(JSON.stringify(state).includes('FILE_STDERR'), false);
});

test('collection keeps legacy records: pid-only liveness, string killedBy and file logs', async (t) => {
  const base = await fixture(t);
  await writeWorker(base, 'old-running', { status: 'running', pid: process.pid, heartbeatAt: now - 3600000, startedAt: now - 3600000 });
  await writeWorker(base, 'old-killed', { status: 'killed', reason: 'SIGTERM', killedBy: 'coordinator', startedAt: now - 5000 },
    { 'stderr.log': 'file err\n', 'stdout.log': 'file out\n' });
  await writeWorker(base, 'old-empty-arrays', { status: 'failed', reason: 'timeout', startedAt: now - 5000, lastStderr: [], lastStdout: [] },
    { 'stderr.log': 'from file\n' });
  const state = await collectState({ base, now, processes: noProcesses });
  const byId = Object.fromEntries(state.workers.map((worker) => [worker.id, worker]));
  assert.equal(byId['old-running'].status, 'running');
  assert.equal(byId['old-killed'].failure.label, '강제 종료 (killedBy=coordinator, SIGTERM)');
  assert.deepEqual(byId['old-killed'].failure.logTail, ['file err']);
  assert.deepEqual(byId['old-empty-arrays'].failure.logTail, ['from file']);
});

test('collection passes every recorded PID to the process probe', async (t) => {
  const base = await fixture(t);
  await writeWorker(base, 'a', { status: 'succeeded', agentPid: 11, launcherPid: 12, startedAt: now, finishedAt: now });
  await writeWorker(base, 'b', { status: 'succeeded', pid: 13, startedAt: now, finishedAt: now });
  let seen;
  const state = await collectState({ base, now, processes: async (pids) => { seen = pids; return [{ pid: 99, binary: 'codex', subcommand: 'exec', cwd: '~', elapsedSec: 1, status: 'untracked running' }]; } });
  assert.deepEqual([...seen].sort(), [11, 12, 13]);
  assert.equal(state.untracked.length, 1);
  assert.equal(state.workers.length, 2);
  const broken = await collectState({ base, now, processes: async () => { throw new Error('ps failed'); } });
  assert.deepEqual(broken.untracked, []);
});

test('a live worker past the 60s heartbeat threshold is stale with its age; a fresh heartbeat is not', async (t) => {
  const base = await fixture(t);
  const iso = (ms) => new Date(ms).toISOString();
  // This test process is alive, so both workers stay running regardless of heartbeat age.
  await writeWorker(base, 'stale', { status: 'running', launcherPid: process.pid, heartbeatAt: iso(now - 90000), startedAt: iso(now - 600000) });
  await writeWorker(base, 'fresh', { status: 'starting', launcherPid: process.pid, heartbeatAt: iso(now - 60000), startedAt: iso(now - 600000) });
  await writeWorker(base, 'ended', { status: 'succeeded', heartbeatAt: iso(now - 3600000), startedAt: iso(now - 7200000), finishedAt: iso(now - 3600000) });
  const state = await collectState({ base, now, processes: noProcesses });
  const byId = Object.fromEntries(state.workers.map((worker) => [worker.id, worker]));
  assert.equal(byId.stale.status, 'running');
  assert.equal(byId.stale.heartbeatStale, true);
  assert.equal(byId.stale.heartbeatAgeSec, 90);
  assert.equal(byId.stale.failure, null);
  assert.equal(byId.fresh.status, 'running');
  assert.equal(byId.fresh.heartbeatStale, false);
  assert.equal(byId.fresh.heartbeatAgeSec, 60);
  assert.equal(byId.ended.heartbeatStale, false);
});

test('post-check and recorded reason codes stay visible as raw codes next to Korean labels without chat text', async (t) => {
  const base = await fixture(t);
  const chat = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'CHAT_BODY_SECRET' }] } });
  await writeWorker(base, 'post-check', { status: 'failed', startedAt: now - 5000, finishedAt: now,
    postCheck: { decision: 'fail', reasons: ['foreign-identity', 'dirty-worktree', 'git-failed: from-ref', 'no-commits'] } },
  { 'stdout.log': `${chat}\n`, 'stderr.log': 'PROMPT_TEXT_SECRET\n' });
  await writeWorker(base, 'from-ref', { status: 'failed', reason: 'from-ref', startedAt: now - 5000, finishedAt: now });
  await writeWorker(base, 'prose', { status: 'failed', reason: 'model said CHAT_BODY_SECRET', startedAt: now - 5000, finishedAt: now });
  const state = await collectState({ base, now, processes: noProcesses });
  const byId = Object.fromEntries(state.workers.map((worker) => [worker.id, worker]));
  const failure = byId['post-check'].failure;
  assert.equal(failure.label, 'foreign-identity, 작업 트리 미정리, git 명령 실패: from-ref, 커밋 없음');
  assert.deepEqual(failure.codes, ['foreign-identity', 'dirty-worktree', 'git-failed: from-ref', 'no-commits']);
  assert.deepEqual(byId['post-check'].postCheck.reasons, ['foreign-identity', 'dirty-worktree', 'no-commits']);
  assert.equal(byId['from-ref'].failure.label, 'from-ref');
  assert.deepEqual(byId['from-ref'].failure.codes, ['from-ref']);
  assert.deepEqual(byId.prose.failure.codes, []);
  assert.equal(JSON.stringify(byId['post-check']).includes('CHAT_BODY_SECRET'), false);
  const reasons = JSON.stringify(state.workers.map((worker) => [worker.failure.label, worker.failure.codes, worker.postCheck]));
  assert.doesNotMatch(reasons, /PROMPT_TEXT_SECRET|undefined|기타/);
});
