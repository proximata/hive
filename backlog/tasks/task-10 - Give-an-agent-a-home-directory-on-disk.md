---
id: TASK-10
title: Give an agent a home directory on disk
status: Done
assignee: []
created_date: '2026-08-30 00:37'
updated_date: '2026-09-01 07:26'
labels:
  - agents
dependencies: []
priority: high
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
THE structural gap versus Hamlet, and the prerequisite for cron, memory, skills and secrets. rg 'fs\.' packages/hive-agent returns 0 hits - a Hive agent has no disk at all. Hamlet's layout (pear-0 persistence.js:56): ~/.pear-0/agents/<role>/{keypair,metadata,files,skills}, with files/instruction.md loaded as the system prompt (responder.js:28) and skills/*/SKILL.md as learned behaviour. Copy the directory, ignore the 70KB spec around it. Keep fs behind an injected adapter so the package still loads under Bare and in the browser. Persona kind 30175 stays authoritative; the file is an override, or there are two sources of truth. NOTE: no fs sandbox exists - bare-fs is unrestricted - so document this as a convention, not a jail, and never host third-party agents on it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 demo-delegation still 26/26, plus a new assert that editing <home>/files/instruction.md changes the next turn's system prompt
<!-- AC:END -->
