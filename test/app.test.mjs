/** Cover pre-paint theme selection, persistence and the privacy toggle without a browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { pageSource } from './helpers/page-source.mjs';

const source = await pageSource();

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

/** Execute the real entry point with storage and minimal DOM event targets. */
function loadApp({ saved = null, dark = false, blocked = false, storedWindow = null, href = 'http://127.0.0.1:4317/' } = {}) {
  const listeners = new Map();
  const nodes = new Map();
  const writes = [];
  const urls = [];
  const stored = { theme: saved, window: storedWindow };
  let systemChange;
  /** Create a small text-node DOM double for inventory, detail and SVG rendering. */
  function node() {
    return {
      textContent: '', children: [], attributes: {}, handlers: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      showModal() { this.open = true; },
      close() { this.open = false; },
    };
  }
  const document = {
    createElement: node,
    createElementNS: node,
    documentElement: { dataset: {} },
    addEventListener: (name, callback) => listeners.set(name, callback),
    querySelector: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
  };
  const context = {
    document,
    matchMedia: () => ({ matches: dark, addEventListener: (name, callback) => { systemChange = callback; } }),
    localStorage: {
      getItem(key) { if (blocked) throw new Error('Storage blocked'); return stored[key] ?? null; },
      setItem(key, value) { if (blocked) throw new Error('Storage blocked'); stored[key] = value; writes.push([key, value]); },
    },
    location: { href },
    history: { state: null, replaceState(data, unused, url) { context.location.href = String(url); urls.push(String(url)); } },
    URL,
    EventSource: class {},
  };
  runInNewContext(source, context);
  return { document, nodes, writes, urls, stored, context, ready: () => listeners.get('DOMContentLoaded')(), systemChange: (matches) => systemChange({ matches }) };
}

