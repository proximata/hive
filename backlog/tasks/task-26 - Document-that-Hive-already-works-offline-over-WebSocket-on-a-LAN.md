---
id: TASK-26
title: Document that Hive already works offline over WebSocket on a LAN
status: To Do
assignee: []
created_date: '2026-08-30 05:17'
labels:
  - docs
dependencies: []
priority: medium
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Free finding from the transport review, currently written down nowhere: an offline LAN Hive already works today over plain WebSocket - transports/ws.js carries identical frames and needs no DHT at all. Users assume no-internet means no-Hive. Also correct the Pears framing while here: package.json calls this the Pears stack but Hive is Bare-only in practice - pear-runtime is loaded once as an updater (workers/main.js:159) against a placeholder pear:// key (package.json:16), and corestore and hyperswarm are dependencies with ZERO imports. Say what would actually make it a Pear app: pear stage, pear seed (a machine that must stay up), and a real key at package.json:16.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 README or docs/DEPLOY names the LAN-only path with the exact command; no unqualified 'Pears stack' claim remains
<!-- AC:END -->
