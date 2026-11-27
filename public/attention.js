/** Decide what needs a look and render it in the attention list, tab title, favicon and live work. */
import { age, clock, duration, number } from './lib/format.js';
import { $, el, svg } from './lib/dom.js';
import { state } from './store.js';
import { privacy } from './privacy.js';
import {
  BOT_ROLE_LABELS,
  UNPICKED_FAILURE_LABELS,
  attentionTime,
  isDashboardWorker,
  isRunningWorker,
  labels,
  mergeWaitText,
  owner,
} from './worker-text.js';

const FAVICON_COLORS = { red: '#e5484d', blue: '#3b82f6', green: '#22a06b' };

/** Count tracked workers that are running, starting or merging; untracked processes are excluded. */
function runningCount(snapshot) {
  return (snapshot.workers ?? []).filter((worker) => isDashboardWorker(worker) && isRunningWorker(worker)).length;
}

/** Name a worker for the tab tooltip by issue and worker id; hidden in privacy mode. */
function alertTarget(worker) {
  if (privacy) return '워커 숨김';
  return worker.issue ? `${worker.issue} (${worker.id})` : worker.id;
}

/** Alert on merge failures, unhandled attempt failures and owner handoffs older than 30 minutes. */
function workerAlert(worker) {
  if (worker.mergeWait && !worker.resolved) return `${alertTarget(worker)} · ${mergeWaitText(worker)}`;
  if (worker.merging?.status === 'merging') return null;
  if (worker.resolved) return null;
  if (worker.merging?.status === 'failed') return `${alertTarget(worker)} 병합 실패: ${worker.merging.reason || '사유 없음'}`;
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
export function renderTabStatus() {
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
    if (worker.merging?.status === 'failed' && !worker.resolved) {
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
export function renderAttention() {
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
export function renderBotActivity() {
  const list = $('#bot-activity');
  list.replaceChildren(...(state.botActivity ?? []).map((activity) => {
    const row = el('tr');
    const active = activity.startedAt != null;
    const task = !active ? '대기' : privacy ? '숨김' : activity.tasks.map((task) => {
      const title = task.taskSummary.replace(new RegExp(`^${task.issue}(?:\\s+|:\\s*)`), '');
      return [task.issue, title].filter(Boolean).join(' ');
    }).filter(Boolean).join(' / ') || '데이터 없음';
    const taskCell = el('td', task, 'bot-activity-task');
    taskCell.setAttribute('title', task);
    const nameCell = el('td');
    const role = BOT_ROLE_LABELS[activity.role];
    if (role) nameCell.append(el('span', role, 'bot-role'));
    nameCell.append(el('span', activity.name));
    row.append(
      nameCell,
      taskCell,
      el('td', active ? (clock(activity.startedAt) ?? '데이터 없음') : '대기'),
      el('td', active && clock(activity.startedAt) ? age((state.generatedAt - activity.startedAt) / 1000) : '대기'),
      el('td', clock(activity.lastActivityAt) ?? '데이터 없음'),
    );
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
export function renderLiveWork() {
  const running = (state.workers ?? []).filter((worker) => isDashboardWorker(worker) && isRunningWorker(worker));
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

/** Keep the alert tooltip clear of other panels and jump to the attention list from the header badge. */
export function initAttention() {
  for (const name of ['mouseenter', 'focusin']) $('#alert-status').addEventListener(name, positionAlertTooltip);
  document.addEventListener('scroll', positionAlertTooltip, { passive: true });
  globalThis.addEventListener?.('resize', positionAlertTooltip);
  $('#alert-trigger').addEventListener('click', () => $('#attention').scrollIntoView?.({ block: 'start' }));
}
