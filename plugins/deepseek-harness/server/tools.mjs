import { bind, commitCursor, readLink, writeLink } from './links.mjs';

const text = (description, maxLength = 2000) => ({ type: 'string', minLength: 1, maxLength, description });
const int = (minimum, maximum, description) => ({ type: 'integer', minimum, maximum, description });
const session = { sessionId: text('DeepSeek Harness session ID') };
const sync = {
  ...session,
  afterSeq: int(-1, Number.MAX_SAFE_INTEGER, 'Exclusive event cursor; -1 reads from the beginning'),
  limit: int(1, 500, 'Maximum returned events; default 100'),
  maxChars: int(1000, 100000, 'Maximum approximate event JSON characters; default 16000'),
  includeTools: { type: 'boolean', description: 'Include tool details; default false to save context' },
};
function tool(name, description, properties = {}, required = [], readOnly = true, delegates = false) {
  const opensApp = name !== 'dsh_unbind';
  return { name, description: name === 'dsh_unbind' ? description : `${description} Automatically opens the installed desktop App if it is not running and waits for its bridge.`,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly && !opensApp, destructiveHint: delegates, openWorldHint: delegates } };
}
export const tools = [
  tool('dsh_status', 'Check the local DeepSeek Harness desktop bridge, capabilities and sync limitations.'),
  tool('dsh_workspaces', 'List project workspaces registered in the DeepSeek Harness desktop app.'),
  tool('dsh_list_sessions', 'List DeepSeek desktop conversations to choose one to link.', { limit: int(1, 500, 'Maximum sessions; default 50') }),
  tool('dsh_create_session', 'Create an App-visible DeepSeek conversation in a project workspace. Does not send a task.', {
    workspaceId: text('Existing DeepSeek workspace ID; exclusive with cwd'),
    cwd: text('Existing absolute project directory; registered as a workspace if needed'),
    title: text('Conversation title', 200), agentPreset: text('Optional DeepSeek agent preset'),
  }, [], false),
  tool('dsh_send', 'Send task text to an existing DeepSeek desktop conversation. Keep requestId to retry safely after a transport failure. Uses existing App model and permissions.', {
    ...session, text: text('Task or follow-up message', 200000), requestId: text('Idempotency ID for this logical message', 200),
    mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue follows the current task; steer interrupts it with guidance' },
    clientTimeZone: text('IANA timezone, for example Asia/Shanghai', 100),
  }, ['sessionId', 'text', 'requestId'], false, true),
  tool('dsh_sync', 'Read only new DeepSeek messages and durable lifecycle events after a cursor. Return hasMore pages in order. Does not call a model.', sync, ['sessionId']),
  tool('dsh_wait', 'Wait inside the plugin for task completion or required input. Default until=settled avoids token-by-token/model polling. A local event listener does the waiting. Use timeoutMs<=50000 on clients with a 60s tool timeout; up to 600000 if the host timeout is increased.', {
    ...sync, timeoutMs: int(0, 600000, 'Wait bound, default 50000 milliseconds'),
    until: { type: 'string', enum: ['settled', 'message'], description: 'settled waits for completion/input, message returns on a new message' },
  }, ['sessionId']),
  tool('dsh_cancel', 'Cancel the active DeepSeek turn. DeepSeek retains queued messages; this does not clear the queue.', session, ['sessionId'], false),
  tool('dsh_bind', 'Link this Codex session to one DeepSeek conversation, in both directions. The trusted UserPromptSubmit hook imports new DeepSeek messages on the next Codex prompt, and the DeepSeek extension mirrors this Codex transcript into the conversation while the app has it open. Use the codexSessionId given by the hook.', {
    ...session, codexSessionId: text('Current Codex session ID from the sync hook'),
    fromStart: { type: 'boolean', description: 'Also copy existing history in both directions; default false copies future updates' },
  }, ['sessionId', 'codexSessionId'], false),
  tool('dsh_unbind', 'Stop automatic next-prompt import and Codex record mirroring for this Codex session.', {
    codexSessionId: text('Current Codex session ID'),
  }, ['codexSessionId'], false),
];

export function validate(name, args) {
  const definition = tools.find(t => t.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  const schema = definition.inputSchema;
  for (const key of schema.required) if (!(key in args)) throw new Error(`Missing required argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown argument: ${key}`);
    const prop = schema.properties[key];
    if (prop.type === 'string' && (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > prop.maxLength)) throw new Error(`Invalid text argument: ${key}`);
    if (prop.type === 'integer' && (!Number.isSafeInteger(value) || value < prop.minimum || value > prop.maximum)) throw new Error(`Invalid integer argument: ${key}`);
    if (prop.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid boolean argument: ${key}`);
    if (prop.enum && !prop.enum.includes(value)) throw new Error(`Invalid value for ${key}`);
  }
  return definition;
}

export async function callTool(client, name, args, signal) {
  validate(name, args);
  switch (name) {
    case 'dsh_bind': return await bind(client, args.codexSessionId, args.sessionId, args.fromStart);
    case 'dsh_unbind': await writeLink(args.codexSessionId, null); return { unbound: true };
    default: {
      const methods = { dsh_status: 'health', dsh_workspaces: 'workspaces', dsh_list_sessions: 'list',
        dsh_create_session: 'create', dsh_send: 'send', dsh_sync: 'sync', dsh_wait: 'wait', dsh_cancel: 'cancel' };
      return await client.call(methods[name], args, { signal, timeoutMs: name === 'dsh_wait' ? (args.timeoutMs ?? 50000) + 10000 : 45000 });
    }
  }
}

export async function syncLinked(client, codexSessionId) {
  const link = await readLink(codexSessionId);
  if (!link) return null;
  const result = await client.call('sync', { sessionId: link.sessionId, afterSeq: link.cursor, maxChars: 8000, limit: 50 }, { timeoutMs: 2000 });
  // Returning an additionalContext packet is the hook's delivery boundary.
  // No model is called here, and empty packets are omitted by the hook.
  return { result, commit: () => commitCursor(codexSessionId, link, result.cursor) };
}