test('theme script blocks parsing in the head before any body can paint', () => {
  // 테마는 일반 스크립트로 먼저 적용하고, 나머지 화면 코드는 지연 실행되는 모듈로 불러온다.
  assert.match(html, /<head>[\s\S]*<script src="\/theme-boot\.js"><\/script>[\s\S]*<\/head>/);
  assert.doesNotMatch(html, /<script[^>]*(?:defer|async)[^>]*src="\/theme-boot\.js"/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
});

test('theme follows system preference before DOM ready and tracks changes', () => {
  for (const dark of [false, true]) {
    const app = loadApp({ dark });
    assert.equal(app.document.documentElement.dataset.theme, dark ? 'dark' : 'light');
    app.ready();
    app.systemChange(!dark);
    assert.equal(app.document.documentElement.dataset.theme, dark ? 'light' : 'dark');
    assert.equal(app.nodes.get('#theme-toggle').attributes['aria-pressed'], String(!dark));
    assert.equal(app.writes.length, 0);
  }
});

test('saved theme overrides the system and the button persists both choices', () => {
  const app = loadApp({ saved: 'light', dark: true });
  assert.equal(app.document.documentElement.dataset.theme, 'light');
  app.ready();
  const button = app.nodes.get('#theme-toggle');
  button.handlers.click();
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(button.attributes['aria-pressed'], 'true');
  app.systemChange(false);
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  button.handlers.click();
  assert.equal(app.document.documentElement.dataset.theme, 'light');
  assert.deepEqual(app.writes, [['theme', 'dark'], ['theme', 'light']]);
});

test('invalid or inaccessible storage falls back to system and toggling still works', () => {
  for (const options of [{ saved: 'invalid' }, { blocked: true }]) {
    const app = loadApp({ ...options, dark: true });
    assert.equal(app.document.documentElement.dataset.theme, 'dark');
    app.ready();
    app.nodes.get('#theme-toggle').handlers.click();
    assert.equal(app.document.documentElement.dataset.theme, 'light');
  }
});

test('names are shown by default and privacy can still be enabled and disabled', () => {
  assert.doesNotMatch(html.match(/<input\b[^>]*id="privacy"[^>]*>/)[0], /\bchecked\b/);
  const app = loadApp();
  app.ready();
  const name = () => runInNewContext('identity({ id: "worker-real" }, 0)', app.context);
  assert.equal(name(), 'worker-real');
  app.nodes.get('#privacy').handlers.change({ target: { checked: true } });
  assert.equal(name(), '워커 01');
  app.nodes.get('#privacy').handlers.change({ target: { checked: false } });
  assert.equal(name(), 'worker-real');
});

/** Read every rendered text node, including labels nested below inventory cells. */
function renderedText(node) {
  return [node.textContent, ...(node.children ?? []).map(renderedText)].join(' ');
}

test('interval labels use both endpoints and show raw keys below Korean labels', () => {
  const app = loadApp();
  for (const [name, to, label] of [
    ['spec', 'agent-exit', '에이전트 실행'], ['preflight', 'worktree', '사전 점검'],
    ['worktree', 'spec', '워크트리 준비'], ['agent-exit', 'post-check', '사후 검사'],
    ['post-check', 'finish', '마무리'], ['spec', 'failed', '작업 명세 → 실패'],
  ]) {
    const node = runInNewContext(`intervalName(${JSON.stringify({ name, to })})`, app.context);
    assert.equal(node.textContent, label);
    assert.equal(node.children[0].textContent, `${name} → ${to === 'finish' ? '(finish)' : to}`);
  }
});

test('Grok renders in inventory, token breakdown, Gantt and detail with privacy protection', () => {
  const app = loadApp();
  const worker = { id: 'grok:private-id', repo: '', issue: 'ISSUE-7', branch: '', bot: 'Engineering Owner', task: 'Private task',
    agent: 'grok', kind: 'task', status: 'canceled', startedAt: 1000, finishedAt: 3000, lastUpdateAt: 3000,
    elapsedSec: 2, elapsedEstimated: false, tokens: null, retry: null, steps: [], postCheck: { decision: 'unavailable', reasons: [] } };
  runInNewContext(`state = {workers: [${JSON.stringify(worker)}]}; renderWorkers(state.workers); renderTimeline(state.workers); showDetail(state.workers[0].id);`, app.context);
  assert.match(renderedText(app.nodes.get('#workers')), /grok:private-id.*Engineering Owner.*Private task.*grok.*취소.*—/);
  assert.match(renderedText(app.nodes.get('#tokens')), /grok.*—.*토큰 미수집/);
  assert.match(renderedText(app.nodes.get('#timeline')), /ISSUE-7.*grok/);
  assert.match(renderedText(app.nodes.get('#detail-body')), /Engineering Owner.*Private task/);
  runInNewContext('privacy = true; renderWorkers(state.workers); renderTimeline(state.workers); showDetail(state.workers[0].id);', app.context);
  for (const selector of ['#workers', '#timeline', '#detail-body']) {
    assert.doesNotMatch(renderedText(app.nodes.get(selector)), /private-id|Engineering Owner|Private task|ISSUE-7/);
  }
});

test('every known step has a Korean label and unknown or missing ends never render undefined, 기타 or other', () => {
  const app = loadApp();
  const known = ['preflight', 'worktree', 'spec', 'agent-start', 'agent-exit', 'post-check', 'launcher-commit', 'launcher-tests', 'failed', 'dry-run', 'finished', 'cleanup'];
  for (const name of known) {
    const label = runInNewContext(`stepLabel(${JSON.stringify(name)})`, app.context);
    assert.match(label, /[가-힣]/, name);
  }
  assert.equal(runInNewContext('stepLabel("custom-step")', app.context), 'custom-step');
  assert.equal(runInNewContext('stepLabel(undefined)', app.context), '종료');
  assert.equal(runInNewContext('stepLabel("dead")', app.context), '중단 감지');
  for (const step of [{ name: 'spec' }, { name: 'spec', to: 'killed' }, { name: 'custom-step', to: 'failed' }, { name: 'unrecognized', to: 'finish' }]) {
    const text = renderedText(runInNewContext(`intervalName(${JSON.stringify(step)})`, app.context));
    assert.doesNotMatch(text, /undefined|기타|\bother\b/, JSON.stringify(step));
  }
});

test('failed worker shows reason, signal, heartbeat age and log tail; privacy hides names and logs', () => {
  const app = loadApp();
  const worker = { id: 'lw-1', repo: 'r', issue: 'AIMON-2', branch: 'b', title: '실패 상세 작업', agent: 'codex', kind: null,
    status: 'killed', startedAt: 1000, finishedAt: null, lastUpdateAt: 3000, heartbeatAt: 48000, elapsedSec: 2, elapsedEstimated: true,
    exitCode: null, signal: 'SIGTERM', tokens: null, retry: null, launcherPid: null, agentPid: null,
    steps: [{ name: 'agent-exit', to: 'killed', at: 2000, durationSec: 1 }],
    failure: { code: 'killed', label: '강제 종료 (SIGTERM)', logTail: ['LOG_LINE_A', 'LOG_LINE_B'] },
    postCheck: { decision: 'unavailable', reasons: [] } };
  const proc = { pid: 4242, elapsedSec: 65, binary: 'claude', subcommand: '-p', cwd: '~/worktrees/x', status: 'untracked running' };
  const summary = { counts: { killed: 1 }, failureRate: 1, failed: 1, finished: 1, retryRate: 0, retries: 0, retryEligible: 0, retryUnknown: 1, attempts: 1 };
  const snapshot = { generatedAt: 60000, workers: [worker], untracked: [proc], summary: { day: summary } };
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderMetrics(); renderWorkers(state.workers); showDetail('lw-1');`, app.context);
  const detail = renderedText(app.nodes.get('#detail-body'));
  assert.match(detail, /codex \/ 실패 상세 작업/);
  assert.match(detail, /강제 종료 \/ — \/ SIGTERM/);
  assert.match(detail, /강제 종료 \(SIGTERM\)/);
  assert.match(detail, /하트비트 12초 전/);
  assert.match(detail, /LOG_LINE_A\nLOG_LINE_B/);
  assert.doesNotMatch(detail, /undefined|기타|\bother\b|봇 \/ 작업 — \/ —/);
  const rows = renderedText(app.nodes.get('#workers'));
  assert.match(rows, /강제 종료 \(SIGTERM\).*LOG_LINE_B/s);
  assert.match(rows, /에이전트 종료/);
  assert.match(rows, /PID 4242.*~\/worktrees\/x.*claude -p.*미등록 실행 중.*1분 5초/s);
  assert.match(renderedText(app.nodes.get('#metrics')), /미등록 실행 중 1/);
  runInNewContext('privacy = true; renderWorkers(state.workers); showDetail("lw-1");', app.context);
  for (const selector of ['#workers', '#detail-body']) {
    const text = renderedText(app.nodes.get(selector));
    assert.doesNotMatch(text, /실패 상세 작업|LOG_LINE|~\/worktrees|AIMON-2/, selector);
    assert.match(text, /강제 종료 \(SIGTERM\)/, selector);
  }
});

test('stale heartbeat shows its age and failure codes stay visible in inventory and detail, also with privacy on', () => {
  const app = loadApp();
  const base = { repo: 'r', branch: 'b', agent: 'claude', kind: null, startedAt: 1000, finishedAt: null, lastUpdateAt: 3000,
    elapsedSec: 2, elapsedEstimated: false, exitCode: null, signal: null, tokens: null, retry: null, launcherPid: 7, agentPid: null, steps: [] };
  const stale = { ...base, id: 'lw-stale', issue: 'AIMON-11', title: '숨길 작업 제목', status: 'running', heartbeatAt: -5000, heartbeatAgeSec: 65,
    heartbeatStale: true, failure: null, postCheck: { decision: 'unavailable', reasons: [] } };
  const fresh = { ...stale, id: 'lw-fresh', heartbeatAt: 55000, heartbeatAgeSec: 5, heartbeatStale: false };
  const failed = { ...base, id: 'lw-failed', issue: 'AIMON-12', title: '실패 작업', status: 'failed', heartbeatAt: null, heartbeatAgeSec: null,
    heartbeatStale: false, postCheck: { decision: 'fail', reasons: ['foreign-identity', 'dirty-worktree', 'no-commits'] },
    failure: { code: 'post-check', codes: ['foreign-identity', 'dirty-worktree', 'git-failed: from-ref', 'no-commits'],
      label: 'foreign-identity, 작업 트리 미정리, git 명령 실패: from-ref, 커밋 없음', logTail: ['CHAT_LOG_LINE'] } };
  const snapshot = { generatedAt: 60000, workers: [stale, fresh, failed], untracked: [] };
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderWorkers(state.workers);`, app.context);
  const rows = app.nodes.get('#workers').children.map(renderedText);
  assert.match(rows[0], /하트비트 끊김 · 1분 5초 전/);
  assert.doesNotMatch(rows[1], /하트비트 끊김/);
  assert.match(rows[2], /foreign-identity, 작업 트리 미정리, git 명령 실패: from-ref, 커밋 없음/);
  assert.match(rows[2], /사유 코드: dirty-worktree, no-commits/);
  assert.doesNotMatch(rows.join('\n'), /undefined|기타/);
  runInNewContext('showDetail("lw-stale")', app.context);
  assert.match(renderedText(app.nodes.get('#detail-body')), /하트비트 끊김 · 1분 5초 전.*하트비트 1분 5초 전 · 60초 초과 \(끊김\)/s);
  runInNewContext('showDetail("lw-fresh")', app.context);
  assert.doesNotMatch(renderedText(app.nodes.get('#detail-body')), /끊김/);
  runInNewContext('showDetail("lw-failed")', app.context);
  assert.match(renderedText(app.nodes.get('#detail-body')), /사유 코드 foreign-identity, dirty-worktree, no-commits, git-failed: from-ref/);
  runInNewContext('privacy = true; renderWorkers(state.workers); showDetail("lw-failed");', app.context);
  for (const selector of ['#workers', '#detail-body']) {
    const text = renderedText(app.nodes.get(selector));
    assert.doesNotMatch(text, /숨길 작업 제목|실패 작업|CHAT_LOG_LINE|AIMON-1[12]/, selector);
    assert.match(text, /foreign-identity/, selector);
    assert.match(text, /dirty-worktree/, selector);
  }
  assert.match(renderedText(app.nodes.get('#workers')), /하트비트 끊김 · 1분 5초 전/);
});

