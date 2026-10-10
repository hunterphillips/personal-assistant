// Focus candidates files: validates scanner output and reads or atomically
// writes one source's { scanned, signature, candidates } document. Reads return
// a frozen document or null and never throw; this module never runs a scan.
// ScanError is what a scan throws, and checkedCandidates is the gate every
// scan's output passes before it is returned.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { atomicJson, deepFreeze } from './board.mjs';
import { SCAN_SOURCES } from './validate.mjs';

export class ScanError extends Error {
  constructor(code, detail = undefined) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ScanError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

// Returns the list unchanged when it is valid; throws
// ScanError('invalid_candidates') with the problems otherwise.
export function checkedCandidates(list, limits) {
  const problems = validateCandidates(list, limits);
  if (problems.length > 0) throw new ScanError('invalid_candidates', problems.join('; '));
  return list;
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
      candidates: document.candidates,
    }));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function writeCandidatesFile(file, { scanned, signature, candidates }) {
  await atomicJson(file, { scanned, signature, candidates });
}

function validDocument(document, limits) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return false;
  if (typeof document.scanned !== 'string' || document.scanned.length === 0) return false;
  if (typeof document.signature !== 'string' || document.signature.length === 0) return false;
  return validateCandidates(document.candidates, limits).length === 0;
}
