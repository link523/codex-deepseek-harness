// Automatic Codex -> DeepSeek conversation linking.
//
// A Codex session starts in a working directory. If exactly one recent DeepSeek
// conversation belongs to the same directory, bind them so the next prompt
// imports the conversation. Ambiguous matches stay unbound; the user can still
// call dsh_bind explicitly.
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bind, readLink } from './links.mjs';

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const AMBIGUOUS_WINDOW_MS = 60 * 1000;

async function normalizePath(path) {
  try { return await realpath(path); }
  catch { return resolve(path); }
}

function timestamp(item) {
  if (typeof item?.updatedAt === 'number') return item.updatedAt;
  const value = Date.parse(item?.updatedAt ?? '');
  return Number.isFinite(value) ? value : 0;
}

export async function chooseSession(items, cwd, now = Date.now(), maxAge = DEFAULT_MAX_AGE_MS) {
  const target = await normalizePath(cwd);
  const same = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.sessionId !== 'string' || typeof item?.cwd !== 'string') continue;
    if (await normalizePath(item.cwd) !== target) continue;
    same.push(item);
  }
  if (!same.length) return { session: null, candidates: [] };
  const fresh = same.filter(item => item.running || (timestamp(item) && now - timestamp(item) <= maxAge));
  if (!fresh.length) return { session: null, candidates: same.slice(0, 5) };
  const pool = fresh
    .sort((a, b) => Number(b.running) - Number(a.running) || timestamp(b) - timestamp(a));
  const top = pool[0];
  if (pool.length > 1 && !top.running && timestamp(top) - timestamp(pool[1]) < AMBIGUOUS_WINDOW_MS) {
    return { session: null, candidates: pool.slice(0, 5) };
  }
  return { session: top, candidates: pool.slice(0, 5) };
}

export async function autoBind(client, input) {
  if (typeof input?.session_id !== 'string' || !input.session_id.trim()) return null;
  if (typeof input?.cwd !== 'string' || !input.cwd.trim()) return null;
  const existing = await readLink(input.session_id);
  if (existing) return { link: existing, created: false };
  let result;
  try { result = await client.call('list', { limit: 100 }, { timeoutMs: 2000 }); }
  catch { return null; }
  const { session, candidates } = await chooseSession(result.items ?? [], input.cwd);
  if (!session) return { created: false, candidates };
  const link = await bind(client, input.session_id, session.sessionId,
    { fromStart: true, mirrorFromStart: false, timeoutMs: 2000 });
  return { link, created: true, session };
}