/** Build a minimal snapshot around a fixed clock for tab status checks; a worker row may carry extra fields. */
function tabSnapshot({ workers = [], untracked = [], lanes, asks } = {}) {
  const now = 10 * 86400000;
  return { generatedAt: now, untracked, lanes, asks, workers: workers.map(([status, ageMs, awaiting = null, extra = {}], index) => ({
    id: `w${index}`, status, startedAt: now - ageMs, awaiting, resolved: false, heartbeatStale: false, ...extra })) };
}

test('favicon is red only for open items: lane at 0, unpicked failure, overdue handoff and open approval', () => {
  const app = loadApp();
  const hour = 3600000;
  const awaiting = { owner: 'coordinator', ageSec: 900 };
  const proc = { pid: 1, elapsedSec: 5, binary: 'claude', subcommand: '-p', cwd: '', status: 'untracked running' };
  const covered = [{ name: 'impl', running: 1, zero: false }];
  const ask = { id: 'ask-1', title: '배포 승인', owner: 'eo', ageSec: 60, unstaffed: true };
  for (const [name, fixture, color] of [
    ['lane at 0', { workers: [['running', hour]], lanes: [...covered, { name: 'review', running: 0, zero: true }] }, 'red'],
    ['dead stale-heartbeat worker alone is not red', { workers: [['dead', hour, null, { heartbeatStale: true }], ['running', hour]] }, 'blue'],
    ['dead worker with process gone alone is not red', { workers: [['dead', 48 * hour]] }, 'green'],
    ['unpicked failed worker', { workers: [['failed', hour]], lanes: covered }, 'red'],
    ['unpicked killed worker while running', { workers: [['killed', hour], ['running', hour]], lanes: covered }, 'red'],
    ['unpicked failure older than 24h', { workers: [['failed', 48 * hour]] }, 'red'],
    ['awaiting over 10 minutes', { workers: [['succeeded', hour, awaiting]] }, 'green'],
    ['awaiting while running', { workers: [['succeeded', 48 * hour, awaiting], ['running', hour]] }, 'blue'],
    ['open approval while idle', { workers: [['succeeded', hour]], asks: [ask] }, 'red'],
    ['open approval while running', { workers: [['running', hour]], asks: [{ ...ask, unstaffed: false }] }, 'red'],
    ['retried, superseded or acked failures', { workers: [['failed', 2 * hour, null, { resolved: true }], ['killed', hour, null, { resolved: true }]] }, 'green'],
    ['resolved failure while running', { workers: [['failed', hour, null, { resolved: true }], ['running', hour]], lanes: covered }, 'blue'],
    ['dead worker superseded or acked', { workers: [['dead', hour, null, { resolved: true }], ['running', hour]] }, 'blue'],
    ['acked or advanced result is not awaiting', { workers: [['succeeded', hour, null, { resolved: true }]] }, 'green'],
    ['untracked process is not a red reason', { workers: [['succeeded', hour]], untracked: [proc] }, 'green'],
    ['no open asks', { workers: [['succeeded', hour]], asks: [] }, 'green'],
    ['running', { workers: [['running', hour], ['succeeded', hour]], lanes: covered }, 'blue'],
    ['starting', { workers: [['starting', hour]] }, 'blue'],
    ['idle ok', { workers: [['succeeded', hour], ['no-changes', hour], ['canceled', hour]] }, 'green'],
    ['empty', {}, 'green'],
  ]) {
    assert.equal(runInNewContext(`faviconColor(${JSON.stringify(tabSnapshot(fixture))})`, app.context), color, name);
  }
});

test('open items render one per line in the needs-attention panel; title, favicon and header tooltip show only the count', () => {
  const app = loadApp();
  const hour = 3600000;
  const snapshot = tabSnapshot({
    workers: [
      ['dead', hour, null, { issue: 'AIMON-31', heartbeatStale: true }],
      ['dead', hour, null, { issue: 'AIMON-32' }],
      ['succeeded', hour, { owner: 'eo', ageSec: 900 }, { issue: 'AIMON-33' }],
      ['failed', hour, null, { issue: 'AIMON-34' }],
      ['failed', hour, null, { issue: 'AIMON-35', resolved: true }],
      ['killed', hour, null, { issue: 'AIMON-36' }],
      ['failed', hour, { owner: 'eo', ageSec: 1200 }, { issue: 'AIMON-37' }],
      ['dead', hour, null, { issue: 'AIMON-38', resolved: true }],
      ['failed', hour],
    ],
    lanes: [{ name: 'review', running: 0, zero: true }, { name: 'impl', running: 1, zero: false }],
    asks: [{ id: 'ask-1', title: '배포 승인', owner: 'eo', ageSec: 60, unstaffed: true }, { id: 'ask-2', title: '', owner: 'eo', ageSec: 60, unstaffed: false }],
  });
  const lines = [
    '레인 review 실행 0',
    'AIMON-33 (w2) · 병합 대기 · 15분 · eo · 이유 없음',
    'AIMON-34 (w3) 실패 미처리',
    'AIMON-36 (w5) 강제 종료 미처리',
    'AIMON-37 (w6) 실패 미처리 · 병합 대기 · 20분 · eo · 이유 없음',
    'w8 실패 미처리',
    '승인 대기 ask-1 배포 승인',
    '승인 대기 ask-2',
  ];
  const title = runInNewContext(`documentTitle(${JSON.stringify(snapshot)})`, app.context);
  assert.equal(title, '🔴 (0) AI 팀 모니터링 · 열린 항목 7건');
  assert.doesNotMatch(title, /\n|AIMON|w\d|review|ask-/);
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderTabStatus(); renderAttention();`, app.context);
  const items = app.nodes.get('#attention-list').children;
  assert.deepEqual(items.map((item) => item.textContent), lines);
  for (const item of items) {
    assert.match(item.className, /^attention-item(?: attention-(?:orange|red))?$/);
    assert.equal(item.attributes.title, item.textContent);
  }
  assert.equal(app.nodes.get('#attention-count').textContent, '8건');
  const tooltip = app.nodes.get('#alert-tooltip').textContent;
  assert.match(tooltip, /^열린 항목 7건/);
  assert.equal(app.nodes.get('link[rel="icon"]').attributes.title, '열린 항목 7건');
  assert.equal(app.nodes.get('#alert-trigger').attributes['aria-label'], '열린 항목 7건');
  assert.equal(app.nodes.get('#alert-trigger').textContent, '● 7');
  for (const text of [tooltip, app.nodes.get('link[rel="icon"]').attributes.title]) {
    assert.doesNotMatch(text, /AIMON|\(w\d\)|w8|review|ask-|\n/);
  }
  assert.equal(app.nodes.get('#alert-status').hidden, false);
  runInNewContext('privacy = true; renderTabStatus(); renderAttention();', app.context);
  const hidden = app.nodes.get('#attention-list').children.map((item) => item.textContent);
  assert.equal(hidden.length, lines.length);
  assert.deepEqual([hidden[0], hidden[2], hidden.at(-2), hidden.at(-1)], ['레인 01 실행 0', '워커 숨김 실패 미처리', '승인 대기 질문 01', '승인 대기 질문 02']);
  assert.doesNotMatch(hidden.join(' '), /review|AIMON|ask-|배포|w\d/);
});

test('live and attention lists append only the supplied task summary and hide it in privacy mode', () => {
  const app = loadApp();
  const snapshot = tabSnapshot({ workers: [
    ['running', 60000, null, { issue: 'AIMON-30', taskSummary: 'HARNESS-7 공동 저자 트레일러 사전 제거' }],
    ['succeeded', 3600000, { owner: 'eo', ageSec: 2400 }, { taskSummary: '다음 단계 작업', handoff: { owner: 'eo', nextStep: 'verify' } }],
    ['failed', 3600000, null, { taskSummary: '실패 작업' }],
    ['running', 60000, null, { title: '대체 제목 금지', task: '채팅 작업 금지', branch: '대체 브랜치 금지' }],
  ] });
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderLiveWork(); renderAttention();`, app.context);
  const summaries = (selector) => app.nodes.get(selector).children.flatMap((item) => item.children.map((child) => child.textContent));
  assert.deepEqual(summaries('#running-list'), ['HARNESS-7 공동 저자 트레일러 사전 제거']);
  assert.deepEqual(summaries('#attention-list'), ['다음 단계 작업', '실패 작업']);
  assert.equal(app.nodes.get('#running-list').children[0].textContent, 'AIMON-30 (w0) · 실행 중 · 08:59:00 시작 · 1분');
  assert.equal(app.nodes.get('#attention-list').children[0].textContent, 'w1 · 검증 대기 · 40분 · eo · 이유 없음');
  assert.equal(app.nodes.get('#attention-list').children[1].textContent, 'w2 실패 미처리');
  assert.equal(app.nodes.get('#attention-count').textContent, '2건');
  runInNewContext('privacy = true; renderLiveWork(); renderAttention();', app.context);
  for (const selector of ['#running-list', '#attention-list']) {
    assert.deepEqual(summaries(selector), []);
    assert.doesNotMatch(renderedText(app.nodes.get(selector)), /HARNESS|공동 저자|다음 단계 작업|실패 작업|대체 제목|채팅 작업|대체 브랜치/);
  }
});

