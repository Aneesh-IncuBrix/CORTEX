---
description: Show jev-router's health — engine status and checksums, agent catalog size, recent routing decisions, guard activity. Use when the user invokes /jev-router:doctor or asks whether jev-router is working.
---

Run exactly this command with the Bash tool and show the user its output verbatim, then add one sentence on anything marked ✗ or NOT INSTALLED.

node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.js" --data "${CLAUDE_PLUGIN_DATA}"
