'use strict';
const textBlocks = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => ['text', 'input_text', 'output_text'].includes(block.type)).map(block => block.text || '').join('\n') : '';
function humanClaude(row) {
  if (row.isMeta || row.isSidechain) return false;
  if (row.origin != null && row.origin.kind !== 'human') return false;
  if (row.promptSource != null && !['typed', 'queued'].includes(row.promptSource)) return false;
  return row.turnOrigin == null || row.turnOrigin === 'human';
}
const tags = 'system-reminder|task-notification|local-command-stdout|local-command-caveat|command-name|command-message|command-args|user-memory-input|agent-message|environment_context|user_instructions|turn_aborted|hook_prompt|additional_context|subagent_notification|agent_message_board_notification|codex_internal_context|goal_context';
function cleanText(kind, value, keepShell = false) {
  let text = String(value || '');
  if (kind === 'codex' && /^\s*<skill>[\s\S]*<\/skill>\s*$/i.test(text)) return '';
  if (kind === 'codex') text = text.replace(/(?:^|\n)#{1,6}[ \t]+AGENTS\.md instructions[^\r\n]*\r?\n[\s\S]*?(?:<\/INSTRUCTIONS\s*>|$)/gi, '\n');
  // A stack also discards nested or unfinished service blocks; no text from them can leak out.
  const pattern = new RegExp(`<(/?)(${tags}${keepShell ? '' : '|bash-input|bash-stdout|bash-stderr|user_shell_command|persisted-output'})\\b[^>]*>`, 'gi'), stack = [], out = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (!stack.length) out.push(text.slice(start, match.index));
    const name = match[2].toLowerCase();
    if (!match[1] && !/\/>$/.test(match[0])) stack.push(name);
    else if (match[1] && stack.at(-1) === name) stack.pop();
    start = match.index + match[0].length;
  }
  if (!stack.length) out.push(text.slice(start));
  return out.join('').trim();
}
function serviceMetadata(meta, index) {
  const kind = meta?.content_item_kinds?.[index];
  if (typeof kind === 'string' && kind && kind !== 'unknown' && !kind.startsWith('user.')) return true;
  const provenance = meta?.content_item_metadata?.[index]?.provenance;
  return Boolean(provenance?.hook || ['hook', 'agents_md', 'harness'].includes(provenance?.type));
}
function userText(kind, row, message) {
  if (kind === 'claude' && !humanClaude(row)) return '';
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
  if (!Array.isArray(content)) return '';
  const metadata = message.internal_chat_message_metadata_passthrough;
  return content.map((block, index) => {
    if (!['text', 'input_text', 'output_text'].includes(block.type)) return '';
    if (kind === 'codex' && serviceMetadata(metadata, index)) return '';
    return cleanText(kind, block.text);
  }).filter(Boolean).join('\n');
}
module.exports = { humanClaude, userText, cleanText };
