// Render the cursor page returned by the bridge `sync` method as compact
// Markdown. Codex injects this into the next prompt; a readable digest is much
// cheaper than raw event JSON and preserves the conversation shape.
const MAX_TOOL = 1200;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part?.text === 'string' && part.text.trim()) parts.push(part.text);
    else if (part?.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

function stringValue(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ''); }
}

function truncate(value, max = MAX_TOOL) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text;
}

function quote(value) {
  return String(value ?? '').split('\n').map(line => `> ${line}`).join('\n');
}

function reasonText(reason) {
  if (typeof reason === 'string') return reason;
  if (typeof reason?.kind === 'string') return reason.kind;
  return 'unknown';
}

export function formatEntry(entry) {
  // Oversized sync entries carry a bounded preview instead of data. Keep it
  // visible before the hook acknowledges the cursor; never silently drop it.
  if (entry?.truncated) {
    return `**${entry.type ?? 'Event'} (truncated, seq ${entry.seq ?? '?'})**\n\n${quote(truncate(entry.preview, 8000))}\n\n[Partial preview only; full event content was not imported.]`;
  }
  const data = entry?.data ?? {};
  switch (entry?.type) {
    case 'user/message': return `**User**\n\n${textOf(data.content)}`;
    case 'assistant/message': return `**Assistant**\n\n${textOf(data.content)}`;
    case 'turn/start': return `---\n\n**Turn ${data.turn ?? '?'}**`;
    case 'turn/end': return `_Turn ${data.turn ?? '?'} ended (${reasonText(data.reason)})_`;
    case 'tool/call': return `> **Tool call** \`${truncate(data.name ?? 'tool', 200)}\`\n>\n${quote(truncate(stringValue(data.arguments)))}`;
    case 'tool/result': return `> **Tool result**\n>\n${quote(truncate(textOf(data.message?.content) || JSON.stringify(data.message ?? data)))}`;
    case 'plan/mode': return `> **Plan mode:** ${data.active ? 'active' : 'inactive'}`;
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      if (!todos.length) return '';
      return `> **Todos**\n>\n${todos.map(todo => `> - [${todo?.status ?? 'pending'}] ${truncate(todo?.content ?? '', 500)}`).join('\n')}`;
    }
    case 'model/selection': return `> **Model:** ${data.provider ?? '?'}/${data.model ?? '?'}${data.reasoningEffort ? ` (effort: ${data.reasoningEffort})` : ''}`;
    case 'agent/error': return `> **Error:** ${truncate(data.message ?? data.error ?? JSON.stringify(data), 1000)}`;
    default: return '';
  }
}

export function formatSync(result, link) {
  const state = result?.state ?? {};
  const status = state.running ? 'running' : state.active ? 'active' : 'idle';
  const queued = state.queuedCount ? `, ${state.queuedCount} queued` : '';
  const lines = [
    '## DeepSeek Harness sync',
    `- session: ${result?.sessionId ?? '?'}`,
    `- state: ${status}${queued}`,
    `- cursor: ${link?.cursor ?? '?'} -> ${result?.cursor ?? '?'}${result?.hasMore ? ' (more history available)' : ''}`,
  ];
  for (const entry of result?.entries ?? []) {
    const line = formatEntry(entry);
    if (line) lines.push('', line);
  }
  if (result?.hasMore) lines.push('', 'More history remains; use dsh_sync with this sessionId and cursor before concluding.');
  return lines.join('\n');
}
