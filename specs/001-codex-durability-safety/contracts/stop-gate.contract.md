# Contract — Stop-Gate (`stop-review-gate-hook.mjs`)

Covers FR6. Verified by M5.

## `parseStopReviewOutput(rawOutput) → { ok, reason?, warn? }`
First line of trimmed `rawOutput` decides:
- `""` (empty) → `{ ok:false, reason:<blocked + bypass> }` — did-not-run.
- starts `ALLOW:` → `{ ok:true }`.
- starts `BLOCK:` → `{ ok:false, reason:"…<reason>… <bypass>" }`.
- **non-empty, neither prefix (odd-but-present)** → `{ ok:true, warn:<text> }` (R6).

## `runStopReview(cwd, input) → { ok, reason?, warn? }`
These four MUST stay blocking (`ok:false`) — they are genuine failures, not "ran but
odd" (R6):
- `result.error.code === "ETIMEDOUT"` (15-min timeout).
- `result.status !== 0` (non-zero exit).
- `JSON.parse(result.stdout)` throws (invalid JSON).
- (and empty `rawOutput`, via `parseStopReviewOutput`).

## Block-reason invariant
Every `{ ok:false }` reason string ends with a runnable bypass, e.g.:
`Bypass: run /codex:setup to disable the stop-review gate, or /codex:review --wait to
review now.`

## Decision emission (`main`)
- gate off → log running-task note, no block.
- setup missing → log + return, no block.
- `review.ok` false → `emitDecision({decision:"block", reason})`.
- `review.warn` present → log warn to stderr, do not block.

## Guarantee
A review that **ran** (exit 0, valid JSON, non-empty output) never traps the session,
even with an odd preamble; a review that **failed to run** always blocks with a
discoverable escape.
