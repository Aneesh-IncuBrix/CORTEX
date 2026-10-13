---
description: Open jev-router's token dashboard — cost and tokens per prompt before vs after the plugin, against a random holdout, with quality (pushback rate, cost per accepted answer). Use when the user invokes /jev-router:dashboard or asks how much the plugin saves or whether quality held.
---

Run exactly this with the Bash tool, then show the user the first output line verbatim and the file path:

node "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.js" --data "${CLAUDE_PLUGIN_DATA}" --open

If it says "Collecting data", explain in one sentence that no saving is claimed until 100 prompts have run with the plugin.
