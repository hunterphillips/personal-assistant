// Focus Gmail scan: two Gmail queries (the bounded inbox one, and the
// communities one built from Hunter's own note), then a mechanical filter and
// a fixed sentence per thread. scan({ google, vault, now, limits, signal })
// resolves at most 15 validated candidates, oldest latest-message first, or
// throws. It never writes anything and never makes the keep or drop judgment:
// that is the rulebook's, the curator's. What lives here is machinery only:
// drop the robots, describe the rest accurately, in the same words every run.

import { checkedCandidates } from '../candidates.mjs';
import { communityQuery } from './community-query.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Bulk mail is excluded so a 14-day window fits in one page. Widening it back
// to the whole inbox makes the long tail unreachable, not more complete.
const INBOX_QUERY = 'in:inbox newer_than:14d -list:* -category:promotions -category:updates -category:social -category:forums';
const PAGE_SIZE = 50;
const MAX_PAGES = 3;
const MAX_GETS = 40; // threads.get calls per run
const MAX_CANDIDATES = 15;

const METADATA_HEADERS = [
  'From', 'To', 'Cc', 'Subject', 'Date',
  'List-Id', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted',
];

// An address that no person reads. Matched against the address, not the name.
const AUTOMATED_RE = /no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|calendar-notification|alerts?@|info@|news@|hello@|team@|support@/i;
const BULK_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);
// Senders whose mail is always machinery: social networks, and Google's own
// calendar-invitation and document-share notifications.
const DROP_DOMAINS = ['linkedin.com', 'facebookmail.com', 'calendar-server.bounces.google.com', 'docs.google.com'];

const MAX_SNIPPET = 80;
const MAX_PARTIES = 3;

const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });

// ---- header plumbing ------------------------------------------------------

export function headerMap(message) {
  const out = {};
  for (const h of message?.payload?.headers ?? []) {
    const key = String(h.name || '').toLowerCase();
    if (!(key in out)) out[key] = String(h.value ?? '');
  }
  return out;
}

// Split an address list on commas that are not inside quotes or angle
// brackets: `"Phillips, Hunter" <h@x.com>, a@b.com` is two addresses, not three.
function splitAddresses(value) {
  const parts = [];
  let cur = '';
  let quoted = false;
  let angled = false;
  for (const ch of String(value ?? '')) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<') angled = true;
    else if (ch === '>') angled = false;
    else if (ch === ',' && !quoted && !angled) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseAddress(one) {
  const m = String(one).match(/^(.*?)<([^>]*)>\s*$/);
  let name = m ? m[1].trim() : '';
  const email = (m ? m[2] : String(one)).trim().toLowerCase();
  name = name.replace(/^"(.*)"$/s, '$1').trim();
  if (name.includes('=?')) name = ''; // RFC 2047 encoded word: don't guess, use the local-part
  return { name, email };
}

export function addresses(value) {
  return splitAddresses(value).map(parseAddress).filter((a) => a.email);
}

function firstAddress(value) {
  return addresses(value)[0] ?? { name: '', email: '' };
}

function domainOf(email) {
  const at = String(email).lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1);
}

// How a participant is named in `meta`: himself is "me", everyone else is the
// display name they send under, or their local-part when they send without one.
function labelOf(addr, me) {
  if (addr.email && addr.email === me) return 'me';
  if (addr.name) return addr.name;
  return addr.email.split('@')[0] || addr.email;
}

// Gmail returns thread messages oldest-first, but sort rather than trust it:
// the latest message is the fact every field below is built from.
function sortedMessages(thread) {
  return [...(thread?.messages ?? [])].sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
}

// ---- filtering ------------------------------------------------------------

