# `.claude/` — Claude Code contract

Built in Phase 0 (DEV_PIPELINE.MD §1.2, §1.3). `CLAUDE.md` at the repository
root is the standing instruction file; everything here is the enforcement and
tooling around it.

| Path | What it does |
| --- | --- |
| `commands/verify.md` | `/verify [full]` — runs the gate, groups failures by cause |
| `commands/phase.md` | `/phase <n>` — loads the phase brief and enters plan mode |
| `commands/review.md` | `/review <branch>` — the §1.4 checklist, report-only |
| `commands/new-module.md` | `/new-module <name>` — scaffolds a vertical slice |
| `commands/exit-audit.md` | `/exit-audit <n>` — verifies each exit criterion individually |
| `agents/invariant-auditor.md` | Read-only scan for float money math, unscoped repository access, enqueue-in-transaction, domain import violations |
| `agents/test-writer.md` | Writes a test file from an enumerated case list |
| `agents/fixture-builder.md` | Generates bank CSV, adversarial AI, and seed corpora |
| `agents/sql-reviewer.md` | Reviews aggregate SQL and migrations |
| `settings.json` | The hooks. See below. |

## Hooks

| Event | Script | Effect |
| --- | --- | --- |
| `PreToolUse` on Write/Edit | `scripts/hooks/guard-migrations.mjs` | **Blocks** an edit to a `drizzle/*.sql` file already in `HEAD`. New migrations pass. |
| `PostToolUse` on Write/Edit | `scripts/hooks/typecheck-on-edit.mjs` | Runs `tsc --noEmit` after a TypeScript edit; surfaces errors immediately. |
| `PostToolUse` on Write/Edit | `scripts/hooks/invariants-on-domain-edit.mjs` | Runs the invariant checker after a `src/domain/` edit. |
| `Stop` | `scripts/hooks/stop-dirty-tree.mjs` | Warns when the tree is dirty and the unit suite is red. Warns only; never blocks. |

Each script keeps its decision in an exported pure function, unit-tested in
`scripts/hooks/hooks.test.ts`. The tests prove the logic; they do **not** prove
the hook is wired up. That is proven by firing it.

## Non-interactive sessions do not load these settings by default

Verified against Claude Code 2.1.87: `claude -p` ignores project settings —
and therefore every hook here — unless you pass `--setting-sources`:

```bash
# Hooks DO NOT fire — the migration guard is not loaded:
claude -p "..." --permission-mode acceptEdits

# Hooks fire:
claude -p "..." --permission-mode acceptEdits --setting-sources project
```

Interactive sessions load project settings normally. This matters for any
scripted or CI use of Claude Code against this repository: without the flag you
have no guardrail, and nothing tells you so.

## Verifying a hook actually fires

DEV_PIPELINE.MD §1.3: *"A misconfigured hook fails silently, and you will
believe you have a guardrail you do not have."* Two ways to check.

Feed a payload straight to the script — fast, no session, no tokens:

```bash
echo '{"tool_name":"Edit","cwd":"'"$PWD"'","tool_input":{"file_path":"drizzle/0000_initial_schema.sql"}}' \
  | node scripts/hooks/guard-migrations.mjs; echo "exit=$?"   # expect 2
```

Or fire it end-to-end through a real session, which is the only thing that
proves the wiring as well as the logic:

```bash
claude -p "Use the Edit tool to change X to Y in drizzle/<a committed migration>." \
  --permission-mode acceptEdits --allowedTools Edit,Read --setting-sources project
```

Expect the model to report the edit was blocked, and the file to be byte-identical
afterwards. Check the file, not just the transcript.
