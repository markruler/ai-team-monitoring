/** Render metrics, the Issue timeline, the worker table and the worker detail dialog. */
import { date, duration, figure, money, number } from './lib/format.js';
import { $, el, svg } from './lib/dom.js';
import { state } from './store.js';
import { privacy } from './privacy.js';
import {
  FINISHED_STATUSES,
  UNPICKED_FAILURE_LABELS,
  awaitingText,
  extraFailureCodes,
  heartbeatAge,
  identity,
  intervalName,
  isRunningWorker,
  labels,
  mergeWaitText,
  owner,
  reasonCodeList,
  staleHeartbeatText,
  stepLabel,
} from './worker-text.js';
import { timeWindow, visibleWorkers, windowPrefix } from './time-window.js';

const USAGE_KEYS = ['costUsd', 'newInput', 'input', 'cacheWrite', 'cached', 'output', 'turns'];

/** Add usage figure by figure; a figure stays null only when neither side reported it. */
function mergeUsage(a, b) {
  return Object.fromEntries(USAGE_KEYS.map((key) => {
    const left = a[key] ?? null;
    const right = b[key] ?? null;
    return [key, left === null && right === null ? null : (left ?? 0) + (right ?? 0)];
  }));
}

/** Describe the secondary token figures; cache reads stay separate from new input. */
function usageBreakdown(usage) {
  return `새 입력 ${figure(usage.newInput)} · 캐시 읽기 ${figure(usage.cached)} · 출력 ${figure(usage.output)} · 턴 ${figure(usage.turns)}`;
}

/** Build the cost-first usage cell; cost is the headline and the sort value. */
function usageCell(worker) {
  if (worker.tokens === null) return el('td', '—');
  const cell = el('td', `${worker.usageTruncated ? '≥ ' : ''}${money(worker.tokens.costUsd)}`);
  cell.setAttribute('data-sort-value', worker.tokens.costUsd ?? '');
  cell.append(el('small', usageBreakdown(worker.tokens)));
  return cell;
}

export let selectedId;

/** Summarize a worker cohort with the same denominators as the server's `summarize`. */
function summarize(workers) {
  const counts = {};
  for (const worker of workers) counts[worker.status] = (counts[worker.status] ?? 0) + 1;
  const count = (status) => counts[status] ?? 0;
  const finished = FINISHED_STATUSES.reduce((total, status) => total + count(status), 0);
  const failed = count('failed') + count('killed') + count('dead');
  const eligible = workers.filter((worker) => worker.retry !== null && worker.retry !== undefined).length;
  const retries = workers.filter((worker) => worker.retry === true).length;
  return { counts, attempts: workers.length, finished, failed, failureRate: finished ? failed / finished : 0,
    awaiting: workers.filter((worker) => worker.awaiting).length,
    retries, retryEligible: eligible, retryUnknown: workers.length - eligible, retryRate: eligible ? retries / eligible : 0 };
}

/** Render the status cards and explicit rate denominators for the visible cohort. */
export function renderMetrics() {
  const summary = summarize(visibleWorkers());
  const prefix = windowPrefix(timeWindow);
  const target = $('#metrics');
  target.replaceChildren();
  for (const status of ['succeeded', 'no-changes', 'failed', 'killed', 'dead', 'canceled']) {
    const card = el('div', undefined, 'metric');
    card.append(el('span', `● ${labels[status]}`, `metric-label ${status}`), el('strong', number(summary.counts[status] ?? 0)), el('small', `${prefix} ATTEMPTS`));
    target.append(card);
  }
  const untracked = el('div', undefined, 'metric');
  untracked.append(el('span', `● ${labels['untracked running']}`, 'metric-label untracked'), el('strong', number((state.untracked ?? []).length)), el('small', 'LIVE PROCESSES'));
  target.append(untracked);
  for (const [title, rate, caption] of [
    ['실패율', summary.failureRate, `${summary.failed} / 완료 ${summary.finished} · 중단 포함`],
    ['재시도율', summary.retryRate, `${summary.retries} / 식별 ${summary.retryEligible} · 미확인 ${summary.retryUnknown}`],
  ]) {
    const card = el('div', undefined, 'metric');
    card.append(el('span', title, 'metric-label'), el('strong', `${(rate * 100).toFixed(1)}%`), el('small', caption));
    target.append(card);
  }
  $('#attempts').textContent = `${number(summary.attempts)}회 실행 · 시작 시각 기준 · 실행 중·다음 단계 대기는 항상 포함`;
}

