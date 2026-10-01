// The Agents view's pure helpers, loaded from public/agents.js into a bare
// window. Nothing here touches the DOM.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/agents.js', import.meta.url), 'utf8');
const markdown = readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.runInNewContext(markdown, context);
vm.runInNewContext(source, context);
const view = context.window.DashboardAgents;
// Values made inside the vm context have other Object and Array prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

const persona = (fields) => ({ id: 'cfo', name: 'CFO', kind: 'persona', provider: 'claude', state: 'idle', pending: null, lastMessage: null, lastError: null, ...fields });

const shape = (list) => plain(list.map((g) => [g.title, g.entries.map((e) => [e.agent ? e.agent.id : null, e.sessions.map((s) => s.id)])]));

const GROUP_LIST = [{ id: 'work', name: 'Work' }, { id: 'personal', name: 'Personal' }];

test('groups follows the registry list in order, then unlisted groups as first seen, and drops empty groups', () => {
  const agents = [
    { id: 'a', group: 'personal' }, { id: 'b', group: 'work' }, { id: 'c', group: 'personal' },
  ];
  assert.deepEqual(shape(view.groups(agents, [], GROUP_LIST)), [['Work', [['b', []]]], ['Personal', [['a', []], ['c', []]]]]);
  assert.deepEqual(plain(view.groups([{ id: 'b', group: 'work' }], [], GROUP_LIST).map((g) => g.title)), ['Work']);
  assert.deepEqual(plain(view.groups([], [], GROUP_LIST)), []);
  // The list sets the order; a listed group with no agents is left out.
  const reversed = [{ id: 'personal', name: 'Home life' }, { id: 'work', name: 'Work' }, { id: 'empty', name: 'Nobody' }];
  assert.deepEqual(plain(view.groups(agents, [], reversed).map((g) => g.title)), ['Home life', 'Work']);
  // Groups the list leaves out follow it, in the order agents first name them, with the id's first letter raised.
  const more = agents.concat([{ id: 'd', group: 'family' }, { id: 'e', group: 'side-projects' }, { id: 'f', group: 'family' }]);
  assert.deepEqual(shape(view.groups(more, [], GROUP_LIST)), [
    ['Work', [['b', []]]], ['Personal', [['a', []], ['c', []]]], ['Family', [['d', []], ['f', []]]], ['Side-projects', [['e', []]]],
  ]);
  // With no list at all every group is unlisted.
  assert.deepEqual(plain(view.groups(agents).map((g) => g.title)), ['Personal', 'Work']);
});

test('roleChip is off when the role only repeats the name', () => {
  assert.equal(view.roleChip({ name: 'Assistant', role: 'Assistant' }), false);
  assert.equal(view.roleChip({ name: 'CFO', role: 'Money' }), true);
  assert.equal(view.roleChip({ name: 'CFO', role: '' }), false);
  assert.equal(view.roleChip({ name: 'CFO' }), false);
});

test('groupName is the registry name, else the id with its first letter raised', () => {
  assert.equal(view.groupName('work', GROUP_LIST), 'Work');
  assert.equal(view.groupName('family', GROUP_LIST), 'Family');
  assert.equal(view.groupName('family'), 'Family');
  assert.equal(view.groupName(''), '');
  assert.equal(view.groupName(undefined, GROUP_LIST), '');
});

test('groups puts pinned personas first under no heading and pinnedPersona finds the first', () => {
  const agents = [
    { id: 'cfo', group: 'work', kind: 'persona' },
    persona({ id: 'assistant', group: 'personal', pinned: true }),
    { id: 'brain', group: 'personal', kind: 'persona' },
  ];
  const list = view.groups(agents, [], GROUP_LIST);
  assert.deepEqual(plain(list.map((g) => [g.key, g.title])), [['pinned', null], ['work', 'Work'], ['personal', 'Personal']]);
  assert.deepEqual(shape(list), [[null, [['assistant', []]]], ['Work', [['cfo', []]]], ['Personal', [['brain', []]]]]);
  assert.equal(view.pinnedPersona(agents).id, 'assistant');
  // A pinned entry that is not a persona (nothing to open) is not the default.
  assert.equal(view.pinnedPersona([{ id: 'x', pinned: true, kind: 'system' }]), null);
  assert.equal(view.pinnedPersona([{ id: 'cfo', kind: 'persona', provider: 'claude' }]), null);
});

test('groups nests sessions under their project in snapshot order and puts the rest under Other sessions', () => {
  const agents = [{ id: 'b', group: 'work', kind: 'project' }, { id: 'a', group: 'personal', kind: 'persona' }, { id: 'c', group: 'archive', kind: 'project' }];
  const sessions = [
    { id: 'codex:1', projectId: 'b' }, { id: 'claude:2', projectId: null }, { id: 'codex:3', projectId: 'b' }, { id: 'codex:4', projectId: 'gone' },
    { id: 'codex:5', projectId: 'c' },
  ];
  // A project in a group the list leaves out (c) still has a row, under its own heading, so its sessions nest there.
  assert.deepEqual(shape(view.groups(agents, sessions, GROUP_LIST)), [
    ['Work', [['b', ['codex:1', 'codex:3']]]],
    ['Personal', [['a', []]]],
    ['Archive', [['c', ['codex:5']]]],
    ['Other sessions', [[null, ['claude:2', 'codex:4']]]],
  ]);
  assert.deepEqual(shape(view.groups([], sessions.slice(1, 2))), [['Other sessions', [[null, ['claude:2']]]]]);
});

