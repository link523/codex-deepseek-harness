import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, rmdir, stat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stateDirectory } from './client.mjs';

function linkFile(codexSessionId) {
  if (typeof codexSessionId !== 'string' || !codexSessionId.trim() || codexSessionId.length > 1000) throw new Error('A valid codexSessionId is required');
  return join(stateDirectory(), 'links', `${createHash('sha256').update(codexSessionId).digest('hex')}.json`);
}
export async function readLink(codexSessionId) {
  try { return JSON.parse(await readFile(linkFile(codexSessionId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Hooks and the MCP server are separate processes. Serialize only local file
// updates; never hold this lock while waiting for the App or a network response.
async function updateLink(codexSessionId, update) {
  const file = linkFile(codexSessionId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const owner = join(lock, `${process.pid}-${randomUUID()}`);
  const deadline = Date.now() + 1500;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Recover a terminated writer's lock, or an abandoned empty directory.
      try {
        const owners = await readdir(lock);
        for (const name of owners) {
          const pid = Number(name.split('-')[0]);
          if (!Number.isSafeInteger(pid) || pid <= 0) continue;
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') await unlink(join(lock, name)); }
        }
        if (owners.length || Date.now() - (await stat(lock)).mtimeMs > 30000) await rmdir(lock);
      } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      if (Date.now() >= deadline) throw new Error('Conversation link is busy; retry sync shortly');
      await delay(20);
    }
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(owner, '', { flag: 'wx', mode: 0o600 });
    const link = await update(await readLink(codexSessionId));
    if (link === undefined) return;
    await writeFile(temp, JSON.stringify(link), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
    await unlink(owner).catch(() => {});
    await rmdir(lock).catch(() => {});
  }
}
export async function writeLink(codexSessionId, link) {
  await updateLink(codexSessionId, () => link);
}
export async function commitCursor(codexSessionId, expected, cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < -1) throw new Error('Invalid sync cursor');
  await updateLink(codexSessionId, current => {
    if (!current || current.bindingId !== expected.bindingId || current.sessionId !== expected.sessionId
      || current.linkedAt !== expected.linkedAt) return;
    if (cursor > current.cursor) return { ...current, cursor };
  });
}
export async function bind(client, codexSessionId, sessionId, fromStart = false) {
  const snapshot = await client.call('sync', { sessionId, afterSeq: -1, limit: 1 });
  // codexSessionId and mirrorFromStart let the bridge extension locate the Codex
  // transcript and mirror its records into this conversation. Cursor matching in
  // commitCursor still uses bindingId/sessionId/linkedAt only.
  const link = { sessionId, codexSessionId, mirrorFromStart: fromStart === true,
    bindingId: randomUUID(), cursor: fromStart ? -1 : snapshot.endSeq, linkedAt: new Date().toISOString() };
  await writeLink(codexSessionId, link);
  return link;
}
