---
id: TASK-28
title: Replicate events between relays with autobase
status: To Do
assignee: []
created_date: '2026-08-30 05:35'
labels:
  - relay
  - transport
dependencies: []
priority: high
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Owner wants hyper* replication: all peers writing to a single Autobase, bootstrapped from 3 local nodes on the relay VM (owner states this is a temporary topology, not the ideal). PROVEN on Bare already: autobase 7.28.1 (Apache-2.0) installs and runs under Bare - a probe built 3 bases on one bootstrap key, added 2 writers via host.addWriter(key,{indexer:true}) inside apply, and appended to the linearized view. hypercore, hyperbee and corestore are ALREADY in node_modules transitively; only autobase is a new direct dep. THE FINDING THAT MAKES THIS CHEAP: Hive's event set is already a CRDT. Event ids are sha256 of the serialized event (hive-core/lib/event.js:44), and replaceable conflicts resolve by created_at with an id tiebreak, not by arrival order (sqlite-store.js:131-140, 'older, or ties and loses the id tiebreak'). So merging is commutative and the final state does not depend on log order. Consequence: SQLite can stay as the derived VIEW, with apply() doing an idempotent insert by id - no truncate or rollback handling, which is normally the expensive part of an autobase view, and FTS5 plus every existing filter query survives untouched. THE CLASH: autobase writers are explicitly authorised via addWriter, while Hive's relay is an open write surface. Resolve by making RELAYS the writers and keeping users as clients - which is what the 3-nodes-on-a-VM sketch already implies. THE OPEN QUESTION TO ANSWER BEFORE BUILDING: if the set is commutative, autobase's linearization solves an ordering problem Hive does not have, and plain multi-feed replication (each relay one hypercore, all replicating all, merge on read) would converge without any writer management or quorum. Autobase's real value here is the managed writer set and a single bootstrap key to hand out. Decide explicitly which of those two you are buying. Also note 3 indexers on ONE VM share a failure domain, so the quorum in README:178 buys no availability - it exercises the multiwriter path, nothing more.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Two relay processes share one autobase, an event posted to either appears in both, and the SQLite view converges to identical state regardless of arrival order
<!-- AC:END -->