test('failures without inbox records stay visible without a legacy fold; handled failures leave alerts', () => {
  const app = loadApp();
  const snapshot = tabSnapshot({ workers: [
    ['succeeded', 30 * 3600000, null, { legacy: true }],
    ['failed', 30 * 3600000, null, { issue: 'AIMON-81', legacy: true }],
    ['killed', 30 * 3600000, null, { issue: 'AIMON-82', legacy: true }],
    ['failed', 30 * 3600000, null, { resolved: true }],
  ] });
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderTabStatus(); renderAttention();`, app.context);
  assert.deepEqual(app.nodes.get('#attention-list').children.map((item) => item.textContent), [
    'AIMON-81 (w1) 실패 미처리', 'AIMON-82 (w2) 강제 종료 미처리',
  ]);
  assert.match(app.nodes.get('#alert-tooltip').textContent, /^열린 항목 2건/);
  assert.doesNotMatch(html, /attention-legacy/);
});

test('without an open item the tab is blue while running, else green, with no tooltip or indicator', () => {
  const app = loadApp();
  const hour = 3600000;
  for (const [fixture, color, title] of [
    [{ workers: [['running', hour], ['failed', hour, null, { resolved: true }]], asks: [] }, 'blue', '(1) AI 팀 모니터링'],
    [{ workers: [['succeeded', hour], ['killed', hour, null, { resolved: true }]] }, 'green', '(0) AI 팀 모니터링'],
  ]) {
    runInNewContext(`state = ${JSON.stringify(tabSnapshot(fixture))}; renderTabStatus();`, app.context);
    assert.equal(app.document.title, title);
    assert.match(decodeURIComponent(app.nodes.get('link[rel="icon"]').attributes.href), new RegExp(`fill="${color === 'blue' ? '#3b82f6' : '#22a06b'}"`));
    assert.equal(app.nodes.get('link[rel="icon"]').attributes.title, '');
    assert.equal(app.nodes.get('#alert-tooltip').textContent, '');
    assert.equal(app.nodes.get('#alert-status').hidden, true);
  }
  assert.match(html, /<span id="alert-status" class="alert-status" hidden><button id="alert-trigger"[^>]*aria-describedby="alert-tooltip"><\/button><span id="alert-tooltip" class="alert-tooltip" role="tooltip"><\/span><\/span>/);
});

test('title shows tracked running count and each SSE snapshot updates the favicon link and title', () => {
  const app = loadApp();
  const proc = { pid: 1, elapsedSec: 5, binary: 'codex', subcommand: 'exec', cwd: '', status: 'untracked running' };
  const title = (fixture) => runInNewContext(`documentTitle(${JSON.stringify(tabSnapshot(fixture))})`, app.context);
  assert.equal(title({}), '(0) AI 팀 모니터링');
  assert.equal(title({ workers: [['succeeded', 1000]], untracked: [proc] }), '(0) AI 팀 모니터링');
  assert.equal(title({ workers: [['running', 1000], ['starting', 1000], ['failed', 1000, null, { resolved: true }]] }), '(2) AI 팀 모니터링');
  const summary = { counts: {}, failureRate: 0, failed: 0, finished: 0, retryRate: 0, retries: 0, retryEligible: 0, retryUnknown: 0, attempts: 0 };
  const snapshot = { ...tabSnapshot({ workers: [['running', 1000]] }), summary: { day: summary, all: summary }, events: [], handoffs: [], sources: {}, alerts: { count: 0 } };
  snapshot.workers = snapshot.workers.map((worker) => ({ ...worker, agent: 'claude', elapsedSec: 1, tokens: null, steps: [] }));
  let feed;
  app.context.EventSource = class { constructor() { feed = this; } };
  app.ready();
  const icon = () => decodeURIComponent(app.nodes.get('link[rel="icon"]').attributes.href);
  feed.onmessage({ data: JSON.stringify(snapshot) });
  assert.equal(app.nodes.get('#connection').textContent, '● LIVE');
  assert.equal(app.document.title, '(1) AI 팀 모니터링');
  assert.match(icon(), /^data:image\/svg\+xml,<svg[^>]*>.*fill="#3b82f6"/);
  feed.onmessage({ data: JSON.stringify({ ...snapshot, workers: [{ ...snapshot.workers[0], status: 'failed', resolved: true }] }) });
  assert.equal(app.document.title, '(0) AI 팀 모니터링');
  assert.match(icon(), /fill="#22a06b"/);
  feed.onmessage({ data: JSON.stringify({ ...snapshot, workers: [{ ...snapshot.workers[0], status: 'failed' }] }) });
  assert.equal(app.document.title, '🔴 (0) AI 팀 모니터링 · 열린 항목 1건');
  assert.match(icon(), /fill="#e5484d"/);
  feed.onmessage({ data: JSON.stringify({ ...snapshot, workers: [{ ...snapshot.workers[0], status: 'dead' }] }) });
  assert.equal(app.document.title, '(0) AI 팀 모니터링');
  assert.match(icon(), /fill="#22a06b"/);
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
});

/** Build a snapshot with one worker per spec, relative to a fixed clock, for window selection checks. */
function windowSnapshot(specs) {
  const now = 10 * 86400000;
  const workers = specs.map(([id, status, ageHours, awaiting = null]) => ({ id, repo: 'r', issue: id, branch: 'b', agent: 'claude', kind: null,
    status, startedAt: now - ageHours * 3600000, finishedAt: null, lastUpdateAt: now, elapsedSec: 1, elapsedEstimated: false,
    tokens: null, retry: null, steps: [], awaiting, failure: null, postCheck: { decision: 'unavailable', reasons: [] } }));
  return { generatedAt: now, workers, untracked: [], events: [], handoffs: [], sources: {}, alerts: { count: 0 }, asks: [] };
}

/** Render the snapshot through the real SSE handler and return the inventory and metric texts. */
function renderWindowSnapshot(app, snapshot) {
  let feed;
  app.context.EventSource = class { constructor() { feed = this; } };
  app.ready();
  feed.onmessage({ data: JSON.stringify(snapshot) });
  return { feed, workers: () => renderedText(app.nodes.get('#workers')), metrics: () => renderedText(app.nodes.get('#metrics')) };
}

test('metrics omit live work cards while keeping list badges and the attempts caption through SSE', () => {
  const app = loadApp();
  renderWindowSnapshot(app, windowSnapshot([
    ['running-worker', 'running', 1],
    ['waiting-worker', 'succeeded', 1, { owner: 'eo', ageSec: 1200 }],
  ]));

  const labels = app.nodes.get('#metrics').children.map((card) => card.children[0].textContent);
  assert.deepEqual(labels, [
    '● 성공', '● 변경 없음', '● 실패', '● 강제 종료', '● 중단 감지', '● 취소',
    '● 미등록 실행 중', '실패율', '재시도율',
  ]);
  assert.equal(app.nodes.get('#running-count').textContent, '1건');
  assert.equal(app.nodes.get('#attention-count').textContent, '1건');
  assert.match(renderedText(app.nodes.get('#running-list')), /running-worker/);
  assert.match(renderedText(app.nodes.get('#attention-list')), /waiting-worker/);
  assert.equal(app.nodes.get('#attempts').textContent, '2회 실행 · 시작 시각 기준 · 실행 중·다음 단계 대기는 항상 포함');
});

test('no-changes worker renders 변경 없음 in inventory and increments its summary count through SSE', () => {
  const app = loadApp();
  const view = renderWindowSnapshot(app, windowSnapshot([]));
  const metric = (label) => app.nodes.get('#metrics').children.find((card) => card.children[0].textContent === `● ${label}`);
  assert.equal(metric('변경 없음').children[1].textContent, '0');

  view.feed.onmessage({ data: JSON.stringify(windowSnapshot([['unchanged-worker', 'no-changes', 1]])) });

  assert.equal(app.nodes.get('#worker-count').textContent, '1 WORKERS');
  const badge = app.nodes.get('#workers').children[0].children[2].children[0];
  assert.equal(badge.textContent, '변경 없음');
  assert.equal(badge.className, 'status no-changes');
  assert.equal(metric('변경 없음').children[1].textContent, '1');
  for (const label of ['성공', '실패']) assert.equal(metric(label).children[1].textContent, '0');
  assert.doesNotMatch(view.workers(), /unknown|알 수 없음|미확인|undefined/);
});

test('default window is 3h with empty URL and storage, and summary labels use the 3H prefix', () => {
  assert.match(html, /<button id="window-3h"[^>]*aria-pressed="true">3시간<\/button>/);
  for (const preset of ['1h', '6h', '12h', '24h', 'all']) assert.match(html, new RegExp(`<button id="window-${preset}"[^>]*aria-pressed="false"`));
  assert.doesNotMatch(html, /id="day"|최근 24시간<\/button>/);
  const app = loadApp();
  const view = renderWindowSnapshot(app, windowSnapshot([['recent', 'succeeded', 1]]));
  assert.equal(runInNewContext('timeWindow', app.context), '3h');
  assert.equal(app.nodes.get('#window-3h').attributes['aria-pressed'], 'true');
  assert.equal(app.nodes.get('#window-24h').attributes['aria-pressed'], 'false');
  assert.match(view.metrics(), /3H ATTEMPTS/);
  assert.doesNotMatch(view.metrics(), /24H ATTEMPTS|ALL ATTEMPTS/);
  assert.deepEqual(app.writes, []);
  assert.deepEqual(app.urls, []);
});

test('URL window wins over storage and updates it; stored window applies when the URL has none', () => {
  const fromUrl = loadApp({ href: 'http://127.0.0.1:4317/?window=1h', storedWindow: '24h' });
  const view = renderWindowSnapshot(fromUrl, windowSnapshot([['recent', 'succeeded', 0.5]]));
  assert.equal(runInNewContext('timeWindow', fromUrl.context), '1h');
  assert.equal(fromUrl.stored.window, '1h');
  assert.match(view.metrics(), /1H ATTEMPTS/);
  const fromStorage = loadApp({ storedWindow: '3h' });
  fromStorage.ready();
  assert.equal(runInNewContext('timeWindow', fromStorage.context), '3h');
  const all = loadApp({ storedWindow: 'all' });
  const allView = renderWindowSnapshot(all, windowSnapshot([['old', 'succeeded', 100]]));
  assert.match(allView.metrics(), /ALL ATTEMPTS/);
  assert.doesNotMatch(allView.metrics(), /\dH ATTEMPTS/);
  assert.match(allView.workers(), /old/);
  all.nodes.get('#window-6h').handlers.click();
  assert.equal(all.stored.window, '6h');
  assert.equal(new URL(all.urls.at(-1)).searchParams.get('window'), '6h');
  assert.match(allView.metrics(), /6H ATTEMPTS/);
  assert.equal(all.nodes.get('#window-6h').attributes['aria-pressed'], 'true');
});

test('custom hour windows are accepted from the URL and input; invalid values keep the last valid window', () => {
  const custom = loadApp({ href: 'http://127.0.0.1:4317/?window=5h' });
  const view = renderWindowSnapshot(custom, windowSnapshot([['four', 'succeeded', 4], ['six', 'succeeded', 6]]));
  assert.equal(runInNewContext('timeWindow', custom.context), '5h');
  assert.equal(custom.nodes.get('#window-hours').value, '5');
  assert.match(view.metrics(), /5H ATTEMPTS/);
  assert.match(view.workers(), /four/);
  assert.doesNotMatch(view.workers(), /six/);
  const input = custom.nodes.get('#window-hours');
  const submit = (value) => { input.value = value; custom.nodes.get('#window-form').handlers.submit({ preventDefault() {} }); };
  submit('7');
  assert.equal(runInNewContext('timeWindow', custom.context), '7h');
  assert.equal(custom.stored.window, '7h');
  assert.equal(new URL(custom.urls.at(-1)).searchParams.get('window'), '7h');
  assert.match(view.workers(), /six/);
  for (const invalid of ['', 'abc', '0', '-3', '2.5']) {
    submit(invalid);
    assert.equal(runInNewContext('timeWindow', custom.context), '7h', JSON.stringify(invalid));
    assert.equal(input.attributes['aria-invalid'], 'true');
  }
  assert.equal(custom.stored.window, '7h');
  for (const invalid of ['0h', '-2h', 'abc', '']) {
    const app = loadApp({ href: `http://127.0.0.1:4317/?window=${encodeURIComponent(invalid)}`, storedWindow: '12h' });
    app.ready();
    assert.equal(runInNewContext('timeWindow', app.context), '12h', invalid);
    const fallback = loadApp({ href: `http://127.0.0.1:4317/?window=${encodeURIComponent(invalid)}`, storedWindow: 'bogus' });
    fallback.ready();
    assert.equal(runInNewContext('timeWindow', fallback.context), '3h', invalid);
  }
});