test('sessionsSentence speaks only when nothing is listed and both sources are off', () => {
  const off = { available: false, reason: 'not_running' };
  const on = { available: true };
  const sentence = 'No coding sessions. Start the Codex server or open a terminal in cmux.';
  assert.equal(view.sessionsSentence({ sessions: [], codex: off, cmux: off }), sentence);
  assert.equal(view.sessionsSentence({ sessions: [], codex: off, cmux: on }), '');
  assert.equal(view.sessionsSentence({ sessions: [], codex: on, cmux: off }), '');
  assert.equal(view.sessionsSentence({ sessions: [{ id: 'codex:1' }], codex: off, cmux: off }), '');
  assert.equal(view.sessionsSentence(null), '');
});

test('codexSentence and cmuxSentence say what is off and nothing while on', () => {
  assert.equal(view.codexSentence({ available: true }), '');
  assert.equal(view.codexSentence({ available: false, reason: 'no_server' }), 'The Codex server is not running.');
  assert.equal(view.codexSentence({ available: false, reason: 'disconnected' }), 'The Codex server disconnected.');
  assert.equal(view.codexSentence({ available: false, reason: 'ws_unavailable' }), 'Codex sessions are off until npm ci runs.');
  assert.equal(view.codexSentence({ available: false, reason: 'no_adapter' }), 'Codex sessions are off.');
  assert.equal(view.cmuxSentence({ available: true, stale: true }), '');
  assert.equal(view.cmuxSentence({ available: false, reason: 'not_running' }), 'cmux is not running.');
  assert.equal(view.cmuxSentence({ available: false, reason: 'no_password' }), 'cmux refused the connection. Check the socket password.');
  assert.equal(view.cmuxSentence({ available: false, reason: 'auth_failed' }), 'cmux refused the connection. Check the socket password.');
  assert.equal(view.cmuxSentence({ available: false, reason: 'error' }), 'cmux is not reachable.');
  assert.equal(view.cmuxSentence({ available: false, reason: 'not_refreshed' }), 'cmux is not reachable.');
});

test('terminalReason says why Open terminal is off, in order: no binding, cmux, closed', () => {
  const live = { workspaceId: 'ws', surfaceId: 'sf', live: true };
  const on = { cmux: { available: true } };
  assert.equal(view.terminalReason({ binding: null }, on), 'This thread was not started with codex-new, so its terminal is not known.');
  assert.equal(view.terminalReason({ binding: { workspaceId: null, surfaceId: null, live: false } }, on),
    'This thread was not started with codex-new, so its terminal is not known.');
  assert.equal(view.terminalReason({ binding: { ...live, live: false } }, { cmux: { available: false, reason: 'not_running' } }), 'cmux is not running.');
  assert.equal(view.terminalReason({ binding: { ...live, live: false } }, on), 'That terminal is closed.');
  assert.equal(view.terminalReason({ binding: live }, on), '');
});

test('openRefusal turns each open-terminal refusal into a sentence', () => {
  assert.equal(view.openRefusal(null), 'The dashboard did not respond.');
  assert.equal(view.openRefusal({ code: 'unbound' }), 'This thread was not started with codex-new, so its terminal is not known.');
  assert.equal(view.openRefusal({ code: 'terminal_closed' }), 'That terminal is closed.');
  assert.equal(view.openRefusal({ code: 'cmux_unavailable', reason: 'no_password' }), 'cmux refused the connection. Check the socket password.');
  assert.equal(view.openRefusal({ code: 'focus_failed', reason: 'not_found' }), 'That terminal is closed.');
  assert.equal(view.openRefusal({ code: 'focus_failed', reason: 'not_running' }), 'cmux is not running.');
  assert.equal(view.openRefusal({ code: 'focus_failed', reason: 'error' }), 'cmux could not open that terminal.');
  assert.equal(view.openRefusal({ code: 'no_such_session' }), 'That session is no longer listed.');
  assert.equal(view.openRefusal({ code: 'internal_error' }), 'Something went wrong on the dashboard. Try again.');
});

