# Product Hunt Launch Checklist for Hive

## Pre-Launch (T-7 days)

### Repository Polish
- [x] README.md with demo, badges, clear value prop
- [x] Professional logo (docs/logo.svg)
- [x] Demo recording (docs/demo-tui.cast → docs/demo-tui.gif + docs/demo-tui.mp4)
- [x] SPEC.md as normative specification
- [x] LICENSE (Apache-2.0)
- [x] Contributing guidelines
- [x] Code of conduct
- [x] Security policy (SECURITY.md)

### GitHub Best Practices
- [x] Branch protection on main
- [x] Required status checks (CI)
- [x] Issue templates (bug, feature, question)
- [x] PR template
- [x] GitHub Actions CI (test matrix, build, artifact)
- [x] GitHub Actions issue automation
- [x] Dependabot enabled
- [x] Code scanning (CodeQL)
- [x] Secret scanning
- [x] Release workflow

### Documentation
- [x] Quick start guide
- [x] Architecture overview
- [x] Agent/QVAC integration docs
- [x] Release/packaging guide
- [x] Status matrix (what's real vs stubbed)
- [x] Runtime notes
- [x] API reference (in SPEC.md)

## Launch Day (T-0)

### Product Hunt Page
- [ ] **Tagline** (60 chars): "P2P hive mind for humans + AI agents on the Pears stack"
- [ ] **Description** (260 chars): "Hive is a wire-compatible analog of Block/Buzz built on Bare/ SQLite/ Hyperswarm/ QVAC. Agents are keypairs, not roles. Reachable via hyper://<pubkey> — no ports, no DNS."
- [ ] **Topics**: `open-source`, `p2p`, `ai-agents`, `nostr`, `developer-tools`, `decentralized`
- [ ] **Website**: https://github.com/proximata/hive
- [ ] **Demo video/GIF**: Upload docs/demo-tui.mp4 or link asciinema
- [ ] **Screenshots**: Terminal demo, architecture diagram, workflow YAML
- [ ] **Maker comment**: First comment with story + technical details

### Social Assets
- [ ] Twitter/X announcement thread
- [ ] LinkedIn post
- [ ] Discord/Telegram community announcement
- [ ] Hacker News submission (Show HN)
- [ ] Reddit: r/rust, r/p2p, r/nostr, r/localllm

### GitHub Release
- [ ] Tag v0.1.0
- [ ] Release notes with highlights
- [ ] Attach binaries (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64)
- [ ] Mark as pre-release

## Post-Launch (T+1 to T+7)

### Community
- [ ] Respond to every PH comment within 2 hours
- [ ] Thank top hunters/upvoters personally
- [ ] Share metrics transparently
- [ ] AMA session (Twitter Spaces / Discord)

### Metrics to Track
- [ ] GitHub stars (target: 100+ week 1)
- [ ] Product Hunt upvotes (target: 200+)
- [ ] Issues filed (signal of real usage)
- [ ] PRs from community
- [ ] Discord/Telegram joins
- [ ] Binary downloads

### Follow-up Content
- [ ] Technical deep-dive blog post
- [ ] "How we built Hive on Bare" video
- [ ] Agent/QVAC integration tutorial
- [ ] Comparison: Hive vs Buzz vs others

---

## Product Hunt Launch Template

### Title
**Hive — P2P hive mind for humans + AI agents**

### Tagline
P2P hive mind for humans + AI agents on the Pears stack

### Description
Hive is a wire-compatible analog of Block/Buzz built entirely on the Pears stack (Bare runtime, SQLite, Hyperswarm, pear-runtime for OTA, QVAC for local inference).

**Key differentiators:**
- **Agents are keypairs, not roles** — Same NIP-42 challenge, same channel membership, same signatures. An agent's work is attributable because it signed it.
- **Kinds are the only dispatch switch** — Adding features = adding kinds. Unknown kinds are ignored, nothing breaks.
- **Reachable without infrastructure** — Relay listens on `hyper://<pubkey>`. No ports, no DNS, no certs. Traverses NAT.
- **Inference is local** — QVAC SDK runs models on-device or delegates to peers over the same DHT.
- **Pear-native** — Standalone binaries, OTA updates, peer-to-peer distribution via pear:// links.

**Compatible with:** Block/Buzz (same kind numbers, NIP-29, CLI contract), nak, any Nostr client.

**Open source:** Apache-2.0, proximata/hive

### Topics
`open-source` `p2p` `ai-agents` `nostr` `developer-tools` `decentralized` `bare-runtime` `sqlite` `hyperswarm` `qvac`

### First Comment (Maker)
```
Hey hunters! 🐝

I'm excited to share Hive — a project that started as "what if Block/Buzz was built on the Pears stack?"

**The backstory:** Block/Buzz is a fantastic "hive mind" workspace where humans and AI agents are equals — every message, reaction, workflow step, git event is a Schnorr-signed Nostr event. But it's Rust on Postgres + Redis + S3, which means infrastructure.

**Hive asks:** What if the same product ran on Bare (the Pears runtime)? SQLite instead of Postgres. Hyperswarm instead of load balancers. QVAC for local inference. pear-runtime for OTA updates.

**What's working:**
✅ Full NIP-01/29/42 relay over WebSocket + Hyperswarm
✅ SQLite store with inverted-index search + hash-chain audit
✅ Channels, DMs, threads, reactions, presence, canvas
✅ Agent personas with QVAC (local + delegated inference)
✅ YAML workflow engine with approval gates
✅ buzz-cli compatible JSON CLI
✅ Standalone binaries + pear:// OTA

**What's stubbed:** Git smart-HTTP (NIP-34 events stored), voice huddles (p2p audio would be better anyway)

**Tech stack:** JavaScript on Bare, zero native deps beyond bare-runtime, ~13k lines, 187 tests.

Would love your feedback — especially from anyone building local-first AI agents or p2p apps. The SPEC.md is the normative spec if you want to dig deep.

Happy to answer any technical questions in the comments!
```

---

## GitHub Repository Settings Checklist

### Branch Protection (main)
```
✅ Require pull request reviews (1)
✅ Dismiss stale reviews
✅ Require status checks to pass
  - CI / test (Node 22, Bare stable)
  - CI / test (Node 22, Bare latest)
  - CI / build
✅ Require branches up to date
✅ Require conversation resolution
✅ Include administrators
```

### Issue Templates
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/ISSUE_TEMPLATE/question.yml`

### PR Template
- `.github/PULL_REQUEST_TEMPLATE.md`

### Security
- `SECURITY.md` with responsible disclosure
- CodeQL analysis enabled
- Secret scanning enabled
- Dependabot alerts + auto-PRs

### Community
- `CODE_OF_CONDUCT.md` (Contributor Covenant)
- `CONTRIBUTING.md`
- Discussion categories: General, Ideas, Q&A, Showcase

---

## Release Checklist (v0.1.0)

### Pre-release
- [ ] All CI green on main
- [ ] Version bumped in package.json
- [ ] CHANGELOG.md updated
- [ ] Binaries built for all platforms:
  - [ ] linux-x64
  - [ ] linux-arm64
  - [ ] darwin-x64
  - [ ] darwin-arm64
  - [ ] win32-x64

### Release
- [ ] Tag: `git tag -a v0.1.0 -m "Release v0.1.0"`
- [ ] Push tag: `git push origin v0.1.0`
- [ ] GitHub Release UI: Generate notes, attach binaries
- [ ] Mark as pre-release
- [ ] Announce in discussions

### Post-release
- [ ] Update demo recordings if needed
- [ ] Tweet release link
- [ ] Update Product Hunt with release link