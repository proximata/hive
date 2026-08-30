---
id: TASK-15
title: 'Raven speaks unprompted: mentionOnly flag plus _shouldAnswer()'
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - agents
  - raven
dependencies: []
priority: medium
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
An agent that only answers @-mentions is invisible to the people who most need help. Three ADDITIVE changes to Agent: seed channels from /api/channels; watch() gains mentionOnly defaulting TRUE so every existing agent behaves identically; extract _shouldAnswer(). The unaddressed-question path must require the author to have a kind 0 and NO kind 10100 - human authorship is the stopping condition, signature-backed and stronger than the forgeable hop tag. RISK: that gate is bypassable by an attacker who simply never publishes a 10100, so the self-budget (1 unprompted per channel per 10min, 1 per thread) is the real blast-radius limit - ship the budget first or ship neither. No greetings. Publish Raven's own 10100 BEFORE enabling this, or two Ravens pass each other's human check and loop.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Agent-authored question stays silent; human question containing a SKILL.md vocabulary token gets a reply; a second within the cooldown stays silent; npm test green with existing agents unchanged
<!-- AC:END -->
