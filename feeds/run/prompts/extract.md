Call `get_thread` on thread `{{THREAD_ID}}` (subject: {{SUBJECT}}, from
{{SENDER}}). It is one issue of a newsletter.

List every distinct story or link the issue presents to its readers. For
each: the story's own title (not the newsletter's section heading), its
URL (the link the issue gives; the canonical article URL if the issue
wraps it, otherwise the link as given), and one sentence saying what it is,
in the issue's own words where possible. `source` is the newsletter's name:
Latent Space, AINews, Axios Nashville, Hacker Newsletter, or Simon
Willison's newsletter. `issue_date` is the issue's date.

Skip sponsor and advertising slots, job listings, subscribe, unsubscribe,
share, and footer links, the newsletter's own housekeeping, and a welcome
or confirmation email (return no stories for those). Do not judge
relevance; a separate step does that. Do not invent stories that the issue
does not contain.
