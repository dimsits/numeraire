---
description: Run the full verification gate and summarize failures grouped by cause
allowed-tools: Bash(npm run verify), Bash(npm run verify:*), Bash(npm run typecheck), Bash(npm run lint), Bash(npm run format:check), Bash(npm run test:*), Bash(npm run boundaries), Bash(npm run coverage:*), Read, Grep, Glob
argument-hint: "[full]"
---

Run the verification gate for this repository.

- With no argument, run `npm run verify`
  (typecheck → lint → format:check → unit tests → boundaries).
- With the argument `full`, run `npm run verify:full`
  (the above, then integration tests → API tests → coverage gate).

Argument given: `$ARGUMENTS`

Then report:

1. **Pass or fail**, and the exact exit status.
2. If it failed, group the failures **by cause**, not by file. A single missing
   import that produces forty type errors is one cause. Name the cause, then
   list the files it touches.
3. For each cause, say which gate caught it (tsc / eslint / prettier / vitest /
   dependency-cruiser / check-invariants) and what the minimal fix is.
4. Call out separately any failure that is an **invariant violation**
   (`INVARIANT VIOLATION` output, or a dependency-cruiser `domain-*` rule).
   Those are never fixed by relaxing the rule — see CLAUDE.md.

Do not fix anything unless asked. Report first.
