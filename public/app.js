/** Apply the saved or system theme before the body can paint. */
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let savedTheme;
try { savedTheme = localStorage.getItem('theme'); } catch { /* System preference remains available without storage. */ }
if (!['light', 'dark'].includes(savedTheme)) savedTheme = null;
document.documentElement.dataset.theme = savedTheme ?? (systemTheme.matches ? 'dark' : 'light');

/** Synchronize the root theme and accessible toggle state. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const button = document.querySelector('#theme-toggle');
  button.setAttribute('aria-pressed', String(theme === 'dark'));
}

/** Render local allowlisted telemetry with DOM text nodes and inline SVG only. */
const $ = (selector) => document.querySelector(selector);
const NS = 'http://www.w3.org/2000/svg';
const number = (value) => new Intl.NumberFormat('ko-KR').format(Math.round(value ?? 0));
const USAGE_KEYS = ['costUsd', 'newInput', 'input', 'cacheWrite', 'cached', 'output', 'turns'];

/** Format a reported figure, or an em dash when the CLI never reported it. */
function figure(value) {
  return value === null || value === undefined ? '—' : number(value);
}

/** Format the CLI-reported total_cost_usd; an unreported cost is an em dash, never $0. */
function money(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

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
const labels = { running: '실행 중', succeeded: '성공', 'no-changes': '변경 없음', failed: '실패', killed: '강제 종료', dead: '중단 감지', canceled: '취소', unknown: '미확인', 'untracked running': '미등록 실행 중' };
Object.assign(labels, { 'merge-conflict': '병합 충돌', queued: '파일 겹침 병합 대기' });
const STEP_LABELS = { preflight: '사전 점검', worktree: '워크트리 준비', spec: '작업 명세',
  'agent-start': '에이전트 시작', 'agent-exit': '에이전트 종료', 'post-check': '사후 검사',
  'launcher-commit': '커밋', 'launcher-tests': '테스트', failed: '실패', 'dry-run': '모의 실행',
  finished: '완료', cleanup: '정리', starting: '시작', running: '실행', killed: '강제 종료',
  unrecognized: '알 수 없는 단계', finish: '종료', now: '현재' };
const HOUR_MS = 3600000;
const WINDOW_PRESETS = ['1h', '3h', '6h', '12h', '24h', 'all'];
const DEFAULT_WINDOW = '3h';
const WINDOW_STORAGE_KEY = 'window';
const ALWAYS_SHOWN_STATUSES = new Set(['running', 'starting']);
const FINISHED_STATUSES = ['succeeded', 'no-changes', 'failed', 'killed', 'dead', 'canceled'];
let state;
let timeWindow = DEFAULT_WINDOW;
let privacy = false;
let selectedId;

/** Create a safe text-only DOM element. */
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Create an SVG node with explicit attributes. */
function svg(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Format durations without exposing source text. */
function duration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${Math.round(seconds % 60)}초`;
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
}

/** Label a step key in Korean; a status ends the last interval and unknown keys stay raw. */
function stepLabel(name) {
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
function intervalName(step) {
  const name = el('div', intervalLabel(step));
  const to = step.to ?? 'finish';
  name.append(el('small', `${step.name} → ${to === 'finish' ? '(finish)' : to}`));
  return name;
}

/** Format existing timestamps as a KST 24-hour clock. */
function date(value) {
  return clock(value) ?? '—';
}

/** Return HH:MM:SS in Seoul, leaving unavailable timestamps empty. */
function clock(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

/** Add an available failure or wait instant beside its snapshot age. */
function attentionTime(value, label, now) {
  const time = clock(value);
  return time ? ` · ${time} ${label}${typeof now === 'number' ? ` · ${age((now - value) / 1000)}` : ''}` : '';
}

/** Format an elapsed age coarsely, e.g. `12분`, `2시간 5분`, `3일`. */
function age(seconds) {
  const minutes = Math.floor(Math.max(0, seconds ?? 0) / 60);
  if (minutes < 60) return `${minutes}분`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
  return `${Math.floor(minutes / 1440)}일`;
}

/** Describe who should pick up an awaiting worker and how long it has waited; the owner is hidden in privacy mode. */
function awaitingText(awaiting) {
  return `다음 단계 대기 · ${privacy ? '담당 숨김' : awaiting.owner} · ${age(awaiting.ageSec)}`;
}

/** Describe immediate merge conflicts and file-overlap waits without exposing private details. */
function mergeWaitText(worker) {
  const wait = worker.mergeWait;
  if (!wait) return '';
  if (wait.status === 'merge-conflict') return `병합 충돌${wait.detail ? ` · ${privacy ? '파일 숨김' : wait.detail}` : ''}`;
  return privacy ? '파일 겹침 병합 대기' : wait.detail;
}

/** Show the bot or CLI and the task title, hidden in privacy mode. */
function owner(worker) {
  if (privacy) return '봇 / 작업 숨김';
  const who = worker.bot || (worker.agent && worker.agent !== 'unknown' ? worker.agent : labels.unknown);
  return `${who} / ${worker.task || worker.title || worker.issue || worker.branch || '제목 없음'}`;
}

/** Seconds since the last heartbeat, preferring the server's age so every view agrees. */
function heartbeatSeconds(worker) {
  return worker.heartbeatAgeSec ?? Math.max(0, (state.generatedAt - worker.heartbeatAt) / 1000);
}

/** Describe the time since the last heartbeat. */
function heartbeatAge(worker) {
  if (worker.heartbeatAt === null || worker.heartbeatAt === undefined) return '하트비트 기록 없음';
  return `하트비트 ${duration(heartbeatSeconds(worker))} 전`;
}

/** Label a running/starting worker whose heartbeat is past the 60-second threshold, with its age. */
function staleHeartbeatText(worker) {
  return `하트비트 끊김 · ${duration(heartbeatSeconds(worker))} 전`;
}

/** List raw reason codes (post-check, then failure) once each; codes are not names, so privacy keeps them. */
function reasonCodeList(worker) {
  return [...new Set([...(worker.postCheck?.reasons ?? []), ...(worker.failure?.codes ?? [])])];
}

/** Codes the failure label does not already spell out, e.g. `dirty-worktree` behind `작업 트리 미정리`. */
function extraFailureCodes(worker) {
  return reasonCodeList(worker).filter((code) => !worker.failure.label.includes(code));
}

/** Hide worker identifiers when privacy is enabled. */
function identity(worker, index) {
  return privacy ? `워커 ${String(index + 1).padStart(2, '0')}` : worker.id;
}

/** Normalize `all` or a positive integer hour count like `5h`/`5`; anything else is null. */
function parseWindow(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'all') return 'all';
  const match = /^(\d+)h?$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  return Number.isSafeInteger(hours) && hours > 0 ? `${hours}h` : null;
}

/** Window length in milliseconds, or null for the full period. */
function windowMs(key) {
  return key === 'all' ? null : Number.parseInt(key, 10) * HOUR_MS;
}

/** Summary card prefix, e.g. `3H` or `ALL`. */
function windowPrefix(key) {
  return key === 'all' ? 'ALL' : key.toUpperCase();
}

/** True when a timestamp falls inside the selected window ending at the snapshot time. */
function inWindow(timestamp) {
  const span = windowMs(timeWindow);
  if (span === null) return true;
  return timestamp !== null && timestamp !== undefined && timestamp >= state.generatedAt - span;
}

/** Running and awaiting workers stay visible in every window; others follow their start time. */
function visibleWorkers() {
  return state.workers.filter((worker) => ALWAYS_SHOWN_STATUSES.has(worker.status) || Boolean(worker.awaiting) || Boolean(worker.mergeWait) || inWindow(worker.startedAt));
}

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
function renderMetrics() {
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
function renderTimeline(workers) {
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

/** Render per-worker inventory and CLI usage for the selected cohort. */
function renderWorkers(workers) {
  const target = $('#workers');
  target.replaceChildren();
  for (const worker of workers) {
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
  for (const process of state.untracked ?? []) target.append(untrackedRow(process));
  if (!workers.length && !(state.untracked ?? []).length) { const row = el('tr'); const cell = el('td', '이 기간의 실행 기록이 없습니다.', 'empty'); cell.colSpan = 7; row.append(cell); target.append(row); }
  $('#worker-count').textContent = `${workers.length} WORKERS`;
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
function showDetail(id, open = true) {
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

/** Render optional metadata feeds; messages and free-form reasons are never present. */
function renderFeeds() {
  for (const [selector, rows, missing] of [
    ['#events', state.events, state.sources.eventsMissing], ['#handoffs', state.handoffs, state.sources.handoffsMissing],
  ]) {
    const target = $(selector);
    target.replaceChildren();
    const selected = rows.filter((row) => inWindow(row.ts));
    for (const row of [...selected].reverse().slice(0, 6)) {
      const line = el('div', undefined, 'event');
      if (selector === '#events') line.append(el('span', `${row.type} · ${row.cli} · ${labels[row.status]}`), el('small', `${duration(row.elapsedSec)} · ${date(row.ts)}`));
      else line.append(el('span', `${row.from} → ${row.to}${!privacy && row.taskKey ? ` · ${row.taskKey}` : ''}`), el('small', `대기 ${duration(row.waitSec)} · ${date(row.ts)}`));
      target.append(line);
    }
    if (!selected.length) target.append(el('div', missing ? '선택 입력 파일이 아직 없습니다.' : '표시할 기록이 없습니다.', 'empty'));
  }
}

/** List open asks; an ask without a running worker is red. Titles and owners are hidden in privacy mode. */
function renderAsks() {
  const target = $('#asks');
  target.replaceChildren();
  for (const ask of state.asks ?? []) {
    const row = el('div', undefined, ask.unstaffed ? 'event ask ask-unstaffed' : 'event ask');
    row.append(el('span', privacy ? '질문 숨김' : ask.title || ask.id),
      el('small', `${privacy ? '담당 숨김' : ask.owner} · ${ask.ageSec === null ? '생성 시각 없음' : `${age(ask.ageSec)} 전`}`));
    target.append(row);
  }
}

/** Name an inbox item's worker and repo/issue, hidden in privacy mode. */
function inboxTarget(item) {
  return privacy ? '워커 / Issue 숨김' : `${item.workerId} · ${item.repo} ${item.issue}`.trim();
}

/** Render one pending inbox item; awaiting items reuse the red `다음 단계 대기` badge. */
function pendingInboxRow(item) {
  const row = el('div', undefined, item.awaiting ? 'event inbox-item inbox-awaiting' : 'event inbox-item');
  const name = el('span', inboxTarget(item));
  if (item.awaiting) name.append(el('span', awaitingText(item), 'awaiting-badge'));
  const parts = [privacy ? '담당 숨김' : item.owner, labels[item.status] ?? labels.unknown,
    ...(item.reason ? [item.reason] : []), ...(item.mergeWait ? [mergeWaitText(item)] : item.detail ? [[item.blocker, privacy ? '이유 숨김' : item.detail].filter(Boolean).join(' · ')] : []), item.ageSec === null ? '종료 시각 없음' : `${age(item.ageSec)} 전`];
  row.append(name, el('small', parts.join(' · ')));
  return row;
}

/** Render one acked inbox item as a muted, folded line that needs no action. */
function ackedInboxRow(item) {
  const row = el('div', undefined, 'event inbox-acked');
  const parts = [`처리 ${date(item.ackedAt)}`, ...(privacy ? [] : [item.by, ...(item.nextWorkerId ? [`다음 ${item.nextWorkerId}`] : [])])];
  row.append(el('span', inboxTarget(item)), el('small', parts.filter(Boolean).join(' · ')));
  return row;
}

/** List pending inbox items first, then acked items folded below; nothing is rendered when the inbox is empty. */
function renderInbox() {
  const target = $('#inbox');
  target.replaceChildren();
  const { pending = [], acked = [] } = state.inbox ?? {};
  for (const item of pending) target.append(pendingInboxRow(item));
  if (!acked.length) return;
  const folded = el('details', undefined, 'inbox-acked-list');
  folded.append(el('summary', `처리됨 ${acked.length}건`), ...acked.map(ackedInboxRow));
  target.append(folded);
}

/** Show each lane's running count; a lane at 0 is red with its time at 0. The panel is hidden without a config. */
function renderLanes() {
  const panel = $('#lanes');
  panel.replaceChildren();
  panel.hidden = !Array.isArray(state.lanes) || !state.lanes.length;
  if (panel.hidden) return;
  state.lanes.forEach((lane, index) => {
    const zero = lane.running === 0;
    const card = el('div', undefined, zero ? 'lane lane-zero' : 'lane');
    const name = privacy ? `레인 ${String(index + 1).padStart(2, '0')}` : lane.name;
    const caption = zero ? `실행 중 워커 없음 · ${lane.zeroSec === null ? '0 지속 시간 알 수 없음' : `${age(lane.zeroSec)}째 0`}` : '실행 중';
    card.append(el('span', name, 'metric-label'), el('strong', number(lane.running)), el('small', caption));
    if (lane.timeline) card.append(laneTimelineChart(lane.timeline, name));
    panel.append(card);
  });
}

/** Draw today's healthy running count as a step chart; periods at 0 are a red baseline so gaps stay visible. */
function laneTimelineChart(timeline, name) {
  const width = 240;
  const height = 26;
  const span = Math.max(1, timeline.to - timeline.from);
  const top = Math.max(1, timeline.max);
  const zeroes = timeline.segments.filter((segment) => segment.count === 0).length;
  const wrap = el('div', undefined, 'lane-timeline');
  const chart = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `${name} 오늘 실행 중 워커 수 타임라인, 현재 ${timeline.current}, 0 구간 ${zeroes}개`,
  });
  for (const segment of timeline.segments) {
    const x = (segment.from - timeline.from) / span * width;
    const w = Math.max(0.5, (segment.to - segment.from) / span * width);
    const h = segment.count ? 4 + (height - 6) * segment.count / top : 3;
    const rect = svg('rect', { x, y: height - h, width: w, height: h, class: segment.count ? 'lane-busy' : 'lane-idle' });
    rect.append(svg('title', {}, `${clock(segment.from)}–${clock(segment.to)} · ${segment.count}개`));
    chart.append(rect);
  }
  const summary = `오늘 ${clock(timeline.from)}–${clock(timeline.to)} · 현재 ${timeline.current} · 최대 ${timeline.max} · 0 구간 ${zeroes}개`;
  wrap.append(chart, el('small', summary));
  return wrap;
}

/** Render one history row: success/failure counts and a compact failure-reason breakdown (codes only). */
function laneHistoryRow(name, row) {
  const line = el('div', undefined, row.failed ? 'event lane-history lane-history-failed' : 'event lane-history');
  line.append(el('span', name), el('small', `성공 ${number(row.succeeded)} · 실패 ${number(row.failed)}`));
  if (row.reasons.length) line.append(el('small', row.reasons.map((reason) => `${reason.label} ${number(reason.count)}`).join(' · '), 'failure-reason'));
  return line;
}

/** Show today's (24h) succeeded/failed counts and failure reasons per lane; hidden without a lane config. */
function renderLaneHistory() {
  const panel = $('#lane-history');
  const target = $('#lane-history-body');
  target.replaceChildren();
  const history = state.laneHistory;
  panel.hidden = !history || !Array.isArray(history.lanes) || (!history.lanes.length && !history.ungrouped);
  if (panel.hidden) return;
  history.lanes.forEach((lane, index) => {
    target.append(laneHistoryRow(privacy ? `레인 ${String(index + 1).padStart(2, '0')}` : lane.name, lane));
  });
  if (history.ungrouped) target.append(laneHistoryRow('기타 (레인 없음)', history.ungrouped));
}

const ACTIVE_STATUSES = new Set(['running', 'starting']);
const FAVICON_COLORS = { red: '#e5484d', blue: '#3b82f6', green: '#22a06b' };

/** Classify live work with merge lifecycle taking precedence over the attempt status. */
function isRunningWorker(worker) {
  if (worker.mergeWait) return false;
  if (worker.merging?.status === 'merging') return true;
  if (worker.merging?.status === 'failed') return false;
  if (worker.merging?.status === 'merged' && worker.resolved) return false;
  return ACTIVE_STATUSES.has(worker.status);
}

/** Count tracked workers that are running, starting or merging; untracked processes are excluded. */
function runningCount(snapshot) {
  return (snapshot.workers ?? []).filter(isRunningWorker).length;
}

const UNPICKED_FAILURE_LABELS = { failed: '실패', killed: '강제 종료' };

/** Name a worker for the tab tooltip by issue and worker id; hidden in privacy mode. */
function alertTarget(worker) {
  if (privacy) return '워커 숨김';
  return worker.issue ? `${worker.issue} (${worker.id})` : worker.id;
}

/** Alert on merge failures, unhandled attempt failures and owner handoffs older than 30 minutes. */
function workerAlert(worker) {
  if (worker.mergeWait && !worker.resolved) return `${alertTarget(worker)} · ${mergeWaitText(worker)}`;
  if (worker.merging?.status === 'merging') return null;
  if (worker.merging?.status === 'failed') return `${alertTarget(worker)} 병합 실패: ${worker.merging.reason || '사유 없음'}`;
  if (worker.resolved) return null;
  const failure = UNPICKED_FAILURE_LABELS[worker.status];
  if (failure) return `${alertTarget(worker)} ${failure} 미처리`;
  if (worker.awaiting?.ageSec > 30 * 60) return `${alertTarget(worker)} 다음 단계 대기 ${age(worker.awaiting.ageSec)}`;
  return null;
}

/** Name an open ask for the tab tooltip by id and title; numbered instead in privacy mode. */
function askAlert(ask, index) {
  if (privacy) return `승인 대기 질문 ${String(index + 1).padStart(2, '0')}`;
  return `승인 대기 ${ask.title ? `${ask.id} ${ask.title}` : ask.id}`;
}

/** List user decisions, unhandled failures, empty lanes and owner waits beyond 30 minutes. */
function currentAlerts(snapshot) {
  const lanes = (snapshot.lanes ?? []).flatMap((lane, index) => {
    if (lane.running !== 0) return [];
    return [`레인 ${privacy ? String(index + 1).padStart(2, '0') : lane.name} 실행 0`];
  });
  const workers = (snapshot.workers ?? []).map(workerAlert).filter(Boolean);
  const asks = (snapshot.asks ?? []).map(askAlert);
  return [...lanes, ...workers, ...asks];
}

/** Pick the tab icon color: red for any open item, then blue while a tracked worker runs, else green. */
function faviconColor(snapshot) {
  if (currentAlerts(snapshot).length) return 'red';
  return runningCount(snapshot) ? 'blue' : 'green';
}

/** Short open-item summary for the tab and header tooltip, e.g. `열린 항목 5건`; empty when nothing is open. */
function alertSummary(snapshot) {
  const total = currentAlerts(snapshot).length;
  return total ? `열린 항목 ${number(total)}건` : '';
}

/** Format the document title with the running worker count; while red, a red mark leads and only the short summary follows. */
function documentTitle(snapshot) {
  const summary = alertSummary(snapshot);
  const base = `(${runningCount(snapshot)}) AI 팀 모니터링`;
  return summary ? `🔴 ${base} · ${summary}` : base;
}

/** Build an inline SVG favicon data URL filled with the given status color. */
function faviconHref(color) {
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${FAVICON_COLORS[color]}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(icon)}`;
}

/** Reflect the snapshot status in the tab icon, title and header indicator; only the short summary, never the list. */
function renderTabStatus() {
  const total = currentAlerts(state).length;
  const summary = alertSummary(state);
  document.title = documentTitle(state);
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) {
    icon.setAttribute('href', faviconHref(faviconColor(state)));
    icon.setAttribute('title', summary);
  }
  $('#alert-status').hidden = !total;
  const trigger = $('#alert-trigger');
  trigger.textContent = total ? `● ${number(total)}` : '';
  trigger.setAttribute('aria-label', summary);
  $('#alert-tooltip').textContent = total ? `${summary} · 목록은 '살펴볼 항목' 패널에서 확인` : '';
}

