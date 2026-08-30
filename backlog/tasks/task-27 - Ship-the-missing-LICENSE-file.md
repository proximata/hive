---
id: TASK-27
title: Ship the missing LICENSE file
status: Done
assignee: []
created_date: '2026-08-30 05:35'
updated_date: '2026-08-30 05:52'
labels:
  - docs
dependencies: []
priority: high
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
package.json:14 declares Apache-2.0 and there is NO LICENSE file in the repo. It is public. Declaring a license you do not ship is the defect; fix that first, then decide whether to keep it. Dependency spread measured across node_modules: 163 Apache-2.0, 68 MIT, 8 ISC, 1 Python-2.0 - all permissive, so MIT is available if wanted. Two things to weigh before switching: Apache-2.0 section 3 grants an explicit patent licence and MIT grants none, which matters more than usual for a protocol and crypto project; and the whole Bare/Holepunch ecosystem this depends on is itself Apache-2.0, so matching it is the low-friction default. Note MIT would NOT unlock the GPL-3.0 Umbral option rejected in the encrypted-files design - GPL is copyleft and infects the combined distributed work whatever the project's own licence says. Relicensing needs sign-off from the human contributors in git log (qwadratic, Ivan Kotelnikov; 'exe.dev user' is a VM identity and dependabot is a bot).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A LICENSE file exists at the repo root and its text matches the license field in package.json
<!-- AC:END -->
