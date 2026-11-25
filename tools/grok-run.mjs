/** Append minimal, validated Grok lifecycle metadata without message content. */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Validate the exact event schema, bounded metadata and ISO timestamp. */
export function validateGrokEvent(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid event');
  const start = row.event === 'start';
  const allowed = start ? ['v', 'id', 'event', 'at', 'bot', 'task', 'issue'] : ['v', 'id', 'event', 'at', 'status'];
  if (Object.keys(row).some((key) => !allowed.includes(key)) || row.v !== 1 || !['start', 'finish'].includes(row.event)) throw new Error('Invalid event fields');
  for (const [key, limit] of [['id', 128], ...(start ? [['bot', 80], ['task', 200], ...(row.issue !== undefined ? [['issue', 64]] : [])] : [])]) {
    if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > limit || /[\x00-\x1f\x7f]/.test(row[key])) throw new Error(`Invalid ${key}`);
  }
  const iso = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const instant = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
  if (!iso.test(row.at) || !Number.isFinite(instant) || instant < 0) throw new Error('Invalid at');
  const calendarDay = row.at.slice(0, 10);
  if (new Date(`${calendarDay}T00:00:00Z`).toISOString().slice(0, 10) !== calendarDay) throw new Error('Invalid at');
  if (!start && !['succeeded', 'failed', 'canceled'].includes(row.status)) throw new Error('Invalid status');
  return row;
}

/** Parse only the documented CLI flags, rejecting duplicates and extra arguments. */
export function parseGrokArgs(args, at = new Date().toISOString()) {
  const [event, ...flags] = args;
  const row = { v: 1, event, at };
  const allowed = event === 'start' ? ['id', 'bot', 'task', 'issue'] : event === 'finish' ? ['id', 'status'] : [];
  if (!allowed.length || flags.length % 2) throw new Error('Invalid arguments');
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index].slice(2);
    if (!flags[index].startsWith('--') || !allowed.includes(key) || Object.hasOwn(row, key)) throw new Error('Invalid arguments');
    row[key] = flags[index + 1];
  }
  return validateGrokEvent(row);
}

/** Append one complete line; never rewrite existing runs. */
export async function appendGrokRun(args, { path = process.env.GROK_RUNS_JSONL || join(homedir(), '.local/state/agent-orchestration/grok-runs.jsonl'), at } = {}) {
  const row = parseGrokArgs(args, at);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await appendGrokRun(process.argv.slice(2)); }
  catch { console.error('Invalid Grok run or append failed. Use start --id ID --bot NAME --task TITLE [--issue KEY] or finish --id ID --status succeeded|failed|canceled.'); process.exitCode = 1; }
}
