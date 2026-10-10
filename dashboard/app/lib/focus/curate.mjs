// Focus curator: assembles one bounded-context prompt, makes one structured
// Claude SDK query, and hands only ops to the board store's guarded write path.
// run() always resolves with a frozen outcome; it never writes the board itself,
// loads SDK settings, enables tools, or lets a model answer bill an API key.

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { BoardError, deepFreeze } from './board.mjs';
import { createQueryLoader, SUBSCRIPTION_SOURCES } from '../runtime/sdk.mjs';

const DAY_MS = 86_400_000;
const SYSTEM_PROMPT = 'You curate the Focus board. Answer with the ops object the schema describes and nothing else.';
const itemSchema = JSON.parse(await readFile(new URL('./item.schema.json', import.meta.url), 'utf8'));
const opsSchema = JSON.parse(await readFile(new URL('./ops.schema.json', import.meta.url), 'utf8'));

export function createCurator(deps) {
  const {
    board, rules, vault, profile, settings, systemSettings, zone, limits, timeouts,
    cwd, log: rawLog = () => {}, now = () => new Date(),
  } = deps;
  const disabled = deps.query === null;
  const loader = disabled ? null : createQueryLoader({ query: deps.query });
  const log = (entry) => { try { rawLog(entry); } catch {} };

  async function run({ trigger, source = null, candidates = [], others = [], signal = null }) {
    const runId = randomUUID();
    let pruned;
    let usage;
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
      let abortDetail = null;
      const onAbort = () => {
        abortDetail = signal?.reason instanceof Error ? signal.reason.message : 'The curate call was aborted.';
        controller.abort(signal?.reason);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => {
        abortDetail = 'The curator timed out.';
        controller.abort();
      }, timeouts.focusCurateMs);
      const stderr = [];
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
      if (!result) return outcome('failed', { detail: 'The curator did not return a result.', pruned });
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
        if (error instanceof BoardError && ['no_board', 'board_invalid'].includes(error.code)) {
          return outcome('failed', { detail: error.code === 'no_board' ? 'The Focus board is missing.' : 'The Focus board is invalid.', pruned, usage });
        }
        throw error;
      }
    } catch (error) {
      log({ event: 'focus_curate_error', error: error?.message ?? String(error) });
      return outcome('failed', { detail: sentence(error), ...(pruned === undefined ? {} : { pruned }), ...(usage ? { usage } : {}) });
    }
  }

  return Object.freeze({ run });
}

function queryOptions({ controller, stderr, cwd, settings, systemSettings }) {
  const focusModel = settings.current().model;
  const systemCurrent = systemSettings?.current?.() ?? null;
  const systemModel = systemCurrent?.settings?.model ?? systemCurrent?.model ?? {};
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
  const info = await stat(file);
  if (!info.isFile()) throw new Error('The Focus rules path is not a regular file.');
  if (info.size > maxBytes) throw new Error('The Focus rules file is too large.');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > maxBytes) throw new Error('The Focus rules file is too large.');
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
    for (const group of candidates) sections.push(`=== CANDIDATES (source: ${group.source}) ===`, JSON.stringify(group.candidates, null, 2), '');
  }
  sections.push(
    '=== LATEST CANDIDATES FROM THE OTHER SOURCES (each from its own last scan) ===',
    ...(others.length ? others.flatMap((group) => [
      `--- ${group.source} (scanned ${group.scanned}) ---`, JSON.stringify(group.candidates, null, 2),
    ]) : ['(none)']),
    '', '=== RECENT USER CORRECTIONS (newest first, last 14 days) ===',
    corrections.length ? corrections.join('\n') : '(none)', '',
    '=== YOUR OUTPUT ===', 'A JSON object with an `ops` array, nothing else. Empty `ops` when the board should not change.',
  );
  return sections.join('\n');
}

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

function opsFrom(answer) {
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
  return 'The Focus board is missing.';
}

function sentence(error) {
  const message = error?.message ?? String(error);
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function outcome(value, fields = {}) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));
  return deepFreeze({ outcome: value, ...clean });
}
