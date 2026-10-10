// Focus jobs: registers four mechanical scans and one curator with the generic
// in-process runner. It owns Focus's quiet-hours and pause policy, candidate
// signatures, scan error sentences, and refresh/catch-up fan-in. It returns a
// refresh function and never schedules work outside the runner.

import path from 'node:path';

import { readCandidatesFile, ScanError, writeCandidatesFile } from './candidates.mjs';
import { signature as candidateSignature } from './signature.mjs';
import { wallClock } from '../schedule.mjs';

const SOURCES = Object.freeze(['calendar', 'gmail', 'git', 'notes']);
const LABELS = Object.freeze({
  calendar: 'focus.scan-calendar', gmail: 'focus.scan-gmail', git: 'focus.scan-git', notes: 'focus.scan-notes', rejudge: 'focus.curate',
});
const NAMES = Object.freeze({ calendar: 'Calendar scan', gmail: 'Gmail scan', git: 'GitHub scan', notes: 'Notes scan' });
const SCAN_DETAILS = Object.freeze({
  google_signed_out: 'Sign in to Google first.', google_reauth: 'Sign in to Google again.', google_failed: 'Google did not answer.',
  gh_failed: 'GitHub could not be read.', vault_unavailable: 'The vault folder is not available.',
  invalid_candidates: 'The scan produced candidates the board cannot take.',
});

export function createFocusJobs({ runner, board, settings, scans, curator, candidatesDir, zone, limits, timeouts, log = () => {}, now = () => new Date() }) {
  const fileFor = (source) => path.join(candidatesDir, `${source}.json`);
  const allowed = (at, trigger) => {
    if (trigger === 'refresh') return true;
    const hour = wallClock(dateOf(at), zone).hour;
    return hour >= 5 && hour < 22;
  };

  async function candidateFiles() {
    return Object.fromEntries(await Promise.all(SOURCES.map(async (source) => [source, await readCandidatesFile(fileFor(source), limits)])));
  }

  async function runScan(source, trigger, _context, { signal, enqueue }) {
    try {
      const candidates = await scans[source]({ signal, limits, log, now: () => dateOf(now()).getTime() });
      const current = await board.read();
      const nextSignature = candidateSignature(candidates, current.board);
      const previous = await readCandidatesFile(fileFor(source), limits);
      const changed = previous?.signature !== nextSignature;
      await writeCandidatesFile(fileFor(source), {
        scanned: dateOf(now()).toISOString(), signature: changed ? (previous?.signature ?? null) : nextSignature, candidates,
      }, limits);
      if (changed && trigger === 'schedule' && !settings.current().paused) {
        await enqueue(LABELS.rejudge, 'scan', { source, signature: nextSignature });
      }
      return Object.freeze({
        outcome: changed ? 'wrote' : 'no change', candidates: candidates.length,
        ...(['refresh', 'catchup'].includes(trigger) ? { changed, signature: nextSignature } : {}),
      });
    } catch (error) {
      const detail = error instanceof ScanError ? (SCAN_DETAILS[error.code] ?? error.message) : (error?.message ?? String(error));
      return Object.freeze({ outcome: 'failed', detail, ...(['refresh', 'catchup'].includes(trigger) ? { changed: false } : {}) });
    }
  }

  async function runCurate(trigger, context = {}, { signal }) {
    const files = await candidateFiles();
    let covered = [];
    let source = null;
    if (trigger === 'scan' && SOURCES.includes(context?.source)) {
      covered = [{ source: context.source, signature: context.signature }];
      source = context.source;
    } else if (trigger === 'refresh' || trigger === 'catchup') {
      covered = Array.isArray(context?.sources) ? context.sources.filter((entry) => SOURCES.includes(entry?.source)) : [];
    }
    const coveredSet = new Set(covered.map((entry) => entry.source));
    const group = (id) => files[id] ? { source: id, scanned: files[id].scanned, candidates: files[id].candidates } : null;
    const candidates = trigger === 'rejudge' ? []
      : trigger === 'scan' ? (files[source]?.candidates ?? [])
        : covered.map(({ source: id }) => group(id)).filter(Boolean);
    const others = SOURCES.filter((id) => !coveredSet.has(id)).map(group).filter(Boolean);
    const answer = await curator.run({ trigger, source, candidates, others, signal });
    // The curator saw every file that exists, as candidates or as others, so
    // each one's signature is taken again against the board the curate left;
    // the scan's own signature was taken against the board before it.
    if (answer.outcome === 'wrote' || answer.outcome === 'no change') {
      const after = (await board.read()).board;
      for (const id of SOURCES) {
        const held = files[id];
        if (!held) continue;
        await writeCandidatesFile(fileFor(id), { ...held, signature: candidateSignature(held.candidates, after) }, limits);
      }
    }
    const { run: _curatorRun, ...result } = answer;
    return Object.freeze(result);
  }

  async function onBurstEnd(results) {
    // A burst that ran the curate's own occurrence ran a rejudge after every
    // scan in it, which saw every file and advanced every signature.
    if (results.some((result) => result.label === LABELS.rejudge)) return;
    const scanResults = results.filter((result) => sourceOf(result.label));
    const refreshed = scanResults.filter((result) => result.trigger === 'refresh');
    if (refreshed.length > 0) {
      await runner.enqueue(LABELS.rejudge, 'refresh', {
        sources: refreshed.map((result) => ({ source: sourceOf(result.label), signature: result.signature })),
      });
      return;
    }
    const changed = scanResults.filter((result) => result.trigger === 'catchup' && result.changed === true);
    if (changed.length > 0) await runner.enqueue(LABELS.rejudge, 'catchup', { sources: signaturesOf(changed) });
  }

  for (const source of SOURCES) {
    runner.register(Object.freeze({
      label: LABELS[source], name: NAMES[source], cron: () => settings.current().schedules[source],
      due: allowed, paused: () => false, timeoutMs: timeouts.focusScanMs, triggerFor: (trigger) => trigger,
      run: (trigger, context, controls) => runScan(source, trigger, context, controls),
    }));
  }
  runner.register(Object.freeze({
    label: LABELS.rejudge, name: 'Curate', cron: () => settings.current().schedules.rejudge,
    due: (at, trigger) => allowed(at, trigger) && (trigger === 'refresh' || !settings.current().paused),
    paused: () => settings.current().paused, timeoutMs: timeouts.focusCurateMs, run: runCurate, onBurstEnd,
    // The curate's own occurrence, and a catch-up that carries no sources, is
    // the rejudge.
    triggerFor: (trigger, context) => (trigger === 'schedule' || (trigger === 'catchup' && !Array.isArray(context?.sources)) ? 'rejudge' : trigger),
  }));

  async function refresh() {
    const batch = SOURCES.map((source) => ({ label: LABELS[source], trigger: 'refresh', context: null }));
    return runner.enqueue(batch, 'refresh', null, { exclusive: true });
  }

  return Object.freeze({ refresh });
}

function dateOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function sourceOf(label) { return SOURCES.find((source) => LABELS[source] === label) ?? null; }
function signaturesOf(results) {
  return results.filter((result) => typeof result.signature === 'string').map((result) => ({ source: sourceOf(result.label), signature: result.signature }));
}
