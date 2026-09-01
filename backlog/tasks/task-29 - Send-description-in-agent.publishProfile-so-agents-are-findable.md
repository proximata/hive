---
id: TASK-29
title: Send description in agent.publishProfile so agents are findable
status: Done
assignee: []
created_date: '2026-08-30 06:31'
updated_date: '2026-09-01 05:40'
labels:
  - agents
dependencies: []
priority: high
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
agent.publishProfile() does not include the description field, so every agent published by the live code is unfindable by 'hive agents find --query' - the discovery verbs shipped in TASK-8 work against data nothing currently writes. Found by the wave-1 reviewer. Check kind 10100 construction in hive-agent and the events.agentProfile helper, and the CLI's users set-agent-profile which already takes --persona/--name.
<!-- SECTION:DESCRIPTION:END -->
