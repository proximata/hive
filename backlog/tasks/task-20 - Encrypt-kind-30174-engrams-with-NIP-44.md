---
id: TASK-20
title: Encrypt kind 30174 engrams with NIP-44
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - security
  - agents
dependencies: []
priority: low
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Memory and engrams are stored plaintext on an open read surface, contradicting SPEC 7.4, and commands.js:512 publishes them that way. Blocks Raven capturing feedback from private channels; until it lands, feedback capture must truncate the author to 8 hex and never touch private channels. The cipher is not the hard part - key management for a channel-scoped audience is.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Publish an engram and curl the raw event: content is NIP-44 ciphertext; a round-trip read test passes
<!-- AC:END -->
