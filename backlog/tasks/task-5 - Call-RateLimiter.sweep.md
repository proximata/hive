---
id: TASK-5
title: Call RateLimiter.sweep()
status: Done
assignee: []
created_date: '2026-08-30 00:37'
updated_date: '2026-08-30 06:15'
labels:
  - relay
dependencies: []
priority: medium
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ratelimit.js:57 defines sweep() and grep finds no caller anywhere. One Map entry per distinct publishing pubkey is retained for process lifetime; Sybil-cheap keys make it a slow leak. Must be unref()'d or Bare's loop never reaches idle, which matters for mobile suspension later.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Test drives the clock past the window and asserts the bucket map shrinks; interval is unref'd
<!-- AC:END -->
