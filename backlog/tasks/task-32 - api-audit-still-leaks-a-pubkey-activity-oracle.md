---
id: TASK-32
title: api/audit still leaks a pubkey-activity oracle
status: To Do
assignee: []
created_date: '2026-08-30 06:31'
labels:
  - relay
  - security
dependencies: []
priority: medium
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
TASK-2 gated audit rows by channel accessibility, but rows with channel_id null (AuthSuccess, AuthFailure) still return their actor to ANY authenticated key, so any key can enumerate which pubkeys are authenticating and when. The wave-1 harden agent flagged it and did not fix it. Decide: drop actor for channel-less rows, or make those rows operator-only like verifyAuditChain now is.
<!-- SECTION:DESCRIPTION:END -->
