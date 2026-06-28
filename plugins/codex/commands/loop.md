---
description: Run the Codex maintenance loop across one repo or recent /dev repos with WSL and leak guards
argument-hint: '[--cwd <repo>|--discover-dev] [--run-tests] [--foreground-review] [--push] [--once|--max-iterations <n>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the bundled Codex loop:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-loop.mjs" --cwd "${CLAUDE_PROJECT_DIR:-$PWD}" $ARGUMENTS
```

Output rules:
- Return the command stdout verbatim.
- Do not summarize or rewrite the report.
- Do not continue with Claude-side edits if the loop reports `stopReason`.
- Treat `--push` as an explicit user request only; never add it yourself.

