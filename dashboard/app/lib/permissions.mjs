// The permission levels an agent's turn can run at, as data: what each
// level means to the interface and which Claude Agent SDK permission mode
// it maps to (runtime/claude.mjs applies the mapping; sdk.d.ts
// PermissionMode). The level is set per agent in the registry
// (registry.mjs `permission`) with a system default in settings
// (settings.mjs `permission.default`, seeded 'ask'); no agent is named in
// code.
//
//   ask    permissionMode 'default': every tool outside the allow rules
//          raises an approval card.
//   auto   permissionMode 'auto': Claude Code's classifier decides and
//          escalates to a card only when it is unsure. Per model, and
//          `permissions.disableAutoMode` can refuse it; the adapter logs the
//          mode the SDK actually took.
//   full   permissionMode 'bypassPermissions' with
//          allowDangerouslySkipPermissions: no approval card at all. A
//          question the model puts to Hunter (AskUserQuestion) still comes
//          through as a card.
//
//   PERMISSION_LEVELS     ['ask', 'auto', 'full'], frozen, in display order
//   permissionName(id)    the display name, or the id itself for one not listed
//   isPermission(value)   whether value is one of PERMISSION_LEVELS
//   sdkModeFor(level)     { permissionMode, allowDangerouslySkipPermissions? }
//                         for a level; null and undefined map as 'ask'

export const PERMISSION_LEVELS = Object.freeze(['ask', 'auto', 'full']);

const PERMISSION_NAMES = Object.freeze({ ask: 'Ask', auto: 'Auto', full: 'Full access' });

const SDK_MODES = Object.freeze({
  ask: Object.freeze({ permissionMode: 'default' }),
  auto: Object.freeze({ permissionMode: 'auto' }),
  full: Object.freeze({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }),
});

export function permissionName(id) {
  return Object.hasOwn(PERMISSION_NAMES, id) ? PERMISSION_NAMES[id] : String(id ?? '');
}

export function isPermission(value) {
  return typeof value === 'string' && PERMISSION_LEVELS.includes(value);
}

export function sdkModeFor(level) {
  return SDK_MODES[level ?? 'ask'] ?? null;
}
