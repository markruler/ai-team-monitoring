/** Read-only local worker telemetry server. Only allowlisted metadata leaves this module. */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { validateGrokEvent } from './tools/grok-run.mjs';
import { completionEvidence, completionFlags } from './tools/completion.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LIMIT = 32 * 1024 * 1024;
const TAIL_LIMIT = 64 * 1024;
const ACTIVE = new Set(['starting', 'running']);
const STATUSES = ['running', 'succeeded', 'no-changes', 'failed', 'killed', 'dead', 'canceled'];
const FAILURE_STATUSES = new Set(['failed', 'killed', 'dead']);
const HEARTBEAT_MS = 60 * 1000;
const STEP_KEY = /^[a-z][a-z0-9_-]{0,31}$/;
// A reason code, optionally with a short code-shaped detail such as `git-failed: from-ref`; prose never matches.
const REASON_CODE = /^[a-z][a-z0-9_-]{0,47}(?::\s?[a-z0-9][a-z0-9._-]{0,47})?$/;
const AGENT_BINARIES = new Set(['codex', 'claude', 'agy']);
const NO_REASON = '사유 기록 없음 (이전 런처 기록)';
const REASON_LABELS = {
  'lost-heartbeat': '하트비트 손실 (60초 초과)',
  'repeat-failure-blocked': '동일 사유 재실패로 자동 재실행 차단',
  'process-dead': '프로세스 종료 감지 (process-dead)',
  'preflight-rejected': '사전 점검 거부',
  'agent-task-rejected': '작업 거부 (agent-task-rejected)',
  'missing-issue-key': '이슈 키 누락',
  'repo-missing': '저장소 경로 없음',
  'git-failed': 'git 명령 실패',
  'dirty-worktree': '작업 트리 미정리',
  'permission-denied': '권한 거부',
  'no-commits': '커밋 없음',
  timeout: '시간 초과',
  enoent: '파일 또는 명령 없음 (ENOENT)',
  usage: '명령 사용법 오류 (usage)',
  dirty: '작업 트리 미정리',
  identity: '커밋 작성자 불일치',
  subject: '커밋 제목 규칙 위반',
};
const STEP_FAILURE_LABELS = { preflight: '사전 점검 거부', worktree: '워크트리 준비 실패', spec: '작업 명세 준비 실패',
  'agent-start': '에이전트 시작 실패', 'agent-exit': '에이전트 비정상 종료', 'post-check': '사후 검사 실패',
  'launcher-commit': '커밋 실패', 'launcher-tests': '테스트 실패' };
// Ordered: the first matching pattern in the newest log text wins.
const LOG_PATTERNS = [
  ['agent-task-rejected', /agent-task-rejected\b[\s:=-]*([^\n]*)/i],
  ['missing-issue-key', /(?:missing|no)\s+(?:jira\s+)?issue[\s-]+key|issue[\s-]+key\s+(?:is\s+)?(?:missing|required)/i],
  ['permission-denied', /permission denied|\bEPERM\b|\bEACCES\b/i],
  ['no-commits', /\bno[\s-]commits?\b/i],
  ['killed', /\b(SIGKILL|SIGTERM)\b|\bkilled\b/i],
  ['timeout', /\btimed?[\s-]?out\b|\bETIMEDOUT\b/i],
  ['enoent', /\bENOENT\b/],
  ['usage', /^\s*usage:/im],
];

/** Remove credential-like strings, email addresses, terminal escapes and controls. */
export function redact(value) {
  return String(value ?? '').slice(0, 500)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[\w-]+/gi, '[secret]')
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '[secret]')
    .replace(/\bBearer\s+\S+/gi, '[secret]')
    .replace(/\b[A-Za-z0-9_+\/-]{32,}={0,2}\b/g, '[redacted]');
}

/** Convert a timestamp to milliseconds, ignoring invalid values. */
export function timestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

/** Parse only complete JSONL lines; malformed and partial writes are harmless. */
export function parseJsonl(text) {
  return text.split('\n').slice(0, -1).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
    } catch { return []; }
  });
}

const AWAITING_AFTER_MS = 10 * 60 * 1000;
const ENDED_STATUSES = new Set(['succeeded', 'no-changes', 'failed', 'killed', 'dead']);
const LEGACY_STATUSES = new Set(['succeeded', 'no-changes']);
const INBOX_SCHEMA = 'agent-orchestration.inbox/v1';
const ASKS_SCHEMA = 'agent-orchestration.asks/v1';
const LANES_SCHEMA = 'ai-team-monitoring.lanes/v1';
const READ_ONLY_SUCCESS_STATUSES = new Set(['completed-no-changes', 'no-changes']);
const NO_COMMITS_REASON = /^(?:post-check:\s*)?no-commits$/i;

/** A read-only worker is expected to make no commits, so its no-commits result counts as success. */
export function readOnlySucceeded(record) {
  if (record?.mode !== 'read-only') return false;
  if (record.status === 'succeeded' || READ_ONLY_SUCCESS_STATUSES.has(record.status)) return true;
  return record.status === 'failed' && typeof record.reason === 'string' && NO_COMMITS_REASON.test(record.reason.trim());
}

/** Normalize completed workers consistently for worker and inbox display. */
function normalizedStatus(record) {
  if (record.status === 'completed-no-changes') return 'no-changes';
  return readOnlySucceeded(record) ? 'succeeded' : record.status;
}

/** Detect live PIDs without sending a signal; EPERM still indicates a process exists. */
export function pidAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // Callback-style callers (e.g. Array.some) pass an index here; never call a non-function.
  const probe = typeof kill === 'function' ? kill : process.kill;
  try { probe(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Classify liveness for display without changing the source record.
 * Alive = any launcher/agent/legacy PID alive, or a heartbeat within 60 seconds.
 * Records with neither PIDs nor a heartbeat fall back to the newest timestamp within 15 minutes.
 */
export function workerStatus(record, now = Date.now(), alive = pidAlive) {
  const status = normalizedStatus(record);
  if (!ACTIVE.has(status)) return STATUSES.includes(status) ? status : 'unknown';
  const pids = [record.launcherPid, record.agentPid, record.pid].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (pids.some((pid) => alive(pid))) return 'running';
  const heartbeat = timestamp(record.heartbeatAt);
  if (heartbeat !== null) return now - heartbeat <= HEARTBEAT_MS ? 'running' : 'dead';
  if (pids.length) return 'dead';
  const updates = [record.startedAt, record.lastLogAt, record.updatedAt,
    ...(Array.isArray(record.steps) ? record.steps.map((step) => step?.at) : [])]
    .map(timestamp).filter((value) => value !== null);
  return updates.length && now - Math.max(...updates) <= 15 * 60 * 1000 ? 'running' : 'dead';
}

/**
 * Report the heartbeat age and whether an active (running/starting) record has gone past the
 * same 60-second threshold that workerStatus uses for liveness.
 */
export function heartbeatState(record, now = Date.now()) {
  const at = timestamp(record.heartbeatAt);
  if (at === null) return { heartbeatAgeSec: null, heartbeatStale: false };
  const ageMs = Math.max(0, now - at);
  return { heartbeatAgeSec: Math.floor(ageMs / 1000), heartbeatStale: ACTIVE.has(record.status) && ageMs > HEARTBEAT_MS };
}

/** Accept only exact loopback host names, with an optional valid port. */
export function validHost(host) {
  if (typeof host !== 'string') return false;
  const match = /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/i.exec(host);
  return Boolean(match && (!match[2] || (+match[2] > 0 && +match[2] <= 65535)));
}

/** Normalize nonnegative usage counters. */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Usage figures reported per worker; each is a nonnegative number, or null when the CLI never reported it. */
export const USAGE_KEYS = ['costUsd', 'newInput', 'input', 'cacheWrite', 'cached', 'output', 'turns'];

/** Read a nonnegative reported figure, or null when it is absent or invalid. */
function reported(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Add two optional figures; the sum stays null only when neither side was reported. */
function addReported(a, b) {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

/** Return usage with every figure unreported. */
export function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, null]));
}

