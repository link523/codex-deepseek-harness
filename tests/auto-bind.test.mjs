import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseSession } from '../plugins/deepseek-harness/server/auto-bind.mjs';

test('chooseSession prefers a running conversation in the same workspace', async () => {
  const now = Date.now();
  const result = await chooseSession([
    { sessionId: 'old', cwd: '/tmp/workspace-a', running: false, updatedAt: now - 2 * 60 * 60 * 1000 },
    { sessionId: 'running', cwd: '/tmp/workspace-a', running: true, updatedAt: now - 60 * 1000 },
    { sessionId: 'other', cwd: '/tmp/workspace-b', running: true, updatedAt: now },
  ], '/tmp/workspace-a', now);
  assert.equal(result.session.sessionId, 'running');
  assert.equal(result.candidates.length, 1);
});

test('chooseSession leaves two equally recent idle conversations unbound', async () => {
  const now = Date.now();
  const result = await chooseSession([
    { sessionId: 'a', cwd: '/tmp/workspace-a', running: false, updatedAt: now - 1000 },
    { sessionId: 'b', cwd: '/tmp/workspace-a', running: false, updatedAt: now - 2000 },
  ], '/tmp/workspace-a', now);
  assert.equal(result.session, null);
  assert.equal(result.candidates.length, 2);
});

test('chooseSession ignores conversations in another workspace', async () => {
  const now = Date.now();
  const result = await chooseSession([
    { sessionId: 'a', cwd: '/tmp/workspace-b', running: true, updatedAt: now },
  ], '/tmp/workspace-a', now);
  assert.equal(result.session, null);
  assert.deepEqual(result.candidates, []);
});

test('chooseSession does not bind an old idle conversation', async () => {
  const now = Date.now();
  const result = await chooseSession([
    { sessionId: 'old', cwd: '/tmp/workspace-a', running: false, updatedAt: now - 3 * 60 * 60 * 1000 },
  ], '/tmp/workspace-a', now);
  assert.equal(result.session, null);
  assert.equal(result.candidates.length, 1);
});
