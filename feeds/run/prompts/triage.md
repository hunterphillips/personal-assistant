You are deciding which stories since {{SINCE}} become posts in the
{{FEED}} feed. Apply the rules and the feed's note below exactly.

## The rules every feed shares

{{RULES}}

## The feed's note

{{NOTE}}

## Context

What stays true about the reader, from the feed's context sources. Use
it to judge what a story would change; never quote it back.

{{CONTEXT}}

## The feed's sources

Each story names its source by id. Use these ids in `sources`.

{{SOURCES}}

## Already shown in this feed in the last fourteen days

{{SEEN}}

## Stories since {{SINCE}}

Extracted from the issues and entries since {{SINCE}}. The same story
often appears in several sources; collapse it to one post and name every
source.

{{STORIES}}

## Output

`items`: the posts that pass, ranked, within the note's cap and never
more than five. For each: `sources` is the ids of every source that ran
the story. `headline` is the sentence the Daily Brief prints, written for
a reader who has not seen the story: it names the source, says what
happened in plain words, and, in a second sentence at most, states the
fact that made it pass: what it changes, in the world. `takeaway` is one
plain sentence, at most 240 characters, saying what the reader takes away.
`insights` is a few short paragraphs of Markdown, at most 2000
characters: what the story says, and why it bears on the note and the
context. Never advice and never a suggestion: no "worth raising", "you
should", "you could", and no "you" in `headline` or `takeaway`. No hype,
no "notably".

`overflow`: stories that pass but miss the cap, or that pass narrowly.
They are shown in the feed, so `summary` is written the way a headline is:
for a reader who has not seen the story, naming the source, in the story's
own terms, with no advice and no "you". `takeaway` and `insights` as for
items. Never a note about how narrowly it passed.

`considered`: how many distinct stories you judged after collapsing
duplicates. `duplicates_collapsed`: how many were merged into another.

Be strict. A launch, a demo, a benchmark, a funding round, a take, or a
story that only sounds related fails unless the note says otherwise. When
in doubt it fails.
