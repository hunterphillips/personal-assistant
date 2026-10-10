import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_PATH = fileURLToPath(
  new URL('../launchd/com.personal-assistant.dashboard.plist.template', import.meta.url),
);
const TEMPLATE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// Characters XML 1.0 cannot represent, even as character references: C0
// controls other than tab/newline/carriage return, lone surrogates, U+FFFE/F.
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// `home` is the data root, where the job's log goes; `exportHome` names it
// in the job's environment too, for a root other than the default (which
// dashboard-start and the daemon resolve from HOME on their own).
export function validatePlistInputs({
  label,
  nodePath,
  appDir,
  home,
  exportHome = false,
  port,
  publicOrigin,
  briefsDir,
  focusOrigin,
  ghCli,
}) {
  const problems = [];

  for (const [name, value] of Object.entries({ label, nodePath, appDir, home, publicOrigin, briefsDir, focusOrigin, ghCli })) {
    if (typeof value === 'string' && XML_INVALID.test(value)) {
      problems.push(`${name} contains characters that cannot appear in a plist`);
    }
  }

  if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(label)) {
    problems.push('label must contain only letters, numbers, periods, and hyphens');
  }
  validateAbsolutePath(nodePath, 'nodePath', problems);
  validateAbsolutePath(appDir, 'appDir', problems);
  validateAbsolutePath(home, 'home', problems);
  if (briefsDir !== undefined) validateAbsolutePath(briefsDir, 'briefsDir', problems);
  if (ghCli !== undefined) validateAbsolutePath(ghCli, 'ghCli', problems);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('port must be an integer from 1 to 65535');
  }

  const normalizedPublicOrigin = validateOrigin(publicOrigin, {
    name: 'publicOrigin',
    protocol: 'https:',
    optional: true,
    problems,
  });
  const normalizedFocusOrigin = validateOrigin(focusOrigin, {
    name: 'focusOrigin',
    protocol: 'http:',
    optional: true,
    loopbackOnly: true,
    problems,
  });

  if (problems.length > 0) throw new TypeError(problems.join('; '));

  return Object.freeze({
    label,
    nodePath,
    appDir,
    home,
    exportHome: exportHome === true,
    port,
    publicOrigin: normalizedPublicOrigin,
    briefsDir,
    focusOrigin: normalizedFocusOrigin,
    ghCli,
  });
}

export function renderPlist(input) {
  const values = validatePlistInputs(input);
  const logPath = path.join(values.home, 'log', 'dashboard.log');
  const replacements = {
    LABEL: escapeXml(values.label),
    START_PATH: escapeXml(path.join(values.appDir, 'bin', 'dashboard-start')),
    NODE_PATH: escapeXml(values.nodePath),
    APP_DIR: escapeXml(values.appDir),
    PATH: escapeXml(`${path.dirname(values.nodePath)}:/usr/local/bin:/usr/bin:/bin`),
    PORT: escapeXml(String(values.port)),
    HOME_ENTRY: environmentEntry('PERSONAL_ASSISTANT_HOME', values.exportHome ? values.home : undefined),
    PUBLIC_ORIGIN_ENTRY: environmentEntry('DASHBOARD_PUBLIC_ORIGIN', values.publicOrigin),
    BRIEFS_DIR_ENTRY: environmentEntry('DASHBOARD_BRIEFS_DIR', values.briefsDir),
    FOCUS_ORIGIN_ENTRY: environmentEntry('DASHBOARD_FOCUS_ORIGIN', values.focusOrigin),
    GH_CLI_ENTRY: environmentEntry('DASHBOARD_GH_CLI', values.ghCli),
    LOG_PATH: escapeXml(logPath),
  };

  let rendered = TEMPLATE;
  for (const [name, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{{${name}}}`, () => value);
  }
  if (/{{[A-Z0-9_]+}}/.test(rendered)) {
    throw new Error('plist template contains an unresolved placeholder');
  }
  return rendered;
}

function validateAbsolutePath(value, name, problems) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    problems.push(`${name} must be an absolute path`);
  }
}

function validateOrigin(value, { name, protocol, optional, loopbackOnly = false, problems }) {
  if (value === undefined || value === null || value === '') {
    if (!optional) problems.push(`${name} is required`);
    return undefined;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push(`${name} must be a bare ${protocol}// origin`);
    return undefined;
  }

  const isBare = url.username === '' && url.password === '' && url.pathname === '/' &&
    url.search === '' && url.hash === '' && (value === url.origin || value === `${url.origin}/`);
  if (!isBare || url.protocol !== protocol) {
    problems.push(`${name} must be a bare ${protocol}// origin`);
    return undefined;
  }
  if (loopbackOnly && !LOOPBACK_HOSTS.has(url.hostname)) {
    problems.push(`${name} must use a loopback hostname`);
    return undefined;
  }
  return url.origin;
}

function environmentEntry(name, value) {
  if (value === undefined) return '';
  return `    <key>${name}</key>\n    <string>${escapeXml(value)}</string>\n`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
