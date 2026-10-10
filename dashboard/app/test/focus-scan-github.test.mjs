// The Focus GitHub scan over canned `gh` answers about invented repos. The
// fake `gh` records every call; nothing here runs `gh` or reaches GitHub.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { LIMITS } from '../lib/config.mjs';
import { ScanError } from '../lib/focus/candidates.mjs';
import { age, scan } from '../lib/focus/scans/github.mjs';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const fixture = (name) => readFileSync(new URL(`./fixtures/focus/github/${name}`, import.meta.url), 'utf8');

function fakeGh(overrides = {}) {
  const calls = [];
  const gh = async (args, options = {}) => {
    calls.push({ args, options });
    const [command, sub] = args;
    if (overrides[`${command} ${sub}`]) return overrides[`${command} ${sub}`](args);
    if (command === 'repo' && sub === 'list') return fixture('repo-list.json');
    if (command === 'search' && sub === 'issues') return fixture('issues.json');
    if (command === 'api' && sub === 'graphql') {
      const name = args.find((arg) => arg.startsWith('name=')).slice('name='.length);
      return fixture(`graphql-${name}.json`);
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  gh.calls = calls;
  return gh;
}

async function run(gh = fakeGh()) {
  return scan({ gh, now: () => NOW, limits: LIMITS });
}

function byTitle(candidates) {
  return new Map(candidates.map((c) => [c.title, c]));
}

// Every rule's window, without the cap of 10 getting in the way. Also drops
// recipe-box#5 and garden-planner#22, the fixtures for the two-labels and
// idle-and-requested overlap cases, which would otherwise push recipe-box#3
// out of this budget; the tests for those two cases restore one at a time.
async function uncapped() {
  const gh = fakeGh({
    'api graphql': (args) => {
      const name = args.find((arg) => arg.startsWith('name=')).slice('name='.length);
      const answer = JSON.parse(fixture(`graphql-${name}.json`));
      if (name === 'recipe-box') {
        answer.data.repository.refs.nodes = answer.data.repository.refs.nodes.slice(0, 1);
        answer.data.repository.pullRequests.nodes = answer.data.repository.pullRequests.nodes
          .filter((pr) => pr.number !== 5);
      }
      return JSON.stringify(answer);
    },
    'search issues': () => JSON.stringify(JSON.parse(fixture('issues.json')).filter((issue) => issue.number !== 22)),
  });
  return byTitle(await run(gh));
}

test('age reads in hours under a day and whole days after', () => {
  assert.equal(age(30 * 60_000), '1h');
  assert.equal(age(6 * 3600_000), '6h');
  assert.equal(age(26 * 3600_000), '1d');
  assert.equal(age(3 * 86_400_000), '3d');
});

test('an open pull request counts when idle 2 to 30 days, draft or not', async () => {
  const found = await uncapped();
  assert.equal(found.has('garden-planner#11: review and merge'), false, '1 day old is out');
  assert.equal(found.has('garden-planner#13: review and merge'), false, '31 days old is out');
  assert.deepEqual(found.get('garden-planner#12: review and merge'), {
    title: 'garden-planner#12: review and merge',
    source: 'git',
    external_id: 'https://github.com/hunterphillips/garden-planner/pull/12',
    link: 'https://github.com/hunterphillips/garden-planner/pull/12',
    meta: 'draft · idle 3d',
    occurs_at: '2026-10-07T12:00:00Z',
  });
  assert.equal(found.get('recipe-box#3: review and merge').meta, 'idle 10d');
});

test('a review request naming hunterphillips counts at any age; a team request does not', async () => {
  const found = await uncapped();
  assert.equal(found.get('garden-planner#14: review and merge').meta, 'review requested · 1d');
  assert.equal(found.has('garden-planner#15: review and merge'), false);
});

test('a pull request both idle and requested reads once, as review requested', async () => {
  const gh = fakeGh({
    'api graphql': (args) => {
      const name = args.find((arg) => arg.startsWith('name=')).slice('name='.length);
      const answer = JSON.parse(fixture(`graphql-${name}.json`));
      if (name === 'recipe-box') answer.data.repository.refs.nodes = answer.data.repository.refs.nodes.slice(0, 1);
      return JSON.stringify(answer);
    },
    'search issues': () => JSON.stringify(JSON.parse(fixture('issues.json')).filter((issue) => issue.number !== 22)),
  });
  const candidates = await run(gh);
  const url = 'https://github.com/hunterphillips/recipe-box/pull/5';
  const matches = candidates.filter((c) => c.external_id === url);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], {
    title: 'recipe-box#5: review and merge',
    source: 'git',
    external_id: url,
    link: url,
    meta: 'review requested · 3d',
    occurs_at: '2026-10-07T12:00:00Z',
  });
});

test('ready-for-human issues are decisions and needs-info issues are answers', async () => {
  const found = await uncapped();
  const decide = found.get('garden-planner#20: decide');
  assert.equal(decide.meta, 'ready-for-human · 1d');
  assert.equal(decide.external_id, 'https://github.com/hunterphillips/garden-planner/issues/20');
  assert.equal(found.get('recipe-box#21: answer').meta, 'needs-info · 6h');
});

