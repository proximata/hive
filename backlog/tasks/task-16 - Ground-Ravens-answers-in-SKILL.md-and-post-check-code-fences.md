---
id: TASK-16
title: Ground Raven's answers in SKILL.md and post-check code fences
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
updated_date: '2026-08-30 00:37'
labels:
  - agents
  - raven
dependencies:
  - TASK-15
priority: medium
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An agent that invents CLI verbs teaches users commands that do not exist. Stuff skill/SKILL.md (15.2KB, ~4k tokens) verbatim as the system prompt and re-read it at startup, so there is no copy and no drift. SPEC.md (38.8KB) is grep-on-miss only. Post-check every code fence in the reply against the verb table in commands.js and drop unknown verbs. Note providers return toolCalls:[] (provider.js:104), so there is no tool loop to hang a read-on-demand skill loader on.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A reply containing 'hive frobnicate' has that fence removed before posting; test asserts it
<!-- AC:END -->
