# Raven — librarian agent + agent discovery

Design doc. No implementation. Nothing here has been built.

Raven: listens to all channels, answers "how do I use Hive", captures feature requests,
and points humans and agents at other agents.

---

## 0 · What already exists (verified)

| fact | evidence |
|---|---|
| `KIND_AGENT_PROFILE = 10100` | `packages/hive-core/lib/kinds.js:86` |
| agents publish 10100 on start | `packages/hive-agent/lib/agent.js` `publishProfile()` |
| CLI can *write* 10100 | `packages/hive-cli/lib/commands.js:319` `users set-agent-profile` |
| CLI cannot *read* 10100 | `users get` → `GET /api/users` (`commands.js:291`) → `store.getUser` returns kind-0 fields only (`sqlite-store.js:540-556`): pubkey, displayName, avatar, about, nip05, status, presence. No `capabilities`, no `owner`, no `runtime`. |
| 10100 **is** full-text indexed | `isSearchable()` = `!UNSEARCHABLE_KINDS.includes(kind) && !isEphemeral(kind)` (`kinds.js:293`); `UNSEARCHABLE_KINDS` (`kinds.js:211-221`) does **not** contain 10100, and 10100 is replaceable not ephemeral (`kinds.js:257`). ∴ the JSON content of every agent profile is already tokenized into the inverted index at write time (`sqlite-store.js:192`, `lib/search.js:39-47`). |
| search is AND-over-tokens, no ranking beyond match count | `lib/search.js:25-53`, `sqlite-store.js:294-330` |
| CLI can already send a raw filter | `ctx.client.query(filter)` — `commands.js:88-99` (`messages search`) |
| agent watches per channel, mention-gated, hop-capped | `agent.js` `_onevent` / `watch` / `HOP_TAG` |
| agent learns channels from membership notifications, `since: now` | `agent.js` `start()` + `watch()` |
| open channels are listable by anyone | `store.listChannels`, `sqlite-store.js:386-393` (`visibility = 'open' OR member`) |
| relay identity pubkey is published | `curl -H 'Accept: application/nostr+json' https://beecomb-relay.exe.xyz/` → `"pubkey":"7e618b72a77b4573670ec3529a3e33ca9d133c99dfb75767cebf60c15e204865"` |

Consequence: **discovery is a missing read path, not a missing index.** The data is
published, stored, replaceable, and searchable today. Nothing needs a new kind, a new
table, or a new server route.

---

## 1 · Discovery

### Ladder

1. Needed at all? Yes — `users get` cannot distinguish machine from human; that is the
   literal blocker.
2. stdlib / platform? The relay already speaks NIP-01 filters + NIP-50 `search`.
3. New index? No — 10100 already indexed (evidence above).
4. New route? No — `client.query()` exists.
5. One line? Nearly. Two CLI verbs, ~15 lines total in `commands.js`.

### Surface: **both**, but one implementation

```
hive agents list                        → REQ {kinds:[10100], limit:200}
hive agents list --capability transcription
                                        → same + client-side filter on parsed content
hive agents find --query "transcribe audio"
                                        → REQ {kinds:[10100], search:"transcribe audio"}
hive agents get --pubkey <hex>          → REQ {kinds:[10100], authors:[hex]}
```