test('an issue carrying both ready-for-human and needs-info is a decision, not an answer', async () => {
  const gh = fakeGh({
    'api graphql': (args) => {
      const name = args.find((arg) => arg.startsWith('name=')).slice('name='.length);
      const answer = JSON.parse(fixture(`graphql-${name}.json`));
      if (name === 'recipe-box') {
        answer.data.repository.refs.nodes = answer.data.repository.refs.nodes.slice(0, 1);
        answer.data.repository.pullRequests.nodes = answer.data.repository.pullRequests.nodes
          .filter((pr) => pr.number !== 5);
      }
      return JSON.stringify(answer);
    },
  });
  const found = byTitle(await run(gh));
  assert.deepEqual(found.get('garden-planner#22: decide'), {
    title: 'garden-planner#22: decide',
    source: 'git',
    external_id: 'https://github.com/hunterphillips/garden-planner/issues/22',
    link: 'https://github.com/hunterphillips/garden-planner/issues/22',
    meta: 'ready-for-human · 21h',
    occurs_at: '2026-10-09T15:00:00Z',
  });
  assert.equal(found.has('garden-planner#22: answer'), false);
});

test('a failed default-branch run counts within 2 days', async () => {
  const found = await uncapped();
  const failed = found.get('garden-planner: fix the failed run');
  assert.equal(failed.meta, 'checks failed · 1d');
  assert.equal(failed.link, 'https://github.com/hunterphillips/garden-planner/commit/aaa111/checks?check_suite_id=101');
  assert.equal(found.has('recipe-box: fix the failed run'), false, '3 days old is out');
});

test('an idle branch without an open or merged pull request counts; merged issue branches are skipped', async () => {
  const found = await uncapped();
  const idle = found.get('garden-planner/idle-branch: finish or delete');
  assert.equal(idle.meta, 'idle 5d');
  assert.equal(idle.link, 'https://github.com/hunterphillips/garden-planner/tree/idle-branch');
  assert.equal(found.has('garden-planner/with-pr: finish or delete'), false, 'an open pull request covers it');
  assert.equal(found.has('garden-planner/merged-pr: finish or delete'), false, 'a merged pull request finished it');
  assert.equal(found.get('garden-planner/closed-pr: finish or delete').meta, 'idle 9d', 'closed unmerged still counts');
  assert.equal(found.has('garden-planner/claude/issue-7: finish or delete'), false, 'issue 7 is closed');
  assert.equal(
    found.get('garden-planner/claude/issue-8: finish or delete').link,
    'https://github.com/hunterphillips/garden-planner/tree/claude/issue-8',
    'issue 8 is still open',
  );
  assert.equal(found.has('garden-planner/fresh-branch: finish or delete'), false);
  assert.equal(found.has('garden-planner/ancient-branch: finish or delete'), false);
  assert.equal(found.has('garden-planner/main: finish or delete'), false, 'the default branch is never idle work');
});

test('freshest first, capped at 10', async () => {
  const candidates = await run();
  assert.deepEqual(candidates.map((c) => c.title), [
    'recipe-box#21: answer',
    'garden-planner#22: decide',
    'garden-planner#14: review and merge',
    'garden-planner: fix the failed run',
    'garden-planner#20: decide',
    'garden-planner#12: review and merge',
    'recipe-box#5: review and merge',
    'garden-planner/claude/issue-8: finish or delete',
    'garden-planner/idle-branch: finish or delete',
    'recipe-box/b1: finish or delete',
  ]);
});

test('only hunterphillips repos are listed and queried, and only active ones', async () => {
  const gh = fakeGh();
  await run(gh);
  const [list, ...rest] = gh.calls.map((call) => call.args);
  assert.deepEqual(list, [
    'repo', 'list', 'hunterphillips', '--no-archived', '--source', '--limit', '100',
    '--json', 'nameWithOwner,pushedAt',
  ]);
  const graphql = rest.filter((args) => args[0] === 'api');
  assert.deepEqual(
    graphql.map((args) => [args.find((a) => a.startsWith('owner=')), args.find((a) => a.startsWith('name='))]),
    [['owner=hunterphillips', 'name=garden-planner'], ['owner=hunterphillips', 'name=recipe-box']],
  );
  assert.ok(
    graphql.every((args) => args.some((a) => a.includes('associatedPullRequests(first: 5) { nodes { state } }'))),
    'every branch pull request state is asked for, unfiltered',
  );
  const search = rest.find((args) => args[0] === 'search');
  assert.deepEqual(search.slice(0, 7), [
    'search', 'issues', 'label:ready-for-human,needs-info', '--owner', 'hunterphillips', '--state', 'open',
  ]);
  for (const call of gh.calls) {
    assert.equal(call.args.some((arg) => arg.includes('another-owner') || arg.includes('old-sketches')), false);
  }
});

test('a failing gh throws ScanError gh_failed with its stderr', async () => {
  const gh = fakeGh({
    'repo list': () => {
      const error = new Error('Command failed: gh repo list');
      error.stderr = 'HTTP 401: Bad credentials\n';
      throw error;
    },
  });
  await assert.rejects(run(gh), (error) => (
    error instanceof ScanError && error.code === 'gh_failed' && error.detail === 'HTTP 401: Bad credentials'
  ));
});

test('an aborted signal throws ScanError gh_failed before gh runs', async () => {
  const gh = fakeGh();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    scan({ gh, now: NOW, limits: LIMITS, signal: controller.signal }),
    (error) => error instanceof ScanError && error.code === 'gh_failed',
  );
  assert.equal(gh.calls.length, 0);
});
