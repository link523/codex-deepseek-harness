import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fixture } from './fixture.mjs';
import { createSessionAdapter } from '../plugins/deepseek-harness/bridge/session-adapter.mjs';
import { BridgeClient } from '../plugins/deepseek-harness/server/client.mjs';
import { bind, readLink, writeLink, commitCursor } from '../plugins/deepseek-harness/server/links.mjs';
import { syncLinked, validate } from '../plugins/deepseek-harness/server/tools.mjs';

async function session() {
  const f = fixture();
  const { sessionId } = await f.ctx.sessionController.create({ workspaceId: 'test-workspace' });
  return { ...f, sessionId, adapter: createSessionAdapter(f.ctx) };
}

async function localState(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-regression-'));
  const values = { DSH_CODEX_DATA_DIR: dir, ...overrides };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('settled waits take two history snapshots across many intermediate events', async () => {
  const f = await session();
  const live = f.sessions.get(f.sessionId);
  for (let seq = 0; seq < 20000; seq++) live.events.push({ seq, type: 'provider/chunk', data: {} });
  f.agents.get(f.sessionId).status = 'running';
  f.append(f.sessionId, 'turn/start', {});
  let snapshots = 0;
  live.snapshotEvents = () => { snapshots++; return [...live.events]; };
  const waiting = f.adapter.call('wait', { sessionId: f.sessionId, timeoutMs: 2000 });
  for (let i = 0; i < 30; i++) {
    await setImmediate();
    f.append(f.sessionId, 'provider/chunk', {});
  }
  await setImmediate();
  f.agents.get(f.sessionId).status = 'idle';
  f.append(f.sessionId, 'turn/end', { reason: 'success' });
  assert.equal((await waiting).reason, 'idle');
  assert.equal(snapshots, 2);
  assert.equal(f.emitter.listenerCount('session/event'), 0);
});

test('incremental sync skips a 50000-event prefix with bounded indexed reads', async () => {
  const f = await session();
  const live = f.sessions.get(f.sessionId);
  for (let seq = 0; seq < 50000; seq++) live.events.push({ seq, type: 'assistant/message', data: { content: 'old' } });
  f.append(f.sessionId, 'turn/end', {});
  let reads = 0;
  live.snapshotEvents = () => new Proxy(live.events, { get(target, key, receiver) {
    if (/^\d+$/.test(String(key))) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const result = await f.adapter.call('sync', { sessionId: f.sessionId, afterSeq: 49995 });
  assert.equal(result.entries.length, 5);
  assert.equal(result.cursor, 50000);
  assert.ok(reads < 100, `Indexed history reads: ${reads}`);
});

test('message waits detect a new message beyond the first returned page', async () => {
  const f = await session();
  f.agents.get(f.sessionId).status = 'running';
  for (let i = 0; i < 10; i++) f.append(f.sessionId, 'turn/start', {});
  f.append(f.sessionId, 'assistant/message', { content: 'new answer' });
  const result = await f.adapter.call('wait', { sessionId: f.sessionId, until: 'message', limit: 1, timeoutMs: 0 });
  assert.equal(result.reason, 'message');
  assert.equal(result.hasMore, true);
});

test('queued work remains pending even while its agent is unavailable', async () => {
  const f = await session();
  f.agents.delete(f.sessionId);
  f.ctx.sessionProjections.snapshot = () => ({ values: { inbox: { 'next-turn': [{}] } } });
  const result = await f.adapter.call('wait', { sessionId: f.sessionId, timeoutMs: 0 });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.state.queuedCount, 1);
});

test('an unavailable legacy gateway does not break sync', async () => {
  const f = await session();
  Object.defineProperty(f.ctx, 'typertGateway', { get() { throw new Error('Service not injected'); } });
  const result = await f.adapter.call('sync', { sessionId: f.sessionId });
  assert.deepEqual(result.state.pendingInput, []);
});

test('a task starting during the final snapshot is not reported as idle', async () => {
  const f = await session();
  let snapshots = 0;
  const live = f.sessions.get(f.sessionId);
  live.snapshotEvents = () => {
    if (++snapshots === 2) {
      f.agents.get(f.sessionId).status = 'running';
      f.append(f.sessionId, 'turn/start', {});
    }
    return [...live.events];
  };
  const result = await f.adapter.call('wait', { sessionId: f.sessionId, timeoutMs: 0 });
  assert.equal(result.reason, 'timeout');
  assert.equal(result.state.running, true);
});

const stub = { async call(method, args) {
  return { sessionId: args.sessionId, endSeq: 10, cursor: 7, entries: [], hasMore: false };
} };

test('a delayed sync cannot resurrect an unbound conversation or overwrite a new binding', async t => {
  await localState(t);
  await bind(stub, 'codex', 'first', true);
  const old = await syncLinked(stub, 'codex');
  await writeLink('codex', null);
  await old.commit();
  assert.equal(await readLink('codex'), null);
  await bind(stub, 'codex', 'first', true);
  const rebound = await readLink('codex');
  await old.commit();
  assert.deepEqual(await readLink('codex'), rebound);
});

test('out-of-order sync completion cannot move a cursor backward', async t => {
  await localState(t);
  const link = await bind(stub, 'codex', 'session', true);
  await commitCursor('codex', link, 9);
  await commitCursor('codex', link, 4);
  assert.equal((await readLink('codex')).cursor, 9);
});

test('cursor commits from independent processes remain monotonic', async t => {
  await localState(t);
  const link = await bind(stub, 'codex', 'session', true);
  const moduleURL = pathToFileURL(resolve('plugins/deepseek-harness/server/links.mjs')).href;
  await Promise.all([8, 1, 7, 3, 2, 6, 4, 5].map(cursor => new Promise((done, reject) => {
    const source = `import { commitCursor } from ${JSON.stringify(moduleURL)}; await commitCursor('codex', ${JSON.stringify(link)}, ${cursor});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done() : reject(new Error(errors || `exit ${code}`)));
  })));
  assert.equal((await readLink('codex')).cursor, 8);
});

test('cursor updates recover a lock left by a terminated writer', async t => {
  const dir = await localState(t);
  const link = await bind(stub, 'codex', 'session', true);
  const hash = createHash('sha256').update('codex').digest('hex');
  const lock = join(dir, 'links', `${hash}.json.lock`);
  await mkdir(lock);
  await writeFile(join(lock, '2147483647-terminated'), '');
  await commitCursor('codex', link, 3);
  assert.equal((await readLink('codex')).cursor, 3);
});

test('moving link data does not move bridge discovery', async t => {
  const dir = await localState(t, { DSH_HOME: join(tmpdir(), 'dsh-home-test'), DSH_CODEX_CONNECTION_FILE: undefined });
  assert.equal(new BridgeClient().file, join(process.env.DSH_HOME, 'codex-bridge', 'connection.json'));
  assert.ok(!new BridgeClient().file.startsWith(dir));
});

test('timeouts cover response bodies and retain safe send-retry guidance', async t => {
  const dir = await localState(t);
  const server = createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { const closed = new Promise(done => server.close(done)); server.closeAllConnections(); await closed; });
  const file = join(dir, 'connection.json');
  await writeFile(file, JSON.stringify({ protocol: 1, host: '127.0.0.1', port: server.address().port, token: 'a'.repeat(64) }));
  const client = new BridgeClient({ file, autoLaunch: false });
  await assert.rejects(client.call('send', {}, { timeoutMs: 50 }), error => {
    assert.equal(error.code, 'TIMEOUT');
    assert.match(error.message, /same requestId/);
    return true;
  });
});

test('tool validation rejects keys inherited from Object.prototype', () => {
  assert.throws(() => validate('dsh_status', { toString: 'unexpected' }), /Unknown argument/);
});
