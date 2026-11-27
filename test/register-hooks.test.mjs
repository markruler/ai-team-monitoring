/** Cover CLI hook registration: home-relative commands, idempotent appends and untouched existing groups. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addCliHooks, hookCommand, registerFile } from '../tools/register-hooks.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'register-hooks-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('hookCommand writes paths under home as $HOME and keeps others absolute', () => {
  assert.equal(
    hookCommand('claude', { script: '/home/u/repo/tools/cli-hook.mjs', home: '/home/u' }),
    'node "$HOME/repo/tools/cli-hook.mjs" --agent claude',
  );
  assert.equal(
    hookCommand('codex', { script: '/opt/repo/tools/cli-hook.mjs', home: '/home/u' }),
    'node "/opt/repo/tools/cli-hook.mjs" --agent codex',
  );
});

test('addCliHooks appends missing events only and keeps other groups', () => {
  const other = { hooks: [{ type: 'command', command: 'orca-hook' }] };
  const settings = { hooks: { Stop: [other], PostToolUse: [{ hooks: [{ type: 'command', command: 'node x/cli-hook.mjs --agent claude' }] }] } };
  const added = addCliHooks(settings, { command: 'node cli-hook.mjs --agent claude', events: ['UserPromptSubmit', 'PostToolUse', 'Stop'] });
  assert.deepEqual(added, ['UserPromptSubmit', 'Stop']);
  assert.equal(settings.hooks.Stop[0], other);
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.PostToolUse.length, 1);
  // 두 번째 실행은 아무것도 추가하지 않는다.
  assert.deepEqual(addCliHooks(settings, { command: 'node cli-hook.mjs --agent claude', events: ['UserPromptSubmit', 'Stop'] }), []);
});

test('registerFile keeps indentation, is idempotent and skips missing files', async (t) => {
  const home = await tempDir(t);
  const path = join(home, 'settings.json');
  await writeFile(path, '{\n    "model": "x"\n}\n');
  const options = { agent: 'claude', events: ['Stop', 'PostToolUse'], script: join(home, 'repo/tools/cli-hook.mjs'), home };
  assert.deepEqual(await registerFile(path, options), ['Stop', 'PostToolUse']);
  const text = await readFile(path, 'utf8');
  assert.match(text, /^\{\n {4}"model"/);
  const settings = JSON.parse(text);
  assert.equal(settings.model, 'x');
  assert.deepEqual(settings.hooks.PostToolUse[0], {
    matcher: '*',
    hooks: [{ type: 'command', command: 'node "$HOME/repo/tools/cli-hook.mjs" --agent claude', timeout: 5 }],
  });
  assert.deepEqual(await registerFile(path, options), []);
  assert.equal(await readFile(path, 'utf8'), text);
  assert.equal(await registerFile(join(home, 'missing.json'), options), null);
});
