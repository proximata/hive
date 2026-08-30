---
id: TASK-25
title: Thread DHT bootstrap through to SwarmTransport
status: To Do
assignee: []
created_date: '2026-08-30 05:17'
labels:
  - relay
  - transport
dependencies: []
priority: medium
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The offline case that actually happens is a LAN with no uplink, and it is mostly a bootstrap problem: hyperdht hardcodes 3 internet bootstrap hosts (hyperdht/lib/constants.js:17) and there is NO mDNS or LAN discovery anywhere in the stack - grep for mdns/multicast over hyperswarm, hyperdht and dht-rpc returns 0 hits, and hyperswarm-mdns / bare-mdns are E404 on npm. dht-rpc does accept private IPv4 bootstrap addresses, so a LAN node can seed the swarm. The change is ~5 lines: workers/main.js:145 constructs SwarmTransport(relay) with no options, while swarm.js:68 already accepts bootstrap, agent.js:69 already threads it and test/swarm.js:24 already exercises it. Default undefined keeps behaviour byte-identical.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Two relays on a LAN with no internet discover each other via --bootstrap pointing at a private IPv4; npm test green; default path unchanged
<!-- AC:END -->
