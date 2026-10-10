// Focus candidates files: validates scanner output and reads or atomically
// writes one source's { scanned, signature, curated, candidates } document;
// signature (candidates and board placement) and curated (candidates alone, as
// last placed by a curate) are null until that source has first been curated,
// and a file without curated reads it as null. Reads return
// a frozen document or null and never throw; writes refuse a document that
// would read back as null. This module never runs a scan. ScanError is what a
// scan throws, and checkedCandidates is the gate every scan's output passes
// before it is returned.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { atomicText, deepFreeze } from './board.mjs';
import { SCAN_SOURCES } from './validate.mjs';

export class ScanError extends Error {
  constructor(code, detail = undefined) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ScanError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// Returns the list deep-frozen when it is valid; throws
// ScanError('invalid_candidates') with the problems otherwise.
export function checkedCandidates(list, limits) {
  const problems = validateCandidates(list, limits);
  if (problems.length > 0) throw new ScanError('invalid_candidates', problems.join('; '));
  return deepFreeze(list);
}

export function validateCandidates(list, limits) {
  if (!Array.isArray(list)) return Object.freeze(['not an array']);
  const problems = [];
  if (list.length > limits.focusCandidatesMax) {
    problems.push(`at most ${limits.focusCandidatesMax} candidates`);
  }
  list.forEach((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null) {
      problems.push(`[${index}] not an object`);
      return;
    }
    if (typeof candidate.title !== 'string' || candidate.title.length === 0 || candidate.title.length > 200) {
      problems.push(`[${index}] bad title`);
    }
    if (!SCAN_SOURCES.includes(candidate.source)) {
      problems.push(`[${index}] bad source ${JSON.stringify(candidate.source)}`);
    }
    if (typeof candidate.external_id !== 'string' || candidate.external_id.length === 0) {
      problems.push(`[${index}] bad external_id`);
    }
    for (const key of ['link', 'meta', 'occurs_at', 'text']) {
      if (candidate[key] !== undefined && candidate[key] !== null && typeof candidate[key] !== 'string') {
        problems.push(`[${index}] ${key} must be string or null`);
      }
    }
  });
  return Object.freeze(problems);
}

export async function readCandidatesFile(file, limits) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > limits.focusCandidateBytes) return null;
    const buffer = Buffer.alloc(limits.focusCandidateBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limits.focusCandidateBytes) return null;
    const document = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!validDocument(document, limits)) return null;
    return deepFreeze(structuredClone({
      scanned: document.scanned,
      signature: document.signature,
      curated: document.curated ?? null,
      candidates: document.candidates,
    }));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Throws ScanError('invalid_candidates') with the problems, writing nothing,
// when readCandidatesFile would read the document back as null.
export async function writeCandidatesFile(file, { scanned, signature, curated = null, candidates }, limits) {
  const document = { scanned, signature, curated, candidates };
  const problems = documentProblems(document, limits);
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (problems.length === 0 && Buffer.byteLength(text) > limits.focusCandidateBytes) {
    problems.push(`over ${limits.focusCandidateBytes} bytes`);
  }
  if (problems.length > 0) throw new ScanError('invalid_candidates', problems.join('; '));
  await atomicText(file, text);
}

function validDocument(document, limits) {
  return documentProblems(document, limits).length === 0;
}

function documentProblems(document, limits) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return ['not an object'];
  const problems = [];
  if (typeof document.scanned !== 'string' || document.scanned.length === 0) problems.push('bad scanned');
  if (document.signature !== null && (typeof document.signature !== 'string' || document.signature.length === 0)) problems.push('bad signature');
  if (document.curated != null && (typeof document.curated !== 'string' || document.curated.length === 0)) problems.push('bad curated');
  problems.push(...validateCandidates(document.candidates, limits));
  return problems;
}
