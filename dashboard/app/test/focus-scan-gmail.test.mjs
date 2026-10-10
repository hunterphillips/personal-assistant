// The Focus Gmail scan on fixture threads: what machinery gets dropped, and
// the exact sentence a kept thread turns into, the same words every run. The
// Google client and the vault are fakes; nothing here calls Google.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../lib/config.mjs';
import { communityQuery } from '../lib/focus/scans/community-query.mjs';
import {
  filterThread, candidateFromThread, groupForThread, cleanSubject, orderAndCap, scan,
} from '../lib/focus/scans/gmail.mjs';

const ME = 'hunter@example.com';

// A Gmail message as users.threads.get?format=metadata returns one.
function message({ from, to = '', cc = '', subject = 'dinner', at = '2026-09-11T20:00:00Z', headers = {}, labelIds = ['INBOX'], snippet = '' }) {
  const all = { From: from, To: to, Cc: cc, Subject: subject, ...headers };
  return {
    id: `m-${at}`,
    labelIds,
    snippet,
    internalDate: String(Date.parse(at)),
    payload: {
      headers: Object.entries(all)
        .filter(([, v]) => v)
        .map(([name, value]) => ({ name, value })),
    },
  };
}
const thread = (id, ...messages) => ({ id, messages });

test('a thread with only automated senders is dropped', () => {
  const t = thread('t1', message({ from: 'Acme <no-reply@acme.com>', to: ME, subject: 'Your receipt' }));
  assert.equal(filterThread(t, ME), false);
});

test('list mail, bulk categories and social senders are dropped', () => {
  const list = thread('t2', message({ from: 'Weekly <editor@news.example>', to: ME, headers: { 'List-Id': '<weekly.news.example>' } }));
  assert.equal(filterThread(list, ME), false);

  const promo = thread('t3', message({ from: 'Shop <sales@shop.example>', to: ME, labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }));
  assert.equal(filterThread(promo, ME), false);

  const social = thread('t4', message({ from: 'LinkedIn <invitations@linkedin.com>', to: ME }));
  assert.equal(filterThread(social, ME), false);

  const vacation = thread('t5', message({ from: 'Sam <sam@example.com>', to: ME, headers: { 'Auto-Submitted': 'auto-replied' } }));
  assert.equal(filterThread(vacation, ME), false);
});

test('a person is kept, even when an earlier message was automated', () => {
  const t = thread(
    't6',
    message({ from: 'Acme <no-reply@acme.com>', to: ME, at: '2026-09-10T15:00:00Z' }),
    message({ from: 'Sarah Chen <sarah@acme.com>', to: ME, at: '2026-09-11T15:00:00Z' }),
  );
  assert.equal(filterThread(t, ME), true);
});

test('a thread Dallas wrote last, with him only cc\'d', () => {
  const t = thread(
    't7',
    message({
      from: 'Lauren <lauren@antoinettes.example>', to: 'dallas@example.com', cc: ME,
      subject: 'Party details', at: '2026-09-11T16:30:00Z',
    }),
    message({
      from: 'Dallas <dallas@example.com>', to: 'lauren@antoinettes.example', cc: ME,
      subject: 'Re: Party details', at: '2026-09-12T02:00:00Z',
      snippet: 'Confirmed the outdoor space, no tent needed',
    }),
  );
  const c = candidateFromThread(t, ME);
  assert.equal(c.title, 'Dallas — Party details');
  assert.equal(c.source, 'gmail');
  assert.equal(c.external_id, 't7');
  assert.equal(c.link, 'https://mail.google.com/mail/u/0/#inbox/t7');
  assert.equal(
    c.meta,
    "Gmail · Lauren ↔ Dallas, me cc'd · latest from Dallas Sep 11 · Confirmed the outdoor space, no tent needed",
    'dated in America/Chicago, where 02:00Z on the 12th is still the 11th',
  );
  assert.equal(c.occurs_at, '2026-09-12T02:00:00Z');
});

test('when he wrote last the meta says so, and he is named last', () => {
  const t = thread(
    't8',
    message({ from: 'Robert <robert@mcwc.example>', to: ME, subject: 'Founder coaching', at: '2026-09-09T14:00:00Z' }),
    message({ from: `Hunter <${ME}>`, to: 'robert@mcwc.example', subject: 'Re: Founder coaching', at: '2026-09-10T14:00:00Z' }),
  );
  const c = candidateFromThread(t, ME);
  assert.equal(c.meta, 'Gmail · Robert ↔ me · latest from me Sep 10');
  assert.equal(c.title, 'Hunter — Founder coaching');
});

