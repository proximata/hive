---
id: TASK-24
title: Encrypted files with per-recipient key wrapping
status: To Do
assignee: []
created_date: '2026-08-30 05:17'
labels:
  - security
  - agents
dependencies: []
priority: medium
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Design is docs/design/encrypted-sharing.md. v1: one random content key per file, file encrypted once, the key NIP-44-wrapped per recipient - O(N) tiny wraps, one copy of the ciphertext, no exotic crypto. Reuse kind 1063 (exists at kinds.js:16 with zero callers) plus one new kind for per-recipient wrapped keys; kind 4 would spam DM inboxes. Group schemes were investigated and rejected for v1 with reasons: a shared group key is just NIP-44 twice and makes removal O(files) re-wraps; Umbral proxy re-encryption is GPL-3.0-only against this repo's Apache-2.0 and needs wasm on Bare; MLS/NIP-EE (ts-mls) is the correct destination for real forward secrecy but needs an always-online delivery service. Triggers to revisit: observed recipient sets above ~200, or a forward-secrecy requirement. MEASURED on Bare: chacha20-poly1305 and aes-256-gcm work, plain chacha20 fails UNKNOWN_CIPHER, secp256k1 ECDH works, so NIP-44 needs exactly one pure-JS dep. PRECONDITION: media reads need no auth (rest.js:146), so the hash IS the access token - encryption must be a client invariant, not a feature. Removal is never retroactive: say 'cannot receive new files', never 'access revoked'.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Encrypt a file, share to two recipients, both decrypt; a third pubkey holding the ciphertext cannot; the raw blob fetched by hash is ciphertext
<!-- AC:END -->