/** Render an issue-grouped timeline with accessible clickable bars and step markers. */
export function renderTimeline(workers) {
  const target = $('#timeline');
  target.replaceChildren();
  const timed = workers.filter((worker) => worker.startedAt !== null);
  if (!timed.length) { target.append(el('div', '아직 표시할 실행 기록이 없습니다.', 'empty')); return; }
  const groups = new Map();
  for (const worker of timed) {
    const key = JSON.stringify([worker.repo, worker.issue]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(worker);
  }
  const start = Math.min(...timed.map((worker) => worker.startedAt));
  const end = Math.max(start + 60000, ...timed.map((worker) => worker.startedAt + worker.elapsedSec * 1000));
  const width = 1100;
  const left = 180;
  const scale = (value) => left + (value - start) / (end - start) * (width - left - 20);
  const height = 50 + timed.length * 38 + groups.size * 29;
  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Issue별 워커 실행 타임라인' });
  for (let i = 0; i <= 4; i++) {
    const time = start + (end - start) * i / 4;
    const x = scale(time);
    chart.append(svg('line', { x1: x, x2: x, y1: 30, y2: height, class: 'grid-line' }));
    chart.append(svg('text', { x, y: 17, 'text-anchor': i === 4 ? 'end' : 'start' }, new Date(time).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
  }
  let y = 52;
  let groupIndex = 0;
  for (const group of groups.values()) {
    groupIndex++;
    chart.append(svg('text', { x: 0, y, class: 'issue-label' }, privacy ? `ISSUE ${String(groupIndex).padStart(2, '0')}` : `${group[0].issue || 'Issue 없음'}`.slice(0, 28)));
    y += 21;
    for (const worker of group) {
      const index = state.workers.indexOf(worker);
      chart.append(svg('text', { x: 8, y: y + 13 }, `${identity(worker, index).slice(0, 21)} · ${worker.agent}`));
      const bar = svg('rect', { x: scale(worker.startedAt), y, width: Math.max(5, scale(worker.startedAt + worker.elapsedSec * 1000) - scale(worker.startedAt)), height: 22, rx: 4, class: `bar ${worker.status}`, tabindex: 0, role: 'button', 'aria-label': `${identity(worker, index)} ${labels[worker.status]} ${duration(worker.elapsedSec)}` });
      bar.append(svg('title', {}, `${labels[worker.status]} · ${duration(worker.elapsedSec)}`));
      bar.addEventListener('click', () => showDetail(worker.id));
      bar.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showDetail(worker.id); } });
      chart.append(bar);
      for (const step of worker.steps.filter((item) => ['preflight', 'worktree', 'agent-exit', 'post-check'].includes(item.name))) {
        const x = scale(Math.min(end, Math.max(start, step.at)));
        const marker = svg('path', { d: `M ${x} ${y + 6} l 4 5 l -4 5 l -4 -5 Z`, class: 'marker' });
        marker.append(svg('title', {}, step.name));
        chart.append(marker);
      }
      y += 38;
    }
    y += 8;
  }
  target.append(chart);
}

/** Render a live agent process that no worker record owns; only binary and subcommand are known. */
function untrackedRow(process) {
  const row = el('tr');
  const name = el('td', `PID ${process.pid}`);
  name.append(el('small', privacy ? '경로 숨김' : process.cwd || '경로 확인 불가'));
  const status = el('td');
  status.append(el('span', labels['untracked running'], 'status untracked'));
  row.append(name, el('td', `${process.binary} ${process.subcommand}`), status,
    el('td', process.elapsedSec === null ? '—' : duration(process.elapsedSec)), el('td', '—'), el('td', '—'), el('td'));
  return row;
}

