import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePlistInputs } from './launchd.mjs';

const TEMPLATE_PATH = fileURLToPath(
  new URL('../systemd/com.personal-assistant.dashboard.service.template', import.meta.url),
);
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
// A control character would end a directive and start another; a backslash
// in an unquoted path could continue the line.
const UNIT_INVALID = /[\u0000-\u001F\u007F]/;
const PATH_NAMES = new Set(['nodePath', 'appDir', 'home', 'briefsDir']);
// The data root a unit names when the installer exports none: the one
// dashboard-start resolves from HOME, written with systemd's home specifier.
const DEFAULT_DATA_ROOT = '%h/.personal-assistant';

// The same inputs and refusals as the plist (validatePlistInputs), plus the
// characters a unit file cannot carry.
export function validateUnitInputs(input) {
  const problems = [];
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    if (UNIT_INVALID.test(value)) problems.push(`${name} contains characters that cannot appear in a unit`);
    else if (PATH_NAMES.has(name) && value.includes('\\')) problems.push(`${name} must not contain a backslash`);
  }
  if (problems.length > 0) throw new TypeError(problems.join('; '));
  return validatePlistInputs(input);
}

export function renderUnit(input) {
  const values = validateUnitInputs(input);
  const replacements = {
    START_PATH: quoteArgument(path.join(values.appDir, 'bin', 'dashboard-start')),
    NODE_PATH: quoteArgument(values.nodePath),
    APP_DIR: escapeSpecifiers(values.appDir),
    PATH_ENTRY: quoteAssignment('PATH', `${path.dirname(values.nodePath)}:/usr/local/bin:/usr/bin:/bin`),
    PORT: String(values.port),
    HOME_ENTRY: environmentEntry('PERSONAL_ASSISTANT_HOME', values.exportHome ? values.home : undefined),
    PUBLIC_ORIGIN_ENTRY: environmentEntry('DASHBOARD_PUBLIC_ORIGIN', values.publicOrigin),
    BRIEFS_DIR_ENTRY: environmentEntry('DASHBOARD_BRIEFS_DIR', values.briefsDir),
    FOCUS_ORIGIN_ENTRY: environmentEntry('DASHBOARD_FOCUS_ORIGIN', values.focusOrigin),
    DATA_ROOT: values.exportHome ? escapeSpecifiers(values.home) : DEFAULT_DATA_ROOT,
  };

  let rendered = TEMPLATE;
  for (const [name, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{{${name}}}`, () => value);
  }
  if (/{{[A-Z0-9_]+}}/.test(rendered)) {
    throw new Error('unit template contains an unresolved placeholder');
  }
  return rendered;
}

function environmentEntry(name, value) {
  if (value === undefined) return '';
  return `Environment=${quoteAssignment(name, value)}\n`;
}

// Environment= splits on spaces outside quotes and expands % specifiers.
function quoteAssignment(name, value) {
  return `"${escapeQuoted(`${name}=${value}`)}"`;
}

// ExecStart= also expands $VARIABLES.
function quoteArgument(value) {
  return `"${escapeQuoted(value).replaceAll('$', '$$$$')}"`;
}

function escapeQuoted(value) {
  return escapeSpecifiers(value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'));
}

function escapeSpecifiers(value) {
  return value.replaceAll('%', '%%');
}