/** Add usage figure by figure, keeping figures that neither side reported as null. */
export function mergeUsage(a, b) {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, addReported(a[key] ?? null, b[key] ?? null)]));
}

/** Read the cumulative usage, cost and turn count from one Claude `result` row. */
function claudeResultUsage(row) {
  const usage = row.usage && typeof row.usage === 'object' ? row.usage : {};
  const input = reported(usage.input_tokens);
  const cacheWrite = reported(usage.cache_creation_input_tokens);
  return {
    costUsd: reported(row.total_cost_usd) ?? reported(usage.total_cost_usd),
    newInput: addReported(input, cacheWrite),
    input,
    cacheWrite,
    cached: reported(usage.cache_read_input_tokens),
    output: reported(usage.output_tokens),
    turns: reported(row.num_turns) ?? reported(usage.num_turns),
  };
}

/** Read one Codex `turn.completed` row; Codex input already includes cached input, so new input excludes it. */
function codexTurnUsage(row) {
  const usage = row.usage && typeof row.usage === 'object' ? row.usage : {};
  const input = reported(usage.input_tokens);
  const cached = reported(usage.cached_input_tokens);
  return {
    costUsd: null,
    newInput: input === null ? null : Math.max(0, input - (cached ?? 0)),
    input,
    cacheWrite: null,
    cached,
    output: reported(usage.output_tokens),
    turns: 1,
  };
}

/**
 * Read cost-first usage from CLI log rows without summing cache reads into a headline total.
 * Claude `result` rows are cumulative, so only the last one counts; Codex `turn.completed` rows are per turn and add up.
 */
export function usageFromRows(rows) {
  let claude = null;
  let codex = emptyUsage();
  for (const row of rows) {
    if (row.type === 'result') claude = claudeResultUsage(row);
    else if (row.type === 'turn.completed') codex = mergeUsage(codex, codexTurnUsage(row));
  }
  return claude ? mergeUsage(claude, codex) : codex;
}

/** Count relaunches using the original repo/issue/branch identity before redaction. */
export function retryFlags(records) {
  const seen = new Set();
  const flags = new Map();
  for (const record of [...records].sort((a, b) => (timestamp(a.startedAt) ?? 0) - (timestamp(b.startedAt) ?? 0))) {
    const branch = record.branch ?? record.branchName;
    if (!record.repo || record.issue === undefined || !branch) { flags.set(record, null); continue; }
    const key = JSON.stringify([record.repo, record.issue, branch]);
    flags.set(record, seen.has(key));
    seen.add(key);
  }
  return flags;
}

/** Read a bounded tail using a read-only descriptor, skipping an incomplete first line. */
async function readTail(path, limit = LIMIT) {
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) return { text: '', truncated: false };
    const offset = Math.max(0, stat.size - limit);
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: offset > 0 };
  } catch (error) {
    return { text: '', truncated: false, missing: error.code === 'ENOENT', unreadable: error.code !== 'ENOENT' };
  } finally { await file?.close(); }
}

/** Read the first bytes of a small text file read-only; failures read as empty. */
async function readHead(path, limit = 16 * 1024) {
  let file;
  try {
    file = await open(path, 'r');
    if (!(await file.stat()).isFile()) return '';
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await file.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { await file?.close(); }
}

/** Keep launcher step keys as-is; anything that is not a short lowercase key cannot escape. */
export function stepName(name) {
  return typeof name === 'string' && STEP_KEY.test(name) ? name : 'unrecognized';
}

/** Clip one redacted display line. */
function clip(value, limit = 200) {
  return redact(value).trim().slice(0, limit);
}

/** Expose only validated merge status, timestamps and a redacted failure reason. */
function mergingMetadata(value) {
  if (!value || !['merging', 'merged', 'failed'].includes(value.status)) return null;
  return {
    status: value.status,
    startedAt: timestamp(value.startedAt),
    finishedAt: timestamp(value.finishedAt),
    reason: value.status === 'failed' && typeof value.reason === 'string' ? clip(value.reason) : '',
  };
}

/** Normalize immediate merge conflicts and file-overlap waits from harness records or evidence. */
function mergeWaitMetadata(record, waiting) {
  const sources = [waiting, record?.merging, record].filter(Boolean);
  const queueDetail = sources.flatMap((value) => [value.blocker, value.detail])
    .find((value) => typeof value === 'string' && /waiting for .+ merge \(file conflict\)/i.test(value));
  const queued = queueDetail || sources.some((value) => ['queued', 'waiting'].includes(value.status) || value.blocker === 'file-conflict');
  if (queued) return { status: 'queued', detail: clip(queueDetail || sources.find((value) => value.detail)?.detail, 300) || '파일 겹침 병합 대기' };
  if (!sources.some((value) => value.status === 'merge-conflict' || value.blocker === 'conflict')) return null;
  const files = sources.map((value) => value.files ?? value.conflictFiles).find(Array.isArray);
  const detail = files?.filter((value) => typeof value === 'string').map((value) => clip(value)).filter(Boolean).join(', ')
    || clip(sources.find((value) => value.detail)?.detail, 300);
  return { status: 'merge-conflict', detail: clip(detail, 300) };
}

/** Name who killed a run: a legacy actor string, or the classification of a launcher killedBy object. */
function killerName(killedBy) {
  if (typeof killedBy === 'string') {
    const actor = clip(killedBy, 80);
    return actor ? `killedBy=${actor}` : '';
  }
  if (!killedBy || typeof killedBy !== 'object' || typeof killedBy.classification !== 'string') return '';
  return clip(killedBy.classification, 80);
}

/** Describe a kill using only the signal and the recorded actor/reason fields. */
function killedLabel(record, signal) {
  const parts = [];
  const killer = killerName(record.killedBy);
  if (killer) parts.push(killer);
  if (typeof record.killReason === 'string' && record.killReason.trim()) parts.push(`killReason=${clip(record.killReason, 80)}`);
  const killSignal = signal ?? signalName(record.killedBy?.signal);
  if (killSignal) parts.push(killSignal);
  return parts.length ? `강제 종료 (${parts.join(', ')})` : '강제 종료';
}

/** Return a validated POSIX signal name, if any. */
function signalName(value) {
  return typeof value === 'string' && /^SIG[A-Z0-9]{2,10}$/.test(value) ? value : null;
}

/** Label one reason key or free-form reason, classifying prose by the known log patterns. */
export function reasonLabel(value, record = {}) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const key = text.toLowerCase().replace(/_/g, '-');
  if (key === 'killed') return killedLabel(record, signalName(record.signal));
  const signal = signalName(text);
  if (signal) return killedLabel(record, signal);
  if (Object.hasOwn(REASON_LABELS, key)) return REASON_LABELS[key];
  const prefixed = /^([a-z][a-z0-9-]{1,47}):\s*(.*)$/s.exec(text);
  if (prefixed && Object.hasOwn(REASON_LABELS, prefixed[1])) {
    const detail = clip(prefixed[2], 160);
    return detail ? `${REASON_LABELS[prefixed[1]]}: ${detail}` : REASON_LABELS[prefixed[1]];
  }
  const match = classifyText(text);
  if (match && match.code !== 'killed') return `${match.label}: ${clip(text)}`;
  if (match) return `${killedLabel(record, match.signal)}: ${clip(text)}`;
  return clip(text);
}

/** Find the first known failure pattern in log or error text. */
export function classifyText(text) {
  for (const [code, pattern] of LOG_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (code === 'agent-task-rejected') {
      const reason = clip(match[1] ?? '', 160);
      return { code, label: reason ? `${REASON_LABELS[code]}: ${reason}` : REASON_LABELS[code] };
    }
    if (code === 'killed') {
      const signal = signalName(match[1]?.toUpperCase());
      return { code, signal, label: signal ? `강제 종료 (${signal})` : '강제 종료' };
    }
    return { code, label: REASON_LABELS[code] };
  }
  return null;
}

