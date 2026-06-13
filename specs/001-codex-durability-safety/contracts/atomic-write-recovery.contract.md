# Contract — Atomic Write & Recovery (`lib/state.mjs`)

Covers FR3, FR4. Verified by M2, M3.

## `atomicWriteFileSync(target, data) → void`
- Opens `<dir>/.<basename>.tmp-<pid>-<rand>` with `O_EXCL` (`"wx"`) (R9).
- `fs.writeFileSync(fd, data)` → `fs.fsyncSync(fd)` → `closeSync`.
- `renameOver(tmp, target)` (atomic on POSIX; `unlink`+`rename` fallback on Windows).
- `fsyncDir(dirname(target))` — best-effort; ignore platforms that can't fsync a dir
  (R3).
- **Post / Guarantee:** a crash at any point leaves the previous `target` parseable; a
  successful return means the new contents are durable past power loss (where the fs
  honors fsync).
- Applied to `state.json` (`:114`), job json (`:169`), broker session
  (`broker-lifecycle.mjs:92`).

## `loadState(cwd, { locked = false }) → State`
- File absent → `defaultState()`.
- Read error → `defaultState()`.
- Parse OK → `normalize(parsed)` (today's default-merge; jobs coerced to array).
- **Parse error + `locked:true`:** rename to `state.json.corrupt-<ts>`; warn (naming
  the backup + orphan risk, R10); return `defaultState()`.
- **Parse error + `locked:false`:** return `defaultState()`, **no rename**, no throw
  (R5).
- **Guarantee:** corrupt bytes are never destroyed; only a locked caller quarantines.

## `renameOver(tmp, target) → void`
- POSIX: `fs.renameSync`.
- Windows / `EEXIST`/`EPERM`: `unlinkSync(target)` then `renameSync` (small non-atomic
  window, accepted — NFR3).

## `fsyncDir(dir) → void`
- `openSync(dir,"r")` → `fsyncSync` → `closeSync`; swallow errors (Windows / network
  fs can't always fsync a directory — best-effort, NFR6/R11).
