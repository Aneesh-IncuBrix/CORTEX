---
description: Install (or remove with --uninstall) jev-router's local decision engine. One-time ~100 MB download of pinned, checksum-verified files; afterwards routing runs fully offline. Run only when the user invokes /jev-router:setup.
disable-model-invocation: true
argument-hint: "[--lite | --uninstall | --model-dir <folder>]"
---

Run exactly this command with the Bash tool (timeout 600000 ms) and then show the user its output verbatim. Do not change the command or retry it with different flags. If it fails, show the error and suggest `/jev-router:doctor`.

node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.js" --data "${CLAUDE_PLUGIN_DATA}" $ARGUMENTS