/** Keep the last TAIL_LIMIT characters, dropping a cut-off first line so JSONL stays whole. */
function tailText(text) {
  const value = String(text ?? '');
  if (value.length <= TAIL_LIMIT) return value;
  const sliced = value.slice(-TAIL_LIMIT);
  return sliced.slice(sliced.indexOf('\n') + 1);
}

/**
 * Turn raw log text into displayable lines. JSONL agent events carry conversation text,
 * so a JSON line is reduced to its allowlisted status fields (or dropped).
 */
export function logLines(text) {
  return String(text ?? '').split('\n').flatMap((line) => {
    if (!line.trimStart().startsWith('{')) return [line];
    let row;
    try { row = JSON.parse(line); } catch { return [line]; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const fields = ['type', 'subtype', 'is_error', 'exit_code', 'status']
      .filter((key) => ['string', 'number', 'boolean'].includes(typeof row[key]) && /^[\w.:-]{1,40}$/.test(String(row[key])))
      .map((key) => `${key}=${row[key]}`);
    return fields.length ? [`[json] ${fields.join(' ')}`] : [];
  });
}

/** Return the last five non-empty redacted lines of stderr, else stdout, 200 chars each. */
export function logTail(stderr = '', stdout = '') {
  for (const text of [stderr, stdout]) {
    const lines = logLines(text).map((line) => clip(line)).filter(Boolean);
    if (lines.length) return lines.slice(-5);
  }
  return [];
}

/** Derive a failure from the step right before a `failed` step, e.g. preflight → failed. */
function stepFailure(record) {
  const steps = (Array.isArray(record.steps) ? record.steps : []).filter((step) => step && typeof step.name === 'string')
    .sort((a, b) => (timestamp(a.at) ?? 0) - (timestamp(b.at) ?? 0));
  const failedIndex = steps.findLastIndex((step) => step.name === 'failed');
  if (failedIndex <= 0) return null;
  const previous = steps[failedIndex - 1].name;
  const label = STEP_FAILURE_LABELS[previous] ?? `${stepName(previous)} 단계 실패`;
  return { code: previous === 'preflight' ? 'preflight-rejected' : `${stepName(previous)}-failed`, source: 'steps', label };
}

/** Keep only code-shaped reason values (e.g. `dirty-worktree`, `git-failed: from-ref`) for display as raw codes. */
export function reasonCodes(values) {
  const codes = values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter((value) => REASON_CODE.test(value));
  return [...new Set(codes)].slice(0, 10);
}

/**
 * Classify why a run failed: recorded reasons first, then steps, then logs, then reconciled status.
 * A step-derived failure prefixes a recorded reason so "사전 점검 거부" stays visible.
 * A dead run whose active record outlived its heartbeat reads as lost-heartbeat rather than a bare process-dead.
 * Returns { code, codes, label, source }: label is always displayable Korean or a raw key, codes are the raw reason codes.
 */
export function classifyFailure(record, { status = record.status, stderr = '', stdout = '', heartbeatStale = false } = {}) {
  const fromSteps = stepFailure(record);
  const recorded = recordedFailure(record);
  if (recorded && fromSteps && recorded.source !== 'postCheck.reasons') {
    return { code: fromSteps.code, codes: reasonCodes([fromSteps.code, ...recorded.codes]), source: `steps+${recorded.source}`, label: `${fromSteps.label}: ${recorded.label}` };
  }
  if (recorded) return recorded;
  if (fromSteps) return { ...fromSteps, codes: reasonCodes([fromSteps.code]) };
  const match = classifyText(logLines(`${tailText(stdout)}\n${tailText(stderr)}`).join('\n'));
  if (match) return { code: match.code, codes: [match.code], source: 'logs', label: match.label };
  if (status === 'dead' && heartbeatStale) return { code: 'lost-heartbeat', codes: ['lost-heartbeat'], source: 'heartbeat', label: REASON_LABELS['lost-heartbeat'] };
  if (status === 'dead') return { code: 'process-dead', codes: ['process-dead'], source: 'status', label: REASON_LABELS['process-dead'] };
  if (status === 'killed') return { code: 'killed', codes: ['killed'], source: 'status', label: '강제 종료' };
  return { code: 'unknown', codes: [], source: 'none', label: NO_REASON };
}

/** Append the launcher's reasonDetail to a recorded failure label unless the label already says it. */
function recordedFailure(record) {
  const result = recordedReason(record);
  const detail = typeof record.reasonDetail === 'string' ? clip(record.reasonDetail, 160) : '';
  if (!result || !detail || result.label.toLowerCase().includes(detail.toLowerCase())) return result;
  return { ...result, label: `${result.label}: ${detail}` };
}

/** Read the reason the launcher recorded: postCheck reasons, reason fields, then the signal. */
function recordedReason(record) {
  const postCheck = record.postCheck && typeof record.postCheck === 'object' ? record.postCheck : {};
  const postReasons = (Array.isArray(postCheck.reasons) ? postCheck.reasons : [postCheck.reasons])
    .filter((value) => typeof value === 'string' && value.trim());
  if (postReasons.length) {
    return { code: 'post-check', codes: reasonCodes(postReasons), source: 'postCheck.reasons', label: postReasons.map((value) => reasonLabel(value, record)).join(', ') };
  }
  for (const field of ['reason', 'failureReason', 'error', 'spawnError', 'reconciledReason', 'reconciledStatus', 'reconciled']) {
    const value = record[field];
    const text = typeof value === 'string' ? value : value && typeof value === 'object' ? value.reason ?? value.code ?? value.message : null;
    const label = reasonLabel(text, record);
    if (!label) continue;
    const key = String(text).trim().toLowerCase().replace(/_/g, '-');
    return { code: /^[a-z][a-z0-9-]{0,47}$/.test(key) ? key : 'recorded', codes: reasonCodes([text]), source: field, label };
  }
  const signal = signalName(record.signal);
  if (signal || record.killedBy || record.killReason) return { code: 'killed', codes: ['killed'], source: 'signal', label: killedLabel(record, signal) };
  return null;
}

/** Use the first markdown heading of a spec as the task title. */
export function specTitle(text) {
  const match = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(String(text ?? ''));
  return match ? clip(match[1], 120) : '';
}

/** Read a task summary from the record title, own commit subject, or original issue heading. */
export async function taskSummary(record, { spec = '', exec = run } = {}) {
  if (typeof record.title === 'string' && record.title.trim()) return redact(record.title);
  const branch = record.branch || record.branchName;
  const sources = [[record.worktree, 'HEAD'], [record.repoDir, branch ? `refs/heads/${branch}` : null]];
  for (const [cwd, ref] of sources) {
    if (typeof cwd !== 'string' || !cwd || !ref || !record.worktreeBase) continue;
    try {
      const subject = await exec('git', ['log', '-1', '--format=%s', `${record.worktreeBase}..${ref}`, '--'], { cwd });
      const issue = /\b[A-Z][A-Z0-9_]*-\d+\b/.exec(subject)?.[0];
      if (issue && issue !== record.issue) break;
      if (subject.trim()) return redact(subject.trimEnd());
      break;
    } catch { /* A removed worktree or missing branch falls through to the spec. */ }
  }
  for (const line of String(spec).split(/\r?\n/)) {
    const heading = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t#]*$/.exec(line)?.[1];
    if (!heading || /^Local worker spec\s+—\s+/.test(heading)) continue;
    if (/\b[A-Z][A-Z0-9_]*-\d+\b/.test(heading)) return redact(heading);
  }
  return '';
}

/** Return a path only when it resolves inside root, so records cannot point reads elsewhere. */
function insideRoot(root, path) {
  if (typeof path !== 'string' || !path) return null;
  const base = resolve(root);
  const full = resolve(base, path);
  return full === base || full.startsWith(base + sep) ? full : null;
}

/** Convert ps etime ([[dd-]hh:]mm:ss) to seconds. */
export function etimeSeconds(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return ((+days * 24 + +hours) * 60 + +minutes) * 60 + +seconds;
}

/** Reduce an agent command line to its binary and subcommand; prompt text is dropped. */
export function agentCommand(command) {
  const tokens = String(command ?? '').trim().split(/\s+/);
  // The binary is argv[0], or argv[1] behind a JS runtime wrapper; `grep claude -p` must not match.
  const index = AGENT_BINARIES.has(basename(tokens[0])) ? 0
    : ['node', 'bun'].includes(basename(tokens[0])) && AGENT_BINARIES.has(basename(tokens[1] ?? '')) ? 1 : -1;
  if (index < 0) return null;
  const binary = basename(tokens[index]);
  const subcommand = tokens.slice(index + 1).find((token) => ['exec', '-p', '--print'].includes(token));
  if (!subcommand) return null;
  return { binary, subcommand: subcommand === 'exec' ? 'exec' : '-p' };
}

/** Parse `ps -axo pid,ppid,etime,command` rows. */
export function parsePs(text) {
  return String(text ?? '').split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match ? [{ pid: +match[1], ppid: +match[2], etime: match[3], command: match[4] }] : [];
  });
}