test('running and awaiting workers stay visible outside the window while other finished workers follow it', () => {
  const app = loadApp();
  const awaiting = { owner: 'coordinator', ageSec: 900 };
  const view = renderWindowSnapshot(app, windowSnapshot([
    ['old-running', 'running', 10], ['old-starting', 'starting', 10], ['old-awaiting', 'succeeded', 10, awaiting],
    ['old-finished', 'succeeded', 10], ['old-failed', 'failed', 10], ['recent-finished', 'succeeded', 1],
  ]));
  const rows = view.workers();
  for (const id of ['old-running', 'old-starting', 'old-awaiting', 'recent-finished']) assert.match(rows, new RegExp(id), id);
  for (const id of ['old-finished', 'old-failed']) assert.doesNotMatch(rows, new RegExp(id), id);
  assert.equal(app.nodes.get('#worker-count').textContent, '4 WORKERS');
  app.nodes.get('#window-12h').handlers.click();
  assert.match(view.workers(), /old-finished.*old-failed/s);
});

test('usage column, CLI totals and detail headline the reported cost, not the cache-inclusive sum', () => {
  const app = loadApp();
  const base = { repo: 'r', issue: 'AIMON-19', branch: 'b', agent: 'claude', status: 'succeeded', startedAt: 1000, finishedAt: 3000,
    lastUpdateAt: 3000, elapsedSec: 2, elapsedEstimated: false, retry: null, steps: [], postCheck: { decision: 'pass', reasons: [] } };
  const claude = { ...base, id: '6cjmbx', usageTruncated: true,
    tokens: { costUsd: 6.4213, newInput: 170948, input: 118, cacheWrite: 170830, cached: 7788936, output: 46014, turns: 87 } };
  const codex = { ...base, id: 'codex-1', agent: 'codex',
    tokens: { costUsd: null, newInput: 60, input: 120, cacheWrite: null, cached: 60, output: 15, turns: 2 } };
  runInNewContext(`state = {generatedAt: 4000, workers: ${JSON.stringify([claude, codex])}}; renderWorkers(state.workers); showDetail('6cjmbx');`, app.context);
  const rows = app.nodes.get('#workers').children;
  const claudeCell = rows[0].children[5];
  assert.equal(claudeCell.textContent, '≥ $6.4213');
  assert.equal(claudeCell.attributes['data-sort-value'], 6.4213);
  assert.equal(claudeCell.children[0].textContent, '새 입력 170,948 · 캐시 읽기 7,788,936 · 출력 46,014 · 턴 87');
  const codexCell = rows[1].children[5];
  assert.equal(codexCell.textContent, '—');
  assert.equal(codexCell.attributes['data-sort-value'], '');
  const tokens = renderedText(app.nodes.get('#tokens'));
  assert.match(tokens, /claude ≥ \$6\.4213 .*새 입력 170,948 · 캐시 읽기 7,788,936/);
  assert.match(tokens, /codex — .*새 입력 60 · 캐시 읽기 60 · 출력 15 · 턴 2/);
  const detail = renderedText(app.nodes.get('#detail-body'));
  assert.match(detail, /비용 \(total_cost_usd\) ≥ \$6\.4213/);
  assert.match(detail, /새 입력 = 입력 118 \+ 캐시 쓰기 170,830/);
  for (const text of [renderedText(app.nodes.get('#workers')), tokens, detail]) {
    assert.doesNotMatch(text, /8,005,898|합계|\$0\.00/);
  }
});

