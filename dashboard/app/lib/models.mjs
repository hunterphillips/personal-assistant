// The models an agent's turn can run on, as data: the Claude Code aliases
// the SDK accepts as `model` (sdk.d.ts: "alias (e.g. 'fable', 'opus',
// 'sonnet', 'haiku') or full model ID"). An alias follows whatever each
// family's current model is, so the table does not go stale with a release;
// a full id typed into the registry by hand still works and shows as itself.
// Each entry was confirmed with one `claude -p --model <id>` call on
// 2026-10-01; a turn on an id the CLI rejects ends in lastError through the
// adapter's START_FAILED path (runtime/claude.mjs), never hangs.
//
// Effort is the SDK's enum, validated here at every level and nowhere
// narrowed per model: the SDK documents its own fallback ('xhigh' falls
// back to 'high' on a model without it; 'max' is for select models), and a
// pair a turn refuses surfaces as any failed turn does.
//
//   MODELS           [{ id, name }] in display order, frozen
//   EFFORTS          ['low', 'medium', 'high', 'xhigh', 'max'], frozen
//   modelName(id)    the display name, or the id itself for one not listed
//   effortName(id)   the display name of an effort level, or the id itself
//   isEffort(value)  whether value is one of EFFORTS

export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const EFFORT_NAMES = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' });

export const MODELS = Object.freeze([
  { id: 'fable', name: 'Fable' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
].map((entry) => Object.freeze(entry)));

export function modelName(id) {
  const entry = MODELS.find((model) => model.id === id);
  return entry ? entry.name : String(id ?? '');
}

export function effortName(id) {
  return Object.hasOwn(EFFORT_NAMES, id) ? EFFORT_NAMES[id] : String(id ?? '');
}

export function isEffort(value) {
  return typeof value === 'string' && EFFORTS.includes(value);
}
