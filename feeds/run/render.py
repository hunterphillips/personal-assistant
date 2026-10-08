#!/usr/bin/env python3
"""Write what a feeds run produced. Standard library only.

    render.py feed   --data D --feed F --date d --since S --envelope triage.json
                     --read id,id [--status ok|degraded] [--note TEXT]
    render.py packet --data D --date d [--failed id,id]

`feed` turns one feed's triage envelope into its items file,
feeds/<F>/items/<d>.json, every post the run judged worth keeping,
survivors first (shape in feeds/README.md), and, under the run's
directory feeds/.run/: overflow/<d>-<F>.json, the feed's lines in
seen.jsonl, its last_run in state.json, and work/<d>/<F>.json, the kept
posts the packet reads. The items store is append-only and its ids are
positional, so an items file that already exists is left as it is.

`packet` runs once after every feed: it reads the day's work files and
writes one packets/<d>.yaml, domain `watch`, holding every feed's kept
posts, for the next Daily Brief run. A day with no work file writes no
packet.
"""
import argparse, datetime as dt, glob, json, os, sys


def q(s):
    return json.dumps(str(s), ensure_ascii=False)


def write_json(path, doc, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    if mode:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def source_names(data):
    names = {}
    for path in glob.glob(os.path.join(data, "sources", "*.json")):
        try:
            s = read_json(path)
            names[s["id"]] = s.get("name") or s["id"]
        except (ValueError, KeyError, TypeError):
            continue
    return names


def render_feed(a):
    env = read_json(a.envelope)
    if env.get("is_error"):
        print(f"render.py: triage returned an error envelope: {env.get('result', '')[:300]}", file=sys.stderr)
        return 1
    out = env.get("structured_output") or {}
    items, overflow = out.get("items", []), out.get("overflow", [])
    considered, dupes = out.get("considered", 0), out.get("duplicates_collapsed", 0)
    feed = read_json(os.path.join(a.data, "feeds", a.feed, "feed.json"))
    run = os.path.join(a.data, "feeds", ".run")
    now = dt.datetime.now().astimezone().replace(microsecond=0).isoformat()
    read = [s for s in a.read.split(",") if s]
    note = (a.note + " " if a.note else "") + (
        f"{considered} distinct stories since {a.since} judged, {dupes} duplicates collapsed; "
        f"{len(items)} survived, {len(overflow)} kept for the feed.")

    items_path = os.path.join(a.data, "feeds", a.feed, "items", f"{a.date}.json")
    written = not os.path.exists(items_path)
    if written:
        posts = []
        for it in items + overflow:
            n = len(posts) + 1
            post = {"id": f"{a.feed}/{a.date}/{n}", "title": it["title"], "url": it["url"], "sources": it["sources"],
                    "summary": it["headline"] if n <= len(items) else it["summary"]}
            for key in ("takeaway", "insights"):
                if it.get(key):
                    post[key] = it[key]
            post["kept"] = n <= len(items)
            posts.append(post)
        write_json(items_path, {"feed": a.feed, "producer": feed.get("producer", "scout"), "date": a.date,
                                "since": a.since, "generated_at": now, "read": read, "items": posts}, 0o600)

    write_json(os.path.join(run, "overflow", f"{a.date}-{a.feed}.json"),
               {"feed": a.feed, "date": a.date, "since": a.since, "overflow": overflow})
    with open(os.path.join(run, "seen.jsonl"), "a", encoding="utf-8") as f:
        for verdict, group in (("kept", items), ("overflow", overflow)):
            for it in group:
                f.write(json.dumps({"feed": a.feed, "date": a.date, "verdict": verdict, "sources": it["sources"],
                                    "title": it["title"], "url": it["url"]}, ensure_ascii=False) + "\n")
    state_path = os.path.join(run, "state.json")
    state = read_json(state_path, {})
    state.setdefault("feeds", {}).setdefault(a.feed, {})["last_run"] = a.date
    state.setdefault("reported", [])
    write_json(state_path, state)
    write_json(os.path.join(run, "work", a.date, f"{a.feed}.json"),
               {"feed": a.feed, "name": feed.get("name", a.feed), "date": a.date, "since": a.since,
                "generated_at": now, "status": a.status, "note": note, "items": items}, 0o600)

    kept = items_path if written else f"{items_path} (already there, kept)"
    print(f"feed {a.feed} {a.date}: {len(items)} items, {len(overflow)} overflow, {considered} considered -> {kept}")
    return 0


def render_packet(a):
    run = os.path.join(a.data, "feeds", ".run")
    works = [read_json(p) for p in sorted(glob.glob(os.path.join(run, "work", a.date, "*.json")))]
    if not works:
        print(f"packet {a.date}: no feed ran, no packet")
        return 0
    failed = [f for f in (a.failed or "").split(",") if f]
    names = source_names(a.data)
    now = dt.datetime.now().astimezone().replace(microsecond=0).isoformat()
    since = min(w["since"] for w in works)
    status = "degraded" if failed or any(w.get("status") != "ok" for w in works) else "ok"
    notes = [f"{w['name']}: {w['note']}" for w in works]
    for fid in failed:
        feed = read_json(os.path.join(a.data, "feeds", fid, "feed.json"), {}) or {}
        notes.append(f"{feed.get('name', fid)} could not run.")

    lines = ["domain: watch", f"generated_at: {now}", f"data_as_of: {now}", f"since: {since}",
             f"status: {status}", f"notes: {q(' '.join(notes))}"]
    entries = []
    for w in works:
        for i, it in enumerate(w["items"], 1):
            receipt = " / ".join(names.get(s, s) for s in it["sources"]) + ": " + it["url"]
            entries += [
                f"  - id: watch/{w['feed']}/{a.date}/{i}",
                "    kind: context",
                f"    headline: {q(it['headline'])}",
                f"    why: {q(it.get('takeaway') or it['headline'])}",
                f"    as_of: {w['generated_at']}",
                "    origin: external",
                "    basis: summarized",
                f"    about: watch/{w['feed']}/{a.date}",
                "    receipt:",
                f"      - {q(receipt)}",
            ]
    lines += ["items:"] + entries if entries else ["items: []"]
    lines.append("")

    packet = os.path.join(run, "packets", f"{a.date}.yaml")
    os.makedirs(os.path.dirname(packet), exist_ok=True)
    tmp = packet + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.chmod(tmp, 0o600)
    os.replace(tmp, packet)
    print(f"packet {a.date}: {len(works)} feeds, {sum(len(w['items']) for w in works)} items -> {packet}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=("feed", "packet"))
    ap.add_argument("--data", required=True)
    ap.add_argument("--date", required=True)
    ap.add_argument("--feed")
    ap.add_argument("--since")
    ap.add_argument("--envelope")
    ap.add_argument("--read", default="")
    ap.add_argument("--status", default="ok")
    ap.add_argument("--note", default="")
    ap.add_argument("--failed", default="")
    a = ap.parse_args()
    if a.command == "feed":
        if not (a.feed and a.since and a.envelope):
            ap.error("feed needs --feed, --since, and --envelope")
        return render_feed(a)
    return render_packet(a)


if __name__ == "__main__":
    sys.exit(main())
