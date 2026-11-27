/** Render the bottom tool-usage bar, its detail panel and per-tool refresh requests. */
import { age, money, number, shortDate, shortTime } from './lib/format.js';
import { $, el, svg } from './lib/dom.js';
import { rerender, state } from './store.js';
import { HOUR_MS, timeWindow, windowMs, windowPrefix } from './time-window.js';

const USAGE_TOOLS = ['claude', 'codex', 'antigravity', 'cursor'];
const USAGE_STORAGE_KEY = 'toolUsage';
const USAGE_FORCE_MIN_MS = 30000;
let usageTools = new Set();
const usageToolRefreshClickedAt = {};
let usageDetailTool = null;

const TOOL_STATUS_TEXT = {
  off: '조회 꺼짐 · 이름을 눌러 켜기',
  disabled: '조회 시작 중',
  loading: '조회 중',
  missing: '로컬 세션 로그 없음',
  unavailable: '실행 중인 언어 서버 없음',
  'auth-missing': 'cursor-agent 로그인 정보 없음 · cursor-agent login 필요',
  'auth-expired': '인증 만료 · cursor-agent login 후 다시 조회',
  error: '조회 실패',
};

/** Sum hour buckets that overlap the selected window; `all` keeps every retained hour. */
function toolTotals(hourly) {
  const span = windowMs(timeWindow);
  const since = span === null ? -Infinity : state.generatedAt - span - HOUR_MS;
  const totals = { newInput: 0, cacheWrite: 0, cached: 0, output: 0, messages: 0 };
  for (const bucket of hourly ?? []) {
    if (bucket.hour <= since) continue;
    for (const key of Object.keys(totals)) totals[key] += bucket[key] ?? 0;
  }
  return totals;
}

/** Name a limit window by its length, e.g. `5시간 한도`, `주간 한도`. */
function limitName(minutes) {
  if (minutes === 300) return '5시간';
  if (minutes === 10080) return '주간';
  if (minutes === 1440) return '일간';
  if (typeof minutes === 'number' && minutes % 60 === 0) return `${minutes / 60}시간`;
  return typeof minutes === 'number' ? `${minutes}분` : '한도';
}

/** Full sentence for a gauge, used in tooltips and the accessible label. */
function gaugeText({ label, percent, detail }) {
  return `${label} ${number(Math.min(100, Math.max(0, percent)))}% 사용${detail ? ` · ${detail}` : ''}`;
}

/** Build an inline mini gauge with its percent; the bar turns orange from 70% and red from 90%. */
function limitGauge(gauge) {
  const percent = Math.min(100, Math.max(0, gauge.percent));
  const wrap = el('span', undefined, 'limit');
  const color = percent >= 90 ? 'var(--red)' : percent >= 70 ? 'var(--orange)' : 'var(--mint)';
  const bar = svg('svg', { viewBox: '0 0 500 5', role: 'img', 'aria-label': gaugeText(gauge), preserveAspectRatio: 'none' });
  bar.append(svg('rect', { width: 500, height: 5, rx: 2.5, fill: 'var(--usage-track)' }));
  bar.append(svg('rect', { width: 5 * percent, height: 5, rx: 2.5, fill: color }));
  wrap.append(bar, el('span', `${gauge.label} ${number(percent)}%`));
  return wrap;
}

/** Describe when a limit resets; a reset already past means the reported percent is stale. */
function resetText(resetAt) {
  if (typeof resetAt !== 'number') return '';
  return resetAt <= state.generatedAt ? '보고 이후 리셋됨' : `${shortDate(resetAt)} 리셋`;
}

/** Read the tools this browser chose to query; unavailable or invalid storage means none. */
function storedUsageTools() {
  try {
    const saved = JSON.parse(localStorage.getItem(USAGE_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((tool) => USAGE_TOOLS.includes(tool)) : []);
  } catch {
    return new Set();
  }
}

/** Remember the chosen tools for this browser only. */
function persistUsageTools() {
  try { localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify([...usageTools])); } catch { /* The choice lasts for this page only. */ }
}

