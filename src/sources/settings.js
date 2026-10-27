'use strict';
const path = require('path');
const cache = require('../cache');
const { CLAUDE_DIR, readJson } = require('../util');

function autoCompactWindow(projectDir, modelId) {
  for (const file of [path.join(projectDir, '.claude', 'settings.local.json'), path.join(projectDir, '.claude', 'settings.json'), path.join(CLAUDE_DIR, 'settings.json')]) {
    let settings;
    try { settings = cache.parsedFile(file, () => readJson(file)); } catch { continue; }
    const value = settings?.modelSettings?.[modelId]?.autoCompactWindow ?? settings?.autoCompactWindow;
    if (value != null) return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

module.exports = { autoCompactWindow };
