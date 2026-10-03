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
from unittest import mock

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

    def read_brief(self):
        path = os.path.join(self.dir, f"brief-{DATE}.json")
        with open(path, encoding="utf-8") as f:
            return json.load(f), path

    def test_build_writes_the_brief_data_with_paragraph_ids(self):
        self.write_memo(MEMO)
        result = build(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        brief, _ = self.read_brief()
        self.assertEqual(
            set(brief), {"date", "title", "words", "opening", "sections"}
        )
        self.assertEqual(brief["date"], DATE)
        self.assertEqual(brief["title"], "Monday, a quiet start")
        self.assertEqual(brief["words"], 24)
        self.assertEqual(
            brief["opening"],
            {"id": "opening", "text": "Cash is fine and nothing is due before Thursday."},
        )
        self.assertEqual(
            brief["sections"],
            [
                {
                    "id": "money",
                    "label": "Money",
                    "items": [
                        {
                            "id": "money-1",
                            "text": "- The snapshot ran; drift is under a point.",
                        }
                    ],
                },
                {
                    "id": "work",
                    "label": "Work",
                    "items": [
                        {"id": "work-1", "text": "Two threads wait on other people."}
                    ],
                },
            ],
        )

    def test_brief_data_uses_null_without_an_opening_and_unique_section_slugs(self):
        self.write_memo(
            "# Tuesday\n\n## Needs You\n\nFirst ask.\n\n## Needs-You\n\nSecond ask.\n"
        )
        result = build(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        brief, _ = self.read_brief()
        self.assertIsNone(brief["opening"])
        self.assertEqual(
            [section["id"] for section in brief["sections"]],
            ["needs-you", "needs-you-2"],
        )
        self.assertEqual(
            [section["items"][0]["id"] for section in brief["sections"]],
            ["needs-you-1", "needs-you-2-1"],
        )

    def test_brief_data_keeps_each_paragraph_and_list_as_one_item(self):
        self.write_memo(
            "# Tuesday\n\n## Work\n\nFirst paragraph.\n\n"
            "* One\n+ Two\n\nLast paragraph.\n"
        )
        result = build(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        brief, _ = self.read_brief()
        self.assertEqual(
            brief["sections"][0]["items"],
            [
                {"id": "work-1", "text": "First paragraph."},
                {"id": "work-2", "text": "- One\n- Two"},
                {"id": "work-3", "text": "Last paragraph."},
            ],
        )

    def test_more_than_200_items_fails_before_writing_outputs(self):
        paragraphs = "\n\n".join("Item" for _ in range(200))
        self.write_memo(f"# Too many\n\nOpening.\n\n## Work\n\n{paragraphs}\n")
        result = build(self.dir)
        self.assertEqual(result.returncode, 1)
        self.assertIn("201 items; the cap is 200", result.stderr)
        self.assertEqual(
            sorted(name for name in os.listdir(self.dir) if not name.startswith("memo-")),
            [],
        )

    def test_200_items_is_allowed(self):
        paragraphs = "\n\n".join("Item" for _ in range(199))
        self.write_memo(f"# At the cap\n\nOpening.\n\n## Work\n\n{paragraphs}\n")
        result = build(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        brief, _ = self.read_brief()
        self.assertEqual(
            1 + sum(len(section["items"]) for section in brief["sections"]),
            200,
        )

    def test_brief_data_replaces_atomically_with_mode_0600(self):
        path = os.path.join(self.dir, f"brief-{DATE}.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("old\n")
        os.chmod(path, 0o644)
        self.write_memo(MEMO)
        result = build(self.dir)
        self.assertEqual(result.returncode, 0, result.stderr)
        brief, path = self.read_brief()
        self.assertEqual(brief["date"], DATE)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertFalse(
            os.path.exists(os.path.join(self.dir, f".brief-{DATE}.json.tmp"))
        )

    def test_atomic_replace_failure_keeps_the_previous_brief_data(self):
        path = os.path.join(self.dir, f"brief-{DATE}.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("old\n")
        sys.path.insert(0, os.path.dirname(BUILD))
        try:
            import build as module
        finally:
            sys.path.pop(0)

        with mock.patch.object(module.os, "replace", side_effect=OSError("stopped")):
            with self.assertRaises(OSError):
                module.write_atomic(path, "new\n", mode=0o600)

        with open(path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "old\n")

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
