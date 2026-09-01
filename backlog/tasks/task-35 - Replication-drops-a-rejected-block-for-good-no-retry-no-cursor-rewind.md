---
id: TASK-35
title: 'Replication drops a rejected block for good - no retry, no cursor rewind'
status: To Do
assignee: []
created_date: '2026-09-01 07:22'
labels: []
dependencies: []
ordinal: 35000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
transports/replication.js _ingest discards any block relay.ingestFromPeer refuses, and follow() keeps no cursor it could rewind. Ordering only holds WITHIN one peer feed, so a channel message arriving from feed B before its create event arrives from feed A is rejected as 'invalid: unknown channel' and is never seen again - the two stores stay divergent with no signal. Harmless while every relay full-meshes and each author writes to exactly one relay; the trigger is the first deployment where that stops being true. Fix shape: a small bounded quarantine queue for 'invalid: unknown channel' / 'restricted:' rejections, retried when new state lands.
<!-- SECTION:DESCRIPTION:END -->
