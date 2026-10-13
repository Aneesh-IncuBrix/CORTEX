---
description: Compare jev-router's list-price cost estimate with the user's real bill (Anthropic Admin API cost report or AWS Cost Explorer for Bedrock), per day, and calibrate the dashboard. Use when the user invokes /jev-router:reconcile or asks for the real/actual price difference.
---

Never ask the user to paste a key into the chat, and never print, echo or write a key anywhere.

1. Ask (AskUserQuestion) how their Claude Code usage is billed: "Anthropic API (Console)", "Amazon Bedrock", "Claude subscription (Pro/Max/Team)", "Claude Enterprise". For a subscription, explain there is no per-token bill to compare with and stop. For Enterprise, explain it needs the Analytics API (not supported yet) and stop.
2. Anthropic API: the user needs an Admin API key (`sk-ant-admin01-…`, created by an org admin in Console → Settings → Admin keys). Ask them to set it themselves in their shell as `ANTHROPIC_ADMIN_KEY` before you run anything, then run:

   node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile-cost.js" --source anthropic --data "${CLAUDE_PLUGIN_DATA}"

3. Bedrock: needs the AWS CLI and a profile allowed `ce:GetCostAndUsage`. Ask which profile (or default), then run:

   node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile-cost.js" --source bedrock --aws-profile <profile> --data "${CLAUDE_PLUGIN_DATA}"

4. Show the totals line and any warning it prints. Explain the factor in one sentence: the bill can include other people, apps or machines on the same account, so a factor well above 1 does not mean the estimate is wrong. Then offer `/jev-router:dashboard`, which now shows the real bill next to the estimate.

If it fails with 401/403 (Anthropic) or AccessDenied (AWS), say which permission is missing; do not retry with other credentials.
