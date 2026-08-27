/**
 * drizzle-kit configuration — ARCHITECTURE.md §4, ADR-003.
 *
 * Migrations are plain SQL files under `drizzle/`, committed and reviewed.
 * CLAUDE.md: once a `drizzle/*.sql` file is in HEAD it is immutable — schema
 * changes generate a new migration. A PreToolUse hook enforces that.
 *
 * `schema` points at the table definitions that Phase 2 creates
 * (DEV_PIPELINE.md task 2.2). Until they exist, `drizzle-kit generate` has
 * nothing to read; `drizzle-kit migrate`, which npm run db:migrate calls, does
 * not read the schema at all — it applies whatever is in `drizzle/` against
 * DATABASE_URL. In Phase 0 that is a genuinely empty journal, so the command
 * connects, ensures the migrations table, and applies nothing.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
