#!/usr/bin/env node
// Phase 2 spike: proves the Claude Agent SDK can run a persona thread the way
// the dashboard daemon will. It works only inside a scratch repo it creates
// under SPIKE_ROOT and appends one JSON line per step to SPIKE_LOG.
//
//   SPIKE_ROOT   directory to create (required)
//   SPIKE_LOG    JSON-lines log file (default $SPIKE_ROOT/spike.jsonl)
//   SPIKE_STAGE  internal: 'resume' runs only the child half of the
//                resume-after-restart step
//
// Every step is caught and logged; the script never throws out.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = process.env.SPIKE_ROOT;
const LOG = process.env.SPIKE_LOG || (ROOT ? path.join(ROOT, 'spike.jsonl') : null);
const STAGE = process.env.SPIKE_STAGE || 'main';
const REPO = ROOT ? path.join(ROOT, 'repo') : null;
const QUERY_TIMEOUT_MS = 180_000;
const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

function log(step, ok, detail = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), stage: STAGE, pid: process.pid, step, ok, detail });
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {
    // The log is the deliverable; if it cannot be written, stderr is all that is left.
  }
  process.stderr.write(`${line}\n`);
}

function redact(text) {
  return String(text)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]')
    .replace(/\b(?:ey|gh[pousr]_|xox[abp]-)[A-Za-z0-9._-]{20,}/g, '[token]')
    // Long opaque strings with mixed case and digits; paths and UUIDs lack one of the three.
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) && !m.includes('/') ? '[token]' : m))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
}

function trim(text, max = 500) {
  const s = redact(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function timed(step, fn) {
  const started = Date.now();
  try {
    const { ok, detail } = await fn();
    log(step, ok, { ...detail, wallMs: Date.now() - started });
    return { ok, detail };
  } catch (error) {
    log(step, false, { error: trim(error?.stack || error, 1500), wallMs: Date.now() - started });
    return { ok: false, detail: {} };
  }
}

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, ...opts }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// Runs one query() to completion and returns what the steps need. Errors from
// the SDK are captured, not thrown.
async function runQuery(prompt, options, { accountInfo = false } = {}) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), QUERY_TIMEOUT_MS);
  const out = { init: null, texts: [], result: null, error: null, account: null, messageTypes: {} };
  try {
    const q = query({ prompt, options: { ...options, abortController } });
    for await (const message of q) {
      const key = message.subtype ? `${message.type}/${message.subtype}` : message.type;
      out.messageTypes[key] = (out.messageTypes[key] ?? 0) + 1;
      if (message.type === 'system' && message.subtype === 'init') {
        out.init = {
          session_id: message.session_id,
          apiKeySource: message.apiKeySource,
          permissionMode: message.permissionMode,
          model: message.model,
          claude_code_version: message.claude_code_version,
          cwd: message.cwd,
          skillsIncludeOrbit: Array.isArray(message.skills) ? message.skills.includes('orbit') : null,
          skillCount: Array.isArray(message.skills) ? message.skills.length : null,
          toolsIncludeAskUserQuestion: Array.isArray(message.tools) ? message.tools.includes('AskUserQuestion') : null,
        };
        if (accountInfo) {
          try {
            const info = await Promise.race([
              q.accountInfo(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('accountInfo timeout')), 15_000)),
            ]);
            out.account = {
              tokenSource: info.tokenSource ?? null,
              apiKeySource: info.apiKeySource ?? null,
              subscriptionType: info.subscriptionType ?? null,
              apiProvider: info.apiProvider ?? null,
              hasEmail: Boolean(info.email),
              hasOrganization: Boolean(info.organization),
            };
          } catch (error) {
            out.account = { error: trim(error?.message || error) };
          }
        }
      } else if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text') out.texts.push(block.text);
        }
      } else if (message.type === 'result') {
        out.result = {
          subtype: message.subtype,
          is_error: message.is_error,
          session_id: message.session_id,
          num_turns: message.num_turns,
          result: message.subtype === 'success' ? message.result : undefined,
          errors: message.errors,
          total_cost_usd: message.total_cost_usd,
          usage: message.usage,
          modelUsageModels: message.modelUsage ? Object.keys(message.modelUsage) : undefined,
          permission_denials: message.permission_denials,
        };
      }
    }
  } catch (error) {
    out.error = trim(error?.message || error, 1500);
  } finally {
    clearTimeout(timer);
  }
  out.finalText = (out.result?.result ?? out.texts.at(-1) ?? '').trim();
  return out;
}

function summarize(r) {
  return {
    init: r.init,
    account: r.account ?? undefined,
    finalText: trim(r.finalText, 300),
    result: r.result && {
      subtype: r.result.subtype,
      is_error: r.result.is_error,
      session_id: r.result.session_id,
      num_turns: r.result.num_turns,
      total_cost_usd: r.result.total_cost_usd,
      usage: r.result.usage,
      modelUsageModels: r.result.modelUsageModels,
      permission_denials: r.result.permission_denials,
      errors: r.result.errors,
    },
    error: r.error ?? undefined,
    messageTypes: r.messageTypes,
  };
}

