"""feeds/run/fetch_rss.py against RSS and Atom fixtures served from files.

Run from the repo root: python3 -m unittest discover -s feeds/test
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

FETCH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "run", "fetch_rss.py")
spec = importlib.util.spec_from_file_location("fetch_rss", FETCH)
fetch_rss = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(fetch_rss)

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Fixture Letter</title>
  <link>https://letter.example.com/</link>
  <item>
    <title>New issue</title>
    <link>/p/new-issue</link>
    <pubDate>Tue, 09 Jan 2001 07:00:00 GMT</pubDate>
    <description>Short &lt;b&gt;teaser&lt;/b&gt;</description>
    <content:encoded><![CDATA[<h2>Story one</h2><p>Body <a href="https://a.example.com/1">link</a>.</p><script>var x = 1;</script>]]></content:encoded>
  </item>
  <item>
    <title>Bare issue</title>
    <link>https://letter.example.com/p/bare</link>
    <pubDate>Mon, 08 Jan 2001 23:30:00 -0600</pubDate>
  </item>
  <item>
    <title>Old issue</title>
    <link>https://letter.example.com/p/old</link>
    <pubDate>Fri, 05 Jan 2001 07:00:00 GMT</pubDate>
    <description>Old.</description>
  </item>
  <item>
    <title>Undated issue</title>
    <link>https://letter.example.com/p/undated</link>
  </item>
</channel>
</rss>
"""

ATOM = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://atom.example.com/blog/">
  <title>Fixture Atom</title>
  <link rel="self" href="https://atom.example.com/feed.atom"/>
  <entry>
    <title type="html">Post &amp;amp; more</title>
    <link rel="alternate" href="posts/one"/>
    <updated>2001-01-10T09:00:00Z</updated>
    <content type="html">&lt;p&gt;Atom body.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Summary only</title>
    <link href="https://atom.example.com/two"/>
    <published>2001-01-08T00:00:00+00:00</published>
    <updated>2001-01-09T00:00:00+00:00</updated>
    <summary>Just a summary.</summary>
  </entry>
  <entry>
    <title>Old post</title>
    <link href="https://atom.example.com/old"/>
    <updated>2000-12-31T00:00:00Z</updated>
  </entry>
</feed>
"""


class ParseTest(unittest.TestCase):
    def test_rss_keeps_entries_since_the_date_and_resolves_links(self):
        entries, newest = fetch_rss.parse(RSS.encode(), "https://letter.example.com/feed", "2001-01-08")
        self.assertEqual([e["title"] for e in entries], ["New issue", "Bare issue"])
        self.assertEqual(entries[0]["link"], "https://letter.example.com/p/new-issue")
        self.assertEqual(entries[0]["date"], "2001-01-09T07:00:00+00:00")
        self.assertEqual(newest, "2001-01-09T07:00:00+00:00")

    def test_rss_content_prefers_the_full_body_with_html_stripped(self):
        entries, _ = fetch_rss.parse(RSS.encode(), "https://letter.example.com/feed", "2001-01-08")
        self.assertIn("Story one", entries[0]["content"])
        self.assertIn("Body link.", entries[0]["content"].replace("\n", " ").replace("  ", " "))
        self.assertNotIn("<", entries[0]["content"])
        self.assertNotIn("var x", entries[0]["content"])

    def test_rss_entry_without_a_description_has_empty_content(self):
        entries, _ = fetch_rss.parse(RSS.encode(), "https://letter.example.com/feed", "2001-01-08")
        self.assertEqual(entries[1]["content"], "")
        self.assertEqual(entries[1]["date"], "2001-01-08T23:30:00-06:00")

    def test_atom_keeps_entries_since_the_date_and_resolves_against_xml_base(self):
        entries, newest = fetch_rss.parse(ATOM.encode(), "https://atom.example.com/feed.atom", "2001-01-08")
        self.assertEqual([e["title"] for e in entries], ["Post & more", "Summary only"])
        self.assertEqual(entries[0]["link"], "https://atom.example.com/blog/posts/one")
        self.assertEqual(entries[0]["content"], "Atom body.")
        self.assertEqual(entries[1]["content"], "Just a summary.")
        self.assertEqual(entries[1]["date"], "2001-01-08T00:00:00+00:00")
        self.assertEqual(newest, "2001-01-10T09:00:00+00:00")

    def test_newest_counts_entries_before_the_date_too(self):
        entries, newest = fetch_rss.parse(ATOM.encode(), "https://atom.example.com/feed.atom", "2001-02-01")
        self.assertEqual(entries, [])
        self.assertEqual(newest, "2001-01-10T09:00:00+00:00")

    def test_content_is_capped(self):
        body = "<p>" + "word " * 40000 + "</p>"
        doc = RSS.replace("Short &lt;b&gt;teaser&lt;/b&gt;", "x").replace(
            '<h2>Story one</h2><p>Body <a href="https://a.example.com/1">link</a>.</p><script>var x = 1;</script>', body)
        entries, _ = fetch_rss.parse(doc.encode(), "https://letter.example.com/feed", "2001-01-08")
        self.assertLessEqual(len(entries[0]["content"].encode("utf-8")), fetch_rss.MAX_CONTENT)


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="fetch-rss-")
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_writes_one_file_per_entry_and_reports_the_newest_date(self):
        src = os.path.join(self.tmp, "feed.xml")
        with open(src, "w", encoding="utf-8") as f:
            f.write(RSS)
        out = os.path.join(self.tmp, "out")
        result = subprocess.run([sys.executable, FETCH, "--since", "2001-01-08", "--out", out, "file://" + src],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"entries": 2, "newest": "2001-01-09T07:00:00+00:00"})
        self.assertEqual(sorted(os.listdir(out)), ["entry-1.json", "entry-2.json"])
        with open(os.path.join(out, "entry-1.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["title"], "New issue")

    def test_a_feed_that_does_not_parse_fails(self):
        src = os.path.join(self.tmp, "feed.xml")
        with open(src, "w", encoding="utf-8") as f:
            f.write("<html>not a feed")
        result = subprocess.run([sys.executable, FETCH, "--since", "2001-01-08", "--out", os.path.join(self.tmp, "o"), "file://" + src],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("fetch_rss", result.stderr)


if __name__ == "__main__":
    unittest.main()
