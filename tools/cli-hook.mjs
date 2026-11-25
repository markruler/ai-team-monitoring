#!/usr/bin/env node
/** Append minimal, validated Claude/Codex CLI hook metadata without prompt, tool or message content. */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i;
const AGENTS = new Set(['claude', 'codex']);
const EVENTS = new Set(['start', 'heartbeat', 'finish']);
const FINISH_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const ALLOWED_KEYS = new Set(['v', 'agent', 'id', 'event', 'at', 'model', 'repo', 'sessionId', 'status']);

/** Strip control characters, trim, and bound one metadata string. */
function clean(value, limit) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, limit);
}

/** Shorten long UUID identifiers while preserving short synthetic IDs. */
function shortId(value) {
  const text = clean(value, 64);
  if (!text) return '';
  return UUID_LIKE.test(text) ? text.slice(0, 8) : text;
}

/** Validate the exact CLI lifecycle event schema, bounded metadata and ISO timestamp. */
export function validateCliEvent(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid event');
  if (Object.keys(row).some((key) => !ALLOWED_KEYS.has(key)) || row.v !== 1 || !AGENTS.has(row.agent) || !EVENTS.has(row.event)) {
    throw new Error('Invalid event fields');
  }
  for (const [key, limit, required] of [
    ['id', 160, true],
    ['model', 80, false],
    ['repo', 80, false],
    ['sessionId', 128, false],
  ]) {
    if (row[key] === undefined) {
      if (required) throw new Error(`Missing ${key}`);
      continue;
    }
    if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > limit || /[\x00-\x1f\x7f]/.test(row[key])) {
      throw new Error(`Invalid ${key}`);
    }
  }
  const instant = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
  if (!ISO.test(row.at) || !Number.isFinite(instant) || instant < 0) throw new Error('Invalid at');
  const calendarDay = row.at.slice(0, 10);
  if (new Date(`${calendarDay}T00:00:00Z`).toISOString().slice(0, 10) !== calendarDay) throw new Error('Invalid at');
  if (row.event === 'finish') {
    if (!FINISH_STATUSES.has(row.status)) throw new Error('Invalid status');
  } else if (row.status !== undefined) {
    throw new Error('Unexpected status');
  }
  return row;
}

/** Map hook stop/end status or reason into a dashboard finish status. */
function finishStatus(value) {
  const lower = clean(value, 64).toLowerCase();
  if (['error', 'failed', 'failure'].includes(lower)) return 'failed';
  if (['aborted', 'canceled', 'cancelled', 'interrupted', 'user_abort'].includes(lower)) return 'canceled';
  return 'succeeded';
}

/** Extract allowlisted lifecycle metadata from a Claude Code or Codex CLI hook/notify payload. */
export function cliEventFromPayload(payload, { agent: forcedAgent, at = new Date().toISOString() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const hook = clean(payload.hook_event_name ?? payload.event ?? payload.type, 64);
  const eventMap = {
    UserPromptSubmit: 'start',
    start: 'start',
    PreToolUse: 'heartbeat',
    PostToolUse: 'heartbeat',
    PostToolUseFailure: 'heartbeat',
    heartbeat: 'heartbeat',
    Stop: 'finish',
    SessionEnd: 'finish',
    'agent-turn-complete': 'finish',
    finish: 'finish',
  };
  const event = eventMap[hook];
  if (!event) return null;

  const isCodexNotify = payload.type === 'agent-turn-complete' || Boolean(payload['thread-id'] || payload['turn-id']);
  const rawAgent = clean(forcedAgent ?? payload.agent ?? (isCodexNotify ? 'codex' : 'claude'), 32).toLowerCase();
  if (!AGENTS.has(rawAgent)) return null;

  const sessionId = clean(payload.session_id ?? payload['thread-id'] ?? payload.thread_id ?? payload.conversation_id, 128);
  const turnId = clean(payload.turn_id ?? payload['turn-id'] ?? payload.generation_id, 128);
  const id = hook === 'SessionEnd'
    ? shortId(sessionId)
    : [shortId(sessionId), shortId(turnId)].filter(Boolean).join('-');
  if (!id) return null;

  const model = clean(payload.model ?? payload.model_id, 80);
  const cwd = clean(payload.cwd, 512);
  const repo = cwd ? clean(basename(cwd.replace(/\/+$/, '')), 80) : '';
  const row = {
    v: 1,
    agent: rawAgent,
    id,
    event,
    at,
    ...(model ? { model } : {}),
    ...(repo ? { repo } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(event === 'finish' ? { status: finishStatus(payload.status ?? payload.stop_reason ?? payload.reason) } : {}),
  };
  return validateCliEvent(row);
}

/** Append one validated CLI lifecycle line; never rewrite existing runs. */
export async function appendCliEvent(payload, { agent, path = process.env.CLI_RUNS_JSONL || join(homedir(), '.local/state/agent-orchestration/cli-runs.jsonl'), at } = {}) {
  const row = cliEventFromPayload(payload, { agent, at });
  if (!row) return null;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return row;
}

/** Parse minimal CLI flags (--agent claude|codex) and optional positional JSON payload (Codex notify). */
export function parseHookArgs(argv) {
  let agent;
  let inlineJson = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--agent' && argv[index + 1]) {
      agent = argv[++index];
    } else if (arg.startsWith('{') && arg.endsWith('}')) {
      inlineJson = arg;
    }
  }
  return { agent, inlineJson };
}

/** Read bounded stdin text so a malformed or oversized hook payload can never hang the CLI. */
async function readStdin(limit = 1024 * 1024) {
  if (process.stdin.isTTY) return '';
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > limit) return '';
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { agent, inlineJson } = parseHookArgs(process.argv.slice(2));
    const text = inlineJson ?? await readStdin();
    if (text.trim()) {
      const payload = JSON.parse(text);
      await appendCliEvent(payload, { agent });
    }
  } catch { /* Fail open: monitoring hooks must never block Claude or Codex CLI. */ }
  process.stdout.write('{}\n');
}
