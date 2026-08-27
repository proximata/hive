# Recon: Hamlet framing → Hive demo narrative

Read-only recon. No code written. Sources listed per claim.

## 0. Source access

- `github.com/qwadratic/hamlet` — **PRIVATE**. Firecrawl scrape returned GitHub's
  logged-out chrome only; zero README body (`grep -i sovereign /tmp/hamlet-gh.md` → 0 hits
  outside nav links). Repo name confirmed from `pear-0/.git`: `origin git@github.com:qwadratic/hamlet.git`.
- ∴ worked from the **local tree**, which is the same codebase: `~/Desktop/hobby-dev/pear-0/`
  (README.md, SPEC.md 70K/1602 lines, docs/demo-script.md, notes/plan-hamlet.md) plus
  `~/Desktop/demos/hobby/pear-0-hamlet/source/{SCRIPT,VOICEOVER}.md`.
- Nothing below is invented. Every quote has a file:line origin.

`pear-0` = the repo. `hamlet` = the node-host daemon inside it (`notes/plan-hamlet.md`),
and the name the demo ships under. Same project.

---

## 1. Hamlet's core claims, quoted

**The thesis** — `pear-0/README.md:1`

> Sovereign peer-to-peer A2A protocol on Pear (Bare runtime + Hyperswarm DHT).

**What "sovereign" means there** — it is topology, not adjective. `docs/demo-script.md`:

> there is no platform in the middle. You run the network, you own the identities, you shut it off.

> "No central server, no platform that owns your identity."

> "The registry is forkable. This is the sovereign part, and it is not a slogan, it is the topology."

> "And because I own it, I can turn it off. The droplets are destroyed, billing stops, the network is gone."

**Humans are second-class. On purpose.** `SPEC.md:165` Goal 1:

> Agent-first network. Humans are second-class; they interact with the network only through a
> single agent they own.

`SPEC.md` §9:

> The human **never** emits protocol messages directly onto the wire.

> [Human App] Attaches to exactly one local Agent Node over local IPC … **Not a network peer.**

**What an agent owns** — `demos/…/SCRIPT.md` beat 4:

> imgy is born with its own keypair, home directory, instruction file and skills.

`SPEC.md:167` Goal 2:

> Every actor on the wire is identified by a long-lived keypair. Names are human-readable
> handles bound by a central registry (Raven).

`SPEC.md` §8 Skills:

> Each agent has a `skills/` directory under its Home … Skills are invoked by the agent's own
> decision-making. Humans cannot invoke a skill directly — they ask the agent, which may then
> choose to invoke skills.

**How they discover** — registry lookup + tag distance. `notes/plan-hamlet.md`:

> discovery is name + Hamming-on-tags, so more tags = more findable

`docs/demo-script.md` scene 5:

> "I never needed its address. I asked by capability and the network resolved it."

**How they act on their own** — node-owned cron, `notes/plan-hamlet.md` D-decisions:

> **Cron** = `croner` … node-owned. Cron is owned by the hamlet (a real scheduler), not the
> explorer.

`SCRIPT.md` beats 6–9: `every sixty seconds, find an image generator agent and generate a fresh
image` → `image 001` → `image 002` → *"It simply keeps going, image after image."*

**The closer** — `SCRIPT.md` beat 10:

> Agents that discover, negotiate, and act on their own. That's hamlet.

⚠ One honest correction to Hamlet's own voiceover: **"negotiate" is aspirational.**
`SPEC.md:192` Non-Goals: *"Product-level negotiation (quality, cost, capability selection) …
out of MVP scope at the protocol layer."* And *"Semantic discovery (Hamming on tags only)"*.
Discovery is tag distance; there is no negotiation round-trip.

---

## 2. Precise diff

### Hive does, Hamlet does not