const TOOLTIP_MARGIN = 8;
const TOOLTIP_MAX_WIDTH = 320;
const TOOLTIP_MAX_HEIGHT = 240;
const TOOLTIP_MIN_HEIGHT = 40;
const TOOLTIP_OBSTACLES = ['header', '.toolbar', '#lanes', '#metrics'];

/** Vertical viewport bands, top to bottom, that no obstacle rectangle overlaps; empty rectangles are ignored. */
function freeBands(obstacles, viewportHeight) {
  const blocked = obstacles.filter((rect) => rect && rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight).sort((a, b) => a.top - b.top);
  const bands = [];
  let cursor = 0;
  for (const rect of blocked) {
    if (rect.top > cursor) bands.push({ top: cursor, bottom: rect.top });
    cursor = Math.max(cursor, rect.bottom);
  }
  if (cursor < viewportHeight) bands.push({ top: cursor, bottom: viewportHeight });
  return bands;
}

/**
 * Place the tooltip inside the viewport in a band that no obstacle (header, window controls, lanes, summary cards)
 * touches; obstacles block their full width, so no horizontal overlap is possible. Prefers the first roomy band below
 * the anchor, else the tallest band. Returns { top, left, width, maxHeight } in viewport pixels, or null when no band fits.
 */
function tooltipPlacement(anchor, obstacles, viewport) {
  const width = Math.max(0, Math.min(TOOLTIP_MAX_WIDTH, viewport.width - 2 * TOOLTIP_MARGIN));
  const left = Math.max(TOOLTIP_MARGIN, Math.min(anchor.right - width, viewport.width - width - TOOLTIP_MARGIN));
  const bands = freeBands(obstacles, viewport.height)
    .map((band) => ({ top: band.top + TOOLTIP_MARGIN, bottom: band.bottom - TOOLTIP_MARGIN }))
    .filter((band) => band.bottom > band.top);
  if (!bands.length) return null;
  const height = (band) => band.bottom - band.top;
  const below = bands.find((band) => band.top >= anchor.top && height(band) >= TOOLTIP_MIN_HEIGHT);
  const band = below ?? bands.reduce((best, item) => (height(item) > height(best) ? item : best));
  return { top: band.top, left, width, maxHeight: Math.min(TOOLTIP_MAX_HEIGHT, height(band)) };
}