/** SSE path that asks the server to collect only the checked tools, optionally refreshing all (`true`) or one tool now. */
export function eventsPath(refresh = false) {
  const tools = USAGE_TOOLS.filter((tool) => usageTools.has(tool));
  const target = refresh === true ? '1' : USAGE_TOOLS.includes(refresh) ? refresh : '';
  const params = [...(tools.length ? [`usage=${tools.join(',')}`] : []), ...(target ? [`refresh=${target}`] : [])];
  return params.length ? `/api/events?${params.join('&')}` : '/api/events';
}

const lastToolUsage = {};
const usageRefreshPending = {};
const PENDING_MIN_MS = 700;
const PENDING_MAX_MS = 30000;

/**
 * True while a tool is being re-read: the server says so, or this page asked and has not yet seen a newer read.
 * Remote reads often finish between two-second snapshots, so the page tracks its own request from the click,
 * keeps the spinner at least PENDING_MIN_MS and gives up after PENDING_MAX_MS (e.g. a refused request).
 */
function isToolRefreshing(tool, usage = state.toolUsage ?? {}, now = Date.now()) {
  if ((usage.refreshingTools ?? []).includes(tool)) return true;
  const asked = usageRefreshPending[tool];
  if (asked === undefined) return false;
  const elapsed = now - asked;
  const answered = (usage.refreshedAtByTool?.[tool] ?? -Infinity) >= asked - 500;
  if (elapsed < PENDING_MIN_MS || (!answered && elapsed < PENDING_MAX_MS)) return true;
  delete usageRefreshPending[tool];
  return false;
}

/** True when this page forced the tool within the server's per-tool cooldown, so another request would be ignored. */
function isToolCooling(tool, now = Date.now()) {
  return now - (usageToolRefreshClickedAt[tool] ?? -Infinity) < USAGE_FORCE_MIN_MS;
}

/**
 * Remember that this page asked to re-read these tools now; only checked tools outside the cooldown count,
 * mirroring which ones the server will accept. Returns the tools actually requested.
 */
function markRefreshPending(tools, now = Date.now()) {
  const accepted = tools.filter((tool) => usageTools.has(tool) && !isToolCooling(tool, now));
  for (const tool of accepted) {
    usageRefreshPending[tool] = now;
    usageToolRefreshClickedAt[tool] = now;
  }
  return accepted;
}

/** True when a tool report carries data to show rather than a placeholder status. */
function hasUsageData(report) {
  return Boolean(report) && !['loading', 'disabled'].includes(report.status);
}

/**
 * Keep each tool's last report with data when a newer message has none (server restarting, page just connected),
 * so the bar keeps showing the previous usage until the next read finishes.
 */
export function keepLastUsage(toolUsage) {
  if (!toolUsage) return toolUsage;
  const merged = { ...toolUsage };
  for (const tool of USAGE_TOOLS) {
    if (hasUsageData(toolUsage[tool])) lastToolUsage[tool] = toolUsage[tool];
    else if (lastToolUsage[tool]) merged[tool] = lastToolUsage[tool];
  }
  return merged;
}

/** The server's report for a tool, or `off` when this browser has not checked it. */
function toolState(tool) {
  return usageTools.has(tool) ? state.toolUsage?.[tool] : { status: 'off' };
}

const CLAUDE_LIMIT_STATUS = {
  loading: '한도 조회 중',
  'auth-missing': 'Claude Code 로그인 정보 없음',
  'auth-expired': '로그인 토큰 만료 · Claude Code 사용 시 갱신',
  error: '한도 조회 실패',
};

/** Describe a log-based tool: window tokens as the headline and the most-used limit window as the gauge. */
function logToolView(key, usage) {
  const totals = toolTotals(usage.hourly);
  const detail = `새 입력 ${number(totals.newInput)} · 캐시 읽기 ${number(totals.cached)} · 출력 ${number(totals.output)} · ${key === 'claude' ? '응답' : '턴'} ${number(totals.messages)}`;
  const limits = usage.limits;
  if (!limits) {
    const status = key === 'claude' ? CLAUDE_LIMIT_STATUS[usage.limitsStatus] ?? '' : '';
    return { headline: number(totals.newInput + totals.output), detail, status, warn: ['auth-expired', 'auth-missing', 'error'].includes(usage.limitsStatus) };
  }
  return {
    headline: number(totals.newInput + totals.output),
    gauges: limits.windows.filter((window) => !window.scope).map((window) => ({
      label: `${limitName(window.windowMinutes)}`,
      percent: window.usedPercent,
      detail: resetText(window.resetsAt),
    })),
    detail: [limits.plan ? `${limits.plan} 요금제` : '', detail, `${shortDate(limits.observedAt)} 보고`].filter(Boolean).join(' · '),
    status: limits.limitReached ? '한도 도달' : '',
    warn: limits.limitReached,
  };
}

