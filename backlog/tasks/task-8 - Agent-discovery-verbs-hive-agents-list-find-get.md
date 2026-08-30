---
id: TASK-8
title: 'Agent discovery verbs: hive agents list/find/get'
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - agents
  - cli
dependencies: []
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Agents are invisible from the CLI: store.getUser (sqlite-store.js:540-556) returns kind-0 fields only, so 'hive users get' cannot tell a machine from a human, while the web client reads 10100 directly (app.js:406) and shows the badge. This is NOT an index problem - kind 10100 is already full-text indexed (kinds.js:293; UNSEARCHABLE_KINDS omits it). Verbs are ~15 lines in commands.js over client.query({kinds:[10100], search|authors}). Exact tag match on capabilities[] then token-AND search, NOT substring ('ai' matches 'chain'). No embeddings: needs qvac, which is not installed and therefore untestable.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 hive agents find --capability code returns a seeded agent; hive agents get <pubkey> shows its description; tests added; skill/check.sh green
<!-- AC:END -->
