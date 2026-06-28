# Plan — `cc-plugin-codex`: mirror the Codex plugin in reverse (Codex → Claude Code)

## Context

`codex-plugin-cc` is a **Claude Code** plugin: "use Codex from Claude Code to review code or delegate tasks." The request is the mirror — **`cc-plugin-codex`**, a **Codex** plugin that delegates the other way: from inside Codex, use **Claude Code** to review a diff, delegate a task, and (optionally) gate session-stop behind a review.

This was validated as a feasibility study first. Two load-bearing facts were **verified live** (not assumed):

- **Codex has a full plugin system** matching Claude Code's package format. `codex plugin add/list/marketplace/remove` exists; `~/.codex/config.toml` has `plugin_hooks = true` and `[hooks.state]` entries for `session_start`, `stop`, `pre/post_tool_use`, `user_prompt_submit`, `pre/post_compact`. The existing codex plugin is installed on **both** runtimes and its `hooks/hooks.json` (PascalCase `SessionStart`/`SessionEnd`/`Stop`, `${CLAUDE_PLUGIN_ROOT}`, `type:command`) is consumed by Codex unchanged. Other Codex plugins (`oh-my-codex`, `claude-mem`, `review-loop`) ship the same shape.
- **Claude Code 2.1.177 has headless mode:** `claude -p` with `--output-format text|json|stream-json`, **`--json-schema`** (runtime-enforced structured output), `--effort`, `--session-id`/`--resume`/`--continue`, `--model`, `--allowedTools`/`--disallowedTools`, `--permission-mode`, `--add-dir`, `--mcp-config`, `--append-system-prompt`, `--max-turns`.

**Verdict: highly feasible.** ~60–70% of the existing package is format-identical reuse. The only substantial new code is one transport file (`lib/claude.mjs`) that spawns `claude -p`; the entire Codex app-server + broker stack is **deleted** (no long-lived server to share — each `claude -p` is standalone). Decisions taken: **plugin mirror (1:1)**, **full build in one pass** (all 7 commands + background jobs + stop-gate + test port).

Outcome: a user runs `codex plugin add cc@cc-plugin-codex` and gets `/cc:review`, `/cc:adversarial-review`, `/cc:rescue`, `/cc:status`, `/cc:result`, `/cc:cancel`, `/cc:setup` inside Codex, backed by Claude Code.

## Target location & package shape

**New private GitHub repo + separate working folder** (NOT a fork, NOT inside `codex-plugin-cc`):
- Folder: **`~/dev/cc-plugin-codex/`** — independent git repo (`git init`), separate from `~/dev/codex-plugin-cc`.
- Remote: **`gh repo create Cybercommanders/cc-plugin-codex --private --source ~/dev/cc-plugin-codex`** (private; owner = Cybercommanders, the authed account). No `upstream` — this is original, not a fork.
- Reuse from `codex-plugin-cc` is by **copying files** into the new repo (the source is MIT/Apache per its LICENSE/NOTICE — carry the license + attribution in NOTICE).

Structure mirrors the source `plugins/codex/` → `plugins/cc/`:

```
cc-plugin-codex/
  .claude-plugin/marketplace.json            # name: cc-plugin-codex; plugins:[{name:cc, source:./plugins/cc}]
  package.json                               # name cc-plugin-codex; scripts: bump-version, check-version, test  (NO prebuild/build)
  plugins/cc/
    .claude-plugin/plugin.json               # name:cc, version, description, author
    commands/  review.md adversarial-review.md rescue.md status.md result.md cancel.md setup.md
    agents/    cc-rescue.md
    hooks/     hooks.json                     # SessionStart, SessionEnd, Stop
    prompts/   adversarial-review.md stop-review-gate.md   # reuse verbatim
    schemas/   review-output.schema.json      # reuse byte-for-byte (fed to claude --json-schema)
    skills/    claude-prompting/ cc-result-handling/
    scripts/
      cc-companion.mjs                        # orchestrator (mirror of codex-companion.mjs)
      session-lifecycle-hook.mjs             # SessionStart/SessionEnd (broker code removed)
      stop-review-gate-hook.mjs              # Stop gate (robust-scan fail-closed from day one)
      lib/  claude.mjs (NEW transport) state.mjs process.mjs git.mjs args.mjs prompts.mjs
            fs.mjs workspace.mjs tracked-jobs.mjs job-control.mjs render.mjs bump-version.mjs
    tests/  state.test.mjs process.test.mjs git.test.mjs render.test.mjs bump-version.test.mjs
            runtime.test.mjs (rewritten) fake-claude-fixture.mjs helpers.mjs
```

