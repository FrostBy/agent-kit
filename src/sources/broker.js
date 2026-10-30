'use strict';
const fs = require('fs');
const path = require('path');
const { readJson } = require('../util');

// Broker state files sit in the scratchpad itself or one folder down (scratchpad/codex/…).
function stateFiles(scratchpad) {
  let entries;
  try { entries = fs.readdirSync(scratchpad, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.state.json')) files.push(path.join(scratchpad, e.name));
    else if (e.isDirectory()) {
      try {
        for (const f of fs.readdirSync(path.join(scratchpad, e.name), { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith('.state.json')) files.push(path.join(scratchpad, e.name, f.name));
        }
      } catch { /* An unreadable subfolder must not hide the other agents. */ }
    }
  }
  return files;
}

function agents(scratchpad, agent) {
  if (typeof scratchpad !== 'string' || !scratchpad) return [];
  const found = [];
  for (const filename of stateFiles(scratchpad)) {
    try {
      const state = readJson(filename);
      const id = agent === 'codex' ? state?.threadId : state?.sessionId;
      if (state?.agent !== agent || ['done', 'error'].includes(state.status)
        || typeof id !== 'string' || !/^[\w-]+$/.test(id)) continue;
      const updatedAt = fs.statSync(filename).mtimeMs;
      found.push({ id, name: path.basename(filename).slice(0, -11), model: typeof state.model === 'string' ? state.model : '', updatedAt });
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
