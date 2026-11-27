/** Render lane status and lane history charts. */
import { age, clock, number } from './lib/format.js';
import { $, el, svg } from './lib/dom.js';
import { state } from './store.js';
import { privacy } from './privacy.js';

/** Show each lane's running count; a lane at 0 is red with its time at 0. The panel is hidden without a config. */
export function renderLanes() {
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
export function renderLaneHistory() {
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
