#!/usr/bin/env node
'use strict';
// Finds every place a codebase calls an LLM, how it is configured, and where tokens can be saved.
// Read-only. Reports env var NAMES only, never values.
// Usage: node scan-llm.js [repoDir] [--json]
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODE = /\.(py|js|mjs|cjs|ts|tsx|jsx|go|rb|java|kt|cs|php|rs|swift|dart)$/i;
const SKIP_DIR = new Set(['node_modules', 'venv', 'env', '__pycache__', 'dist', 'build', 'out', 'target', 'vendor', 'site-packages', 'coverage', 'bower_components']);
const MAX_FILE_BYTES = 1_000_000;

// Provider detection: import/usage signatures.
const PROVIDERS = [
  ['anthropic', /(import anthropic|from anthropic|@anthropic-ai\/sdk|anthropic-sdk-go|AnthropicBedrock|AnthropicVertex|['"`]claude-[a-z0-9-]+)/i],
  ['openai', /(import openai|from openai|require\(['"]openai['"]\)|from ['"]openai['"]|AzureOpenAI|['"`]gpt-[0-9])/],
  ['gemini', /(google\.generativeai|google\.genai|from google import genai|@google\/genai|@google\/generative-ai|['"`]gemini-[0-9])/],
  ['bedrock', /(bedrock-runtime|BedrockRuntime|invoke_model|InvokeModelCommand)/],
  ['vertex', /\b(vertexai|aiplatform)\b/],
  ['mistral', /(mistralai|@mistralai\/)/],
  ['cohere', /(import cohere|cohere-ai)/],
  ['groq', /(from groq|groq-sdk)/],
  ['ollama', /(ollama|:11434)/i], // a bare /api/generate is too often an app's own route
  ['litellm', /(import litellm|from litellm|litellm\.completion)/],
  ['langchain', /(langchain|ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI)/],
  ['openrouter', /openrouter\.ai/],
  ['other-http', /(api\.deepseek\.com|api\.together\.xyz|api\.x\.ai|api\.perplexity\.ai|api\.fireworks\.ai)/],
];

// A call that spends tokens.
const CALL = /(\.messages\.(create|stream|parse)\(|\.chat\.completions\.create\(|\.completions\.create\(|\.responses\.create\(|generate_content(_async)?\(|generateContent(Stream)?\(|\.a?invoke\(|litellm\.a?completion\(|invoke_model\(|\.converse\(|ollama\.(chat|generate)\(|\/api\/(generate|chat)|\.embeddings\.create\(|embed_content\()/;

// Family then only - . : / digits/letters, so "GEMINI_API_KEY" is not taken for a model id.
const MODEL = /['"`]((?:claude|gpt|o[134]|gemini|mistral|llama|command|deepseek|grok|qwen|phi)(?:[-.:\/0-9][\w.:\/-]*)?)['"`]/i;
const KEY_NAME = /\b([A-Z][A-Z0-9_]*(?:API_KEY|_TOKEN|_SECRET|_KEY))\b/g;
const KEY_VENDOR = /(ANTHROPIC|OPENAI|GEMINI|GOOGLE|MISTRAL|COHERE|GROQ|OPENROUTER|DEEPSEEK|TOGETHER|XAI|AZURE|BEDROCK|OLLAMA|HUGGINGFACE|HF_|PERPLEXITY|FIREWORKS|ELEVENLABS)/;

// Rough price tier for a model id. ponytail: name-based; edit when new model families ship.
function tier(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return 'unknown';
  if (/haiku|(?<!ge)mini|nano|flash-lite|-lite|small|\b8b|\b7b/.test(m)) return 'cheap';
  if (/fable|mythos|opus|gpt-5|^o1|^o3|-pro\b|gemini-[0-9.]+-pro/.test(m)) return 'premium';
  return 'mid';
}

function walk(root) {
  const out = [];
  const go = d => {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name) && !e.name.startsWith('.')) go(p); }
      else if (CODE.test(e.name) && !/(\.test\.|\.spec\.|_test\.|^test_)/.test(e.name)) out.push(p);
    }
  };
  go(root);
  return out;
}

function inLoop(lines, i) {
  const indent = l => l.match(/^\s*/)[0].length;
  const me = indent(lines[i]);
  for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
    const l = lines[j];
    if (!l.trim()) continue;
    if (indent(l) < me && /^\s*(for\b|while\b|async for\b)|\.(map|forEach|flatMap)\(|ThreadPoolExecutor|asyncio\.gather|Promise\.all/.test(l)) return true;
    if (indent(l) === 0 && /^(def |async def |class |function |async function |export )/.test(l)) return false;
  }
  return false;
}

function recommend(provider, f) {
  const r = [];
  if (!f.maxTokens) r.push({ id: 'cap-output', saving: 'medium', text: 'Set an output-token cap sized to the expected answer; runaway outputs are billed in full.' });
  if (!f.caching && ['anthropic', 'gemini', 'openai', 'bedrock', 'vertex'].includes(provider)) r.push({ id: 'prompt-cache', saving: 'high', text: 'Keep the fixed instructions first and identical across calls, and enable prompt caching (Anthropic cache_control, Gemini context caching; OpenAI caches stable prefixes automatically). Cached input costs ~10% of normal.' });
  if (f.loop && !f.batch) r.push({ id: 'batch', saving: 'high', text: 'Called inside a loop: if results are not needed immediately, use the provider batch API (~50% cheaper), and dedupe/cache identical inputs.' });
  if (f.tier === 'premium') r.push({ id: 'model-tier', saving: 'high', ask: true, text: `Premium model "${f.model}": confirm the task needs it; test a cheaper tier on 20-50 real inputs before switching.` });
  if (provider === 'gemini' && /2\.5|-3/.test(String(f.model)) && !f.thinkingCap) r.push({ id: 'thinking-cap', saving: 'high', text: f.legacyGemini ? 'Thinking tokens are billed as output and the legacy google-generativeai SDK cannot cap them; migrate this call to google-genai and set a thinking budget.' : 'Set a thinking budget (low or 0 for extraction/formatting); thinking tokens are billed as output.' });
  if ((provider === 'anthropic' || provider === 'openai') && f.tier !== 'cheap' && !f.thinkingCap) r.push({ id: 'effort', saving: 'medium', text: 'Set reasoning effort explicitly and use lower effort for simple tasks.' });
  if (!f.jsonMode && f.tier !== 'unknown') r.push({ id: 'structured', saving: 'low', text: 'If the reply is parsed, use structured output/JSON mode: shorter replies and no retry-on-bad-JSON calls.' });
  if (!f.model) r.push({ id: 'model-unknown', saving: 'n/a', ask: true, text: 'Model comes from config/env; confirm the value actually deployed.' });
  return r;
}

function analyseCall(lines, i, provider, fileModels, fullText) {
  const win = lines.slice(Math.max(0, i - 15), i + 30).join('\n');
  // Prefer a versioned id ("gemini-2.5-flash") over a bare family word, nearby first, then anywhere in the file.
  const near = [...win.matchAll(new RegExp(MODEL.source, 'gi'))].map(m => m[1]);
  const model = [...near, ...fileModels].find(m => /\d/.test(m)) || near[0] || fileModels[0] || null;
  const has = re => re.test(win);
  const f = {
    model,
    tier: tier(model),
    maxTokens: has(/max_tokens|max_output_tokens|maxOutputTokens|maxTokens|num_predict|max_completion_tokens/),
    caching: has(/cache_control|cachedContent|cached_content|prompt_cache_key|caches\.create/),
    thinkingCap: has(/thinking|reasoning_effort|reasoning:\s*\{|thinkingBudget|thinking_budget|effort/),
    jsonMode: has(/response_mime_type|response_format|json_schema|output_config|responseMimeType|format['"]?\s*:\s*['"]json/),
    batch: has(/batches|batch_create|BatchPrediction/),
    loop: inLoop(lines, i),
    legacyGemini: provider === 'gemini' && /google\.generativeai|@google\/generative-ai/.test(fullText),
  };
  f.recommendations = recommend(provider, f);
  return f;
}

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

function envKeyNames(root) {
  const names = new Set();
  for (const n of ['.env', '.env.example', '.env.local', '.env.sample', '.env.template']) {
    for (const line of safeRead(path.join(root, n)).split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/); // name only; the value is never kept
      if (m && KEY_VENDOR.test(m[1])) names.add(m[1]);
    }
  }
  return names;
}

// Other tools already between Claude Code and the model: advice must work alongside them.
function detectRouters(configDir, root, env = process.env) {
  const found = [];
  if (env.ANTHROPIC_BASE_URL) found.push({ kind: 'env', name: 'ANTHROPIC_BASE_URL', note: 'Claude Code traffic goes through a proxy/router; savings are still measured from session transcripts, but real prices may differ from list.' });
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    if (env[k]) found.push({ kind: 'env', name: k, note: 'Model override: the cheap subagent tier resolves to whatever this points at.' });
  }
  for (const f of [path.join(configDir, 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')]) {
    let s;
    try { s = JSON.parse(safeRead(f)); } catch { continue; }
    for (const k of Object.keys(s.env || {})) if (/^ANTHROPIC_(BASE_URL|MODEL|DEFAULT_|SMALL_FAST)|SUBAGENT_MODEL/.test(k)) found.push({ kind: 'settings', name: k, file: f });
    for (const p of Object.keys(s.enabledPlugins || {})) {
      const n = p.split('@')[0]; // the marketplace part ("…@claude-token-plugins") must not match
      if (/rout|proxy|omni|gateway|litellm|ccr|token|cost/i.test(n) && n !== 'jev-router') found.push({ kind: 'plugin', name: p, note: 'Another routing/token plugin is enabled; jev-router only adds hints and subagents, so both can run.' });
    }
  }
  if (fs.existsSync(path.join(os.homedir(), '.claude-code-router'))) found.push({ kind: 'tool', name: 'claude-code-router' });
  for (const n of ['litellm_config.yaml', 'litellm.yaml', 'config.yaml']) if (/model_list/.test(safeRead(path.join(root, n)))) found.push({ kind: 'tool', name: 'litellm', file: n });
  return found;
}

function scan(root, configDir, env) {
  const sites = [];
  const keys = envKeyNames(root);
  const providers = new Set();
  const repoSdk = { legacy: false, modern: false };
  for (const file of walk(root)) {
    try { if (fs.statSync(file).size > MAX_FILE_BYTES) continue; } catch { continue; }
    const text = safeRead(file);
    const fileProviders = PROVIDERS.filter(([, re]) => re.test(text)).map(([n]) => n);
    if (!fileProviders.length) continue;
    if (/google\.generativeai|@google\/generative-ai/.test(text)) repoSdk.legacy = true;
    if (/google\.genai|from google import genai|@google\/genai/.test(text)) repoSdk.modern = true;
    for (const m of text.matchAll(KEY_NAME)) if (KEY_VENDOR.test(m[1])) keys.add(m[1]);
    const lines = text.split('\n');
    const fileModels = [...text.matchAll(new RegExp(MODEL.source, 'gi'))].map(m => m[1]);
    lines.forEach((line, i) => {
      if (!CALL.test(line) || /^\s*(#|\/\/|\*)/.test(line)) return;
      const ctx = lines.slice(Math.max(0, i - 15), i + 5).join('\n');
      const provider = fileProviders.find(n => PROVIDERS.find(p => p[0] === n)[1].test(ctx)) || fileProviders[0];
      providers.add(provider);
      sites.push({ file: path.relative(root, file).split(path.sep).join('/'), line: i + 1, provider, ...analyseCall(lines, i, provider, fileModels, text) });
    });
  }
  // Clients are often built in a helper module, so judge the Gemini SDK repo-wide as well as per file.
  if (repoSdk.legacy && !repoSdk.modern) {
    for (const s of sites) if (s.provider === 'gemini' && !s.legacyGemini) { s.legacyGemini = true; s.recommendations = recommend('gemini', s); }
  }
  return { root, scannedAt: new Date().toISOString(), providers: [...providers].sort(), keyEnvNames: [...keys].sort(), routers: detectRouters(configDir, root, env), sites };
}

const RANK = { high: 0, medium: 1, low: 2, 'n/a': 3 };

function print(r) {
  console.log(`LLM usage scan: ${r.root}`);
  console.log(`providers with call sites: ${r.providers.join(', ') || 'none found'}`);
  console.log(`key/config env names referenced (values never read): ${r.keyEnvNames.join(', ') || 'none'}`);
  console.log(`existing routers/proxies: ${r.routers.map(x => x.name).join(', ') || 'none'}`);
  const byTier = r.sites.reduce((a, s) => ((a[s.tier] = (a[s.tier] || 0) + 1), a), {});
  console.log(`\n${r.sites.length} call sites · tiers ${JSON.stringify(byTier)} · in loops ${r.sites.filter(s => s.loop).length}`);
  for (const s of r.sites) {
    const flags = [s.loop && 'in-loop', s.tier, !s.maxTokens && 'no-cap', !s.caching && 'no-cache'].filter(Boolean).join(' ');
    console.log(`\n${s.file}:${s.line}  [${s.provider}] ${s.model || '(model from config)'}  ${flags}`);
    for (const rec of [...s.recommendations].sort((a, b) => RANK[a.saving] - RANK[b.saving])) console.log(`  - (${rec.saving}${rec.ask ? ', ask user' : ''}) ${rec.text}`);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const root = path.resolve(argv.find(a => !a.startsWith('--')) || process.cwd());
  const r = scan(root, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else print(r);
}

module.exports = { scan, tier };
