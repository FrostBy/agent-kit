'use strict';
const { spawn: defaultSpawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

// Shared transport for the broker and its archive command; proxy speaks WebSocket over stdio.
function connectProxy({ env = process.env, spawn = defaultSpawn, mode = 'proxy', log = () => {}, onNotification = () => {}, onRequest, onDisconnect = () => {}, timeout = 90000 } = {}) {
  const stdio = mode === 'stdio';
  const proc = spawn(env.AGENT_BROKER_CODEX || 'codex', stdio ? ['app-server', '--listen', 'stdio://'] : ['app-server', 'proxy'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let alive = true, closed = false, nextId = 1, handshaken = false, raw = Buffer.alloc(0), fragments = [];
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const handshakeTimer = setTimeout(() => lost('proxy handshake timeout'), Math.min(timeout, 10000));
  function lost(why) {
    if (!alive) return;
    alive = false; clearTimeout(handshakeTimer);
    const error = { reason: 'disconnected', message: why };
    readyReject(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    try { proc.kill(); } catch {}
    if (!closed) onDisconnect(why);
  }
  function frame(opcode, payload) {
    if (!alive) return;
    if (stdio) { if (opcode === 1) proc.stdin.write(String(payload) + '\n'); return; }
    const data = Buffer.from(payload), mask = randomBytes(4), len = data.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
      : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
    proc.stdin.write(Buffer.concat([head, mask, data]));
  }
  function message(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { log('bad proxy JSON'); return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      if (onRequest) {
        try { onRequest(msg); }
        catch (error) { respond(msg.id, undefined, { code: -32603, message: error.message }); }
      } else respond(msg.id, undefined, { code: -32601, message: 'broker: not supported' });
    } else onNotification(msg);
  }
  // Server requests have their own lifetime; they never enter the timed client-RPC map.
  function respond(id, result, error) {
    if (!alive) throw Error('Cannot respond on a disconnected transport');
    if (result instanceof Error || (Number.isInteger(result?.code) && typeof result.message === 'string')) {
      error = { code: result.code ?? -32603, message: result.message }; result = undefined;
    }
    frame(1, JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
  }
  function frames() {
    for (;;) {
      if (raw.length < 2) return;
      const fin = raw[0] & 0x80, opcode = raw[0] & 15, masked = raw[1] & 0x80;
      let len = raw[1] & 127, off = 2;
      if (len === 126) { if (raw.length < 4) return; len = raw.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (raw.length < 10) return; len = Number(raw.readBigUInt64BE(2)); off = 10; }
      if (raw.length < off + (masked ? 4 : 0) + len) return;
      const mask = masked ? raw.subarray(off, off + 4) : null; if (masked) off += 4;
      const payload = Buffer.from(raw.subarray(off, off + len)); raw = raw.subarray(off + len);
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      if (opcode === 9) { frame(10, payload); continue; }
      if (opcode === 8) { lost('ws close'); return; }
      if (opcode === 1 || opcode === 0) {
        fragments.push(payload);
        if (fin) { const text = Buffer.concat(fragments).toString('utf8'); fragments = []; message(text); }
      }
    }
  }
  proc.on('error', e => lost(`spawn error ${e.message}`));
  proc.on('exit', code => lost(`proxy exit ${code}`));
  proc.stdin.on?.('error', e => lost(`proxy stdin ${e.message}`));
  proc.stderr.on('data', data => log(`proxy stderr ${String(data).trim().slice(0, 300)}`));
  proc.stdout.on('data', data => {
    raw = Buffer.concat([raw, data]);
    if (stdio) {
      let end;
      while ((end = raw.indexOf(10)) >= 0) { const line = raw.subarray(0, end).toString('utf8'); raw = raw.subarray(end + 1); if (line.trim()) message(line); }
      return;
    }
    if (!handshaken) {
      const end = raw.indexOf('\r\n\r\n'); if (end < 0) return;
      if (!raw.subarray(0, end).toString().startsWith('HTTP/1.1 101')) { lost('proxy handshake failed'); return; }
      handshaken = true; clearTimeout(handshakeTimer); raw = raw.subarray(end + 4); readyResolve();
    }
    frames();
  });
  if (stdio) { clearTimeout(handshakeTimer); readyResolve(); }
  else proc.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  return {
    ready, respond, get alive() { return alive; },
    request(method, params, limit = timeout) {
      if (!alive) return Promise.reject({ reason: 'disconnected', message: 'no connection' });
      return new Promise((resolve, reject) => {
        const id = nextId++, timer = setTimeout(() => lost(`request timeout ${method} after ${limit} ms`), limit);
        const settle = fn => value => { clearTimeout(timer); fn(value); };
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
        frame(1, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    },
    notify(method, params) { frame(1, JSON.stringify({ jsonrpc: '2.0', method, params })); },
    close() { closed = true; lost('client closed'); },
    lost,
  };
}
module.exports = { connectProxy };
