#!/usr/bin/env bash
# Thin wrapper retained for the DEV_PIPELINE.md Phase 0 deliverable contract.
#
# The cross-platform implementation in check-invariants.ts is the source of
# truth: this repository is developed on Windows, where a `grep -rE` pipeline is
# not available. npm scripts and Claude Code hooks invoke the TypeScript entry
# directly; this file exists so `./scripts/check-invariants.sh` also works from
# a POSIX shell. Arguments are forwarded unchanged.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec npx --no-install tsx "${repo_root}/scripts/check-invariants.ts" "$@"