/** Read an element's viewport rectangle, or null when it is missing or not laid out. */
function viewportRect(selector) {
  return document.querySelector(selector)?.getBoundingClientRect?.() ?? null;
}

/** Move the header tooltip next to its trigger without covering the header, window controls or summary cards. */
function positionAlertTooltip() {
  const tooltip = $('#alert-tooltip');
  const anchor = viewportRect('#alert-trigger');
  if (!anchor) return;
  const viewport = { width: globalThis.innerWidth ?? 0, height: globalThis.innerHeight ?? 0 };
  const place = tooltipPlacement(anchor, TOOLTIP_OBSTACLES.map(viewportRect), viewport);
  tooltip.hidden = !place;
  if (!place) return;
  Object.assign(tooltip.style, { top: `${place.top}px`, left: `${place.left}px`, width: `${place.width}px`, maxHeight: `${place.maxHeight}px` });
}

/** Append an available worker task summary as one line, respecting privacy mode. */
function appendTaskSummary(item, worker) {
  if (!privacy && worker?.taskSummary) item.append(el('span', worker.taskSummary, 'task-summary'));
  return item;
}

/** Render an open item with its metadata and optional worker task summary. */
function attentionItem(text, worker) {
  const severity = worker?.awaiting?.ageSec > 1800 ? ' attention-red' : worker?.awaiting?.ageSec > 600 ? ' attention-orange' : '';
  const item = el('li', text, `attention-item${severity}`);
  item.setAttribute('title', !privacy && worker?.taskSummary ? `${text}\n${worker.taskSummary}` : text);
  return appendTaskSummary(item, worker);
}

