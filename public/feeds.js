/** Render the event feed, open asks and the handoff inbox. */
import { age, date, duration } from './lib/format.js';
import { $, el } from './lib/dom.js';
import { state } from './store.js';
import { privacy } from './privacy.js';
import { awaitingText, labels, mergeWaitText } from './worker-text.js';
import { inWindow } from './time-window.js';

/** Render optional metadata feeds; messages and free-form reasons are never present. */
export function renderFeeds() {
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
export function renderAsks() {
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
export function renderInbox() {
  const target = $('#inbox');
  target.replaceChildren();
  const { pending = [], acked = [] } = state.inbox ?? {};
  for (const item of pending) target.append(pendingInboxRow(item));
  if (!acked.length) return;
  const folded = el('details', undefined, 'inbox-acked-list');
  folded.append(el('summary', `처리됨 ${acked.length}건`), ...acked.map(ackedInboxRow));
  target.append(folded);
}
