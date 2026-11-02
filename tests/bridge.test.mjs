import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fixture } from './fixture.mjs';
import { createSessionAdapter } from '../plugins/deepseek-harness/bridge/session-adapter.mjs';
import { startBridge } from '../plugins/deepseek-harness/bridge/index.mjs';
import { BridgeClient } from '../plugins/deepseek-harness/server/client.mjs';

async function environment(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-dsh-'));
  const f = fixture(); const adapter = createSessionAdapter(f.ctx);
  const file = join(dir, 'connection.json');
  const bridge = await startBridge(adapter, { file });
  const client = new BridgeClient({ file });
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...f, dir, file, bridge, client, adapter };
}

test('authenticated native bridge runs tasks in desktop-visible workspaces', async t => {
  const e = await environment(t);
  assert.equal((await e.client.call('health')).protocol, 1);
  const { sessionId } = await e.client.call('create', { cwd: e.dir, title: 'Windows 中文 / macOS' });
  assert.equal(e.workspaces.length, 1);
  assert.equal(e.calls.find(c => c[0] === 'create')[1].workspaceId, e.workspaces[0].id);
  const args = { sessionId, text: 'quote " $(literal) & 中文\nnext line', requestId: 'request-1' };
  await e.client.call('send', args); await e.client.call('send', args);
  const result = await e.client.call('sync', { sessionId });
  assert.equal(result.entries.filter(e => e.type === 'user/message').length, 1);
  assert.equal(result.entries[0].data.content[0].text, args.text);
  assert.equal(result.state.running, true);
  const cancelled = await e.client.call('cancel', { sessionId });
  assert.match(cancelled.note, /queued messages/);
});