## Reuse-vs-rewrite map

Source paths are under `~/dev/codex-plugin-cc/plugins/codex/`.

### Reuse as-is (rename strings only)
- `scripts/lib/state.mjs` — the hardened durability core (cross-process lock, atomic writes, corrupt recovery, `reconstructFromJobFiles`). **Do not touch the lock/recovery logic.** Change only `FALLBACK_STATE_ROOT_DIR` tmp name `codex-companion`→`cc-companion` and the `[codex]` stderr prefix.
- `scripts/lib/process.mjs` — `terminateProcessTree`, `binaryAvailable`, `runCommand`. This is the cancellation mechanism. Zero changes.
- `scripts/lib/git.mjs` — `resolveReviewTarget`/`collectReviewContext` (working-tree/branch diff + sizing). Zero logic changes.
- `scripts/lib/args.mjs`, `prompts.mjs`, `fs.mjs`, `workspace.mjs` — pure helpers. Zero changes.
- `schemas/review-output.schema.json` — reuse byte-for-byte; now passed to `claude -p --json-schema`.
- `prompts/adversarial-review.md`, `prompts/stop-review-gate.md` — runtime-neutral (ALLOW/BLOCK contract, grounding rules). Reuse verbatim.
- Tests `state.test.mjs`, `process.test.mjs`, `git.test.mjs`, `render.test.mjs`, `bump-version.test.mjs` — port with path/string updates only.

### Adapt
- `scripts/lib/tracked-jobs.mjs` — keep job lifecycle/logging; rename `SESSION_ID_ENV` `CODEX_COMPANION_SESSION_ID`→`CC_COMPANION_SESSION_ID` (now the Codex session id).
- `scripts/lib/job-control.mjs` — keep snapshot/selection; re-map the progress-phase vocabulary in `getJobTypeLabel`/`inferLegacyJobPhase` from app-server lines ("turn started", "Reviewer started") to the `claude.mjs` event vocabulary ("Claude session started", "Running tool: Edit", "assistant message"). Drop `getSessionRuntimeStatus` coupling.
- `scripts/lib/render.mjs` — keep all renderers; swap "Codex"→"Claude"; drop "shared session/broker runtime" lines from `renderSetupReport`/`renderStatusReport`; route review rendering through `renderReviewResult` (drop the native-review branch). Keep `parseError` degradation.
- `scripts/codex-companion.mjs` → `scripts/cc-companion.mjs` — keep the full command dispatch, arg parsing, background spawn (`spawnDetachedTaskWorker`/`task-worker`), foreground runner, job bookkeeping. **Rewrite only `executeReviewRun`/`executeTaskRun` bodies** to call `lib/claude.mjs`. In `handleCancel`, drop `interruptAppServerTurn` (cancel = `terminateProcessTree(job.pid)` only). Replace the `spark`→`gpt-5.3-codex-spark` alias with Claude model aliases (or pass model through; `claude` knows `opus`/`sonnet`/`fable`). Align `VALID_REASONING_EFFORTS` to Claude's `{low,medium,high,xhigh,max}`.
- `scripts/session-lifecycle-hook.mjs` — keep `SessionStart` (export `CC_COMPANION_SESSION_ID`, `CLAUDE_PLUGIN_DATA`) and `SessionEnd` `cleanupSessionJobs` (the locked `updateState` cleanup — durability-critical, keep). **Drop all broker teardown** (`sendBrokerShutdown`/`teardownBrokerSession`/`clearBrokerSession`/`loadBrokerSession`).
- `scripts/stop-review-gate-hook.mjs` — keep the skeleton; swap `getCodexAvailability`→`getClaudeAvailability`; **ship `parseStopReviewOutput` as the robust-scan fail-closed design from `docs/architecture.md` §8** (scan whole text for ALLOW/BLOCK or JSON verdict; empty/tokenless/timeout/nonzero/invalid-JSON → BLOCK; bypass hint in every block reason). Spawns `cc-companion.mjs task --json`. Add recursive-gate guard: set `CC_STOP_GATE_ACTIVE=1` when spawning the gate's `claude -p`; hook no-ops if that env is set.
- `commands/*.md` (all 7) + `agents/codex-rescue.md`→`cc-rescue.md` — adapt copy + the one Bash line (`codex-companion.mjs`→`cc-companion.mjs`); namespace `codex:`→`cc:`; `setup.md` install step `npm i -g @openai/codex`→`npm i -g @anthropic-ai/claude-code`; keep `disable-model-invocation`, `allowed-tools`, the review size-estimate + AskUserQuestion + background flow verbatim.
- `package.json`, `scripts/bump-version.mjs`, `tests/bump-version.test.mjs` — rename package + version-file paths; **drop `prebuild` + `build` (tsc)**.

