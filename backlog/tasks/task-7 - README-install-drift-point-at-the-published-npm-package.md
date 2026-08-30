---
id: TASK-7
title: 'README install drift: point at the published npm package'
status: To Do
assignee: []
created_date: '2026-08-30 00:37'
labels:
  - docs
dependencies: []
priority: medium
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
README still lists 'npx -y github:proximata/hive' and never mentions @qwadratic/hive@0.1.0, which is published and measurably faster (62s vs 4m17s cold). Diverges from the hosted skill.md, which already says to prefer the package. Prose only. Do NOT touch HIVE_RELAY_URL anywhere - it is in the published package and hosted skill.md:58,135, and unset it silently falls back to localhost.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 rg 'github:proximata/hive' README.md returns nothing; npm install line present; skill/check.sh 22 green
<!-- AC:END -->
