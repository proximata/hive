---
id: TASK-18
title: Escape hatch for legacy non-UUID channels
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - cli
dependencies: []
priority: medium
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The live store holds 9b03b1be-room and friends, and NO CLI verb can address, archive or delete them because validate.js:18 requires a UUID on every verb - an operator cannot clean their own data. Cheapest fix is a --raw-id escape hatch on destructive verbs only, not relaxing validation globally. Root cause was the relay never validating channel id shape at ingest (handlers.js:173 takes the h tag verbatim).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 hive channels archive 9b03b1be-room --raw-id succeeds against a store seeded with a legacy id; normal paths still reject non-UUIDs
<!-- AC:END -->