test('missing usage figures render as an em dash, never as zero cost or zero tokens', () => {
  const app = loadApp();
  const worker = { id: 'w', repo: 'r', issue: 'i', branch: 'b', agent: 'claude', status: 'failed', startedAt: 1000, finishedAt: 3000,
    lastUpdateAt: 3000, elapsedSec: 2, elapsedEstimated: false, retry: null, steps: [], postCheck: { decision: 'fail', reasons: [] },
    tokens: { costUsd: null, newInput: null, input: null, cacheWrite: null, cached: null, output: null, turns: null } };
  runInNewContext(`state = {generatedAt: 4000, workers: [${JSON.stringify(worker)}]}; renderWorkers(state.workers);`, app.context);
  const cell = app.nodes.get('#workers').children[0].children[5];
  assert.equal(cell.textContent, '—');
  assert.equal(cell.children[0].textContent, '새 입력 — · 캐시 읽기 — · 출력 — · 턴 —');
  assert.doesNotMatch(renderedText(app.nodes.get('#tokens')), /\$0|새 입력 0/);
});

test('usage hint and column header describe the CLI-reported cost instead of disclaiming it', () => {
  assert.doesNotMatch(html, /비용 추정은 제공하지 않습니다/);
  assert.match(html, /total_cost_usd/);
  assert.match(html, /<th>비용 \/ 토큰<\/th>/);
});

test('owner waits turn red strictly after 30 minutes and only once per failed worker', () => {
  const app = loadApp();
  for (const [status, seconds, resolved, count] of [
    ['succeeded', 1799, false, 0],
    ['succeeded', 1800, false, 0],
    ['succeeded', 1801, false, 1],
    ['failed', 1801, false, 1],
    ['killed', 1801, false, 1],
    ['succeeded', 1801, true, 0],
  ]) {
    const snapshot = tabSnapshot({ workers: [[status, 3600000, { ageSec: seconds }, { resolved }]] });
    assert.equal(runInNewContext(`currentAlerts(${JSON.stringify(snapshot)}).length`, app.context), count);
  }
});

/** Read the rendered list entries from the DOM double. */
function listText(node) {
  return node.children.map((item) => item.textContent).join(' ');
}

