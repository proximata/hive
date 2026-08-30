---
id: TASK-11
title: 'hive agent run: an agent process an operator can start'
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
updated_date: '2026-08-30 00:37'
labels:
  - agents
  - cli
dependencies:
  - TASK-10
priority: high
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Configuring an agent today means editing scripts/demo-delegation.js - 'new Agent(' appears only under scripts/ and test/, and bin.mjs has no agent path. Reuse the wiring in scripts/demo-delegation.js:320 rather than forking a second one. Hamlet's shape is worth copying: one systemd unit per role with an EnvironmentFile (deploy/digitalocean/pear-agent@.service, Restart=always). providerFromPersona (qvac.js:159) already resolves runtime from the persona, so the CLI takes a pubkey and key, not a provider flag.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 hive agent run --persona <naddr> & then a mention from another key gets a kind-9 reply; kill exits clean; all three gates green
<!-- AC:END -->
