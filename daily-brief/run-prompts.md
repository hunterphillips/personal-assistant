# Daily Brief — contribution prompt

The scheduled run (`bin/run-brief`, see the plan of 2026-09-27) renders the
prompts in `bin/prompts/` with the day's dates and starts one session per
domain itself. What follows is the same prompt for a run by hand.

One prompt, identical for every domain. Paste it into a session opened in the
domain's own repo. The contract carries every rule, including per-domain scope.
Change both dates: the run date, and the cursor, which is the date of the last
brief Hunter read.

```
Contribute to Hunter's Daily Brief for 2026-09-25. The last brief he read was
dated 2026-09-23; report what changed since then. Read
~/workspace/personal-assistant/daily-brief/contribution-contract.md and follow
it. Write your packet to
~/workspace/personal-assistant/daily-brief/contributions/2026-09-25/<domain>.yaml
where <domain> is cfo, focus, or second-brain.
```

Work needs no prompt; the curator reads that day's `catchup` brief directly.

Calendar: the scheduled run writes `calendar.yaml` from `bin/prompts/calendar.md`;
in a hand run the curator reads the calendars directly.

Watch has no pipeline yet. Until it does, the curator writes the watch packet
by hand once a week from the four sources, against `watch/relevance.md`, or
skips it.