test('live work recalculates coarse start age and handoff owner from each snapshot', () => {
  const app = loadApp();
  const snapshot = tabSnapshot({ workers: [
    ['running', 432000, null, { issue: 'AIMON-30', handoff: { owner: 'Tooling Owner' }, elapsedSec: 999 }],
    ['running', 7500000],
    ['running', 3 * 86400000],
    ['running', 0, null, { startedAt: null }],
    ['running', -60000],
    ['failed', 86400000, null, { merging: { status: 'merging', startedAt: 10 * 86400000 - 125000 }, handoff: { owner: 'Merge Owner' } }],
  ] });
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderLiveWork();`, app.context);
  const rows = () => app.nodes.get('#running-list').children.map((item) => item.textContent);
  assert.deepEqual(rows(), [
    'AIMON-30 (w0) · 실행 중 · 08:52:48 시작 · 7분 · Tooling Owner',
    'w1 · 실행 중 · 06:55:00 시작 · 2시간 5분',
    'w2 · 실행 중 · 09:00:00 시작 · 3일',
    'w3 · 실행 중 · 시작 시각 없음',
    'w4 · 실행 중 · 09:01:00 시작 · 0분',
    'w5 · 병합 중 · 08:57:55 시작 · 2분 · Merge Owner',
  ]);
  runInNewContext('state.generatedAt += 60000; renderLiveWork();', app.context);
  assert.equal(rows()[0], 'AIMON-30 (w0) · 실행 중 · 08:52:48 시작 · 8분 · Tooling Owner');
  runInNewContext('privacy = true; renderLiveWork();', app.context);
  assert.equal(rows()[0], '워커 숨김 · 실행 중 · 08:52:48 시작 · 8분 · 담당 숨김');
  assert.equal(rows()[1], '워커 숨김 · 실행 중 · 06:55:00 시작 · 2시간 6분');
  assert.equal(rows()[5], '워커 숨김 · 병합 중 · 08:57:55 시작 · 3분 · 담당 숨김');
  assert.doesNotMatch(rows().join(' '), /AIMON|Tooling Owner|Merge Owner/);
});

test('bottlenecks retain interval and duration with issue, summary and final status', () => {
  const app = loadApp();
  const snapshot = tabSnapshot({ workers: [
    ['failed', 3600000, null, { issue: 'HARNESS-26', taskSummary: '승인·규칙 원문을 중립 rule 필드로 교체한다' }],
    ['succeeded', 3600000, null, { issue: 'AIMON-38', task: 'TASK_FALLBACK', title: 'TITLE_FALLBACK', branch: 'BRANCH_FALLBACK' }],
  ] });
  for (const worker of snapshot.workers) {
    Object.assign(worker, { agent: 'codex', tokens: null, elapsedSec: 3600, steps: [{ name: 'spec', to: 'agent-exit', durationSec: 125 }] });
  }
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderWorkers(state.workers);`, app.context);
  const rows = () => app.nodes.get('#bottlenecks').children.map(renderedText);
  assert.match(rows()[0], /HARNESS-26 · 승인·규칙 원문을 중립 rule 필드로 교체한다 · 실패/);
  assert.match(rows()[1], /AIMON-38 · 성공/);
  assert.doesNotMatch(rows().join(' '), /TASK_FALLBACK|TITLE_FALLBACK|BRANCH_FALLBACK/);
  for (const row of rows()) {
    assert.match(row, /에이전트 실행.*spec → agent-exit.*2분 5초/);
  }
  runInNewContext('privacy = true; renderWorkers(state.workers);', app.context);
  assert.doesNotMatch(rows().join(' '), /HARNESS-26|AIMON-38|승인·규칙|TASK_FALLBACK|TITLE_FALLBACK|BRANCH_FALLBACK/);
  assert.match(rows()[0], /에이전트 실행.*spec → agent-exit.*실패.*2분 5초/);
  assert.match(rows()[1], /성공/);
});

test('live lists show running beside next stages with issue, worker, age, step and owner', () => {
  const app = loadApp();
  const snapshot = tabSnapshot({ workers: [
    ['running', 1000, null, { issue: 'AIMON-1' }],
    ['succeeded', 3600000, { ageSec: 720, owner: 'eo-bot' }, {
      issue: 'AIMON-2', handoff: { owner: 'Tooling Owner', nextStep: 'verify' },
    }],
  ] });
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderLiveWork(); renderAttention();`, app.context);
  assert.match(listText(app.nodes.get('#running-list')), /AIMON-1.*w0/);
  assert.match(listText(app.nodes.get('#attention-list')), /AIMON-2.*w1.*12분/);
  assert.match(listText(app.nodes.get('#attention-list')), /검증 대기.*Tooling Owner/);
  runInNewContext('privacy = true; renderLiveWork(); renderAttention();', app.context);
  assert.doesNotMatch(listText(app.nodes.get('#attention-list')), /AIMON|w1|Tooling Owner/);
  assert.match(html, /class="live-work"[\s\S]*id="running-list"[\s\S]*id="attention-list"/);
});

test('merged attention includes every wait once with localized reasons and excludes resolved workers', () => {
  const app = loadApp();
  const snapshot = tabSnapshot({ workers: [
    ['succeeded', 3600000, { owner: 'eo', ageSec: 600 }, { taskSummary: '병합 작업', handoff: { nextStep: 'merge', owner: 'eo' } }],
    ['succeeded', 3600000, { owner: 'eo', ageSec: 1801 }, { taskSummary: '검증 작업', handoff: { nextStep: 'verify', owner: 'eo' } }],
    ['succeeded', 3600000, { owner: 'release', ageSec: 900 }, { handoff: { nextStep: 'deploy', owner: 'release' } }],
    ['failed', 3600000, { owner: 'eo', ageSec: 2400 }, { handoff: { nextStep: 'verify', owner: 'eo' } }],
    ['failed', 3600000, { owner: 'eo', ageSec: 2400 }, { resolved: true }],
  ] });
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderAttention();`, app.context);
  const rows = app.nodes.get('#attention-list').children;
  assert.equal(rows.length, 4);
  assert.equal(app.nodes.get('#attention-count').textContent, '4건');
  for (const [index, reason] of ['병합 대기', '검증 대기', '배포 대기', '실패 미처리 · 검증 대기'].entries()) {
    assert.ok(rows[index].textContent.includes(reason));
  }
  runInNewContext('state = { workers: [], lanes: [], asks: [] }; renderAttention();', app.context);
  assert.equal(app.nodes.get('#attention-count').textContent, '0건');
  assert.equal(app.nodes.get('#attention-list').children[0].textContent, '지금 살펴볼 항목이 없습니다.');
});

