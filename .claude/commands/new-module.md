---
description: Scaffold a vertical slice against the canonical accounts module pattern
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(npm run verify), Bash(npm run typecheck), Bash(npm run test:*), Bash(npm run lint)
argument-hint: "<module name, singular or plural noun>"
---

Module to scaffold: **$1**

Read the canonical pattern first — `src/modules/accounts/` — and follow it
exactly. If `src/modules/accounts/` does not exist yet, stop: the reference
module is written by hand in Phase 4 and everything else copies it. Say so
rather than inventing a pattern.

Create, under `src/modules/$1/`:

- `$1.schemas.ts` — one Zod schema per boundary object (params, query, body,
  response). These feed both runtime validation and the OpenAPI document, so
  they are the single source of truth for the shape (ARCHITECTURE.MD §P7).
- `$1.service.ts` — use-case orchestration. Owns the transaction boundary and
  the authorization check. Takes repositories and a `Clock` by injection;
  constructs nothing itself.
- `$1.routes.ts` — Fastify plugin. Route registration and schema wiring only;
  no business logic.
- `$1.test.ts` — behaviour tests against the service, not the implementation.

Rules for the generated code:

- Every repository call passes `userId`. There is no unscoped read (ADR-009).
- Money stays `bigint` minor units; serialize as a string at the edge.
- Errors are `AppError` subclasses from `src/domain/errors.ts`.
- Time comes from the injected `Clock`; IDs from `@/lib/ids.js`.
- No `any`, no `@ts-expect-error` without a reason.

Then register the route plugin where the other modules are registered, and run
`npm run verify`. Report what you created and anything the accounts pattern
does that did not transfer cleanly.