const WORKER_FILTERS = ['all', 'running', 'attention', 'codex', 'claude', 'cursor'];
let workerFilter = 'all';

/** Return true when a worker belongs to the active inventory filter chip. */
function matchesWorkerFilter(worker) {
  if (workerFilter === 'all') return true;
  if (workerFilter === 'running') return isRunningWorker(worker);
  if (workerFilter === 'attention') {
    if (worker.resolved) return false;
    return Boolean(worker.awaiting || worker.mergeWait || worker.merging?.status === 'failed' || UNPICKED_FAILURE_LABELS[worker.status]);
  }
  return worker.agent === workerFilter;
}

/** Return true when an untracked live process belongs to the active inventory filter chip. */
function matchesUntrackedFilter(proc) {
  if (workerFilter === 'all' || workerFilter === 'running') return true;
  if (workerFilter === 'attention') return false;
  if (workerFilter === 'cursor') return proc.binary === 'cursor-agent';
  return proc.binary === workerFilter;
}

/** Render per-worker inventory and CLI usage for the selected cohort. */
export function renderWorkers(workers) {
  const target = $('#workers');
  target.replaceChildren();
  const filteredWorkers = workers.filter(matchesWorkerFilter);
  const filteredUntracked = (state.untracked ?? []).filter(matchesUntrackedFilter);
  for (const worker of filteredWorkers) {
    const row = el('tr');
    const name = el('td', identity(worker, state.workers.indexOf(worker)));
    name.append(el('small', owner(worker)));
    const status = el('td');
    const statusLabel = mergeWaitText(worker) || labels[worker.status] || labels.unknown;
    const statusBadge = el('span', statusLabel, `status ${worker.status}`);
    if (worker.mergeWait) statusBadge.setAttribute('title', statusLabel);
    status.append(statusBadge);
    if (worker.readOnly) status.append(el('span', '읽기 전용', 'read-only-badge'));
    if (worker.awaiting) status.append(el('span', awaitingText(worker.awaiting), 'awaiting-badge'));
    if (worker.heartbeatStale) status.append(el('span', staleHeartbeatText(worker), 'stale-badge'));
    if (worker.failure) {
      status.append(el('small', worker.failure.label, 'failure-reason'));
      const codes = extraFailureCodes(worker);
      if (codes.length) status.append(el('small', `사유 코드: ${codes.join(', ')}`, 'failure-codes'));
      if (!privacy && worker.failure.logTail.length) status.append(el('small', worker.failure.logTail.join('\n'), 'log-tail'));
    }
    const button = el('button', '상세 ↗');
    button.addEventListener('click', () => showDetail(worker.id));
    const action = el('td');
    action.append(button);
    row.append(name, el('td', worker.agent), status, el('td', `${worker.elapsedEstimated ? '≈ ' : ''}${duration(worker.elapsedSec)}`), el('td', worker.steps.length ? stepLabel(worker.steps.at(-1).name) : '—'), usageCell(worker), action);
    target.append(row);
  }
  for (const process of filteredUntracked) target.append(untrackedRow(process));
  if (!filteredWorkers.length && !filteredUntracked.length) {
    const row = el('tr');
    const cell = el('td', workerFilter === 'all' ? '이 기간의 실행 기록이 없습니다.' : '선택한 필터에 맞는 실행 기록이 없습니다.', 'empty');
    cell.colSpan = 7;
    row.append(cell);
    target.append(row);
  }
  $('#worker-count').textContent = workerFilter === 'all' ? `${workers.length} WORKERS` : `${filteredWorkers.length} / ${workers.length} WORKERS`;
  const totals = {};
  for (const worker of workers) {
    if (worker.tokens === null) { totals[worker.agent] ??= null; continue; }
    totals[worker.agent] = mergeUsage(totals[worker.agent] ?? {}, worker.tokens);
  }
  $('#tokens').replaceChildren();
  const truncated = workers.some((worker) => worker.usageTruncated);
  for (const agent of ['claude', 'codex', ...(Object.hasOwn(totals, 'grok') ? ['grok'] : []), ...(Object.hasOwn(totals, 'cursor') ? ['cursor'] : []), ...(Object.hasOwn(totals, 'gemini') ? ['gemini'] : []), ...(totals.unknown ? ['unknown'] : [])]) {
    const usage = mergeUsage(totals[agent] ?? {}, {});
    const noTokens = agent === 'grok' || (agent === 'cursor' && totals[agent] === null);
    const row = el('div', undefined, 'usage-row');
    const heading = el('div', undefined, 'usage-heading');
    heading.append(el('span', agent), el('strong', noTokens ? '—' : `${truncated && usage.costUsd !== null ? '≥ ' : ''}${money(usage.costUsd)}`));
    const fresh = (usage.newInput ?? 0) + (usage.output ?? 0);
    const chart = svg('svg', { viewBox: '0 0 500 8', 'aria-label': `${agent} 새 입력 대 출력 토큰 비율`, role: 'img', preserveAspectRatio: 'none' });
    chart.append(svg('rect', { width: 500, height: 8, rx: 4, fill: 'var(--usage-track)' }));
    chart.append(svg('rect', { width: fresh ? 500 * (usage.newInput ?? 0) / fresh : 0, height: 8, rx: 4, fill: agent === 'claude' ? 'var(--mint)' : 'var(--blue)' }));
    row.append(heading, chart, el('small', noTokens ? '토큰 미수집' : usageBreakdown(usage)));
    $('#tokens').append(row);
  }
  $('#bottlenecks').replaceChildren();
  const slow = workers.flatMap((worker) => worker.steps.map((step) => ({ worker, ...step }))).sort((a, b) => b.durationSec - a.durationSec).slice(0, 5);
  slow.forEach((step, index) => {
    const row = el('div', undefined, 'bottleneck');
    const name = intervalName(step);
    name.append(el('small', `${identity(step.worker, state.workers.indexOf(step.worker))} · ${step.worker.agent}`));
    name.append(el('small', [
      !privacy && step.worker.issue,
      !privacy && step.worker.taskSummary,
      labels[step.worker.status] ?? labels.unknown,
    ].filter(Boolean).join(' · ')));
    row.append(el('span', `0${index + 1}`, 'rank'), name, el('span', duration(step.durationSec), 'duration'));
    $('#bottlenecks').append(row);
  });
  if (!slow.length) $('#bottlenecks').append(el('div', '단계 기록이 없습니다.', 'empty'));
}

