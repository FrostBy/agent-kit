'use strict';
const fs = require('fs');
const path = require('path');
const { stripVTControlCharacters } = require('util');
const config = require('./config');
const { render } = require('./render');
const { makeTheme } = require('./theme');
const { detectLang } = require('./i18n');
const codex = require('./sources/codex');
const git = require('./sources/git');
const { codexSample } = require('./sample');

function fitLine(line, width) {
  const plain = stripVTControlCharacters(line);
  const segments = new Intl.Segmenter().segment(plain);
  let cells = 0, clipped = '';
  for (const { segment } of segments) {
    const size = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60]/u.test(segment) ? 2 : 1;
    cells += size;
    if (cells <= width - 1) clipped += segment;
  }
  return cells <= width ? line : clipped + '…';
}

async function frame(snapshot, cfg, root, { demo = false, columns = 100 } = {}) {
  const t = makeTheme(cfg), ru = detectLang(cfg) === 'ru';
  const session = snapshot.input.session_id;
  const stamp = Date.parse(snapshot.usageAt);
  const title = `agent-statusline · Codex${demo ? ' · DEMO' : ''} · ${codex.clean(root)}`;
  const status = session
    ? `session ${codex.clean(session).slice(0, 8)}${Number.isFinite(stamp) ? ` · usage ${new Date(stamp).toLocaleTimeString()}` : ''}`
    : ru ? 'Ожидание сессии Codex в этой папке…' : 'Waiting for a Codex session in this folder…';
  const lines = await render(snapshot.input, cfg, Date.now(), {
    usage: () => null, today: () => null, plan: () => snapshot.plan, transcript: () => snapshot.activity,
    git: (dir, opts) => snapshot.git || git.collect(dir, opts),
  });
  return [
    t.paint('model', title), t.paint('muted', status),
    t.paint('muted', '─'.repeat(Math.max(1, Math.min(columns, 100)))),
    ...lines,
  ];
}

async function run({ root = process.cwd(), session, watch = false, demo = false } = {}) {
  root = path.resolve(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('root must be a directory');
  if (watch && !process.stdout.isTTY) throw new Error('--watch requires an interactive terminal; omit it for a snapshot');
  let file, reader, discoveredAt = 0, stopped = false;
  const draw = async () => {
    const now = Date.now();
    if (!demo && (!reader || (!session && now - discoveredAt >= 5000))) {
      const found = codex.findSession({ root, session });
      discoveredAt = now;
      if (found !== file) { file = found; reader = found ? new codex.Reader(found) : null; }
    }
    const snapshot = demo ? codexSample(now, root) : codex.snapshot(reader ? reader.read() : codex.state(), root, now);
    return frame(snapshot, config.load(), root, { demo, columns: process.stdout.columns || 100 });
  };
  if (!watch) { process.stdout.write((await draw()).join('\n') + '\n'); return; }

  const stop = () => { stopped = true; };
  const onKey = (s) => { if (s.includes('q') || s.includes('\x03')) stop(); };
  const wasRaw = process.stdin.isRaw;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onKey);
  process.stdin.resume();
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  try {
    while (!stopped) {
      let lines;
      try { lines = await draw(); }
      catch (e) { lines = [`agent-statusline · Codex`, `source: ${codex.clean(e.message)}`]; }
      const height = Math.max(1, (process.stdout.rows || 30) - 2);
      const visible = lines.slice(0, height);
      if (lines.length > height) visible[height - 1] = `… ${lines.length - height + 1} more rows; enlarge the terminal`;
      const width = Math.max(2, (process.stdout.columns || 100) - 1);
      process.stdout.write('\x1b[H\x1b[2J' + visible.map((line) => fitLine(line, width)).join('\n') + '\n\n' + fitLine('q / Ctrl+C — exit', width));
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.stdin.off('data', onKey);
    if (process.stdin.isTTY) process.stdin.setRawMode(!!wasRaw);
    process.stdin.pause();
  }
}

module.exports = { run, frame, fitLine };
