# CORTEX — Claude Code token-efficiency plugins

A Claude Code plugin marketplace with two independent plugins that reduce Claude credit usage:

| Plugin | What it does | Status |
|---|---|---|
| **jev-router** | Uses TypeSafe's JEV decision model (or a local fallback) to route each prompt to the cheapest capable subagent, and guards token-heavy tool calls | Design under review |
| **cortex** | Local-first persistent memory: Markdown knowledge base, a generated `CORTEX.md` index, budgeted retrieval across sessions | Design under review; built after jev-router |

Design specs: [`docs/superpowers/specs/`](docs/superpowers/specs/).

Install instructions will be added once the first plugin is published.

License: MIT
