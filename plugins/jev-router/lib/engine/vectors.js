'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class VectorCache {
  constructor(file, max = 3000) {
    this.file = file;
    this.max = max;
    this.map = new Map();
    this.dirty = false;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, b64] of Object.entries(j.entries || {})) this.map.set(k, b64);
    } catch {
      // Missing or corrupt cache: start empty.
    }
  }

  static key(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
  }

  get(text) {
    const b64 = this.map.get(VectorCache.key(text));
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    const out = new Float32Array(buf.byteLength / 4);
    new Uint8Array(out.buffer).set(buf);
    return out;
  }

  set(text, vec) {
    const k = VectorCache.key(text);
    this.map.delete(k);
    this.map.set(k, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64'));
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(this.map) }));
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.renameSync(tmp, this.file);
          this.dirty = false;
          return;
        } catch (e) {
          if (attempt === 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        }
      }
    } catch {
      // Cache is an optimisation; never fail the hook over it.
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
}

module.exports = { VectorCache };
