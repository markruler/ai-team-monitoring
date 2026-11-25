#!/usr/bin/env node
/** Append minimal, validated Cursor hook lifecycle metadata without prompt or message content. */
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i;
const EVENTS = new Set(['start', 'heartbeat', 'finish']);
const FINISH_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const ALLOWED_KEYS = new Set(['v', 'id', 'event', 'at', 'model', 'repo', 'conversationId', 'status']);

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

/** Validate the exact Cursor lifecycle event schema, bounded metadata and ISO timestamp. */
export function validateCursorEvent(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid event');
  if (Object.keys(row).some((key) => !ALLOWED_KEYS.has(key)) || row.v !== 1 || !EVENTS.has(row.event)) {
    throw new Error('Invalid event fields');
  }
  for (const [key, limit, required] of [
    ['id', 160, true],
    ['model', 80, false],
    ['repo', 80, false],
    ['conversationId', 128, false],
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

/** Map Cursor stop/sessionEnd status or reason into a dashboard finish status. */
function finishStatus(value) {
  if (value === 'error') return 'failed';
  if (['aborted', 'window_close', 'user_close', 'canceled'].includes(value)) return 'canceled';
  return 'succeeded';
}

/** Extract allowlisted lifecycle metadata from a Cursor hook stdin payload; prompt and tool content are ignored. */
export function cursorEventFromPayload(payload, at = new Date().toISOString()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const hook = payload.hook_event_name;
  const eventMap = { beforeSubmitPrompt: 'start', postToolUse: 'heartbeat', stop: 'finish', sessionEnd: 'finish' };
  const event = eventMap[hook];
  if (!event) return null;
  const conversationId = clean(payload.conversation_id ?? payload.session_id, 128);
  const generationId = clean(payload.generation_id, 128);
  const id = hook === 'sessionEnd'
    ? shortId(conversationId)
    : [shortId(conversationId), shortId(generationId)].filter(Boolean).join('-');
  if (!id) return null;
  const model = clean(payload.model_id ?? payload.model, 80);
  const root = Array.isArray(payload.workspace_roots) ? payload.workspace_roots.find((item) => typeof item === 'string' && item.trim()) : '';
  const repo = root ? clean(basename(root.replace(/\/+$/, '')), 80) : '';
  const row = {
    v: 1,
    id,
    event,
    at,
    ...(model ? { model } : {}),
    ...(repo ? { repo } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(event === 'finish' ? { status: finishStatus(hook === 'sessionEnd' ? (payload.reason ?? payload.final_status) : payload.status) } : {}),
  };
  return validateCursorEvent(row);
}

/** Return the exact stdout JSON contract expected by Cursor for each hook event. */
export function hookOutput(payload) {
  return payload?.hook_event_name === 'beforeSubmitPrompt' ? '{"continue":true}' : '{}';
}

/** Append one validated Cursor lifecycle line; never rewrite existing runs. */
export async function appendCursorEvent(payload, { path = process.env.CURSOR_RUNS_JSONL || join(homedir(), '.local/state/agent-outer-loop/cursor-runs.jsonl'), at } = {}) {
  const row = cursorEventFromPayload(payload, at);
  if (!row) return null;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return row;
}

/** Read bounded stdin text so a malformed or oversized hook payload can never hang Cursor. */
async function readStdin(limit = 1024 * 1024) {
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
  let payload = null;
  try {
    const text = await readStdin();
    if (text.trim()) payload = JSON.parse(text);
    await appendCursorEvent(payload);
  } catch { /* Fail open: monitoring hooks must never block Cursor. */ }
  process.stdout.write(`${hookOutput(payload)}\n`);
}
