Contribute to Hunter's Daily Brief for {{DATE}}. The last brief he read was
dated {{CURSOR}}; report what changed since then. Read
{{ROOT}}/daily-brief/contribution-contract.md and follow it. Write your
packet to {{CONTRIBUTIONS}}/{{DATE}}/{{DOMAIN}}.yaml.

This is a non-interactive scheduled run. Do not ask anything, do not open a
browser, do not wait for input. Read the contract in full before you write,
including the per-domain scope for {{DOMAIN}}; the packet's `kind` values,
header fields, and `since: {{CURSOR}}` come from it. The run started at {{NOW}}; `generated_at` is the real clock time when you write, not a guess, and `data_as_of` is your source's real freshness. You are read-only toward
this repository: do not edit, commit, run scans, refresh data, or create
records. If a source you need cannot be read, write the packet anyway with
`status: degraded` or `failed` and say so in `gaps`. Write the file and stop.
