---
id: TASK-31
title: auth_required derives from mutable policy fields
status: To Do
assignee: []
created_date: '2026-08-30 06:31'
labels:
  - relay
dependencies: []
priority: low
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-6 made NIP-11 auth_required derive from policy.requireAllowlist || policy.requireRelayMembership. Both are plain mutable fields and the test flips relay.policy.requireRelayMembership at runtime, so anything that mutates policy silently changes what the relay advertises publicly. It works; it is a contract resting on a public mutable field. Either freeze the policy object after construction or compute NIP-11 once at startup.
<!-- SECTION:DESCRIPTION:END -->
