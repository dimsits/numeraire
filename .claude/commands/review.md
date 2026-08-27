---
description: Review a branch against the invariants and the review checklist
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status), Bash(git merge-base:*), Read, Grep, Glob
argument-hint: "<branch>"
---

Branch under review: **$1**

Review `git diff main...$1` against `CLAUDE.md` and DEV_PIPELINE.MD §1.4.

Run this in a session that did **not** write the branch. Reviewing in the
session that produced the code is close to worthless: it is anchored on its own
reasoning and will confirm it.

Report in this order:

1. **Invariant violations** — float money math, unscoped repository access
   (a repository method without `userId`), enqueue inside an open transaction,
   `src/domain` importing an outer layer, an edit to a `drizzle/*.sql` file
   that already exists in `HEAD`.
2. **Test quality** — are the tests asserting behaviour, or asserting the
   implementation back at itself? Are the edge cases from the task brief
   actually covered?
3. **Boundary leaks dependency-cruiser cannot see** — a domain function taking
   a Drizzle row type as a parameter, a service returning a Fastify object.
4. **Silent failures** — a widened type, a swallowed error, catch-and-log,
   a weakened assertion.
5. **Dead code** left from an abandoned approach.

Cite `file:line` for every finding.

**Do not fix anything. Report only.** A review that is permitted to edit turns
into a session that quietly rewrites the branch and then reports it as clean.
