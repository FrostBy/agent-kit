'use strict';
const oneLine = (value, limit = 100) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
function toolSummary(tool) {
  const name = tool.name || 'Unknown tool', input = tool.input || {}, output = String(tool.output || '');
  const failed = tool.isError === true || (Number.isInteger(tool.exitCode) && tool.exitCode !== 0);
  const status = failed ? 'failed' : tool.isIncomplete ? 'still running' : 'completed';
  if (name === 'exec' && typeof input.input === 'string') return `Code orchestration ${status}.`;
  if (/^Monitor$/i.test(name)) return failed ? 'Background monitor failed.' : /\bstarted\b/i.test(output) ? 'Background monitor started.' : 'Background monitor updated.';
  if (/^(TaskOutput|TaskStop|TaskList|TaskGet|TaskUpdate|TaskCreate)$/i.test(name)) return `Background task ${name.slice(4).toLowerCase()}: ${status}.`;
  if (/^(Agent|Task|spawn_agent|send_input|send_message|wait|wait_agent|close_agent|resume_agent|list_agents|interrupt_agent|followup_task)$/i.test(name)) return `${['Agent', 'Task'].includes(name) ? 'Agent task' : 'Agent ' + name}: ${failed ? 'failed' : input.run_in_background || name === 'spawn_agent' ? 'started' : status}.`;
  if (/^(TodoWrite|update_plan)$/i.test(name)) {
    const todos = input.todos || input.plan;
    return Array.isArray(todos) ? `Plan updated: ${todos.filter(t => t.status === 'completed').length}/${todos.length} completed.` : `Plan update: ${status}.`;
  }
  if (/^(ToolSearch|tool_search)$/i.test(name)) return `Tool discovery ${status}.`;
  if (/^Skill$/i.test(name)) return `Skill ${oneLine(input.skill || input.name, 60) || 'request'}: ${status}.`;
  if (/^(AskUserQuestion|request_user_input)$/i.test(name)) return `User questions ${failed ? 'failed' : 'recorded'}.`;
  if (/Artifact/i.test(name)) return `Artifact operation ${status}.`;
  if (/^(WebFetch|WebSearch|web_search|web_search_call|web|web_run)$/i.test(name)) return `Web operation ${status}.`;
  if (/^(view_image|image_view|image_generation_call)$/i.test(name)) return `Image operation ${status}; image data is not transferred.`;
  if (/^mcp__/i.test(name) || tool.namespace) return `External tool ${oneLine(name, 100)}: ${status}.`;
  return `${oneLine(name, 100)}: ${status}.`;
}
function todoInput(input) {
  const steps = input?.plan;
  if (!Array.isArray(steps) || !steps.length || steps.some(s => typeof s.step !== 'string' || !['pending', 'in_progress', 'completed'].includes(s.status))) return null;
  return { todos: steps.slice(0, 50).map(s => ({ content: oneLine(s.step, 200), activeForm: oneLine(s.step, 200), status: s.status })) };
}
module.exports = { toolSummary, todoInput };
