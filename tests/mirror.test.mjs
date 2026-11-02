import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.mjs';
import { createSessionAdapter } from '../plugins/deepseek-harness/bridge/session-adapter.mjs';
import { createMirrorWatcher, mirrorKey, mirrorStateFile, transcriptMessages } from '../plugins/deepseek-harness/bridge/mirror.mjs';

let ordinal = 0;
const line = (type, payload) => JSON.stringify({ timestamp: '2026-11-02T08:00:00.000Z', ordinal: ordinal++, type, payload });
const userLine = (id, text, kinds = ['user.text']) => line('response_item', {
  type: 'message', id, role: 'user', content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
});
const assistantLine = (id, text, turnId = 'turn-1') => line('response_item', {
  type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ['assistant.output_text'] },
});
const hash = value => createHash('sha256').update(value).digest('hex');

test('Codex transcripts contribute only real user and assistant conversation', () => {
  const messages = transcriptMessages([
    line('session_meta', { session_id: 'codex-1', cwd: '/tmp' }),
    line('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }] }),
    userLine('msg_env', 'environment context', ['environments.environment_context']),
    userLine('msg_hook', 'DSH hook context', ['hooks.additional_context']),
    userLine('msg_user', 'codex 的提问'),
    assistantLine('msg_a1', '第一段回复', 'turn-1'),
    assistantLine('msg_a2', '第二段回复', 'turn-1'),
    line('response_item', { type: 'message', id: 'msg_empty', role: 'assistant', content: [{ type: 'output_text', text: '  ' }] }),
    line('response_item', { type: 'custom_tool_call', name: 'shell', input: '{}' }),
    line('event_msg', { type: 'task_started' }),
  ]);
  assert.deepEqual(messages.map(message => [message.id, message.role, message.text]), [
    ['msg_user', 'user', 'codex 的提问'],
    ['msg_a1', 'assistant', '第一段回复'],
    ['msg_a2', 'assistant', '第二段回复'],
  ]);
  assert.equal(messages[1].turnId, 'turn-1');
});

const messageEvents = session => session.events.filter(event => event.type === 'user/message' || event.type === 'assistant/message');

test('mirror appends renderable DeepSeek events, deduplicates by Codex ID and never echoes to Codex', async () => {
  const f = fixture();
  const { sessionId } = await f.ctx.sessionController.create({ cwd: '/tmp' });
  const adapter = createSessionAdapter(f.ctx);
  const messages = [
    { id: 'msg_u1', role: 'user', text: '来自 Codex 的提问' },
    { id: 'msg_a1', role: 'assistant', text: '第一段', turnId: 'turn-1' },
    { id: 'msg_a2', role: 'assistant', text: '第二段', turnId: 'turn-1' },
  ];
  const first = await adapter.call('mirror', { sessionId, messages, model: 'gpt-6-luna' });
  assert.equal(first.appended.length, 3);
  assert.equal(first.skipped, 0);
  assert.equal(first.turn, 1);
  const events = f.sessions.get(sessionId).events;
  // The chat only renders an assistant message inside a started step, so every
  // imported record comes with a turn and step boundary of its own.
  assert.deepEqual(events.map(event => event.type), [
    'turn/start', 'user/message',
    'step/start', 'assistant/message', 'step/end',
    'step/start', 'assistant/message', 'step/end',
    'turn/end',
  ]);
  assert.deepEqual(events[0].data, { turn: 1 });
  assert.equal(events[1].data.source.kind, 'user');
  assert.equal(events[1].data.source.mirror, 'codex');
  assert.deepEqual(events[1].data.content, [{ type: 'text', text: '来自 Codex 的提问' }]);
  assert.equal(events[1].surfaceOp, 'append');
  assert.deepEqual([events[2].data, events[3].data.turn, events[3].data.step], [{ turn: 1, step: 10000 }, 1, 10000]);
  assert.deepEqual([events[5].data, events[6].data.step], [{ turn: 1, step: 10001 }, 10001]);
  assert.equal(events[3].data.stream.length, 0);
  assert.equal(events[3].data.message.source.provider, 'codex');
  assert.equal(events[3].data.message.source.model, 'gpt-6-luna');
  assert.deepEqual(events.at(-1).data, { turn: 1, reason: { kind: 'completed' } });

  const again = await adapter.call('mirror', { sessionId, messages });
  assert.deepEqual(again.appended, []);
  assert.equal(again.skipped, 3);
  assert.equal(f.sessions.get(sessionId).events.length, events.length);

  // Mirrored records are DeepSeek history, not something to send back to Codex.
  const result = await adapter.call('sync', { sessionId });
  assert.deepEqual(result.entries.map(entry => entry.type), []);
});

test('mirror reuses the latest turn and keeps imported steps clear of real steps', async () => {
  const f = fixture();
  const { sessionId } = await f.ctx.sessionController.create({ cwd: '/tmp' });
  f.append(sessionId, 'turn/start', { turn: 2 });
  f.append(sessionId, 'step/start', { turn: 2, step: 1 });
  const adapter = createSessionAdapter(f.ctx);
  const result = await adapter.call('mirror', {
    sessionId, messages: [{ id: 'msg_a9', role: 'assistant', text: '补充记录', turnId: 'turn-2' }],
  });
  assert.equal(result.turn, 2);
  const events = f.sessions.get(sessionId).events;
  assert.equal(events.filter(event => event.type === 'turn/start').length, 1);
  assert.deepEqual(events.slice(2).map(event => [event.type, event.data.turn, event.data.step]), [
    ['step/start', 2, 10000], ['assistant/message', 2, 10000], ['step/end', 2, 10000],
  ]);
});

test('mirror refuses cold conversations and malformed records', async () => {
  const f = fixture();
  const adapter = createSessionAdapter(f.ctx);
  await assert.rejects(adapter.call('mirror', { sessionId: 'missing', messages: [{ role: 'user', text: 'x' }] }),
    error => error.code === 'SESSION_NOT_LIVE');
  const { sessionId } = await f.ctx.sessionController.create({ cwd: '/tmp' });
  await assert.rejects(adapter.call('mirror', { sessionId, messages: [] }), /non-empty array/);
  await assert.rejects(adapter.call('mirror', { sessionId, messages: [{ role: 'system', text: 'x' }] }), /role/);
  await assert.rejects(adapter.call('mirror', { sessionId, messages: [{ role: 'user', text: '' }] }), /messages\[0\]\.text/);
});

async function mirrorEnvironment(t, { fromStart, initial }) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-mirror-'));
  const root = join(dir, 'state');
  const home = join(dir, 'codex-home');
  const day = join(home, 'sessions', '2026', '11', '02');
  await mkdir(day, { recursive: true });
  await mkdir(join(root, 'links'), { recursive: true });
  const f = fixture();
  const { sessionId } = await f.ctx.sessionController.create({ cwd: '/tmp' });
  const adapter = createSessionAdapter(f.ctx);
  const codexSessionId = `codex-${hash(dir).slice(0, 12)}`;
  const transcript = join(day, `rollout-2026-11-02T08-00-00-${codexSessionId}.jsonl`);
  await writeFile(transcript, initial.join('\n') + '\n');
  const link = { sessionId, codexSessionId, mirrorFromStart: fromStart, bindingId: 'binding' };
  await writeFile(join(root, 'links', `${hash(codexSessionId)}.json`), JSON.stringify(link));
  const watcher = createMirrorWatcher(adapter, { root, codexHome: home, ctx: f.ctx });
  t.after(async () => { watcher.stop(); await rm(dir, { recursive: true, force: true }); });
  return { f, adapter, watcher, transcript, codexSessionId, sessionId, root, link };
}

