// Feed instructions: the criteria file the watch job reads
// (config.feedInstructionsPath, by default daily-brief/watch/relevance.md),
// read on demand for the Feed view as prose through instructions.mjs.
//
// createFeedInstructions({ file, limits, log }) returns { read }, as
// createInstructions does, with `path` INSTRUCTIONS_PATH, the cap
// limits.feedInstructionsBytes, the sentences naming "The feed
// instructions file", and read failures logged as
// feed_instructions_read_error.

import { createInstructions } from './instructions.mjs';

export const INSTRUCTIONS_PATH = 'daily-brief/watch/relevance.md';

export function createFeedInstructions({ file, limits, log }) {
  return createInstructions({
    file, path: INSTRUCTIONS_PATH, maxBytes: limits.feedInstructionsBytes, label: 'feed', event: 'feed_instructions_read_error', log,
  });
}
