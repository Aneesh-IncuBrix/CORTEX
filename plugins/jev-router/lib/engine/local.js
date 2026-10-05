'use strict';
const fs = require('fs');
const { enginePaths } = require('./manifest');
const { WordPiece } = require('./wordpiece');

class LocalEmbedder {
  static async create(dataDir) {
    const p = enginePaths(dataDir);
    const ort = require(p.ortModule);
    const tokenizer = new WordPiece(JSON.parse(fs.readFileSync(p.tokenizer, 'utf8')));
    // Load from bytes, not a path: avoids native path-encoding bugs with non-ASCII user folders (U11).
    const session = await ort.InferenceSession.create(fs.readFileSync(p.model), {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    });
    return new LocalEmbedder(ort, tokenizer, session);
  }

  constructor(ort, tokenizer, session) {
    this.ort = ort;
    this.tokenizer = tokenizer;
    this.session = session;
  }

  async embed(text) {
    const ids = this.tokenizer.encode(text, 256);
    const n = ids.length;
    const tensor = arr => new this.ort.Tensor('int64', BigInt64Array.from(arr, x => BigInt(x)), [1, n]);
    const feeds = { input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)) };
    if (this.session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0));
    const out = await this.session.run(feeds);
    const t = out.last_hidden_state || out[this.session.outputNames[0]];
    const dim = t.dims[t.dims.length - 1];
    const data = t.data;
    const v = new Float32Array(dim);
    for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) v[j] += data[i * dim + j];
    let norm = 0;
    for (let j = 0; j < dim; j++) { v[j] /= n; norm += v[j] * v[j]; }
    norm = Math.sqrt(norm) || 1;
    for (let j = 0; j < dim; j++) v[j] /= norm;
    return v;
  }
}

module.exports = { LocalEmbedder };
