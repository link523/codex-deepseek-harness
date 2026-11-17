// Markdown rendering for a DeepSeek conversation. The bridge returns this to
// Codex through the `transcript` method, so Codex can read a linked session as
// an MCP resource instead of paging through raw event JSON.
const MAX_TOOL_CHARS = 2000;

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part?.text === 'string') { if (part.text.trim()) parts.push(part.text); continue; }
    if (part?.type === 'image' || part?.type === 'image_url' || part?.type === 'input_image') { parts.push('[image]'); continue; }
    if (part?.type === 'reasoning' || part?.type === 'thinking') continue;
  }
  return parts.join('\n');
}

function stringValue(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ''); }
}

function truncate(value, max = MAX_TOOL_CHARS) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function quote(value) {
  return String(value ?? '').split('\n').map(line => `> ${line}`).join('\n');
}

function reasonText(reason) {
  if (reason === undefined || reason === null) return 'unknown';
  if (typeof reason === 'string') return reason;
  if (typeof reason.kind === 'string') return reason.kind;
  if (typeof reason.message === 'string') return reason.message;
  try { return JSON.stringify(reason); } catch { return 'unknown'; }
}

function todoLines(todos) {
  if (!Array.isArray(todos)) return '';
  return todos.map(todo => `> - [${todo?.status ?? 'pending'}] ${truncate(todo?.content ?? '', 500)}`).join('\n');
}

export function formatEvent(event, includeTools = true) {
  if (!event || typeof event.type !== 'string') return '';
  const data = event.data ?? {};
  switch (event.type) {
    case 'user/message':
      return `**User**\n\n${textOf(data.content ?? data.message?.content)}`;
    case 'assistant/message':
      return `**Assistant**\n\n${textOf(data.message?.content ?? data.content)}`;
    case 'turn/start':
      return `---\n\n**Turn ${data.turn ?? '?'}**`;
    case 'turn/end':
      return `_Turn ${data.turn ?? '?'} ended (${reasonText(data.reason)})_`;
    case 'tool/call':
      if (!includeTools) return '';
      return `> **Tool call** \`${truncate(data.name ?? 'tool', 200)}\` (${truncate(data.callId ?? '', 100)})\n>\n${quote(truncate(stringValue(data.arguments), MAX_TOOL_CHARS))}`;
    case 'tool/result':
      if (!includeTools) return '';
      return `> **Tool result**\n>\n${quote(truncate(textOf(data.message?.content) || JSON.stringify(data.message ?? data), MAX_TOOL_CHARS))}`;
    case 'plan/mode':
      return `> **Plan mode:** ${data.active ? 'active' : 'inactive'}`;
    case 'todo/write': {
      const lines = todoLines(data.todos);
      return lines ? `> **Todos**\n>\n${lines}` : '';
    }
    case 'model/selection':
      return `> **Model:** ${data.provider ?? '?'}/${data.model ?? '?'}${data.reasoningEffort ? ` (effort: ${data.reasoningEffort})` : ''}`;
    case 'agent/error':
      return `> **Error:** ${truncate(data.message ?? data.error ?? JSON.stringify(data), 1000)}`;
    default:
      return '';
  }
}

export function formatTranscript(events, { sessionId, header = {}, includeTools = true, maxChars = 200000 } = {}) {
  const out = ['# DeepSeek Harness conversation', ''];
  out.push(`- session: ${sessionId}`);
  if (header?.cwd) out.push(`- workspace: ${header.cwd}`);
  if (header?.title) out.push(`- title: ${header.title}`);
  out.push('');
  for (const event of events) {
    const line = formatEvent(event, includeTools);
    if (line) out.push(line, '');
  }
  let text = out.join('\n').trimEnd();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[transcript truncated at ${maxChars} characters]`;
  return `${text}\n`;
}
