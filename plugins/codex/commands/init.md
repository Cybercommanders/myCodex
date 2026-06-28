---
description: Initialize Codex for this repository and run preflight checks for auth, hooks, runtime, and WSL health
argument-hint: '[--enable-review-gate|--disable-review-gate|--force|--reap|--foreground-review|--background-review|--no-mywsl|--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Run the bundled Codex preflight for the current repository:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-init-preflight.mjs" --cwd "${CLAUDE_PROJECT_DIR:-$PWD}" $ARGUMENTS
```

It is idempotent: when the repo is already set up and healthy it reports
`already initialized` and skips re-running setup (pass `--force` to re-run). It
preserves the current review-gate state — it only changes the gate when you pass
`--enable-review-gate` or `--disable-review-gate` (a brand-new repo defaults the
gate on). It also reports a read-only `[processes]` section (tracked jobs, broker
liveness, orphaned Codex processes, stale locks); pass `--reap` to terminate
orphans and clear stale locks.

Output rules:
- Return the command stdout verbatim.
- Do not summarize or rewrite the report.
- Preserve the `[cleanup]`, `[memory]`, `[init]`, `[processes]`, and `[warnings]` sections exactly as printed.
- If the command exits nonzero, show the stdout and stderr without starting repairs of your own.

