/** Read common metadata-only bot events from complete JSONL rows. */
import { join } from 'node:path';
import { clip, ownerOf, parseJsonl, readTail, timestamp } from './harness.mjs';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Keep the last valid row per normalized bot in file order, then additional-file order. */
export async function collectJsonlEvents({ base, eventsJsonlPath = process.env.AI_TEAM_MONITORING_EVENTS_JSONL }) {
  const latest = new Map();
  const paths = new Set([join(base, 'bot-heartbeats.jsonl'), eventsJsonlPath].filter(Boolean));
  for (const path of paths) {
    for (const row of parseJsonl((await readTail(path)).text)) {
      if (typeof row.bot !== 'string' || !row.bot.trim()
        || typeof row.ts !== 'string' || !ISO_TIME.test(row.ts)
        || (row.phase !== undefined && !['start', 'end'].includes(row.phase))) continue;
      const at = timestamp(row.ts);
      if (at === null) continue;
      const name = ownerOf({}, row.bot);
      latest.set(name, {
        name,
        issue: typeof row.issue === 'string' && /^[A-Z][A-Z0-9_]*-\d+$/.test(row.issue) ? row.issue : '',
        taskSummary: typeof row.summary === 'string' ? clip(row.summary) : '',
        startedAt: at,
        lastActivityAt: at,
        phase: row.phase,
      });
    }
  }
  return [...latest.values()];
}
