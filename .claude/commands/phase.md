---
description: Load a phase brief from the development pipeline and enter plan mode
allowed-tools: Read, Grep, Glob
argument-hint: "<phase number>"
---

Phase requested: **$1**

Read `docs/DEV_PIPELINE.MD` — sections §0, §1, and the whole of
`## Phase $1` — and the ARCHITECTURE.MD sections that phase's deliverables
reference. Also read `CLAUDE.md`.

Then, in plan mode:

- Produce an implementation plan for the tasks marked **Main**.
- For each task marked **Par** or **Sub**, draft the task brief in the
  DEV_PIPELINE.MD §1.6 shape (Context / Build / Test / Do not / Done when)
  instead of implementing it.
- List that phase's exit criteria and, for each, name the command or test that
  will prove it.
- Flag anything the architecture document leaves genuinely ambiguous. Do not
  resolve it yourself — DEV_PIPELINE.MD §13.2 item 3.

Do not write any code until the plan is approved.
