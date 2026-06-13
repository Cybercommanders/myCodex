# Proposal Pack — Codex Plugin Durability & Safety

**Status:** Draft for review
**Owner:** (fork: Cybercommanders/codex-plugin-cc)
**Source:** Code review of `plugins/codex/scripts/**` plus first-hand findings from a `/codex:init` + background `/codex:adversarial-review` session.
**Base commit:** `807e03a`

---

## What this pack is

A review-ready set of documents covering seven proposed improvements to the Codex
plugin, discovered by reviewing the runtime against how it actually behaved in a
live session. The headline is a single coherent **durability gap**: the plugin's
background-job feature depends on a `state.json` that is neither concurrency-safe
nor crash-safe.

## How to read it (in order)

| # | Document | Purpose | Audience |
|---|----------|---------|----------|
| 1 | [`PRD.md`](./PRD.md) | Problem, goals, scoped requirements, success metrics, traceability | Product + eng review |
| 2 | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Target technical design: lock protocol, atomic writes, recovery, process safety, gate UX | Eng review |
| 3 | [`PLAN.md`](./PLAN.md) | Phased TDD implementation plan, sequencing, test plan, acceptance criteria | Implementer |

## Findings at a glance

| ID | Sev | Title | File evidence | Workstream |
|----|-----|-------|---------------|------------|
| F1 | HIGH | `state.json` read-modify-write has no cross-process lock → lost job updates | `lib/state.mjs:92-122`, `session-lifecycle-hook.mjs:70` | A — Durability Core |
| F2 | HIGH | Non-atomic write + silent full reset on corrupt state → untracked orphan processes | `lib/state.mjs:64-78,114` | A — Durability Core |
| F3 | MED | `/codex:init` cleanup matches full command line → killed an unrelated root daemon | `~/.claude/skills/codex/init.md:114-142` | B — Process Safety |
| F4 | MED | Stop-gate blocks ≤15 min synchronously, fails closed on odd output, hides bypass | `stop-review-gate-hook.mjs:91-140,166` | C — Gate UX |
| F5 | LOW | `terminateProcessTree` throws on `EPERM` instead of reporting undelivered | `lib/process.mjs:100-118` | B — Process Safety |
| F6 | LOW | Tests miss corrupt-state recovery, atomic write, and concurrent upsert | `tests/state.test.mjs` | A/D — Quality |
| F7 | LOW | `init.md` promises `max` effort, but uses an invalid token and never passes `--effort`; companion supports `--effort none…xhigh` | `codex-companion.mjs:69,734,766-784`, `~/.claude/skills/codex/init.md:21-24,195-204` | D — Quality |

## Provenance — what the live session proved

- We launched a **real background writer** (`/codex:adversarial-review --background`) while the
  interactive session kept running — the exact precondition for F1's lost-update race.
- The `/codex:init` cleanup step **issued `kill -TERM` to `earlyoom`** (a root OOM-killer) because
  its `--avoid` regex literally contains the substring `codex`. The kill failed only on
  permissions. This is F3, observed, not theorized.
- We **enabled the stop-review gate** this session, so F4's blocking / fail-closed UX is on the
  active path.
- The adversarial reviewer itself worked well and caught a machine-path leak in generated
  artifacts — evidence the review tooling is sound; the gaps are in state durability and process
  safety, not the review logic.

## Out of scope for this pack

- Rewriting the app-server broker protocol or transport.
- Changing the Codex review prompt content / verdict schema.
- Any change to how Claude Code dispatches hooks (harness-owned).
