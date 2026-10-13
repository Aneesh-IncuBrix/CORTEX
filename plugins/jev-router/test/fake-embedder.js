'use strict';
// Deterministic bag-of-words embedder for engine logic tests (no model needed).
function fakeEmbed(text, dim = 64) {
  const v = new Float32Array(dim);
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}
const fakeEmbedder = { embed: async t => fakeEmbed(t) };
module.exports = { fakeEmbed, fakeEmbedder };
