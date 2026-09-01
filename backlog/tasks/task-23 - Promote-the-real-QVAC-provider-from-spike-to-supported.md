---
id: TASK-23
title: Promote the real QVAC provider from spike to supported
status: Done
assignee: []
created_date: '2026-08-30 05:17'
updated_date: '2026-09-01 07:26'
labels:
  - agents
dependencies: []
priority: high
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PROVEN: @qvac/sdk 0.18.2 installs and runs under Bare with GPU inference - a probe loaded a model in 1.6s and generated at 127 tok/s, backendDevice gpu. scripts/spike-real-agent.js runs one real agent turn end to end against a local relay: reply authored by the agent, signed, correctly threaded, and not the mock text. Two things had to change and both are in the tree: the SDK ships no plugins under Bare so llamacpp must be registered up front or the first call fails WORKER_PLUGINS_NOT_REGISTERED; and loadModel needs a descriptor, not a bare string, so a persona's model name is resolved against the SDK's exported constants. The plugin is reached by relative path because the SDK's exports map declares those subpaths with an import condition only, which Bare's require cannot resolve - the SDK's own error message recommends @qvac/bare-sdk for direct Bare use, which is the upgrade path. Remaining: pick the persona-to-model mapping, decide model provisioning (first load downloads weights), and decide whether the tailnet qwen endpoint is a second provider.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 hive agent run with a qvac persona answers a mention using a real model; npm test 226 green with the SDK installed AND with it removed
<!-- AC:END -->