/** Read the cwd path from `lsof -Fn` output. */
export function parseLsofCwd(text) {
  const line = String(text ?? '').split('\n').find((row) => row.startsWith('n'));
  return line ? line.slice(1) : null;
}

/** Shorten the home prefix to ~ and strip control characters. */
export function shortPath(path, home = homedir()) {
  if (!path) return '';
  const clean = String(path).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300);
  return clean === home || clean.startsWith(home + '/') ? `~${clean.slice(home.length)}` : clean;
}

/** List agent exec/-p processes not owned by a known worker PID or any of its descendants. */
export function untrackedFromPs(psText, knownPids) {
  const rows = parsePs(psText);
  const tracked = new Set(knownPids);
  // Wrappers (e.g. a node launcher) spawn a native child with the same args; skip descendants too.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (tracked.has(row.ppid) && !tracked.has(row.pid)) { tracked.add(row.pid); changed = true; }
    }
  }
  const candidates = rows.flatMap((row) => {
    if (tracked.has(row.pid)) return [];
    const agent = agentCommand(row.command);
    if (!agent) return [];
    return [{ pid: row.pid, ppid: row.ppid, elapsedSec: etimeSeconds(row.etime), ...agent }];
  });
  const agentPids = new Set(candidates.map((item) => item.pid));
  // A wrapper and its native child are one agent; keep only the outermost process.
  return candidates.filter((item) => !agentPids.has(item.ppid));
}

/** Run a fixed read-only command with a short timeout. */
function run(file, args, { cwd } = {}) {
  return new Promise((resolveRun, reject) => {
    execFile(file, args, { cwd, timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolveRun(stdout)));
  });
}

/** Default macOS process probe; any failure yields no untracked processes. */
export async function probeProcesses(knownPids, { platform = process.platform, exec = run, home = homedir() } = {}) {
  if (platform !== 'darwin') return [];
  let psText;
  try { psText = await exec('ps', ['-axo', 'pid,ppid,etime,command']); } catch { return []; }
  const found = untrackedFromPs(psText, [...knownPids, process.pid]).slice(0, 20);
  for (const item of found) {
    try { item.cwd = shortPath(parseLsofCwd(await exec('lsof', ['-a', '-d', 'cwd', '-p', String(item.pid), '-Fn'])), home); } catch { item.cwd = ''; }
  }
  return found.map(({ ppid, ...item }) => ({ ...item, status: 'untracked running' }));
}

/** Summarize attempts started in a period, with explicit denominators. */
export function summarize(workers) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const worker of workers) counts[worker.status] = (counts[worker.status] ?? 0) + 1;
  const finished = workers.filter((worker) => ['succeeded', 'no-changes', 'failed', 'killed', 'dead', 'canceled'].includes(worker.status)).length;
  const failed = counts.failed + counts.killed + counts.dead;
  const eligible = workers.filter((worker) => worker.retry !== null).length;
  const retries = workers.filter((worker) => worker.retry === true).length;
  const awaiting = workers.filter((worker) => worker.awaiting).length;
  return { counts, attempts: workers.length, finished, failed, failureRate: finished ? failed / finished : 0, awaiting,
    retries, retryEligible: eligible, retryUnknown: workers.length - eligible, retryRate: eligible ? retries / eligible : 0 };
}

/** Fold valid lifecycle events by raw ID, then redact all displayed metadata. */
export function grokWorkers(rows, now = Date.now()) {
  const runs = new Map();
  for (const row of rows) {
    try { validateGrokEvent(row); } catch { continue; }
    const run = runs.get(row.id) ?? { starts: [], finishes: [] };
    run[row.event === 'start' ? 'starts' : 'finishes'].push(row);
    runs.set(row.id, run);
  }
  return [...runs.values()].flatMap((run) => {
    const start = run.starts.sort((a, b) => timestamp(a.at) - timestamp(b.at))[0];
    if (!start) return [];
    const startedAt = timestamp(start.at);
    const finish = run.finishes.filter((row) => timestamp(row.at) >= startedAt).sort((a, b) => timestamp(a.at) - timestamp(b.at))[0];
    const finishedAt = finish ? timestamp(finish.at) : null;
    const dead = now - startedAt > 6 * 3600000;
    const end = finishedAt ?? Math.min(now, startedAt + 6 * 3600000);
    const status = finish ? finish.status : dead ? 'dead' : 'running';
    return [{ id: `grok:${redact(start.id)}`, repo: '', issue: redact(start.issue), branch: '', title: redact(start.task),
      bot: redact(start.bot), task: redact(start.task), cli: 'grok', agent: 'grok', kind: 'task',
      status, startedAt, finishedAt, heartbeatAt: null, heartbeatAgeSec: null, heartbeatStale: false, signal: null,
      failure: FAILURE_STATUSES.has(status) ? { ...classifyFailure({}, { status }), logTail: [] } : null,
      lastUpdateAt: finishedAt ?? startedAt, elapsedSec: Math.max(0, end - startedAt) / 1000,
      elapsedEstimated: !finish && dead, exitCode: null, steps: [], retry: null,
      launcherPid: null, agentPid: null, postCheck: { decision: 'unavailable', reasons: [], omittedReasons: 0 },
      tokens: null, usageTruncated: false, logUnreadable: false }];
  });
}

/** Join one recorded last-lines array into text, keeping only string entries. */
function recordedLines(value) {
  return Array.isArray(value) ? value.filter((line) => typeof line === 'string').join('\n') : '';
}

/** Use the launcher's recorded lastStderr/lastStdout lines when either is non-empty. */
function recordedTail(record) {
  const stderr = recordedLines(record.lastStderr);
  const stdout = recordedLines(record.lastStdout);
  return stderr.trim() || stdout.trim() ? { stderr, stdout } : null;
}

/** Read the stderr/stdout tails from the worker's log directory (records folder by default). */
async function fileTail(workersPath, recordDir, record, stdoutText) {
  const logDir = insideRoot(workersPath, record.logDir) ?? recordDir;
  const stderr = (await readTail(join(logDir, 'stderr.log'), TAIL_LIMIT)).text;
  const stdout = logDir === recordDir ? tailText(stdoutText) : (await readTail(join(logDir, 'stdout.log'), TAIL_LIMIT)).text;
  return { stderr, stdout };
}

/** Use startedAt, or finishedAt when startedAt is missing, to order attempts of the same repo+issue. */
function attemptTime(record) {
  return timestamp(record.startedAt) ?? timestamp(record.finishedAt);
}

/** Keep a string field as-is (raw until display), or null. */
function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