### Rewrite (net-new)
- `scripts/lib/claude.mjs` — the transport (spec below).
- `tests/runtime.test.mjs` + `tests/fake-claude-fixture.mjs` — a fake `claude` on PATH printing canned `--output-format json/stream-json` envelopes (review-ok, review-findings, task-ok, task-fail, hang-for-cancel). Simpler than the app-server fake (no JSON-RPC state machine).
- `skills/claude-prompting/` (adapted from `gpt-5-4-prompting`) and `skills/cc-result-handling/` (renamed from `codex-result-handling`).

### Drop
- `scripts/lib/app-server.mjs`, `scripts/lib/codex.mjs`, `scripts/app-server-broker.mjs`, `scripts/lib/broker-endpoint.mjs`, `scripts/lib/broker-lifecycle.mjs`, `scripts/lib/app-server-protocol.d.ts`, `.generated/**`, `tsconfig.app-server.json`, `tests/broker-endpoint.test.mjs`, `skills/codex-cli-runtime/` (fold its forwarding rules into `cc-rescue.md`).

## New transport — `scripts/lib/claude.mjs`

No broker, no JSON-RPC. One `claude -p` process per call; background jobs use the existing detached `task-worker` + pid tracking in `state.json`; cancel = `terminateProcessTree`. Use `child_process.spawn` (not `spawnSync`) with `--output-format stream-json --verbose --include-partial-messages` to drive live progress; the terminal NDJSON line is the `{type:"result", is_error, result, session_id, total_cost_usd, ...}` envelope (shape confirmed live).

- `getClaudeAvailability(cwd) -> {available, detail}` — `binaryAvailable("claude", ["--version"])`; shape parallels `getCodexAvailability` so `render.mjs`/setup are unchanged.
- `getClaudeAuthStatus(cwd) -> {available, loggedIn, detail, authMethod, requiresAuth}` — check `ANTHROPIC_API_KEY` first; otherwise a single `claude -p "ping" --max-turns 1 --output-format json` probe inside `/cc:setup` ONLY (never per-command; costs tokens). Ambiguous → "available, auth unverified" + guidance, don't block. Shape parallels `buildAuthStatus` so `buildSetupReport` ports with string swaps.
- `runClaudeReview(cwd, {target, context, model, focusText, kind, onProgress}) -> {status, sessionId, reviewJson, rawOutput, parseError, costUsd}` — prompt from `prompts/adversarial-review.md` (adversarial) or a built-in review prompt (native), wrapping `collectReviewContext()` output. Spawn read-only: `claude -p "<prompt>" --output-format stream-json --verbose --json-schema @schemas/review-output.schema.json --model <model> --permission-mode plan --allowedTools "Read,Glob,Grep,Bash(git:*)" --disallowedTools "Edit,Write,MultiEdit" --add-dir <repoRoot>`. Stream events → `onProgress` (tool_use→investigating, git/test→verifying). Parse the schema JSON from the result via `parseStructuredOutput` (lift from `codex.mjs:~1056` into `claude.mjs`); validate; on failure retry once with `--append-system-prompt "Return ONLY JSON matching the schema."`; else surface `parseError` (render degrades).
- `runClaudeTask(cwd, {prompt, write, model, effort, resumeSessionId, onProgress}) -> {status, sessionId, finalMessage, touchedFiles, rawOutput, costUsd}` — write tasks: `--permission-mode acceptEdits --allowedTools "Read,Glob,Grep,Edit,Write,MultiEdit,Bash" --add-dir <cwd>`; read-only: `--permission-mode plan` + read-only allow-list. Generate+pass `--session-id <uuid>` on first run; persist as the job's `threadId` (resume key); resume via `--resume <id>`. Collect `touchedFiles` from `Edit`/`Write`/`MultiEdit` tool_use events (mirror of `collectTouchedFiles`). `status = is_error ? 1 : 0`.
- **Cancellation:** the `task-worker` spawns `claude` in its own process group (`detached:true`) so `terminateProcessTree(-pid)` reaps it. SIGTERM is a hard stop (no graceful turn-drain — documented).

## Stop-review gate on Codex

