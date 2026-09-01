---
id: TASK-34
title: 'demo-web-seed mints no attestation, so the a2a demo now films ''agent - alice?'''
status: To Do
assignee: []
created_date: '2026-09-01 07:22'
labels: []
dependencies: []
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
cf4c97b made the web client render an unattested owner claim with a trailing '?'. scripts/demo-web-seed.js publishes kind 10100 with no NIP-OA auth tag, so every agent in the recorded demo now shows the downgraded form. scripts/record-a2a-demo.mjs:420 asserts memberText.includes('agent - alice'), which is a SUBSTRING of 'agent - alice?', so the check still passes and cannot see the change - a test passing for the wrong reason. Two halves: seed real attestations in demo-web-seed.js so the demo shows the verified state (this also gives skill/check.sh:174 its missing verified branch), and tighten the recorder assertion to the exact suffix so it can never silently accept a downgrade again.
<!-- SECTION:DESCRIPTION:END -->
