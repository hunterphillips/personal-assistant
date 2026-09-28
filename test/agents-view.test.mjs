// The Agents view's pure helpers, loaded from public/agents.js into a bare
// window. Nothing here touches the DOM.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/agents.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const view = context.window.DashboardAgents;
// Values made inside the vm context have other Object and Array prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const persona = (fields) => ({ id: 'cfo', name: 'CFO', kind: 'persona', provider: 'claude', state: 'idle', pending: null, lastMessage: null, lastError: null, ...fields });

test('groups keeps registry order under Work then Personal and drops empty groups', () => {
  const agents = [
    { id: 'a', group: 'personal' }, { id: 'b', group: 'work' }, { id: 'c', group: 'personal' },
  ];
  assert.deepEqual(plain(view.groups(agents).map((g) => [g.title, g.agents.map((a) => a.id)])), [['Work', ['b']], ['Personal', ['a', 'c']]]);
  assert.deepEqual(plain(view.groups([{ id: 'b', group: 'work' }]).map((g) => g.title)), ['Work']);
  assert.deepEqual(plain(view.groups([])), []);
});

test('routinesCount counts the routines once they have been read', () => {
  assert.equal(view.routinesCount(null), '');
  assert.equal(view.routinesCount({ routines: { refreshedAt: null, items: [{}] } }), '');
  assert.equal(view.routinesCount({ routines: { refreshedAt: '2026-09-28T09:00:00.000Z', items: [] } }), '0 routines');
  assert.equal(view.routinesCount({ routines: { refreshedAt: '2026-09-28T09:00:00.000Z', items: [{}] } }), '1 routine');
  assert.equal(view.routinesCount({ routines: { refreshedAt: '2026-09-28T09:00:00.000Z', items: [{}, {}] } }), '2 routines');
});

test('errorSentence turns each code into a sentence and passes adapter sentences through', () => {
  assert.equal(view.errorSentence(persona({ lastError: 'api_key_in_env' })),
    'The dashboard started with an API key in its environment, so personas are off. Unset it and restart the dashboard.');
  assert.equal(view.errorSentence(persona({ lastError: 'start_failed' })),
    'The session file for CFO could not be read. Check the threads directory, then restart the dashboard.');
  assert.equal(view.errorSentence(persona({ lastError: 'sdk_unavailable' })),
    'The Claude Agent SDK could not be loaded. Run npm ci in dashboard/app, then restart the dashboard.');
  assert.equal(view.errorSentence(persona({ lastError: 'provider_unavailable', provider: 'codex' })), 'There is no runtime for Codex yet.');
  assert.equal(view.errorSentence(persona({ lastError: 'turn_timeout' })), 'The last turn ran too long and was stopped.');
  assert.equal(view.errorSentence(persona({ lastError: 'error' })), 'The last turn failed.');
  assert.equal(view.errorSentence(persona({ lastError: null })), 'The last turn failed.');
  const resume = 'The stored session could not be resumed. Start a new thread.';
  assert.equal(view.errorSentence(persona({ lastError: resume })), resume);
});

test('composerReason says why a message cannot be sent', () => {
  assert.equal(view.composerReason(persona()), '');
  assert.equal(view.composerReason({ id: 'x', kind: 'system' }), '');
  assert.equal(view.composerReason(persona({ state: 'busy' })), 'CFO is working. Wait for the reply or interrupt.');
  assert.equal(view.composerReason(persona({ state: 'waiting', pending: { kind: 'question' } })), 'Answer the question first.');
  assert.equal(view.composerReason(persona({ state: 'waiting', pending: { kind: 'approval' } })), 'Allow or deny the request first.');
  assert.equal(view.composerReason(persona({ state: 'unavailable', lastError: 'provider_unavailable' })), 'There is no runtime for Claude yet.');
  assert.equal(view.composerReason(persona({ state: 'unavailable', lastError: null })), 'CFO has not started yet.');
  assert.equal(view.composerReason(persona({ state: 'error', lastError: 'x' })), '');
});

test('refusalSentence covers each route refusal and a missing answer', () => {
  const agent = persona();
  assert.equal(view.refusalSentence(null, agent), 'The dashboard did not respond.');
  assert.equal(view.refusalSentence({ code: 'busy' }, agent), 'CFO is still working. Wait for the reply.');
  assert.equal(view.refusalSentence({ code: 'no_such_request' }, agent), 'That request was already answered or has expired.');
  assert.equal(view.refusalSentence({ code: 'shutting_down' }, agent), 'The dashboard is shutting down. Try again in a moment.');
  assert.equal(view.refusalSentence({ code: 'persona_unavailable' }, agent), 'CFO is unavailable.');
  assert.equal(view.refusalSentence({ code: 'thread_reset_failed' }, agent), 'The thread could not be reset. Check the dashboard log.');
  assert.equal(view.refusalSentence({ code: 'payload_too_large' }, agent), 'The message is too long. Shorten it.');
  assert.equal(view.refusalSentence({ code: 'not_a_persona' }, agent), 'CFO has no thread.');
  assert.equal(view.refusalSentence({ code: 'invalid_agent' }, agent), 'That agent is not in the registry.');
  const generic = 'Something went wrong on the dashboard. Try again.';
  assert.equal(view.refusalSentence({ code: 'internal_error' }, agent), generic);
  assert.equal(view.refusalSentence({ code: 'never_seen_before' }, agent), generic);
  assert.equal(view.refusalSentence({ code: null }, agent), generic);
});

test('previewText collapses whitespace and marks your own messages', () => {
  assert.equal(view.previewText(persona({ lastMessage: { role: 'assistant', text: 'One\n\n  two ' } })), 'One two');
  assert.equal(view.previewText(persona({ lastMessage: { role: 'user', text: 'Hi' } })), 'You: Hi');
  assert.equal(view.previewText(persona()), '');
  assert.equal(view.previewText({ kind: 'project', description: 'A folder.' }), 'A folder.');
});

test('stateLine marks waiting, busy, error, and unavailable personas only', () => {
  const line = (state) => plain(view.stateLine(persona({ state })));
  assert.deepEqual(line('waiting'), { text: 'Waiting for you', tone: 'wait' });
  assert.deepEqual(line('busy'), { text: 'Working', tone: 'muted' });
  assert.deepEqual(line('error'), { text: 'The last turn failed', tone: 'bad' });
  assert.deepEqual(line('unavailable'), { text: 'Unavailable', tone: 'muted' });
  assert.equal(view.stateLine(persona()), null);
  assert.equal(view.stateLine({ kind: 'system', state: null }), null);
});

test('formatInput pretty-prints whole JSON and leaves cut input as it came', () => {
  assert.equal(view.formatInput({ input: '{"a":1}', truncated: false }), '{\n  "a": 1\n}');
  assert.equal(view.formatInput({ input: '{"a":1', truncated: true }), '{"a":1');
  assert.equal(view.formatInput({ input: 'not json', truncated: false }), 'not json');
});
