// Feed discovery for Add source: given a site or a feed's address, the RSS or
// Atom feed to read, as feed/bin/enrich fetches a page (6 s, 512 KB, http and
// https only).
//
// discoverFeed(url, { timeoutMs, maxBytes, fetch }) -> Promise<string | null>
//   Never rejects. The address itself (after redirects) when it answers a
//   feed: an RSS, Atom, or XML content type, or a body that opens with
//   <rss, <feed, or <rdf:RDF. Otherwise the first <link rel="alternate">
//   whose type is application/rss+xml or application/atom+xml, its href
//   resolved against the page, when that is http or https. Otherwise, and on
//   any failure (no answer in time, an error status, a body past the cap
//   read only up to it), null.
// isWebAddress(text) -> boolean   an absolute http or https URL

export const DISCOVER_TIMEOUT_MS = 6000;
export const DISCOVER_MAX_BYTES = 512 * 1024;
const FEED_TYPES = /^application\/(rss|atom)\+xml$/i;
const FEED_CONTENT = /(rss|atom)\+xml|\/xml\b|text\/xml/i;
const FEED_BODY = /^(\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->)*<(rss|feed|rdf:RDF)\b/;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

export function isWebAddress(text) {
  if (typeof text !== 'string') return false;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function discoverFeed(url, {
  timeoutMs = DISCOVER_TIMEOUT_MS, maxBytes = DISCOVER_MAX_BYTES, fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (!isWebAddress(url)) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal, redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml,application/atom+xml,text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    if (!response.ok || !isWebAddress(response.url || url)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const at = response.url || url;
    const text = await readCapped(response, maxBytes);
    const kind = response.headers.get('content-type') ?? '';
    if (FEED_CONTENT.test(kind) || FEED_BODY.test(text.replace(/^﻿/, ''))) return at;
    return alternateFeed(text, at);
  } catch {
    return null;
  }
}

// The body as text, read to at most maxBytes; the rest is not read.
async function readCapped(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

// The first feed a page's <link rel="alternate"> tags name, or null.
function alternateFeed(html, base) {
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('alternate') || !FEED_TYPES.test((attrs.type ?? '').trim()) || !attrs.href) continue;
    let href;
    try { href = new URL(decodeEntities(attrs.href.trim()), base).href; } catch { continue; }
    if (isWebAddress(href)) return href;
  }
  return null;
}

function attributes(tag) {
  const found = {};
  for (const match of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    found[match[1].toLowerCase()] = match[3] ?? match[4] ?? match[5] ?? '';
  }
  return found;
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, '&').replace(/&#38;/g, '&');
}
