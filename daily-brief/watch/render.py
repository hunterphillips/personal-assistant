#!/usr/bin/env python3
"""Turn a triage envelope into the watch packet, the overflow file, the
feed file the dashboard reads, the seen-store lines, and the state update.
Standard library only.

    render.py --date D --since S --envelope triage.json --threads N
              [--out DIR] [--feed DIR]

--out is Watch's state directory (packets/, overflow/, seen.jsonl,
state.json), the data root's watch/ when contribute runs it; --feed is the
feed store's items directory, the data root's feed/items/. Without them
the script writes beside itself and to ../../feed/items, for a run by hand.

The feed file, <feed>/<date>-watch.json, holds every item the run judged
worth keeping, survivors first: see feed/README.md at the repo root for
the shape. The feed store is append-only and its ids are
positional, so a file that already exists for the date is left as it is.
"""
import argparse, datetime as dt, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FEED_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "feed", "items"))


def q(s):
    return json.dumps(str(s), ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--since", required=True)
    ap.add_argument("--envelope", required=True)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--status", default="ok")
    ap.add_argument("--note", default="")
    ap.add_argument("--out", default=HERE)
    ap.add_argument("--feed", default=FEED_DIR)
    a = ap.parse_args()

    with open(a.envelope, encoding="utf-8") as f:
        env = json.load(f)
    if env.get("is_error"):
        print(f"render.py: triage returned an error envelope: {env.get('result','')[:300]}", file=sys.stderr)
        return 1
    out = env.get("structured_output") or {}
    items = out.get("items", [])
    overflow = out.get("overflow", [])
    considered = out.get("considered", 0)
    dupes = out.get("duplicates_collapsed", 0)

    now = dt.datetime.now().astimezone().replace(microsecond=0).isoformat()
    note = a.note or (
        f"{a.threads} issues since {a.since}; {considered} distinct stories judged, "
        f"{dupes} duplicates collapsed; {len(items)} survived, {len(overflow)} kept for the feed."
    )

    lines = [
        "domain: watch",
        f"generated_at: {now}",
        f"data_as_of: {now}",
        f"since: {a.since}",
        f"status: {a.status}",
        f"notes: {q(note)}",
    ]
    if items:
        lines.append("items:")
        for i, it in enumerate(items, 1):
            lines += [
                f"  - id: watch/{a.date}/{i}",
                "    kind: context",
                f"    headline: {q(it['headline'])}",
                f"    why: {q(it['why'])}",
                f"    as_of: {now}",
                "    origin: external",
                "    basis: summarized",
                f"    about: watch/{a.date}",
                "    receipt:",
                f"      - {q(it['source'] + ': ' + it['url'])}",
            ]
    else:
        lines.append("items: []")
    lines.append("")

    packets = os.path.join(a.out, "packets")
    os.makedirs(packets, exist_ok=True)
    packet = os.path.join(packets, f"{a.date}.yaml")
    tmp = packet + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.chmod(tmp, 0o600)
    os.replace(tmp, packet)

    ov_dir = os.path.join(a.out, "overflow")
    os.makedirs(ov_dir, exist_ok=True)
    with open(os.path.join(ov_dir, f"{a.date}.json"), "w", encoding="utf-8") as f:
        json.dump({"date": a.date, "since": a.since, "overflow": overflow}, f, ensure_ascii=False, indent=1)

    feed_path, feed_written = write_feed(a.feed, a.date, a.since, now, items, overflow)

    with open(os.path.join(a.out, "seen.jsonl"), "a", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps({"date": a.date, "verdict": "kept", "source": it["source"], "title": it["title"], "url": it["url"]}, ensure_ascii=False) + "\n")
        for it in overflow:
            f.write(json.dumps({"date": a.date, "verdict": "overflow", "source": it["source"], "title": it["title"], "url": it["url"]}, ensure_ascii=False) + "\n")

    state_path = os.path.join(a.out, "state.json")
    state = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    state["last_run"] = a.date
    state.setdefault("reported", [])
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)

    feed_note = f"{feed_path}" if feed_written else f"{feed_path} (already there, kept)"
    print(f"watch {a.date}: {len(items)} items, {len(overflow)} overflow, {considered} considered -> {packet}, {feed_note}")
    return 0


def write_feed(feed_dir, date, since, now, items, overflow):
    """Write the feed file for the run unless one exists. Returns (path, written)."""
    os.makedirs(feed_dir, exist_ok=True)
    feed_path = os.path.join(feed_dir, f"{date}-watch.json")
    if os.path.exists(feed_path):
        return feed_path, False
    entries = []
    n = 0
    for it in items:
        n += 1
        entries.append({
            "id": f"watch/{date}/{n}", "title": it["title"], "source": it["source"], "url": it["url"],
            "test": it.get("test"), "summary": it["headline"], "kept": True,
        })
    for it in overflow:
        n += 1
        entries.append({
            "id": f"watch/{date}/{n}", "title": it["title"], "source": it["source"], "url": it["url"],
            "test": it.get("test"), "summary": it["summary"], "kept": False,
        })
    doc = {"producer": "watch", "date": date, "since": since, "generated_at": now, "items": entries}
    tmp = feed_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, feed_path)
    return feed_path, True


if __name__ == "__main__":
    sys.exit(main())
