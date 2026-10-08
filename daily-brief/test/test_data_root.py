"""The brief run and Watch write under PERSONAL_ASSISTANT_HOME.

Run from the repo root: python3 -m unittest discover -s daily-brief/test
Every case points PERSONAL_ASSISTANT_HOME at a temporary root with a
fixture layout, never at ~/.personal-assistant, and checks that nothing
lands in the repository.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

BRIEF_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_BRIEF = os.path.join(BRIEF_DIR, "bin", "run-brief")
CONTRIBUTE = os.path.join(BRIEF_DIR, "watch", "contribute")
RENDER = os.path.join(BRIEF_DIR, "watch", "render.py")
DATE = "2001-01-08"

# The binaries run-brief checks before its dry run; it names them by
# absolute path, so a machine without them cannot run this case.
BINARIES = ("/Users/hunterphillips/.local/bin/claude",
            "/Users/hunterphillips/.nvm/versions/node/v24.18.0/bin/node")

DATA_MARKERS = ("contributions", "memo-", "watch/packets", "state.json",
                "seen.jsonl", "relevance.md", "feed/items", "watch/overflow")
CODE_FILES = ("build.py", "check-viewer.mjs")


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


class DataRootTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="brief-root-")
        self.addCleanup(shutil.rmtree, self.tmp)
        self.root = os.path.join(self.tmp, "root")
        write(os.path.join(self.root, "briefs", "2001-01-06.md"), "# fixture\n")
        write(os.path.join(self.root, "briefs", "memo-2001-01-06.md"), "# fixture\n")
        os.makedirs(os.path.join(self.root, "briefs", "contributions"))
        write(os.path.join(self.root, "watch", "packets", "2001-01-07.yaml"), "domain: watch\n")
        write(os.path.join(self.root, "watch", "state.json"), json.dumps({"last_run": "2001-01-05", "reported": []}))
        write(os.path.join(self.root, "feed", "relevance.md"), "# fixture\n")
        self.env = dict(os.environ, PERSONAL_ASSISTANT_HOME=self.root)
        self.repo_before = tree(BRIEF_DIR)
        self.root_before = tree(self.root)

    def assert_nothing_created(self):
        self.assertEqual(tree(BRIEF_DIR), self.repo_before)
        self.assertEqual(tree(self.root), self.root_before)

    def assert_data_paths_under_root(self, output):
        paths = re.findall(r"/[^\s,()<>]+", output)
        data = [p for p in paths if any(m in p for m in DATA_MARKERS) and not p.endswith(CODE_FILES)]
        self.assertTrue(data)
        for p in data:
            self.assertTrue(p.startswith(self.root + "/"), p)

    @unittest.skipUnless(all(os.access(b, os.X_OK) for b in BINARIES), "run-brief's binaries are not on this machine")
    def test_run_brief_dry_run_prints_the_root_and_only_root_data_paths(self):
        result = subprocess.run(["/bin/sh", RUN_BRIEF, "--dry-run", "--date", DATE],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[1], f"run-brief:   data root {self.root}")
        self.assertIn("cursor=2001-01-06", result.stdout)
        self.assertIn(f"{self.root}/briefs/memo-2001-01-06.md", result.stdout)
        self.assertIn("(2001-01-07 )", result.stdout)
        self.assertIn(f"--dir {self.root}/briefs", result.stdout)
        self.assert_data_paths_under_root(result.stdout)
        self.assert_nothing_created()

    def test_run_brief_refuses_a_relative_root(self):
        env = dict(self.env, PERSONAL_ASSISTANT_HOME="relative/root")
        result = subprocess.run(["/bin/sh", RUN_BRIEF, "--dry-run", "--date", DATE],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be an absolute path", result.stderr)

    def test_watch_dry_run_reads_its_state_from_the_root(self):
        result = subprocess.run(["/bin/sh", CONTRIBUTE, "--dry-run", "--date", DATE],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[1], f"  data root {self.root}")
        self.assertIn("since=2001-01-05", result.stdout)
        self.assertIn(f"--out {self.root}/watch --feed {self.root}/feed/items", result.stdout)
        self.assert_data_paths_under_root(result.stdout)
        self.assert_nothing_created()

    def test_render_writes_where_it_is_told(self):
        envelope = os.path.join(self.tmp, "triage.json")
        write(envelope, json.dumps({"structured_output": {
            "considered": 2, "duplicates_collapsed": 0,
            "items": [{"headline": "A headline.", "why": "Why.", "source": "Fixture News",
                       "url": "https://example.com/a", "title": "A", "test": 1}],
            "overflow": [{"source": "Fixture News", "url": "https://example.com/b",
                          "title": "B", "summary": "A summary.", "test": 2}],
        }}))
        out = os.path.join(self.root, "watch")
        feed = os.path.join(self.root, "feed", "items")
        watch_code = tree(os.path.dirname(RENDER))
        result = subprocess.run([sys.executable, RENDER, "--date", DATE, "--since", "2001-01-05",
                                 "--envelope", envelope, "--threads", "1", "--out", out, "--feed", feed],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in (os.path.join(out, "packets", f"{DATE}.yaml"), os.path.join(out, "overflow", f"{DATE}.json"),
                     os.path.join(out, "seen.jsonl"), os.path.join(feed, f"{DATE}-watch.json")):
            self.assertTrue(os.path.isfile(path), path)
        with open(os.path.join(out, "state.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["last_run"], DATE)
        with open(os.path.join(feed, f"{DATE}-watch.json"), encoding="utf-8") as f:
            self.assertEqual([i["kept"] for i in json.load(f)["items"]], [True, False])
        self.assertEqual(tree(os.path.dirname(RENDER)), watch_code)
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(BRIEF_DIR), "feed", "items", f"{DATE}-watch.json")))


if __name__ == "__main__":
    unittest.main()
