'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE_VERSION = 1;
const MODEL = {
  repo: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dim: 384,
  files: [
    { remote: 'onnx/model_quantized.onnx', local: 'model.onnx', sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', size: 22972370 },
    { remote: 'tokenizer.json', local: 'tokenizer.json', sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0', size: 711661 },
  ],
};

function enginePaths(dataDir) {
  const root = path.join(dataDir, 'engine');
  const modelDir = path.join(root, 'model');
  return {
    root,
    modelDir,
    model: path.join(modelDir, 'model.onnx'),
    tokenizer: path.join(modelDir, 'tokenizer.json'),
    ready: path.join(root, 'READY.json'),
    ortModule: path.join(root, 'node_modules', 'onnxruntime-node'),
  };
}

// HF_ENDPOINT lets users behind blocks use a mirror (U9); checksums still gate every file.
function fileUrl(f, endpoint = process.env.HF_ENDPOINT) {
  const base = String(endpoint || 'https://huggingface.co').replace(/\/+$/, '');
  return `${base}/${MODEL.repo}/resolve/${MODEL.revision}/${f.remote}`;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// U12: distinguish why routing is unavailable so the user gets the right next step.
// state: missing | stale (plugin updated, engine too old) | broken (files gone) | lite (no native engine) | ready
function readinessState(dataDir) {
  const p = enginePaths(dataDir);
  let r;
  try { r = JSON.parse(fs.readFileSync(p.ready, 'utf8')); } catch { return { state: 'missing', ready: null }; }
  if (!r || r.engineVersion !== ENGINE_VERSION) return { state: 'stale', ready: r };
  if (r.mode === 'lite') return { state: 'lite', ready: r };
  if (r.revision !== MODEL.revision) return { state: 'stale', ready: r };
  if (!fs.existsSync(p.model) || !fs.existsSync(p.tokenizer) || !fs.existsSync(p.ortModule)) return { state: 'broken', ready: r };
  return { state: 'ready', ready: r };
}

function readReady(dataDir) {
  const s = readinessState(dataDir);
  return s.state === 'ready' ? s.ready : null;
}

module.exports = { ENGINE_VERSION, MODEL, enginePaths, fileUrl, sha256File, readinessState, readReady };
