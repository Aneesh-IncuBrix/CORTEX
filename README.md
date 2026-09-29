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

Install instructions will be added once the first plugin is published.

License: MIT
