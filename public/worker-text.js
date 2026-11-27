/** Shared worker vocabulary: status labels, step names, ages and owner text. */
import { age, clock, duration } from './lib/format.js';
import { el } from './lib/dom.js';
import { state } from './store.js';
import { privacy } from './privacy.js';

export const labels = { running: '실행 중', succeeded: '성공', 'no-changes': '변경 없음', failed: '실패', killed: '강제 종료', dead: '중단 감지', canceled: '취소', unknown: '미확인', 'untracked running': '미등록 실행 중' };
Object.assign(labels, { 'merge-conflict': '병합 충돌', queued: '파일 겹침 병합 대기' });
export const BOT_ROLE_LABELS = { manager: '매니저', coordinator: '코디네이터', routine: '루틴' };

const STEP_LABELS = { preflight: '사전 점검', worktree: '워크트리 준비', spec: '작업 명세',
  'agent-start': '에이전트 시작', 'agent-exit': '에이전트 종료', 'post-check': '사후 검사',
  'launcher-commit': '커밋', 'launcher-tests': '테스트', failed: '실패', 'dry-run': '모의 실행',
  finished: '완료', cleanup: '정리', starting: '시작', running: '실행', killed: '강제 종료',
  unrecognized: '알 수 없는 단계', finish: '종료', now: '현재' };

export const ALWAYS_SHOWN_STATUSES = new Set(['running', 'starting']);
export const FINISHED_STATUSES = ['succeeded', 'no-changes', 'failed', 'killed', 'dead', 'canceled'];

/** Label a step key in Korean; a status ends the last interval and unknown keys stay raw. */
export function stepLabel(name) {
  if (name === undefined || name === null || name === '') return '종료';
  if (Object.hasOwn(STEP_LABELS, name)) return STEP_LABELS[name];
  return Object.hasOwn(labels, name) ? labels[name] : String(name);
}

/** Name the interval using both endpoints, retaining unknown transitions explicitly. */
function intervalLabel(step) {
  const key = `${step.name}→${step.to}`;
  const intervals = {
    'preflight→worktree': '사전 점검', 'worktree→spec': '워크트리 준비',
    'spec→agent-exit': '에이전트 실행', 'agent-exit→post-check': '사후 검사',
    'post-check→finish': '마무리',
  };
  return intervals[key] ?? `${stepLabel(step.name)} → ${stepLabel(step.to)}`;
}

/** Keep the exact allowlisted interval key below its readable label. */
export function intervalName(step) {
  const name = el('div', intervalLabel(step));
  const to = step.to ?? 'finish';
  name.append(el('small', `${step.name} → ${to === 'finish' ? '(finish)' : to}`));
  return name;
}

/** Add an available failure or wait instant beside its snapshot age. */
export function attentionTime(value, label, now) {
  const time = clock(value);
  return time ? ` · ${time} ${label}${typeof now === 'number' ? ` · ${age((now - value) / 1000)}` : ''}` : '';
}

/** Describe who should pick up an awaiting worker and how long it has waited; the owner is hidden in privacy mode. */
export function awaitingText(awaiting) {
  return `다음 단계 대기 · ${privacy ? '담당 숨김' : awaiting.owner} · ${age(awaiting.ageSec)}`;
}

/** Describe immediate merge conflicts and file-overlap waits without exposing private details. */
export function mergeWaitText(worker) {
  const wait = worker.mergeWait;
  if (!wait) return '';
  if (wait.status === 'merge-conflict') return `병합 충돌${wait.detail ? ` · ${privacy ? '파일 숨김' : wait.detail}` : ''}`;
  return privacy ? '파일 겹침 병합 대기' : wait.detail;
}

/** Show the bot or CLI and the task title, hidden in privacy mode. */
export function owner(worker) {
  if (privacy) return '봇 / 작업 숨김';
  const who = worker.bot || (worker.agent && worker.agent !== 'unknown' ? worker.agent : labels.unknown);
  return `${who} / ${worker.task || worker.title || worker.issue || worker.branch || '제목 없음'}`;
}

/** Seconds since the last heartbeat, preferring the server's age so every view agrees. */
function heartbeatSeconds(worker) {
  return worker.heartbeatAgeSec ?? Math.max(0, (state.generatedAt - worker.heartbeatAt) / 1000);
}

/** Describe the time since the last heartbeat. */
export function heartbeatAge(worker) {
  if (worker.heartbeatAt === null || worker.heartbeatAt === undefined) return '하트비트 기록 없음';
  return `하트비트 ${duration(heartbeatSeconds(worker))} 전`;
}

/** Label a running/starting worker whose heartbeat is past the 60-second threshold, with its age. */
export function staleHeartbeatText(worker) {
  return `하트비트 끊김 · ${duration(heartbeatSeconds(worker))} 전`;
}

/** List raw reason codes (post-check, then failure) once each; codes are not names, so privacy keeps them. */
export function reasonCodeList(worker) {
  return [...new Set([...(worker.postCheck?.reasons ?? []), ...(worker.failure?.codes ?? [])])];
}

/** Codes the failure label does not already spell out, e.g. `dirty-worktree` behind `작업 트리 미정리`. */
export function extraFailureCodes(worker) {
  return reasonCodeList(worker).filter((code) => !worker.failure.label.includes(code));
}

/** Hide worker identifiers when privacy is enabled. */
export function identity(worker, index) {
  return privacy ? `워커 ${String(index + 1).padStart(2, '0')}` : worker.id;
}

const ACTIVE_STATUSES = new Set(['running', 'starting']);

/** Classify live work with merge lifecycle taking precedence over the attempt status. */
export function isRunningWorker(worker) {
  if (worker.mergeWait) return false;
  if (worker.merging?.status === 'merging') return true;
  if (worker.merging?.status === 'failed') return false;
  if (worker.merging?.status === 'merged' && worker.resolved) return false;
  return ACTIVE_STATUSES.has(worker.status);
}

/** Harness local workers and Codex/Claude/agy CLI runs; Grok bot and Cursor sessions belong in bot or inventory views. */
export function isDashboardWorker(worker) {
  const id = String(worker?.id ?? '');
  const kind = worker?.cli ?? worker?.agent ?? '';
  if (kind === 'grok' || id.startsWith('grok:')) return false;
  if (kind === 'cursor' || id.startsWith('cursor:')) return false;
  return true;
}

export const UNPICKED_FAILURE_LABELS = { failed: '실패', killed: '강제 종료' };
