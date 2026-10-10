// Focus GitHub scan (source id `git`): open work on Hunter's own GitHub repos
// that is waiting on him. scan({ gh, now, limits, log, signal }) lists his
// active repos, runs one GraphQL query per repo and one issue search, and
// resolves at most 10 validated candidates, freshest first. `gh(args,
// { signal })` resolves stdout and rejects on a non-zero exit; any rejection
// or an aborted signal throws ScanError('gh_failed', detail). Repos under other
// owners are never queried. It never writes anything, on GitHub or on disk.
//
// createGh({ timeout }) is the real `gh`, run through execFile; tests inject
// their own.

import { execFile } from 'node:child_process';

import { checkedCandidates, ScanError } from '../candidates.mjs';

export const OWNER = 'hunterphillips';
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 30 * DAY_MS; // a repo pushed within this is active
const MAX_REPOS = 15;
const IDLE_MIN_MS = 2 * DAY_MS; // a pause over a weekend is not a task
const IDLE_MAX_MS = 30 * DAY_MS; // past a month it is abandoned, not in flight
const FAILED_RUN_MS = 2 * DAY_MS;
const MAX_CANDIDATES = 10;
const MAX_TITLE = 200;
const LABELS = Object.freeze({ 'ready-for-human': 'decide', 'needs-info': 'answer' });
const ISSUE_BRANCH_RE = /^(?:claude|local)\/issue-(\d+)$/;

// One repository's open pull requests, branches with their pull requests'
// states, default branch checks, and recently closed issues (for the claude/
// and local/ issue branch skip).
export const REPO_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    name
    url
    defaultBranchRef {
      name
      target {
        ... on Commit {
          checkSuites(last: 1) { nodes { conclusion url updatedAt } }
        }
      }
    }
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        isDraft
        updatedAt
        author { login }
        reviewRequests(first: 10) {
          nodes { requestedReviewer { ... on User { login } } }
        }
      }
    }
    refs(refPrefix: "refs/heads/", first: 100) {
      nodes {
        name
        target { ... on Commit { committedDate } }
        associatedPullRequests(first: 5) { nodes { state } }
      }
    }
    closedIssues: issues(states: CLOSED, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number }
    }
  }
}`;

export function createGh({ timeout }) {
  return (args, { signal } = {}) => new Promise((resolve, reject) => {
    execFile('gh', args, { timeout, signal, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// "5h" under a day, whole days after.
export function age(ms) {
  if (ms < DAY_MS) return `${Math.max(1, Math.floor(ms / 3_600_000))}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function owned(nameWithOwner) {
  return String(nameWithOwner ?? '').split('/')[0].toLowerCase() === OWNER;
}

function candidate(title, url, meta, occursAt) {
  return {
    title: truncate(title, MAX_TITLE),
    source: 'git',
    external_id: url,
    link: url,
    meta,
    occurs_at: occursAt,
  };
}

// Repos pushed within 30 days, freshest first, at most 15.
export function activeRepos(list, nowMs) {
  return (list ?? [])
    .filter((repo) => owned(repo.nameWithOwner))
    .filter((repo) => nowMs - Date.parse(repo.pushedAt) <= ACTIVE_MS)
    .sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt))
    .slice(0, MAX_REPOS);
}

