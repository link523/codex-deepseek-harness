import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export function fixture() {
  const emitter = new EventEmitter();
  const sessions = new Map(); const agents = new Map(); const workspaces = [];
  const requests = new Set(); const calls = [];
  const ctx = {
    on(name, callback) { emitter.on(name, callback); return () => emitter.off(name, callback); },
    sessions: { get: id => sessions.get(id) }, agents: { get: id => agents.get(id) },
    sessionProjections: { snapshot: () => ({ values: { inbox: { 'next-turn': [], 'next-step': [] } } }) },
    typertGateway: { pendingRemoteEvents: new Map() },
    workspaceRegistry: {
      list: () => workspaces,
      async create(path) { const w = { id: randomUUID(), path, title: path }; workspaces.push(w); return w; },
    },
    sessionQuery: {
      async observeSession(id) {
        const session = sessions.get(id);
        if (!session) throw new Error('Session not found');
        return { header: session.header, events: session.events, [Symbol.dispose]() {} };
      },
    },
    sessionController: {
      async list() { return { items: [...sessions.values()].map(s => ({ sessionId: s.id, running: agents.get(s.id)?.status === 'running' })) }; },
      async create(args) {
        calls.push(['create', args]); const id = `session-${randomUUID()}`;
        sessions.set(id, {
          id, header: { id, cwd: args.cwd }, events: [],
          snapshotEvents() { return this.events; },
          // Mirrors Session.append: one sequenced, immutable event plus observers.
          append(type, data, opts = {}) {
            const event = { seq: this.events.length, time: Date.now(), type, data, ...opts };
            this.events.push(event); emitter.emit('session/event', this, event);
            return event;
          },
        });
        agents.set(id, { id, status: 'idle' });
        return { sessionId: id };
      },
      async prompt(args) {
        calls.push(['prompt', args]);
        if (!requests.has(args.requestId)) {
          requests.add(args.requestId);
          append(args.sessionId, 'user/message', { content: args.content, source: { rpcId: args.requestId } });
          agents.get(args.sessionId).status = 'running';
          append(args.sessionId, 'turn/start', {});
        }
        return { accepted: true };
      },
      cancel(args) {
        calls.push(['cancel', args]);
        agents.get(args.sessionId).status = 'idle';
        append(args.sessionId, 'turn/end', { reason: 'cancelled' });
        emitter.emit('agent/status', { agent: agents.get(args.sessionId), status: 'idle' });
        return { accepted: true };
      },
      async projections() { return { kind: 'sequenced', values: {} }; },
      async rename(args) { calls.push(['rename', args]); return { title: args.title }; },
    },
  };
  function append(id, type, data) {
    return sessions.get(id).append(type, data);
  }
  return { ctx, sessions, agents, workspaces, append, emitter, calls };
}
