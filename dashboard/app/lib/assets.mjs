// The only files served under /assets/. Keys are public names; files are
// relative to public/. An entry whose file does not exist returns 404.

export const ASSETS = Object.freeze({
  'agents.js': { file: 'agents.js', type: 'text/javascript; charset=utf-8' },
  'brief-bridge.js': { file: 'brief-bridge.js', type: 'text/javascript; charset=utf-8' },
  'feed.js': { file: 'feed.js', type: 'text/javascript; charset=utf-8' },
  'goals.js': { file: 'goals.js', type: 'text/javascript; charset=utf-8' },
  'routines.js': { file: 'routines.js', type: 'text/javascript; charset=utf-8' },
  'shell.js': { file: 'shell.js', type: 'text/javascript; charset=utf-8' },
  'styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
});
