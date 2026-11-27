/** Read-only completion evidence and waiting reasons, scoped to one snapshot request. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const BLOCKERS = new Set(['prerequisite-branch', 'user-approval', 'conflict', 'file-conflict', 'test-failure', 'failure']);
const SUCCEEDED_STATUSES = new Set(['succeeded', 'done']);
const UNIX_SECONDS = /^\d+$/;
/** Accept the numeric timestamps used by inbox rows and ISO worker timestamps. */
const attemptTime = (record) => {
  const value = record.startedAt ?? record.finishedAt;
  return typeof value === 'number' ? value : Date.parse(value);
};
const SHA = /^[a-f0-9]{40,64}$/i;

/** Run bounded local Git queries without a shell or network access. */
export function localGit(repo, args, input = '') {
  return new Promise((resolveResult) => {
    const child = execFile('git', ['-C', repo, ...args], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => resolveResult(error ? null : stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Ignore missing, malformed or oversized optional harness state. */
async function optionalJson(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.length <= 1024 * 1024 ? JSON.parse(text) : null;
  } catch { return null; }
}

/** Normalize waiting maps, worker arrays and escalation output into worker-keyed rows. */
export function evidenceRows(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object')
    .map((row) => [row.workerId ?? row.key ?? row.id, row]);
  if (value.workers || value.entries || value.items) return evidenceRows(value.workers ?? value.entries ?? value.items);
  return Object.entries(value).filter(([, row]) => row && typeof row === 'object' && !Array.isArray(row));
}

/** Read waiting reasons, then prefer the latest escalation evidence when it supplies a field. */
export async function completionEvidence(base) {
  const rows = evidenceRows(await optionalJson(join(base, 'waiting.json')));
  rows.push(...evidenceRows(await optionalJson(join(base, 'escalations.json'))));
  try {
    const text = await readFile(join(base, 'escalations.jsonl'), 'utf8');
    if (text.length <= 1024 * 1024) for (const line of text.split('\n')) {
      try { rows.push(...evidenceRows([JSON.parse(line)])); } catch { /* Partial journal line. */ }
    }
  } catch { /* Optional journal. */ }
  const result = new Map();
  for (const [id, row] of rows) if (typeof id === 'string') {
    const previous = result.get(id) ?? {};
    result.set(id, { ...previous, ...(BLOCKERS.has(row.blocker) ? { blocker: row.blocker } : {}),
      ...(['merge-conflict', 'queued', 'waiting'].includes(row.status) ? { status: row.status } : {}),
      ...(Array.isArray(row.files ?? row.conflictFiles) ? { files: (row.files ?? row.conflictFiles).filter((value) => typeof value === 'string') } : {}),
      ...(typeof row.blocker === 'string' && /^waiting for .+ merge \(file conflict\)$/i.test(row.blocker) ? { detail: row.blocker } : {}),
      ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
      ...(row.doneBy ? { doneBy: row.doneBy } : {}) });
  }
  return result;
}

const VERDICT_CACHE_LIMIT = 5000;
const sharedVerdicts = new Map();

/** Remember one verdict, dropping the oldest entries beyond the limit. */
function rememberVerdict(cache, key, done) {
  cache.set(key, done);
  while (cache.size > VERDICT_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/**
 * Evaluate worker completion. Git queries are shared within one call; final verdicts are cached across calls by
 * repository, integration-target SHA and worker head, so they are recomputed only when the target branch moves.
 * Calls with an injected `git` (tests) get a private cache unless one is passed.
 */
export async function completionFlags(records, { evidence = new Map(), git = localGit, home = homedir(), readOnlySucceeded = () => false, verdicts = git === localGit ? sharedVerdicts : new Map() } = {}) {
  const targets = new Map();
  const queries = new Map();
  const flags = new Map();
  /** Reuse identical Git queries for a repository at the same target SHA. */
  function query(repo, target, args, input = '') {
    const key = JSON.stringify([repo, target, args, input]);
    if (!queries.has(key)) queries.set(key, git(repo, args, input));
    return queries.get(key);
  }
  /** Resolve the integration ref once per repository; personal clones use local main. */
  async function targetFor(repo, company) {
    if (!targets.has(repo)) targets.set(repo, (async () => {
      for (const ref of company ? ['refs/remotes/origin/develop', 'refs/remotes/origin/main'] : ['refs/heads/main']) {
        const sha = await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
        if (SHA.test(sha ?? '')) return sha;
      }
      return null;
    })());
    return targets.get(repo);
  }
  for (const record of records) {
    const id = record.id ?? record._dir;
    const time = attemptTime(record);
    const successor = record.repo && record.issue != null && records.some((next) => next !== record && next.repo === record.repo &&
      next.issue === record.issue && attemptTime(next) > time &&
      (['succeeded', 'done'].includes(next.status) || readOnlySucceeded(next)));
    let done = Boolean(evidence.get(id)?.doneBy) || readOnlySucceeded(record) || successor;
    const head = record.postCheck?.head;
    const repo = typeof record.repoDir === 'string' ? resolve(record.repoDir) : null;
    if (!done && repo && SHA.test(head ?? '')) {
      const company = repo === join(home, 'work') || repo.startsWith(join(home, 'work') + sep);
      const target = await targetFor(repo, company);
      const orphanCheck = SUCCEEDED_STATUSES.has(record._status ?? record.status) && !evidence.get(id)?.blocker;
      const verdictKey = target ? JSON.stringify([repo, target, head, orphanCheck]) : null;
      if (verdictKey && verdicts.has(verdictKey)) {
        done = verdicts.get(verdictKey);
      } else if (target) {
        // merge-base exits nonzero for an unrelated commit; patch-id also handles cherry-picks.
        const ancestor = await query(repo, target, ['merge-base', '--is-ancestor', head, target]);
        done = ancestor !== null;
        if (!done) {
          const patch = await query(repo, target, ['show', '--pretty=format:', '--no-ext-diff', '--no-textconv', head, '--']);
          const patchId = patch ? await query(repo, target, ['patch-id', '--stable'], patch + '\n') : null;
          if (patchId) {
            const history = await query(repo, target, ['log', '--pretty=format:commit %H', '-p', '--no-ext-diff', '--no-textconv', target, '--']);
            const ids = history ? await query(repo, target, ['patch-id', '--stable'], history + '\n') : null;
            done = Boolean(ids?.split('\n').some((line) => line.split(/\s+/)[0] === patchId.split(/\s+/)[0]));
          }
        }
        // A full-history squash or orphan root rewrite severs ancestry and patch-ids for older succeeded commits.
        if (!done && orphanCheck) {
          const commonBase = await query(repo, target, ['merge-base', head, target]);
          if (commonBase === null) {
            const headRaw = await query(repo, target, ['show', '-s', '--format=%ct', head]);
            const rootsRaw = UNIX_SECONDS.test(headRaw ?? '') ? await query(repo, target, ['log', '--max-parents=0', '--format=%ct', target]) : null;
            const rootLines = rootsRaw ? rootsRaw.split('\n').filter(Boolean) : [];
            if (rootLines.length && rootLines.every((line) => UNIX_SECONDS.test(line)) && Number(headRaw) < Math.min(...rootLines.map(Number))) {
              done = await query(repo, target, ['rev-parse', '--is-shallow-repository']) === 'false';
            }
          }
        }
        rememberVerdict(verdicts, verdictKey, done);
      }
    }
    flags.set(id, done);
  }
  return flags;
}