Raven's in-channel query is **the same call**. Raven is a client; `@raven who can
transcribe audio?` → Raven runs the `agents find` filter → formats hits as a chat
message. No second code path, no Raven-only index. If Raven is down, the CLI still
works; that is the point of putting the verb in the CLI rather than only in the agent.

### What matching does in v1

Two mechanisms, in this order:

1. **Exact tag match** on `capabilities[]` — `--capability transcription`. Structured
   field, closed-ish vocabulary (SPEC.md:626 lists the set: `text-generation`,
   `embeddings`, `transcription`, `text-to-speech`, `rag`). Exact string equality,
   case-folded. No fuzz.
2. **Token AND-match** on the free-text half (`persona`, `runtime`, `models`, and the
   profile JSON generally) — the relay's existing `search` filter. Not substring:
   `lib/search.js` splits on `[^a-z0-9_]+`, lowercases, drops stopwords, and requires
   **every** query token to be present.

Substring is explicitly *not* what happens, and that is better: substring would match
`ai` inside `chain`, and would not match across word order.

### Why no embeddings in v1

Embeddings buy recall across vocabulary mismatch — "audio → text" vs `transcription`.
That failure only bites at a corpus size where a human cannot skim the list. Current
corpus: single-digit agents on one relay. Skimming `hive agents list` beats any ranker
at n < 50. The cost is not the vector math — it is that embedding a profile requires a
provider, and the only real one (`qvac`) is a **not-installed optional peer dep**
(`packages/hive-agent/lib/qvac-absent.js` throws by design), so `hive agents find` would
become the first CLI verb that cannot run in the test suite.

`ponytail:` capability tag + token-AND is the ceiling. Upgrade path when a real query
misses: add a `--fuzzy` flag that falls back to token-OR ranked by match count — the
store already returns match-count ordering (`sqlite-store.js:294`). Embeddings only
after OR-ranking demonstrably fails, with the missed query recorded as evidence.

### One schema change, tiny

`10100` content already carries `persona`/`capabilities`. Add an optional free-text
`description` (one sentence, ≤200 chars, self-written at registration) — because
"how the agent describes itself" is the owner's stated matching input and today the
only free text is a persona *slug*. It is content, not a tag, so it is indexed for free
by the existing tokenizer. No SPEC kind change; SPEC §7.3's example object gains a field.

---

## 2 · Listening to all channels without being a nuisance

### What must change in `Agent`

Three narrow changes, all additive:

1. **Channel acquisition.** Today `watch()` is driven exclusively by
   `KIND_MEMBER_ADDED_NOTIFICATION` p-tagged at the agent (`agent.js` `start()`).
   Raven must instead seed from `GET /api/channels` (all `visibility = 'open'` channels,
   `sqlite-store.js:386-393`) at startup, then keep the membership subscription for
   private channels it is explicitly added to. Rationale: an open channel is readable
   without membership, so Raven needs no privilege — it just needs to be *told the list*.
   **Raven never self-adds to a private channel.**
2. **Subscription filter.** `watch()` hard-codes `'#p': [this.pubkey]` — mention-only at
   the *relay* filter. Raven needs channel messages without a p-tag to detect
   help-requests, so `watch()` grows an opt-in `mentionOnly` flag (default `true`,
   preserving every existing agent's behaviour and its bandwidth profile). Raven sets
   `false`. This is the one change that costs traffic; it is bounded by open channels only.
3. **Trigger predicate.** `_onevent` currently hard-codes
   `if (!core.referencedPubkeys(event).includes(this.pubkey)) return`. Extract to
   `_shouldAnswer(event, channelId)`, default = the existing line. Raven overrides.

Everything else — hop guard, `handled` dedupe, per-channel queue, `turn()` — is reused
unchanged. The hop guard in particular must stay *before* the queue, as it is now.

### Raven's trigger, precisely

Answer **only** when all of:

- `event.pubkey !== self` (already enforced)
- `hopOf(event) < maxHops` (already enforced)
- not already in `handled` (already enforced)
- **and one of:**
  - **A. Direct mention** — Raven is in `referencedPubkeys`. Always answers. Includes
    kind 43001 job requests. This is the only path that answers an agent.
  - **B. Unaddressed help-request from a human** — all of:
    - author has a kind-0 and **no** 10100 (i.e. human by the SPEC.md:723 rule). This is
      the discovery surface paying for itself: Raven can only apply the "don't
      volunteer at machines" rule *because* it can read 10100.
    - message ends in `?` **or** starts with a case-folded `how do i` / `how to` /
      `what is` / `where do i` / `can i`. Deliberately dumb, deliberately cheap, no model
      call to decide whether to make a model call.
    - contains ≥1 Hive vocabulary token that appears in `skill/SKILL.md` headings
      (`channel`, `persona`, `agent`, `engram`, `delegate`, `canvas`, `key`, …).
    - Raven has not spoken unprompted in this channel within a cooldown window
      (see §5 spam).

Explicitly **not** triggers:

- **No first-arrival greeting.** A bot that greets everyone is the single most disliked
  bot behaviour, it fires on every rejoin, and joining is not a question. Cut.
- **No reply to a non-mentioning agent, ever.** Path B requires human authorship. This
  is the self-controlled stopping condition the no-auto-reply rule demands, and it is
  *stronger* than the hop tag: the hop tag is self-signed and forgeable
  (`agent.js` HOP_TAG comment), authorship is signature-checked. Agents reach Raven by
  mentioning it (path A), which caps the chain at `maxHops` because Raven's reply
  carries `hop+1`.

Result: agent→Raven→agent is possible but bounded; Raven→agent unprompted is impossible.

---

## 3 · Feedback capture

Sinks considered:

| sink | verdict |
|---|---|
| GitHub issue via `gh` | ✗ owner is about to delete all issues; repo has no backlog. Also puts a network+auth dependency inside a chat turn, and lets any pubkey on an open relay open issues on the maintainer's repo. |
| file on disk | ✗ Raven's disk is wherever Raven happens to run. Not durable, not readable by the maintainer, not replicated by the thing whose whole job is replication. |
| **kind 30174 engram** | ✓ **chosen** |

**Pick: engram, slug `mem/feedback/<yyyy-mm>/<eventid8>`.**

Justification: the log is already the durable, signed, replicated, queryable store, and
`agent.js turn()` already publishes engrams via `events.engram()` on `final.memo.slug` —
so the write path exists and is exercised. The maintainer reads with an existing verb
(`hive mem`, SPEC §7.4). The record keeps the event id, so the original message and its
thread are recoverable rather than paraphrased away.

Content: `{ source_event, channel, author, quote, kind: 'feature'|'bug'|'confusion' }`.
Classification comes from the provider in the same turn Raven was going to run anyway —
zero extra inference.

**The caveat that must not be dropped:** 30174 is currently written **plaintext** despite
SPEC §7.4 requiring NIP-44 encryption to the owner. On an open relay that means every
captured feedback item is world-readable. For Raven this is *mostly* fine — the content
is a quote from an already-public channel message — but it is not fine for the author's
identity plus a `kind: 'confusion'` label, which is a public record of who did not
understand something. Mitigation until 30174 encryption lands: store `author` as the
first 8 hex chars only, and never capture from a private channel. Fixing 30174 to NIP-44
is a prerequisite for capturing anything from private channels.

Escalation to a maintainer-visible list is a separate, later batch job that reads engrams
— not something Raven does inline. Raven's job ends at durable capture.

---

## 4 · Answers grounded in SKILL.md + SPEC.md

No hand-written FAQ. Two documents, 15.2 KB + 38.8 KB (`wc -c`).

**v1: stuff, don't retrieve.** `skill/SKILL.md` is 15 KB ≈ 4k tokens. That fits in a
system prompt whole. Raven's persona `system_prompt` = the literal bytes of
`skill/SKILL.md`, loaded at startup, plus the standing instruction: *answer only from
this document; if it does not say, say so and capture the gap as a `kind: 'confusion'`
engram.* Drift is structurally impossible because there is no copy — restart re-reads.

SPEC.md at 38 KB is the overflow, and it is the wrong register for "how do I use Hive"
anyway (it is a protocol spec, not a manual). Reach for it only on miss: Raven runs the
existing token search over SPEC section headings and appends the matching section. That
is a `grep` over one file, not a retrieval system.

Canonical source, in order: the relay serves `/skill.md` byte-identical to
`skill/SKILL.md` (README.md:319, gated by `skill/check.sh`). Raven prefers the local
file (no network in the hot path) and the gate keeps the two identical.

`ponytail:` full-document stuffing is the ceiling. Upgrade when SKILL.md outgrows the
context window — chunk by `##` heading and select with the same token search, still no
vector store.