// Candidates from one repository's GraphQL answer.
export function repoCandidates(repository, nowMs) {
  if (!repository) return [];
  const out = [];
  const repo = repository.name;

  for (const pr of repository.pullRequests?.nodes ?? []) {
    const idleMs = nowMs - Date.parse(pr.updatedAt);
    const requested = (pr.reviewRequests?.nodes ?? [])
      .some((request) => String(request.requestedReviewer?.login ?? '').toLowerCase() === OWNER);
    const idle = idleMs >= IDLE_MIN_MS && idleMs <= IDLE_MAX_MS;
    if (!requested && !idle) continue;
    const meta = requested
      ? `review requested · ${age(idleMs)}`
      : `${pr.isDraft ? 'draft · ' : ''}idle ${age(idleMs)}`;
    out.push(candidate(`${repo}#${pr.number}: review and merge`, pr.url, meta, pr.updatedAt));
  }

  const defaultBranch = repository.defaultBranchRef;
  const suite = defaultBranch?.target?.checkSuites?.nodes?.at(-1);
  if (suite?.conclusion === 'FAILURE' && suite.url && nowMs - Date.parse(suite.updatedAt) <= FAILED_RUN_MS) {
    out.push(candidate(
      `${repo}: fix the failed run`,
      suite.url,
      `checks failed · ${age(nowMs - Date.parse(suite.updatedAt))}`,
      suite.updatedAt,
    ));
  }

  const closed = new Set((repository.closedIssues?.nodes ?? []).map((issue) => issue.number));
  for (const ref of repository.refs?.nodes ?? []) {
    if (ref.name === defaultBranch?.name) continue;
    const committed = ref.target?.committedDate;
    if (!committed) continue;
    const idleMs = nowMs - Date.parse(committed);
    if (!(idleMs >= IDLE_MIN_MS && idleMs <= IDLE_MAX_MS)) continue;
    // An open pull request is already on the board; a merged one means the
    // branch was finished and never deleted. Closed unmerged still counts.
    if ((ref.associatedPullRequests?.nodes ?? []).some((pr) => pr.state === 'OPEN' || pr.state === 'MERGED')) continue;
    const issue = ref.name.match(ISSUE_BRANCH_RE);
    if (issue && closed.has(Number(issue[1]))) continue;
    out.push(candidate(
      `${repo}/${ref.name}: finish or delete`,
      `${repository.url}/tree/${ref.name.split('/').map(encodeURIComponent).join('/')}`,
      `idle ${age(idleMs)}`,
      committed,
    ));
  }
  return out;
}

// Candidates from the issue search; an issue carrying both labels is a decision.
export function issueCandidates(issues, nowMs) {
  const out = [];
  for (const issue of issues ?? []) {
    if (!owned(issue.repository?.nameWithOwner)) continue;
    const names = new Set((issue.labels ?? []).map((label) => label.name));
    const label = Object.keys(LABELS).find((name) => names.has(name));
    if (!label) continue;
    out.push(candidate(
      `${issue.repository.name}#${issue.number}: ${LABELS[label]}`,
      issue.url,
      `${label} · ${age(nowMs - Date.parse(issue.updatedAt))}`,
      issue.updatedAt,
    ));
  }
  return out;
}

// Freshest first, one candidate per URL, at most 10.
export function orderAndCap(candidates) {
  const seen = new Set();
  return [...candidates]
    .sort((a, b) => Date.parse(b.occurs_at) - Date.parse(a.occurs_at))
    .filter((c) => (seen.has(c.external_id) ? false : seen.add(c.external_id)))
    .slice(0, MAX_CANDIDATES);
}

export async function scan({ gh, now = Date.now, limits, log = () => {}, signal } = {}) {
  const nowMs = typeof now === 'function' ? now() : Number(now);

  async function run(args) {
    if (signal?.aborted) throw new ScanError('gh_failed', 'The scan was stopped.');
    let stdout;
    try {
      stdout = await gh(args, { signal });
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).trim();
      throw new ScanError('gh_failed', detail || 'gh failed.');
    }
    try {
      return JSON.parse(stdout);
    } catch (error) {
      throw new ScanError('gh_failed', `gh ${args.slice(0, 2).join(' ')} returned non-JSON: ${error.message}`);
    }
  }

  const repos = activeRepos(await run([
    'repo', 'list', OWNER, '--no-archived', '--source', '--limit', '100',
    '--json', 'nameWithOwner,pushedAt',
  ]), nowMs);

  const candidates = [];
  for (const repo of repos) {
    const [owner, name] = repo.nameWithOwner.split('/');
    const answer = await run([
      'api', 'graphql',
      '-f', `query=${REPO_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
    ]);
    candidates.push(...repoCandidates(answer?.data?.repository, nowMs));
  }

  const issues = await run([
    // One label qualifier with a comma is either label; gh's --label flag
    // would send one qualifier per label, which GitHub reads as both.
    'search', 'issues', 'label:ready-for-human,needs-info', '--owner', OWNER, '--state', 'open',
    '--json', 'repository,number,title,url,labels,updatedAt',
  ]);
  candidates.push(...issueCandidates(issues, nowMs));

  const kept = orderAndCap(candidates);
  log({ event: 'focus_scan_github', repos: repos.length, found: candidates.length, kept: kept.length });
  return checkedCandidates(kept, limits);
}
