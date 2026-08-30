---
id: TASK-1
title: Cap filters per REQ (both transports)
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - security
  - relay
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
One 64KB frame can carry ~4600 filters; each becomes its own SQL scan, hanging the relay for everyone. TIERS.subscriptions:20 already exists in ratelimit.js:6 and is NEVER READ - the cap is defined, just unwired. Enforce at BOTH entry points: protocol.js:53 (WS REQ) and rest.js:227 (POST /query). Live public server, so this is one frame from a hang.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 REQ with 21 filters returns CLOSED with 'invalid: too many filters'; test asserts both WS and REST paths; npm test 226 green
<!-- AC:END -->
