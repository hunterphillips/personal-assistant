// The only files served under /assets/. Keys are public names; files are
// relative to public/. An entry whose file does not exist yet returns 404.
// brief-bridge.js is registered ahead of phase 3, which adds the file.

export const ASSETS = Object.freeze({
  'brief-bridge.js': { file: 'brief-bridge.js', type: 'text/javascript; charset=utf-8' },
});
