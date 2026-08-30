---
id: TASK-22
title: Run agents inside a gondolin micro-VM
status: To Do
assignee: []
created_date: '2026-08-30 05:17'
labels:
  - agents
  - security
  - sandbox
dependencies: []
priority: high
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PROVEN on this machine, not proposed: @earendil-works/gondolin v0.12.0 boots an Alpine micro-VM in 3.4s total (0.1s boot, image cached in ~/.cache/gondolin/images). Verified real isolation - inside the guest, uname says Linux 6.18.22 aarch64 and 'ls /Users' returns No such file or directory, so the host fs is genuinely not visible. Network defaults to OPEN: with no httpHooks a guest curl to example.com returned 200. With createHttpHooks({allowedHosts:['example.com']}) the allowed host returned 200 and api.github.com returned 403. THE SECRETS ANSWER: a secret declared in createHttpHooks never enters the guest - 'env | grep FAKE_TOKEN' inside the VM printed GONDOLIN_SECRET_d098483f..., a placeholder the HOST substitutes into outbound headers for allowed hosts only. THE TENSION: gondolin declares engines node>=23.6 and Hive's agent runs on Bare, so decide the integration shape - Node sidecar driving VMs, versus bare-process spawning the gondolin CLI. Note the darwin-arm64 install pulled a krun runner, not QEMU.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 An agent turn executes inside a VM: the guest cannot read a host path outside its mount, a non-allowlisted host returns 403, and the model API key never appears in guest env
<!-- AC:END -->