Codex fires `Stop` from `hooks.json` (PascalCase confirmed working via `review-loop`), passes hook-input JSON on stdin, honors `{"decision":"block"|"approve","reason"}` on stdout — identical contract. Flow ports directly: read stdin (`input.last_assistant_message ?? input.last_agent_message ?? ""` — read defensively, field name unverified; the §8 prompt re-derives edits from git so the name is non-load-bearing), gate on `getConfig().stopReviewGate`, build prompt from `prompts/stop-review-gate.md`, spawn `cc-companion.mjs task --json` (15-min timeout), parse with §8 robust-scan fail-closed, `emitDecision`. Recursive-gate guard via `CC_STOP_GATE_ACTIVE=1`.

## Build order (full mirror, one pass)

0. **Repo** — `mkdir ~/dev/cc-plugin-codex && git init`; `gh repo create Cybercommanders/cc-plugin-codex --private --source ~/dev/cc-plugin-codex --remote origin`; copy LICENSE + NOTICE (attribution to the source plugin).
1. **Scaffold** — `marketplace.json`, `plugin.json`, copy reuse-as-is libs (state, process, git, args, prompts, fs, workspace) + schema + prompt templates with renames. Port `state.test.mjs`/`process.test.mjs`/`git.test.mjs`. Confirm `node --test` green and the durability core works in the new package.
2. **Transport** — write `lib/claude.mjs` + `fake-claude-fixture.mjs`; unit-test review/task/availability against the fake.
3. **Orchestrator** — `cc-companion.mjs` (adapt dispatch; rewrite `executeReviewRun`/`executeTaskRun`; cancel via pid). Adapt `tracked-jobs.mjs`, `job-control.mjs`, `render.mjs`. Rewrite `runtime.test.mjs`.
4. **Commands + agent** — port all 7 `commands/*.md` + `cc-rescue.md` (namespace/strings/install step). Verify Codex honors `disable-model-invocation` + `allowed-tools` (expected yes).
5. **Hooks** — `session-lifecycle-hook.mjs` (broker code removed) + `stop-review-gate-hook.mjs` (§8 parser + recursive guard) + `hooks.json`. Wire `--enable-review-gate` toggle in setup.
6. **Skills + packaging** — `claude-prompting`, `cc-result-handling`; finalize `package.json` (no prebuild/tsc); port CI workflow minus the prebuild step.

## Verification (end-to-end)

- **Unit:** `node --test tests/*.test.mjs` green — esp. ported `state.test.mjs` (durability) and rewritten `runtime.test.mjs` against `fake-claude-fixture.mjs` (each subcommand → correct `claude -p` flags → correct rendered output; cancel kills the tracked pid).
- **Install on Codex:** `codex plugin marketplace add ~/dev/cc-plugin-codex` then `codex plugin add cc@cc-plugin-codex`; confirm `/cc:` commands register and the hook trust prompt appears.
- **Live smoke (real `claude`):** in a scratch git repo with a staged change — `/cc:review` returns a schema-valid verdict; `/cc:adversarial-review "focus on X"` returns findings; `/cc:rescue "make a trivial edit"` (write) edits a file and `touchedFiles` is reported; `/cc:rescue --background ...` + `/cc:status` shows running→completed; `/cc:cancel` kills a long task (verify no orphan `claude` pid); `/cc:result` shows stored output.
- **Stop gate:** `/cc:setup --enable-review-gate`, attempt to end a Codex session after an unreviewed change → BLOCK with bypass hint; a clean ALLOW lets it end; confirm no recursive gate (the gate's own `claude -p` doesn't re-trigger Stop).
- **Durability (dogfood):** force-kill a background task mid-write → `/cc:status` still lists it / no orphan; corrupt `state.json` → recovered from `jobs/*.json` (reuse of hardened `state.mjs`).

## Risks / unknowns

- **Stream-json event schema** (intermediate `assistant`/`tool_use` field names) — verify empirically against one real `claude -p --output-format stream-json` run before finalizing the parser; the terminal `result` envelope is confirmed.
- **Auth detection** costs tokens — gate the probe to `/cc:setup` only.
- **No graceful interrupt** — cancel is SIGTERM to the process group; a mid-edit task may leave a partial file. Documented.
- **Codex agent-invocation surface** for `/cc:rescue`→`cc-rescue` may differ from Claude Code's `Agent` tool; fallback is inline `cc-companion.mjs task` (the subagent is an optimization, not load-bearing). Verify on first install.
- **Double-gate loop** if both plugins' gates are on — mitigated by `CC_STOP_GATE_ACTIVE`.
- **`@anthropic-ai/claude-code` install path / binary name** for `setup.md` guidance — confirm the current published package + that `claude` is on PATH.
