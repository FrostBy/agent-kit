'use strict';
const fs = require('fs');
const path = require('path');
const { readJson } = require('../util');

function agents(scratchpad, agent) {
  if (typeof scratchpad !== 'string' || !scratchpad) return [];
  let files;
  try { files = fs.readdirSync(scratchpad, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.state.json')) continue;
    try {
      const filename = path.join(scratchpad, file.name);
      const state = readJson(filename);
      const id = agent === 'codex' ? state?.threadId : state?.sessionId;
      if (state?.agent !== agent || ['done', 'error'].includes(state.status)
        || typeof id !== 'string' || !/^[\w-]+$/.test(id)) continue;
      const updatedAt = fs.statSync(filename).mtimeMs;
      found.push({ id, name: file.name.slice(0, -11), model: typeof state.model === 'string' ? state.model : '', updatedAt });
    } catch { /* A disappearing state file must not hide the other agents. */ }
  }
  return found;
}

function select(agents, accepts) {
  const fresh = agents.filter((a) => a && Number.isFinite(a.updatedAt) && accepts(a.updatedAt));
  fresh.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  const active = fresh.filter((a) => !a.done);
  return active.length ? active.slice(0, 3) : fresh.slice(0, 1);
}

module.exports = { agents, select };
