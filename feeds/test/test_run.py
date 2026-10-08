"""The feeds run: its dry run, its context, and what render.py writes, all
under PERSONAL_ASSISTANT_HOME.

Run from the repo root: python3 -m unittest discover -s feeds/test
Every case points at a temporary root with two feeds and a few sources of
each kind, never at ~/.personal-assistant, and makes no claude or network
call.
"""

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

FEEDS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FEEDS_DIR)
RUN = os.path.join(FEEDS_DIR, "run", "run-feeds")
RENDER = os.path.join(FEEDS_DIR, "run", "render.py")
PREPARE = os.path.join(FEEDS_DIR, "run", "prepare.py")
DATE = "2001-01-08"

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("prepare", PREPARE)
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def tree(root):
    found = set()
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in dirs + files:
            found.add(os.path.relpath(os.path.join(base, name), root))
    return found


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class Root(unittest.TestCase):
    """A data root with two active feeds, one inactive, and sources of every kind."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="feeds-root-")
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = os.path.join(self.tmp, "root")
        self.notes = os.path.join(self.tmp, "notes")
        write(os.path.join(self.notes, "priorities.md"), "# Priorities\nShip the thing.\n")
        write(os.path.join(self.notes, "dir", "a.md"), "Note A.\n")
        write(os.path.join(self.notes, "dir", "b.md"), "Note B.\n")
        write(os.path.join(self.notes, "dir", "skip.txt"), "Not markdown.\n")
        self.source("letter-rss", "Letter", "rss", url="https://letter.example.com/feed")
        self.source("letter-mail", "Letter by mail", "email", sender="news@letter.example.com")
        self.source("other-mail", "Other", "email", sender="Other <other@mail.example.com>")
        self.source("priorities", "Priorities", "file", path=os.path.join(self.notes, "priorities.md"))
        self.source("notes-dir", "Notes", "folder", path=os.path.join(self.notes, "dir"))
        self.source("town-rss", "Town", "rss", url="https://town.example.com/atom")
        self.source("retired", "Retired", "rss", url="https://retired.example.com/feed", active=False)
        self.feed("news", "News", ["letter-rss", "letter-mail", "other-mail", "priorities", "retired"])
        self.feed("local", "Local", ["town-rss", "notes-dir"])
        self.feed("old", "Old", ["town-rss"], active=False)
        write(os.path.join(self.root, "feeds", ".run", "state.json"),
              json.dumps({"feeds": {"news": {"last_run": "2001-01-05"}}, "reported": ["2001-01-01"]}))
        self.env = dict(os.environ, PERSONAL_ASSISTANT_HOME=self.root)

    def source(self, sid, name, kind, active=True, **fields):
        write(os.path.join(self.root, "sources", f"{sid}.json"), json.dumps(dict(
            version=1, id=sid, name=name, kind=kind, active=active, default=False,
            created="2001-01-01T00:00:00Z", updated="2001-01-01T00:00:00Z", **fields)))

    def feed(self, fid, name, sources, active=True):
        write(os.path.join(self.root, "feeds", fid, "feed.json"), json.dumps(dict(
            version=1, id=fid, name=name, producer="scout", sources=sources, active=active,
            created="2001-01-01T00:00:00Z", updated="2001-01-01T00:00:00Z")))
        write(os.path.join(self.root, "feeds", fid, "note.md"), f"The {name} feed's note.\n")


class DryRunTest(Root):
    def dry_run(self):
        repo_before, root_before = tree(FEEDS_DIR), tree(self.root)
        result = subprocess.run(["/bin/sh", RUN, "--dry-run", "--date", DATE], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(tree(FEEDS_DIR), repo_before)
        self.assertEqual(tree(self.root), root_before)
        return result.stdout

    def block(self, out, fid):
        m = re.search(rf"^  feed {fid} .*?(?=^  feed |^  packet)", out, re.S | re.M)
        self.assertTrue(m, out)
        return m.group(0)

    def test_prints_each_active_feed_with_its_sources_by_kind(self):
        out = self.dry_run()
        self.assertEqual(out.splitlines()[1], f"  data root {self.root}")
        self.assertIn("  feed news (News) since=2001-01-05", out)
        self.assertIn("  feed local (Local) since=2000-12-25", out)
        self.assertNotIn("feed old", out)
        news = self.block(out, "news")
        self.assertIn("    rss: letter-rss https://letter.example.com/feed", news)
        self.assertIn("    email: letter-mail news@letter.example.com, other-mail Other <other@mail.example.com>", news)
        self.assertIn(f"    context: priorities {self.notes}/priorities.md", news)
        self.assertNotIn("retired", news)
        local = self.block(out, "local")
        self.assertIn("    rss: town-rss https://town.example.com/atom", local)
        self.assertIn(f"    context: notes-dir {self.notes}/dir", local)

    def test_prints_the_paths_under_the_root(self):
        out = self.dry_run()
        news = self.block(out, "news")
        self.assertIn(f"{self.root}/feeds/news/note.md", news)
        self.assertIn(f"{self.root}/feeds/news/items/{DATE}.json", news)
        self.assertIn(f"{self.root}/feeds/.run/overflow/{DATE}-news.json", news)
        self.assertIn(f"{self.root}/feeds/.run/work/{DATE}/news.json", news)
        self.assertIn(f"{self.root}/feeds/.run/packets/{DATE}.yaml", out)

    def test_a_feed_with_email_sources_queries_their_senders(self):
        news = self.block(self.dry_run(), "news")
        self.assertIn("query=(from:news@letter.example.com OR from:other@mail.example.com) after:2001/01/05", news)
        self.assertIn("mcp__claude_ai_Gmail__search_threads", news)

    def test_a_feed_with_no_email_sources_makes_no_gmail_call(self):
        local = self.block(self.dry_run(), "local")
        self.assertIn("    email: none, no Gmail call", local)
        self.assertNotIn("Gmail__", local)
        self.assertNotIn("query=", local)

    def test_a_feed_already_written_for_the_date_is_skipped(self):
        write(os.path.join(self.root, "feeds", "local", "items", f"{DATE}.json"), "{}\n")
        out = self.dry_run()
        local = self.block(out, "local")
        self.assertIn(f"    skipped: {self.root}/feeds/local/items/{DATE}.json is already written", local)
        self.assertNotIn("triage:", local)
        self.assertIn("triage:", self.block(out, "news"))

    def test_no_active_feed_is_a_quiet_dry_run(self):
        for fid in ("news", "local"):
            os.remove(os.path.join(self.root, "feeds", fid, "feed.json"))
        out = self.dry_run()
        self.assertIn("  no active feeds", out)


class ContextTest(Root):
    def test_a_file_and_a_folder_with_their_paths_as_headings(self):
        text, notes = prepare.context(self.root, prepare.load_feed(self.root, "news"))
        self.assertIn(f"### {self.notes}/priorities.md\n\n# Priorities", text)
        self.assertEqual(notes, [])
        text, _ = prepare.context(self.root, prepare.load_feed(self.root, "local"))
        self.assertIn(f"### {self.notes}/dir/a.md\n\nNote A.", text)
        self.assertIn(f"### {self.notes}/dir/b.md\n\nNote B.", text)
        self.assertNotIn("Not markdown", text)

    def test_a_source_over_its_cap_is_cut_and_the_run_says_so(self):
        write(os.path.join(self.notes, "priorities.md"), "x" * (70 * 1024))
        text, notes = prepare.context(self.root, prepare.load_feed(self.root, "news"))
        self.assertLessEqual(len(text.encode()), prepare.SOURCE_CAP + 200)
        self.assertEqual(notes, ["Context priorities was cut at 64 KB."])

    def test_the_total_is_capped(self):
        names = []
        for i in range(5):
            sid = f"big-{i}"
            write(os.path.join(self.notes, f"{sid}.md"), "y" * (60 * 1024))
            self.source(sid, sid, "file", path=os.path.join(self.notes, f"{sid}.md"))
            names.append(sid)
        self.feed("big", "Big", names)
        text, notes = prepare.context(self.root, prepare.load_feed(self.root, "big"))
        self.assertLessEqual(len(text.encode()), prepare.TOTAL_CAP)
        self.assertEqual(notes, ["Context big-4 was cut: the context reached 256 KB."])

    def test_a_missing_path_is_noted(self):
        os.remove(os.path.join(self.notes, "priorities.md"))
        text, notes = prepare.context(self.root, prepare.load_feed(self.root, "news"))
        self.assertEqual(text, "")
        self.assertEqual(notes, [f"Context priorities was not found at {self.notes}/priorities.md."])


class PrepareTest(Root):
    def test_seen_is_per_feed_and_fourteen_days(self):
        write(os.path.join(self.root, "feeds", ".run", "seen.jsonl"), "".join(json.dumps(l) + "\n" for l in [
            {"feed": "news", "date": "2001-01-01", "sources": ["letter-rss"], "title": "Recent", "url": "https://e.com/1"},
            {"feed": "news", "date": "2000-12-20", "sources": ["letter-rss"], "title": "Stale", "url": "https://e.com/2"},
            {"feed": "local", "date": "2001-01-07", "sources": ["town-rss"], "title": "Other feed", "url": "https://e.com/3"},
        ]))
        self.assertEqual(prepare.seen(self.root, "news", DATE), "- [letter-rss] Recent <https://e.com/1>")
        self.assertEqual(prepare.seen(self.root, "local", DATE), "- [town-rss] Other feed <https://e.com/3>")

    def test_a_thread_is_matched_to_its_source_by_sender(self):
        feed = prepare.load_feed(self.root, "news")
        self.assertEqual(prepare.source_for_sender(feed, "Other Letter <other@mail.example.com>")["id"], "other-mail")
        self.assertEqual(prepare.source_for_sender(feed, "news@letter.example.com")["id"], "letter-mail")
        self.assertIsNone(prepare.source_for_sender(feed, "nobody@example.com"))


def envelope(path, items, overflow):
    write(path, json.dumps({"structured_output": {"considered": len(items) + len(overflow), "duplicates_collapsed": 0,
                                                  "items": items, "overflow": overflow}}))
    return path


def kept(n, sources):
    return {"title": f"Kept {n}", "sources": sources, "url": f"https://example.com/k{n}",
            "headline": f"Headline {n}.", "takeaway": f"Takeaway {n}.", "insights": f"Insights {n}."}


def spare(n, sources):
    return {"title": f"Spare {n}", "sources": sources, "url": f"https://example.com/s{n}",
            "summary": f"Summary {n}.", "takeaway": f"Spare takeaway {n}.", "insights": f"Spare insights {n}."}


class RenderTest(Root):
    def render(self, fid, items, overflow, read):
        env = envelope(os.path.join(self.tmp, f"triage-{fid}.json"), items, overflow)
        result = subprocess.run([sys.executable, RENDER, "feed", "--data", self.root, "--feed", fid, "--date", DATE,
                                 "--since", "2001-01-05", "--envelope", env, "--read", read],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def packet(self, *extra):
        result = subprocess.run([sys.executable, RENDER, "packet", "--data", self.root, "--date", DATE, *extra],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        path = os.path.join(self.root, "feeds", ".run", "packets", f"{DATE}.yaml")
        if not os.path.exists(path):
            return None
        with open(path, encoding="utf-8") as f:
            return f.read()

    def test_two_feeds_make_one_packet_with_both_feeds_kept_items(self):
        self.render("news", [kept(1, ["letter-rss", "letter-mail"])], [spare(1, ["letter-rss"])], "letter-rss,letter-mail,priorities")
        self.render("local", [kept(2, ["town-rss"])], [], "town-rss,notes-dir")
        packet = self.packet()
        self.assertIn("domain: watch", packet)
        self.assertIn(f"  - id: watch/news/{DATE}/1", packet)
        self.assertIn(f"  - id: watch/local/{DATE}/1", packet)
        self.assertIn('    headline: "Headline 1."', packet)
        self.assertIn('    why: "Takeaway 2."', packet)
        self.assertIn(f"    about: watch/news/{DATE}", packet)
        self.assertIn('      - "Letter / Letter by mail: https://example.com/k1"', packet)
        self.assertIn("status: ok", packet)
        self.assertIn("News: ", packet)
        self.assertIn("Local: ", packet)
        self.assertNotIn("Spare", packet)
        self.assertEqual(packet.count("  - id: "), 2)

    def test_the_feed_file_has_the_new_shape(self):
        self.render("news", [kept(1, ["letter-rss"])], [spare(1, ["letter-mail"])], "letter-rss,letter-mail,priorities")
        doc = read_json(os.path.join(self.root, "feeds", "news", "items", f"{DATE}.json"))
        self.assertEqual({k: doc[k] for k in ("feed", "producer", "date", "since", "read")},
                         {"feed": "news", "producer": "scout", "date": DATE, "since": "2001-01-05",
                          "read": ["letter-rss", "letter-mail", "priorities"]})
        self.assertEqual(doc["items"][0], {"id": f"news/{DATE}/1", "title": "Kept 1", "url": "https://example.com/k1",
                                           "sources": ["letter-rss"], "summary": "Headline 1.", "takeaway": "Takeaway 1.",
                                           "insights": "Insights 1.", "kept": True})
        self.assertEqual(doc["items"][1]["id"], f"news/{DATE}/2")
        self.assertEqual(doc["items"][1]["summary"], "Summary 1.")
        self.assertFalse(doc["items"][1]["kept"])
        self.assertNotIn("test", doc["items"][0])

    def test_state_seen_and_overflow_are_per_feed(self):
        self.render("news", [kept(1, ["letter-rss"])], [spare(1, ["letter-rss"])], "letter-rss")
        self.render("local", [], [spare(2, ["town-rss"])], "town-rss")
        run = os.path.join(self.root, "feeds", ".run")
        state = read_json(os.path.join(run, "state.json"))
        self.assertEqual(state["feeds"], {"news": {"last_run": DATE}, "local": {"last_run": DATE}})
        self.assertEqual(state["reported"], ["2001-01-01"])
        with open(os.path.join(run, "seen.jsonl"), encoding="utf-8") as f:
            seen = [json.loads(l) for l in f]
        self.assertEqual([(s["feed"], s["verdict"], s["title"]) for s in seen],
                         [("news", "kept", "Kept 1"), ("news", "overflow", "Spare 1"), ("local", "overflow", "Spare 2")])
        self.assertEqual(read_json(os.path.join(run, "overflow", f"{DATE}-local.json"))["overflow"][0]["title"], "Spare 2")
        self.assertEqual(read_json(os.path.join(run, "work", DATE, "local.json"))["items"], [])

    def test_an_existing_feed_file_is_left_as_it_is(self):
        path = os.path.join(self.root, "feeds", "news", "items", f"{DATE}.json")
        write(path, '{"kept": "as is"}\n')
        self.render("news", [kept(1, ["letter-rss"])], [], "letter-rss")
        self.assertEqual(read_json(path), {"kept": "as is"})

    def test_a_failed_feed_degrades_the_packet(self):
        self.render("news", [kept(1, ["letter-rss"])], [], "letter-rss")
        packet = self.packet("--failed", "local")
        self.assertIn("status: degraded", packet)
        self.assertIn("Local could not run.", packet)

    def test_no_feed_ran_writes_no_packet(self):
        self.assertIsNone(self.packet("--failed", "news,local"))


if __name__ == "__main__":
    unittest.main()
