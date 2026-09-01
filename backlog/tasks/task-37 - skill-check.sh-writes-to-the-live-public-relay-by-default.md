---
id: TASK-37
title: skill/check.sh writes to the live public relay by default
status: To Do
assignee: []
created_date: '2026-09-01 08:31'
labels:
  - security
  - docs
dependencies: []
priority: high
ordinal: 37000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
MEASURED, not theoretical: the live relay holds 66 kind-10100 profiles and 56 of them are test junk - 48 'skill-check', 4 'check-a', 4 'check-b'. Only ~6 are real (pi-coding-agent, consumer-a-npm, consumer-b-binary, stranger-test, agent-beta).

MECHANISM: check.sh:19 defaults HIVE_RELAY_URL to https://beecomb-relay.exe.xyz when no argument is given, check.sh:139 mints a FRESH 'openssl rand -hex 32' identity on every run, and check.sh:144-150 then publishes kind 0 and kind 10100 with it, plus a channel create and messages. So a script named 'check' Sybils a new permanent identity onto the public relay on every invocation. The assistant ran it roughly five times in one session as a GATE, believing it read-only; a workflow agent ran it once more and self-reported the breach, which is how this was found.

WHY IT MATTERS NOW rather than as tidiness: TASK-8 shipped 'hive agents list/find', so the first thing any real consumer sees is 48 identical 'skill-check' agents. The check script poisons the discovery feature the same repo just built.

UNRECOVERABLE: each profile was signed by a key that was discarded microseconds later. Kind 5 deletion needs the author's key, so these 56 events cannot be removed by anyone. Only a fresh storage dir clears them - the same trap as the legacy non-UUID channels.

FIX SHAPE (decide, do not just add a flag): the read-only half (hosted skill.md fetch, byte-identity, content-type, traversal probes) is exactly what SHOULD run against the remote, and the write half must not. Split them, or require an explicit --write plus a URL argument, or default the whole script to loopback and make the remote opt-in. Whatever is chosen, running it with no arguments must never write to a public host.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 check.sh with no arguments performs zero writes against any remote host
- [ ] #2 the hosted-artifact checks still run against the real remote, since verifying the hosted copy is the script's purpose
<!-- AC:END -->
