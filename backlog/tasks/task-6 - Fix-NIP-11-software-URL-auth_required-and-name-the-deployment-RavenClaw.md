---
id: TASK-6
title: 'Fix NIP-11: software URL, auth_required, and name the deployment RavenClaw'
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - docs
  - relay
dependencies: []
priority: medium
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
relay.js:569 serves software=github.com/hive/hive, a repo that does not exist, publicly. It also advertises auth_required:true while writes are open - the open surface is an ACCEPTED tradeoff, so the doc is the bug, not the write path. Set auth_required:false. Bundle the deployment rename to RavenClaw here (NIP-11 name field only). Do NOT rename the protocol term: ~1150 of 1215 'relay' hits are NIP-01 vocabulary, and HIVE_RELAY_URL is baked into the published npm package and the hosted skill.md.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 curl -H 'Accept: application/nostr+json' shows the real repo URL, auth_required:false, name RavenClaw; skill/check.sh 22 green; test/relay.js updated
<!-- AC:END -->
