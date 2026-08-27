# Migrations

Generated SQL migrations, committed and reviewed line by line (ADR-003).

`meta/_journal.json` currently has **zero entries**. That is the real state of
the repository at Phase 0: no schema exists yet, so there is nothing to apply.
It is an empty ledger, not a placeholder migration — `npm run db:migrate`
connects, ensures the `__drizzle_migrations` bookkeeping table, and applies
nothing. If the command fails, it fails; nothing here suppresses that.

Phase 2 generates `0000_initial_schema.sql` and hand-writes
`0001_invariant_triggers.sql` (DEV_PIPELINE.md tasks 2.3 and 2.4), and
drizzle-kit appends their entries to this journal.

**Files here are immutable once committed.** To change the schema, generate a
new migration; never edit an applied one. The `PreToolUse` hook in
`.claude/settings.json` blocks edits to any `drizzle/*.sql` file present in
HEAD.
