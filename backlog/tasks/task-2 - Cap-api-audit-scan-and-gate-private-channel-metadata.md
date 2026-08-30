---
id: TASK-2
title: Cap /api/audit scan and gate private-channel metadata
status: Done
assignee: []
created_date: '2026-08-30 00:37'
updated_date: '2026-08-30 06:15'
labels:
  - security
  - relay
dependencies: []
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Two defects in one unauthenticated endpoint. sqlite-store.js:697 verifyAuditChain does SELECT * with no LIMIT plus sha256 per row, synchronously, on Bare's single loop. rest.js:325 has no rate limit - the limiter is write-path only (relay.js:232, EVENT only). Separately the endpoint returns rows with channel_id/actor and never passes _canRead, so private-channel membership metadata leaks. Fix: LIMIT+offset, apply limiter to GET, reuse _canRead.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Seeded ~100k-event store: /api/audit responds sub-second; repeated calls rate-limited; private channel the caller cannot read is absent from output; test in test/rest.js
<!-- AC:END -->
