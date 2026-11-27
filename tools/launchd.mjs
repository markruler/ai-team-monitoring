#!/usr/bin/env node
/** Install, inspect or uninstall the macOS launchd LaunchAgent for ai-team-monitoring. */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'com.markruler.ai-team-monitoring';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Escape XML special characters for plist string elements. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Validate a TCP port number in 1..65535. */
export function parsePortOption(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) throw new Error(`Invalid port: ${raw}`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`Port out of range: ${port}`);
  return port;
}

/** Render a launchd LaunchAgent plist bound to loopback with KeepAlive, restarting itself when server code changes. */
export function renderPlist({
  label = LABEL,
  nodePath = process.execPath,
  repoDir = ROOT,
  home = homedir(),
  port = 4317,
  logPath = join(home, 'agent-orchestration-jobs/ai-team-monitoring/server.log'),
} = {}) {
  const validPort = parsePortOption(port);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>--watch</string>
    <string>${xmlEscape(join(repoDir, 'server.mjs'))}</string>
    <string>--port</string><string>${validPort}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(repoDir)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${xmlEscape(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

/** Parse CLI arguments for install / uninstall / status / print. */
export function parseLaunchdArgs(argv) {
  const [command, ...rest] = argv;
  if (!['install', 'uninstall', 'status', 'print'].includes(command)) {
    throw new Error('Usage: node tools/launchd.mjs <install|uninstall|status|print> [--port 4317]');
  }
  let port = 4317;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--port') {
      port = parsePortOption(rest[++index]);
    } else {
      throw new Error(`Unknown option: ${rest[index]}`);
    }
  }
  return { command, port };
}

function runLaunchctl(args) {
  return new Promise((resolve, reject) => {
    execFile('launchctl', args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const { command, port } = parseLaunchdArgs(process.argv.slice(2));
  const home = homedir();
  const plistPath = join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
  const logPath = join(home, 'agent-orchestration-jobs/ai-team-monitoring/server.log');
  const domain = `gui/${process.getuid?.() ?? 501}`;

  if (command === 'print') {
    process.stdout.write(renderPlist({ home, port, logPath }));
    return;
  }
  if (command === 'status') {
    const installed = await readFile(plistPath, 'utf8').then(() => true, () => false);
    let loaded = false;
    try {
      await runLaunchctl(['print', `${domain}/${LABEL}`]);
      loaded = true;
    } catch { loaded = false; }
    console.log(JSON.stringify({ label: LABEL, plistPath, installed, loaded }, null, 2));
    return;
  }
  if (command === 'uninstall') {
    try { await runLaunchctl(['bootout', `${domain}/${LABEL}`]); } catch { /* already unloaded */ }
    await rm(plistPath, { force: true });
    console.log(`Uninstalled ${LABEL} (${plistPath})`);
    return;
  }
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(plistPath, renderPlist({ home, port, logPath }), { mode: 0o644 });
  try { await runLaunchctl(['bootout', `${domain}/${LABEL}`]); } catch { /* not loaded yet */ }
  await runLaunchctl(['bootstrap', domain, plistPath]);
  await runLaunchctl(['kickstart', '-k', `${domain}/${LABEL}`]);
  console.log(`Installed and started ${LABEL} on http://127.0.0.1:${port} (${plistPath})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