// Mechanical drop rules for inbox threads. Community threads bypass this
// entirely — being list mail is the point of that query.
export function filterThread(thread, me) {
  const messages = sortedMessages(thread);
  if (!messages.length) return false;
  const latest = messages[messages.length - 1];
  const h = headerMap(latest);

  if ((latest.labelIds ?? []).some((l) => BULK_LABELS.has(l))) return false;
  if (h['list-id'] || h['list-unsubscribe']) return false;
  if (/^\s*(bulk|list|junk)/i.test(h.precedence ?? '')) return false;
  const auto = (h['auto-submitted'] ?? '').trim().toLowerCase();
  if (auto && auto !== 'no') return false;

  const domain = domainOf(firstAddress(h.from).email);
  if (domain && DROP_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return false;

  // No message on the thread from a personal-looking address means nobody is
  // on the other end. His own address always counts as a person.
  return messages.some((m) => {
    const from = firstAddress(headerMap(m).from);
    return from.email === me || !AUTOMATED_RE.test(from.email);
  });
}

// The group a community thread belongs to, so its title can lead with the
// group's name instead of whatever the list puts in From.
export function groupForThread(thread, groups) {
  for (const m of sortedMessages(thread)) {
    const from = firstAddress(headerMap(m).from);
    const domain = domainOf(from.email);
    for (const g of groups) {
      const sender = String(g.email).toLowerCase();
      if (from.email === sender) return g;
      if (!sender.includes('@') && (domain === sender || domain.endsWith(`.${sender}`))) return g;
    }
  }
  return null;
}

// ---- formatting -----------------------------------------------------------

function truncate(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export function cleanSubject(subject) {
  return String(subject ?? '').replace(/^\s*(?:(?:re|fwd?|aw|antw)\s*(?:\[\d+\])?\s*:\s*)+/i, '').trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
function decodeSnippet(text) {
  return String(text ?? '').replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ENTITIES[e] ?? _);
}

export function formatDay(ms) {
  return dayFormat.format(new Date(ms));
}

// One candidate from one thread. `group` is set for community threads only.
export function candidateFromThread(thread, me, group = null) {
  const messages = sortedMessages(thread);
  const latest = messages[messages.length - 1];
  const h = headerMap(latest);
  const from = firstAddress(h.from);

  const subject = cleanSubject(h.subject) || cleanSubject(headerMap(messages[0]).subject) || '(no subject)';
  const senderName = from.name || from.email.split('@')[0] || 'someone';
  const title = truncate(`${group?.name || senderName} — ${subject}`, 200);

  // Everyone who wrote or was written to, in the order they first appear;
  // himself last, so a two-party thread reads "Robert ↔ me". A display name
  // from any message wins over a bare address on an earlier one — the same
  // person is named the same way every run.
  const parties = new Map();
  for (const m of messages) {
    const mh = headerMap(m);
    for (const addr of [...addresses(mh.from), ...addresses(mh.to)]) {
      const known = parties.get(addr.email);
      if (!known) parties.set(addr.email, addr);
      else if (!known.name && addr.name) known.name = addr.name;
    }
  }
  const meCcOnly = !parties.has(me) && addresses(h.cc).some((a) => a.email === me);
  const labels = [...parties.values()].filter((a) => a.email !== me).map((a) => labelOf(a, me));
  if (parties.has(me)) labels.push('me');

  const between = labels.slice(0, MAX_PARTIES).join(' ↔ ') || 'unknown sender';
  const latestMs = Number(latest.internalDate || 0);
  const bits = [
    `Gmail · ${between}${meCcOnly ? ", me cc'd" : ''}`,
    `latest from ${labelOf(from, me)} ${formatDay(latestMs)}`,
  ];
  const snippet = truncate(decodeSnippet(latest.snippet), MAX_SNIPPET);
  if (snippet) bits.push(snippet);

  return {
    title,
    source: 'gmail',
    external_id: thread.id,
    link: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
    meta: bits.join(' · '),
    occurs_at: new Date(latestMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

// Oldest latest-message first: the thread that has been waiting longest leads,
// and the cap sheds the freshest rather than the stalest.
export function orderAndCap(candidates) {
  return [...candidates]
    .sort((a, b) => (a.occurs_at < b.occurs_at ? -1 : a.occurs_at > b.occurs_at ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
}

// ---- the scan -------------------------------------------------------------

export async function scan({ google, vault, now: _now, limits, signal } = {}) {
  const profile = await google.gapi(`${API}/profile`, {}, { signal });
  const me = String(profile.emailAddress ?? '').toLowerCase();

  const inbox = await google.gapiPages(
    `${API}/threads`,
    { q: INBOX_QUERY, maxResults: PAGE_SIZE },
    { maxPages: MAX_PAGES, signal },
  );
  const query = communityQuery(vault.communitySenders());
  const community = query
    ? await google.gapiPages(`${API}/threads`, { q: query, maxResults: PAGE_SIZE }, { maxPages: 1, signal })
    : [];

  const groups = vault.communityGroups();
  const communityIds = new Set(community.map((t) => t.id));
  // Community threads first (they are always kept), then the inbox in
  // Gmail's own newest-first order, so the cap sheds the stalest threads.
  const ids = [...communityIds, ...inbox.map((t) => t.id).filter((id) => !communityIds.has(id))].slice(0, MAX_GETS);

  const candidates = [];
  for (const id of ids) {
    const thread = await google.gapi(
      `${API}/threads/${id}`,
      { format: 'metadata', metadataHeaders: METADATA_HEADERS },
      { signal },
    );
    const isCommunity = communityIds.has(id);
    const group = isCommunity ? groupForThread(thread, groups) : null;
    if (!isCommunity && !filterThread(thread, me)) continue;
    candidates.push(candidateFromThread(thread, me, group));
  }

  return checkedCandidates(orderAndCap(candidates), limits);
}