| | Hamlet | Hive |
|---|---|---|
| human on the wire | never — App is `Not a network peer` | human is a keypair, signs every message |
| shared room | human↔agent over local IPC; a2a between mailboxes, off-screen | humans + agents in the **same channel**, same NIP-42, same `h` tag |
| ownership as data | none — agent is sovereign, unattributable to a person | `10100.owner` + NIP-OA `["auth", owner, conditions, sig]` (`SPEC.md` §7.2) |
| one log | per-agent mailboxes + Homes | one hash-chained store, `SPEC.md:509` *"Append-only, tamper-evident, SHA-256 chained"* |
| extend without protocol change | new `a2a.message` kind, but registry + schema in the loop | *"a kind integer is the only dispatch switch"* (`SPEC.md` §1.1) |
| discovery | ask Raven, **a central registry** | filter query on 10100 — *"is a filter query, not an API call"* |
| test without hardware | Gemini key or canned 1×1 PNG | `InferenceProvider` boundary → whole suite, no GPU/model/network |

The sharpest one: **Hamlet's registry is central.** `SPEC.md:167` says it plainly — "bound by a
central registry (Raven)". Hamlet's answer is "it's forkable". Hive has no registry at all;
identity is the key and discovery is a filter.

### Hamlet does better — say it out loud

1. **Autonomy.** `lib/node/cron.js` + croner, node-owned, survives the explorer closing. Hive
   agents are strictly reactive: `agent.js:_onevent` drops everything that is not a mention.
   Hamlet's agent wakes itself up. Hive's cannot. This is Hamlet's whole demo and Hive has no
   equivalent.
2. **The agent has a body.** Home directory, instruction file, `skills/` scanned at startup,
   encrypted replication. Hive has engrams (30174) and a persona blob — no filesystem, no skills.
3. **It is actually deployed.** DigitalOcean, public IPs, verified end-to-end *"laptop behind
   home NAT to DO droplet to Gemini Flash to a real 1024×1024 PNG, 7.9s"*. Hive has **no
   deployment** — `hive.exe.xyz` NXDOMAIN, `deploy/hive.service` still `CHANGE-ME`, loopback only.
4. **Intent → capability resolution**, `lib/raven/classify.js` + `intent.js`. Hive has capability
   strings but nothing resolves freeform intent to an agent.
5. **Payments have a slot.** `payment_receipt` field, wdk-rgb rail designed in
   `docs/a2a-conformance.md`. Hive: nothing.

---

## 3. What already exists vs what the demo needs

Verified in tree. Three gaps, all small, none needing a new kind.

**Already works — do not rebuild**

- Agent-to-agent mentions. `agent.js:129` is `if (event.pubkey === this.pubkey) return` and that
  is the **only** sender filter. No human/agent check anywhere. B's mention handler fires for A
  exactly as for a human. ✓
- Ownership already exists as protocol data: `agent.js:107` `owner: this.owner ?? this.pubkey`,
  `agent.js:117` *"so every action this agent takes carries provenance without pretending to be
  the owner"*, plus the 10100 `owner` field and the `p` tag in `demo-web-seed.js:625`.
- Job lifecycle is already published per turn: 43002 accepted → 43004 result → 43006 on throw,
  plus 44200 turn metric when `owner !== null` (`agent.js:turn`).
- Engram write path exists in `hive-cli/lib/commands.js:512` (`mem set`, kind 30174, `d` slug).

**GAP-1 — blocking the whole flow.** `agent.js` reply is built with
`mentions: [trigger.pubkey]` (hardcoded). ∴ honey's reply p-tags **alice only**; comb's
subscription (`'#p': [this.pubkey]`) never matches, and the chain stops at hop 1.
Ladder: no new kind, no new event, no parser — the `mentions` array in
`hive-sdk/index.js:16` already becomes `p` tags. Cheapest correct fix: let the provider's `final`
carry the pubkeys it wants to address and concat them onto that one array. Effort **low**.

**GAP-2 — requirement "whose agent is whose".** `hive-web/public/app.js:405` parses 10100 and
throws the owner away: it stores `{ name, agent: true }` only. Screen currently says `[agent]`,
never `[agent · alice]`. Effort **low** — keep one field already in hand, render it in the
members row and the transcript role span.

