---
id: TASK-3
title: Validate p tags and cap putUser fan-out
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - security
  - relay
dependencies: []
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
handlers.js:236 loops every p tag doing addMember + audit + a relay-signed notification (a schnorr sign) per target, synchronously. ~900 p tags fit in a 64KB frame. p is also never validated as 64-hex, so garbage strings enter channel_members. Reject over the cap rather than truncating silently.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Event with 900 p tags rejected with a reason; event with p='notahexkey' rejected; test asserts no user rows created; DM and mention paths still pass
<!-- AC:END -->
