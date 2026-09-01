---
id: TASK-17
title: Wire verifyAttestation on the read side
status: Done
assignee: []
created_date: '2026-08-30 00:37'
updated_date: '2026-09-01 05:40'
labels:
  - agents
  - security
dependencies: []
priority: medium
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
[agent - alice] is rendered from a self-signed claim: kind 10100 owner is whatever the agent typed (commands.js:317), and hive-core/lib/attestation.js is correct, tested code with ZERO non-test callers. Verify before DISPLAYING ownership. Do not put it in the policy path and do not reject at ingest - a signature proves authorship, not authorisation, and fail-closed ingest would make unattested demo agents vanish. Becomes urgent the moment agent discovery ships, not before.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CLI and web show unverified ownership distinctly; a forged owner field produces no attributed label; test added
<!-- AC:END -->