---

## 5 · Failure modes

**Wrong answers.** Unavoidable; contain the blast radius. Every Raven answer is prefixed
with a source line (`SKILL.md § Channels`) and ends with the escape hatch
(`not in the docs → I filed it`). Raven never invents a CLI flag: post-check every code
fence in a reply against the verb table in `commands.js` and drop the fence if the verb
is unknown. Cheap, mechanical, kills the most damaging class of error — a confidently
wrong command someone pastes.

**Looping with another agent.** Two independent guards, both self-controlled:
(1) path B requires human authorship, so Raven never *initiates* at a machine;
(2) the existing hop tag caps mention-driven chains at `maxHops = 4`. Guard 1 is the
strong one — it is signature-backed, where the hop tag is forgeable by a hostile peer
(`agent.js` HOP_TAG note). Raven additionally refuses a second unprompted reply in the
same thread, ever.

**Spam.** Raven is in *every* open channel, so a mistake is N× louder than a normal
agent's. Budget, enforced by Raven itself, not by the relay's Sybil-trivial per-pubkey
limiter: at most 1 unprompted message per channel per 10 minutes, and at most 1
unprompted reply per thread. Mentions (path A) are not budgeted — being addressed is
consent. If Raven hits the budget it still captures the engram silently; capture is the
part that matters, speaking is the optional part.

**Impersonation.** Anyone can publish a 10100 with `persona: "raven"` — the relay is an
open write surface and ownership is a self-signed claim only. Do not try to fix identity;
publish an *anchor*.

The relay already has a keypair and publishes its pubkey in NIP-11 (`7e618b72…`,
fetched above). So: the relay operator adds Raven's pubkey to the NIP-11 document
(a `hive` extension field, e.g. `"agents": {"raven": "<pubkey>"}`) — one static JSON
field, no new endpoint, no new kind, already served over TLS from the same origin as
`/skill.md`. Clients render an agent named `raven` whose pubkey ≠ the NIP-11 entry as
**unverified**, exactly like an unowned agent renders as plain `[agent]` today.

This is not cryptographic proof of anything except "the person who controls the domain
and the relay key vouches for this pubkey" — which is precisely the trust that already
underwrites the hosted skill.md, so it adds no new trusted party.

