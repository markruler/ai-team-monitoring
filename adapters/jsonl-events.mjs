/** Read common metadata-only bot events from complete JSONL rows. */
import { join } from 'node:path';
import { clip, ownerOf, parseJsonl, readTail, timestamp } from './harness.mjs';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Parse one row into normalized event fields, or null when the row is invalid. */
function eventOf(row) {
  if (typeof row.bot !== 'string' || !row.bot.trim()
    || typeof row.ts !== 'string' || !ISO_TIME.test(row.ts)
    || (row.phase !== undefined && !['start', 'end'].includes(row.phase))) return null;
  const at = timestamp(row.ts);
  if (at === null) return null;
  return {
    name: ownerOf({}, row.bot),
    issue: typeof row.issue === 'string' && ISSUE_KEY.test(row.issue) ? row.issue : '',
    taskSummary: typeof row.summary === 'string' ? clip(row.summary) : '',
    at,
    phase: row.phase,
  };
}

/**
 * Project per-bot activity: the newest valid timestamp and every issue whose latest start has no newer end.
 * Rows are merged across files by timestamp (file order breaks ties); a row without phase counts as a start.
 */
export async function collectJsonlEvents({ base, eventsJsonlPath = process.env.AI_TEAM_MONITORING_EVENTS_JSONL }) {
  const events = [];
  const paths = new Set([join(base, 'bot-heartbeats.jsonl'), eventsJsonlPath].filter(Boolean));
  for (const path of paths) {
    for (const row of parseJsonl((await readTail(path)).text)) {
      const event = eventOf(row);
      if (event) events.push(event);
    }
  }
  events.sort((a, b) => a.at - b.at);
  const bots = new Map();
  for (const event of events) {
    const bot = bots.get(event.name) ?? { name: event.name, lastActivityAt: null, open: new Map() };
    bots.set(event.name, bot);
    bot.lastActivityAt = Math.max(bot.lastActivityAt ?? 0, event.at);
    if (event.phase === 'end') {
      bot.open.delete(event.issue);
      continue;
    }
    const current = bot.open.get(event.issue);
    if (!current) bot.open.set(event.issue, { issue: event.issue, taskSummary: event.taskSummary, startedAt: event.at });
    else if (event.taskSummary) current.taskSummary = event.taskSummary;
  }
  return [...bots.values()].map(({ name, lastActivityAt, open }) => ({ name, lastActivityAt, tasks: [...open.values()] }));
}
