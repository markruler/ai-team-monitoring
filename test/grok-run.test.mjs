/** Verify strict lifecycle metadata and the real append-only CLI entry point. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendGrokRun, parseGrokArgs, validateGrokEvent } from '../tools/grok-run.mjs';

const at = '2026-11-25T04:00:00Z';
const args = ['start', '--id', 'run-1', '--bot', 'Engineering Owner', '--task', 'Fix intervals', '--issue', 'AUTOISSUE-7'];

test('CLI validates exact flags, required metadata, caps, controls and finish status', () => {
  assert.equal(parseGrokArgs(args, at).issue, 'AUTOISSUE-7');
  assert.equal(parseGrokArgs(['finish', '--id', 'run-1', '--status', 'canceled'], at).status, 'canceled');
  for (const invalid of [[], ['start'], [...args, '--message', 'private'], [...args, '--id', 'duplicate'],
    [...args, '--task'], ['finish', '--id', 'r', '--status', 'running'],
    ['finish', '--id', 'r', '--status', 'failed', '--bot', 'x']]) {
    assert.throws(() => parseGrokArgs(invalid, at));
  }
  const row = parseGrokArgs(args, at);
  assert.equal(validateGrokEvent({ ...row, at: '2026-11-25T13:00:00.1+09:00' }).id, 'run-1');
  for (const [key, value] of [['id', 'x'.repeat(129)], ['bot', 'x'.repeat(81)], ['task', 'x'.repeat(201)], ['issue', 'x'.repeat(65)],
    ['task', ''], ['task', 'line\nbreak'], ['at', 'yesterday'], ['at', '2026-02-30T04:00:00Z'], ['v', 2]]) {
    assert.throws(() => validateGrokEvent({ ...row, [key]: value }));
  }
  assert.throws(() => validateGrokEvent({ ...row, message: 'private' }));
});

test('real CLI honors environment override and preserves prior bytes; rejection appends nothing', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'grok-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, 'runs.jsonl');
  await writeFile(path, 'existing\n');
  const options = { env: { ...process.env, GROK_RUNS_JSONL: path }, stdio: 'pipe' };
  execFileSync(process.execPath, ['tools/grok-run.mjs', ...args], options);
  execFileSync(process.execPath, ['tools/grok-run.mjs', 'finish', '--id', 'run-1', '--status', 'succeeded'], options);
  const before = await readFile(path, 'utf8');
  const lines = before.trimEnd().split('\n');
  assert.equal(lines[0], 'existing');
  assert.equal(validateGrokEvent(JSON.parse(lines[1])).bot, 'Engineering Owner');
  assert.equal(validateGrokEvent(JSON.parse(lines[2])).status, 'succeeded');
  assert.throws(() => execFileSync(process.execPath, ['tools/grok-run.mjs', ...args, '--message', 'secret'], options));
  await assert.rejects(appendGrokRun(['finish', '--id', 'r', '--status', 'bad'], { path }));
  assert.equal(await readFile(path, 'utf8'), before);
  await appendGrokRun(args, { path: join(base, 'nested', 'runs.jsonl'), at });
  assert.equal(JSON.parse(await readFile(join(base, 'nested', 'runs.jsonl'), 'utf8')).at, at);
});
