Write Hunter's daily brief for {{DATE}}. This is a non-interactive
scheduled run in {{ROOT}}: do not ask anything.

The inputs are in {{CONTRIBUTIONS}}/{{DATE}}/: what his systems
reported this morning. `cfo.yaml` is his finances, `focus.yaml` his task
board, `second-brain.yaml` his personal notes, `calendar.yaml` his calendar,
`watch.yaml` a newsletter digest checked daily (most days absent), `run.yaml` a
note from the process that gathered the inputs. The last brief he read was
{{CURSOR}}; the previous memos are {{PREVIOUS_MEMOS}}.

He reads the brief once, in the morning, on his phone or a screen. Write
it the way a sharp assistant who read everything would: one page, plain
words, times and dates up front, bullets where they help and prose where
they don't, headings of your choosing. Read daily-brief/curator.md for the
few rules that hold, then write {{BRIEFS}}/memo-{{DATE}}.md as
markdown with `## ` headings. Then build and check:

    python3 daily-brief/briefs/build.py {{DATE}} --dir {{BRIEFS}}
    node daily-brief/briefs/check-viewer.mjs {{DATE}} --dir {{BRIEFS}}

If either fails, fix the memo and run both again. Touch no other file. When
both pass, stop.
