// Focus candidates files: validates scanner output and reads or atomically
// writes one source's { scanned, signature, candidates } document. Reads return
// a frozen document or null and never throw; this module never runs a scan.

import { readFile, stat } from 'node:fs/promises';

import { atomicJson } from './board.mjs';
import { SCAN_SOURCES } from './validate.mjs';

const SHA256 = /^[a-f0-9]{64}$/;

export function validateCandidates(list, limits) {
  if (!Array.isArray(list)) return Object.freeze(['not an array']);
  const problems = [];
  if (list.length > limits.focusCandidatesMax) {
    problems.push(`at most ${limits.focusCandidatesMax} candidates`);
  }
  list.forEach((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
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
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > limits.focusCandidateBytes) return null;
    const raw = await readFile(file);
    if (raw.byteLength > limits.focusCandidateBytes) return null;
    const document = JSON.parse(raw.toString('utf8'));
    if (!validDocument(document, limits)) return null;
    return deepFreeze(structuredClone(document));
  } catch {
    return null;
  }
}

export async function writeCandidatesFile(file, { scanned, signature, candidates }) {
  await atomicJson(file, { scanned, signature, candidates });
}

function validDocument(document, limits) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return false;
  if (Object.keys(document).some((key) => !['scanned', 'signature', 'candidates'].includes(key))) return false;
  if (typeof document.scanned !== 'string' || Number.isNaN(Date.parse(document.scanned))) return false;
  if (typeof document.signature !== 'string' || !SHA256.test(document.signature)) return false;
  return validateCandidates(document.candidates, limits).length === 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