/** Describe Antigravity: plan as the headline and the least-remaining model quota as the gauge. */
function antigravityView(usage) {
  const tightest = usage.models.reduce((best, model) => (!best || model.remainingFraction < best.remainingFraction ? model : best), null);
  const credits = [['프롬프트', usage.credits?.prompt], ['플로', usage.credits?.flow]]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label} 크레딧 ${number(value.available)} / ${number(value.monthly)}`);
  return {
    headline: usage.plan ?? '—',
    gauges: tightest ? [{ label: '모델 한도', percent: (1 - tightest.remainingFraction) * 100, detail: resetText(tightest.resetAt) }] : [],
    detail: [...(tightest ? [`최소 잔여 ${tightest.label}`] : []), ...credits, `${shortDate(usage.observedAt)} 조회`].join(' · '),
  };
}

/** Name Cursor's included-usage gauge by its reset period. */
function cursorPeriodLabel(usage) {
  return { weekly: '주간', monthly: '월간' }[usage.plan?.includedPeriod] ?? '포함';
}

/** Cursor's included-usage percent, falling back to dollars when only those are reported. */
function cursorPercent(usage) {
  return usage.totalPercent ?? (usage.spentCents !== null && usage.limitCents ? (usage.spentCents / usage.limitCents) * 100 : null);
}

/** Describe Cursor: included usage percent as the gauge; once it is used up, remaining credits replace the warning. */
function cursorView(usage) {
  const percent = cursorPercent(usage);
  const exhausted = percent !== null && percent >= 100;
  const credit = usage.credits?.availableCents ?? null;
  const reset = usage.plan?.includedResetsAt ?? usage.cycleEndAt;
  let status = '';
  if (exhausted) status = credit > 0 ? `크레딧 $${number(credit / 100)}` : '한도 도달';
  return {
    headline: percent === null ? '—' : `${number(percent)}%`,
    gauges: percent === null ? [] : [{ label: cursorPeriodLabel(usage), percent, detail: reset ? `${shortDate(reset)} 초기화` : '' }],
    detail: [usage.plan?.name ? `${usage.plan.name} 요금제` : '', usage.message ?? '', `${shortDate(usage.observedAt)} 조회`].filter(Boolean).join(' · '),
    status,
    warn: exhausted && !(credit > 0),
  };
}

/** Pick what one header chip shows: a status line until data arrives, then the tool's own view. */
function toolView(tool, usage) {
  if (usage?.status !== 'ok') {
    return {
      headline: '—',
      status: TOOL_STATUS_TEXT[usage?.status] ?? TOOL_STATUS_TEXT.loading,
      warn: ['auth-expired', 'auth-missing', 'error'].includes(usage?.status),
    };
  }
  if (tool === 'antigravity') return antigravityView(usage);
  if (tool === 'cursor') return cursorView(usage);
  return logToolView(tool, usage);
}

/** Show when usage was last read and keep the refresh button off while a refresh runs or was just requested. */
function renderUsageRefresh(usage) {
  const anyChecked = usageTools.size > 0;
  const allCooling = [...usageTools].every((tool) => isToolCooling(tool));
  $('#usage-refresh').disabled = !anyChecked || allCooling;
  let text = '';
  if (!anyChecked) text = '';
  else if (usage.refreshedAt) text = `${shortTime(usage.refreshedAt)} 조회`;
  $('#usage-refreshed').textContent = text;
  $('#usage-refreshed').setAttribute('title', usage.nextRefreshAt && anyChecked ? `다음 자동 조회 ${shortTime(usage.nextRefreshAt)}` : '');
}

const TOOL_LABELS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', cursor: 'Cursor' };

/** Describe a reset instant with its distance, e.g. `11/27 13:40 초기화 · 46분 후`. */
function untilText(resetAt) {
  if (typeof resetAt !== 'number') return '초기화 시각 미보고';
  const seconds = (resetAt - state.generatedAt) / 1000;
  return seconds <= 0 ? `${shortDate(resetAt)} 초기화됨 (보고 이후)` : `${shortDate(resetAt)} 초기화 · ${age(seconds)} 후`;
}

/** Name a limit window for the detail panel, adding the model scope when there is one. */
function windowLabel(window) {
  return window.scope ? `${limitName(window.windowMinutes)} · ${window.scope}` : limitName(window.windowMinutes);
}

/** Collect one tool's detail: limit rows, labeled facts and notes; null fields are simply left out. */
function toolDetail(tool, usage) {
  if (usage?.status !== 'ok') {
    return { subtitle: '', limits: [], facts: [], notes: [{ text: TOOL_STATUS_TEXT[usage?.status] ?? TOOL_STATUS_TEXT.loading, warn: ['auth-expired', 'auth-missing', 'error'].includes(usage?.status) }] };
  }
  if (tool === 'antigravity') {
    const models = [...usage.models].sort((a, b) => a.remainingFraction - b.remainingFraction);
    const credits = [['프롬프트 크레딧', usage.credits?.prompt], ['플로 크레딧', usage.credits?.flow]].filter(([, value]) => value)
      .map(([label, value]) => [label, `${number(value.available)} / ${number(value.monthly)}`]);
    return {
      subtitle: usage.plan ?? '',
      limits: models.map((model) => ({ label: model.label, percent: (1 - model.remainingFraction) * 100, reset: untilText(model.resetAt) })),
      facts: [...credits, ['조회', shortDate(usage.observedAt)]],
      notes: models.length ? [] : [{ text: '한도가 보고된 모델이 없습니다' }],
    };
  }
  if (tool === 'cursor') {
    const dollars = (cents) => (cents === null || cents === undefined ? null : money(cents / 100));
    const percent = cursorPercent(usage);
    const credits = usage.credits;
    const reset = usage.plan?.includedResetsAt ?? usage.cycleEndAt;
    const facts = [
      ['남은 크레딧', dollars(credits?.availableCents)],
      ['이번 달 추가 사용', dollars(credits?.spentThisMonthCents)],
      ['월 추가 사용 한도', credits ? dollars(credits.monthlyLimitCents) ?? '미설정' : null],
      ['충전 합계', dollars(credits?.fundedCents)],
      ['Auto 사용률', usage.autoPercent === null ? null : `${number(usage.autoPercent)}%`],
      ['API 사용률', usage.apiPercent === null ? null : `${number(usage.apiPercent)}%`],
      ['사용 금액', dollars(usage.spentCents)],
      ['한도 금액', dollars(usage.limitCents)],
      ['조회', shortDate(usage.observedAt)],
    ].filter(([, value]) => value !== null);
    const notes = [];
    if (usage.message) notes.push({ text: usage.message, warn: percent !== null && percent >= 100 && !(credits?.availableCents > 0) });
    if (percent !== null && percent >= 100 && credits?.availableCents > 0) notes.push({ text: '포함 사용량을 모두 써서 추가 크레딧으로 사용 중입니다' });
    return {
      subtitle: usage.plan?.name ? `${usage.plan.name} 요금제` : 'cursor-agent 로그인 기준',
      limits: percent === null ? [] : [{ label: `${cursorPeriodLabel(usage)} 포함 사용량`, percent, reset: untilText(reset ?? null) }],
      facts,
      notes,
    };
  }
  const totals = toolTotals(usage.hourly);
  const limits = usage.limits;
  const facts = [
    ['새 입력', number(totals.newInput)],
    ...(tool === 'claude' ? [['캐시 쓰기', number(totals.cacheWrite)]] : []),
    ['캐시 읽기', number(totals.cached)],
    ['출력', number(totals.output)],
    [tool === 'claude' ? '응답' : '턴', number(totals.messages)],
    ...(limits ? [['한도 보고', shortDate(limits.observedAt)]] : []),
  ];
  const notes = [];
  if (!limits && tool === 'claude') notes.push({ text: CLAUDE_LIMIT_STATUS[usage.limitsStatus] ?? '', warn: ['auth-expired', 'auth-missing', 'error'].includes(usage.limitsStatus) });
  if (limits?.limitReached) notes.push({ text: '한도에 도달한 창이 있습니다', warn: true });
  return {
    subtitle: limits?.plan ? `${limits.plan} 요금제` : '',
    limits: (limits?.windows ?? []).map((window) => ({ label: windowLabel(window), percent: window.usedPercent, reset: untilText(window.resetsAt) })),
    facts,
    factsTitle: `토큰 (${timeWindow === 'all' ? '최근 7일' : windowPrefix(timeWindow)})`,
    notes: notes.filter((note) => note.text),
  };
}

/** Render the detail panel for the open tool above the footer, or hide it. */
function renderUsageDetail() {
  const panel = $('#usage-detail');
  for (const tool of USAGE_TOOLS) $(`#tool-open-${tool}`).setAttribute('aria-expanded', String(tool === usageDetailTool));
  panel.hidden = !usageDetailTool;
  if (!usageDetailTool) return;
  const detail = toolDetail(usageDetailTool, toolState(usageDetailTool));
  const head = el('div', undefined, 'usage-detail-head');
  const title = el('h3', TOOL_LABELS[usageDetailTool]);
  // Reuse the chip's inline SVG so the panel shows the same icon without extra markup or image requests.
  const icon = document.querySelector(`.tool-icon-${usageDetailTool}`)?.cloneNode?.(true);
  if (icon) title.prepend(icon);
  if (detail.subtitle) title.append(el('small', detail.subtitle));
  const actions = el('div', undefined, 'usage-detail-actions');
  const tool = usageDetailTool;
  const usage = state.toolUsage ?? {};
  const refreshedAt = usage.refreshedAtByTool?.[tool];
  const refreshing = isToolRefreshing(tool, usage);
  if (refreshing) actions.append(spinner(TOOL_LABELS[tool]));
  actions.append(el('span', refreshedAt ? `${shortTime(refreshedAt)} 조회` : '', 'usage-refreshed'));
  const reload = el('button', '↻ 다시 조회');
  reload.setAttribute('type', 'button');
  reload.setAttribute('aria-label', `${TOOL_LABELS[tool]} 사용량 다시 조회`);
  reload.disabled = !usageTools.has(tool) || refreshing || isToolCooling(tool);
  reload.addEventListener('click', () => requestToolRefresh(tool));
  const close = el('button', '닫기 ×');
  close.setAttribute('type', 'button');
  close.addEventListener('click', () => { usageDetailTool = null; renderUsageDetail(); });
  actions.append(reload, close);
  head.append(title, actions);
  const parts = [head];
  if (detail.limits.length) {
    const grid = el('div', undefined, 'detail-limits');
    for (const limit of detail.limits) {
      const percent = Math.min(100, Math.max(0, limit.percent));
      const color = percent >= 90 ? 'var(--red)' : percent >= 70 ? 'var(--orange)' : 'var(--mint)';
      const bar = svg('svg', { viewBox: '0 0 500 6', role: 'img', 'aria-label': `${limit.label} ${number(percent)}% 사용`, preserveAspectRatio: 'none' });
      bar.append(svg('rect', { width: 500, height: 6, rx: 3, fill: 'var(--usage-track)' }), svg('rect', { width: 5 * percent, height: 6, rx: 3, fill: color }));
      grid.append(el('span', limit.label), bar, el('strong', `${number(percent)}%`), el('span', limit.reset, 'reset'));
    }
    parts.push(grid);
  }
  if (detail.facts.length) {
    if (detail.factsTitle) parts.push(el('p', detail.factsTitle, 'eyebrow'));
    const facts = el('dl', undefined, 'detail-facts');
    for (const [label, value] of detail.facts) {
      const item = el('div');
      item.append(el('dt', label), el('dd', value));
      facts.append(item);
    }
    parts.push(facts);
  }
  for (const note of detail.notes) parts.push(el('p', note.text, `detail-note${note.warn ? ' warn' : ''}`));
  panel.replaceChildren(...parts);
}

