---
id: TASK-33
title: HIVE_AGENT_KEY bypasses the 64-hex validation the keypair file gets
status: To Do
assignee: []
created_date: '2026-09-01 07:22'
labels: []
dependencies: []
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
run.js resolveAgent (packages/hive-agent/lib/run.js:150) reads env.HIVE_AGENT_KEY and hands it straight to core.fromHex. The sibling path, AgentHome.readSecretKey (home.js:97), rejects anything not matching /^[0-9a-f]{64}$/i with a named error. A typo'd or truncated env key therefore produces a silently DIFFERENT agent identity instead of an error - the exact failure --create was written to prevent. Fix: run the same KEY regex on the env value, with an error naming HIVE_AGENT_KEY. Not fixed in review because run.js was dirty with another agent's uncommitted work.
<!-- SECTION:DESCRIPTION:END -->
