#!/usr/bin/env python3
"""Write the ideas still open for the brief: suggestions from the last 14 days
that Hunter has not started, dismissed, or seen replaced.

    open-ideas.py <data-root> <date> <out.json>

Writes nothing and exits 0 when no idea is open, so the curator sees no file.
"""
import datetime, json, os, sys

CLOSED = {"taken", "dismissed", "replaced"}


def main(data, date, out):
    items_dir = os.path.join(data, "ideas", "items")
    try:
        marks = json.load(open(os.path.join(data, "ideas", "marks.json")))
    except (OSError, ValueError):
        marks = {}
    since = (datetime.date.fromisoformat(date) - datetime.timedelta(days=14)).isoformat()
    open_ideas = []
    try:
        names = sorted(os.listdir(items_dir))
    except OSError:
        names = []
    for name in names:
        if not name.endswith(".json") or name[:10] < since or name[:10] > date:
            continue
        try:
            run = json.load(open(os.path.join(items_dir, name)))
        except (OSError, ValueError):
            continue
        for item in run.get("items") or []:
            mark = marks.get(item.get("id")) or {}
            if mark.get("status") in CLOSED:
                continue
            open_ideas.append({
                "id": item.get("id"),
                "suggested": run.get("date") or name[:10],
                "title": item.get("title"),
                "text": item.get("text"),
                "saved": mark.get("status") == "saved",
            })
    if not open_ideas:
        return
    tmp = out + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump({"ideas": open_ideas}, f, indent=1)
    os.replace(tmp, out)


if __name__ == "__main__":
    main(*sys.argv[1:4])
