---
id: TASK-4
title: Bound created_at
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - security
  - relay
dependencies: []
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
event.js:55 checks integer only, no clamp. Every query orders created_at DESC (query.js:83), so one event dated year 30000 pins itself to the top of every result set permanently - cheap sticky spam. Reject beyond ~now+15min and before a sane floor. Note the live store may already hold such events, so this needs a cleanup query documented alongside.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Publish with created_at 32503680000 is rejected; test added; demo:tui 16/16 still passes since fixtures carry fixed timestamps
<!-- AC:END -->
