---
id: TASK-30
title: listAudit applies LIMIT before the accessibility filter
status: To Do
assignee: []
created_date: '2026-08-30 06:31'
labels:
  - relay
dependencies: []
priority: medium
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
sqlite-store.js listAudit takes LIMIT in SQL and the accessibility filter is applied afterwards in rest.js, so a caller who is not a member of some channels receives FEWER than limit rows and cannot tell short-page from end-of-data. Push the filter into the query or over-fetch and trim. Found by the wave-1 reviewer while verifying TASK-2.
<!-- SECTION:DESCRIPTION:END -->