/** Keep the newest valid inbox row per worker; the file name's owner is used when a row has none. */
export function inboxByWorker(rows) {
  const result = new Map();
  for (const row of rows) {
    if (row.schema !== INBOX_SCHEMA || typeof row.workerId !== 'string' || !row.workerId) continue;
    const finishedAt = timestamp(row.finishedAt);
    const previous = result.get(row.workerId);
    if (previous && (previous.finishedAt ?? -1) > (finishedAt ?? -1)) continue;
    const issue = typeof row.issue === 'string' || typeof row.issue === 'number' ? row.issue : null;
    result.set(row.workerId, { owner: typeof row.owner === 'string' ? row.owner : '', finishedAt,
      repo: stringOrNull(row.repo), issue, status: stringOrNull(row.status), reason: stringOrNull(row.reason), mode: stringOrNull(row.mode),
      nextStep: ['merge', 'verify', 'deploy'].includes(row.nextStep) ? row.nextStep : null });
  }
  return result;
}

/** Map acked worker IDs (including auto-acks that carry nextWorkerId) to their newest ack; `has` works like a Set. */
export function ackedWorkers(rows) {
  const result = new Map();
  for (const row of rows) {
    if (typeof row.workerId !== 'string' || !row.workerId) continue;
    const ackedAt = timestamp(row.ackedAt);
    const previous = result.get(row.workerId);
    if (previous && (previous.ackedAt ?? -1) > (ackedAt ?? -1)) continue;
    result.set(row.workerId, { ackedAt, by: stringOrNull(row.by), nextWorkerId: stringOrNull(row.nextWorkerId) });
  }
  return result;
}

/** Key attempts by repo+issue; null when either is missing. */
function attemptKey(repo, issue) {
  return repo && issue !== undefined && issue !== null ? JSON.stringify([repo, issue]) : null;
}

/** Newest attempt time per repo+issue across worker records. */
function latestAttempts(records) {
  const latest = new Map();
  for (const record of records) {
    const key = attemptKey(record.repo, record.issue);
    if (key) latest.set(key, Math.max(latest.get(key) ?? -Infinity, attemptTime(record) ?? -Infinity));
  }
  return latest;
}

/** Worker id used by the inbox and acks: the record id, else its directory name. */
function recordId(record) {
  return typeof record.id === 'string' ? record.id : record._dir;
}

/** Mark successful workers without inbox records as historical; failures must remain actionable. */
export function legacyFlags(records, { inbox = new Map() } = {}) {
  return new Map(records.map((record) => [record, LEGACY_STATUSES.has(record._status) && !inbox.has(recordId(record))]));
}

/** Resolve the next stage and responsible bot using explicit release roles before issue routing. */
export function handoffMetadata(record, entry = {}) {
  const role = (entry.owner ?? '').trim().toLowerCase().replace(/[-_]/g, ' ');
  let owner;
  if (role === 'release owner') owner = 'Release Owner';
  else if (role === 'verifier') owner = 'Verifier';
  else if (/^(HARNESS|AIMON|SECRET|AWSDEV)-/i.test(record.issue ?? entry.issue ?? '')) owner = 'Tooling Owner';
  else if (/^AUTOISSUE-/i.test(record.issue ?? entry.issue ?? '')) owner = 'Engineering Owner';
  else owner = clip(entry.owner, 64) || 'unassigned';
  const nextStep = entry.nextStep ?? (owner === 'Release Owner' ? 'deploy' : owner === 'Verifier' ? 'verify' : 'merge');
  return { owner, nextStep };
}

/**
 * Flag ended workers that nobody picked up: an inbox line exists, not acked, no newer attempt for the same
 * repo+issue, no completion evidence, and at least 10 minutes since finishedAt. A worker without an inbox line is never awaiting.
 * Returns a Map from record to waiting metadata and a sanitized blocker reason, or null.
 */
export function awaitingFlags(records, { inbox = new Map(), acks = new Set(), completed = new Map(), evidence = new Map(), now = Date.now() } = {}) {
  const latest = latestAttempts(records);
  const flags = new Map();
  for (const record of records) {
    const id = recordId(record);
    const entry = inbox.get(id);
    const finishedAt = entry?.finishedAt ?? timestamp(record.finishedAt);
    const key = JSON.stringify([record.repo, record.issue]);
    const newer = latest.has(key) && latest.get(key) > (attemptTime(record) ?? -Infinity);
    const ended = ENDED_STATUSES.has(record._status);
    if (!entry || !ended || completed.get(id) || readOnlySucceeded(record) || acks.has(id) || newer || finishedAt === null || now - finishedAt < AWAITING_AFTER_MS) {
      flags.set(record, null);
      continue;
    }
    const waiting = evidence.get(id);
    flags.set(record, { owner: clip(entry?.owner, 64) || 'unassigned', finishedAt, ageSec: Math.floor((now - finishedAt) / 1000),
      blocker: waiting?.blocker ?? null, detail: clip(waiting?.detail, 300) || '이유 없음' });
  }
  return flags;
}

/**
 * Mark workers whose outcome is already handled: acked in the inbox, or followed by a newer attempt for the
 * same repo+issue. A handled dead or failed worker is history, not a current problem. Returns a Map record → boolean.
 */
export function resolvedFlags(records, { acks = new Map() } = {}) {
  const latest = latestAttempts(records);
  return new Map(records.map((record) => {
    const id = typeof record.id === 'string' ? record.id : record._dir;
    const key = attemptKey(record.repo, record.issue);
    const newer = key !== null && latest.get(key) > (attemptTime(record) ?? -Infinity);
    return [record, acks.has(id) || newer];
  }));
}

/**
 * Mark Grok runs whose outcome is already handled: acked by run id, or followed by a newer Grok run for the same
 * non-empty issue. Grok runs carry no repo, so the repo+issue rule in resolvedFlags cannot apply. Returns a Map run → boolean.
 */
export function grokResolvedFlags(runs, { acks = new Map() } = {}) {
  const latest = new Map();
  for (const run of runs) {
    if (run.issue) latest.set(run.issue, Math.max(latest.get(run.issue) ?? -Infinity, run.startedAt ?? -Infinity));
  }
  return new Map(runs.map((run) => [run, acks.has(run.id) || (Boolean(run.issue) && latest.get(run.issue) > (run.startedAt ?? -Infinity))]));
}

/**
 * Build the inbox view from parsed inbox rows and acks. Pending = not acked and no newer attempt for the
 * same repo+issue and no completion evidence (no 10-minute wait); `awaiting` marks pending items that also meet the AIMON-5 rule.
 * Acked items carry only ackedAt, by and nextWorkerId; ack notes and free-form text are never exposed.
 */
export function inboxView(records, { inbox = new Map(), acks = new Map(), awaiting = new Map(), completed = new Map(), evidence = new Map(), now = Date.now() } = {}) {
  const recordsById = new Map(records.map((record) => [typeof record.id === 'string' ? record.id : record._dir, record]));
  const latest = latestAttempts(records);
  const attempts = [...inbox].map(([workerId, entry]) => {
    const record = recordsById.get(workerId);
    const key = attemptKey(entry.repo ?? record?.repo, entry.issue ?? record?.issue);
    const time = (record && attemptTime(record)) ?? entry.finishedAt;
    if (key && !record && time !== null) latest.set(key, Math.max(latest.get(key) ?? -Infinity, time));
    return { workerId, entry, record, key, time };
  });
  const pending = [];
  const acked = [];
  for (const { workerId, entry, record, key, time } of attempts) {
    const ageSec = entry.finishedAt === null ? null : Math.max(0, Math.floor((now - entry.finishedAt) / 1000));
    const rawStatus = normalizedStatus(entry);
    const item = { workerId: clip(workerId, 80), repo: clip(entry.repo ?? record?.repo, 80), issue: clip(entry.issue ?? record?.issue, 80),
      owner: clip(entry.owner, 64) || 'unassigned', status: STATUSES.includes(rawStatus) ? rawStatus : 'unknown',
      reason: reasonLabel(entry.reason) ?? '', finishedAt: entry.finishedAt, ageSec };
    const ack = acks.get?.(workerId);
    if (ack) {
      acked.push({ ...item, ackedAt: ack.ackedAt, by: clip(ack.by, 64), nextWorkerId: clip(ack.nextWorkerId, 80) });
      continue;
    }
    const newer = key !== null && (latest.get(key) ?? -Infinity) > (time ?? -Infinity);
    if (newer || completed.get(workerId) || readOnlySucceeded(record ?? entry)) continue;
    const isAwaiting = record ? Boolean(awaiting.get(record)) : ageSec !== null && ageSec * 1000 >= AWAITING_AFTER_MS;
    const waiting = evidence.get(workerId);
    const mergeWait = mergeWaitMetadata(record ?? entry, waiting);
    pending.push({ ...item, ...(mergeWait ? { mergeWait } : {}), awaiting: isAwaiting, blocker: waiting?.blocker ?? null, detail: clip(waiting?.detail, 300) || '이유 없음' });
  }
  pending.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  acked.sort((a, b) => (b.ackedAt ?? 0) - (a.ackedAt ?? 0));
  return { pending: pending.slice(0, 100), acked: acked.slice(0, 20) };
}

