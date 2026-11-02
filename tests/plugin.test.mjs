import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { appCandidates } from '../scripts/platform.mjs';
import { addMarketplace } from '../scripts/install.mjs';
import { tools, validate, callTool } from '../plugins/deepseek-harness/server/tools.mjs';
import { hook } from '../plugins/deepseek-harness/hooks/sync.mjs';
import { bind, readLink } from '../plugins/deepseek-harness/server/links.mjs';

test('platform paths cover Windows, macOS, custom paths and redirected local data', () => {
  assert.ok(appCandidates('win32', { LOCALAPPDATA: 'C:\\Redirect' }, 'C:\\Users\\Person').includes('C:\\Users\\Person\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'));
  assert.deepEqual(appCandidates('darwin', {}, '/Users/person'), ['/Applications/DeepSeek Harness.app', '/Users/person/Applications/DeepSeek Harness.app']);
  assert.deepEqual(appCandidates('darwin', { DSH_DESKTOP_PATH: '/Custom/App.app' }, '/Users/person'), ['/Custom/App.app']);
});

test('marketplace install preserves unrelated entries, creates backup and is repeatable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-market-'));
  try {
    const file = join(home, '.agents', 'plugins', 'marketplace.json');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ name: 'existing', extra: true, plugins: [{ name: 'other' }] }));
    await addMarketplace(home, join(home, 'My Plugins', 'DeepSeek'));
    await addMarketplace(home, join(home, 'My Plugins', 'DeepSeek'));
    const market = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(market.name, 'existing'); assert.equal(market.extra, true);
    assert.equal(market.plugins.length, 2); assert.equal(market.plugins[0].name, 'other');
    assert.equal(market.plugins[1].source.path, './My Plugins/DeepSeek');
    await assert.rejects(addMarketplace(home, resolve(home, '..', 'outside')), /inside your home/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('tool validation rejects extra fields and requires idempotency IDs for sending', () => {
  assert.throws(() => validate('dsh_send', { sessionId: 's', text: 'hello' }), /requestId/);
  assert.throws(() => validate('dsh_status', { shell: 'anything' }), /Unknown argument/);
  assert.throws(() => validate('dsh_wait', { sessionId: 's', timeoutMs: 600001 }), /integer/);
  assert.equal(tools.length, 10);
});

test('conversation binding and hook import only deltas, isolate Codex chats and never call a model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-links-'));
  const previous = process.env.DSH_CODEX_DATA_DIR; process.env.DSH_CODEX_DATA_DIR = dir;
  const calls = [];
  const client = { async call(method, args) {
    calls.push([method, args]);
    return { sessionId: args.sessionId, cursor: 7, endSeq: 7, hasMore: false,
      entries: args.afterSeq === 7 ? [] : [{ seq: 7, type: 'assistant/message', data: { content: 'finished' } }] };
  } };
  try {
    await bind(client, 'codex-a', 'dsh-a', true);
    const result = await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'codex-a' }, client);
    assert.match(result.hookSpecificOutput.additionalContext, /finished/);
    assert.match(result.hookSpecificOutput.additionalContext, /untrusted external/);
    assert.equal((await readLink('codex-a')).cursor, 7);
    const empty = await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'codex-a' }, client);
    assert.deepEqual(empty, {});
    const other = await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'codex-b', prompt: 'Use DeepSeek' }, client);
    assert.doesNotMatch(other.hookSpecificOutput.additionalContext, /finished/);
    assert.equal(await readLink('codex-b'), null);
    assert.ok(calls.every(([method]) => method === 'sync'));
    await callTool(client, 'dsh_unbind', { codexSessionId: 'codex-a' });
    assert.equal(await readLink('codex-a'), null);
  } finally {
    if (previous === undefined) delete process.env.DSH_CODEX_DATA_DIR; else process.env.DSH_CODEX_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('stdio MCP negotiates, validates and responds to concurrent JSONL requests', async t => {
  const child = spawn(process.execPath, ['plugins/deepseek-harness/server/index.mjs'], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { child.kill(); });
  const messages = []; let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk;
    for (;;) { const n = pending.indexOf('\n'); if (n < 0) break; messages.push(JSON.parse(pending.slice(0, n))); pending = pending.slice(n + 1); }
  });
  child.stdin.write([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsh_send', arguments: {} } }),
    'invalid-json',
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
    JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: null }),
    '',
  ].join('\n'));
  const deadline = Date.now() + 4000;
  while (messages.length < 6 && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  assert.equal(messages.find(m => m.id === 1).result.protocolVersion, '2025-06-18');
  assert.equal(messages.find(m => m.id === 2).result.tools.length, 10);
  assert.equal(messages.find(m => m.id === 3).result.isError, true);
  assert.equal(messages.find(m => m.id === null).error.code, -32700);
  assert.deepEqual(messages.find(m => m.id === 4).result, {});
  assert.equal(messages.find(m => m.id === 5).error.code, -32602);
  child.stdin.end(); await once(child, 'exit');
});

test('portable and Codex manifests point to real packaged resources', async () => {
  const root = resolve('plugins/deepseek-harness');
  const portable = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  const legacy = JSON.parse(await readFile(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(portable.name, legacy.name); assert.equal(portable.version, legacy.version);
  for (const path of [legacy.mcpServers, legacy.hooks, './server/index.mjs', './bridge/cordis.patch.yml', './skills/deepseek-harness/SKILL.md']) await readFile(join(root, path));
  const skill = await readFile(join(root, 'skills/deepseek-harness/SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: deepseek-harness\r?\ndescription: [^\r\n]+\r?\n---/);
  assert.doesNotMatch(skill, /\[TODO:/);
});
