import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './fixture.mjs';
import { createSessionAdapter } from '../plugins/deepseek-harness/bridge/session-adapter.mjs';
import { startBridge } from '../plugins/deepseek-harness/bridge/index.mjs';
import { BridgeClient } from '../plugins/deepseek-harness/server/client.mjs';
import { launchSpec } from '../plugins/deepseek-harness/server/desktop.mjs';
import { writeLink } from '../plugins/deepseek-harness/server/links.mjs';
import { hook } from '../plugins/deepseek-harness/hooks/sync.mjs';

async function environment(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-start-'));
  const f = fixture(); const adapter = createSessionAdapter(f.ctx);
  const file = join(dir, 'connection.json'); const bridges = [];
  t.after(async () => { for (const bridge of bridges) await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  async function open() { const bridge = await startBridge(adapter, { file }); bridges.push(bridge); return bridge; }
  return { ...f, adapter, dir, file, open };
}

test('an already-connected App is used without launching it again', async t => {
  const e = await environment(t); await e.open();
  let launches = 0;
  const client = new BridgeClient({ file: e.file, launch: async () => { launches++; } });
  assert.equal((await client.call('health')).protocol, 1);
  assert.ok(Array.isArray((await client.call('list')).items));
  assert.equal(launches, 0);
});

test('concurrent cold-start calls launch once, wait for readiness, and send the original task once', async t => {
  const e = await environment(t);
  const { sessionId } = await e.ctx.sessionController.create({ workspaceId: 'test' });
  let launches = 0;
  const client = new BridgeClient({ file: e.file, pollIntervalMs: 2, launch: async () => { launches++; await delay(20); await e.open(); } });
  const args = { sessionId, requestId: 'cold-send', text: 'original task' };
  const [health, sent, listed] = await Promise.all([client.call('health'), client.call('send', args), client.call('list')]);
  assert.equal(launches, 1);
  assert.equal(health.protocol, 1); assert.equal(sent.requestId, args.requestId); assert.equal(listed.items.length, 1);
  const prompts = e.calls.filter(([method]) => method === 'prompt');
  assert.equal(prompts.length, 1); assert.equal(prompts[0][1].content[0].text, args.text);
});

test('stale discovery after an App exit is replaced during automatic startup', async t => {
  const e = await environment(t); const old = await e.open();
  await old.close(); await writeFile(e.file, JSON.stringify(old.connection));
  let launches = 0;
  const client = new BridgeClient({ file: e.file, launch: async () => { launches++; await e.open(); } });
  assert.equal((await client.call('health')).protocol, 1);
  assert.equal(launches, 1);
});

test('startup has a bounded timeout and leaves the requested task unsent', async t => {
  const e = await environment(t); let launches = 0;
  const client = new BridgeClient({ file: e.file, startupTimeoutMs: 30, pollIntervalMs: 2, launch: async () => { launches++; } });
  await assert.rejects(client.call('send', { sessionId: 's', requestId: 'r', text: 'task' }), error => {
    assert.equal(error.code, 'STARTUP_TIMEOUT'); assert.match(error.message, /not sent/); return true;
  });
  assert.equal(launches, 1); assert.equal(e.calls.length, 0);
});

test('cancelling one startup waiter does not cancel another or submit the cancelled operation', async t => {
  const e = await environment(t); let launches = 0; let started;
  const entered = new Promise(done => { started = done; });
  const client = new BridgeClient({ file: e.file, pollIntervalMs: 2, launch: async () => { launches++; started(); await delay(30); await e.open(); } });
  const controller = new AbortController();
  const cancelled = assert.rejects(client.call('create', { workspaceId: 'test' }, { signal: controller.signal }), { code: 'CANCELLED' });
  await entered;
  const other = client.call('list'); controller.abort();
  await cancelled;
  assert.deepEqual((await other).items, []); assert.equal(launches, 1); assert.equal(e.calls.length, 0);
});

test('an already-cancelled call does not launch the App', async t => {
  const e = await environment(t); let launches = 0;
  const controller = new AbortController(); controller.abort();
  const client = new BridgeClient({ file: e.file, launch: async () => { launches++; } });
  await assert.rejects(client.call('health', {}, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(launches, 0);
});

test('background prompt sync does not open a closed App', async t => {
  const e = await environment(t);
  const original = { data: process.env.DSH_CODEX_DATA_DIR, file: process.env.DSH_CODEX_CONNECTION_FILE };
  process.env.DSH_CODEX_DATA_DIR = e.dir; process.env.DSH_CODEX_CONNECTION_FILE = e.file;
  let launches = 0; const prior = BridgeClient.prototype.startDesktop;
  BridgeClient.prototype.startDesktop = async () => { launches++; throw new Error('Should not start'); };
  try {
    await writeLink('background-chat', { sessionId: 's', cursor: -1, linkedAt: 'test', bindingId: 'test' });
    assert.deepEqual(await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'background-chat', prompt: 'hello' }), {});
    assert.equal(launches, 0);
  } finally {
    BridgeClient.prototype.startDesktop = prior;
    if (original.data === undefined) delete process.env.DSH_CODEX_DATA_DIR; else process.env.DSH_CODEX_DATA_DIR = original.data;
    if (original.file === undefined) delete process.env.DSH_CODEX_CONNECTION_FILE; else process.env.DSH_CODEX_CONNECTION_FILE = original.file;
  }
});

test('an uncertain send failure is not replayed and does not launch another App', async t => {
  const e = await environment(t); let sends = 0; let launches = 0;
  const server = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk;
    if (JSON.parse(input).method === 'health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result: { protocol: 1 } })); }
    else { sends++; req.socket.destroy(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { const closed = new Promise(done => server.close(done)); server.closeAllConnections(); await closed; });
  await writeFile(e.file, JSON.stringify({ protocol: 1, host: '127.0.0.1', port: server.address().port, token: 'a'.repeat(64) }));
  const client = new BridgeClient({ file: e.file, launch: async () => { launches++; } });
  await assert.rejects(client.call('send', { sessionId: 's', requestId: 'r', text: 'task' }), { code: 'BRIDGE_UNREACHABLE' });
  assert.equal(sends, 1); assert.equal(launches, 0);
});

test('invalid discovery data is reported without launching the App', async t => {
  const e = await environment(t); let launches = 0;
  await writeFile(e.file, 'invalid-json');
  const client = new BridgeClient({ file: e.file, launch: async () => { launches++; } });
  await assert.rejects(client.call('health'), { code: 'INVALID_CONNECTION' });
  assert.equal(launches, 0);
});

test('cold-start waits stay within the original total request budget', async t => {
  const e = await environment(t); const { sessionId } = await e.ctx.sessionController.create({ workspaceId: 'test' });
  e.agents.get(sessionId).status = 'running';
  const client = new BridgeClient({ file: e.file, launch: async () => { await delay(20); await e.open(); } });
  const result = await client.call('wait', { sessionId, timeoutMs: 1000 }, { timeoutMs: 200 });
  assert.equal(result.reason, 'timeout'); assert.equal(result.state.running, true);
});

test('desktop launch uses literal paths on macOS and Windows', () => {
  assert.deepEqual(launchSpec('/Applications/DeepSeek Harness 中文.app', 'darwin'), { command: '/usr/bin/open', args: ['-a', '/Applications/DeepSeek Harness 中文.app'], detached: false });
  const path = 'C:\\Apps\\DSH & literal\\DeepSeek Harness.exe';
  assert.deepEqual(launchSpec(path, 'win32'), { command: path, args: [], detached: true });
});
