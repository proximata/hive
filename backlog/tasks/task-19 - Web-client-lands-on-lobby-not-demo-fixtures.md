---
id: TASK-19
title: 'Web client lands on #lobby, not demo fixtures'
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - web
dependencies: []
priority: medium
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
app.js:834 selects channels[0], which is #engineering - alice, bob, honey and a scripted transcript. Every first-time visitor sees fabricated people and believes it is their data. Select by name #lobby with a fallback to first. This is not a fixture-removal task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Loading the client against a store holding both fixtures and lobby selects #lobby; demo:tui 16/16 green
<!-- AC:END -->
