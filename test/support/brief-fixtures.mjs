import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.resolve(fileURLToPath(new URL('../fixtures/', import.meta.url)));

export async function fixture(name) {
  return readFile(path.join(FIXTURES, name), 'utf8');
}

export function viewerHtml({ date, items, key = `db-items-${date}`, extraScript = '', controls = true }) {
  const controlsHtml = controls ? `
<div id="brief"></div>
<textarea id="overall"></textarea>
<span id="status"></span>
<button class="save" onclick="saveOut()">Save</button>
<button onclick="copyOut()">Copy</button>
<button onclick="clearAll()">Clear</button>` : '<div>incompatible invented viewer</div>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>.lede{font-weight:600}</style></head>
<body>${controlsHtml}
<script>
const ITEMS = ${JSON.stringify(items)};
const KEY = '${key}';
let fb = {};
function saveOut() {}
function copyOut() {}
function clearAll() { fb = {}; }
${extraScript}
</script>
</body>
</html>
`;
}

export async function writeViewer(dir, date, options = {}) {
  const items = options.items ?? [{ sec: 'Invented', id: 'one', text: 'Invented item.' }];
  const html = options.html ?? viewerHtml({ date, items, key: options.key ?? `db-items-${date}`, ...options });
  const file = path.join(dir, `viewer-${date}.html`);
  await writeFile(file, html);
  return { file, html, items };
}
