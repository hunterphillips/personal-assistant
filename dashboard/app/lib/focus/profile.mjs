// Profile: read-only personal context selected for the Focus caller.
// createProfile({ dir, execFile, timeoutMs }).read() returns trimmed selector
// output, or an empty string when the store is absent, the selector rejects the
// caller, exits non-zero, or times out. It never reads store data directly.

import { execFile as nodeExecFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export function createProfile({ dir, execFile = nodeExecFile, timeoutMs }) {
  async function read() {
    try {
      if (!(await stat(dir)).isDirectory()) return '';
    } catch {
      return '';
    }
    const selector = path.join(dir, 'resolver/select.mjs');
    try {
      const stdout = await execute(execFile, 'node', [selector, '--caller', 'focus'], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
      });
      return String(stdout).trim();
    } catch {
      return '';
    }
  }

  return Object.freeze({ read });
}

function execute(execFile, command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
