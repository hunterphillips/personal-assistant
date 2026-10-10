// Focus curator: assembles one bounded-context prompt, makes one structured
// Claude SDK query, and hands only ops to the board store's guarded write path.
// run() always resolves with a frozen outcome; it never writes the board itself,
// loads SDK settings, enables tools, or lets a model answer bill an API key.

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { BoardError, deepFreeze } from './board.mjs';
import { RuntimeError } from '../runtime/adapter.mjs';
import { createQueryLoader, SUBSCRIPTION_SOURCES } from '../runtime/sdk.mjs';

const DAY_MS = 86_400_000;
const TRIGGERS = new Set(['scan', 'refresh', 'rejudge']);
const STDERR_TAIL = 2000;
const BOARD_PROBLEMS = { no_board: 'The board file is missing.', board_invalid: 'The board file is not valid.' };
const SYSTEM_PROMPT = 'You curate the Focus board. Answer with the ops object the schema describes and nothing else.';
const itemSchema = JSON.parse(await readFile(new URL('./item.schema.json', import.meta.url), 'utf8'));
const opsSchema = JSON.parse(await readFile(new URL('./ops.schema.json', import.meta.url), 'utf8'));

export function createCurator(deps) {
  const {
    board, rules, vault, profile, settings, systemSettings, zone, limits, timeouts,
    cwd, log: rawLog = () => {}, now = () => new Date(),
  } = deps;
  const disabled = deps.query === null;
  const loader = disabled ? null : createQueryLoader({ query: deps.query, ...(deps.importSdk ? { importSdk: deps.importSdk } : {}) });
  const log = (entry) => { try { rawLog(entry); } catch {} };

  async function run({ trigger, source = null, candidates = [], others = [], signal = null }) {
    const runId = randomUUID();
    let pruned;
    let usage;
    let abortDetail = null;
    const stderr = [];
    const logError = (error) => log({
      event: 'focus_curate_error', run: runId, trigger, error, stderr: stderr.join('').slice(-STDERR_TAIL),
    });
    const outcome = (value, fields = {}) => {
      const answer = shapedOutcome(value, { run: runId, ...fields });
      log({
        event: 'focus_curate', run: runId, trigger, ...(source == null ? {} : { source }), outcome: value,
        ...pick(answer, ['counts', 'pruned', 'usage']),
      });
      return answer;
    };
    if (!TRIGGERS.has(trigger)) return outcome('failed', { detail: 'The curate was asked to run with an unknown trigger.' });
    try {
      const pruneResult = await board.prune({ run: runId });
      pruned = pruneResult.pruned;
      if (disabled) return outcome('failed', { detail: 'Model calls are off while an API key is in the daemon\'s environment.', pruned });

      const current = await board.read();
      if (!current.board) return outcome('failed', { detail: boardProblem(current), pruned });
      const basis = current.board.updated;
      const rulebook = await readRules(rules, limits.briefInstructionsBytes);
      const at = now();
      const [priorities, projectState, person, corrections] = await Promise.all([
        Promise.resolve(vault.readPriorities()),
        Promise.resolve(vault.readProjectState(at)),
        Promise.resolve(profile.read()),
        board.corrections({ since: new Date(at.getTime() - 14 * DAY_MS), limit: 10 }),
      ]);
      const prompt = buildPrompt({
        rulebook, at, zone, priorities, projectState, profile: person,
        current: current.board, trigger, source, candidates, others, corrections,
      });
      const controller = new AbortController();
      const onAbort = () => {
        abortDetail = 'The run was stopped.';
        controller.abort(signal?.reason);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => {
        abortDetail = 'The curator timed out.';
        controller.abort();
      }, timeouts.focusCurateMs);
      let result = null;
      try {
        const query = await loader.ensureQuery();
        const options = queryOptions({ controller, stderr, cwd, settings, systemSettings });
        for await (const message of query({ prompt, options })) {
          if (message?.type === 'system' && message.subtype === 'init') {
            const keySource = message.apiKeySource;
            if (typeof keySource === 'string' && !SUBSCRIPTION_SOURCES.has(keySource)) {
              abortDetail = 'This call would bill an API key.';
              controller.abort();
              break;
            }
          }
          if (message?.type === 'result') result = message;
        }
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      if (abortDetail) return outcome('failed', { detail: abortDetail, pruned, usage });
      if (!result) {
        logError('The curator did not return a result.');
        return outcome('failed', { detail: 'The curator did not return a result.', pruned });
      }
      usage = usageOf(result);
      if (result.is_error || result.subtype !== 'success') {
        return outcome('failed', { detail: resultProblem(result), pruned, usage });
      }
      let ops;
      try { ops = opsFrom(result.structured_output); } catch (error) {
        return outcome('failed', { detail: error.message, pruned, usage });
      }
      try {
        const written = await board.curate({ ops, run: runId, basis });
        const changed = written.counts.added + written.counts.changed + written.counts.expired;
        return outcome(changed === 0 ? 'no change' : 'wrote', { counts: written.counts, pruned, usage });
      } catch (error) {
        if (error instanceof BoardError && error.code === 'rejected') return outcome('rejected', { detail: error.detail, pruned, usage });
        if (error instanceof BoardError && error.code === 'stale') return outcome('skipped', { detail: 'The board changed during the call.', pruned, usage });
        throw error;
      }
    } catch (error) {
      logError(error?.message ?? String(error));
      return outcome('failed', { detail: abortDetail ?? sentence(error), ...(pruned === undefined ? {} : { pruned }), ...(usage ? { usage } : {}) });
    }
  }

  return Object.freeze({ run });
}

function queryOptions({ controller, stderr, cwd, settings, systemSettings }) {
  const focusModel = settings.current().model;
  const systemCurrent = systemSettings?.current?.() ?? null;
  // The Focus model and effort each fall back to the system's independently, on purpose.
  const systemModel = systemCurrent?.settings?.model ?? {};
  const model = focusModel.id ?? systemModel.default ?? null;
  const effort = focusModel.effort ?? systemModel.effort ?? null;
  return {
    outputFormat: { type: 'json_schema', schema: opsSchema },
    tools: [], settingSources: [], permissionMode: 'dontAsk', persistSession: false,
    maxTurns: 3, cwd, systemPrompt: SYSTEM_PROMPT, abortController: controller,
    stderr: (text) => stderr.push(String(text)),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

async function readRules(file, maxBytes) {
  let info;
  try { info = await stat(file); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw new Error('The Focus rules file is missing.');
    throw error;
  }
  if (!info.isFile()) throw new Error('The Focus rules path is not a regular file.');
  if (info.size > maxBytes) throw new Error('The Focus rules file is too large.');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > maxBytes) throw new Error('The Focus rules file is too large.');
  if (!text.trim()) throw new Error('The Focus rules file is empty.');
  return text;
}

function buildPrompt({ rulebook, at, zone, priorities, projectState, profile, current, trigger, source, candidates, others, corrections }) {
  const local = at.toLocaleString('en-US', { timeZone: zone, timeZoneName: 'short' });
  const sections = [
    rulebook, '', '=== CURRENT TIME ===', `${at.toISOString()} (${local}, ${zone})`, '',
    ...(priorities ? ["=== STANDING PRIORITIES (the user's own living notes) ===", priorities, ''] : []),
    ...(projectState ? ['=== PROJECT STATE (vault: what is actually done) ===', projectState, ''] : []),
    ...(profile ? ['=== WHO THE USER IS (personal-context; background only — see rulebook §2) ===', profile, ''] : []),
    '=== ITEM SCHEMA (shape of every item on the board) ===', JSON.stringify(itemSchema, null, 2), '',
    '=== YOUR ANSWER (ops) ===', JSON.stringify(opsSchema, null, 2), '',
    ...renderDocument(current), '',
  ];
  if (trigger === 'rejudge') {
    sections.push('=== REJUDGE ===', 'No new candidates. Re-judge every open item in the current document against the rules as if it had just arrived, using the latest candidates from every source below as evidence. Expire what the rules would not create today, close as done what is evidenced finished, retier what is misplaced.', '');
  } else if (trigger === 'scan') {
    sections.push(`=== CANDIDATES (source: ${source}) ===`, JSON.stringify(candidates, null, 2), '');
  } else {
    for (const group of candidates.filter(hasCandidates)) sections.push(`=== CANDIDATES (source: ${group.source}) ===`, JSON.stringify(group.candidates, null, 2), '');
  }
  const latest = others.filter(hasCandidates);
  sections.push(
    '=== LATEST CANDIDATES FROM THE OTHER SOURCES (each from its own last scan) ===',
    ...(latest.length ? latest.flatMap((group) => [
      `--- ${group.source} (scanned ${group.scanned}) ---`, JSON.stringify(group.candidates, null, 2),
    ]) : ['(none)']),
    '', '=== RECENT USER CORRECTIONS (newest first, last 14 days) ===',
    corrections.length ? corrections.join('\n') : '(none)', '',
    '=== YOUR OUTPUT ===', 'A JSON object with an `ops` array, nothing else. Empty `ops` when the board should not change.',
  );
  return sections.join('\n');
}

function hasCandidates(group) { return Array.isArray(group?.candidates); }

function renderDocument(current) {
  const open = current.items.filter((item) => item.status === 'open');
  const closed = current.items.filter((item) => item.status !== 'open');
  return [
    '=== CURRENT DOCUMENT: OPEN ITEMS (the board, in full) ===', JSON.stringify(open, null, 2), '',
    '=== CLOSED ITEMS (tombstones: off the board, listed so you do not re-add them; an `expired` one you may reopen) ===',
    closed.length ? closed.map(tombstoneLine).join('\n') : '(none)',
  ];
}

function tombstoneLine(item) {
  return JSON.stringify({
    id: item.id, title: item.title, source: item.source, external_id: item.external_id ?? null,
    status: item.status, updated: item.updated, meta: item.meta ?? null,
  });
}

function opsFrom(raw) {
  let answer = raw;
  if (typeof answer === 'string') {
    try { answer = JSON.parse(answer); } catch { throw new Error('The curator answered without an ops array.'); }
  }
  if (Array.isArray(answer)) return answer;
  if (answer && typeof answer === 'object') {
    if (Array.isArray(answer.ops)) return answer.ops;
    if (Array.isArray(answer.items)) throw new Error('The curator answered with a document; ops were expected.');
  }
  throw new Error('The curator answered without an ops array.');
}

function usageOf(result) {
  if (!result.usage) return undefined;
  return deepFreeze({ input: result.usage.input_tokens, output: result.usage.output_tokens, costUsd: result.total_cost_usd });
}

function resultProblem(result) {
  const errors = Array.isArray(result.errors) ? result.errors.filter((value) => typeof value === 'string' && value.trim()) : [];
  if (errors.length) return errors.join('; ');
  if (typeof result.result === 'string' && result.result.trim()) return result.result.trim();
  return String(result.subtype ?? 'The curator call failed.');
}

function boardProblem(result) {
  if (result.problem) return result.problem;
  return BOARD_PROBLEMS.no_board;
}

function sentence(error) {
  if (error instanceof BoardError && Object.hasOwn(BOARD_PROBLEMS, error.code)) return BOARD_PROBLEMS[error.code];
  if (error instanceof RuntimeError && error.code === 'sdk_unavailable') return 'The Claude Agent SDK could not be loaded.';
  const message = error?.message ?? String(error);
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function shapedOutcome(value, fields = {}) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
  return deepFreeze({ outcome: value, ...clean });
}