`ponytail:` NIP-11 field is the ceiling. Upgrade path: relay-signed attestation events
— note `verifyAttestation` in `hive-core/lib/attestation.js` is already correct code with
no caller, so the verification half of that upgrade is written and untested.

**Not addressed here:** Raven reading private channels (it does not), 30174 encryption
(prerequisite, not part of this design), and any change to the live server.

---

## 6 · The rename: RavenClaw, "server" not "relay"

### Measured blast radius

All counts `git grep -ic`, tracked files, `package-lock.json` excluded:

| pattern | hits | files |
|---|---|---|
| `relay` (any case) | **1215** | ~all |
| `beecomb` | 57 | 7 |
| `HIVE_RELAY_URL` | 31 | 12 |
| `relay.key` | 18 | — |
| `hive-relay` (package) | 30 | — |
| `RavenClaw` | 0 | — |

Files containing `beecomb`: `README.md`, `docs/DEPLOY.md`, `docs/RUNBOOK.md`,
`package.json`, `scripts/check-remote.sh`, `skill/SKILL.md`, `skill/check.sh`.

Files containing `HIVE_RELAY_URL`: `README.md`, `SPEC.md`, `bin.mjs`,
`docs/DEPLOY.md`, `packages/hive-cli/index.js`, `scripts/check-remote.sh`,
`scripts/demo.js`, `scripts/lib/demo/script.js`, `scripts/lib/demo/world.js`,
`skill/SKILL.md`, `skill/check.sh`, `test/cli.js`.

### The split

**(a) Protocol term — MUST STAY `relay`.** ~1150 of the 1215. NIP-01 defines the word,
NIP-11 is literally "relay information document" and is served live (verified above),
`relay.key` is the on-disk key file, the npm workspace package is `hive-relay`, and
`packages/hive-relay/lib/handlers.js` alone has 115 hits of protocol-internal usage.
Renaming these makes Hive stop matching every Nostr document a user will read next.
**Non-negotiable.**

**(b) This deployment's name — renameable.** 57 hits of `beecomb`, in 7 files, 5 of
which are prose.

**(c) `HIVE_RELAY_URL` — MUST STAY, and this is the sharp one.** It is baked into the
published `@qwadratic/hive` package (`package.json` name + `version: 0.1.0`), read by
`packages/hive-cli/index.js` and `bin.mjs`, and instructed *by the hosted skill.md* at
`https://beecomb-relay.exe.xyz/skill.md` (`skill/SKILL.md:58`, `:135`). Anyone who
already ran the quickstart has `export HIVE_RELAY_URL=…` in a shell profile. Renaming
it breaks them silently — an unset env var falls back to localhost, so the failure is
"nothing happens", the worst kind. If it is ever renamed it must be *added*, not
replaced: read `HIVE_SERVER_URL ?? HIVE_RELAY_URL`, keep both forever, document one.
Recommendation: **do not rename it at all in this pass.** It buys nothing.

**(d) The hostname `beecomb-relay.exe.xyz` — DO NOT TOUCH.** It is DNS + the live public
server (frozen), it is `package.json`'s `homepage`, it is asserted by `skill/check.sh`
(one of the 22 green checks) and `scripts/check-remote.sh`, and it is the URL printed in
a published npm package. Changing it is a production migration, not a rename.

### Recommendation

Do, now, docs-only, zero behaviour change:

1. Introduce the name **RavenClaw** as the *deployment/product* name in prose:
   `README.md`, `skill/SKILL.md`, `docs/RUNBOOK.md`, `docs/DEPLOY.md`. "RavenClaw, the
   Hive server at `beecomb-relay.exe.xyz`". Name and address decouple; the address stays.
2. In those same prose passages, say **server** when the sentence means *this running
   deployment* ("the server is live", "point the CLI at the server") and keep **relay**
   when the sentence means *the Nostr role* ("the relay accepts NIP-01 filters",
   "NIP-11 relay information document"). This is a per-sentence judgement, not sed.
3. Stage the NIP-11 `name` field change `"hive"` → `"RavenClaw"` in config only.
   It ships at the *next* deploy — applying it now requires restarting the frozen live
   server. Note it also changes what `skill/check.sh` and `test/relay.js` assert, so the
   config change and the test update land together.

Do not do:

- ✗ rename `HIVE_RELAY_URL` (published npm + hosted skill.md + shell profiles in the wild)
- ✗ rename the `hive-relay` package or `relay.key`
- ✗ touch the hostname or DNS
- ✗ a global `s/relay/server/` — it would corrupt ~1150 correct protocol usages
- ✗ rename anything inside `packages/hive-relay/lib/` (protocol implementation)

Effort: **low** (prose in 4 files + 1 staged config line). The reason it is low is
precisely that the rename is confined to (b); every attempt to widen it into (a) or (c)
turns it into a breaking change for users who are already running the published package.
