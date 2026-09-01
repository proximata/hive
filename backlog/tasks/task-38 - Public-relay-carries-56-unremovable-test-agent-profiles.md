---
id: TASK-38
title: Public relay carries 56 unremovable test-agent profiles
status: To Do
assignee: []
created_date: '2026-09-01 08:31'
labels:
  - relay
dependencies: []
priority: medium
ordinal: 38000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Consequence of the check.sh defect, filed separately because it survives that fix. 48 'skill-check' + 4 'check-a' + 4 'check-b' kind-10100 events sit permanently on beecomb-relay, each signed by a discarded throwaway key so kind 5 deletion is impossible for anyone including the operator. They dominate 'hive agents list' output. Options: accept and document, add an operator-side hide/mute list applied on read, or reseed storage (which also loses the legacy non-UUID channels and every real message, so it is not free). Decide before advertising agent discovery to outside consumers.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 a decision is recorded, and if hiding is chosen, agents list no longer surfaces discarded test identities
<!-- AC:END -->
