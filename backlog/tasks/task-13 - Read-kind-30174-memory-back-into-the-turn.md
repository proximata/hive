---
id: TASK-13
title: Read kind 30174 memory back into the turn
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
updated_date: '2026-08-30 00:37'
labels:
  - agents
dependencies:
  - TASK-10
priority: medium
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An agent writes a memo every turn and never remembers anything: _buildHistory (agent.js:372-388) uses only persona.system_prompt plus the current batch and never queries the channel. Adding a relay read makes turn latency depend on relay RTT, so cap the fetch and do not block the turn on failure. While here, note 30174 is plaintext AND search-indexed - reading it back raises the value of encrypting it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Extend the delegation demo: a memo written in turn 1 is quoted in turn 2's prompt; assertion count rises and all pass
<!-- AC:END -->
