# Universal LLM Optimizer — Setup Guide

Route every LLM request (from Claude Code and from your own apps) to the cheapest model that can do the job, with failover, budgets and cost tracking.

> **Status (2026-10-05):** Part A uses LiteLLM, an existing open-source gateway, and works today. Parts B–C are the pieces `claude-token-plugins` adds on top; they are **planned, not built yet**. The steps in Part A are taken from the LiteLLM docs and have **not yet been run on this machine**.

---

## How it fits together

```
Claude Code ──(ANTHROPIC_BASE_URL)──┐
Your Python / Node apps ─(OPENAI_BASE_URL)─┤
                                    ▼
                 LiteLLM gateway  (localhost:4000)
                 ├─ complexity router (tiers)
                 ├─ classifier: heuristic | custom (our local engine)
                 ├─ fallbacks on 429 / 5xx
                 ├─ budgets per key / per provider
                 └─ cost + token tracking
                                    ▼
            Gemini · Claude · OpenAI · Groq · OpenRouter · local
```

A Claude Code plugin **cannot** intercept other applications' API calls. That's why apps go through the gateway, and Claude Code is pointed at the same gateway.

---

## Part A — Gateway (works today)

### 1. Install

Requires Python 3.10–3.13. LiteLLM may not support 3.14 yet, so use a 3.12 venv:

```bash
python -m venv .venv-gateway
# Windows: .venv-gateway\Scripts\activate   |   macOS/Linux: source .venv-gateway/bin/activate
pip install "litellm[proxy]"
```

### 2. Keys: environment variables only, never in files you commit

```bash
# PowerShell
$env:GEMINI_API_KEY    = "<your new Gemini key>"
$env:ANTHROPIC_API_KEY = "<your Anthropic key>"
$env:OPENAI_API_KEY    = "<optional>"
$env:LITELLM_MASTER_KEY = "sk-local-<random string>"   # protects the gateway itself
```

### 3. `gateway/config.yaml`

```yaml
model_list:
  # --- individual models (prices are LiteLLM's built-in table) ---
  - model_name: g-flash-lite
    litellm_params: { model: gemini/gemini-2.5-flash-lite, api_key: os.environ/GEMINI_API_KEY }
  - model_name: g-flash
    litellm_params: { model: gemini/gemini-2.5-flash, api_key: os.environ/GEMINI_API_KEY }
  - model_name: c-haiku
    litellm_params: { model: anthropic/claude-haiku-4-5-20251001, api_key: os.environ/ANTHROPIC_API_KEY }
  - model_name: c-sonnet
    litellm_params: { model: anthropic/claude-sonnet-5-5, api_key: os.environ/ANTHROPIC_API_KEY }

  # --- the router your apps call ---
  - model_name: smart-router
    litellm_params:
      model: auto_router/complexity_router
      complexity_router_config:
        tiers:
          SIMPLE:    g-flash-lite
          MEDIUM:    g-flash
          COMPLEX:   c-sonnet
          REASONING: c-sonnet
      complexity_router_default_model: g-flash

router_settings:
  fallbacks:                       # used on 429 / 5xx / timeouts
    - { g-flash-lite: [g-flash] }
    - { g-flash:      [c-haiku] }
    - { c-sonnet:     [g-flash] }

litellm_settings:
  drop_params: true                # ignore params a provider doesn't support
```

### 4. Start

```bash
litellm --config gateway/config.yaml      # listens on http://localhost:4000
```

### 5. Point your apps at it

**OpenAI-compatible SDKs (Python/Node):**
```bash
OPENAI_BASE_URL=http://localhost:4000/v1
OPENAI_API_KEY=$LITELLM_MASTER_KEY
# in code, use model="smart-router"
```

**Apps that use the Gemini SDK directly** (your video-gen and Image creation repos use `gemini-2.5-flash` in 61 files): switch those calls to an OpenAI-compatible client with `model="smart-router"`, or keep them on Gemini but set `thinkingBudget` (Part C).

### 6. Point Claude Code at it (optional, read the caveats)

```bash
ANTHROPIC_BASE_URL=http://localhost:4000
ANTHROPIC_AUTH_TOKEN=$LITELLM_MASTER_KEY
ANTHROPIC_CUSTOM_MODEL_OPTION=smart-router
```

Caveats:
- Changing model mid-conversation throws away Claude's prompt cache, which can **raise** cost.
- Non-Claude models handle Claude Code's tools less reliably.
- Start by routing only subagent and background work, and compare with the benchmark (Part D) before enabling it for everything.

### 7. Budgets, keys and the dashboard

Create a gateway key per repo, so spend is tracked and capped per project:

```bash
curl -X POST http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" \
  -d '{"key_alias":"video-gen","max_budget":20,"budget_duration":"30d"}'
```

The dashboard is at `http://localhost:4000/ui`. Spend logging needs a Postgres `DATABASE_URL`; see the LiteLLM docs.

---

## Part B — What `claude-token-plugins` adds (planned)

| Piece | Purpose |
|---|---|
| **Local classifier plugin** (`classifier_type: custom`) | Our on-device engine plus heuristics decide the tier. No LLM call, so the optimizer costs ~0 tokens. Needs the difficulty fix found in testing (it currently rates everything "simple"). |
| **Secret-redaction pre-call hook** | Strips API keys, passwords and private keys from prompts before any provider sees them. |
| **Quality check and escalation** | JSON/schema validation, plus lint/tests for code. If a cheap model's answer fails, retry one tier up. |
| **Claude Code plugin commands** | `/token-status`, `/token-report`, `/token-route "<prompt>"`, reading the gateway's spend data. |
| **Benchmark harness** | Replays your real prompts through *always-premium*, *always-cheap* and *router*, and reports cost, tokens and success rate. |

---

## Part C — Free savings to apply first (measured 2026-10-05)

1. **Cap Gemini thinking.** In our runs, hidden "thinking" was ~75–80% of `gemini-2.5-flash` output tokens, billed at $2.50/M. Set `thinkingBudget` low (or 0) for extraction, formatting and short answers.
2. **Reuse prompt prefixes.** Gemini cached input is $0.03/M vs $0.30/M uncached; keep system prompts identical and at the start of the request.
3. **Batch non-urgent jobs** (render pipelines) with the provider's batch API, which is discounted.

---

## Part D — Proving the savings

Measured on 8 code-reading tasks (keyword-checked answers, 2–4 runs each):

| Model | Correct | Avg $/task |
|---|---|---|
| Claude Sonnet (inside Claude Code) | 94% | $0.242 |
| Gemini 2.5 Flash (bare agent) | 96% | $0.012 |
| Gemini 2.5 Flash-Lite | 59% | $0.0004 |

These are directional, not final: the Claude number includes ~45k tokens of Claude Code start-up context. Before trusting the router for an app, replay ~100 of that app's real prompts through it and check that quality holds.

---

## Security checklist

- [ ] Rotate any key that was ever pasted into a chat or committed.
- [ ] Keys only in env vars or the gateway's secret store; never in `config.yaml` values.
- [ ] Set `LITELLM_MASTER_KEY`; bind the gateway to `127.0.0.1` unless you mean to share it.
- [ ] Turn off prompt logging unless you need it.

## Sources

- LiteLLM Auto Routing: https://docs.litellm.ai/docs/proxy/auto_routing
- LiteLLM Routing & fallbacks: https://docs.litellm.ai/docs/routing-load-balancing
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