test('origin, host and authentication checks reject untrusted requests', async t => {
  const e = await environment(t);
  const url = `http://127.0.0.1:${e.bridge.connection.port}/v1/call`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${e.bridge.connection.token}` };
  const request = headers => new Promise((done, reject) => {
    const req = httpRequest(url, { method: 'POST', headers }, res => {
      res.resume(); res.on('end', () => done({ status: res.statusCode }));
    });
    req.on('error', reject); req.end(JSON.stringify({ method: 'health' }));
  });
  assert.equal((await request({ 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await request({ ...headers, Origin: 'https://example.com' })).status, 403);
  assert.equal((await request({ ...headers, Host: 'attacker.example' })).status, 403);
  assert.equal((await request({ ...headers, 'Sec-Fetch-Site': 'same-origin' })).status, 403);
  assert.equal((await request(headers)).status, 200);
  if (process.platform !== 'win32') assert.equal((await stat(e.file)).mode & 0o777, 0o600);
});

test('discovery is loopback-only and stale connection metadata is removed on close', async t => {
  const e = await environment(t);
  assert.equal(e.bridge.connection.host, '127.0.0.1');
  const original = await readFile(e.file, 'utf8');
  await writeFile(e.file, original.replace('127.0.0.1', 'example.com'));
  await assert.rejects(e.client.call('health'), /Invalid local bridge/);
  await writeFile(e.file, original);
  await e.bridge.close();
  await assert.rejects(readFile(e.file), { code: 'ENOENT' });
});

test('sync paginates forward without losing messages or repeating whole histories', async t => {
  const e = await environment(t);
  const { sessionId } = await e.client.call('create', { cwd: e.dir });
  e.append(sessionId, 'request/header', { Authorization: 'NEVER_EXPOSE' });
  for (let i = 0; i < 12; i++) e.append(sessionId, 'assistant/message', { content: [{ type: 'text', text: `message ${i}` }, { type: 'reasoning', text: 'PRIVATE_REASONING' }] });
  e.append(sessionId, 'tool/result', { secret: 'TOOL_DETAIL' });
  let cursor = -1; const all = [];
  for (;;) {
    const result = await e.client.call('sync', { sessionId, afterSeq: cursor, limit: 3 });
    assert.ok(result.cursor > cursor); cursor = result.cursor;
    all.push(...result.entries);
    assert.doesNotMatch(JSON.stringify(result), /NEVER_EXPOSE|PRIVATE_REASONING|TOOL_DETAIL/);
    if (!result.hasMore) break;
  }
  assert.equal(all.length, 12);
  assert.equal(new Set(all.map(e => e.seq)).size, 12);
  assert.equal((await e.client.call('sync', { sessionId, afterSeq: cursor })).entries.length, 0);
});

test('oversize events return an explicit truncated preview and a usable cursor', async t => {
  const e = await environment(t);
  const { sessionId } = await e.client.call('create', { cwd: e.dir });
  e.append(sessionId, 'assistant/message', { content: 'x'.repeat(10000) });
  const value = await e.client.call('sync', { sessionId, maxChars: 1000 });
  assert.equal(value.entries[0].truncated, true);
  assert.equal(value.cursor, 0);
  assert.ok(JSON.stringify(value.entries).length < 1200);
});

test('settled wait holds intermediate messages locally and returns only on completion', async t => {
  const e = await environment(t);
  const { sessionId } = await e.client.call('create', { cwd: e.dir });
  await e.client.call('send', { sessionId, text: 'task', requestId: 'wait-task' });
  let returned = false;
  const promise = e.client.call('wait', { sessionId, timeoutMs: 2000 }).then(v => { returned = true; return v; });
  await new Promise(done => setTimeout(done, 20));
  e.append(sessionId, 'assistant/message', { content: 'intermediate' });
  await new Promise(done => setTimeout(done, 30));
  assert.equal(returned, false);
  e.agents.get(sessionId).status = 'idle';
  e.append(sessionId, 'turn/end', { reason: 'success' });
  const value = await promise;
  assert.equal(value.reason, 'idle'); assert.equal(value.state.running, false);
  assert.equal(e.emitter.listenerCount('session/event'), 0);
});

test('pending approvals return input-required without auto-approving', async t => {
  const e = await environment(t);
  const { sessionId } = await e.client.call('create', { cwd: e.dir });
  await e.client.call('send', { sessionId, text: 'task', requestId: 'approval-task' });
  e.ctx.typertGateway.pendingRemoteEvents.set('approval', { frame: { agentId: sessionId, event: 'permission/ask', request: { command: 'example' } } });
  const value = await e.client.call('wait', { sessionId, timeoutMs: 1000 });
  assert.equal(value.reason, 'input-required'); assert.equal(value.state.pendingInput.length, 1);
  assert.equal(e.ctx.typertGateway.pendingRemoteEvents.size, 1);
});

test('wait timeout is explicit and cancellation releases event subscriptions', async t => {
  const e = await environment(t);
  const { sessionId } = await e.client.call('create', { cwd: e.dir });
  await e.client.call('send', { sessionId, text: 'task', requestId: 'cancel-wait' });
  const timeout = await e.client.call('wait', { sessionId, timeoutMs: 10 });
  assert.equal(timeout.reason, 'timeout'); assert.equal(timeout.state.running, true);
  const controller = new AbortController();
  const pending = e.adapter.call('wait', { sessionId, timeoutMs: 3000 }, controller.signal);
  controller.abort(new Error('test cancellation'));
  await assert.rejects(pending, /test cancellation/);
  assert.equal(e.emitter.listenerCount('session/event'), 0);
});

test('bridge validates arguments before mutating sessions', async t => {
  const e = await environment(t);
  await assert.rejects(e.client.call('create', { cwd: 'relative' }), /absolute path/);
  await assert.rejects(e.client.call('create', {}), /workspaceId/);
  await assert.rejects(e.client.call('create', { cwd: e.dir, workspaceId: 'both' }), /not both/);
  await assert.rejects(e.client.call('send', { sessionId: 'no-session', text: ' ', mode: 'queue' }), /text must/);
  await assert.rejects(e.client.call('wait', { sessionId: 's', timeoutMs: -1 }), /timeoutMs/);
  assert.equal(e.sessions.size, 0);
});

test('queued-but-not-yet-running work is not reported as completed', async t => {
  const e = await environment(t);
  const { sessionId } = await e.client.call('create', { cwd: e.dir });
  e.ctx.sessionProjections.snapshot = () => ({ values: { inbox: { 'next-turn': [{ id: 'pending' }], 'next-step': [] } } });
  const result = await e.client.call('wait', { sessionId, timeoutMs: 10 });
  assert.equal(result.reason, 'timeout'); assert.equal(result.state.queuedCount, 1);
});

test('actual desktop assistant envelope omits provider stream and reasoning', async t => {
  const e = await environment(t);
  const { sessionId } = await e.client.call('create', { cwd: e.dir });
  e.append(sessionId, 'assistant/message', { turn: 1, step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'visible answer' }, { type: 'reasoning', text: 'hidden' }], source: { provider: 'account' } },
    stream: ['PRIVATE_STREAM'] });
  const result = await e.client.call('sync', { sessionId });
  assert.equal(result.entries[0].data.content[0].text, 'visible answer');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STREAM|hidden/);
});
