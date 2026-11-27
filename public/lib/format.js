/** Format numbers, money, durations and Seoul clock times for display. */

export const number = (value) => new Intl.NumberFormat('ko-KR').format(Math.round(value ?? 0));

/** Format a reported figure, or an em dash when the CLI never reported it. */
export function figure(value) {
  return value === null || value === undefined ? '—' : number(value);
}

/** Format the CLI-reported total_cost_usd; an unreported cost is an em dash, never $0. */
export function money(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

/** Format durations without exposing source text. */
export function duration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${Math.round(seconds % 60)}초`;
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
}

/** Format existing timestamps as a KST 24-hour clock. */
export function date(value) {
  return clock(value) ?? '—';
}

/** Return HH:MM:SS in Seoul, leaving unavailable timestamps empty. */
export function clock(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

/** Format an elapsed age coarsely, e.g. `12분`, `2시간 5분`, `3일`. */
export function age(seconds) {
  const minutes = Math.floor(Math.max(0, seconds ?? 0) / 60);
  if (minutes < 60) return `${minutes}분`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
  return `${Math.floor(minutes / 1440)}일`;
}

/** Format an instant as `MM/DD HH:MM` in Seoul. */
export function shortDate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
}

/** Format an instant as `HH:MM` in Seoul. */
export function shortTime(value) {
  return shortDate(value).split(' ')[1] ?? '—';
}