/** List open asks only, marking an ask red when none of its workers is running in this snapshot. */
export function openAsks(rows, runningIds, now = Date.now()) {
  return rows.filter((row) => row.schema === ASKS_SCHEMA && row.status === 'open').map((row) => {
    const workerIds = Array.isArray(row.workerIds) ? row.workerIds.filter((id) => typeof id === 'string') : [];
    const createdAt = timestamp(row.createdAt);
    return { id: clip(row.id, 80), title: clip(row.title, 160), owner: clip(row.owner, 64) || 'unassigned', createdAt,
      ageSec: createdAt === null ? null : Math.max(0, Math.floor((now - createdAt) / 1000)),
      unstaffed: !workerIds.some((id) => runningIds.has(id)) };
  }).slice(-50);
}

/** Keep only non-empty string patterns from a lane match list. */
function patternList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
}

/** Parse a lanes/v1 config; returns the lane list, or null when the text is not a valid config. */
export function parseLanes(text) {
  let config;
  try { config = JSON.parse(text); } catch { return null; }
  if (!config || config.schema !== LANES_SCHEMA || !Array.isArray(config.lanes)) return null;
  return config.lanes.filter((lane) => lane && typeof lane.name === 'string' && lane.name).slice(0, 50).map((lane) => ({
    name: lane.name, repos: patternList(lane.match?.repo), issuePrefixes: patternList(lane.match?.issuePrefix) }));
}

/** A worker belongs to a lane when its repo is listed or its issue starts with a listed prefix. */
export function laneMatches(lane, worker) {
  const issue = typeof worker.issue === 'string' ? worker.issue : String(worker.issue ?? '');
  return (Boolean(worker.repo) && lane.repos.includes(worker.repo)) || lane.issuePrefixes.some((prefix) => issue.startsWith(prefix));
}

/** A healthy running worker is active and has no heartbeat, or a heartbeat within the 60-second lost-heartbeat threshold. */
function healthyRunning(worker, now) {
  if (worker.status !== 'running' && worker.status !== 'starting') return false;
  return typeof worker.heartbeatAt !== 'number' || now - worker.heartbeatAt <= HEARTBEAT_MS;
}

/**
 * Count healthy running workers per lane. A lane with none is `zero`; its time at zero is now minus the latest
 * finishedAt of its workers, or null (unknown) when no worker of the lane has finished.
 */
export function laneCoverage(lanes, workers, now = Date.now()) {
  return lanes.map((lane) => {
    const members = workers.filter((worker) => laneMatches(lane, worker));
    const running = members.filter((worker) => healthyRunning(worker, now)).length;
    const finished = members.map((worker) => worker.finishedAt).filter((value) => typeof value === 'number');
    const lastFinishedAt = finished.length ? Math.max(...finished) : null;
    const zeroSec = running || lastFinishedAt === null ? null : Math.max(0, Math.floor((now - lastFinishedAt) / 1000));
    return { name: clip(lane.name, 64), running, zero: running === 0, lastFinishedAt, zeroSec };
  });
}

const SEOUL_OFFSET_MS = 9 * 3600000;

/** Start of the Asia/Seoul calendar day containing `now`; Seoul has a fixed +09:00 offset without DST. */
export function seoulDayStart(now) {
  return Math.floor((now + SEOUL_OFFSET_MS) / 86400000) * 86400000 - SEOUL_OFFSET_MS;
}

/**
 * The window in which a worker ran healthily: from startedAt until finishedAt, never past 60 seconds
 * after its last heartbeat (the lost-heartbeat threshold), and never past `now`. Returns null when unknown.
 * A worker without heartbeat that is no longer active and has no finishedAt ends at its last update.
 */
export function healthyWindow(worker, now) {
  const start = worker.startedAt;
  if (typeof start !== 'number') return null;
  const ends = [now];
  if (typeof worker.finishedAt === 'number') ends.push(worker.finishedAt);
  if (typeof worker.heartbeatAt === 'number') ends.push(worker.heartbeatAt + HEARTBEAT_MS);
  else if (typeof worker.finishedAt !== 'number' && !ACTIVE.has(worker.status)) ends.push(worker.lastUpdateAt ?? start);
  const end = Math.min(...ends);
  return end > start ? { start, end } : null;
}

/**
 * Today's (Asia/Seoul) healthy running-worker count for one lane as contiguous segments covering
 * day start → now, including segments at 0. Adjacent segments with equal counts are merged.
 */
export function laneTimeline(lane, workers, now = Date.now()) {
  const from = seoulDayStart(now);
  const changes = new Map();
  for (const worker of workers.filter((item) => laneMatches(lane, item))) {
    const window = healthyWindow(worker, now);
    if (!window || window.end <= from) continue;
    const start = Math.max(window.start, from);
    changes.set(start, (changes.get(start) ?? 0) + 1);
    changes.set(window.end, (changes.get(window.end) ?? 0) - 1);
  }
  const points = [...new Set([from, ...changes.keys(), now])].filter((at) => at >= from && at <= now).sort((a, b) => a - b);
  const segments = [];
  let running = 0;
  for (let index = 0; index < points.length - 1; index++) {
    running += changes.get(points[index]) ?? 0;
    const last = segments.at(-1);
    if (last && last.count === running) last.to = points[index + 1];
    else segments.push({ from: points[index], to: points[index + 1], count: running });
  }
  const max = Math.max(0, ...segments.map((item) => item.count));
  return { from, to: now, current: segments.at(-1)?.count ?? 0, max, segments };
}

const DAY_MS = 86400000;
const HISTORY_SUCCESS_STATUSES = new Set(['succeeded', 'no-changes']);
const HISTORY_REASON_LABELS = { unknown: '사유 기록 없음', recorded: '기타 기록 사유' };

/** Reason codes of one failed worker: structured post-check codes first, else its failure code; never prose. */
function historyReasonCodes(worker) {
  const postCheck = worker.postCheck?.reasons ?? [];
  if (postCheck.length) return [...new Set(postCheck)];
  const code = worker.failure?.code;
  return [typeof code === 'string' && REASON_CODE.test(code) ? code : 'unknown'];
}

