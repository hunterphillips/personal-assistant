All data in this folder is invented for tests.

`runs/` holds the job runner's run logs. Their timestamps count from
2000-01-01T00:00:00.000Z as the moment the test starts: the browser fixture
server moves every `startedAt`, `endedAt`, and `occurrence` forward by the
time since then, so `1999-12-31T23:52:00.000Z` reads as eight minutes ago.
`settings.json` is a copy of the repo's `defaults/focus-settings.json`.