/** Describe a pending handoff with timestamp, age and owner before the possibly long blocker detail. */
function pendingHandoffText(worker) {
  const handoff = worker.handoff ?? { owner: worker.awaiting.owner, nextStep: 'merge' };
  const reasons = { merge: '병합 대기', verify: '검증 대기', deploy: '배포 대기' };
  const reason = reasons[handoff.nextStep] ?? '다음 단계 대기';
  const ownerName = privacy ? '담당 숨김' : handoff.owner;
  const detail = privacy ? '이유 숨김' : [worker.awaiting.blocker, worker.awaiting.detail || '이유 없음'].filter(Boolean).join(' · ');
  const time = clock(worker.awaiting.finishedAt);
  return `${reason}${time ? ` · ${time} 대기 시작` : ''} · ${age(worker.awaiting.ageSec)} · ${ownerName} · ${detail}`;
}

/** Collect attention and pending handoffs together, visiting each worker only once. */
function attentionItems(snapshot) {
  const lanes = (snapshot.lanes ?? []).flatMap((lane, index) => (
    lane.running === 0
      ? [{ text: `레인 ${privacy ? String(index + 1).padStart(2, '0') : lane.name} 실행 0${attentionTime(lane.lastFinishedAt, '중단', snapshot.generatedAt)}` }]
      : []
  ));
  const workers = (snapshot.workers ?? []).flatMap((worker) => {
    if (worker.mergeWait && !worker.resolved) {
      return [{ text: `${alertTarget(worker)}${attentionTime(worker.awaiting?.finishedAt ?? worker.finishedAt, '대기 시작', snapshot.generatedAt)} · ${mergeWaitText(worker)}`, worker }];
    }
    if (worker.merging?.status === 'merging') return [];
    if (worker.merging?.status === 'failed') {
      return [{ text: `${alertTarget(worker)}${attentionTime(worker.merging.finishedAt ?? worker.finishedAt, '실패', snapshot.generatedAt)} · 병합 실패: ${worker.merging.reason || '사유 없음'}`, worker }];
    }
    if (worker.resolved) return [];
    const alert = workerAlert(worker);
    if (!alert && !worker.awaiting) return [];
    const failure = UNPICKED_FAILURE_LABELS[worker.status];
    let text = alert;
    if (failure) text += attentionTime(worker.finishedAt, '실패', snapshot.generatedAt);
    if (worker.awaiting) {
      const target = failure ? text : alertTarget(worker);
      text = `${target} · ${pendingHandoffText(worker)}`;
    }
    return [{ text, worker }];
  });
  const asks = (snapshot.asks ?? []).map((ask, index) => {
    const time = attentionTime(ask.createdAt, '대기 시작', snapshot.generatedAt);
    if (!time) return { text: askAlert(ask, index) };
    const head = privacy ? `승인 대기 질문 ${String(index + 1).padStart(2, '0')}` : `승인 대기 ${ask.id}`;
    return { text: `${head}${time}${!privacy && ask.title ? ` · ${ask.title}` : ''}` };
  });
  return [...lanes, ...workers, ...asks];
}

