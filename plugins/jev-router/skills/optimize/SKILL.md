---
description: Find every place this codebase (and Claude Code itself) spends LLM tokens, ask the user which models to keep or reduce and what budget to hold, then propose and apply approved token-saving changes. Use when the user invokes /jev-router:optimize, or asks to cut token/LLM/API costs, audit model usage, or stay within an AI budget.
---

# Optimize token usage

Goal: lower token spend without lowering quality and without raising the user's budget. You propose; the user decides. Never change a model, effort level, or prompt the user has not approved.

## Hard rules

- Never print, copy, move, or log API key **values**. Work with env var names only. Do not open `.env` files beyond what the scanner reports.
- Never switch a call site to a cheaper model silently. Model changes need the user's explicit choice in step 3, and a quality check (step 5).
- If another router/proxy/token plugin is reported (OmniRoute, claude-code-router, LiteLLM, `ANTHROPIC_BASE_URL`, model overrides), work alongside it: do not remove or reconfigure it unless the user asks. Say that savings are still measured from Claude Code transcripts, and real prices depend on that router.
- Edits go through normal review: small diffs, one concern per change, tests run where the repo has them.

## 1. Scan (read-only)

Run both and keep the output for the next steps:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-llm.js" "${CLAUDE_PROJECT_DIR:-.}"
node "${CLAUDE_PLUGIN_ROOT}/scripts/savings-report.js" --data "${CLAUDE_PLUGIN_DATA}" --since "$(date -u +%Y-%m-01)"
```

The scanner is regex-based. Before relying on a site, Read ±20 lines around it to confirm it is a real model call and see the actual model, prompt size and settings. Drop false positives and say so.

## 2. Summarise for the user (short)

- Providers found, number of call sites, which run in loops, which use premium models.
- Existing routers/proxies, and what that means for them.
- This month's Claude Code spend from the report.
- The top 3–5 changes ranked by likely saving, each with `path:line`.

## 3. Ask (AskUserQuestion, one round, up to 4 questions)

Ask only what changes what you do next:

1. **Monthly budget** for this work (USD), or "no fixed budget". Use it with `--budget` in step 6.
2. **Models, per provider found**: "Keep current models", "Use a cheaper tier where quality holds (Recommended)", "Let me choose per call site". For Claude Code itself also offer: keep main model / cheaper default effort / route simple work to the Haiku subagents (`jev-router:quick`, `jev-router:scout`).
3. **How to apply**: "Propose diffs, I approve each (Recommended)" or "Apply all low-risk ones (caps, caching, batching), propose model changes".
4. **Quality check** for model changes: "I'll provide 20–50 sample inputs", "Use inputs from existing tests/fixtures", or "Skip model changes".

If they choose per call site, ask again listing the premium/unknown-model sites (up to 4 per question).

## 4. Change, safest first

Apply in this order and stop at whatever the user approved:

1. **Output caps** where missing, sized from what the code reads from the reply.
2. **Prompt caching**: move fixed instructions to the front, keep them byte-identical across calls, add the provider's cache control.
3. **Thinking/effort caps**: Gemini thinking budget, Anthropic `output_config.effort`, OpenAI `reasoning_effort`. If the scanner says the SDK is too old to set it (e.g. legacy `google-generativeai`), propose the SDK migration as its own change instead of a workaround.
4. **Loops**: dedupe identical inputs, cache results, or move non-urgent work to the batch API.
5. **Structured output** where the code parses JSON from the reply.
6. **Model tier**, only for sites the user approved, behind a config value or env var so it can be reverted without a code change.

For Claude Code's own usage (if the user opted in), suggest settings rather than editing them: a lower default effort, `CLAUDE_CODE_SUBAGENT_MODEL` or the Haiku subagents for search and small edits, and keeping jev-router in `advise` mode.

## 5. Check quality before keeping a model change

Run the same sample inputs through the old and new setting (or the repo's tests). Report pass rate and token use for both. If quality drops, revert that change and say so. Calls cost money: tell the user the rough count first.

## 6. Report

Re-run the report with the budget and show the result:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/savings-report.js" --data "${CLAUDE_PLUGIN_DATA}" --since "$(date -u +%Y-%m-01)" --budget <USD>
```

End with: what changed (`path:line`), what was skipped and why, the estimated saving per change as a range (not a promise), and how to measure the real saving after a week of use. No saving may be claimed from the report until it says there is enough routed data.