test('attention items place timestamp before long failure reasons, merge conflicts, handoff details and ask titles', () => {
  const app = loadApp();
  const now = Date.parse('2026-11-25T07:30:00Z');
  const at = Date.parse('2026-11-25T07:17:10Z');
  const snapshot = {
    generatedAt: now,
    lanes: [],
    workers: [
      { id: 'w-mf', issue: 'HARNESS-26', status: 'failed', resolved: false, finishedAt: at - 60000, merging: { status: 'failed', finishedAt: at, reason: 'conflict: ' + 'x'.repeat(120) } },
      { id: 'w-mw', issue: 'HARNESS-35', status: 'merge-conflict', resolved: false, finishedAt: at, mergeWait: { status: 'merge-conflict', detail: 'a.js, ' + 'b.js, '.repeat(20) } },
      { id: 'w-aw', issue: 'ISSUE-18152', status: 'succeeded', resolved: false, finishedAt: at, awaiting: { owner: 'Engineering Owner', finishedAt: at, ageSec: 770, blocker: 'user-approval', detail: 'very long pending detail' } },
    ],
    asks: [{ id: 'ask-1', title: '아주 긴 승인 요청 제목', owner: 'eo', createdAt: at, ageSec: 770, unstaffed: true }],
  };
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderAttention();`, app.context);
  const rows = app.nodes.get('#attention-list').children.map((item) => item.textContent);
  assert.match(rows[0], /^HARNESS-26 \(w-mf\) · 16:17:10 실패 · 12분 · 병합 실패: conflict:/);
  assert.match(rows[1], /^HARNESS-35 \(w-mw\) · 16:17:10 대기 시작 · 12분 · 병합 충돌 · a\.js/);
  assert.match(rows[2], /^ISSUE-18152 \(w-aw\) · 병합 대기 · 16:17:10 대기 시작 · 12분 · Engineering Owner · user-approval · very long/);
  assert.match(rows[3], /^승인 대기 ask-1 · 16:17:10 대기 시작 · 12분 · 아주 긴 승인 요청 제목$/);
});

test('renderLiveWork shows interactive codex and claude CLI sessions and hides cwd in privacy mode', () => {
  const app = loadApp();
  const snapshot = {
    generatedAt: 60000,
    workers: [],
    untracked: [
      { pid: 50169, elapsedSec: 858, binary: 'codex', subcommand: 'cli', cwd: '~/work', status: 'untracked running' },
      { pid: 41589, elapsedSec: 3605, binary: 'claude', subcommand: 'cli', cwd: '~', status: 'untracked running' },
    ],
  };
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderLiveWork();`, app.context);
  assert.equal(app.nodes.get('#running-count').textContent, '2건');
  const rows = app.nodes.get('#running-list').children.map((item) => item.textContent);
  assert.equal(rows[0], 'codex CLI (PID 50169) · 미등록 실행 중 · ~/work · 14분 18초');
  assert.equal(rows[1], 'claude CLI (PID 41589) · 미등록 실행 중 · ~ · 1시간 0분');
  runInNewContext('privacy = true; renderLiveWork();', app.context);
  const masked = app.nodes.get('#running-list').children.map((item) => item.textContent);
  assert.equal(masked[0], 'codex CLI (PID 50169) · 미등록 실행 중 · 경로 숨김 · 14분 18초');
  assert.doesNotMatch(masked.join('\n'), /~\/work/);
});

test('privacy checkbox syncs with ?privacy=1 query param and restores on reload', () => {
  const app = loadApp({ href: 'http://127.0.0.1:4317/?window=3h&privacy=1' });
  app.ready();
  assert.equal(app.nodes.get('#privacy').checked, true);
  assert.equal(runInNewContext('identity({ id: "worker-real" }, 0)', app.context), '워커 01');
  app.nodes.get('#privacy').handlers.change({ target: { checked: false } });
  assert.equal(app.urls.at(-1), 'http://127.0.0.1:4317/?window=3h');
  assert.equal(runInNewContext('identity({ id: "worker-real" }, 0)', app.context), 'worker-real');
  app.nodes.get('#privacy').handlers.change({ target: { checked: true } });
  assert.equal(app.urls.at(-1), 'http://127.0.0.1:4317/?window=3h&privacy=1');
});

test('worker inventory filter chips filter by status and agent while preserving cohort totals', () => {
  const app = loadApp();
  app.ready();
  const now = 60000;
  const base = { repo: 'r', issue: 'I-1', branch: 'b', startedAt: 1000, finishedAt: 2000, lastUpdateAt: 2000, elapsedSec: 1, elapsedEstimated: false, steps: [], tokens: null, resolved: false };
  const snapshot = {
    generatedAt: now,
    workers: [
      { ...base, id: 'w-codex-run', agent: 'codex', status: 'running', finishedAt: null },
      { ...base, id: 'w-claude-fail', agent: 'claude', status: 'failed' },
      { ...base, id: 'w-cursor-ok', agent: 'cursor', status: 'succeeded' },
    ],
    untracked: [{ pid: 9001, elapsedSec: 10, binary: 'codex', subcommand: 'cli', cwd: '~', status: 'untracked running' }],
  };
  runInNewContext(`state = ${JSON.stringify(snapshot)}; renderWorkers(state.workers);`, app.context);
  assert.equal(app.nodes.get('#worker-count').textContent, '3 WORKERS');
  assert.equal(app.nodes.get('#workers').children.length, 4);

  app.nodes.get('#filter-running').handlers.click();
  assert.equal(app.nodes.get('#worker-count').textContent, '1 / 3 WORKERS');
  assert.equal(app.nodes.get('#workers').children.length, 2);
  assert.equal(app.nodes.get('#filter-running').attributes['aria-pressed'], 'true');

  app.nodes.get('#filter-attention').handlers.click();
  assert.equal(app.nodes.get('#worker-count').textContent, '1 / 3 WORKERS');
  assert.match(renderedText(app.nodes.get('#workers')), /w-claude-fail/);

  app.nodes.get('#filter-cursor').handlers.click();
  assert.equal(app.nodes.get('#worker-count').textContent, '1 / 3 WORKERS');
  assert.match(renderedText(app.nodes.get('#workers')), /w-cursor-ok/);

  app.nodes.get('#filter-all').handlers.click();
  assert.equal(app.nodes.get('#worker-count').textContent, '3 WORKERS');
});

test('page reloads once the server reports different page files, and only then', () => {
  const app = loadApp();
  let reloads = 0;
  app.context.location.reload = () => { reloads += 1; };
  let feed;
  app.context.EventSource = class { constructor() { feed = this; } };
  app.ready();
  const snapshot = windowSnapshot([]);
  // 첫 값은 기준으로만 기록하고, 값이 없거나 같으면 새로고침하지 않는다.
  feed.onmessage({ data: JSON.stringify({ ...snapshot, assetVersion: 'a1' }) });
  feed.onmessage({ data: JSON.stringify({ ...snapshot, assetVersion: 'a1' }) });
  feed.onmessage({ data: JSON.stringify({ ...snapshot, assetVersion: null }) });
  assert.equal(reloads, 0);
  assert.equal(app.nodes.get('#connection').textContent, '● LIVE');
  feed.onmessage({ data: JSON.stringify({ ...snapshot, assetVersion: 'b2' }) });
  assert.equal(reloads, 1);
});