/** Render the combined review list next to running work, including every pending handoff. */
function renderAttention() {
  const items = attentionItems(state);
  const list = $('#attention-list');
  list.replaceChildren(...items.map(({ text, worker }) => attentionItem(text, worker)));
  if (!items.length) list.append(el('li', '지금 살펴볼 항목이 없습니다.', 'attention-empty'));
  $('#attention-count').textContent = `${number(items.length)}건`;
}

/** Describe live work with its coarse start age and privacy-safe handoff owner. */
function liveWorkText(worker) {
  const merging = worker.merging?.status === 'merging';
  const startedAt = merging ? worker.merging.startedAt : worker.startedAt;
  const elapsed = typeof startedAt === 'number'
    ? age((state.generatedAt - startedAt) / 1000)
    : '시작 시각 없음';
  const ownerName = worker.handoff?.owner ? ` · ${privacy ? '담당 숨김' : worker.handoff.owner}` : '';
  const start = clock(startedAt);
  return `${merging ? '병합 중' : labels.running} · ${start ? `${start} 시작 · ${elapsed}` : elapsed}${ownerName}`;
}

/** Render fixed bot and routine rows using only allowlisted activity metadata. */
function renderBotActivity() {
  const list = $('#bot-activity');
  list.replaceChildren(...(state.botActivity ?? []).map((activity) => {
    const row = el('tr');
    const task = privacy ? '숨김' : activity.tasks.map((task) => {
      const title = task.taskSummary.replace(new RegExp(`^${task.issue}(?:\\s+|:\\s*)`), '');
      return [task.issue, title].filter(Boolean).join(' ');
    }).filter(Boolean).join(' / ') || '데이터 없음';
    const taskCell = el('td', task, 'bot-activity-task');
    taskCell.setAttribute('title', task);
    row.append(el('td', activity.name), taskCell, el('td', clock(activity.startedAt) ?? '데이터 없음'),
      el('td', clock(activity.startedAt) ? age((state.generatedAt - activity.startedAt) / 1000) : '데이터 없음'),
      el('td', clock(activity.lastActivityAt) ?? '데이터 없음'));
    return row;
  }));
}