test('watcher mirrors new Codex records and resumes from the persisted offset', async t => {
  const e = await mirrorEnvironment(t, { fromStart: true, initial: [userLine('msg_u1', '历史提问'), assistantLine('msg_a1', '历史回复')] });
  await e.watcher.tick();
  const session = e.f.sessions.get(e.sessionId);
  assert.deepEqual(messageEvents(session).map(event => event.data.id ?? event.data.message.id), ['msg_u1', 'msg_a1']);
  assert.equal(session.events.filter(event => event.type === 'turn/start').length, 1);
  const before = session.events.length;
  await appendFile(e.transcript, `${userLine('msg_u2', '新的提问')}\n`);
  await e.watcher.tick();
  assert.equal(session.events.length, before + 1);
  assert.equal(session.events.filter(event => event.type === 'turn/start').length, 1);
  const state = JSON.parse(await readFile(mirrorStateFile(e.root, mirrorKey(e.link)), 'utf8'));
  assert.equal(state.path, e.transcript);
  assert.ok(state.offset > 0);
  await e.watcher.tick(); // No new bytes, no new events.
  assert.equal(session.events.length, before + 1);
});

test('default binding imports only future Codex records', async t => {
  const e = await mirrorEnvironment(t, { fromStart: false, initial: [userLine('msg_old', '绑定前的提问')] });
  await e.watcher.tick();
  assert.equal(e.f.sessions.get(e.sessionId).events.length, 0);
  await appendFile(e.transcript, `${userLine('msg_new', '绑定后的提问')}\n`);
  await e.watcher.tick();
  const events = messageEvents(e.f.sessions.get(e.sessionId));
  assert.deepEqual(events.map(event => event.data.id), ['msg_new']);
  assert.equal(events[0].data.content[0].text, '绑定后的提问');
});

test('links to closed conversations are skipped without reading or failing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-mirror-'));
  const f = fixture();
  const adapter = createSessionAdapter(f.ctx);
  const root = join(dir, 'state');
  await mkdir(join(root, 'links'), { recursive: true });
  await writeFile(join(root, 'links', 'stale.json'), JSON.stringify({ sessionId: 'closed', codexSessionId: 'codex-closed' }));
  await writeFile(join(root, 'links', 'legacy.json'), JSON.stringify({ sessionId: 'closed' }));
  const watcher = createMirrorWatcher(adapter, { root, codexHome: join(dir, 'codex-home'), ctx: f.ctx });
  t.after(async () => { watcher.stop(); await rm(dir, { recursive: true, force: true }); });
  await watcher.tick();
  await assert.rejects(readFile(mirrorStateFile(root, 'codex-closed\u0000closed'), 'utf8'), error => error.code === 'ENOENT');
});
