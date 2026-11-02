import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const invalid = message => { throw new BridgeError('INVALID_ARGUMENT', message); };
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  return value;
}
export function string(value, field, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    invalid(`${field} must be non-empty text (maximum ${max} characters)`);
  }
  return value;
}
export function integer(value, field, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${field} must be between ${min} and ${max}`);
  return value;
}

// Never return provider request headers or private reasoning in a conversation sync.
// Raw tool output is opt-in; it may be large and is unnecessary for ordinary waiting.
const conversationTypes = new Set(['user/message', 'assistant/message', 'turn/start', 'turn/end', 'agent/error']);
const detailTypes = new Set(['tool/call', 'tool/result', 'assistant/attempt']);
function cleanContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.filter(part => !['reasoning', 'thinking'].includes(part?.type)).map(part => {
    if (part?.type === 'text') return { type: 'text', text: part.text };
    return { type: part?.type ?? 'unknown', omitted: true };
  });
}
// Records mirrored from Codex carry a marker so they are never sent back to
// Codex by dsh_sync or dsh_wait; that direction already has the real history.
// Mirrored prompts keep source.kind "user" so the desktop app renders them as
// human input; the extra marker keeps them distinguishable from real prompts.
function isMirrored(event) {
  if (event.type === 'user/message') {
    const source = event.data?.source;
    return source?.mirror === 'codex' || source?.kind === 'codex';
  }
  if (event.type === 'assistant/message') return event.data?.message?.source?.provider === 'codex';
  return false;
}
function publicEvent(event, detail) {
  if (!conversationTypes.has(event.type) && !(detail && detailTypes.has(event.type))) return null;
  if (isMirrored(event)) return null;
  let data = event.data;
  if (event.type === 'assistant/message' || event.type === 'user/message') {
    const message = data.message ?? data;
    data = { role: event.type === 'user/message' ? 'user' : 'assistant', content: cleanContent(message.content) };
  }
  return {
    seq: event.seq, type: event.type, time: event.time, data,
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }),
  };
}

export function createSessionAdapter(ctx) {
  const api = ctx.sessionController;
  for (const method of ['create', 'prompt', 'cancel', 'list', 'projections']) {
    if (typeof api?.[method] !== 'function') throw new BridgeError('INCOMPATIBLE_DSH', `Missing sessionController.${method}; update DeepSeek Harness`);
  }

  // Turn boundaries this adapter opened itself for imported records. They stay
  // out of DSH -> Codex sync, which only needs the conversation content.
  const syntheticTurns = new Set();
  const isMirroredBoundary = event =>
    (event.type === 'turn/start' || event.type === 'turn/end') && syntheticTurns.has(event.data?.turn);

  async function snapshot(sessionId, signal) {
    signal.throwIfAborted();
    const live = ctx.sessions.get(sessionId);
    if (live) return { header: live.header, events: live.snapshotEvents() };
    const observation = await ctx.sessionQuery.observeSession(sessionId, { signal });
    try { return { header: observation.header, events: [...observation.events] }; }
    finally { observation[Symbol.dispose](); }
  }

  function state(sessionId, events) {
    const agent = ctx.agents.get(sessionId);
    const live = ctx.sessions.get(sessionId);
    const inbox = live ? ctx.sessionProjections?.snapshot(live)?.values?.inbox : null;
    const queuedCount = inbox ? (inbox['next-turn']?.length ?? 0) + (inbox['next-step']?.length ?? 0) : 0;
    // Older desktop builds expose these pending events; newer contexts may not inject the gateway.
    let pending = [];
    try {
      const gateway = ctx.typertGateway;
      pending = [...(gateway?.pendingRemoteEvents?.values?.() ?? [])]
        .filter(value => value.frame?.agentId === sessionId)
        .map(value => ({ event: value.frame.event, request: value.frame.request }));
    } catch { /* Optional legacy injection is unavailable in this Harness build. */ }
    let lastTurn;
    for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
      if (events[i].type === 'turn/end' || events[i].type === 'turn/start') { lastTurn = events[i]; break; }
    }
    return {
      active: Boolean(agent), running: agent?.status === 'running', queuedCount,
      pendingInput: pending,
      lastTurn: lastTurn ? { type: lastTurn.type, seq: lastTurn.seq, data: lastTurn.data } : null,
    };
  }

  function syncOptions(args) {
    const sessionId = string(args.sessionId, 'sessionId');
    const afterSeq = integer(args.afterSeq, 'afterSeq', -1, -1, Number.MAX_SAFE_INTEGER);
    const limit = integer(args.limit, 'limit', 100, 1, 500);
    const maxChars = integer(args.maxChars, 'maxChars', 16000, 1000, 100000);
    if (args.includeTools !== undefined && typeof args.includeTools !== 'boolean') invalid('includeTools must be boolean');
    return { sessionId, afterSeq, limit, maxChars };
  }

  // Durable events are sequenced. Skip the already-delivered prefix without walking it.
  function afterIndex(events, cursor) {
    let low = 0; let high = events.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (events[mid].seq <= cursor) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  async function sync(args, signal, value) {
    const { sessionId, afterSeq, limit, maxChars } = syncOptions(args);
    value ??= await snapshot(sessionId, signal);
    const endSeq = value.events.at(-1)?.seq ?? -1;
    if (afterSeq > endSeq) throw new BridgeError('CURSOR_AHEAD', 'Session history changed; reset afterSeq to -1');
    const entries = []; let cursor = afterSeq; let chars = 0;
    for (let i = afterIndex(value.events, afterSeq); i < value.events.length; i++) {
      const event = value.events[i];
      if (isMirroredBoundary(event)) { cursor = event.seq; continue; }
      const entry = publicEvent(event, args.includeTools === true);
      if (entry) {
        const serialized = JSON.stringify(entry);
        if (entries.length >= limit || (entries.length && chars + serialized.length > maxChars)) break;
        if (serialized.length > maxChars) {
          entries.push({ seq: event.seq, type: event.type, time: event.time, truncated: true, preview: serialized.slice(0, maxChars - 300) });
        } else entries.push(entry);
        chars += Math.min(serialized.length, maxChars);
      }
      cursor = event.seq;
    }
    return { sessionId, cursor, endSeq, hasMore: cursor < endSeq, entries, state: state(sessionId, value.events) };
  }

  async function wait(args, signal) {
    const { sessionId, afterSeq } = syncOptions(args);
    const timeoutMs = integer(args.timeoutMs, 'timeoutMs', 50000, 0, 600000);
    const until = args.until ?? 'settled';
    if (!['settled', 'message'].includes(until)) invalid('until must be settled or message');
    const deadline = Date.now() + timeoutMs;
    // Install listeners before the initial read, avoiding a lost completion event.
    let wake; let revision = 0;
    const changed = (...values) => {
      const first = values[0];
      const id = typeof first === 'string' ? first : first?.id ?? first?.agent?.id;
      if (id === args.sessionId) { revision++; wake?.(); }
    };
    const disposers = ['session/event', 'agent/status', 'agent/error', 'api-session/status']
      .map(name => ctx.on(name, changed));
    let initialized = false; let messageCursor = afterSeq;
    try {
      for (;;) {
        const before = revision;
        signal.throwIfAborted();
        // Settled waits inspect live status only. Serialize history once, on return.
        // The first snapshot still checks session existence and cursor validity.
        if (!initialized) {
          const initial = await snapshot(sessionId, signal);
          if (afterSeq > (initial.events.at(-1)?.seq ?? -1)) {
            throw new BridgeError('CURSOR_AHEAD', 'Session history changed; reset afterSeq to -1');
          }
          initialized = true;
        }
        const current = state(sessionId);
        let reason;
        let value;
        if (current.pendingInput.length) reason = 'input-required';
        else if (!current.running && !current.queuedCount) reason = 'idle';
        else if (until === 'message') {
          value = await snapshot(sessionId, signal);
          for (let i = afterIndex(value.events, messageCursor); i < value.events.length; i++) {
            const event = value.events[i];
            messageCursor = event.seq;
            if (isMirrored(event)) continue;
            if (event.type === 'user/message' || event.type === 'assistant/message') { reason = 'message'; break; }
          }
        }
        if (!reason && Date.now() >= deadline) reason = 'timeout';
        if (reason) {
          const result = await sync(args, signal, value);
          // A task can enter the queue while the final snapshot is being read.
          // Decide against its final state, rather than an earlier idle check.
          if (result.state.pendingInput.length) return { reason: 'input-required', ...result };
          if (!result.state.running && !result.state.queuedCount) return { reason: 'idle', ...result };
          if (reason === 'message') return { reason, ...result };
          if (Date.now() >= deadline) return { reason: 'timeout', ...result };
          continue;
        }
        if (revision !== before) continue;
        await new Promise((done, reject) => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); wake = undefined; done(); };
          const abort = () => { finish(); reject(signal.reason ?? new Error('Cancelled')); };
          // A local watchdog observes pending approvals on old builds; it never calls an LLM.
          const timer = setTimeout(finish, Math.min(1000, deadline - Date.now()));
          wake = finish;
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          else if (revision !== before) finish();
        });
      }
    } finally { for (const dispose of disposers) dispose(); }
  }

  function mirrorOptions(args) {
    const sessionId = string(args.sessionId, 'sessionId');
    if (!Array.isArray(args.messages) || args.messages.length === 0 || args.messages.length > 100) {
      invalid('messages must be a non-empty array with at most 100 items');
    }
    const provider = args.provider === undefined ? 'codex' : string(args.provider, 'provider', 100);
    const model = args.model === undefined ? 'codex' : string(args.model, 'model', 200);
    const messages = args.messages.map((value, index) => {
      const message = object(value);
      if (message.role !== 'user' && message.role !== 'assistant') invalid(`messages[${index}].role must be user or assistant`);
      return {
        role: message.role,
        id: message.id === undefined ? undefined : string(message.id, `messages[${index}].id`, 200),
        text: string(message.text, `messages[${index}].text`, 100000),
        turnId: message.turnId === undefined ? undefined : string(message.turnId, `messages[${index}].turnId`, 200),
      };
    });
    return { sessionId, messages, provider, model };
  }

  // Mirrored steps use numbers above any real step so a Codex record can never
  // share a chat context (turn:step) with a DeepSeek step and replace it.
  const MIRROR_STEP_BASE = 10000;

  // Highest turn the conversation already defines, from any event that carries one.
  function latestTurn(events) {
    let turn;
    for (const event of events) {
      const value = event.data?.turn;
      if (!Number.isSafeInteger(value) || value < 0) continue;
      if (turn === undefined || value > turn) turn = value;
    }
    return turn;
  }

  function nextMirrorStep(events, turn) {
    let step = MIRROR_STEP_BASE;
    for (const event of events) {
      if (event.data?.turn !== turn) continue;
      if (event.type !== 'step/start' && event.type !== 'step/end' && event.type !== 'assistant/message') continue;
      const value = event.data?.step;
      if (Number.isSafeInteger(value) && value >= step) step = value + 1;
    }
    return step;
  }

  // Append Codex records to a live conversation. Codex message IDs become
  // DeepSeek message IDs, so a repeated tick or an app restart cannot duplicate
  // history. Records attach to the conversation's latest turn because the chat
  // only renders an assistant message inside a started step; a conversation
  // without any turn gets one synthetic turn to hold the imported records.
  function mirror(args) {
    const { sessionId, messages, provider, model } = mirrorOptions(args);
    const live = ctx.sessions.get(sessionId);
    if (!live) {
      throw new BridgeError('SESSION_NOT_LIVE', 'Open the DeepSeek conversation in the desktop app before its Codex records can be mirrored');
    }
    if (typeof live.append !== 'function' || typeof live.snapshotEvents !== 'function') {
      throw new BridgeError('INCOMPATIBLE_DSH', 'This Harness build cannot append mirrored records');
    }
    const events = live.snapshotEvents();
    const known = new Set();
    for (const event of events) {
      if (event.type === 'user/message' && typeof event.data?.id === 'string') known.add(event.data.id);
      if (event.type === 'assistant/message' && typeof event.data?.message?.id === 'string') known.add(event.data.message.id);
    }
    const pending = []; let skipped = 0;
    for (const message of messages) {
      const id = message.id ?? `codex-${createHash('sha256').update(`${message.turnId ?? ''}\0${message.text}`).digest('hex').slice(0, 24)}`;
      if (known.has(id)) { skipped++; continue; }
      known.add(id);
      pending.push({ ...message, id });
    }
    const appended = [];
    const endSeq = () => live.snapshotEvents().at(-1)?.seq ?? -1;
    if (pending.length === 0) return { sessionId, appended, skipped, endSeq: endSeq() };

    let turn = latestTurn(events);
    let createdTurn = false;
    if (turn === undefined) {
      turn = 1;
      live.append('turn/start', { turn });
      syntheticTurns.add(turn);
      createdTurn = true;
    }
    let step = nextMirrorStep(events, turn);
    for (const message of pending) {
      if (message.role === 'user') {
        appended.push(live.append('user/message', {
          id: message.id, role: 'user', source: { kind: 'user', mirror: 'codex' },
          content: [{ type: 'text', text: message.text }],
        }, { surfaceOp: 'append' }).seq);
        continue;
      }
      // The chat drops an assistant message whose step never started, so each
      // imported record opens and closes its own mirrored step.
      live.append('step/start', { turn, step });
      appended.push(live.append('assistant/message', {
        turn, step, stream: [],
        message: { id: message.id, role: 'assistant', source: { kind: 'model', provider, model }, content: [{ type: 'text', text: message.text }] },
      }, { surfaceOp: 'append' }).seq);
      live.append('step/end', { turn, step });
      step++;
    }
    if (createdTurn) live.append('turn/end', { turn, reason: { kind: 'completed' } });
    return { sessionId, turn, appended, skipped, endSeq: endSeq() };
  }

  return {
    async call(method, input, signal = new AbortController().signal) {
      const args = object(input ?? {});
      switch (method) {
        case 'health': return { name: 'dsh-codex-bridge', version: '0.2.0', protocol: 1, platform: process.platform,
          capabilities: ['create', 'send', 'sync', 'wait', 'cancel', 'workspaces', 'list', 'mirror'],
          idlePush: false, waiting: 'local-events', tokenPolicy: 'Waiting/sync makes no additional model calls; delegated tasks use the App model normally' };
        case 'workspaces': return { items: ctx.workspaceRegistry.list().map(w => ({ id: w.id, title: w.title, path: w.path })) };
        case 'list': {
          const result = await api.list({}, signal);
          const limit = integer(args.limit, 'limit', 50, 1, 500);
          return { items: result.items.slice(0, limit).map(row => ({
            sessionId: row.sessionId, cwd: row.cwd, running: row.running,
            agentAvailable: row.agentAvailable, updatedAt: row.updatedAt,
            title: row.title ?? row.projections?.values?.title ?? row.projections?.values?.sessionTitle,
          })), hasMore: result.items.length > limit };
        }
        case 'create': {
          const request = {};
          if (args.workspaceId !== undefined) request.workspaceId = string(args.workspaceId, 'workspaceId');
          if (args.cwd !== undefined) {
            if (request.workspaceId) invalid('Specify workspaceId or cwd, not both');
            string(args.cwd, 'cwd');
            if (!isAbsolute(args.cwd) || (process.platform === 'win32' && /^[\\/](?![\\/])/.test(args.cwd))) invalid('cwd must be a fully qualified absolute path');
            const cwd = await realpath(resolve(args.cwd));
            if (!(await stat(cwd)).isDirectory()) invalid('cwd must name an existing directory');
            // Attach to a real Workspace so the conversation appears in the desktop sidebar.
            const workspace = ctx.workspaceRegistry.list().find(w => w.path === cwd) ?? await ctx.workspaceRegistry.create(cwd);
            request.workspaceId = workspace.id;
          }
          if (!request.workspaceId) invalid('Choose an existing workspaceId or an absolute cwd');
          if (args.agentPreset !== undefined) request.agentPreset = string(args.agentPreset, 'agentPreset');
          if (args.title !== undefined) string(args.title, 'title', 200);
          const created = await api.create(request);
          if (args.title !== undefined) await api.rename({ sessionId: created.sessionId, title: args.title });
          return created;
        }
        case 'send': {
          const requestId = args.requestId === undefined ? randomUUID() : string(args.requestId, 'requestId', 200);
          const mode = args.mode ?? 'queue';
          if (!['queue', 'steer'].includes(mode)) invalid('mode must be queue or steer');
          const request = { sessionId: string(args.sessionId, 'sessionId'), requestId, mode,
            content: [{ type: 'text', text: string(args.text, 'text', 200000) }] };
          if (args.clientTimeZone !== undefined) request.clientTimeZone = string(args.clientTimeZone, 'clientTimeZone', 100);
          const result = await api.prompt(request, signal);
          return { ...result, sessionId: request.sessionId, requestId };
        }
        case 'cancel': return { ...await api.cancel({ sessionId: string(args.sessionId, 'sessionId') }), note: 'Cancels the active turn; queued messages are retained by DeepSeek Harness.' };
        case 'mirror': return mirror(args);
        case 'sync': return await sync(args, signal);
        case 'wait': return await wait(args, signal);
        default: throw new BridgeError('METHOD_NOT_FOUND', `Unknown bridge method: ${method}`);
      }
    },
  };
}
