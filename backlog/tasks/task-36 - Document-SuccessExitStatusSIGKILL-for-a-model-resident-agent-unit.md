---
id: TASK-36
title: Document SuccessExitStatus=SIGKILL for a model-resident agent unit
status: To Do
assignee: []
created_date: '2026-09-01 07:26'
labels:
  - docs
  - agents
dependencies: []
priority: medium
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
packages/hive-agent/lib/run.js:285-289 self-SIGKILLs when an inference worker is resident, because measured on @qvac/sdk 0.18.2 under Bare with a model loaded, Bare.exit(0) neither exits nor returns - it blocks in runtime teardown waiting for the llamacpp thread. The behaviour is correct, conditional (exit(0) when no model is resident) and logged, but the ONLY place the consequence is written down is a code comment. An operator writing a systemd unit for 'hive agent run' will see exit 137 on every clean stop and read it as a crash, and with Restart=always plus no SuccessExitStatus=SIGKILL the unit flaps in the logs. Add the unit-file shape to docs/DEPLOY.md or the runbook, including SuccessExitStatus=SIGKILL and why. Upgrade path that removes the need entirely: @qvac/bare-sdk, which owns its Bare worker lifecycle.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 docs show a working unit file for an agent with a resident model, and state that exit 137 on stop is expected
<!-- AC:END -->
