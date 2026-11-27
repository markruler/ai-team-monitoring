/** Append the monitoring CLI hook to Claude Code and Codex hook settings without touching existing groups. */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOK_SCRIPT = fileURLToPath(new URL('./cli-hook.mjs', import.meta.url));

export const HOOK_TARGETS = [
  { file: '.claude/settings.json', agent: 'claude', events: ['UserPromptSubmit', 'PostToolUse', 'Stop', 'StopFailure', 'SessionEnd'] },
  { file: '.codex/hooks.json', agent: 'codex', events: ['UserPromptSubmit', 'PostToolUse', 'Stop'] },
];

/** Build the hook command, writing a path under the home directory as "$HOME/..." so settings carry no user name. */
export function hookCommand(agent, { script = HOOK_SCRIPT, home = homedir() } = {}) {
  const rel = relative(home, script);
  const path = rel && !rel.startsWith('..') && !isAbsolute(rel) ? `$HOME/${rel}` : script;
  return `node "${path}" --agent ${agent}`;
}

/** Add one hook group per missing event; events that already run cli-hook.mjs are left alone. Returns added events. */
export function addCliHooks(settings, { command, events }) {
  settings.hooks ??= {};
  const added = [];
  for (const event of events) {
    const groups = settings.hooks[event] ??= [];
    const present = groups.some((group) => group.hooks?.some((item) => item.command?.includes('cli-hook.mjs')));
    if (present) continue;
    groups.push({
      ...(event === 'PostToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command, timeout: 5 }],
    });
    added.push(event);
  }
  return added;
}

/** Register hooks in one settings file, keeping its indentation; a missing file means the CLI is not installed. */
export async function registerFile(path, { agent, events, script = HOOK_SCRIPT, home = homedir() }) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const settings = text.trim() ? JSON.parse(text) : {};
  const added = addCliHooks(settings, { command: hookCommand(agent, { script, home }), events });
  if (!added.length) return added;
  const indent = /^\{\n(\s+)"/.exec(text)?.[1] ?? '  ';
  await writeFile(path, `${JSON.stringify(settings, null, indent)}\n`);
  return added;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const home = homedir();
    for (const { file, agent, events } of HOOK_TARGETS) {
      const added = await registerFile(join(home, file), { agent, events, home });
      const status = added === null ? 'skipped (file not found)' : `added: ${added.join(', ') || '(already present)'}`;
      console.log(`~/${file} ${status}`);
    }
  } catch (error) {
    console.error(`Hook registration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