/** Describe an untracked live CLI process for the top running-work list. */
function untrackedLiveText(proc) {
  const label = proc.subcommand === 'cli' ? `${proc.binary} CLI` : `${proc.binary} ${proc.subcommand}`;
  const where = privacy ? '경로 숨김' : (proc.cwd || '경로 확인 불가');
  const elapsed = proc.elapsedSec === null ? '' : ` · ${duration(proc.elapsedSec)}`;
  return `${label} (PID ${proc.pid}) · ${labels['untracked running']} · ${where}${elapsed}`;
}

/** Keep running and merging work visible regardless of the selected time window. */
function renderLiveWork() {
  const running = (state.workers ?? []).filter(isRunningWorker);
  const untracked = state.untracked ?? [];
  const runningList = $('#running-list');
  runningList.replaceChildren(
    ...running.map((worker) => attentionItem(`${alertTarget(worker)} · ${liveWorkText(worker)}`, worker)),
    ...untracked.map((proc) => attentionItem(untrackedLiveText(proc))),
  );
  const total = running.length + untracked.length;
  if (!total) runningList.append(el('li', '실행 중인 워커가 없습니다.', 'attention-empty'));
  $('#running-count').textContent = `${number(total)}건`;
}

/** Refresh every view from the latest snapshot. */
function render() {
  if (!state) return;
  renderTabStatus();
  renderLanes();
  renderLiveWork();
  renderBotActivity();
  renderMetrics();
  renderAttention();
  renderLaneHistory();
  renderInbox();
  renderAsks();
  const workers = visibleWorkers();
  renderTimeline(workers);
  renderWorkers(workers);
  renderFeeds();
  $('#updated').textContent = `${date(state.generatedAt)} · 2초 갱신`;
  const issues = [];
  if (state.sources.recordsUnavailable) issues.push('워커 입력 없음 / 읽기 불가');
  if (state.sources.lanesInvalid) issues.push('레인 설정 읽기 불가');
  if (state.sources.invalidRecords) issues.push(`불완전 레코드 ${state.sources.invalidRecords}개 제외`);
  if (workers.some((worker) => worker.usageTruncated)) issues.push('토큰 일부 집계');
  if (Object.entries(state.sources).some(([key, value]) => /Unreadable|Truncated/.test(key) && value)) issues.push('선택 입력 읽기 제한');
  $('#source-status').textContent = [...issues, `알림 ${state.alerts.count}건 (원문 숨김)`].join(' · ');
  if ($('#detail').open) showDetail(selectedId, false);
}