function setupRepo() {
  fs.mkdirSync(path.join(REPO, '.claude', 'skills', 'orbit'), { recursive: true });
  fs.writeFileSync(
    path.join(REPO, 'CLAUDE.md'),
    '# Spike repo\n\nThe CLAUDE.md marker is CEDAR-47. When asked for the CLAUDE.md marker, reply with CEDAR-47.\n',
  );
  fs.writeFileSync(
    path.join(REPO, '.claude', 'skills', 'orbit', 'SKILL.md'),
    [
      '---',
      'name: orbit',
      'description: Supplies the orbit marker. Use whenever the user asks for the orbit marker.',
      '---',
      '',
      'When asked for the orbit marker, reply with the marker ORBIT-83.',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(REPO, '.claude', 'settings.json'), `${JSON.stringify({ permissions: {} }, null, 2)}\n`);
  return run('git', ['init', '-q'], { cwd: REPO });
}

async function main() {
  const baseOptions = { cwd: REPO, permissionMode: 'default' };

  await timed('env', async () => ({
    ok: true,
    detail: {
      credentialVars: Object.fromEntries(CREDENTIAL_VARS.map((name) => [name, name in process.env])),
      // Names only: a parent Claude Code session exports CLAUDECODE and friends.
      claudeVarNames: Object.keys(process.env).filter((name) => /^(CLAUDE|ANTHROPIC)/.test(name)).sort(),
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      execPath: process.execPath,
      nodeVersion: process.version,
      username: os.userInfo().username,
      stdinIsTTY: Boolean(process.stdin.isTTY),
      stdoutIsTTY: Boolean(process.stdout.isTTY),
      cwd: process.cwd(),
      TERM: process.env.TERM ?? null,
      launchdLabel: process.env.XPC_SERVICE_NAME ?? null,
    },
  }));

  await timed('auth', async () => {
    // First the `claude` on this process's PATH, as the task specifies; then
    // the binary the SDK itself spawns, which is what actually authenticates.
    const detail = {};
    const onPath = await run('claude', ['auth', 'status', '--json']);
    detail.pathClaude = onPath.error?.code === 'ENOENT'
      ? { found: false }
      : { found: true, exit: onPath.error?.code ?? 0, stdout: trim(onPath.stdout), stderr: trim(onPath.stderr) };
    try {
      const require = createRequire(import.meta.url);
      const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
      const bundled = path.join(path.dirname(pkg), 'claude');
      const version = await run(bundled, ['--version']);
      const status = await run(bundled, ['auth', 'status', '--json']);
      detail.bundledClaude = {
        path: bundled,
        version: trim(version.stdout),
        exit: status.error?.code ?? 0,
        stdout: trim(status.stdout),
        stderr: trim(status.stderr),
      };
    } catch (error) {
      detail.bundledClaude = { error: trim(error?.message || error) };
    }
    const ok = Boolean(detail.bundledClaude?.stdout || detail.pathClaude?.stdout);
    return { ok, detail };
  });

  const setup = await timed('setup', async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    const git = await setupRepo();
    return { ok: !git.error, detail: { repo: REPO, gitError: git.error ? trim(git.stderr || git.error.message) : null } };
  });
  if (!setup.ok) return;

  let sessionId = null;
  const calls = [];
  const recordingCanUseTool = (decide) => async (toolName, input, opts) => {
    calls.push({ toolName, input: trim(JSON.stringify(input), 800), decisionReason: opts?.decisionReason ?? null, title: opts?.title ?? null });
    return decide(toolName, input, opts);
  };

  await timed('settings', async () => {
    calls.length = 0;
    const r = await runQuery(
      'Reply with exactly the CLAUDE.md marker and the orbit marker, nothing else.',
      {
        ...baseOptions,
        maxTurns: 3,
        // Logs any prompt; lets the Skill tool through so a skill that needs
        // invoking can load, denies everything else.
        canUseTool: recordingCanUseTool(async (toolName, input) =>
          toolName === 'Skill'
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'denied by spike' }),
      },
      { accountInfo: true },
    );
    sessionId = r.init?.session_id ?? r.result?.session_id ?? null;
    const ok = r.finalText.includes('CEDAR-47') && r.finalText.includes('ORBIT-83');
    return { ok, detail: { sessionId, ...summarize(r), canUseToolCalls: [...calls] } };
  });
  if (!sessionId) {
    log('done', false, { reason: 'no session id from settings step' });
    return;
  }

  await timed('question', async () => {
    calls.length = 0;
    let questionsShape = null;
    let answerShape = null;
    const r = await runQuery(
      'Use the AskUserQuestion tool to ask me which color I want, offering Blue and Amber, then reply with only the color I chose.',
      {
        ...baseOptions,
        resume: sessionId,
        maxTurns: 3,
        canUseTool: recordingCanUseTool(async (toolName, input) => {
          if (toolName !== 'AskUserQuestion') return { behavior: 'deny', message: 'denied by spike' };
          questionsShape = input;
          // Documented shape (typings AskUserQuestionInput.answers and the
          // user-input guide): answers keyed by the question text, value is
          // the chosen option's label; the original questions pass through.
          const answers = Object.fromEntries((input.questions ?? []).map((q) => [q.question, 'Amber']));
          const updatedInput = { ...input, answers };
          answerShape = updatedInput;
          return { behavior: 'allow', updatedInput };
        }),
      },
    );
    const ok = r.finalText.trim().replace(/[.!]$/, '').toLowerCase() === 'amber';
    return { ok, detail: { inputReceived: questionsShape, updatedInputReturned: answerShape, ...summarize(r), canUseToolCalls: [...calls] } };
  });

  const marker = path.join(REPO, 'marker.txt');
  const bashPrompt = 'Run the shell command `printf probe > marker.txt` in the current directory, then reply done.';

  await timed('approval-deny', async () => {
    calls.length = 0;
    let bashCalls = 0;
    const r = await runQuery(bashPrompt, {
      ...baseOptions,
      resume: sessionId,
      maxTurns: 3,
      canUseTool: recordingCanUseTool(async (toolName) => {
        if (toolName === 'Bash') bashCalls += 1;
        return { behavior: 'deny', message: 'denied by spike' };
      }),
    });
    const exists = fs.existsSync(marker);
    return { ok: !exists && bashCalls >= 1, detail: { markerExists: exists, bashCalls, ...summarize(r), canUseToolCalls: [...calls] } };
  });

  await timed('approval-allow', async () => {
    calls.length = 0;
    let allowed = 0;
    const r = await runQuery(bashPrompt, {
      ...baseOptions,
      resume: sessionId,
      maxTurns: 3,
      canUseTool: recordingCanUseTool(async (toolName, input) => {
        if (toolName === 'Bash' && allowed === 0) {
          allowed += 1;
          return { behavior: 'allow', updatedInput: input };
        }
        return { behavior: 'deny', message: 'denied by spike' };
      }),
    });
    const content = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
    return { ok: content === 'probe', detail: { markerContent: content, ...summarize(r), canUseToolCalls: [...calls] } };
  });

  await timed('resume-after-restart', async () => {
    fs.writeFileSync(path.join(ROOT, 'session.json'), `${JSON.stringify({ sessionId })}\n`);
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT_PATH], {
        env: { ...process.env, SPIKE_STAGE: 'resume', SPIKE_ROOT: ROOT, SPIKE_LOG: LOG },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('error', (error) => resolve(`spawn error: ${error.message}`));
      child.on('exit', (exitCode, signal) => resolve(signal ? `signal ${signal}` : exitCode));
    });
    return { ok: code === 0, detail: { childExit: code, note: 'the child logs resume-child with the pass/fail' } };
  });

  await timed('concurrent-resume', async () => {
    const prompt = (word) => `Reply with only the word ${word}.`;
    const opts = { ...baseOptions, resume: sessionId, maxTurns: 1 };
    const started = Date.now();
    const [a, b] = await Promise.all(
      ['WALNUT', 'PEBBLE'].map(async (word) => {
        const r = await runQuery(prompt(word), opts);
        return { word, finishedMs: Date.now() - started, ...summarize(r) };
      }),
    );
    // What is on disk afterwards: which transcript files carry this id.
    const projects = path.join(os.homedir(), '.claude', 'projects');
    const transcripts = [];
    for (const dir of fs.readdirSync(projects)) {
      for (const id of new Set([sessionId, a.result?.session_id, b.result?.session_id].filter(Boolean))) {
        const file = path.join(projects, dir, `${id}.jsonl`);
        if (fs.existsSync(file)) {
          const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
          transcripts.push({ id, dir, lines: lines.length, mentionsWalnut: lines.some((l) => l.includes('WALNUT')), mentionsPebble: lines.some((l) => l.includes('PEBBLE')) });
        }
      }
    }
    return { ok: true, detail: { a, b, transcripts } };
  });

  log('done', true, {});
}

async function resumeChild() {
  await timed('resume-child', async () => {
    const { sessionId } = JSON.parse(fs.readFileSync(path.join(ROOT, 'session.json'), 'utf8'));
    const r = await runQuery('Which color did I choose earlier? Reply with only the color.', {
      cwd: REPO,
      resume: sessionId,
      permissionMode: 'default',
      maxTurns: 2,
    });
    const ok = r.finalText.trim().replace(/[.!]$/, '').toLowerCase() === 'amber';
    if (!ok) process.exitCode = 1;
    return { ok, detail: { sessionId, ...summarize(r) } };
  });
}

async function entry() {
  if (!ROOT || !path.isAbsolute(ROOT)) {
    process.stderr.write('spike-claude-sdk: SPIKE_ROOT must be an absolute path\n');
    process.exitCode = 64;
    return;
  }
  fs.mkdirSync(ROOT, { recursive: true });
  try {
    if (STAGE === 'resume') await resumeChild();
    else await main();
  } catch (error) {
    log('fatal', false, { error: trim(error?.stack || error, 1500) });
  }
}

await entry();