/** Populate the metadata-only detail panel, keeping it synchronized with SSE. */
export function showDetail(id, open = true) {
  selectedId = id;
  const index = state.workers.findIndex((worker) => worker.id === id);
  if (index < 0) { $('#detail').close(); return; }
  const worker = state.workers[index];
  const target = $('#detail-body');
  target.replaceChildren(el('p', identity(worker, index), 'eyebrow'));
  if (worker.readOnly) target.append(el('span', '읽기 전용', 'read-only-badge'));
  if (worker.awaiting) target.append(el('span', awaitingText(worker.awaiting), 'awaiting-badge'));
  if (worker.heartbeatStale) target.append(el('span', staleHeartbeatText(worker), 'stale-badge'));
  const list = el('dl');
  for (const [key, value] of [
    ['봇 / 작업', privacy ? '숨김' : owner(worker)],
    ['저장소', privacy ? '숨김' : worker.repo], ['Issue / Branch', privacy ? '숨김' : `${worker.issue} / ${worker.branch || '미기록'}`],
    ['CLI / 종류', worker.kind ? `${worker.agent} / ${worker.kind}` : worker.agent],
    ['상태 / 종료 코드 / 시그널', `${mergeWaitText(worker) || labels[worker.status] || labels.unknown} / ${worker.exitCode ?? '—'} / ${worker.signal ?? '—'}`],
    ...(worker.failure ? [['실패 사유', worker.failure.label]] : []),
    ['하트비트', `${heartbeatAge(worker)}${worker.heartbeatStale ? ' · 60초 초과 (끊김)' : ''}`],
    ['시작 / 종료', `${date(worker.startedAt)} / ${date(worker.finishedAt)}`], ['마지막 갱신', date(worker.lastUpdateAt)],
    ['소요 시간', `${worker.elapsedEstimated ? '종료 시각 추정: ' : ''}${duration(worker.elapsedSec)}`], ['PID (launcher / agent)', `${worker.launcherPid ?? '—'} / ${worker.agentPid ?? '—'}`],
    ['재시도', worker.retry === null ? 'branch 등 식별 정보 부족' : worker.retry ? '재실행' : '최초 실행'],
    ['비용 (total_cost_usd)', worker.tokens === null ? '—' : `${worker.usageTruncated ? '≥ ' : ''}${money(worker.tokens.costUsd)}`],
    ['토큰', worker.tokens === null ? '—' : `${usageBreakdown(worker.tokens)}${worker.tokens.cacheWrite === null ? '' : ` (새 입력 = 입력 ${figure(worker.tokens.input)} + 캐시 쓰기 ${figure(worker.tokens.cacheWrite)})`}`],
    ['Post-check', worker.postCheck.decision], ['사유 코드', reasonCodeList(worker).join(', ') || '기록 없음'],
  ]) list.append(el('dt', key), el('dd', value));
  target.append(list);
  if (worker.failure) {
    target.append(el('h3', '마지막 로그 (stderr, 없으면 stdout)', 'detail-section'));
    if (privacy) target.append(el('p', '이름 숨기기 중에는 로그를 표시하지 않습니다.', 'muted'));
    else if (worker.failure.logTail.length) target.append(el('pre', worker.failure.logTail.join('\n'), 'log-tail'));
    else target.append(el('p', '로그 기록 없음', 'muted'));
  }
  if (worker.postCheck.omittedReasons) target.append(el('p', '자유 형식 사유는 개인정보 보호를 위해 생략했습니다.', 'notice'));
  if (worker.usageTruncated) target.append(el('p', '로그 크기 제한으로 최근 32 MiB만 집계했습니다. 토큰은 하한값입니다.', 'notice'));
  if (worker.logUnreadable) target.append(el('p', '사용량 로그를 읽을 수 없습니다.', 'notice'));
  target.append(el('h3', '단계별 간격', 'detail-section'));
  for (const step of worker.steps) {
    const row = el('div', undefined, 'event');
    row.append(intervalName(step), el('small', date(step.at)), el('span', duration(step.durationSec)));
    target.append(row);
  }
  if (!worker.steps.length) target.append(el('p', '단계 기록 없음', 'muted'));
  if (open && !$('#detail').open) $('#detail').showModal();
}

/** Sync active state and aria-pressed on the worker inventory filter chips. */
function syncWorkerFilterControls() {
  for (const key of WORKER_FILTERS) {
    const button = $(`#filter-${key}`);
    button.classList.toggle('active', key === workerFilter);
    button.setAttribute('aria-pressed', String(key === workerFilter));
  }
}

/** Switch the worker inventory filter chip and re-render the table. */
function selectWorkerFilter(key) {
  if (!WORKER_FILTERS.includes(key)) return false;
  workerFilter = key;
  syncWorkerFilterControls();
  if (state) renderWorkers(visibleWorkers());
  return true;
}

/** Wire the worker filter chips and the detail dialog's close button. */
export function initWorkers() {
  syncWorkerFilterControls();
  for (const key of WORKER_FILTERS) $(`#filter-${key}`).addEventListener('click', () => selectWorkerFilter(key));
  $('#close-detail').addEventListener('click', () => $('#detail').close());
}
