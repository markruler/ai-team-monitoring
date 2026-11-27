/** Entry point: connect the live stream, wire every section and redraw the page. */
import { date } from './lib/format.js';
import { $ } from './lib/dom.js';
import { setRenderer, setState, state } from './store.js';
import { initPrivacy } from './privacy.js';
import { initWindowControls, visibleWorkers } from './time-window.js';
import { initWorkers, renderMetrics, renderTimeline, renderWorkers, selectedId, showDetail } from './workers.js';
import { renderAsks, renderFeeds, renderInbox } from './feeds.js';
import { renderLaneHistory, renderLanes } from './lanes.js';
import { initAttention, renderAttention, renderBotActivity, renderLiveWork, renderTabStatus } from './attention.js';
import { eventsPath, initUsage, keepLastUsage, renderToolUsage } from './usage.js';
import { initTheme } from './theme.js';

let loadedAssetVersion = null;

/** True when the server now serves different page files than the ones this page started with. */
function assetsChanged(version) {
  if (!version) return false;
  if (loadedAssetVersion === null) {
    loadedAssetVersion = version;
    return false;
  }
  return version !== loadedAssetVersion;
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
  renderToolUsage();
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

setRenderer(render);

let feed = null;

/** (Re)open the live stream so the server collects exactly the checked tools. */
function connect(refresh = false) {
  feed?.close();
  feed = new EventSource(eventsPath(refresh));
  feed.onmessage = (event) => {
    try {
      const next = JSON.parse(event.data);
      // A saved page file reloads every open page, so edits show without pressing refresh.
      if (assetsChanged(next.assetVersion)) {
        location.reload();
        return;
      }
      next.toolUsage = keepLastUsage(next.toolUsage);
      setState(next);
      $('#connection').textContent = '● LIVE';
      $('#connection').classList.remove('disconnected');
      render();
    } catch { $('#connection').textContent = '데이터 확인 필요'; }
  };
  feed.onerror = () => { $('#connection').textContent = '● 연결 재시도 중'; $('#connection').classList.add('disconnected'); };
}

/** Connect dashboard controls and telemetry after the document is ready. */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initWindowControls();
  initWorkers();
  initPrivacy();
  initAttention();
  initUsage(connect);
  connect();
});
