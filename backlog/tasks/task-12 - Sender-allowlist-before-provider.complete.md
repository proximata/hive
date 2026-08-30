---
id: TASK-12
title: Sender allowlist before provider.complete()
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - agents
  - security
dependencies: []
priority: high
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
agent.js:177 subscribes on channel plus p-tag self with NO filter on who may trigger a turn, so any stranger's mention runs the model on the owner's key and budget. Harmless while providers are scripted; it is exactly the defect that closed PR #16 (archive/pr-16), and it stops being harmless the moment a real model is wired. Allowlist belongs in persona kind 30175 (already author-only, kinds.js:207) so it is not world-readable config. Default MUST be permissive or every demo breaks - opt-in deny.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Persona with allow:[alice]: a mention from bob produces no 43002 and no provider call; from alice a normal turn; demo:tui 16/16 unchanged
<!-- AC:END -->
