---
description: Verify each exit criterion of a phase individually, citing its proof
allowed-tools: Bash(npm run:*), Bash(docker compose:*), Bash(docker build:*), Bash(git status), Bash(git status --short), Read, Grep, Glob
argument-hint: "<phase number>"
---

Phase to audit: **$1**

Run `npm run verify:full`. Then read the **Exit criteria** list for
`## Phase $1` in `docs/DEV_PIPELINE.MD` and verify each criterion
**individually**.

Report one line per criterion:

```
<criterion> — PASS | FAIL | NOT PROVEN — <the command or test file that proves it>
```

Rules for this audit, and they matter more than the checklist itself:

- Cite the **specific** command output or test file that proves each line.
  "`npm run verify` passed" does not prove a criterion about Docker.
- If a criterion has **no test or command proving it**, say **NOT PROVEN**.
  Do not infer a pass from adjacent evidence. A session asked to confirm a
  checklist will tend to confirm it; that is the failure mode this command
  exists to prevent (DEV_PIPELINE.MD §13.3).
- If a criterion cannot be exercised in this environment (no Docker daemon, no
  remote CI run), say so explicitly and mark it NOT PROVEN.
- Run the audit on a clean checkout: report `git status --short` output, and
  say whether uncommitted changes could be affecting the result.

Finish with a single line: whether Phase $1 is complete, and if not, exactly
what remains.