test('a community thread is titled with the group, not the list address', () => {
  const groups = [{ name: 'AI Tinkerers — Nashville chapter', email: 'messages@mail.aitinkerers.org' }];
  const t = thread('t9', message({
    from: 'AI Tinkerers <messages@mail.aitinkerers.org>', to: ME,
    subject: 'Sept 29 meetup: Skills, Memory, and Second Brains',
    at: '2026-09-14T18:00:00Z',
    headers: { 'List-Id': '<aitinkerers>', 'List-Unsubscribe': '<https://unsub>' },
  }));
  // It would be dropped as list mail — the communities note is what lets it through.
  assert.equal(filterThread(t, ME), false);
  const group = groupForThread(t, groups);
  assert.equal(group, groups[0]);
  assert.equal(
    candidateFromThread(t, ME, group).title,
    'AI Tinkerers — Nashville chapter — Sept 29 meetup: Skills, Memory, and Second Brains',
  );
});

test('subjects lose their Re:/Fwd: chain, and a sender with no name uses the local-part', () => {
  assert.equal(cleanSubject('Re: Fwd: RE: headcount'), 'headcount');
  assert.equal(cleanSubject('Re[2]: headcount'), 'headcount');
  const t = thread('t10', message({ from: 'jake@musiccityworkclub.com', to: ME, subject: 'Re: N.A.S.H.' }));
  assert.equal(candidateFromThread(t, ME).title, 'jake — N.A.S.H.');
});

test('oldest waiting first, capped at 15', () => {
  const made = Array.from({ length: 20 }, (_, i) => ({
    external_id: `c${i}`,
    occurs_at: `2026-09-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
  }));
  const ordered = orderAndCap([...made].reverse());
  assert.equal(ordered.length, 15);
  assert.equal(ordered[0].external_id, 'c0');
  assert.equal(ordered.at(-1).external_id, 'c14');
});

test('the community query names each sender, and is empty without any', () => {
  assert.equal(communityQuery([]), '');
  assert.equal(
    communityQuery(['list@garden.example', 'books.example.org']),
    'from:(list@garden.example OR books.example.org) newer_than:14d',
  );
});

function fakeVault(senders = [], groups = []) {
  return { communitySenders: () => senders, communityGroups: () => groups };
}

function fakeGoogle({ inbox = [], community = [], threads = {} }) {
  const calls = [];
  return {
    calls,
    async gapi(url, params = {}) {
      calls.push({ url, params });
      if (url.endsWith('/profile')) return { emailAddress: 'Hunter@Example.com' };
      const id = url.match(/threads\/([^/]+)$/)[1];
      return threads[id];
    },
    async gapiPages(url, params = {}, options = {}) {
      calls.push({ url, params, options });
      return params.q.startsWith('in:inbox') ? inbox : community;
    },
  };
}

test('scan reads community threads first and keeps them past the bulk filter', async () => {
  const groups = [{ name: 'Garden club', email: 'list@garden.example' }];
  const threads = {
    c1: thread('c1', message({
      from: 'Garden <list@garden.example>', to: ME, subject: 'Plant swap', at: '2026-09-12T15:00:00Z',
      headers: { 'List-Id': '<garden>' },
    })),
    i1: thread('i1', message({ from: 'Sam <sam@example.com>', to: ME, subject: 'lunch', at: '2026-09-10T15:00:00Z' })),
    i2: thread('i2', message({ from: 'Acme <no-reply@acme.com>', to: ME, subject: 'receipt' })),
  };
  const google = fakeGoogle({ inbox: [{ id: 'i1' }, { id: 'c1' }, { id: 'i2' }], community: [{ id: 'c1' }], threads });
  const candidates = await scan({
    google, vault: fakeVault(['list@garden.example'], groups), now: Date.now, limits: LIMITS,
  });
  assert.deepEqual(candidates.map((c) => c.external_id), ['i1', 'c1']);
  assert.equal(candidates[1].title, 'Garden club — Plant swap');
  const gets = google.calls.filter((c) => /threads\/[^/]+$/.test(c.url)).map((c) => c.url.split('/').at(-1));
  assert.deepEqual(gets, ['c1', 'i1', 'i2']);
  const queries = google.calls.filter((c) => c.params.q).map((c) => c.params.q);
  assert.match(queries[0], /^in:inbox newer_than:14d -list:\* /);
  assert.equal(queries[1], 'from:(list@garden.example) newer_than:14d');
});

test('scan skips the community query without senders and gets at most 40 threads', async () => {
  const inbox = Array.from({ length: 45 }, (_, i) => ({ id: `t${i}` }));
  const threads = Object.fromEntries(inbox.map(({ id }, i) => [id, thread(id, message({
    from: `Person ${i} <p${i}@example.com>`, to: ME, at: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`,
  }))]));
  const google = fakeGoogle({ inbox, threads });
  const candidates = await scan({ google, vault: fakeVault(), now: Date.now, limits: LIMITS });
  assert.equal(google.calls.filter((c) => c.params.q).length, 1, 'no community query');
  assert.equal(google.calls.filter((c) => /threads\/[^/]+$/.test(c.url)).length, 40);
  assert.equal(candidates.length, 15);
});
