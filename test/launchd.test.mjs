/** Cover macOS launchd LaunchAgent plist rendering and CLI argument validation. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LABEL, parseLaunchdArgs, parsePortOption, renderPlist } from '../tools/launchd.mjs';

test('renderPlist generates valid KeepAlive LaunchAgent XML with escaped paths and port', () => {
  const xml = renderPlist({
    nodePath: '/usr/local/bin/node',
    repoDir: '/Users/dev/ai-team-monitoring',
    home: '/Users/dev',
    port: 4317,
    logPath: '/Users/dev/logs/server.log',
  });
  assert.match(xml, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/Users\/dev\/ai-team-monitoring\/server\.mjs<\/string>/);
  assert.match(xml, /<string>--port<\/string><string>4317<\/string>/);
  // 서버·adapter 코드를 고치면 서비스가 재설치 없이 다시 시작되도록 --watch로 실행한다.
  assert.match(xml, /<string>--watch<\/string>\s*<string>[^<]*server\.mjs<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.match(xml, /<key>StandardOutPath<\/key><string>\/Users\/dev\/logs\/server\.log<\/string>/);
});

test('launchd CLI argument and port parsing rejects invalid values', () => {
  assert.deepEqual(parseLaunchdArgs(['install']), { command: 'install', port: 4317 });
  assert.deepEqual(parseLaunchdArgs(['print', '--port', '4400']), { command: 'print', port: 4400 });
  assert.equal(parsePortOption('4317'), 4317);
  assert.throws(() => parsePortOption('0'));
  assert.throws(() => parsePortOption('70000'));
  assert.throws(() => parsePortOption('abc'));
  assert.throws(() => parseLaunchdArgs(['bogus']));
  assert.throws(() => parseLaunchdArgs(['install', '--unknown']));
});
