// Codex → DeepSeek record mirror.
//
// The plugin's hook already copies new DeepSeek messages into Codex. This module
// covers the other direction without importing anything from the Codex plugin:
// it reads the link files written by `dsh_bind`, tails the matching Codex rollout
// transcript and appends the user/assistant messages to the live DeepSeek
// session through the bridge adapter.
import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MIRROR_INTERVAL_MS = 3000;
export const MAX_BATCH = 25;
export const MAX_TEXT = 100000;

export function bridgeStateRoot() {
  return process.env.DSH_CODEX_DATA_DIR
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'codex-bridge');
}
export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}
const digest = value => createHash('sha256').update(value).digest('hex');
// One Codex transcript can be linked to more than one DeepSeek conversation,
// so the tail offset belongs to the pair rather than to the transcript alone.
export const mirrorKey = link => `${link.codexSessionId}\u0000${link.sessionId}`;
export const mirrorStateFile = (root, key) => join(root, 'mirror', `${digest(key)}.json`);

function messageText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part?.text === 'string' && part.text.trim()) parts.push(part.text);
  }
  return parts.join('\n');
}

// Codex stores one JSON record per line. Only response_item messages are
// conversation; developer prompts, hook context, environment injections and
// tool traffic stay in Codex so the DeepSeek history keeps the same shape as a
// normal chat. User records must carry the `user.text` kind because Codex also
// writes environment context as a `user` role message.
export function transcriptMessages(lines) {
  const messages = [];
  for (const line of lines) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'response_item' || record.payload?.type !== 'message') continue;
    const payload = record.payload;
    const role = payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const metadata = payload.internal_chat_message_metadata_passthrough ?? {};
    const kinds = Array.isArray(metadata.content_item_kinds) ? metadata.content_item_kinds : [];
    if (role === 'user' && kinds.length && !kinds.includes('user.text')) continue;
    if (role === 'assistant' && kinds.includes('hooks.additional_context')) continue;
    let text = messageText(payload.content);
    if (!text) continue;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    const id = typeof payload.id === 'string' && payload.id
      ? payload.id
      : `codex-${digest(`${record.timestamp ?? ''}|${text}`).slice(0, 24)}`;
    const turnId = typeof metadata.turn_id === 'string' && metadata.turn_id ? metadata.turn_id : undefined;
    messages.push({ id, role, text, ...(turnId ? { turnId } : {}) });
  }
  return messages;
}

async function readLinks(root) {
  const directory = join(root, 'links');
  let names;
  try { names = await readdir(directory); } catch { return []; }
  const links = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const link = JSON.parse(await readFile(join(directory, name), 'utf8'));
      // Links written before reverse sync lack codexSessionId; ignore them here.
      if (typeof link?.sessionId !== 'string' || typeof link?.codexSessionId !== 'string') continue;
      links.push(link);
    } catch { /* A half-written or unrelated file must not stop other links. */ }
  }
  return links;
}

async function readState(root, key) {
  try {
    const value = JSON.parse(await readFile(mirrorStateFile(root, key), 'utf8'));
    if (typeof value?.path === 'string' && Number.isSafeInteger(value.offset)) return { path: value.path, offset: value.offset };
  } catch { /* First run, or the state file was removed. */ }
  return null;
}

async function writeState(root, key, value) {
  const file = mirrorStateFile(root, key);
  try {
    await mkdir(join(root, 'mirror'), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  } catch { /* Losing the offset only costs a re-read; message IDs deduplicate. */ }
}

// Rollout files are named after the Codex session that owns them, so the newest
// matching file is the live transcript even after a resume.
async function findTranscript(home, codexSessionId) {
  const directory = join(home, 'sessions');
  let entries;
  try { entries = await readdir(directory, { recursive: true, withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
    if (!entry.name.includes(codexSessionId)) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && (!best || info.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: info.mtimeMs, size: info.size };
  }
  return best;
}

export function createMirrorWatcher(adapter, options = {}) {
  const root = options.root ?? bridgeStateRoot();
  const home = options.codexHome ?? codexHome();
  const intervalMs = options.intervalMs ?? MIRROR_INTERVAL_MS;
  const logger = options.logger;
  const ctx = options.ctx;
  const state = new Map(); // mirrorKey(link) -> { path, offset }
  let timer = null;
  let ticking = false;
  let stopped = false;

  async function processLink(link) {
    // A cold DeepSeek conversation has no live event log to append to; the
    // offset stays put and mirroring resumes when the app opens the session.
    if (ctx && !ctx.sessions.get(link.sessionId)) return;
    const key = mirrorKey(link);
    let mirror = state.get(key);
    if (!mirror) {
      mirror = await readState(root, key) ?? { path: null, offset: 0 };
      state.set(key, mirror);
    }
    if (!mirror.path) {
      const found = await findTranscript(home, link.codexSessionId);
      if (!found) return;
      mirror.path = found.path;
      // Old history is opt-in: start at the current end of the transcript.
      if (mirror.offset === 0 && link.mirrorFromStart !== true) mirror.offset = found.size;
    }
    const info = await stat(mirror.path).catch(() => null);
    if (!info) { mirror.path = null; return; }
    if (info.size < mirror.offset) mirror.offset = 0; // Transcript was rewritten.
    if (info.size === mirror.offset) return;
    const handle = await open(mirror.path, 'r');
    let consumed = 0;
    let messages = [];
    try {
      const length = info.size - mirror.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, mirror.offset);
      const text = buffer.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) return; // Wait for a complete line; the next tick retries.
      const chunk = text.slice(0, end + 1);
      consumed = Buffer.byteLength(chunk, 'utf8');
      messages = transcriptMessages(chunk.split('\n'));
    } finally { await handle.close(); }
    // Keep the offset on failure so the same records are retried next tick.
    for (let index = 0; index < messages.length; index += MAX_BATCH) {
      await adapter.call('mirror', { sessionId: link.sessionId, messages: messages.slice(index, index + MAX_BATCH) });
    }
    mirror.offset += consumed;
    await writeState(root, key, mirror);
  }

  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const links = await readLinks(root);
      const active = new Set(links.map(mirrorKey));
      for (const key of state.keys()) if (!active.has(key)) state.delete(key);
      for (const link of links) {
        try { await processLink(link); }
        catch (error) { logger?.warn?.(`Codex record mirror skipped one link: ${error.message}`); }
      }
    } finally { ticking = false; }
  }

  function start() {
    if (timer || stopped) return;
    timer = setInterval(() => { tick().catch(error => logger?.warn?.(`Codex record mirror failed: ${error.message}`)); }, intervalMs);
    timer.unref?.();
    setTimeout(() => { tick().catch(() => {}); }, 250).unref?.();
  }
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop };
}
