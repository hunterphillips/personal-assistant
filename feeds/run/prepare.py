#!/usr/bin/env python3
"""What run-feeds needs from the data root, one subcommand per question.
Reads only; the prompts it builds go to the paths it is given, under the
run's work directory. Standard library only.

    prepare.py feeds    --data D                      active feed ids, one a line
    prepare.py describe --data D --feed F             the feed's sources by kind, for the dry run
    prepare.py since    --data D --feed F --date d    the feed's last run, or 14 days back
    prepare.py sources  --data D --feed F --kind K    "<id>\\t<url|sender|path>" per active source
    prepare.py query    --data D --feed F --since S   the Gmail query for its email sources, or nothing
    prepare.py extract  --data D --feed F --template T --out P (--thread JSON | --entry FILE --source ID)
                                                      writes an extract prompt; prints the source id
    prepare.py triage   --data D --feed F --date d --since S --template T --rules R
                        --stories FILE --out P --notes N
                                                      writes the triage prompt; context notes to N

The shapes are in feeds/README.md. A feed or source whose file does not
parse, or whose id is not a slug, is skipped with a line on stderr.
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import sys

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
KINDS = ("rss", "email", "file", "folder")
SOURCE_CAP = 64 * 1024
TOTAL_CAP = 256 * 1024
SEEN_DAYS = 14
FIELD = {"rss": "url", "email": "sender", "file": "path", "folder": "path"}


def warn(msg):
    print(f"prepare.py: {msg}", file=sys.stderr)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        warn(f"{path}: {e}")
        return None


def load_sources(data):
    out = {}
    for path in sorted(glob.glob(os.path.join(data, "sources", "*.json"))):
        s = read_json(path)
        if not isinstance(s, dict) or not SLUG.match(str(s.get("id", ""))) or s.get("kind") not in KINDS:
            warn(f"{path}: not a source, skipped")
            continue
        out[s["id"]] = s
    return out


def feed_ids(data):
    ids = []
    for path in sorted(glob.glob(os.path.join(data, "feeds", "*", "feed.json"))):
        f = read_json(path)
        fid = os.path.basename(os.path.dirname(path))
        if not isinstance(f, dict) or f.get("id") != fid or not SLUG.match(fid):
            warn(f"{path}: not a feed, skipped")
            continue
        if f.get("active"):
            ids.append(fid)
    return ids


def load_feed(data, fid):
    """The feed, with `_sources`: its active sources in its own order."""
    if not SLUG.match(fid):
        raise SystemExit(f"prepare.py: not a feed id: {fid}")
    feed = read_json(os.path.join(data, "feeds", fid, "feed.json"))
    if not isinstance(feed, dict):
        raise SystemExit(f"prepare.py: no feed {fid}")
    known = load_sources(data)
    feed["_sources"] = [known[s] for s in feed.get("sources", []) if s in known and known[s].get("active")]
    return feed


def by_kind(feed, *kinds):
    return [s for s in feed["_sources"] if s["kind"] in kinds]


def address(sender):
    m = re.search(r"<([^>]+)>", sender or "")
    return (m.group(1) if m else sender or "").strip().lower()


def source_for_sender(feed, sender):
    a = address(sender)
    return next((s for s in by_kind(feed, "email") if address(s.get("sender")) == a), None)


def days_before(date, n):
    return (dt.date.fromisoformat(date) - dt.timedelta(days=n)).isoformat()


def since(data, fid, date):
    path = os.path.join(data, "feeds", ".run", "state.json")
    state = (read_json(path) if os.path.exists(path) else None) or {}
    last = ((state.get("feeds") or {}).get(fid) or {}).get("last_run")
    return last or days_before(date, SEEN_DAYS)


def query(feed, since_date):
    senders = [address(s.get("sender")) for s in by_kind(feed, "email") if address(s.get("sender"))]
    if not senders:
        return ""
    return "(" + " OR ".join(f"from:{s}" for s in senders) + ") after:" + since_date.replace("-", "/")


def cut(text, limit):
    b = text.encode("utf-8")
    return text if len(b) <= limit else b[:limit].decode("utf-8", "ignore")


def context(data, feed):
    """The feed's file and folder sources as text, each file under its path
    as a heading, and the notes on what was cut or missing."""
    parts, notes = [], []
    for s in by_kind(feed, "file", "folder"):
        path = s.get("path", "")
        if s["kind"] == "file":
            files = [path] if os.path.isfile(path) else None
        else:
            files = sorted(p for p in glob.glob(os.path.join(path, "*.md")) if os.path.isfile(p)) if os.path.isdir(path) else None
        if files is None:
            notes.append(f"Context {s['id']} was not found at {path}.")
            continue
        pieces = []
        for p in files:
            with open(p, encoding="utf-8", errors="replace") as f:
                pieces.append(f"### {p}\n\n{f.read().strip()}\n")
        text = "\n".join(pieces)
        if not text:
            continue
        if len(text.encode("utf-8")) > SOURCE_CAP:
            text = cut(text, SOURCE_CAP)
            notes.append(f"Context {s['id']} was cut at {SOURCE_CAP // 1024} KB.")
        room = TOTAL_CAP - len("\n".join(parts).encode("utf-8")) - (1 if parts else 0)
        if len(text.encode("utf-8")) > room:
            text = cut(text, max(room, 0))
            notes.append(f"Context {s['id']} was cut: the context reached {TOTAL_CAP // 1024} KB.")
        if text:
            parts.append(text)
    return "\n".join(parts), notes


def seen(data, fid, date):
    """The feed's own seen list for the last fourteen days, as prompt lines."""
    path = os.path.join(data, "feeds", ".run", "seen.jsonl")
    cutoff, lines = days_before(date, SEEN_DAYS), []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    s = json.loads(line)
                except ValueError:
                    continue
                if s.get("feed") == fid and str(s.get("date", "")) >= cutoff:
                    lines.append(f"- [{', '.join(s.get('sources') or [])}] {s.get('title', '')} <{s.get('url', '')}>")
    return "\n".join(lines)