/** Count succeeded/failed workers of one group and break failures down by reason code. */
function historyCounts(workers) {
  const reasons = new Map();
  let succeeded = 0;
  let failed = 0;
  for (const worker of workers) {
    if (HISTORY_SUCCESS_STATUSES.has(worker.status)) { succeeded++; continue; }
    if (!FAILURE_STATUSES.has(worker.status)) continue;
    failed++;
    for (const code of historyReasonCodes(worker)) reasons.set(code, (reasons.get(code) ?? 0) + 1);
  }
  const breakdown = [...reasons].map(([code, total]) => ({
    code, label: HISTORY_REASON_LABELS[code] ?? REASON_LABELS[code] ?? code, count: total,
  })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return { succeeded, failed, reasons: breakdown };
}

/**
 * Today's history per lane over the same 24h start-time window as summary.day.
 * Success = succeeded + no-changes (read-only no-commits is already succeeded); failure = failed + killed + dead,
 * matching summary.failed. Workers in no lane form one `ungrouped` row, or null when there are none.
 */
export function laneHistory(lanes, workers, now = Date.now()) {
  const windowStart = now - DAY_MS;
  const today = workers.filter((worker) => worker.startedAt !== null && worker.startedAt >= windowStart);
  const rows = lanes.map((lane) => ({ name: clip(lane.name, 64), ...historyCounts(today.filter((worker) => laneMatches(lane, worker))) }));
  const rest = today.filter((worker) => !lanes.some((lane) => laneMatches(lane, worker)));
  const ungrouped = historyCounts(rest);
  return { windowStart, lanes: rows, ungrouped: ungrouped.succeeded || ungrouped.failed ? ungrouped : null };
}

/** Read the lane config; a missing file hides the panel and an invalid file is reported, never thrown. */
async function readLanes(path) {
  const file = await readTail(path, 256 * 1024);
  if (file.missing || file.unreadable || file.truncated) return { lanes: null, missing: Boolean(file.missing), invalid: !file.missing };
  const lanes = parseLanes(file.text);
  return { lanes, missing: false, invalid: lanes === null };
}

/** Read every `<owner>.jsonl` inbox file plus acks.jsonl under `<base>/inbox`; missing files read as empty. */
async function readInbox(base) {
  const dir = join(base, 'inbox');
  let names = [];
  try { names = (await readdir(dir, { withFileTypes: true })).filter((item) => item.isFile() && item.name.endsWith('.jsonl') && item.name !== 'acks.jsonl').map((item) => item.name); } catch { /* No inbox yet. */ }
  const rows = [];
  for (const name of names) {
    const owner = name.slice(0, -'.jsonl'.length);
    for (const row of parseJsonl((await readTail(join(dir, name))).text)) rows.push({ ...row, owner: typeof row.owner === 'string' && row.owner ? row.owner : owner });
  }
  const acksFile = await readTail(join(dir, 'acks.jsonl'));
  return { inbox: inboxByWorker(rows), acks: ackedWorkers(parseJsonl(acksFile.text)), inboxMissing: !names.length, acksMissing: Boolean(acksFile.missing) };
}

/** Build an allowlisted state snapshot. Raw logs, errors, event reasons and messages are omitted. */
export async function collectState({ base = join(homedir(), '.local/state/agent-outer-loop'), eventsPath = process.env.AGENT_EVENTS_JSONL, grokPath = process.env.GROK_RUNS_JSONL, lanesPath = process.env.AI_TEAM_MONITORING_LANES, now = Date.now(), processes = probeProcesses } = {}) {
  const workersPath = join(base, 'local-workers');
  let entries = [];
  let recordsUnavailable = false;
  try { entries = await readdir(workersPath, { withFileTypes: true }); } catch { recordsUnavailable = true; }
  const raw = [];
  let invalidRecords = 0;
  // Sequential reads bound open descriptors and memory even with a large worker history.
  for (const entry of entries.filter((item) => item.isDirectory())) {
    try {
      const source = await readTail(join(workersPath, entry.name, 'record.json'));
      if (source.truncated) throw new Error('oversized');
      const record = JSON.parse(source.text);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid');
      const recordDir = join(workersPath, entry.name);
      const log = await readTail(join(recordDir, 'stdout.log'));
      const specPath = insideRoot(workersPath, record.specFile);
      const spec = specPath ? await readHead(specPath) : '';
      const title = specTitle(spec);
      const summary = await taskSummary(record, { spec });
      const status = workerStatus(record, now);
      const heartbeat = heartbeatState(record, now);
      let failure = null;
      if (FAILURE_STATUSES.has(status)) {
        const { stderr, stdout } = recordedTail(record) ?? await fileTail(workersPath, recordDir, record, log.text);
        failure = { ...classifyFailure(record, { status, stderr, stdout, heartbeatStale: heartbeat.heartbeatStale }), logTail: logTail(stderr, stdout) };
      }
      raw.push({ ...record, _usage: usageFromRows(parseJsonl(log.text)), _truncated: log.truncated, _logUnreadable: Boolean(log.unreadable), _dir: entry.name,
        _status: status, _title: title, _taskSummary: summary, _failure: failure, _heartbeat: heartbeat });
    } catch { invalidRecords++; }
  }
  const retries = retryFlags(raw);
  const inboxState = await readInbox(base);
  const evidence = await completionEvidence(base);
  const completionRecords = [...raw, ...[...inboxState.inbox].filter(([id]) => !raw.some((record) => recordId(record) === id)).map(([id, entry]) => ({ ...entry, id }))];
  const completed = await completionFlags(completionRecords, { evidence, readOnlySucceeded });
  const awaiting = awaitingFlags(raw, { inbox: inboxState.inbox, acks: inboxState.acks, completed, evidence, now });
  const inbox = inboxView(raw, { inbox: inboxState.inbox, acks: inboxState.acks, awaiting, completed, evidence, now });
  const resolved = resolvedFlags(raw, { acks: inboxState.acks });
  const legacy = legacyFlags(raw, { inbox: inboxState.inbox });
  const knownPids = raw.flatMap((record) => [record.agentPid, record.launcherPid, record.pid]).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const untracked = await Promise.resolve().then(() => processes(knownPids)).catch(() => []);
  const workers = raw.map((record) => {
    const mergeWait = mergeWaitMetadata(record, evidence.get(recordId(record)));
    const status = mergeWait?.status ?? record._status;
    const startedAt = timestamp(record.startedAt);
    const finishedAt = timestamp(record.finishedAt);
    const updates = [record.heartbeatAt, record.lastLogAt, ...(Array.isArray(record.steps) ? record.steps.map((step) => step?.at) : [])].map(timestamp).filter((value) => value !== null);
    const lastUpdateAt = Math.max(startedAt ?? 0, ...updates);
    const end = finishedAt ?? (ACTIVE.has(record.status) && status === 'running' ? now : lastUpdateAt);
    const sourceSteps = (Array.isArray(record.steps) ? record.steps : []).filter((step) => step && timestamp(step.at) !== null).sort((a, b) => timestamp(a.at) - timestamp(b.at));
    const steps = sourceSteps.map((step, index) => {
      const at = timestamp(step.at);
      const next = timestamp(sourceSteps[index + 1]?.at) ?? Math.max(at, end);
      const to = sourceSteps[index + 1] ? stepName(sourceSteps[index + 1].name) : finishedAt !== null ? 'finish' : status === 'running' ? 'now' : status;
      return { name: stepName(step.name), to, at, durationSec: Math.max(0, next - at) / 1000 };
    });
    const postCheck = record.postCheck;
    // Only structured reason codes are accepted; prose could contain chat or credentials.
    const rawReasons = postCheck && typeof postCheck === 'object' ? (postCheck.reasonCodes ?? postCheck.reasons ?? []) : [];
    const reasons = (Array.isArray(rawReasons) ? rawReasons : [rawReasons]).filter((value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(value)).map(redact);
    const decision = typeof postCheck === 'object' && postCheck ? postCheck.decision ?? postCheck.status : postCheck;
    const issue = redact(record.issue);
    const branch = redact(record.branch ?? record.branchName);
    return { id: redact(record.id ?? record._dir), repo: redact(record.repo), issue, branch, title: record._title || issue || branch,
      taskSummary: record._taskSummary,
      merging: mergingMetadata(record.merging),
      mergeWait,
      kind: ['implementation', 'review', 'fix', 'task', 'issue', 'pr', 'test'].includes(record.kind) ? record.kind : null,
      agent: ['claude', 'codex', 'grok', 'agy'].includes(record.agent) ? record.agent : 'unknown', status, startedAt, finishedAt, lastUpdateAt,
      heartbeatAt: timestamp(record.heartbeatAt), ...record._heartbeat,
      elapsedSec: startedAt === null ? 0 : Math.max(0, end - startedAt) / 1000, elapsedEstimated: finishedAt === null && status !== 'running',
      exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null, signal: signalName(record.signal), failure: record._failure,
      steps, retry: retries.get(record), readOnly: record.mode === 'read-only', awaiting: awaiting.get(record),
      resolved: Boolean(completed.get(recordId(record))) || resolved.get(record), legacy: legacy.get(record),
      handoff: handoffMetadata(record, inboxState.inbox.get(recordId(record))),
      launcherPid: Number.isSafeInteger(record.launcherPid) ? record.launcherPid : null, agentPid: Number.isSafeInteger(record.agentPid) ? record.agentPid : null,
      postCheck: { decision: ['pass', 'passed', 'fail', 'failed', 'approved', 'rejected', 'accept', 'retry', 'skip', 'succeeded', 'no-changes'].includes(decision) ? decision : 'unavailable', reasons, omittedReasons: Math.max(0, (Array.isArray(rawReasons) ? rawReasons.length : 1) - reasons.length) },
      tokens: record._usage, usageTruncated: record._truncated, logUnreadable: record._logUnreadable };
  }).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const [eventsFile, alertsFile, handoffsFile, grokFile, asksFile] = await Promise.all([
    readTail(eventsPath || join(base, 'events.jsonl')), readTail(join(base, 'alerts.jsonl')), readTail(join(base, 'handoffs.jsonl')),
    readTail(grokPath || join(base, 'grok-runs.jsonl')), readTail(join(base, 'asks.jsonl')),
  ]);
  const grokRuns = grokWorkers(parseJsonl(grokFile.text), now);
  const grokResolved = grokResolvedFlags(grokRuns, { acks: inboxState.acks });
  workers.push(...grokRuns.map((worker) => ({ ...worker, readOnly: false, awaiting: null, resolved: grokResolved.get(worker), legacy: false })));
  workers.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const runningIds = new Set([
    ...raw.filter((record) => record._status === 'running').map((record) => record.id ?? record._dir),
    ...workers.filter((worker) => worker.status === 'running').map((worker) => worker.id),
  ]);
  const asks = openAsks(parseJsonl(asksFile.text), runningIds, now);
  const laneConfig = await readLanes(lanesPath || join(base, 'lanes.json'));
  const lanes = laneConfig.lanes && laneCoverage(laneConfig.lanes, workers, now)
    .map((coverage, index) => ({ ...coverage, timeline: laneTimeline(laneConfig.lanes[index], workers, now) }));
  const history = laneConfig.lanes && laneHistory(laneConfig.lanes, workers, now);
  const events = parseJsonl(eventsFile.text).map((row) => ({ ts: timestamp(row.ts), workerId: redact(row.workerId),
    type: /^[a-zA-Z0-9_.-]{1,48}$/.test(row.type) ? redact(row.type) : 'event',
    cli: ['codex', 'claude', 'grok'].includes(row.cli) ? row.cli : 'unknown', status: STATUSES.includes(row.status) ? row.status : 'unknown',
    elapsedSec: count(row.elapsedSec), tokens: typeof row.tokens === 'number' ? count(row.tokens) : null })).slice(-100);
  const handoffs = parseJsonl(handoffsFile.text).map((row) => ({ ts: timestamp(row.ts),
    from: ['claude', 'codex'].includes(row.from) ? row.from : 'agent', to: ['claude', 'codex'].includes(row.to) ? row.to : 'agent',
    kind: ['review', 'implementation', 'retry', 'handoff'].includes(row.kind) ? row.kind : 'handoff',
    taskKey: redact(row.taskKey), waitSec: count(row.waitSec) })).slice(-100);
  const byCli = {};
  for (const worker of workers) {
    if (worker.tokens === null) { byCli[worker.agent] ??= null; continue; }
    byCli[worker.agent] = mergeUsage(byCli[worker.agent] ?? emptyUsage(), worker.tokens);
  }
  const bottlenecks = workers.flatMap((worker, index) => worker.steps.map((step) => ({ workerIndex: index, name: step.name, to: step.to, durationSec: step.durationSec }))).sort((a, b) => b.durationSec - a.durationSec).slice(0, 5);
  return { generatedAt: now, workers, untracked, summary: { all: summarize(workers), day: summarize(workers.filter((worker) => worker.startedAt !== null && worker.startedAt >= now - DAY_MS)) },
    byCli, bottlenecks, events, handoffs, asks, inbox, lanes, laneHistory: history, alerts: { count: parseJsonl(alertsFile.text).length },
    sources: { lanesMissing: laneConfig.missing, lanesInvalid: laneConfig.invalid, inboxMissing: inboxState.inboxMissing, acksMissing: inboxState.acksMissing, asksMissing: Boolean(asksFile.missing), grokMissing: Boolean(grokFile.missing), grokUnreadable: Boolean(grokFile.unreadable), grokTruncated: grokFile.truncated, recordsUnavailable, invalidRecords, eventsMissing: Boolean(eventsFile.missing), handoffsMissing: Boolean(handoffsFile.missing), alertsMissing: Boolean(alertsFile.missing),
      eventsUnreadable: Boolean(eventsFile.unreadable), handoffsUnreadable: Boolean(handoffsFile.unreadable), alertsUnreadable: Boolean(alertsFile.unreadable),
      eventsTruncated: eventsFile.truncated, alertsTruncated: alertsFile.truncated, handoffsTruncated: handoffsFile.truncated } };
}

/** Serve fixed static assets, JSON and a shared two-second SSE stream on IPv4 loopback. */
export function createServer(options = {}) {
  const clients = new Set();
  let state;
  let updating = false;
  const refresh = async () => {
    if (updating) return;
    updating = true;
    try {
      state = await collectState(options);
      const message = `data: ${JSON.stringify(state)}\n\n`;
      for (const client of clients) {
        if (client.writableLength > 1024 * 1024) { client.destroy(); clients.delete(client); }
        else client.write(message);
      }
    } finally { updating = false; }
  };
  const ready = refresh();
  const timer = setInterval(() => { refresh().catch(() => {}); }, 2000);
  timer.unref();
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (!validHost(req.headers.host)) { res.writeHead(403); res.end('Forbidden host'); return; }
    if (req.headers.origin && ![ `http://${req.headers.host}` ].includes(req.headers.origin)) { res.writeHead(403); res.end('Forbidden origin'); return; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    const path = req.url?.split('?')[0];
    try {
      await ready;
      if (path === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(state)); return; }
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write(`retry: 2000\ndata: ${JSON.stringify(state)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (Object.hasOwn(assets, path)) {
        const [file, type] = assets[path];
        const content = await readFile(join(ROOT, 'public', file));
        res.writeHead(200, { 'Content-Type': type }); res.end(content); return;
      }
      res.writeHead(404); res.end('Not found');
    } catch { res.writeHead(500); res.end('State unavailable'); }
  });
  server.on('close', () => { clearInterval(timer); for (const client of clients) client.end(); });
  return server;
}

/** Validate the deliberately small command line interface. */
export function parsePort(args) {
  if (!args.length) return 4317;
  if (args.length !== 2 || args[0] !== '--port' || !/^[0-9]+$/.test(args[1]) || +args[1] < 1 || +args[1] > 65535) throw new Error('Usage: node server.mjs [--port 4317]');
  return +args[1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = parsePort(process.argv.slice(2));
    const server = createServer();
    server.on('error', (error) => { console.error(`Server error: ${error.code ?? 'unknown'}`); process.exitCode = 1; server.close(); });
    server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port} (pid ${process.pid})`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
