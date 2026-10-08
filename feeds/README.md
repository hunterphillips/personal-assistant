# Feeds

A feed is a folder with its own instructions, its chosen sources, its
posts, and its marks. A source is a registered thing a feed reads: an RSS
feed, a newsletter's email sender, or a file or folder of context. The
dashboard's Feed reads them; the feeds run writes the posts; nothing
edits a post.

Everything here lives in the data root (`PERSONAL_ASSISTANT_HOME`,
default `~/.personal-assistant`), outside the repository, local only: the
posts are summaries of outside content with Hunter's relevance verdicts.
This folder holds the code: `run/` (the daily run), `bin/enrich`, and
`test/`.

## Sources

`sources/<id>.json`, where the id is a slug of the name, unique.

```jsonc
{ "version": 1, "id": "latent-space", "name": "Latent Space",
  "kind": "rss",                                // rss | email | file | folder
  "url": "https://www.latent.space/feed",       // rss
  "sender": "swyx@substack.com",                // email
  "path": "/abs/path/longterm-priorities.md",   // file | folder
  "active": true, "default": false,
  "created": "<ISO>", "updated": "<ISO>" }
```

The role follows from the kind: `rss` and `email` are incoming, read for
stories; `file` and `folder` are context, read to judge them.

## Feeds

`feeds/<id>/feed.json`, with the feed's instructions in `note.md` beside it.

```jsonc
{ "version": 1, "id": "news", "name": "News", "producer": "scout",
  "sources": ["latent-space", "ainews"], "active": true,
  "created": "<ISO>", "updated": "<ISO>" }
```

`feeds/<id>/items/<date>.json` is one file per run of the feed, written by
the producer and append-only: a run that already has a file leaves it
alone, so a post's id keeps pointing at the same story. To redo a run,
delete its file first.

```jsonc
{ "feed": "news", "producer": "scout", "date": "2026-10-09",
  "since": "2026-10-08", "generated_at": "<ISO>",
  "read": ["latent-space", "ainews", "longterm-priorities"],
  "items": [ { "id": "news/2026-10-09/1", "title": "...", "url": "https://...",
    "sources": ["latent-space"], "summary": "...",
    "takeaway": "one sentence",                     // optional, at most 240 chars
    "insights": "markdown, a few short paragraphs", // optional, at most 2000 chars
    "kept": true, "image": "https://..." } ] }
```

- `id` is `<feed>/<date>/<n>`, unique across the store.
- `title`, `url`, `summary` are required and non-empty; `url` is `http` or
  `https`. `sources` lists the ids of every source that ran the story.
- `read` lists the ids of the sources the run read.
- `kept` is true for a post the producer also handed to the Daily Brief;
  the rest passed but missed the feed's cap.
- `image`, optional, is an absolute `http` or `https` URL of the story's
  picture. `bin/enrich` fills it after a run, from the story page's
  `og:image`, `twitter:image`, or `image_src`; a post it finds nothing for
  is left without the key.

Old items, with a `source` string and no `sources`, stay readable: the
reader maps each name in it to a source id by name, or shows the name as
it is.

`feeds/<id>/marks.json` holds Save and Dismiss, written by the daemon only:

```jsonc
{ "version": 1, "marks": { "<item id>": { "status": "saved|dismissed", "at": "<ISO>" } } }
```

## The run

`run/run-feeds` runs every active feed once a day. Per feed, it splits the
feed's active sources by kind:

- **email**: a Gmail search for the senders since the feed's last run,
  then one extract session per thread (`prompts/list.md`,
  `prompts/extract.md`). A feed with no email source makes no Gmail call.
- **rss**: `run/fetch_rss.py` fetches each feed and keeps the entries
  dated since the last run; an entry is often a digest, so each still gets
  an extract session, with no tools and the entry inline. The log names
  each RSS source's newest entry date, so a stale feed shows.
- **file** and **folder**: the file's text, or the folder's `*.md` files,
  each under its path as a heading, up to 64 KB a source and 256 KB in
  all; a cut is said in the packet's notes.

Then one triage session (`prompts/triage.md`) with `run/system-rules.md`,
the feed's `note.md`, the context, what this feed showed in the last
fourteen days, and the stories. `run/render.py feed` writes the items
file and the run's state; after the last feed, `run/render.py packet`
writes one packet for the Daily Brief with every feed's kept posts.
`bin/enrich` fills images per items file.

The run's state is `feeds/.run/` in the data root: `packets/<date>.yaml`
(domain `watch`, which the brief run copies in and marks in `reported`),
`overflow/<date>-<feed>.json`, `work/<date>/<feed>.json` (the kept posts
the packet reads), `seen.jsonl` (one line per post, each with its `feed`),
`state.json` (`feeds.<id>.last_run`, and the brief's `reported`), and the
run lock.

```
feeds/run/run-feeds --dry-run              # each feed, its sources by kind, the paths
feeds/run/run-feeds                        # each feed since its last run
feeds/run/run-feeds --since 2026-09-14     # every feed from one date
```

`FEEDS_TRIAGE_MODEL`, `FEEDS_EXTRACT_MODEL`, `FEEDS_LIST_MODEL` override
the models. Log lines start with `feeds` and carry `feed=<id>`. The run
exits 0 when every feed ran and 1 when any failed; each feed runs on its
own.

Tests: `python3 -m pytest feeds/test`.
