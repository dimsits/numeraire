# Numeraire

## Non-negotiable invariants
- Money is `bigint` minor units. No `number`, `float`, `parseFloat`, or
  `toFixed` anywhere in a money code path. Serialize to JSON as a string.
- `src/domain/**` imports nothing from `src/db`, `src/modules`, `src/ai`,
  `src/jobs`, or any package with I/O. Enforced by dependency-cruiser.
- Every repository method that reads or writes a tenant row takes `userId`
  and includes it in the WHERE clause. There is no `findById(id)`.
- Split lines must sum to the parent transaction amount. Never bypass
  `assertSplitsBalance`. Never write splits outside a Unit of Work.
- Files under `drizzle/*.sql` are immutable once committed. To change the
  schema, generate a new migration. Never edit an applied one.
- Jobs carry IDs, never entities. Handlers re-read current state.
- Enqueue only via `uow.afterCommit()`. Never inside an open transaction.

## Definition of Done (every PR)
1. `npm run verify` passes (typecheck, lint, format, unit tests, boundaries)
2. New code has tests. Domain code has table-driven or property tests.
3. No new `any`, no `@ts-expect-error` without a comment naming the reason.
4. If a route changed, the OpenAPI snapshot is regenerated intentionally.
5. If a decision deviates from docs/ARCHITECTURE.MD, stop and ask. Do not
   resolve architectural ambiguity unilaterally — propose an ADR instead.

## Conventions
- Zod schema per boundary object, colocated in `*.schemas.ts`.
- Errors are `AppError` subclasses. Never throw strings or bare `Error`.
- Time comes from the injected `Clock`, never `new Date()` in domain or services.
- IDs come from `lib/ids.ts` (UUIDv7), never `crypto.randomUUID()` inline.
- Log via the request-scoped child logger. Never `console.*`.
- Imports use the `@/*` alias for `src/*`, with explicit `.js` extensions.

## Workflow
- Use plan mode for any task spanning more than three files.
- Run `npm run verify` before proposing a commit, not after being asked.
- Reference docs/ARCHITECTURE.MD by section number rather than restating it.

## Commands
`npm run verify` · `verify:full` · `dev:api` · `dev:worker` · `build` ·
`test:unit` · `test:integration` · `test:api` · `boundaries` · `db:migrate`

## Current phase
Phase 0 complete: harness only. `src/domain`, `src/db`, `src/modules`,
`src/ai`, `src/jobs`, `src/parsers`, and `src/plugins` do not exist yet — the
tooling is configured to expect them and to skip cleanly until they arrive.
`tests/integration/` is empty, which is why `test:integration` alone carries
`--passWithNoTests`; remove that flag with the first Phase 2 test.