/** Ask the server to re-read one tool now; set by the page once the live stream exists. */
let requestToolRefresh = () => {};

/**
 * True when a click started inside `container`. Uses the dispatch-time path, because a click handler may re-render
 * and detach the clicked node (e.g. the detail panel's reload button) before this check runs.
 */
function clickedInside(event, container) {
  const path = event.composedPath?.();
  return path ? path.includes(container) : container.contains(event.target);
}

/** Build an accessible spinner announcing that `label` is being re-read. */
function spinner(label) {
  const node = el('span', undefined, 'usage-spinner');
  node.setAttribute('role', 'status');
  node.setAttribute('aria-label', `${label} 재조회 중`);
  return node;
}

/** Open a tool's detail, or close it when that tool is already open. */
function toggleUsageDetail(tool) {
  usageDetailTool = usageDetailTool === tool ? null : tool;
  renderUsageDetail();
}

/** Fill the one-line sticky footer; a chip opens its detail panel and keeps a short tooltip. */
export function renderToolUsage() {
  const usage = state.toolUsage;
  $('#tool-usage').hidden = !usage;
  if (!usage) return;
  $('#tool-usage-window').textContent = timeWindow === 'all' ? `최근 ${usage.retentionHours / 24}일` : windowPrefix(timeWindow);
  renderUsageRefresh(usage);
  for (const tool of USAGE_TOOLS) {
    const view = toolView(tool, toolState(tool));
    // The chip keeps its last numbers while re-reading; only a spinner beside the name signals the refresh.
    $(`#tool-${tool}`).setAttribute('data-refreshing', String(usageTools.has(tool) && isToolRefreshing(tool, usage)));
    // With gauges the bar shows only their percents; the headline (tokens, plan) stays in the tooltip and detail panel.
    $(`#tool-headline-${tool}`).textContent = view.gauges?.length ? '' : view.headline;
    const parts = [];
    for (const gauge of view.gauges ?? []) parts.push(limitGauge(gauge));
    if (view.status) parts.push(el('span', view.status, `tool-status${view.warn ? ' warn' : ''}`));
    $(`#tool-body-${tool}`).replaceChildren(...parts);
    const tooltip = [view.gauges?.length ? view.headline : '', ...(view.gauges ?? []).map(gaugeText), view.status, view.detail].filter(Boolean).join('\n');
    $(`#tool-open-${tool}`).setAttribute('title', `${tooltip}${tooltip ? '\n' : ''}눌러서 자세히 보기`);
  }
  renderUsageDetail();
}

