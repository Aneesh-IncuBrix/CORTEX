# CORTEX — Claude Code token-efficiency plugins

A Claude Code plugin marketplace with two independent plugins that reduce Claude credit usage:

| Plugin | What it does | Status |
|---|---|---|
| **jev-router** | A fully local, JEV-style decision engine (23 MB model, no API key) that routes each prompt to the cheapest capable subagent and guards token-heavy tool calls | In development |
| **cortex** | Local-first persistent memory: Markdown knowledge base, a generated `CORTEX.md` index, budgeted retrieval across sessions | Designed; built after jev-router |

**Privacy:** both plugins run entirely on your machine and make no network calls, apart from jev-router's
one-time, checksummed engine download during setup. Claude Code itself still sends your conversation to
Anthropic as usual.

Design specs: [`docs/superpowers/specs/`](docs/superpowers/specs/).

## jev-router commands

| Command | What it does |
|---|---|
| `/jev-router:setup` | One-time local engine install (routing is off until this runs). |
| `/jev-router:optimize` | Scans your codebase for every LLM call (Anthropic, OpenAI, Gemini, Bedrock, Vertex, Mistral, Cohere, Groq, Ollama, LiteLLM, LangChain, OpenRouter…), detects routers you already use (OmniRoute, claude-code-router, LiteLLM, `ANTHROPIC_BASE_URL`), asks which models to keep or reduce and your monthly budget, then proposes caps, caching, thinking/effort limits, batching and model changes for you to approve. Reads env var names only, never key values. |
| `/jev-router:dashboard` | Local HTML dashboard: cost and tokens per prompt before vs after the plugin and vs the random holdout, pushback rate, and cost per accepted answer (so cheaper-but-worse never looks like a saving). |
| `/jev-router:reconcile` | Compares the list-price estimate with your real bill per day: Anthropic Admin API cost report (`ANTHROPIC_ADMIN_KEY`, admin key only) or AWS Cost Explorer for Bedrock (`ce:GetCostAndUsage`). Read-only; the key is never printed or stored. The dashboard then shows the real bill and the correction factor. |
| `/jev-router:doctor` | Engine health and recent routing decisions. |

Scripts you can run directly (Node 18+, no dependencies):

```bash
node plugins/jev-router/scripts/scan-llm.js <repo> [--json]          # where tokens are spent in code
node plugins/jev-router/scripts/savings-report.js --budget 300        # Claude Code $/prompt, routed vs not, month-end projection
node plugins/jev-router/scripts/build-labels.js                       # teach difficulty routing from your own history
```

How jev-router proves and improves itself:

- **Context warning:** when a session's context passes 150k tokens (setting `ctx_warn_tokens`), it suggests `/compact` or a fresh session, once per further 50k.
- **Holdout:** 10% of sessions (setting `holdout_percent`) get no hints at all. `savings-report.js` compares hinted sessions with this random control group, so the saving is measured, not assumed.
- **Pushback as quality signal:** a prompt like "no, that's wrong" marks the previous turn as a miss. The report shows the pushback rate per group, and `build-labels.js` learns that such prompts were harder than they looked.

Savings figures use first-party list prices and are estimates. If you route through another provider, your real prices differ.

## Install

In Claude Code (2.1.275 or later):

```
/plugin install jev-router --marketplace Aneesh-IncuBrix/CORTEX
/jev-router:setup
```

Context warnings, the holdout and the dashboard work immediately; prompt routing starts after `/jev-router:setup`. Then run `node <plugin>/scripts/build-labels.js` once so difficulty routing learns from your own history.

License: MIT
