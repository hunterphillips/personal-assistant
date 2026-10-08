Call your Gmail search tool now with exactly this query, one page of up to
40 results:

```
{{QUERY}}
```

Return every thread it finds: the thread id, sender address, subject, and
the date of its latest message. Do not open any thread, do not filter, do
not add queries.

If the tool call fails, is denied, or is unavailable, put the exact error
text in `error` and return no threads. If the search genuinely returns no
threads, `error` is null. Never return an empty list without saying which
of those it was.
