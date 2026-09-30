"""daily-brief/briefs/build.py on a scratch directory.

Run from the repo root: python3 -m unittest discover -s daily-brief
Never points at daily-brief/briefs/ itself.
"""

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

BUILD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "briefs", "build.py")
DATE = "2001-01-01"

MEMO = """# Monday, a quiet start

Cash is fine and nothing is due before Thursday.

## Money

- The snapshot ran; drift is under a point.

## Work

Two threads wait on other people.
"""


def build(directory, date=DATE):
    return subprocess.run([sys.executable, BUILD, date, "--dir", directory], capture_output=True, text=True)


class BuildNoticeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="brief-build-")

    def tearDown(self):
        for name in os.listdir(self.dir):
            os.remove(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def write_memo(self, text):
        with open(os.path.join(self.dir, f"memo-{DATE}.md"), "w", encoding="utf-8") as f:
            f.write(text)

    def read_notice(self):
        path = os.path.join(self.dir, f"notice-{DATE}.json")
        with open(path, encoding="utf-8") as f:
            return json.load(f), path

    def test_build_writes_the_notice_beside_the_viewer(self):
        self.write_memo(MEMO)
        result = build(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.dir, f"viewer-{DATE}.html")))
        notice, path = self.read_notice()
        self.assertEqual(notice["date"], DATE)
        self.assertEqual(notice["state"], "ready")
        self.assertEqual(notice["opening"], "Cash is fine and nothing is due before Thursday.")
        self.assertTrue(notice["memo"].startswith("Cash is fine"), notice["memo"])
        self.assertNotIn("# Monday", notice["memo"])
        self.assertIn("## Money", notice["memo"])
        self.assertIn("Two threads wait on other people.", notice["memo"])
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertIn(f"notice-{DATE}.json", result.stdout)
        self.assertEqual([n for n in os.listdir(self.dir) if n.startswith(".")], [])

    def test_a_memo_without_an_opening_uses_the_title(self):
        self.write_memo("# Tuesday\n\n## Money\n\n- Drift is flat.\n")
        result = build(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        notice, _ = self.read_notice()
        self.assertEqual(notice["opening"], "Tuesday")
        self.assertEqual(notice["memo"], "## Money\n\n- Drift is flat.\n")

    def test_a_memo_without_a_title_uses_the_default_title(self):
        self.write_memo("## Money\n\n- Drift is flat.\n")
        result = build(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        notice, _ = self.read_notice()
        self.assertEqual(notice["opening"], f"Daily Brief — Monday, {DATE}")

    def test_the_memo_is_capped_at_six_kib(self):
        paragraph = "Words " * 120  # ~720 bytes each; ten sections pass 6 KiB
        sections = "".join(f"\n## Section {i}\n\n{paragraph.strip()}\n" for i in range(10))
        self.write_memo("# Long\n\nAn opening line.\n" + sections)
        result = build(self.dir)
        # Over the word cap: build.py refuses, so no notice is written.
        self.assertEqual(result.returncode, 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir, f"notice-{DATE}.json")))

    def test_memo_body_cuts_on_a_character_boundary(self):
        sys.path.insert(0, os.path.dirname(BUILD))
        try:
            import build as module
        finally:
            sys.path.pop(0)
        text = "# T\n\n" + ("é" * (module.NOTICE_MEMO_BYTES))  # two bytes each
        body = module.memo_body(text)
        self.assertLessEqual(len(body.encode("utf-8")), module.NOTICE_MEMO_BYTES)
        self.assertTrue(all(ch == "é" for ch in body))

    def test_a_failed_build_writes_no_notice(self):
        self.write_memo("# Bad\n\n### not allowed\n")
        result = build(self.dir)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir, f"notice-{DATE}.json")))


if __name__ == "__main__":
    unittest.main()
