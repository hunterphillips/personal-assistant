// Focus services: composes Focus's settings store, job runner, Google and
// vault clients, profile reader, scans, curator, and jobs from the daemon's
// config. It loads the settings and registers the jobs, but never starts the
// runner; the caller starts it only when a board exists. Without a board
// (`hasBoard: false`) the clients, scans, curator, and jobs are null and no
// job is registered.
//
// createFocusServices({ config, registry, focusBoard, settings, apiKeyInEnv,
//   hasBoard, runner?, log }) resolves to
//   { focusSettings, google, vault, profile, scans, curator, runner, jobs }.
// `settings` is the system settings store; `runner` replaces the job runner
// (tests). With an API key in the environment the curator has no query, so a
// curate fails instead of billing the key.

import { createJobRunner } from '../jobs-runner.mjs';
import { createQueryLoader } from '../runtime/sdk.mjs';
import { createCurator } from './curate.mjs';
import { createGoogle } from './google.mjs';
import { createFocusJobs } from './jobs.mjs';
import { createProfile } from './profile.mjs';
import { createFocusSettings } from './settings.mjs';
import { createVault } from './vault.mjs';
import { scan as scanCalendar } from './scans/calendar.mjs';
import { scan as scanGmail } from './scans/gmail.mjs';
import { createGh, scan as scanGithub } from './scans/github.mjs';
import { scan as scanNotes } from './scans/notes.mjs';

export async function createFocusServices({
  config, registry, focusBoard, settings, apiKeyInEnv, hasBoard, runner: injectedRunner = null, log = () => {},
}) {
  const focusSettings = createFocusSettings({ file: config.focusSettingsPath, limits: config.limits, log });
  await focusSettings.load();
  const runner = injectedRunner ?? createJobRunner({
    runsDir: config.focusRunsDir, zone: config.timeZone, limits: config.limits,
    runLines: config.limits.focusRunLines, tickMs: config.timeouts.focusTickMs,
    // A hand-edited schedule or pause takes effect within a tick.
    onTick: () => focusSettings.reload(), log,
  });
  const none = { focusSettings, google: null, vault: null, profile: null, scans: null, curator: null, runner, jobs: null };
  if (!hasBoard) return Object.freeze(none);

  const google = createGoogle({ dir: config.focusGoogleDir, log });
  const vault = createVault({ registry, agentId: 'second-brain' });
  const profile = createProfile({ dir: config.personalContextDir, timeoutMs: config.timeouts.focusScanMs });
  const gh = createGh({ cli: config.ghCli, timeout: config.timeouts.focusScanMs });
  const queryLoader = createQueryLoader();
  const query = apiKeyInEnv ? null : async function* queryFocus(input) {
    const sdkQuery = await queryLoader.ensureQuery();
    yield* sdkQuery(input);
  };
  const curator = createCurator({
    query, board: focusBoard, rules: config.focusRulesPath, vault, profile, settings: focusSettings,
    systemSettings: settings, zone: config.timeZone, limits: config.limits, timeouts: config.timeouts,
    cwd: config.home, log,
  });
  const scans = Object.freeze({
    calendar: (deps) => scanCalendar({ google, ...deps }),
    gmail: (deps) => scanGmail({ google, vault, ...deps }),
    git: (deps) => scanGithub({ gh, ...deps }),
    notes: (deps) => scanNotes({ vault, ...deps }),
  });
  const jobs = createFocusJobs({
    runner, board: focusBoard, settings: focusSettings, scans, curator,
    candidatesDir: config.focusCandidatesDir, zone: config.timeZone,
    limits: config.limits, timeouts: config.timeouts, log,
  });
  return Object.freeze({ ...none, google, vault, profile, scans, curator, jobs });
}
