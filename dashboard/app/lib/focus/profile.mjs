// Profile: read-only personal context selected for the Focus caller.
// createProfile({ dir, execFile, timeoutMs }).read() runs the selector with this
// process's node and returns its trimmed output, or an empty string when the
// store is absent, the selector rejects the caller, exits non-zero, or times
// out (timeoutMs defaults to TIMEOUTS.focusScanMs). It never reads store data
// directly.

import { execFile as nodeExecFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { TIMEOUTS } from '../config.mjs';

export function createProfile({ dir, execFile = nodeExecFile, timeoutMs = TIMEOUTS.focusScanMs }) {
  async function read() {
    try {
      if (!(await stat(dir)).isDirectory()) return '';
    } catch {
      return '';
    }
    const selector = path.join(dir, 'resolver/select.mjs');
    try {
      const stdout = await execute(execFile, process.execPath, [selector, '--caller', 'focus'], {
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
