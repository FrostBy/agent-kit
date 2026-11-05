'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const names = ['codex', 'kimi', 'opencode', 'claude'];
function read(file, project = false) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw Error(`Invalid agent policy ${file}: ${e.message}`); }
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  if (!object(value) || Object.keys(value).some(k => !['priority', 'connectors'].includes(k))) throw Error(`Invalid agent policy ${file}`);
  if (value.priority !== undefined && (!Array.isArray(value.priority) || value.priority.some(x => !names.includes(x)) || new Set(value.priority).size !== value.priority.length)) throw Error(`Invalid priority in ${file}`);
  if (value.connectors !== undefined && !object(value.connectors)) throw Error(`Invalid connectors in ${file}`);
  const keys = ['enabled', 'models', 'executable'];
  for (const [name, config] of Object.entries(value.connectors || {})) {
    if (!names.includes(name) || !object(config) || Object.keys(config).some(k => !keys.includes(k))
      || (config.enabled !== undefined && typeof config.enabled !== 'boolean')
      || (!project && config.executable !== undefined && (typeof config.executable !== 'string' || !config.executable.trim()))
      || (config.models !== undefined && (!Array.isArray(config.models) || config.models.some(x => typeof x !== 'string' || !x.trim())))) throw Error(`Invalid connector ${name} in ${file}`);
  }
  return value;
}
function resolve({ env = process.env, cwd = process.cwd(), connector, model } = {}) {
  const home = path.resolve(env.HOME || env.USERPROFILE || os.homedir());
  const global = read(path.join(home, '.config', 'agent-kit', 'agents.json'));
  const projects = [];
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (let dir = path.resolve(cwd);; dir = path.dirname(dir)) {
    if (!samePath(dir, home)) projects.push(path.join(dir, '.agent-kit', 'agents.json'));
    if (path.dirname(dir) === dir) break;
  }
  const effective = {};
  for (const name of names) {
    const config = global.connectors?.[name] || {};
    effective[name] = { enabled: name === 'opencode' ? config.enabled === true : config.enabled !== false, models: config.models };
  }
  let priority = global.priority ?? ['codex', 'kimi', 'opencode'];
  for (const file of projects.reverse()) {
    const project = read(file, true);
    priority = project.priority ?? priority;
    for (const name of names) {
      const config = project.connectors?.[name] || {}, current = effective[name];
      if (config.enabled === false) current.enabled = false;
      if (config.models) current.models = current.models ? current.models.filter(model => config.models.includes(model)) : config.models;
    }
  }
  connector ??= priority.find(name => effective[name].enabled);
  if (!names.includes(connector)) throw Error(`Unknown connector ${connector}`);
  const config = effective[connector];
  if (!config.enabled) throw Error(`Connector ${connector} is disabled`);
  if (connector === 'opencode' && (!global.connectors?.opencode?.models?.length || !model)) throw Error('OpenCode requires a global model allowlist and explicit model');
  if (config.models && (!model || !config.models.includes(model))) throw Error(`Model is not allowed for ${connector}: ${model}`);
  return { connector, agent: connector, executable: global.connectors?.[connector]?.executable };
}
module.exports = { resolve };