/** Read the stored window, tolerating unavailable storage. */
function storedWindow() {
  try { return localStorage.getItem(WINDOW_STORAGE_KEY); } catch { return null; }
}

/** Persist the window in storage and the URL query without adding history entries. */
function persistWindow(key) {
  try { localStorage.setItem(WINDOW_STORAGE_KEY, key); } catch { /* The URL still carries the choice. */ }
  try {
    const url = new URL(location.href);
    url.searchParams.set('window', key);
    history.replaceState(history.state, '', url);
  } catch { /* Storage still carries the choice. */ }
}

/** Pick the URL window, then the stored one, then the default; a valid URL value is also stored. */
function initialWindow() {
  let fromUrl = null;
  try { fromUrl = parseWindow(new URL(location.href).searchParams.get('window')); } catch { /* Fall back to storage. */ }
  if (fromUrl) {
    persistWindow(fromUrl);
    return fromUrl;
  }
  return parseWindow(storedWindow()) ?? DEFAULT_WINDOW;
}

/** Mark the active preset and mirror a custom hour count in the input. */
function syncWindowControls() {
  for (const preset of WINDOW_PRESETS) {
    const button = $(`#window-${preset}`);
    button.classList.toggle('active', preset === timeWindow);
    button.setAttribute('aria-pressed', String(preset === timeWindow));
  }
  const input = $('#window-hours');
  input.value = WINDOW_PRESETS.includes(timeWindow) ? '' : String(windowMs(timeWindow) / HOUR_MS);
  input.setAttribute('aria-invalid', 'false');
}

