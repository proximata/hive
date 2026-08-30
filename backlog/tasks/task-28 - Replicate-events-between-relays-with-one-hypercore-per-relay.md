---
id: TASK-28
title: Replicate events between relays with one hypercore per relay
status: To Do
assignee: []
created_date: '2026-08-30 05:35'
updated_date: '2026-08-30 05:50'
labels:
  - relay
  - transport
dependencies: []
priority: high
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
DECIDED: multi-feed replication, NOT autobase. Each relay owns exactly one hypercore of the events it accepted; every relay replicates every other relay's core and merges on ingest. Autobase was spiked and rejected - it runs fine on Bare (7.28.1, 3 bases on one bootstrap key, addWriter via apply, all verified) but its headline feature is linearization, and Hive has no ordering problem to solve. Event ids are sha256 of the serialized event (hive-core/lib/event.js:44) and replaceable conflicts resolve by created_at with an id tiebreak rather than arrival order (sqlite-store.js:131-140), so the event set is already a commutative CRDT: any merge order converges. Autobase would have added an authorised writer set and a quorum on top of data that needs neither, and its addWriter model actively collides with Hive's open write surface.

WHAT THIS BUYS BY BEING SMALLER: no writer authorisation, no indexers, no quorum, no bootstrap ceremony, and no linearized view to maintain. SQLite stays the store, not a projection - ingest from a peer feed calls the SAME store.addEvent path a WebSocket EVENT does, which is already idempotent by id. FTS5 and every filter query are untouched. No new direct dependency either: corestore ^7.12.0 (package.json:86) and hyperswarm ^4.17.0 (package.json:90) are ALREADY declared with zero imports today, so this finally uses what is shipped.

SHAPE: relay appends each accepted event to its own core; hyperswarm joins a shared topic; on connection, replicate the corestore; a reader tails each peer core and feeds events through the normal validate-then-store path.

RISKS TO DESIGN FOR, not to discover later:
1. Rate limiting is per-pubkey at the EVENT path (relay.js:232). Replication ingest bypasses it, so a peer feed is an unmetered write path into the store - it needs its own cap.
2. Signatures make forgery impossible but say nothing about volume or relevance: a peer can replay the entire history at any time. Ingest must be cheap on re-seeing known ids.
3. Storage is unbounded - every relay ends up holding everything from everyone. Acceptable at 3 nodes, not a plan. Name the trigger for selective replication rather than building it now.
4. Trust is transitive: relay A replicating from B accepts whatever B accepted, including anything B's own limiter let through.
5. The temporary topology is 3 nodes on ONE VM, which shares a failure domain and proves convergence only, never availability.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Two relay processes share one autobase, an event posted to either appears in both, and the SQLite view converges to identical state regardless of arrival order
- [ ] #2 An event posted to relay A appears in relay B's store via replication and not via a client connection
- [ ] #3 Two relays fed the same events in opposite order converge to identical query results
- [ ] #4 Re-replicating a full history inserts no duplicates and does not grow the store
<!-- AC:END -->
