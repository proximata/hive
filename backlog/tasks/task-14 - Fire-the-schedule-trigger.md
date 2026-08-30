---
id: TASK-14
title: Fire the schedule trigger
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
updated_date: '2026-08-30 00:37'
labels:
  - agents
  - workflow
dependencies:
  - TASK-11
priority: medium
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
A scheduled workflow registers successfully and then never runs - silent, which is worse than rejecting it. definition.js:54 already validates the cron string; engine.onEvent (engine.js:74-121) has no cron branch, so the gap is purely ignition. Hamlet has the same bug from the other side: its croner module is written, tested and imported by nothing. Copy the shape including protect:true so ticks cannot overlap. Needs the agent process task first - a cron with no long-lived process is the same silent failure in a new place.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Register a per-second schedule workflow and observe at least two send_message events one second apart
<!-- AC:END -->
