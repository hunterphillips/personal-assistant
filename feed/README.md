# Feed

The store behind the dashboard's Feed: what the assistant's producers found
and judged worth a look, kept for browsing rather than pushed. The dashboard
reads it; producers write it; nothing edits it.

## Files

`items/<date>-<producer>.json`, one file per producer run, local and
gitignored (the items are summaries of outside content with Hunter's
relevance verdicts). The store is append-only: a run that already has a
file leaves it alone, so an item's id keeps pointing at the same story. To
redo a run, delete its file first.

```json
{ "producer": "watch", "date": "2026-09-28", "since": "2026-09-14",
  "generated_at": "2026-09-28T14:47:22-05:00",
  "items": [
    { "id": "watch/2026-09-28/1",
      "title": "Top AI companies hiring lobbyists in Tennessee",
      "source": "Axios Nashville", "url": "https://example.com/story",
      "test": 5,
      "summary": "Axios Nashville, citing the Tennessee Lookout, reports that ...",
      "kept": true } ] }
```

- `id` is `<producer>/<date>/<n>`, unique across the store.
- `title`, `source`, `url`, `summary` are required and non-empty; `url` is
  `http` or `https`.
- `kept` is true for an item the producer also handed to the Daily Brief.
- `test` is the producer's relevance criterion number, or null. Not shown.
- `image`, optional, is an absolute `http` or `https` URL of the story's
  picture. The reader sets anything else to null and still shows the item.
  `bin/enrich` fills it after a run, from the story page's `og:image`,
  `twitter:image`, or `image_src`; an item it finds nothing for is left
  without the key.
- `since` is the window the run covered, when the producer has one.

## Producers

- `watch` (`daily-brief/watch/render.py`, daily): the newsletter
  survivors first, then the overflow that passed a test but not the cap.
  Criteria in `daily-brief/watch/relevance.md`.

The dashboard reads the newest 30 files by name; the reader and its limits
are in `dashboard/app/lib/feed.mjs`.