/** Switch to a valid window, persist it and re-render; invalid input keeps the last valid window. */
function selectWindow(value) {
  const key = parseWindow(value);
  if (!key) return false;
  timeWindow = key;
  persistWindow(key);
  syncWindowControls();
  render();
  return true;
}

/** Connect dashboard controls and telemetry after the document is ready. */
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(document.documentElement.dataset.theme);
  $('#theme-toggle').addEventListener('click', () => {
    savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(savedTheme);
    try { localStorage.setItem('theme', savedTheme); } catch { /* Keep the choice for this page when storage is unavailable. */ }
  });
  systemTheme.addEventListener('change', (event) => {
    if (!savedTheme) applyTheme(event.matches ? 'dark' : 'light');
  });
  timeWindow = initialWindow();
  syncWindowControls();
  for (const preset of WINDOW_PRESETS) $(`#window-${preset}`).addEventListener('click', () => selectWindow(preset));
  $('#window-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#window-hours');
    const text = String(input.value ?? '').trim();
    if (!/^\d+$/.test(text) || !selectWindow(text)) input.setAttribute('aria-invalid', 'true');
  });
  $('#privacy').addEventListener('change', (event) => { privacy = event.target.checked; render(); });
  $('#close-detail').addEventListener('click', () => $('#detail').close());
  for (const name of ['mouseenter', 'focusin']) $('#alert-status').addEventListener(name, positionAlertTooltip);
  document.addEventListener('scroll', positionAlertTooltip, { passive: true });
  globalThis.addEventListener?.('resize', positionAlertTooltip);
  $('#alert-trigger').addEventListener('click', () => $('#attention').scrollIntoView?.({ block: 'start' }));
  const feed = new EventSource('/api/events');
  feed.onmessage = (event) => {
    try {
      state = JSON.parse(event.data);
      $('#connection').textContent = '● LIVE';
      $('#connection').classList.remove('disconnected');
      render();
    } catch { $('#connection').textContent = '데이터 확인 필요'; }
  };
  feed.onerror = () => { $('#connection').textContent = '● 연결 재시도 중'; $('#connection').classList.add('disconnected'); };
});
