// Invented briefs for the tests. test/fixtures/brief/brief-2026-09-15.json is
// one brief in the shape build.py writes, labelled invented in its title;
// briefData() builds others. Nothing here reads the real briefs directory.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(fileURLToPath(new URL('../fixtures/', import.meta.url)));
export const FIXTURE_DATE = '2026-09-15';

export async function fixture(name) {
  return readFile(path.join(FIXTURES, name), 'utf8');
}

// The fixture brief, with its date (and anything else) replaced.
export async function fixtureBrief(date = FIXTURE_DATE, overrides = {}) {
  const value = JSON.parse(await fixture(`brief/brief-${FIXTURE_DATE}.json`));
  return { ...value, date, ...overrides };
}

// A small invented brief: one section per entry of `sections`, each a list
// of item texts.
export function briefData(date, { title = `Invented brief ${date}`, opening = 'Invented opening.', sections = { Invented: ['Invented item.'] } } = {}) {
  return {
    date,
    title,
    words: 3,
    opening: opening === null ? null : { id: 'opening', text: opening },
    sections: Object.entries(sections).map(([label, texts]) => {
      const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return { id, label, items: texts.map((text, index) => ({ id: `${id}-${index + 1}`, text })) };
    }),
  };
}

export async function writeBrief(dir, date, value) {
  const data = value ?? await fixtureBrief(date);
  const text = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
  const file = path.join(dir, `brief-${date}.json`);
  await writeFile(file, text);
  return { file, text, data };
}

// A viewer page the run keeps for the record; the dashboard only notices
// its date.
export async function writeViewer(dir, date) {
  const file = path.join(dir, `viewer-${date}.html`);
  await writeFile(file, '<!doctype html><title>Invented viewer</title>\n');
  return file;
}