/**
 * Restore the checked tools and wire the usage bar. `connect(refresh)` reopens the live stream so the server reads
 * exactly the checked tools; `refresh` is true for all tools, a tool name for one, or false for none.
 */
export function initUsage(connect) {
  usageTools = storedUsageTools();
  for (const tool of USAGE_TOOLS) {
    const box = $(`#usage-${tool}`);
    box.checked = usageTools.has(tool);
    box.addEventListener('change', (event) => {
      if (event.target.checked) usageTools.add(tool);
      else usageTools.delete(tool);
      persistUsageTools();
      connect();
      rerender();
    });
  }
  for (const tool of USAGE_TOOLS) $(`#tool-open-${tool}`).addEventListener('click', () => toggleUsageDetail(tool));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && usageDetailTool) toggleUsageDetail(usageDetailTool);
  });
  document.addEventListener('click', (event) => {
    if (usageDetailTool && !clickedInside(event, $('#tool-usage'))) toggleUsageDetail(usageDetailTool);
  });
  requestToolRefresh = (tool) => {
    if (!markRefreshPending([tool]).length) return;
    rerender();
    connect(tool);
  };
  $('#usage-refresh').addEventListener('click', () => {
    // Show spinners first, then ask the server for exactly the tools it will accept.
    if (!markRefreshPending(USAGE_TOOLS).length) return;
    rerender();
    connect(true);
  });
}