**GAP-3 — ownership is currently 1:N.** `demo-web-seed.js:446` `const owner = humans[0]` — all
six agents are owned by the same person. The demo needs alice→honey, bob→comb. Effort **low**.

**GAP-4 — the "store" beat.** No engram publisher in `hive-agent`; only the CLI has one. Effort
**low** (lift the `commands.js:512` shape), but see the caveat.

⚠ **Security caveat, do not skip.** `SPEC.md` §7.4 specifies engrams NIP-44 encrypted to the
owner with an HMAC-blinded `d` tag *"so slug names stay confidential"*. `commands.js:512`
publishes **plaintext content and a plaintext slug**. Spec ≠ code. ∴ anything the demo writes
into a 30174 is public on the relay — script it with demo-safe text only, and do not let a
"agents remember things" beat imply confidentiality the code does not deliver.

---

## 4. The demo narrative

~52 s, web client, existing recorder (`scripts/record-web-demo.mjs`, 1280×720, 12 fps, port 8931,
`at(<s>, '<label>', fn)` beats). Everything on screen is a real signed event through the real
loopback relay. Provider is scripted + deterministic — QVAC is absent by design, so a scripted
provider is both the lazy and the honest choice.

**Cast.** `#ops`. alice (human) owns **honey**. bob (human) owns **comb**. Four members, that is
the whole roster — the load demo already exists for scale; this one is for legibility.

| t | On screen | Kinds firing | Caption |
|---|---|---|---|
| 0–4 | `#ops`, members: alice, bob, `honey [agent · alice]`, `comb [agent · bob]` | 10100 ×2 in EVENT FLOW | `two people. two agents. one room.` |
| 4–10 | alice types and sends: `@honey — is the webhook retry safe to ship tonight? ask bob's side.` | `9` (p→honey) | `alice asks her own agent.` |
| 10–15 | honey's row lights the magenta gutter; EVENT FLOW ticks | `43002` | `honey takes the job.` |
| 15–23 | honey posts a triage line: `urgency: high · scope: release · needs: bob's side` then a memory write scrolls past | `43003`, `30174` | `not a pipe. it classifies, then remembers.` |
| 23–30 | honey posts to the room, **shorter than alice's ask**, addressed to comb | `9` (p→comb) | `honey summarises. comb is mentioned, not forwarded.` |
| 30–38 | comb's gutter lights; its own triage line against bob's context | `43002`, `43003`, `30174` | `comb triages against bob's context.` |
| 38–45 | comb delivers one line to bob; bob replies `ship it` | `9` (p→bob), `43004` ×2, `9` | `bob gets one line — and the whole chain behind it.` |
| 45–52 | EVENT FLOW scrolled back: the full chain `9 → 43002 → 43003 → 30174 → 9 → 43002 → 43003 → 30174 → 9 → 43004` | `44200` ×2 (owner-encrypted) | `every hop signed. one log. replayable.` |

Shape to hold to:

```
alice ──9──► honey ──43002/43003/30174──► 9 ──► comb ──43002/43003/30174──► 9 ──► bob
        └──────────────── one hash-chained log, every hop Schnorr-signed ───────────────┘
```

**Why this lands the idea and not just the mechanic.** Hamlet's demo proves an agent can act
*alone*. This one proves two agents can act *between two people who never spoke directly* — and
that you can still audit exactly what was said, by whom, and what was dropped in the middle. The
`[agent · alice]` label is doing the ideological work: an agent here is sovereign **and** owned,
which is the pair Hamlet never had to reconcile because its humans were never on the wire.

**Caption discipline.** Six words or fewer where possible, lowercase, one idea. No caption
explains a kind number — the EVENT FLOW panel is already showing it, and saying it twice wastes
the glance.

**Do not** show a URL that is not `127.0.0.1`. There is no deployment.

---

## 5. The one sentence

> Hamlet made agents sovereign by keeping humans off the wire; Hive puts humans back on it with
> the same keys, in the same rooms, so an agent can act on its own **and** still be provably
> someone's.
