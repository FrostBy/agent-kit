'use strict';
const { cleanText, humanClaude } = require('./messages');
const clip = (text, n = 8000) => {
  let value = String(text || '');
  if (value.length <= n) return value;
  value = value.slice(0, n); if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
  return value + '\n[truncated]';
};
const outputText = text => clip(String(text || '').replace(/<\/?persisted-output\b[^>]*>/gi, '').trim());
function summary(shell) {
  return `User ran: ${clip(shell.command, 2000)}\nOutput: ${clip(shell.stdout, 4000) || '(no stdout)'}${shell.stderr ? '\nStderr: ' + clip(shell.stderr, 2000) : ''}`;
}
function claudeShell(row, text, context, ordinal) {
  if (!humanClaude(row) || !/<bash-(?:input|stdout|stderr)\b/i.test(text)) return null;
  text = cleanText('claude', text, true);
  const input = text.match(/^<bash-input>([\s\S]*)<\/bash-input>$/i);
  if (input) {
    context.userShell = { command: clip(input[1].trim(), 4000), id: row.uuid ?? ordinal, uuid: row.uuid, timestamp: row.timestamp };
    return { handled: true };
  }
  const output = text.match(/^<bash-stdout>([\s\S]*)<\/bash-stdout>\s*<bash-stderr>([\s\S]*)<\/bash-stderr>$/i)
    || text.match(/^<bash-stdout>([\s\S]*)<\/bash-stdout>$/i);
  const error = !output && text.match(/^<bash-stderr>([\s\S]*)<\/bash-stderr>$/i);
  if (!output && !error) return null;
  const pending = context.userShell; delete context.userShell;
  if (!pending || (row.parentUuid && pending.uuid && row.parentUuid !== pending.uuid)) return { handled: true };
  const elapsed = Date.parse(row.timestamp) - Date.parse(pending.timestamp);
  const info = row.toolUseResult || {};
  return { handled: true, id: pending.id, shell: { command: pending.command, stdout: outputText(output?.[1]), stderr: outputText(output?.[2] || error?.[1]),
    ...(Number.isInteger(info.exitCode ?? info.exit_code) ? { exitCode: info.exitCode ?? info.exit_code } : {}),
    ...(Number.isFinite(elapsed) && elapsed >= 0 ? { durationMs: elapsed } : {}) } };
}
function codexShells(message) {
  const content = typeof message.content === 'string' ? [{ text: message.content }] : message.content || [];
  if (!Array.isArray(content)) return [];
  const meta = message.internal_chat_message_metadata_passthrough;
  return content.flatMap((block, index) => {
    const kind = meta?.content_item_kinds?.[index], provenance = meta?.content_item_metadata?.[index]?.provenance;
    if ((kind && !['unknown', 'shell.user_command'].includes(kind)) || provenance?.hook) return [];
    const match = String(block.text || '').trim().match(/^<user_shell_command>\s*<command>\s*([\s\S]*?)\s*<\/command>\s*<result>\s*Exit code:\s*(-?\d+)\s*\nDuration:\s*([\d.]+) seconds\s*\nOutput:\s*\n?([\s\S]*?)\s*<\/result>\s*<\/user_shell_command>$/i);
    if (!match) return [];
    return [{ index, shell: { command: clip(match[1], 4000), stdout: outputText(match[4]), stderr: '', exitCode: Number(match[2]), durationMs: Number(match[3]) * 1000 } }];
  });
}
module.exports = { claudeShell, codexShells, summary };
