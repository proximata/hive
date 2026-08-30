---
id: TASK-21
title: 'Decision record: multi-node storage'
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - docs
dependencies: []
priority: low
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operators who need more than one node have no supported path, and the code that did it has been closed. Frame the record around MULTI-NODE, not around Postgres: SQLite already covers single-node, so the acceptance test that matters is two relay processes sharing one database without corruption - which the closed PR never had. pglite was rejected: embedded and single-writer so it cannot serve multiple nodes, 25MB of WASM, and it targets Node or the browser but not Bare. Record the archive branch names or the work is genuinely lost: archive/pr-18 (Postgres), archive/pr-16 (coding agent), archive/pr-14 (compression).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs/design/multi-node-storage.md exists, names the trigger condition and all three archive branches
<!-- AC:END -->