def fill(template, values):
    """Each {{KEY}} replaced once, so filled-in text is never filled again."""
    return re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: values.get(m.group(1), m.group(0)), template)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def describe(feed):
    lines = []
    for kind, label, none in (("rss", "rss", "none"), ("email", "email", "none, no Gmail call"), (("file", "folder"), "context", "none")):
        ss = by_kind(feed, *(kind if isinstance(kind, tuple) else (kind,)))
        lines.append(f"    {label}: " + (", ".join(f"{s['id']} {s.get(FIELD[s['kind']], '')}" for s in ss) or none))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=("feeds", "describe", "since", "sources", "query", "extract", "triage"))
    ap.add_argument("--data", required=True)
    for name in ("feed", "date", "since", "kind", "template", "rules", "stories", "out", "notes", "thread", "entry", "source"):
        ap.add_argument(f"--{name}")
    a = ap.parse_args()

    if a.command == "feeds":
        print("\n".join(feed_ids(a.data)))
        return 0
    if a.command == "since":
        print(since(a.data, a.feed, a.date))
        return 0
    feed = load_feed(a.data, a.feed)
    if a.command == "describe":
        print(describe(feed))
    elif a.command == "sources":
        for s in by_kind(feed, a.kind):
            print(f"{s['id']}\t{s.get(FIELD[s['kind']], '')}")
    elif a.command == "query":
        print(query(feed, a.since))
    elif a.command == "extract":
        if a.thread:
            t = json.loads(a.thread)
            s = source_for_sender(feed, t.get("sender", ""))
            sid, name = (s["id"], s["name"]) if s else (address(t.get("sender", "")), t.get("sender", ""))
            issue = (f"Call `get_thread` on thread `{t.get('id', '')}` (subject: {t.get('subject', '')}, "
                     f"from {t.get('sender', '')}) and read the issue it holds.")
        else:
            s = next(x for x in by_kind(feed, "rss") if x["id"] == a.source)
            sid, name = s["id"], s["name"]
            e = json.loads(read(a.entry))
            issue = ("The entry is below, as the feed published it, with its HTML stripped.\n\n"
                     f"Title: {e.get('title', '')}\nLink: {e.get('link', '')}\nDate: {e.get('date', '')}\n\n"
                     f"{e.get('content', '') or '(no content; the entry is its title and link)'}")
        write(a.out, fill(read(a.template), {"ISSUE": issue, "SOURCE": name}))
        print(sid)
    elif a.command == "triage":
        text, notes = context(a.data, feed)
        note_path = os.path.join(a.data, "feeds", a.feed, "note.md")
        sources = "\n".join(f"- `{s['id']}`: {s['name']} ({s['kind']})" for s in by_kind(feed, "rss", "email"))
        write(a.out, fill(read(a.template), {
            "FEED": feed.get("name", a.feed), "SINCE": a.since, "RULES": read(a.rules).strip(),
            "NOTE": read(note_path).strip(), "CONTEXT": text or "(none)", "SOURCES": sources or "(none)",
            "SEEN": seen(a.data, a.feed, a.date) or "(nothing)", "STORIES": read(a.stories).strip() or "(none)",
        }))
        write(a.notes, " ".join(notes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
