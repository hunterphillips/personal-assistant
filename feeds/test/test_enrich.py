"""feeds/bin/enrich against a local http.server fixture.

Run from the repo root: python3 -m unittest discover -s feeds/test
"""

import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ENRICH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "enrich")

# path -> (status, headers, body), or "slow" for a page that answers after the timeout.
PAGES = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        page = PAGES.get(self.path)
        if page is None:
            self.send_response(404)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<html><head><meta property='og:image' content='https://example.com/404.jpg'></head></html>")
            return
        if page == "slow":
            time.sleep(8)
            page = html('<meta property="og:image" content="https://cdn.example.com/slow.jpg">')
        status, headers, body = page
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, *args):
        pass


def html(head, body=""):
    return (200, {"Content-Type": "text/html; charset=utf-8"}, f"<!doctype html><html><head>{head}</head><body>{body}</body></html>")


class EnrichTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.server.daemon_threads = True
        cls.origin = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        PAGES.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def feed(self, items, name="2026-09-28-watch.json"):
        path = os.path.join(self.dir.name, name)
        doc = {"producer": "watch", "date": "2026-09-28", "since": "2026-09-14",
               "generated_at": "2026-09-28T14:47:22-05:00", "items": items}
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
            f.write("\n")
        return path

    def item(self, n, page, **extra):
        entry = {"id": f"watch/2026-09-28/{n}", "title": f"Title {n}", "source": "Invented Gazette",
                 "url": self.origin + page, "test": 5, "summary": f"Summary {n}", "kept": True}
        entry.update(extra)
        return entry

    def enrich(self, *args):
        return subprocess.run([sys.executable, ENRICH, *args], capture_output=True, text=True, timeout=60)

    def read(self, path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def test_fills_image_from_og_image(self):
        PAGES["/a"] = html('<meta property="og:image" content="https://cdn.example.com/a.jpg">')
        path = self.feed([self.item(1, "/a")])
        done = self.enrich(path)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.read(path)["items"][0]["image"], "https://cdn.example.com/a.jpg")

    def test_falls_back_to_twitter_image_then_image_src(self):
        PAGES["/tw"] = html('<link rel="image_src" href="https://cdn.example.com/src.jpg">'
                            '<meta name="twitter:image" content="https://cdn.example.com/tw.jpg">')
        PAGES["/src"] = html('<meta property="og:image" content="/relative.jpg">'
                             '<link rel="image_src" href="http://cdn.example.com/src.jpg">')
        PAGES["/body"] = html("", '<meta property="og:image" content="https://cdn.example.com/body.jpg">')
        path = self.feed([self.item(1, "/tw"), self.item(2, "/src"), self.item(3, "/body")])
        done = self.enrich(path)
        self.assertEqual(done.returncode, 0, done.stderr)
        items = self.read(path)["items"]
        self.assertEqual(items[0]["image"], "https://cdn.example.com/tw.jpg")
        # A relative og:image is passed over for the next absolute candidate.
        self.assertEqual(items[1]["image"], "http://cdn.example.com/src.jpg")
        # Only the head counts.
        self.assertNotIn("image", items[2])

    def test_follows_up_to_five_redirects(self):
        PAGES["/final"] = html('<meta property="og:image" content="https://cdn.example.com/final.jpg">')
        for n in range(6):
            PAGES[f"/hop{n}"] = (302, {"Location": f"/hop{n - 1}" if n else "/final"}, "")
        path = self.feed([self.item(1, "/hop4"), self.item(2, "/hop5")])
        done = self.enrich(path)
        self.assertEqual(done.returncode, 0, done.stderr)
        items = self.read(path)["items"]
        self.assertEqual(items[0]["image"], "https://cdn.example.com/final.jpg")
        self.assertNotIn("image", items[1])

    def test_failures_leave_items_untouched_and_the_rest_still_filled(self):
        PAGES["/ok"] = html('<meta property="og:image" content="https://cdn.example.com/ok.jpg">')
        PAGES["/pdf"] = (200, {"Content-Type": "application/pdf"},
                         '<head><meta property="og:image" content="https://cdn.example.com/pdf.jpg"></head>')
        PAGES["/bare"] = html("<title>No picture</title>")
        items = [self.item(1, "/missing"), self.item(2, "/pdf"), self.item(3, "/bare"), self.item(4, "/ok")]
        path = self.feed(items)
        done = self.enrich(path)
        self.assertEqual(done.returncode, 0, done.stderr)
        after = self.read(path)["items"]
        self.assertEqual(after[:3], items[:3])
        self.assertEqual(after[3]["image"], "https://cdn.example.com/ok.jpg")
        errors = done.stderr.strip().splitlines()
        self.assertEqual(len(errors), 2, done.stderr)
        self.assertIn("watch/2026-09-28/1", errors[0])
        self.assertIn("404", errors[0])
        self.assertIn("watch/2026-09-28/2", errors[1])

    def test_skips_items_that_have_an_image_and_writes_only_on_a_change(self):
        PAGES["/a"] = html('<meta property="og:image" content="https://cdn.example.com/new.jpg">')
        path = self.feed([self.item(1, "/a", image="https://cdn.example.com/old.jpg")])
        before = os.stat(path)
        done = self.enrich(path)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(os.stat(path).st_ino, before.st_ino)
        self.assertEqual(self.read(path)["items"][0]["image"], "https://cdn.example.com/old.jpg")

    def test_a_rewrite_keeps_every_other_field_and_the_order_with_mode_600(self):
        PAGES["/a"] = html('<meta property="og:image" content="https://cdn.example.com/a.jpg">')
        items = [self.item(1, "/nothing", x=[1, "é"]), self.item(2, "/a", image=None), self.item(3, "/a")]
        path = self.feed(items)
        with open(path, encoding="utf-8") as f:
            before = json.load(f)
        done = self.enrich(path)
        self.assertEqual(done.returncode, 0, done.stderr)
        after = self.read(path)
        before["items"][1]["image"] = "https://cdn.example.com/a.jpg"
        before["items"][2]["image"] = "https://cdn.example.com/a.jpg"
        self.assertEqual(after, before)
        self.assertEqual(list(after), list(before))
        self.assertEqual([list(entry) for entry in after["items"]], [list(entry) for entry in before["items"]])
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertEqual(sorted(os.listdir(self.dir.name)), ["2026-09-28-watch.json"])

    def test_dry_run_names_the_fetches_and_writes_nothing(self):
        PAGES["/a"] = html('<meta property="og:image" content="https://cdn.example.com/a.jpg">')
        path = self.feed([self.item(1, "/a"), self.item(2, "/a", image="https://cdn.example.com/b.jpg")])
        before = open(path, encoding="utf-8").read()
        done = self.enrich("--dry-run", path)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(open(path, encoding="utf-8").read(), before)
        self.assertIn(self.origin + "/a", done.stdout)
        self.assertIn("watch/2026-09-28/1", done.stdout)
        self.assertNotIn("watch/2026-09-28/2", done.stdout)

    def test_an_unreadable_file_is_exit_1_and_the_other_files_still_run(self):
        PAGES["/a"] = html('<meta property="og:image" content="https://cdn.example.com/a.jpg">')
        path = self.feed([self.item(1, "/a")])
        broken = os.path.join(self.dir.name, "2026-09-21-watch.json")
        with open(broken, "w", encoding="utf-8") as f:
            f.write("{not json")
        missing = os.path.join(self.dir.name, "2026-09-14-watch.json")
        done = self.enrich(broken, missing, path)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(len(done.stderr.strip().splitlines()), 2, done.stderr)
        self.assertEqual(self.read(path)["items"][0]["image"], "https://cdn.example.com/a.jpg")

    def test_a_timeout_leaves_the_item_untouched(self):
        PAGES["/slow"] = "slow"
        path = self.feed([self.item(1, "/slow")])
        before = open(path, encoding="utf-8").read()
        done = self.enrich(path)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(open(path, encoding="utf-8").read(), before)
        self.assertIn("watch/2026-09-28/1", done.stderr)


if __name__ == "__main__":
    unittest.main()
