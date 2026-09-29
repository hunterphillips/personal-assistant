#!/usr/bin/env python3
"""Turn a triage envelope into the watch packet, the overflow file, the
seen-store lines, and the state update. Standard library only.

    render.py --date D --since S --envelope triage.json --threads N
"""
import argparse, datetime as dt, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))


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

    packets = os.path.join(HERE, "packets")
    os.makedirs(packets, exist_ok=True)
    packet = os.path.join(packets, f"{a.date}.yaml")
    tmp = packet + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.chmod(tmp, 0o600)
    os.replace(tmp, packet)

    ov_dir = os.path.join(HERE, "overflow")
    os.makedirs(ov_dir, exist_ok=True)
    with open(os.path.join(ov_dir, f"{a.date}.json"), "w", encoding="utf-8") as f:
        json.dump({"date": a.date, "since": a.since, "overflow": overflow}, f, ensure_ascii=False, indent=1)

    with open(os.path.join(HERE, "seen.jsonl"), "a", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps({"date": a.date, "verdict": "kept", "source": it["source"], "title": it["title"], "url": it["url"]}, ensure_ascii=False) + "\n")
        for it in overflow:
            f.write(json.dumps({"date": a.date, "verdict": "overflow", "source": it["source"], "title": it["title"], "url": it["url"]}, ensure_ascii=False) + "\n")

    state_path = os.path.join(HERE, "state.json")
    state = {}
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    state["last_run"] = a.date
    state.setdefault("reported", [])
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)

    print(f"watch {a.date}: {len(items)} items, {len(overflow)} overflow, {considered} considered -> {packet}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
