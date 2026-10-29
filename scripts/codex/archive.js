'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');

function readZip(file) {
  const data = fs.readFileSync(file);
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid ZIP directory');
  const comment = data.subarray(end + 22, end + 22 + data.readUInt16LE(end + 20)).toString('utf8');
  const entries = [];
  let offset = data.readUInt32LE(end + 16);
  for (let i = 0; i < data.readUInt16LE(end + 10); i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const length = data.readUInt16LE(offset + 28);
    const name = data.subarray(offset + 46, offset + 46 + length).toString('utf8');
    const local = data.readUInt32LE(offset + 42);
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const packed = data.subarray(start, start + data.readUInt32LE(offset + 20));
    const method = data.readUInt16LE(offset + 10);
    entries.push({ name, content: () => {
      if (method === 0) return packed;
      if (method === 8) return inflateRawSync(packed);
      throw new Error(`Unsupported ZIP compression: ${method}`);
    } });
    offset += 46 + length + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
  }
  return { comment, entries };
}

function extractZip(zip, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of zip.entries) {
    const relative = entry.name.split('/').slice(1).join('/');
    if (!relative) continue;
    const target = path.resolve(destination, relative);
    if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error('Unsafe ZIP path');
    if (entry.name.endsWith('/')) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.content());
    }
  }
}
module.exports = { readZip, extractZip };
