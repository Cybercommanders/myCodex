---
description: Initialize Codex for this repository and run preflight checks for auth, hooks, runtime, and WSL health
argument-hint: '[--foreground-review|--background-review|--disable-review-gate|--no-mywsl|--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the bundled Codex preflight for the current repository:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-init-preflight.mjs" --cwd "${CLAUDE_PROJECT_DIR:-$PWD}" $ARGUMENTS
```

Output rules:
- Return the command stdout verbatim.
- Do not summarize or rewrite the report.
- Preserve the `[cleanup]`, `[memory]`, `[init]`, and `[warnings]` sections exactly as printed.
- If the command exits nonzero, show the stdout and stderr without starting repairs of your own.

