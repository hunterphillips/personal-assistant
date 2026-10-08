#!/usr/bin/env python3
"""Fetch one RSS or Atom feed and keep the entries published since a date.

    fetch_rss.py --since YYYY-MM-DD --out DIR URL

Writes DIR/entry-<n>.json for each kept entry, newest first: {title, link,
date, content}, with links made absolute and the content's HTML stripped
(each link's URL kept after its text) and cut at 80 KB. Prints {"entries": n, "newest": <date or null>} on
stdout, where newest is the newest entry date in the feed, kept or not, so
the run's log shows a stale feed. An entry with no date is skipped: there
is no telling whether it is new. Exits 1 when the feed cannot be fetched
or parsed. Standard library only.
"""

import argparse
import datetime as dt
import email.utils
import html.parser
import json
import os
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

TIMEOUT = 20
MAX_BYTES = 8 * 1024 * 1024
MAX_CONTENT = 80 * 1024
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

ATOM = "{http://www.w3.org/2005/Atom}"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}encoded"
XML_BASE = "{http://www.w3.org/XML/1998/namespace}base"
BLOCKS = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "blockquote", "pre", "section", "article"}


class Text(html.parser.HTMLParser):
    """An HTML fragment's text, with block elements on their own lines and
    each link's absolute URL after its text, so a digest keeps the link of
    every story it carries."""

    def __init__(self, base=""):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.parts = []
        self.skip = 0
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in BLOCKS:
            self.parts.append("\n")
        elif tag == "a":
            href = urllib.parse.urljoin(self.base, (dict(attrs).get("href") or "").strip())
            self.links.append(href if href.lower().startswith(("http://", "https://")) else "")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag in BLOCKS:
            self.parts.append("\n")
        elif tag == "a" and self.links:
            href = self.links.pop()
            if href and not self.skip:
                self.parts.append(f" ({href})")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)

    def text(self):
        lines = (" ".join(line.split()) for line in "".join(self.parts).splitlines())
        out, blank = [], False
        for line in lines:
            if line:
                out.append(line)
                blank = False
            elif out and not blank:
                out.append("")
                blank = True
        return "\n".join(out).strip()


def strip_html(s, base=""):
    p = Text(base)
    p.feed(s or "")
    p.close()
    return p.text()


def cap(s, limit=MAX_CONTENT):
    b = s.encode("utf-8")
    return s if len(b) <= limit else b[:limit].decode("utf-8", "ignore")


def parse_date(s):
    """An RFC 822 or ISO 8601 date as an aware datetime, or None."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError):
        try:
            d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def text_of(el):
    return "".join(el.itertext()) if el is not None else ""


def rss_entries(channel, base):
    for item in channel.findall("item"):
        link = (item.findtext("link") or "").strip() or (item.findtext("guid") or "").strip()
        body = item.findtext(CONTENT) or item.findtext("description") or ""
        yield item.findtext("title") or "", urllib.parse.urljoin(base, link), parse_date(item.findtext("pubDate")), body


def atom_link(entry, base):
    links = entry.findall(ATOM + "link")
    chosen = next((l for l in links if l.get("rel", "alternate") == "alternate"), links[0] if links else None)
    return urllib.parse.urljoin(base, chosen.get("href", "")) if chosen is not None else ""


def atom_entries(feed, base):
    base = urllib.parse.urljoin(base, feed.get(XML_BASE, ""))
    for entry in feed.findall(ATOM + "entry"):
        ebase = urllib.parse.urljoin(base, entry.get(XML_BASE, ""))
        date = parse_date(entry.findtext(ATOM + "published")) or parse_date(entry.findtext(ATOM + "updated"))
        content = entry.find(ATOM + "content")
        if content is None:
            content = entry.find(ATOM + "summary")
        yield text_of(entry.find(ATOM + "title")), atom_link(entry, ebase), date, text_of(content)


def parse(data, url, since):
    """The entries dated on or after `since` (each in its own offset), newest
    first, and the newest date in the feed as ISO 8601 or None."""
    root = ET.fromstring(data)
    if root.tag == "rss" and root.find("channel") is not None:
        channel = root.find("channel")
        base = urllib.parse.urljoin(url, (channel.findtext("link") or "").strip())
        raw = rss_entries(channel, base)
    elif root.tag == ATOM + "feed":
        raw = atom_entries(root, url)
    else:
        raise ValueError(f"not an RSS or Atom feed: <{root.tag}>")
    cutoff = dt.date.fromisoformat(since)
    kept, newest = [], None
    for title, link, date, body in raw:
        if date is None:
            continue
        if newest is None or date > newest:
            newest = date
        if date.date() < cutoff:
            continue
        kept.append((date, {"title": strip_html(title), "link": link, "date": date.isoformat(),
                            "content": cap(strip_html(body, link))}))
    kept.sort(key=lambda p: p[0], reverse=True)
    return [e for _, e in kept], newest.isoformat() if newest else None


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read(MAX_BYTES)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("url")
    a = ap.parse_args()
    try:
        entries, newest = parse(fetch(a.url), a.url, a.since)
    except Exception as e:  # a network error, a bad status, or a feed that does not parse
        print(f"fetch_rss: {a.url}: {e}", file=sys.stderr)
        return 1
    os.makedirs(a.out, exist_ok=True)
    for i, e in enumerate(entries, 1):
        with open(os.path.join(a.out, f"entry-{i}.json"), "w", encoding="utf-8") as f:
            json.dump(e, f, ensure_ascii=False, indent=1)
    print(json.dumps({"entries": len(entries), "newest": newest}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