test('displayName and shortPath name a session by its title or folder, with the home directory as ~', () => {
  assert.equal(view.displayName({ id: 'cfo', name: 'CFO', kind: 'persona' }), 'CFO');
  assert.equal(view.displayName({ id: 'codex:1', threadId: '1', title: 'Fix the test', cwd: '/home/h/work' }), 'Fix the test');
  assert.equal(view.displayName({ id: 'codex:1', threadId: '1', title: null, cwd: '/home/h/work/' }), 'work');
  assert.equal(view.displayName({ id: 'claude:1', kind: 'terminal', cwd: '/home/h/notes' }), 'notes');
  assert.equal(view.displayName({ id: 'claude:1', kind: 'terminal', cwd: null }), 'Terminal');
  assert.equal(view.shortPath('/home/h/work', '/home/h'), '~/work');
  assert.equal(view.shortPath('/home/h', '/home/h'), '~');
  assert.equal(view.shortPath('/home/hh/work', '/home/h'), '/home/hh/work');
  assert.equal(view.shortPath('/x', null), '/x');
  assert.equal(view.shortPath(null, '/home/h'), '');
});

test('terminalState is a sentence for the terminal pane', () => {
  assert.equal(view.terminalState({ state: 'busy', binding: { live: true } }), 'Claude is working.');
  assert.equal(view.terminalState({ state: 'idle', binding: { live: true } }), 'Claude is idle.');
  assert.equal(view.terminalState({ state: 'unknown', binding: { live: true } }), 'Claude has not reported its state.');
  assert.equal(view.terminalState({ state: 'busy', binding: { live: false } }), 'The terminal is closed.');
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
  // A session is named like its row, and the Codex server's own text never reaches the pane.
  const session = (fields) => ({ id: 'codex:1', threadId: '1', title: null, cwd: '/home/h/work', state: 'error', ...fields });
  assert.equal(view.errorSentence(session({ lastError: 'start_failed' })),
    'The session file for work could not be read. Check the threads directory, then restart the dashboard.');
  assert.equal(view.errorSentence(session({ lastError: 'server_gone' })), 'The Codex server disconnected.');
  assert.equal(view.errorSentence(session({ lastError: 'Rate limited: retry after 30s' })), 'The last turn failed.');
  assert.equal(view.errorSentence(session({ lastError: 'turn_failed' })), 'The last turn failed.');
  assert.equal(view.errorSentence(session({ lastError: null })), 'The last turn failed.');
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
  const session = { id: 'codex:1', threadId: '1', title: 'Fix it', cwd: '/x' };
  assert.equal(view.refusalSentence({ code: 'busy' }, session), 'Fix it is still working. Wait for the reply.');
  assert.equal(view.refusalSentence({ code: 'not_supported' }, session), 'Answer this one in the terminal.');
  assert.equal(view.refusalSentence({ code: 'unavailable' }, session), 'The Codex server is not connected.');
  assert.equal(view.refusalSentence({ code: 'no_such_session' }, session), 'That session is no longer listed.');
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
  // Markdown markers never reach the row.
  assert.equal(view.previewText(persona({ lastMessage: { role: 'assistant', text: '## Needs you\n\n- **Call** the [bank](https://bank.example) about `wire`' } })),
    'Needs you Call the bank about wire');
  assert.equal(view.previewText(persona({ lastMessage: { role: 'system', kind: 'brief', summary: '**Cash** is _fine_.', text: '## Money' } })), 'Cash is fine.');
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

test('stateLine for sessions: a Codex turn wins over a closed terminal, a closed terminal is all a Claude row says', () => {
  const codex = (fields) => plain(view.stateLine({ id: 'codex:1', threadId: '1', state: 'idle', binding: null, ...fields }));
  const terminal = (fields) => plain(view.stateLine({ id: 'claude:1', kind: 'terminal', state: 'idle', binding: { live: true }, ...fields }));
  assert.deepEqual(codex({ state: 'waiting', binding: { live: false } }), { text: 'Waiting for you', tone: 'wait' });
  assert.deepEqual(codex({ state: 'busy' }), { text: 'Working', tone: 'muted' });
  assert.deepEqual(codex({ state: 'error' }), { text: 'The last turn failed', tone: 'bad' });
  assert.deepEqual(codex({ state: 'unavailable', binding: { live: false } }), { text: 'Server stopped', tone: 'muted' });
  assert.deepEqual(codex({ binding: { live: false } }), { text: 'Terminal closed', tone: 'muted' });
  assert.equal(codex({}), null);
  assert.equal(codex({ binding: { live: true } }), null);
  assert.deepEqual(terminal({ state: 'busy' }), { text: 'Working', tone: 'muted' });
  assert.equal(terminal({}), null);
  assert.equal(terminal({ state: 'unknown' }), null);
  assert.deepEqual(terminal({ state: 'busy', binding: { live: false } }), { text: 'Terminal closed', tone: 'muted' });
});

test('formatInput pretty-prints whole JSON and leaves cut input as it came', () => {
  assert.equal(view.formatInput({ input: '{"a":1}', truncated: false }), '{\n  "a": 1\n}');
  assert.equal(view.formatInput({ input: '{"a":1', truncated: true }), '{"a":1');
  assert.equal(view.formatInput({ input: 'not json', truncated: false }), 'not json');
});
