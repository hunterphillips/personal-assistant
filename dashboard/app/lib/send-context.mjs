// What quick chat sends along with Hunter's message: the view he was on
// and, when the view has one, the object in it (the selected job, the feed
// item in view, the open agent). The send route takes it as the body's
// optional `context`; the Claude adapter records it as one system line
// before the user's message and prefixes the prompt the model receives
// with it, while the user's message is recorded as typed.
//
//   parseContext(value) -> { view, label?, detail? } or null when the shape
//     is wrong: `view` one of CONTEXT_VIEWS's keys, `label` a non-empty
//     string of at most LABEL_MAX characters, `detail` a non-empty string of
//     at most DETAIL_MAX characters, and no other key. An empty label or
//     detail is left out.
//   contextLine(context) -> "Sent from Health: Nightly sync", or
//     "Sent from Focus." with no label: the line's text in the thread.
//   contextPrompt(context, text) -> the text with the context before it, as
//     the model receives it.

export const CONTEXT_VIEWS = Object.freeze({
  agents: 'Agents',
  feed: 'Feed',
  brief: 'Brief',
  focus: 'Focus',
  goals: 'Goals',
  ideas: 'Ideas',
  health: 'Health',
});
export const LABEL_MAX = 200;
export const DETAIL_MAX = 2000;

const KEYS = new Set(['view', 'label', 'detail']);

export function parseContext(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !KEYS.has(key))) return null;
  if (typeof value.view !== 'string' || !Object.hasOwn(CONTEXT_VIEWS, value.view)) return null;
  const context = { view: value.view };
  for (const [key, max] of [['label', LABEL_MAX], ['detail', DETAIL_MAX]]) {
    if (!(key in value) || value[key] === null) continue;
    if (typeof value[key] !== 'string' || Array.from(value[key]).length > max) return null;
    const text = value[key].trim();
    if (text) context[key] = text;
  }
  return context;
}

export function contextLine(context) {
  const view = CONTEXT_VIEWS[context.view];
  return context.label ? `Sent from ${view}: ${context.label}` : `Sent from ${view}.`;
}

export function contextPrompt(context, text) {
  const view = CONTEXT_VIEWS[context.view];
  const head = context.label
    ? `Hunter sent this from the ${view} view, looking at: ${context.label}`
    : `Hunter sent this from the ${view} view.`;
  return `${head}${context.detail ? `\n${context.detail}` : ''}\n\n${text}`;
}
